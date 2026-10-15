import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OutboxEventMessage } from '@common/outbox/outbox';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Prisma } from '@common/prisma/types';
import { money } from '@common/response/money-response';
import { NOTIFICATION_GATEWAY, NotificationGateway, NotifyCommand } from '@common/gateway/notification.gateway';
import { ORDER_EVENT, ORDER_MODULE } from '../order/enums/order-events';
import { OrderQueryApi } from '../order/queryapi/order.queryapi';
import { PAYMENT_MODULE_NAME, PAYOUT_EVENT } from '../payment/enums/payment-events';
import { PRODUCT_EVENT, PRODUCT_MODULE } from '../product/enums/product-events';
import { SHOP_EVENT, SHOP_MODULE } from '../shop/enums/shop-events';
import { ShopQueryApi } from '../shop/queryapi/shop.queryapi';
import { ProductQueryApi } from '../product/queryapi/product.queryapi';
import { OrderModule } from '../order/order.module';
import { ProductModule } from '../product/product.module';
import { ShopModule } from '../shop/shop.module';
import { SystemModule } from './system.module';

/* Múi giờ Việt Nam cố định UTC+7 (không có giờ mùa hè) — "hôm nay" của thông báo tính theo ngày VN, không theo TZ máy chủ. */
const VN_UTC_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/* 00:00 hôm nay theo giờ Việt Nam, trả về đúng thời điểm UTC tương ứng. */
export function startOfVnDay(now: Date = new Date()): Date {
  const local = now.getTime() + VN_UTC_OFFSET_MS;
  return new Date(local - (local % DAY_MS) - VN_UTC_OFFSET_MS);
}

/* Nhãn phương thức thanh toán online hiển thị cho vendor (COD không đi qua đây). */
const PAYMENT_METHOD_LABEL: Record<string, string> = { payos: 'PayOS' };

/*
 * Listener thông báo thành viên gian hàng (WP: B5 shop-notify, B10/B12 bổ sung). Nghe sự kiện outbox của order/product/shop:
 * - ORDER_CREATED: báo TẤT CẢ thành viên active của shop (deep link /vendor/orders/CODE)
 * - ORDER_PAID: đơn ONLINE (PayOS) vừa nhận được tiền → báo shop có thể xác nhận/đóng gói (COD bỏ qua:
 *   tiền thu lúc giao). Payload ORDER_PAID không có shopId → tra qua OrderQueryApi.shopIdOfOrder
 * - STOCK_LOW: báo thành viên shop, dedupe theo biến thể + ngày VN (link /vendor/inventory)
 * - SHOP_BANK_CHANGED: báo TẤT CẢ thành viên khi tài khoản ngân hàng nhận tiền đổi (chỉ 4 số cuối) để phát hiện đổi trái phép
 * - PAYOUT_PROCESSING / PAYOUT_PAID / PAYOUT_FAILED (PLAN-0018): báo TẤT CẢ thành viên active (cùng quy ước thông báo tiền như đổi TK ngân hàng)
 *   khi kỳ chi trả đang chuyển tiền / đã trả / thất bại (kèm lý do ngắn, đã cắt)
 *
 * Idempotent + không nuốt lỗi (system KHÔNG có bảng processed_events nên dedupe bằng chính bảng notifications):
 * - Mỗi thông báo mang `payload.eventId` = id outbox event; trước khi gửi, kiểm (userId, payload.eventId) đã có chưa.
 *   Relay claim lại event PROCESSING quá 10' hoặc retry sau lỗi → không gửi trùng.
 * - Lỗi KHÔNG được nuốt: `@OnEvent(..., { suppressErrors: false })` để emitAsync ném lỗi lên → relay đánh FAILED + retry
 *   có backoff (nuốt lỗi thì relay đánh DONE và thông báo mất vĩnh viễn). Có dedupe nên retry an toàn.
 * - Payload thiếu trường bắt buộc (không thể lành lại bằng retry) → cảnh báo rồi bỏ qua, không ném.
 */
