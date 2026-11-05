import type { RefundSummary } from '@common/gateway/payment.gateway';
import { money } from '@common/response/money-response';
import { carrierName } from '../../foundation/delivery.rules';
import { CANCEL_REASON_LABEL, GOODS_RETURN_WINDOW_DAYS, ORDER_STATUS, STATUS_LABEL } from '../../foundation/order.constants';
import { OrderGroupResponse, OrderRefundResponse, OrderResponse, OrderSummaryResponse } from '../dto/order.responses';
import type { OrderGroupRow, OrderRow } from '../repository/order.repository';

export interface PaymentExtras {
  paymentUrl: string | null;
  /* Đơn PayOS còn chờ trả mà chưa có link (tạo link lỗi) — khách bấm "Thanh toán lại". */
  linkRetryable?: boolean;
  transactionCode: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
}

/* Khoản hoàn tiền mới nhất của đơn (từ payment) → response; null khi chưa có khoản hoàn nào. */
export function toRefundResponse(refund: RefundSummary | null | undefined): OrderRefundResponse | null {
  return refund ? { status: refund.status, amount: money(refund.amount) } : null;
}

/*
 * `opts.refund`: khoản hoàn mới nhất của đơn (payment, tra theo LÔ ở service). `opts.notReceivedDays`: hạn báo "chưa nhận hàng" (return.not_received_days) — 0/bỏ trống = chỉ báo được khi đơn đang giao.
 * Cờ canReturn/canReportNotReceived ở đây mới xét trạng thái + giờ; service còn trừ số lượng đã giữ chỗ bởi yêu cầu đổi trả khác.
 */
