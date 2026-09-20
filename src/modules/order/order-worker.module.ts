import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, Interval } from '@nestjs/schedule';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { MailService } from '@common/mail/mail.service';
import { OutboxEventMessage } from '@common/outbox/outbox';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { PrismaService } from '@common/prisma/prisma.service';
import { money } from '@common/response/money-response';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { ORDER_EVENT, ORDER_MODULE, STATUS_LABEL } from './foundation/order.constants';
import { OrderModule } from './order.module';
import { OrderService } from './order/service/order.service';
import { OrderOutboxService } from './outbox/order-outbox.service';
import { OrderQueryApi } from './queryapi/order.queryapi';

/* Relay outbox của order + payment (hai schema) — phát `outbox.<module>.<EVENT>`. */
@Injectable()
export class OrderPaymentOutboxRelayJob implements OnModuleInit {
  private readonly logger = new Logger(OrderPaymentOutboxRelayJob.name);
  private relays: OutboxRelay[] = [];
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.relays = [ORDER_MODULE, 'payment'].map((m) => new OutboxRelay(this.prisma, m, async (msg) => { await this.emitter.emitAsync(`outbox.${m}.${msg.eventType}`, msg); }));
  }

  @Interval(3000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const r of this.relays) await r.poll();
    } catch (err) {
      this.logger.error({ err }, 'Relay outbox order/payment lỗi');
    } finally {
      this.running = false;
    }
  }
}

/* Email cho khách theo sự kiện đơn — idempotent qua order.processed_events. */
@Injectable()
export class OrderMailListeners {
  private readonly logger = new Logger(OrderMailListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OrderOutboxService,
    private readonly mail: MailService,
    private readonly orders: OrderQueryApi,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async send(msg: OutboxEventMessage, handler: string, subject: (o: { code: string; total: string; status: string }) => string, body: (o: { code: string; total: string; status: string; items: Array<{ name: string; color: string; size: string; quantity: number }> }) => string): Promise<void> {
    const { orderCode, userId } = msg.payload as { orderCode: string; userId: string };
    const fresh = await this.prisma.$transaction((tx) => this.outbox.markProcessed(tx, msg.id, msg.eventType, handler));
    if (!fresh) return;
    const [user, order] = await Promise.all([this.users.findSnapshot(userId), this.orders.findByCodeForUser(userId, orderCode)]);
    if (!user || !order) return;
    const link = `${this.env.EF_WEB_URL.replace(/\/$/, '')}/account/orders/${orderCode}`;
    await this.mail.enqueue({ to: user.email, subject: subject(order), html: `<p>Xin chào ${user.fullName},</p>${body(order)}<p><a href="${link}">Xem đơn hàng</a></p><p>— ${this.env.EF_APP_NAME}</p>` });
    this.logger.log({ orderCode, handler }, 'Đã xếp hàng email đơn hàng');
  }

  private itemsHtml(items: Array<{ name: string; color: string; size: string; quantity: number }>): string {
    return `<ul>${items.map((i) => `<li>${i.name} — ${i.color} / ${i.size} × ${i.quantity}</li>`).join('')}</ul>`;
  }

  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.CREATED}`)
  onCreated(msg: OutboxEventMessage): Promise<void> {
    return this.send(msg, 'mail-created', (o) => `Đã nhận đơn hàng ${o.code}`, (o) => `<p>Cảm ơn bạn đã đặt hàng. Tổng thanh toán <b>${money(o.total).display}</b>.</p>${this.itemsHtml(o.items)}`);
  }

  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.PAID}`)
  onPaid(msg: OutboxEventMessage): Promise<void> {
    return this.send(msg, 'mail-paid', (o) => `Đã nhận thanh toán đơn ${o.code}`, (o) => `<p>Chúng tôi đã nhận <b>${money(o.total).display}</b>. Đơn sẽ được xác nhận và đóng gói sớm.</p>`);
  }

  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.STATUS_CHANGED}`)
  onStatus(msg: OutboxEventMessage): Promise<void> {
    const { to } = msg.payload as { to: string };
    return this.send(msg, `mail-status-${to}`, (o) => `Đơn ${o.code}: ${STATUS_LABEL[to] ?? to}`, () => `<p>Đơn hàng của bạn vừa chuyển sang trạng thái <b>${STATUS_LABEL[to] ?? to}</b>.</p>`);
  }

  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.DELIVERED}`)
  onDelivered(msg: OutboxEventMessage): Promise<void> {
    return this.send(msg, 'mail-delivered', (o) => `Đơn ${o.code} đã giao thành công`, (o) => `<p>Hy vọng bạn hài lòng với sản phẩm. Hãy đánh giá để nhận ưu đãi lần sau nhé!</p>${this.itemsHtml(o.items)}`);
  }

  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.CANCELLED}`)
  onCancelled(msg: OutboxEventMessage): Promise<void> {
    const { reason } = msg.payload as { reason: string };
    return this.send(msg, 'mail-cancelled', (o) => `Đơn ${o.code} đã huỷ`, () => `<p>Lý do: ${reason}. Nếu đã thanh toán, tiền sẽ được hoàn trong 3–5 ngày làm việc.</p>`);
  }
}

/* Job: huỷ đơn quá hạn thanh toán (mỗi phút) · tự hoàn tất đơn đã giao lâu (02:30) · dọn idempotency key (03:40). */
@Injectable()
export class OrderJobs {
  private readonly logger = new Logger(OrderJobs.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
  ) {}

  @Interval(60_000)
  async cancelExpired(): Promise<void> {
    const n = await this.orders.cancelExpired();
    if (n > 0) this.logger.log({ n }, 'Đã huỷ đơn quá hạn thanh toán');
  }

  @Cron('0 30 2 * * *')
  async autoComplete(): Promise<void> {
    const n = await this.orders.autoComplete();
    this.logger.log({ n }, 'Đã tự hoàn tất đơn đã giao');
  }

  @Cron('0 40 3 * * *')
  async purge(): Promise<void> {
    const r = await this.prisma.orderIdempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    this.logger.log({ deleted: r.count }, 'Đã dọn idempotency key hết hạn (order)');
  }
}

@Module({
  imports: [OrderModule],
  providers: [OrderPaymentOutboxRelayJob, OrderMailListeners, OrderJobs],
})
export class OrderWorkerModule {}
