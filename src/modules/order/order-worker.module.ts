import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, Interval } from '@nestjs/schedule';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { escapeHtml } from '@common/mail/escape-html';
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
import { ReturnSlaService } from './return/return-sla.service';
import { SHOP_EVENT, SHOP_MODULE } from '../shop/enums/shop-events';
import { CANCEL_SOURCE } from './foundation/order.constants';
import { shopCancelViolation } from './foundation/cancel.rules';
import { OrderFulfilmentService } from './order/service/order-fulfilment.service';
import { OrderSlaService, type OrderSlaResult } from './order/service/order-sla.service';
import { ShopViolationService } from './violation/shop-violation.service';

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
    await this.mail.enqueue({ to: user.email, subject: subject(order), html: `<p>Xin chào ${escapeHtml(user.fullName)},</p>${body(order)}<p><a href="${escapeHtml(link)}">Xem đơn hàng</a></p><p>— ${escapeHtml(this.env.EF_APP_NAME)}</p>` }); // PLAN-0040 tầng 4: tên/link/phần thân đều đã escape (AUD-11c)
    this.logger.log({ orderCode, handler }, 'Đã xếp hàng email đơn hàng');
  }

  private itemsHtml(items: Array<{ name: string; color: string; size: string; quantity: number }>): string {
    return `<ul>${items.map((i) => `<li>${escapeHtml(i.name)} — ${escapeHtml(i.color)} / ${escapeHtml(i.size)} × ${escapeHtml(i.quantity)}</li>`).join('')}</ul>`;
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
    return this.send(msg, `mail-status-${to}`, (o) => `Đơn ${o.code}: ${STATUS_LABEL[to] ?? to}`, () => `<p>Đơn hàng của bạn vừa chuyển sang trạng thái <b>${escapeHtml(STATUS_LABEL[to] ?? to)}</b>.</p>`);
  }

  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.DELIVERED}`)
  onDelivered(msg: OutboxEventMessage): Promise<void> {
    return this.send(msg, 'mail-delivered', (o) => `Đơn ${o.code} đã giao thành công`, (o) => `<p>Hy vọng bạn hài lòng với sản phẩm. Hãy đánh giá để nhận ưu đãi lần sau nhé!</p>${this.itemsHtml(o.items)}`);
  }

  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.CANCELLED}`)
  onCancelled(msg: OutboxEventMessage): Promise<void> {
    const { reason } = msg.payload as { reason: string };
    return this.send(msg, 'mail-cancelled', (o) => `Đơn ${o.code} đã huỷ`, () => `<p>Lý do: ${escapeHtml(reason)}. Nếu đã thanh toán, tiền sẽ được hoàn trong 3–5 ngày làm việc.</p>`);
  }
}

/*
 * Job: huỷ đơn quá hạn thanh toán (mỗi phút) · SLA đổi trả + cảnh báo đơn giao quá hạn (mỗi 10 phút, PLAN-0022) · tự hoàn tất đơn đã giao lâu (02:30) · dọn idempotency key (03:40).
 * Job SLA idempotent + an toàn nhiều instance (khoá dòng + compare-and-set trong ReturnSlaService); cờ `slaRunning` chỉ chặn chạy chồng trong CÙNG tiến trình.
 */
@Injectable()
export class OrderJobs {
  private readonly logger = new Logger(OrderJobs.name);
  private slaRunning = false;
  private orderSlaRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly returnSla: ReturnSlaService,
    private readonly sla: OrderSlaService,
  ) {}

  @Interval(600_000)
  async returnSlaTick(): Promise<void> {
    if (this.slaRunning) return;
    this.slaRunning = true;
    try {
      const r = await this.returnSla.runAll();
      if (r.shopTimeouts + r.expired + r.receiveTimeouts + r.reminded + r.shippingAlerts > 0) this.logger.log(r, 'Đã chạy SLA đổi trả');
    } catch (err) {
      this.logger.error({ err }, 'Job SLA đổi trả lỗi');
    } finally {
      this.slaRunning = false;
    }
  }

  @Interval(60_000)
  async cancelExpired(): Promise<void> {
    const n = await this.orders.cancelExpired();
    if (n > 0) this.logger.log({ n }, 'Đã huỷ đơn quá hạn thanh toán');
  }

  /*
   * PLAN-0027: job SLA đơn hàng — mỗi 5 phút (id job: `order-sla`). Chỉ làm việc khi setting `order.sla_enabled` = true (MẶC ĐỊNH TẮT) và chỉ với đơn có hạn khác NULL (đơn cũ không bị động tới).
   * Cờ `orderSlaRunning` chặn chạy chồng trong cùng tiến trình; nhiều worker do khoá advisory + khoá dòng + compare-and-set trong OrderSlaService.
   */
  @Interval(300_000)
  async orderSlaTick(): Promise<OrderSlaResult | null> {
    if (this.orderSlaRunning) return null;
    this.orderSlaRunning = true;
    try {
      const r = await this.sla.runAll();
      if (r.ran && r.confirmTimeouts + r.shipTimeouts + r.requestsAutoAccepted + r.remindedConfirm + r.remindedShip > 0) this.logger.log(r, 'Đã chạy SLA đơn hàng');
      return r; // trả kết quả để bộ chạy job tay (`order-sla`) in ra; @Interval bỏ qua giá trị trả về
    } catch (err) {
      this.logger.error({ err }, 'Job SLA đơn hàng lỗi');
      return null;
    } finally {
      this.orderSlaRunning = false;
    }
  }

  @Cron('0 30 2 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async autoComplete(): Promise<void> {
    const n = await this.orders.autoComplete();
    this.logger.log({ n }, 'Đã tự hoàn tất đơn đã giao');
  }

  @Cron('0 40 3 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async purge(): Promise<void> {
    const r = await this.prisma.orderIdempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    this.logger.log({ deleted: r.count }, 'Đã dọn idempotency key hết hạn (order)');
  }
}