export function toOrderResponse(o: OrderRow, extras: PaymentExtras | null, returnWindowDays: number, shopName: string, opts: { refund?: RefundSummary | null; notReceivedDays?: number; staffView?: boolean } = {}): OrderResponse {
  const canReturn = (o.status === ORDER_STATUS.DELIVERED || o.status === ORDER_STATUS.COMPLETED) && !!o.deliveredAt && Date.now() - o.deliveredAt.getTime() <= returnWindowDays * 86_400_000;
  const canReportNotReceived = o.status === ORDER_STATUS.SHIPPING || (o.status === ORDER_STATUS.DELIVERED && !!o.deliveredAt && Date.now() - o.deliveredAt.getTime() <= (opts.notReceivedDays ?? 0) * 86_400_000);
  return {
    id: o.id,
    ...(o.fulfilmentMode === 'carrier' ? {fulfilmentMode:'carrier',collectionMode:o.collectionMode ?? (o.paymentMethodCode === 'cod' ? 'carrier_cod':'platform_online'),carrierCodStatus:o.paymentMethodCode === 'cod' && [ORDER_STATUS.DELIVERED,ORDER_STATUS.COMPLETED].includes(o.status as 'delivered'|'completed') ? (o.paymentStatus === 'paid' ? 'remitted':'collected_pending_remittance') : undefined,canShip:o.status === ORDER_STATUS.PACKING && o.cancelRequestStatus !== 'pending'} : {}),
    code: o.code,
    status: o.status,
    statusLabel: STATUS_LABEL[o.status] ?? o.status,
    paymentMethodCode: o.paymentMethodCode,
    paymentStatus: o.paymentStatus,
    shopId: o.shopId,
    shopName,
    cardBrand: extras?.cardBrand ?? null,
    cardLast4: extras?.cardLast4 ?? null,
    transactionCode: extras?.transactionCode ?? null,
    recipientName: o.recipientName,
    recipientPhone: o.recipientPhone,
    shippingAddress: o.shippingAddress,
    customerNote: o.customerNote,
    items: o.items.map((i) => ({ id: i.id, variantId: i.variantId, productId: i.productId, slug: i.slug, name: i.name, imageUrl: i.imageUrl, color: i.color, size: i.size, sku: i.sku, quantity: i.quantity, unitPrice: money(i.unitPrice.toString()), lineTotal: money(i.lineTotal.toString()), reviewed: i.reviewed })),
    subtotal: money(o.subtotal.toString()),
    shippingFee: money(o.shippingFee.toString()),
    discount: money(o.discount.toString()),
    promotion: o.promotionCode ? { code: o.promotionCode, name: o.promotionName } : null,
    shopPromotion: o.shopPromotionCode ? { code: o.shopPromotionCode, name: o.shopPromotionName } : null,
    shopDiscount: money(o.shopDiscount.toString()),
    platformDiscount: money(o.platformDiscount.toString()),
    total: money(o.total.toString()),
    paymentUrl: extras?.paymentUrl ?? null,
    linkRetryable: extras?.linkRetryable ?? false,
    paymentExpiresAt: o.paymentExpiresAt?.toISOString() ?? null,
    trackingUrl: o.trackingUrl,
    // PLAN-0040 Tầng 3.6–3.7: hãng + mã vận đơn (khách/shop/sàn đều thấy); cờ dùng lại mã vận đơn là tín hiệu nghi gian lận ⇒ CHỈ ra cho shop (extras = null) và nhân viên sàn (staffView), luôn false với khách.
    carrier: o.carrier ?? null,
    carrierName: carrierName(o.carrier),
    trackingCode: o.trackingCode ?? null,
    trackingReused: (extras === null || opts.staffView === true) && o.trackingReused === true,
    deliveryFailedAt: o.deliveryFailedAt?.toISOString() ?? null,
    deliveryFailedReason: o.deliveryFailedReason ?? null,
    goodsReturnedAt: o.goodsReturnedAt?.toISOString() ?? null,
    canConfirmGoodsReturned: o.status === ORDER_STATUS.CANCELLED && !!o.deliveryFailedAt && !o.goodsReturnedAt && Date.now() - o.deliveryFailedAt.getTime() <= GOODS_RETURN_WINDOW_DAYS * 86_400_000,
    cancelReason: o.cancelReason,
    history: o.histories.map((h) => ({ fromStatus: h.fromStatus, toStatus: h.toStatus, toStatusLabel: STATUS_LABEL[h.toStatus] ?? h.toStatus, note: h.note, createdAt: h.createdAt.toISOString() })),
    // PLAN-0027: khách huỷ TỨC THÌ tới `confirmed`; đơn đóng gói chỉ gửi yêu cầu huỷ (một lần); địa chỉ đổi được khi chờ xác nhận / đã xác nhận.
    canCancel: o.status === ORDER_STATUS.PENDING || o.status === ORDER_STATUS.CONFIRMED,
    canRequestCancel: o.status === ORDER_STATUS.PACKING && !o.cancelRequestStatus,
    canChangeAddress: o.status === ORDER_STATUS.PENDING || o.status === ORDER_STATUS.CONFIRMED,
    canMarkReceived: o.status === ORDER_STATUS.DELIVERED, // OrderService.toResponses trừ tiếp đơn đang có đổi trả mở
    confirmDueAt: o.confirmDueAt?.toISOString() ?? null,
    shipDueAt: o.shipDueAt?.toISOString() ?? null,
    shipExtended: !!o.shipExtendedAt,
    cancelReasonCode: o.cancelReasonCode ?? null,
    cancelledBy: o.cancelSource ?? null,
    cancelRequest: o.cancelRequestStatus
      ? {
          status: o.cancelRequestStatus,
          reasonCode: o.cancelRequestReasonCode ?? null,
          reasonLabel: o.cancelRequestReasonCode ? (CANCEL_REASON_LABEL[o.cancelRequestReasonCode] ?? null) : null,
          note: o.cancelRequestNote ?? null,
          requestedAt: o.cancelRequestedAt?.toISOString() ?? null,
          dueAt: o.cancelRequestDueAt?.toISOString() ?? null,
          rejectReason: o.cancelRequestRejectReason ?? null,
        }
      : null,
    canReturn,
    canReportNotReceived,
    refund: toRefundResponse(opts.refund),
    createdAt: o.createdAt.toISOString(),
  };
}

export function toOrderGroupResponse(g: OrderGroupRow, orders: OrderResponse[]): OrderGroupResponse {
  return {
    code: g.code,
    recipientName: g.recipientName,
    recipientPhone: g.recipientPhone,
    shippingAddress: g.shippingAddress,
    subtotal: money(g.subtotal.toString()),
    shippingFee: money(g.shippingFee.toString()),
    discount: money(g.discount.toString()),
    total: money(g.total.toString()),
    orders,
    createdAt: g.createdAt.toISOString(),
  };
}

export function toOrderSummary(o: OrderRow, refund?: RefundSummary | null): OrderSummaryResponse {
  const first = o.items[0];
  return {
    code: o.code,
    status: o.status,
    statusLabel: STATUS_LABEL[o.status] ?? o.status,
    paymentMethodCode: o.paymentMethodCode,
    paymentStatus: o.paymentStatus,
    itemCount: o.itemCount,
    total: money(o.total.toString()),
    firstItemName: first?.name ?? null,
    firstItemImage: first?.imageUrl ?? null,
    recipientName: o.recipientName,
    refund: toRefundResponse(refund),
    confirmDueAt: o.confirmDueAt?.toISOString() ?? null,
    shipDueAt: o.shipDueAt?.toISOString() ?? null,
    cancelRequestStatus: o.cancelRequestStatus ?? null,
    createdAt: o.createdAt.toISOString(),
  };
}
