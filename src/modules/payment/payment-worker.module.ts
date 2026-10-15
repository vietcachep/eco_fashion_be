import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { PrismaService } from '@common/prisma/prisma.service';
import { SystemModule } from '@modules/system/system.module';
import { PAYMENT_MODULE } from './foundation/payment.constants';
import { PaymentModule } from './payment.module';
import { PaymentSettlementModule } from './payment-settlement.module';
import { PaymentService } from './payment/payment.service';
import { AutoPayoutJob } from './shop-payout/auto-payout.job';

/*
 * Relay outbox payment — phát event `outbox.payment.*`.
 * WorkerModule sẽ import để chạy job cron.
 */
@Injectable()
export class PaymentOutboxRelayJob implements OnModuleInit {
  private readonly logger = new Logger(PaymentOutboxRelayJob.name);
  private relay!: OutboxRelay;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.relay = new OutboxRelay(this.prisma, PAYMENT_MODULE, async (msg) => {
      await this.emitter.emitAsync(`outbox.${PAYMENT_MODULE}.${msg.eventType}`, msg);
    });
  }

  @Interval(3000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.relay.poll();
      if (n > 0) this.logger.debug({ n }, 'Đã relay outbox payment');
    } catch (err) {
      this.logger.error({ err }, 'Relay outbox payment lỗi');
    } finally {
      this.running = false;
    }
  }
}

/*
 * Job phục hồi refund treo: mỗi 5 phút gọi PaymentService.recoverStuckRefunds — ghi sổ nốt refund mà cổng ĐÃ chi nhưng ghi sổ lỗi (không bao giờ gọi lại cổng),
 * nhả refund treo trước khi gọi cổng, đánh failed refund treo giữa lúc gọi cổng (dữ liệu VNPay cũ) để người xử lý đối chiếu.
 * (PLAN-0018: bỏ job bù hoa hồng COD + listener ví — sàn thu COD nên hoa hồng trừ ở đối soát chi trả, không còn sổ cái ví.)
 */
@Injectable()
export class PaymentJobs {
  private readonly logger = new Logger(PaymentJobs.name);
  private recoveringRefunds = false;

  constructor(private readonly payments: PaymentService) {}

  @Interval(5 * 60_000)
  async recoverStuckRefunds(): Promise<void> {
    if (this.recoveringRefunds) return;
    this.recoveringRefunds = true;
    try {
      const r = await this.payments.recoverStuckRefunds();
      if (r.finalized + r.released + r.flagged > 0) this.logger.warn(r, 'Đã phục hồi refund treo');
    } catch (err) {
      this.logger.error({ err }, 'Job phục hồi refund treo lỗi');
    } finally {
      this.recoveringRefunds = false;
    }
  }
}

/*
 * Worker module payment: relay outbox + job phục hồi refund + CRON CHI TRẢ TỰ ĐỘNG (AutoPayoutJob, 02:00 Asia/Ho_Chi_Minh).
 * Import PaymentModule (PaymentService/PayosService) và PaymentSettlementModule (ShopPayoutService — đối soát cần OrderQueryApi).
 */
@Module({
  imports: [PaymentModule, PaymentSettlementModule, SystemModule],
  providers: [PaymentOutboxRelayJob, PaymentJobs, AutoPayoutJob],
})
export class PaymentWorkerModule {}