/*
 * PLAN-0027 §2.5 (SHOP-01c/f): shop bị khoá ⇒ đơn KHÔNG đóng băng. Nghe `outbox.shop.SHOP_SUSPENDED` (relay của module shop phát trong cùng tiến trình worker): đơn pending/confirmed tự huỷ + hoàn tiền (hệ thống,
 * `shop_suspended`); đơn packing/shipping KHÔNG tự huỷ — báo CSKH MỘT lần kèm danh sách (CSKH quyết từng đơn bằng "Huỷ đơn" của sàn). Huỷ idempotent theo trạng thái đơn; thông báo CSKH đánh dấu qua
 * order.processed_events nên relay phát lại không báo đôi. Còn đơn lỗi ⇒ ném lỗi để relay thử lại (các đơn đã huỷ không bị động tới lần nữa). suppressErrors:false để lỗi không bị nuốt.
 */
@Injectable()
export class OrderShopListeners {
  private readonly logger = new Logger(OrderShopListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OrderOutboxService,
    private readonly fulfilment: OrderFulfilmentService,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
  ) {}

  @OnEvent(`outbox.${SHOP_MODULE}.${SHOP_EVENT.SUSPENDED}`, { suppressErrors: false })
  async onShopSuspended(msg: OutboxEventMessage): Promise<void> {
    const { shopId } = msg.payload as { shopId: string };
    const { cancelled, failed } = await this.fulfilment.cancelOpenOrdersOfSuspendedShop(shopId);
    const staffIds = await this.users.staffUserIdsWithPermission('order.order.cancel');
    const held = await this.prisma.$transaction(async (tx) => ((await this.outbox.markProcessed(tx, msg.id, msg.eventType, 'order-shop-suspended-hold')) ? this.fulfilment.alertSupportAboutHeldOrders(tx, shopId, staffIds) : -1));
    this.logger.log({ shopId, cancelled, failed, heldNotified: held }, 'Đã xử lý đơn mở của shop bị khoá');
    if (failed > 0) throw new Error(`Còn ${failed} đơn chưa tự huỷ được khi khoá shop ${shopId} — relay sẽ thử lại`);
  }
}

/*
 * PLAN-0027 §2.1: điểm vi phạm khi SHOP chủ động huỷ đơn (hết hàng / sai giá / từ chối yêu cầu huỷ rồi tự huỷ / huỷ đơn đã đóng gói) — đọc từ payload ORDER_CANCELLED. Ghi IDEMPOTENT nhờ UNIQUE(order_code, kind),
 * nên relay phát lại sự kiện không cộng điểm hai lần. (Điểm của job SLA ghi thẳng trong tx huỷ — OrderSlaService.)
 */
@Injectable()
export class OrderViolationListeners {
  constructor(
    private readonly prisma: PrismaService,
    private readonly violations: ShopViolationService,
  ) {}

  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.CANCELLED}`, { suppressErrors: false })
  async onCancelled(msg: OutboxEventMessage): Promise<void> {
    const p = msg.payload as { orderCode: string; shopId?: string; cancelSource?: string; reasonCode?: string | null; fromStatus?: string; hadRejectedRequest?: boolean };
    if (p.cancelSource !== CANCEL_SOURCE.SHOP || !p.shopId) return;
    const kind = shopCancelViolation({ reasonCode: p.reasonCode ?? null, fromStatus: p.fromStatus ?? '', hadRejectedRequest: !!p.hadRejectedRequest });
    if (!kind) return;
    const shopId = p.shopId;
    await this.prisma.$transaction((tx) => this.violations.record(tx, { shopId, orderCode: p.orderCode, kind }));
  }
}

@Module({
  imports: [OrderModule],
  providers: [OrderPaymentOutboxRelayJob, OrderMailListeners, OrderJobs, OrderShopListeners, OrderViolationListeners],
})
export class OrderWorkerModule {}
