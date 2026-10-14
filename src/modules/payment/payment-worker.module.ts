import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { OutboxEventMessage } from '@common/outbox/outbox';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { ORDER_EVENT, ORDER_MODULE } from '@modules/order/enums/order-events';
import { OrderModule } from '@modules/order/order.module';
import { type CodScanCursor, OrderQueryApi } from '@modules/order/queryapi/order.queryapi';
import { SHOP_EVENT, SHOP_MODULE } from '@modules/shop/enums/shop-events';
import { METHOD, PAYMENT_EVENT, PAYMENT_MODULE } from './foundation/payment.constants';
import { PaymentModule } from './payment.module';
import { PaymentService } from './payment/payment.service';
import { ShopWalletService } from './shop-wallet/service/shop-wallet.service';

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

/* Hoa hồng COD ròng của một đơn hoàn tất: hoa hồng trên doanh thu shop (khách trả + voucher sàn chịu) trừ phần voucher sàn sàn phải hoàn cho shop; âm = cộng ví.
   Phần đã hoàn cho khách TRƯỚC khi đơn hoàn tất không tính hoa hồng (shop không có doanh thu ở phần đó). */
function codNetCommission(order: { total: Prisma.Decimal; platformDiscount: Prisma.Decimal; commissionRateSnapshot: Prisma.Decimal }, refunded: Prisma.Decimal): Prisma.Decimal {
  const revenue = new Prisma.Decimal(order.total).add(order.platformDiscount);
  const commission = revenue.mul(order.commissionRateSnapshot).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  let net = commission.sub(order.platformDiscount);
  const total = new Prisma.Decimal(order.total);
  if (refunded.gt(0) && total.gt(0)) {
    const kept = total.sub(refunded);
    net = kept.lte(0) ? new Prisma.Decimal(0) : net.mul(kept).div(total).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  }
  return net;
}

/*
 * Listener payment (worker). Lỗi KHÔNG được nuốt: `suppressErrors: false` để lỗi ném lên emitAsync ⇒ relay đánh dấu FAILED + thử lại (mặc định của
 * @nestjs/event-emitter là nuốt + log ⇒ relay đánh DONE và sự kiện mất vĩnh viễn). Mọi xử lý idempotent theo (shop, loại, mã) của sổ cái ⇒ chạy lại an toàn.
 *   ORDER_STATUS_CHANGED → completed + COD ⇒ ghi hoa hồng vào ví COD · PAYMENT_REFUNDED (COD) ⇒ ghi nợ hoàn tiền, đảo hoa hồng · SHOP_APPROVED ⇒ tạo ví.
 */
@Injectable()
export class PaymentEventListeners {
  private readonly logger = new Logger(PaymentEventListeners.name);

  constructor(
    private readonly orders: OrderQueryApi,
    private readonly wallet: ShopWalletService,
  ) {}

