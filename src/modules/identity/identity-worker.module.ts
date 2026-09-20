import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, Interval } from '@nestjs/schedule';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { MailService } from '@common/mail/mail.service';
import { OutboxEventMessage } from '@common/outbox/outbox';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { PrismaService } from '@common/prisma/prisma.service';
import { RefreshTokenRepository } from './auth/repository/refresh-token.repository';
import { IDENTITY_EVENT, IDENTITY_MODULE } from './foundation/identity.constants';
import { LoginHistoryRepository } from './loginhistory/repository/login-history.repository';
import { IdentityOutboxService } from './outbox/identity-outbox.service';

/*
 * Relay outbox identity: mỗi 3s claim event PENDING/FAILED tới hạn và phát qua EventEmitter
 * `outbox.identity.<EVENT_TYPE>` (listener cùng process worker). Chỉ WorkerModule nạp — API không chạy job nền.
 */
@Injectable()
export class IdentityOutboxRelayJob implements OnModuleInit {
  private readonly logger = new Logger(IdentityOutboxRelayJob.name);
  private relay!: OutboxRelay;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.relay = new OutboxRelay(this.prisma, IDENTITY_MODULE, async (msg) => {
      await this.emitter.emitAsync(`outbox.${IDENTITY_MODULE}.${msg.eventType}`, msg);
    });
  }

  @Interval(3000)
  async tick(): Promise<void> {
    if (this.running) return; // không chồng lần chạy khi batch trước chưa xong
    this.running = true;
    try {
      const n = await this.relay.poll();
      if (n > 0) this.logger.debug({ n }, 'Đã relay outbox identity');
    } catch (err) {
      this.logger.error({ err }, 'Relay outbox identity lỗi');
    } finally {
      this.running = false;
    }
  }
}

/*
 * Listener sự kiện identity ở worker. Idempotent qua identity.processed_events (event_id + handler):
 * relay có thể phát lại event nếu worker chết giữa chừng — mail chào mừng không được gửi 2 lần.
 */
@Injectable()
export class IdentityEventListeners {
  private readonly logger = new Logger(IdentityEventListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: IdentityOutboxService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @OnEvent(`outbox.${IDENTITY_MODULE}.${IDENTITY_EVENT.USER_REGISTERED}`)
  async onUserRegistered(msg: OutboxEventMessage): Promise<void> {
    const { email, fullName } = msg.payload as { email: string; fullName: string };
    const fresh = await this.prisma.$transaction((tx) => this.outbox.markProcessed(tx, msg.id, msg.eventType, 'welcome-mail'));
    if (!fresh) return;
    await this.mail.enqueue({
      to: email,
      subject: `Chào mừng bạn đến với ${this.env.EF_APP_NAME}`,
      html: `<p>Xin chào <b>${fullName}</b>,</p><p>Tài khoản của bạn tại ${this.env.EF_APP_NAME} đã sẵn sàng. Chúc bạn mua sắm vui vẻ!</p>`,
    });
    this.logger.log({ userId: msg.aggregateId }, 'Đã xếp hàng mail chào mừng');
  }

  @OnEvent(`outbox.${IDENTITY_MODULE}.${IDENTITY_EVENT.USER_LOCKED}`)
  async onUserLocked(msg: OutboxEventMessage): Promise<void> {
    const { email, reason } = msg.payload as { email: string; reason: string | null };
    const fresh = await this.prisma.$transaction((tx) => this.outbox.markProcessed(tx, msg.id, msg.eventType, 'locked-mail'));
    if (!fresh) return;
    await this.mail.enqueue({
      to: email,
      subject: `${this.env.EF_APP_NAME} — Tài khoản của bạn đã bị khoá`,
      html: `<p>Tài khoản của bạn đã bị khoá${reason ? ` với lý do: <b>${reason}</b>` : ''}. Vui lòng liên hệ cửa hàng nếu cần hỗ trợ.</p>`,
    });
  }
}

/* Job dọn dữ liệu (AGENTS.md — bảng append-only không phình vô hạn): 03:00 mỗi ngày. */
@Injectable()
export class IdentityHousekeepingJob {
  private readonly logger = new Logger(IdentityHousekeepingJob.name);

  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly loginHistory: LoginHistoryRepository,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Cron('0 0 3 * * *')
  async purge(): Promise<void> {
    const day = 86_400_000;
    const tokens = await this.refreshTokens.purgeOld(new Date(Date.now() - 30 * day));
    const logins = await this.loginHistory.purgeOlderThan(new Date(Date.now() - this.env.EF_LOGIN_HISTORY_RETENTION_DAYS * day));
    this.logger.log({ tokens, logins }, 'Đã dọn refresh token cũ và lịch sử đăng nhập quá hạn');
  }
}

/* Phần worker của identity: relay outbox + listener + job dọn. Chỉ WorkerModule import. */
@Module({
  providers: [RefreshTokenRepository, LoginHistoryRepository, IdentityOutboxService, IdentityOutboxRelayJob, IdentityEventListeners, IdentityHousekeepingJob],
})
export class IdentityWorkerModule {}
