import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException, ForbiddenException, NotFoundException } from '@common/exception/business.exception';
import { CART_GATEWAY, CartGateway } from '@common/gateway/cart.gateway';
import { INVENTORY_GATEWAY, InsufficientStockError, InventoryGateway } from '@common/gateway/inventory.gateway';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from '@common/gateway/payment.gateway';
import { PRODUCT_STATS_GATEWAY, ProductStatsGateway } from '@common/gateway/product-stats.gateway';
import { PROMOTION_GATEWAY, PromotionGateway, PromotionQuote } from '@common/gateway/promotion.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { IdempotencyService } from '@common/idempotency/idempotency.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { RequestTraceContext } from '@common/request/request-trace.context';
import { PageResponse } from '@common/response/api-response';
import { money } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { Basket, CartQueryApi } from '../../../cart/queryapi/cart.queryapi';
import { AddressBrief, IdentityQueryApi } from '../../../identity/queryapi/identity.queryapi';
import { PaymentQueryApi } from '../../../payment/queryapi/payment.queryapi';
import { SETTING_KEY } from '../../../system/enums/setting-keys';
import { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { OrderAuditLogService } from '../../audit/order-audit-log.service';
import { ORDER_AUDIT, ORDER_ERR, ORDER_EVENT, ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, STAFF_TRANSITIONS, STATUS_LABEL } from '../../foundation/order.constants';
import { OrderOutboxService } from '../../outbox/order-outbox.service';
import { CheckoutSummaryResponse, OrderResponse, OrderSummaryResponse } from '../dto/order.responses';
import { toOrderResponse, toOrderSummary } from '../mapper/order.mapper';
import { OrderListFilter, OrderRepository, OrderRow } from '../repository/order.repository';

export interface CheckoutAddress {
  recipientName: string;
  phone: string;
  provinceCode: string | null;
  provinceName: string;
  districtName: string | null;
  wardName: string | null;
  street: string;
}

export interface PlaceOrderInput {
  addressId?: string;
  address?: CheckoutAddress;
  paymentMethodCode: string;
  bankCode?: string | null;
  note?: string;
  voucherCode?: string | null;
}

interface Priced {
  basket: Basket;
  subtotal: bigint;
  shippingFee: bigint;
  province: { code: string; name: string } | null;
  quote: PromotionQuote | null;
  discount: bigint;
  total: bigint;
  warnings: string[];
}

/*
 * Đơn hàng (PLAN-0006). Đặt hàng = MỘT transaction: giỏ (dòng tick, còn bán, đủ tồn) → snapshot dòng → phí ship (tỉnh) →
 * mã KM consume → mã đơn (sequence khoá) → tạo đơn + lịch sử → giữ kho (reserve) → xoá dòng giỏ → khởi tạo thanh toán
 * (COD/VietQR/VNPay URL) → thông báo nhân viên + outbox ORDER_CREATED (mail) → idempotency complete.
 * Idempotency-Key: gửi lại cùng key → trả đúng đơn cũ, KHÔNG tạo đơn/giữ kho hai lần. Tiền: server tính toàn bộ.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OrderRepository,
    private readonly audit: OrderAuditLogService,
    private readonly outbox: OrderOutboxService,
    private readonly cart: CartQueryApi,
    private readonly identity: IdentityQueryApi,
    private readonly system: SystemQueryApi,
    private readonly payments: PaymentQueryApi,
    @Inject(INVENTORY_GATEWAY) private readonly inventory: InventoryGateway,
    @Inject(PROMOTION_GATEWAY) private readonly promotion: PromotionGateway,
    @Inject(PAYMENT_GATEWAY) private readonly payment: PaymentGateway,
    @Inject(CART_GATEWAY) private readonly cartWrite: CartGateway,
    @Inject(NOTIFICATION_GATEWAY) private readonly notify: NotificationGateway,
    @Inject(PRODUCT_STATS_GATEWAY) private readonly productStats: ProductStatsGateway,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
  ) {}

  // ================================================================ khách

  private async price(userId: string, provinceHint: string | null, voucherCode: string | null): Promise<Priced> {
    const basket = await this.cart.basketOf(userId, true);
    const warnings: string[] = [];
    for (const l of basket.lines) {
      if (!l.isSellable) warnings.push(`${l.name} (${l.color}/${l.size}) đã ngừng bán`);
      else if (l.quantity > l.available) warnings.push(`${l.name} (${l.color}/${l.size}) chỉ còn ${l.available}`);
    }
    const subtotal = basket.subtotal;
    const { fee, province } = await this.system.shippingFeeFor(subtotal, provinceHint);
    let quote: PromotionQuote | null = null;
    if (voucherCode && subtotal > 0n) {
      quote = await this.promotion.quote(voucherCode, { userId, subtotal, shippingFee: fee, lines: basket.lines.filter((l) => l.isSellable).map((l) => ({ productId: l.productId, categorySlug: l.categorySlug, lineTotal: l.lineTotal })) });
    }
    const discount = quote?.ok ? quote.discount : 0n;
    const total = subtotal + fee - discount < 0n ? 0n : subtotal + fee - discount;
    return { basket, subtotal, shippingFee: fee, province, quote, discount, total, warnings };
  }

  private async resolveProvinceHint(userId: string, q: { province?: string; addressId?: string }): Promise<string | null> {
    if (q.province) return q.province;
    const a = q.addressId ? await this.identity.findAddress(userId, q.addressId) : await this.identity.defaultAddress(userId);
    return a?.provinceCode ?? a?.provinceName ?? null;
  }

  async checkoutSummary(actor: AuthenticatedActor, q: { voucherCode?: string; province?: string; addressId?: string }): Promise<CheckoutSummaryResponse> {
    const hint = await this.resolveProvinceHint(actor.userId, q);
    const p = await this.price(actor.userId, hint, q.voucherCode ?? null);
    return {
      subtotal: money(p.subtotal),
      shippingFee: money(p.shippingFee),
      discount: money(p.discount),
      total: money(p.total),
      promotionCode: p.quote?.ok ? p.quote.code : null,
      promotionError: p.quote && !p.quote.ok ? p.quote.error : null,
      itemCount: p.basket.itemCount,
      provinceName: p.province?.name ?? null,
      warnings: p.warnings,
    };
  }

  async placeOrder(actor: AuthenticatedActor, input: PlaceOrderInput, idempotencyKey: string | null): Promise<OrderResponse> {
    // 1. Địa chỉ giao
    let address: CheckoutAddress;
    if (input.addressId) {
      const a = await this.identity.findAddress(actor.userId, input.addressId);
      if (!a) throw new NotFoundException(ORDER_ERR.ADDRESS_NOT_FOUND, 'Không tìm thấy địa chỉ');
      address = OrderService.fromAddressBrief(a);
    } else if (input.address) {
      address = input.address;
    } else {
      const a = await this.identity.defaultAddress(actor.userId);
      if (!a) throw new BusinessException(ORDER_ERR.ADDRESS_REQUIRED, 'Vui lòng chọn hoặc nhập địa chỉ giao hàng');
      address = OrderService.fromAddressBrief(a);
    }
    // 2. Phương thức thanh toán (FE `card` = VNPay thẻ quốc tế)
    const methodCode = input.paymentMethodCode === 'card' ? PAYMENT_METHOD.VNPAY : input.paymentMethodCode;
    const bankCode = input.paymentMethodCode === 'card' ? 'INTCARD' : (input.bankCode ?? null);
    if (!(await this.payment.isMethodActive(methodCode))) throw new BusinessException(ORDER_ERR.PAYMENT_METHOD_INVALID, 'Phương thức thanh toán không khả dụng');

    const requestHash = IdempotencyService.hashRequest({ userId: actor.userId, address, methodCode, note: input.note ?? null, voucher: input.voucherCode ?? null });
    const code = await this.prisma.$transaction(
      async (tx) => {
        const idem = idempotencyKey ? await IdempotencyService.begin<{ code: string }>(tx.orderIdempotencyKey, { scope: 'place-order', actorKey: actor.userId, key: idempotencyKey, requestHash, ttlHours: 24 }) : null;
        if (idem?.replay) return idem.replay.code;

        // 3. Giỏ + tiền (đọc trong tx để nhất quán)
        const p = await this.price(actor.userId, address.provinceCode ?? address.provinceName, input.voucherCode ?? null);
        const lines = p.basket.lines.filter((l) => l.isSellable);
        if (lines.length === 0) throw new BusinessException(ORDER_ERR.CART_EMPTY, 'Giỏ hàng trống hoặc không còn sản phẩm nào bán được');
        if (p.warnings.length > 0) throw new BusinessException(ORDER_ERR.CART_CHANGED, `Giỏ hàng có thay đổi: ${p.warnings.join('; ')}`, 409);
        if (p.quote && !p.quote.ok) throw new BusinessException(ORDER_ERR.PROMOTION_INVALID, p.quote.error ?? 'Mã giảm giá không hợp lệ');
        if (methodCode === PAYMENT_METHOD.COD) {
          const max = await this.system.settingNumber(SETTING_KEY.ORDER_COD_MAX_AMOUNT);
          if (max > 0 && p.total > BigInt(max)) throw new BusinessException(ORDER_ERR.COD_LIMIT, `Đơn trên ${money(max).display} vui lòng thanh toán trước (chuyển khoản/VNPay)`);
        }

        // 4. Mã đơn + mã KM (consume khoá dòng, kiểm hạn mức lần cuối)
        const orderCode = await this.repo.nextCode(tx);
        let discount = 0n;
        let promo: PromotionQuote | null = null;
        if (p.quote?.ok) {
          promo = await this.promotion.consume(p.quote.code, { userId: actor.userId, subtotal: p.subtotal, shippingFee: p.shippingFee, lines: lines.map((l) => ({ productId: l.productId, categorySlug: l.categorySlug, lineTotal: l.lineTotal })) }, orderCode, tx);
          if (!promo.ok) throw new BusinessException(ORDER_ERR.PROMOTION_INVALID, promo.error ?? 'Mã giảm giá không còn hiệu lực');
          discount = promo.discount;
        }
        const total = p.subtotal + p.shippingFee - discount;

        // 5. Tạo đơn (snapshot)
        const shippingAddress = [address.street, address.wardName, address.districtName, p.province?.name ?? address.provinceName].filter(Boolean).join(', ');
        const expiresAt = await this.paymentExpiry(methodCode);
        const order = await this.repo.create(
          {
            code: orderCode,
            userId: actor.userId,
            status: ORDER_STATUS.PENDING,
            paymentMethodCode: methodCode,
            paymentStatus: PAYMENT_STATUS.UNPAID,
            recipientName: address.recipientName.trim(),
            recipientPhone: address.phone,
            provinceCode: p.province?.code ?? address.provinceCode,
            provinceName: p.province?.name ?? address.provinceName,
            districtName: address.districtName,
            wardName: address.wardName,
            street: address.street.trim(),
            shippingAddress,
            customerNote: input.note?.trim() || null,
            subtotal: p.subtotal.toString(),
            shippingFee: p.shippingFee.toString(),
            discount: discount.toString(),
            promotionCode: promo?.code ?? null,
            promotionName: promo?.name ?? null,
            total: total.toString(),
            itemCount: lines.reduce((n, l) => n + l.quantity, 0),
            paymentExpiresAt: expiresAt,
            createdBy: actor.userId,
            updatedBy: actor.userId,
            items: { create: lines.map((l) => ({ variantId: l.variantId, productId: l.productId, slug: l.slug, name: l.name, imageUrl: l.imageUrl, color: l.color, size: l.size, sku: l.sku, quantity: l.quantity, unitPrice: l.unitPrice.toString(), lineTotal: l.lineTotal.toString() })) },
          },
          tx,
        );
        await this.repo.addHistory(order.id, null, ORDER_STATUS.PENDING, 'Khách đặt hàng', actor.userId, tx);

        // 6. Giữ kho
        try {
          await this.inventory.reserve(lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), { type: 'order', id: orderCode }, tx);
        } catch (err) {
          if (err instanceof InsufficientStockError) {
            const names = err.shortages.map((s) => `${lines.find((l) => l.variantId === s.variantId)?.name ?? s.variantId}: còn ${s.available}`).join('; ');
            throw new BusinessException(ORDER_ERR.OUT_OF_STOCK, `Không đủ hàng — ${names}`, 409);
          }
          throw err;
        }

        // 7. Xoá dòng giỏ đã mua + khởi tạo thanh toán
        await this.cartWrite.removeLines(actor.userId, lines.map((l) => l.variantId), tx);
        await this.payment.initiate({ orderId: order.id, orderCode, userId: actor.userId, amount: total, methodCode, clientIp: RequestTraceContext.current()?.ip ?? '127.0.0.1', bankCode }, tx);

        // 8. Audit + thông báo + outbox
        await this.audit.write(tx, actor, { action: ORDER_AUDIT.CREATED, entityType: 'order', entityId: order.id, entityCode: orderCode, after: { total: total.toString(), method: methodCode, items: lines.length, promotion: promo?.code ?? null } });
        await this.notify.notify({ userId: actor.userId, type: 'order', title: `Đặt hàng thành công — ${orderCode}`, content: `Tổng ${money(total).display}. ${methodCode === PAYMENT_METHOD.COD ? 'Thanh toán khi nhận hàng.' : 'Vui lòng thanh toán để đơn được xử lý.'}`, link: `/account/orders/${orderCode}` }, tx);
        const staff = await this.users.staffUserIdsWithPermission('order.order.read');
        await this.notify.notifyMany(staff.map((userId) => ({ userId, type: 'order', title: `Đơn mới ${orderCode}`, content: `${address.recipientName} · ${money(total).display} · ${methodCode}`, link: `/orders/${orderCode}` })), tx);
        await this.outbox.publish(tx, { eventType: ORDER_EVENT.CREATED, aggregateType: 'order', aggregateId: order.id, payload: { orderCode, userId: actor.userId, total: total.toString(), methodCode } });
        if (idem) await idem.complete(200, { code: orderCode }, orderCode);
        return orderCode;
      },
      { timeout: 20_000 },
    );
    this.logger.log({ orderCode: code, userId: actor.userId }, 'Đã tạo đơn hàng');
    return this.myOrder(actor, code);
  }

  private async paymentExpiry(methodCode: string): Promise<Date | null> {
    if (methodCode === PAYMENT_METHOD.VNPAY) return new Date(Date.now() + (await this.system.settingNumber(SETTING_KEY.ORDER_VNPAY_TIMEOUT_MINUTES)) * 60_000);
    if (methodCode === PAYMENT_METHOD.BANK_TRANSFER) return new Date(Date.now() + (await this.system.settingNumber(SETTING_KEY.ORDER_BANK_TRANSFER_TIMEOUT_HOURS)) * 3_600_000);
    return null;
  }

  static fromAddressBrief(a: AddressBrief): CheckoutAddress {
    return { recipientName: a.recipientName, phone: a.phone, provinceCode: a.provinceCode, provinceName: a.provinceName, districtName: a.districtName, wardName: a.wardName, street: a.street };
  }

  async myOrders(actor: AuthenticatedActor, page: number, size: number, status?: string): Promise<PageResponse<OrderSummaryResponse>> {
    const { items, total } = await this.repo.list({ userId: actor.userId, status }, (page - 1) * size, size);
    return PageResponse.of(items.map(toOrderSummary), page, size, total);
  }

  /* Bản đầy đủ cho trang "Đơn của tôi" (FE vẽ từng món) — ≤ 20 đơn/trang nên gộp extras thanh toán tuần tự vẫn nhẹ. */
  async myOrdersFull(actor: AuthenticatedActor, page: number, size: number, status?: string): Promise<PageResponse<OrderResponse>> {
    const { items, total } = await this.repo.list({ userId: actor.userId, status }, (page - 1) * size, Math.min(size, 20));
    const full = await Promise.all(items.map((o) => this.toResponse(o)));
    return PageResponse.of(full, page, size, total);
  }

  async myOrder(actor: AuthenticatedActor, code: string): Promise<OrderResponse> {
    const o = await this.repo.findByCode(code);
    if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
    return this.toResponse(o);
  }

  private async toResponse(o: OrderRow): Promise<OrderResponse> {
    const [extras, window] = await Promise.all([this.payments.extrasForOrder(o.code), this.system.settingNumber(SETTING_KEY.RETURN_WINDOW_DAYS)]);
    return toOrderResponse(o, extras, window);
  }

  async cancelByCustomer(actor: AuthenticatedActor, code: string, reason: string): Promise<OrderResponse> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.status !== ORDER_STATUS.PENDING) throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, 'Đơn đã được xác nhận, vui lòng liên hệ cửa hàng để huỷ');
      await this.doCancel(o, reason, actor, tx);
    });
    return this.myOrder(actor, code);
  }

  // ================================================================ nhân viên

  async listAdmin(f: OrderListFilter, page: number, size: number): Promise<PageResponse<OrderSummaryResponse>> {
    const { items, total } = await this.repo.list(f, (page - 1) * size, size);
    return PageResponse.of(items.map(toOrderSummary), page, size, total);
  }

  async getAdmin(code: string): Promise<OrderResponse> {
    const o = await this.repo.findByCode(code);
    if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
    return this.toResponse(o);
  }

  /*
   * Chuyển trạng thái theo lưới STAFF_TRANSITIONS. Hệ quả: confirmed → trừ kho thật (commit); delivered → COD thu tiền
   * (payment.markCodCollected → onPaid); completed → cộng sold_count. Mỗi bước: lịch sử + audit + thông báo khách + outbox.
   */
  async updateStatus(actor: AuthenticatedActor, code: string, next: string, opts: { trackingUrl?: string; note?: string }): Promise<OrderResponse> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (!(STAFF_TRANSITIONS[o.status] ?? []).includes(next)) throw new BusinessException(ORDER_ERR.INVALID_TRANSITION, `Không thể chuyển từ "${STATUS_LABEL[o.status]}" sang "${STATUS_LABEL[next]}"`);
      if (next === ORDER_STATUS.CONFIRMED && o.paymentMethodCode !== PAYMENT_METHOD.COD && o.paymentStatus !== PAYMENT_STATUS.PAID) {
        throw new BusinessException(ORDER_ERR.INVALID_TRANSITION, 'Đơn thanh toán online chưa nhận được tiền — chưa xác nhận được');
      }
      const lines = o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
      const now = new Date();
      const stamps: Prisma.OrderUncheckedUpdateInput = { status: next, updatedBy: actor.userId, ...(opts.trackingUrl ? { trackingUrl: opts.trackingUrl } : {}) };
      if (next === ORDER_STATUS.CONFIRMED) {
        stamps.confirmedAt = now;
        await this.inventory.commit(lines, { type: 'order', id: code }, tx);
      }
      if (next === ORDER_STATUS.PACKING) stamps.packedAt = now;
      if (next === ORDER_STATUS.SHIPPING) stamps.shippedAt = now;
      if (next === ORDER_STATUS.DELIVERED) {
        stamps.deliveredAt = now;
        if (o.paymentMethodCode === PAYMENT_METHOD.COD && o.paymentStatus !== PAYMENT_STATUS.PAID) await this.payment.markCodCollected(code, actor.userId, tx);
      }
      if (next === ORDER_STATUS.COMPLETED) {
        stamps.completedAt = now;
        await this.productStats.addSold(o.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), tx);
      }
      await this.repo.update(o.id, stamps, tx);
      await this.repo.addHistory(o.id, o.status, next, opts.note ?? null, actor.userId, tx);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.STATUS_CHANGED, entityType: 'order', entityId: o.id, entityCode: code, before: { status: o.status }, after: { status: next, note: opts.note ?? null } });
      await this.notify.notify({ userId: o.userId, type: 'order', title: `Đơn ${code}: ${STATUS_LABEL[next]}`, content: opts.note ?? null, link: `/account/orders/${code}` }, tx);
      await this.outbox.publish(tx, { eventType: next === ORDER_STATUS.DELIVERED ? ORDER_EVENT.DELIVERED : ORDER_EVENT.STATUS_CHANGED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: code, userId: o.userId, from: o.status, to: next } });
    });
    return this.getAdmin(code);
  }

  async cancelByStaff(actor: AuthenticatedActor, code: string, reason: string): Promise<OrderResponse> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (!(STAFF_TRANSITIONS[o.status] ?? []).includes(ORDER_STATUS.CANCELLED)) throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, `Không huỷ được đơn đang "${STATUS_LABEL[o.status]}"`);
      await this.doCancel(o, reason, actor, tx);
    });
    return this.getAdmin(code);
  }

  /* Huỷ: nhả/hoàn kho tuỳ đã commit chưa, nhả lượt KM, huỷ/hoàn thanh toán, lịch sử + audit + thông báo + outbox. */
  private async doCancel(o: OrderRow, reason: string, actor: AuthenticatedActor | null, tx: Tx): Promise<void> {
    const lines = o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    if (o.status === ORDER_STATUS.PENDING) await this.inventory.release(lines, { type: 'order', id: o.code }, tx);
    else await this.inventory.restock(lines, { type: 'order', id: o.code }, tx);
    await this.promotion.release(o.code, tx);
    if (o.paymentStatus === PAYMENT_STATUS.PAID) {
      await this.payment.requestRefund({ orderCode: o.code, amount: BigInt(o.total.toString()), reason: `Huỷ đơn: ${reason}`, returnRequestId: null, actorUserId: actor?.userId ?? null }, tx);
    } else {
      await this.payment.cancel(o.code, reason, tx);
    }
    await this.repo.update(o.id, { status: ORDER_STATUS.CANCELLED, cancelReason: reason, cancelledAt: new Date(), cancelledBy: actor?.userId ?? null, updatedBy: actor?.userId ?? null }, tx);
    await this.repo.addHistory(o.id, o.status, ORDER_STATUS.CANCELLED, reason, actor?.userId ?? null, tx);
    await this.audit.write(tx, actor, { action: ORDER_AUDIT.CANCELLED, entityType: 'order', entityId: o.id, entityCode: o.code, before: { status: o.status }, after: { reason, refund: o.paymentStatus === PAYMENT_STATUS.PAID } });
    await this.notify.notify({ userId: o.userId, type: 'order', title: `Đơn ${o.code} đã huỷ`, content: reason, link: `/account/orders/${o.code}` }, tx);
    await this.outbox.publish(tx, { eventType: ORDER_EVENT.CANCELLED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: o.code, userId: o.userId, reason } });
  }

  // ================================================================ cổng ngược từ payment

  async onPaid(orderCode: string, info: { paymentId: string; methodCode: string; transactionCode: string | null; bankCode: string | null; paidAt: Date }, tx: Tx): Promise<void> {
    const o = await this.repo.findByCodeForUpdate(orderCode, tx);
    if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, `Không tìm thấy đơn ${orderCode}`);
    if (o.paymentStatus === PAYMENT_STATUS.PAID) return; // IPN lặp — đã xử lý
    await this.repo.update(o.id, { paymentStatus: PAYMENT_STATUS.PAID, paymentExpiresAt: null, updatedBy: null }, tx);
    await this.audit.write(tx, null, { action: ORDER_AUDIT.PAID, entityType: 'order', entityId: o.id, entityCode: orderCode, after: { method: info.methodCode, transactionCode: info.transactionCode } });
    if (o.paymentMethodCode !== PAYMENT_METHOD.COD) {
      await this.notify.notify({ userId: o.userId, type: 'payment', title: `Đã nhận thanh toán đơn ${orderCode}`, content: `Cảm ơn bạn. Đơn sẽ được xác nhận và đóng gói sớm.`, link: `/account/orders/${orderCode}` }, tx);
      const staff = await this.users.staffUserIdsWithPermission('order.order.status.update');
      await this.notify.notifyMany(staff.map((userId) => ({ userId, type: 'payment', title: `Đơn ${orderCode} đã thanh toán`, content: `${info.methodCode} · ${money(o.total.toString()).display}`, link: `/orders/${orderCode}` })), tx);
    }
    await this.outbox.publish(tx, { eventType: ORDER_EVENT.PAID, aggregateType: 'order', aggregateId: o.id, payload: { orderCode, userId: o.userId, methodCode: info.methodCode } });
  }

  async onPaymentFailed(orderCode: string, reason: string, tx: Tx): Promise<void> {
    const o = await this.repo.findByCodeForUpdate(orderCode, tx);
    if (!o || o.status !== ORDER_STATUS.PENDING || o.paymentStatus === PAYMENT_STATUS.PAID) return;
    await this.repo.addHistory(o.id, o.status, o.status, `Thanh toán thất bại: ${reason}`, null, tx);
    await this.notify.notify({ userId: o.userId, type: 'payment', title: `Thanh toán đơn ${orderCode} không thành công`, content: `${reason}. Bạn có thể thử lại trong trang đơn hàng.`, link: `/account/orders/${orderCode}` }, tx);
  }

  async onRefunded(orderCode: string, amount: bigint, refundId: string, tx: Tx): Promise<void> {
    const o = await this.repo.findByCodeForUpdate(orderCode, tx);
    if (!o) return;
    const full = amount >= BigInt(o.total.toString());
    await this.repo.update(o.id, { paymentStatus: full ? PAYMENT_STATUS.REFUNDED : PAYMENT_STATUS.PARTIALLY_REFUNDED, updatedBy: null }, tx);
    await this.repo.addHistory(o.id, o.status, o.status, `Đã hoàn ${money(amount).display}`, null, tx);
    await this.notify.notify({ userId: o.userId, type: 'payment', title: `Đã hoàn tiền đơn ${orderCode}`, content: `Số tiền ${money(amount).display} đã được hoàn.`, link: `/account/orders/${orderCode}`, payload: { refundId } }, tx);
  }

  // ================================================================ jobs (worker)

  async cancelExpired(limit = 50): Promise<number> {
    const rows = await this.repo.findPaymentExpired(limit);
    let n = 0;
    for (const { code } of rows) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const o = await this.repo.findByCodeForUpdate(code, tx);
          if (!o || o.status !== ORDER_STATUS.PENDING || o.paymentStatus === PAYMENT_STATUS.PAID) return;
          await this.doCancel(o, 'Quá hạn thanh toán', null, tx);
          n += 1;
        });
      } catch (err) {
        this.logger.warn({ err, code }, 'Huỷ đơn quá hạn lỗi');
      }
    }
    return n;
  }

  async autoComplete(limit = 100): Promise<number> {
    const days = await this.system.settingNumber(SETTING_KEY.ORDER_AUTO_COMPLETE_DAYS);
    const rows = await this.repo.findDeliveredBefore(new Date(Date.now() - days * 86_400_000), limit);
    let n = 0;
    for (const { code } of rows) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const o = await this.repo.findByCodeForUpdate(code, tx);
          if (!o || o.status !== ORDER_STATUS.DELIVERED) return;
          await this.repo.update(o.id, { status: ORDER_STATUS.COMPLETED, completedAt: new Date() }, tx);
          await this.repo.addHistory(o.id, o.status, ORDER_STATUS.COMPLETED, `Tự hoàn tất sau ${days} ngày`, null, tx);
          await this.productStats.addSold(o.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), tx);
          n += 1;
        });
      } catch (err) {
        this.logger.warn({ err, code }, 'Tự hoàn tất đơn lỗi');
      }
    }
    return n;
  }

  /* Bảo vệ: chỉ chủ đơn hoặc nhân viên có quyền mới xem — dùng cho route dùng chung. */
  assertOwner(o: OrderRow, actor: AuthenticatedActor): void {
    if (o.userId !== actor.userId) throw new ForbiddenException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
  }
}