  /* Ghi hoa hồng COD cho một đơn đã hoàn tất (dùng chung cho listener + job đối soát bù). Trả true nếu có ghi mới. */
  async chargeCodOrder(orderCode: string): Promise<boolean> {
    const order = await this.orders.commissionBasisOf(orderCode);
    if (!order) {
      this.logger.warn({ orderCode }, 'Đơn không tìm thấy khi tính hoa hồng COD');
      return false;
    }
    if (order.paymentMethodCode !== METHOD.COD) return false; // đơn online: sàn đã giữ tiền, hoa hồng trừ ở đối soát
    const net = codNetCommission(order, await this.wallet.refundedTotalOfOrder(orderCode));
    const charged = await this.wallet.chargeCodCommission({ shopId: order.shopId, orderCode, amount: net });
    if (charged) this.logger.log({ orderCode, shopId: order.shopId, net: net.toFixed(0) }, 'Đã ghi hoa hồng COD vào ví');
    return charged;
  }

  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.STATUS_CHANGED}`, { suppressErrors: false })
  async onOrderStatusChanged(msg: OutboxEventMessage): Promise<void> {
    const { orderCode, to: newStatus } = msg.payload as { orderCode: string; to: string };
    if (newStatus !== 'completed') return;
    await this.chargeCodOrder(orderCode);
  }

  @OnEvent(`outbox.${PAYMENT_MODULE}.${PAYMENT_EVENT.REFUNDED}`, { suppressErrors: false })
  async onPaymentRefunded(msg: OutboxEventMessage): Promise<void> {
    const p = msg.payload as { refundId?: string; orderCode?: string; amount?: string; methodCode?: string; shopId?: string | null };
    if (p.methodCode !== METHOD.COD || !p.shopId || !p.refundId || !p.orderCode || !p.amount) return;
    const order = await this.orders.commissionBasisOf(p.orderCode);
    if (!order) return;
    // Hoa hồng chỉ đảo nếu ĐÃ được trừ (đơn đã hoàn tất); hoàn trước khi hoàn tất thì khi hoàn tất hoa hồng đã tính trên phần còn lại (codNetCommission).
    const total = new Prisma.Decimal(order.total);
    const reversal = total.gt(0) && (await this.wallet.hasCodCommission(p.shopId, p.orderCode)) ? codNetCommission(order, new Prisma.Decimal(0)).mul(p.amount).div(total) : new Prisma.Decimal(0);
    await this.wallet.recordCodRefund({ shopId: p.shopId, orderCode: p.orderCode, refundKey: `RF-${p.refundId.replace(/-/g, '').slice(0, 26)}`, amount: p.amount, commissionReversal: reversal });
  }

  @OnEvent(`outbox.${SHOP_MODULE}.${SHOP_EVENT.APPROVED}`, { suppressErrors: false })
  async onShopApproved(msg: OutboxEventMessage): Promise<void> {
    const { shopId } = msg.payload as { shopId: string };
    await this.wallet.ensureWallet(shopId);
  }
}

/* Cửa sổ quét + kích thước lô + trần số lô của job bù hoa hồng COD: 20 lô × 1000 = 20.000 đơn COD hoàn tất/lượt — vượt trần thì log cảnh báo (đơn cũ nhất chưa được quét). */
const COD_RECONCILE_WINDOW_DAYS = 45;
const COD_RECONCILE_BATCH = 1000;
const COD_RECONCILE_MAX_BATCHES = 20;

/*
 * Job đối soát bù hoa hồng COD: mỗi 10 phút quét đơn COD hoàn tất 45 ngày gần nhất chưa có dòng hoa hồng trong sổ cái và ghi nốt (lưới an toàn khi sự kiện
 * ORDER_STATUS_CHANGED bị mất/trễ — vd đơn tự hoàn tất bởi job, relay chết). Idempotent theo (shop, loại, mã đơn).
 * Quét HẾT cửa sổ bằng phân trang theo con trỏ (completedAt, mã đơn) qua nhiều lô trong cùng lượt (mới nhất trước, tối đa COD_RECONCILE_MAX_BATCHES lô) — không còn
 * chuyện 1000 đơn mới nhất đã đủ hoa hồng thì đơn cũ hơn bị bỏ sót mãi mãi. Không chạy chồng; mỗi đơn một try/catch.
 *
 * Job phục hồi refund treo: mỗi 5 phút gọi PaymentService.recoverStuckRefunds — ghi sổ nốt refund mà cổng ĐÃ chi nhưng ghi sổ lỗi (không bao giờ gọi lại cổng),
 * nhả refund treo trước khi gọi cổng, đánh failed refund VNPay treo giữa lúc gọi cổng để người xử lý đối chiếu.
 */
@Injectable()
export class PaymentJobs {
  private readonly logger = new Logger(PaymentJobs.name);
  private running = false;
  private recoveringRefunds = false;

  constructor(
    private readonly orders: OrderQueryApi,
    private readonly wallet: ShopWalletService,
    private readonly listeners: PaymentEventListeners,
    private readonly payments: PaymentService,
  ) {}

  @Interval(10 * 60_000)
  async reconcileCodCommission(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let cursor: CodScanCursor | null = null;
      let fixed = 0;
      let scanned = 0;
      let exhausted = false;
      for (let batch = 0; batch < COD_RECONCILE_MAX_BATCHES; batch += 1) {
        const { codes, next } = await this.orders.completedCodOrderCodesSince(COD_RECONCILE_WINDOW_DAYS, COD_RECONCILE_BATCH, cursor);
        scanned += codes.length;
        const have = await this.wallet.chargedOrderCodes(codes);
        for (const code of codes) {
          if (have.has(code)) continue;
          // Mỗi đơn một try/catch: một đơn lỗi vĩnh viễn không được chặn các đơn còn lại (cùng lô lẫn lô sau) trong cùng lượt quét.
          try {
            if (await this.listeners.chargeCodOrder(code)) fixed += 1;
          } catch (err) {
            this.logger.error({ err, code }, 'Ghi bù hoa hồng COD lỗi cho đơn');
          }
        }
        if (!next) {
          exhausted = true;
          break;
        }
        cursor = next;
      }
      if (!exhausted) this.logger.warn({ scanned, batches: COD_RECONCILE_MAX_BATCHES }, 'Job bù hoa hồng COD chạm trần số lô — các đơn cũ nhất trong cửa sổ chưa được quét');
      if (fixed > 0) this.logger.warn({ fixed }, 'Đã ghi bù hoa hồng COD bị sót');
    } catch (err) {
      this.logger.error({ err }, 'Job đối soát bù hoa hồng COD lỗi');
    } finally {
      this.running = false;
    }
  }

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

/* Worker module payment: relay outbox + listener + job bù. Import PaymentModule (ví) và OrderModule (đọc đơn qua OrderQueryApi). */
@Module({
  imports: [PaymentModule, OrderModule],
  providers: [PaymentOutboxRelayJob, PaymentEventListeners, PaymentJobs],
})
export class PaymentWorkerModule {}
