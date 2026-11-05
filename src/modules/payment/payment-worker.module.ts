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
import { WalletTopupJobs } from './shop-wallet/shop-wallet-topup.job';

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
 * Job refund (PLAN-0022), mỗi job có cờ chống chạy chồng trong tiến trình (nhiều worker vẫn an toàn nhờ compare-and-set ở PaymentService):
 *  - recoverStuckRefunds (5 phút): ghi sổ nốt refund mà tiền ĐÃ đi nhưng ghi sổ lỗi (không bao giờ gọi lại cổng), nhả refund treo trước khi gọi cổng, đánh failed refund treo giữa lúc gọi cổng
 *    (dữ liệu VNPay cũ) để người xử lý đối chiếu. Không đụng refund PayOS đã nhận lệnh.
 *  - reconcileGatewayRefunds (1 phút): refund PayOS ĐÃ nhận lệnh chi (code "00" chỉ là đã nhận) — hỏi `getPayout`: succeeded ⇒ ghi sổ done, failed ⇒ failed (báo kế toán), chưa rõ ⇒ giữ processing,
 *    treo quá 30 phút ⇒ đánh dấu cần người xem + báo kế toán một lần.
 * (PLAN-0018: bỏ job bù hoa hồng COD + listener ví — sàn thu COD nên hoa hồng trừ ở đối soát chi trả, không còn sổ cái ví.)
 */
@Injectable()
export class PaymentJobs {
  private readonly logger = new Logger(PaymentJobs.name);
  private recoveringRefunds = false;
  private reconcilingRefunds = false;
  private pollingPayos = false;
  private autoRefunding = false;

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

  /* PLAN-0025 §2.3 — hỏi PayOS các link còn pending sắp hết hạn / quá 10 phút: khách đã trả mà MẤT webhook vẫn được ghi nhận trước hạn huỷ + ân hạn. */
  @Interval(2 * 60_000)
  async reconcilePendingPayos(): Promise<void> {
    if (this.pollingPayos) return;
    this.pollingPayos = true;
    try {
      const r = await this.payments.reconcilePendingPayos();
      if (r.paid + r.mismatch > 0) this.logger.warn(r, 'Hỏi PayOS: ghi nhận thanh toán bị mất webhook');
    } catch (err) {
      this.logger.error({ err }, 'Job hỏi PayOS link đang chờ lỗi');
    } finally {
      this.pollingPayos = false;
    }
  }

  /* PLAN-0025 §2.5 — tự chi hoàn nhỏ (≤ refund.auto_max_amount) qua PayOS payout. */
  @Interval(5 * 60_000)
  async autoProcessRefunds(): Promise<void> {
    if (this.autoRefunding) return;
    this.autoRefunding = true;
    try {
      const r = await this.payments.autoProcessRefunds();
      if (r.submitted + r.failed > 0) this.logger.log(r, 'Đã tự chi hoàn tiền nhỏ');
    } catch (err) {
      this.logger.error({ err }, 'Job tự chi hoàn tiền lỗi');
    } finally {
      this.autoRefunding = false;
    }
  }

  @Interval(60_000)
  async reconcileGatewayRefunds(): Promise<void> {
    if (this.reconcilingRefunds) return;
    this.reconcilingRefunds = true;
    try {
      const r = await this.payments.reconcileGatewayRefunds();
      if (r.finalized + r.failed > 0) this.logger.log(r, 'Đã đối soát lệnh hoàn tiền PayOS');
    } catch (err) {
      this.logger.error({ err }, 'Job đối soát lệnh hoàn tiền PayOS lỗi');
    } finally {
      this.reconcilingRefunds = false;
    }
  }
}

/*
 * Worker module payment: relay outbox + job phục hồi/đối soát refund + CRON CHI TRẢ TỰ ĐỘNG (AutoPayoutJob, 02:00 Asia/Ho_Chi_Minh).
 * Import PaymentModule (PaymentService/PayosService) và PaymentSettlementModule (ShopPayoutService — đối soát cần OrderQueryApi).
 */
@Module({
  imports: [PaymentModule, PaymentSettlementModule, SystemModule],
  providers: [PaymentOutboxRelayJob, PaymentJobs, AutoPayoutJob, WalletTopupJobs],
})
export class PaymentWorkerModule {}