@Injectable()
export class ShopNotificationListeners {
  private readonly logger = new Logger(ShopNotificationListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_GATEWAY) private readonly notify: NotificationGateway,
    private readonly shops: ShopQueryApi,
    private readonly products: ProductQueryApi,
    private readonly orders: OrderQueryApi,
  ) {}

  /* Đơn mới → thông báo tất cả thành viên active của shop. */
  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.CREATED}`, { suppressErrors: false })
  async onOrderCreated(msg: OutboxEventMessage): Promise<void> {
    const { orderCode, shopId, total, itemCount } = msg.payload as { orderCode?: string; shopId?: string; total?: string; itemCount?: number };
    if (!orderCode || !shopId) {
      this.logger.warn({ eventId: msg.id }, 'ORDER_CREATED thiếu orderCode/shopId — bỏ qua thông báo');
      return;
    }
    const userIds = await this.shops.activeMemberUserIds(shopId);
    const sent = await this.notifyOnce(
      msg,
      userIds,
      { type: 'order', title: `Đơn mới #${orderCode}`, content: `${itemCount ?? 0} sản phẩm · ${money(total).display}`, link: `/vendor/orders/${orderCode}` },
      { shopId, orderCode },
    );
    this.logger.log({ shopId, orderCode, recipients: sent }, 'Đã gửi thông báo đơn mới');
  }

  /* Đơn ONLINE vừa được thanh toán → báo thành viên shop (đơn COD bỏ qua — tiền thu khi giao). */
  @OnEvent(`outbox.${ORDER_MODULE}.${ORDER_EVENT.PAID}`, { suppressErrors: false })
  async onOrderPaid(msg: OutboxEventMessage): Promise<void> {
    const { orderCode, methodCode } = msg.payload as { orderCode?: string; methodCode?: string };
    if (!orderCode) {
      this.logger.warn({ eventId: msg.id }, 'ORDER_PAID thiếu orderCode — bỏ qua thông báo');
      return;
    }
    if (methodCode === 'cod') return;

    const shopId = await this.orders.shopIdOfOrder(orderCode);
    if (!shopId) {
      this.logger.warn({ eventId: msg.id, orderCode }, 'ORDER_PAID: không tìm thấy shop của đơn — bỏ qua thông báo');
      return;
    }
    const [userIds, totals] = await Promise.all([this.shops.activeMemberUserIds(shopId), this.orders.orderTotalsOf([orderCode])]);
    const total = totals.get(orderCode)?.total;
    const via = methodCode ? ` qua ${PAYMENT_METHOD_LABEL[methodCode] ?? methodCode}` : '';
    const sent = await this.notifyOnce(
      msg,
      userIds,
      { type: 'payment', title: `Đơn #${orderCode} đã thanh toán`, content: `Khách đã thanh toán${total ? ` ${money(total.toString()).display}` : ''}${via} — có thể xác nhận và đóng gói`, link: `/vendor/orders/${orderCode}` },
      { shopId, orderCode },
    );
    this.logger.log({ shopId, orderCode, recipients: sent }, 'Đã gửi thông báo đơn đã thanh toán');
  }

  /* Hàng sắp hết → thông báo thành viên shop, dedupe theo biến thể (variantId) + ngày VN. */
  @OnEvent(`outbox.${PRODUCT_MODULE}.${PRODUCT_EVENT.STOCK_LOW}`, { suppressErrors: false })
  async onStockLow(msg: OutboxEventMessage): Promise<void> {
    const { variantId, productId, sku, available } = msg.payload as { variantId?: string; productId?: string; sku?: string; available?: number };
    if (!variantId || !productId) {
      this.logger.warn({ eventId: msg.id }, 'STOCK_LOW thiếu variantId/productId — bỏ qua thông báo');
      return;
    }

    const product = await this.products.findProductBrief(productId);
    if (!product) return;

    const shopId = product.shopId;
    const userIds = await this.shops.activeMemberUserIds(shopId);
    // Khoá dedupe theo variantId (id, không phải SKU: `AO-1` từng khớp nhầm `AO-10`) + ngày VN, tính riêng từng người nhận.
    const sameVariantToday: Prisma.NotificationWhereInput = { type: 'inventory', payload: { path: ['variantId'], equals: variantId }, createdAt: { gte: startOfVnDay() } };
    const sent = await this.notifyOnce(
      msg,
      userIds,
      { type: 'inventory', title: `Sắp hết hàng: ${product.name}`, content: `SKU ${sku ?? ''} · Còn ${available ?? 0}`, link: '/vendor/inventory' },
      { shopId, variantId, productId },
      sameVariantToday,
    );
    this.logger.log({ shopId, productId, variantId, recipients: sent }, 'Đã gửi thông báo hàng sắp hết');
  }

  /*
   * Tài khoản ngân hàng nhận tiền của shop đổi → báo TẤT CẢ thành viên active (kể cả người đổi) để người khác kịp phát hiện
   * đổi trái phép. Chỉ hiện 4 số cuối; số tài khoản đầy đủ không bao giờ có trong payload/thông báo.
   */
  @OnEvent(`outbox.${SHOP_MODULE}.${SHOP_EVENT.BANK_CHANGED}`, { suppressErrors: false })
  async onShopBankChanged(msg: OutboxEventMessage): Promise<void> {
    const { shopId, name, bankAccountLast4, bankAccountNumberMasked, changedByEmail } = msg.payload as {
      shopId?: string;
      name?: string;
      bankAccountLast4?: string | null;
      bankAccountNumberMasked?: string | null;
      changedByEmail?: string;
    };
    if (!shopId) {
      this.logger.warn({ eventId: msg.id }, 'SHOP_BANK_CHANGED thiếu shopId — bỏ qua thông báo');
      return;
    }
    const last4 = bankAccountLast4 ?? bankAccountNumberMasked?.slice(-4) ?? null;
    const account = last4 ? ` (số tài khoản ••••${last4})` : '';
    const userIds = await this.shops.activeMemberUserIds(shopId);
    const sent = await this.notifyOnce(
      msg,
      userIds,
      {
        type: 'system',
        title: 'Tài khoản ngân hàng nhận tiền đã thay đổi',
        content: `Tài khoản ngân hàng nhận tiền của gian hàng${name ? ` ${name}` : ''}${account} vừa được đổi bởi ${changedByEmail ?? 'một thành viên'}. Nếu không phải bạn, hãy liên hệ sàn ngay.`,
        link: '/vendor/shop',
      },
      { shopId },
    );
    this.logger.log({ shopId, recipients: sent }, 'Đã gửi thông báo đổi tài khoản ngân hàng');
  }

  /* Kỳ chi trả đã gửi lệnh chi sang PayOS (đang chuyển tiền). */
  @OnEvent(`outbox.${PAYMENT_MODULE_NAME}.${PAYOUT_EVENT.PROCESSING}`, { suppressErrors: false })
  async onPayoutProcessing(msg: OutboxEventMessage): Promise<void> {
    await this.notifyPayout(msg, 'PAYOUT_PROCESSING', (code, amount) => ({
      title: `Đang chuyển tiền đối soát ${code}`,
      content: `Sàn đang chuyển ${amount} về tài khoản ngân hàng nhận tiền của gian hàng. Tiền thường về trong vài phút.`,
    }));
  }

  /* Kỳ chi trả đã trả xong (PayOS xác nhận hoặc kế toán đánh dấu đã trả). */
  @OnEvent(`outbox.${PAYMENT_MODULE_NAME}.${PAYOUT_EVENT.PAID}`, { suppressErrors: false })
  async onPayoutPaid(msg: OutboxEventMessage): Promise<void> {
    await this.notifyPayout(msg, 'PAYOUT_PAID', (code, amount) => ({
      title: `Đã chi trả đối soát ${code}`,
      content: `Sàn đã chi trả ${amount} cho gian hàng của bạn.`,
    }));
  }

  /* Kỳ chi trả thất bại → báo shop kèm lý do ngắn để sửa (vd chưa khai tài khoản ngân hàng). */
  @OnEvent(`outbox.${PAYMENT_MODULE_NAME}.${PAYOUT_EVENT.FAILED}`, { suppressErrors: false })
  async onPayoutFailed(msg: OutboxEventMessage): Promise<void> {
    const reason = String((msg.payload as { failReason?: string }).failReason ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    await this.notifyPayout(msg, 'PAYOUT_FAILED', (code, amount) => ({
      title: `Chi trả đối soát ${code} thất bại`,
      content: `Sàn chưa chuyển được ${amount}${reason ? ` (${reason})` : ''}. Vui lòng kiểm tra tài khoản ngân hàng nhận tiền của gian hàng; sàn sẽ chi lại sau.`,
    }));
  }

  /* Dùng chung cho 3 sự kiện chi trả: tra thành viên active của shop rồi gửi một lần (dedupe theo eventId). */
  private async notifyPayout(msg: OutboxEventMessage, eventName: string, render: (code: string, amount: string) => { title: string; content: string }): Promise<void> {
    const { payoutId, payoutCode, shopId, netPayout } = msg.payload as { payoutId?: string; payoutCode?: string; shopId?: string; netPayout?: string };
    if (!payoutCode || !shopId) {
      this.logger.warn({ eventId: msg.id }, `${eventName} thiếu payoutCode/shopId — bỏ qua thông báo`);
      return;
    }
    const userIds = await this.shops.activeMemberUserIds(shopId);
    const { title, content } = render(payoutCode, money(netPayout ?? 0).display);
    const sent = await this.notifyOnce(msg, userIds, { type: 'payment', title, content, link: '/vendor/payouts' }, { shopId, payoutId, payoutCode });
    this.logger.log({ shopId, payoutCode, recipients: sent }, `Đã gửi thông báo ${eventName}`);
  }

  /*
   * Gửi `base` + `payload` tới từng user CHƯA có thông báo của event này (payload.eventId = msg.id) — và, nếu có `alsoSkip`,
   * chưa có thông báo khớp điều kiện đó (vd cùng biến thể trong ngày). Tách theo từng user nên retry giữa chừng vẫn đúng.
   * Trả số người nhận thực sự được gửi.
   */
  private async notifyOnce(
    msg: OutboxEventMessage,
    userIds: string[],
    base: Omit<NotifyCommand, 'userId' | 'payload'>,
    payload: Record<string, unknown>,
    alsoSkip?: Prisma.NotificationWhereInput,
  ): Promise<number> {
    if (userIds.length === 0) return 0;
    const already = await this.prisma.notification.findMany({
      where: { userId: { in: userIds }, OR: [{ payload: { path: ['eventId'], equals: msg.id } }, ...(alsoSkip ? [alsoSkip] : [])] },
      select: { userId: true },
    });
    const done = new Set(already.map((n) => n.userId));
    const targets = userIds.filter((userId) => !done.has(userId));
    if (targets.length === 0) return 0;
    await this.notify.notifyMany(targets.map((userId) => ({ ...base, userId, payload: { ...payload, eventId: msg.id } })));
    return targets.length;
  }
}

/*
 * Phần worker của system: listener thông báo thành viên gian hàng cho sự kiện từ order/product/shop module.
 * Chỉ WorkerModule import. Nghe ORDER_CREATED + ORDER_PAID + STOCK_LOW + SHOP_BANK_CHANGED + PAYOUT_PROCESSING/PAID/FAILED từ outbox relay của module nguồn.
 */
@Module({
  imports: [SystemModule, OrderModule, ProductModule, ShopModule],
  providers: [ShopNotificationListeners],
})
export class SystemWorkerModule {}
