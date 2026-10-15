import { money } from '@common/response/money-response';
import { ORDER_STATUS, STATUS_LABEL } from '../../foundation/order.constants';
import { OrderGroupResponse, OrderResponse, OrderSummaryResponse, ReturnRequestResponse } from '../dto/order.responses';
import type { OrderGroupRow, OrderRow } from '../repository/order.repository';

export interface PaymentExtras {
  paymentUrl: string | null;
  transactionCode: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
}

export function toOrderResponse(o: OrderRow, extras: PaymentExtras | null, returnWindowDays: number, shopName: string): OrderResponse {
  const canReturn = (o.status === ORDER_STATUS.DELIVERED || o.status === ORDER_STATUS.COMPLETED) && !!o.deliveredAt && Date.now() - o.deliveredAt.getTime() <= returnWindowDays * 86_400_000;
  return {
    id: o.id,
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
    paymentExpiresAt: o.paymentExpiresAt?.toISOString() ?? null,
    trackingUrl: o.trackingUrl,
    cancelReason: o.cancelReason,
    history: o.histories.map((h) => ({ fromStatus: h.fromStatus, toStatus: h.toStatus, toStatusLabel: STATUS_LABEL[h.toStatus] ?? h.toStatus, note: h.note, createdAt: h.createdAt.toISOString() })),
    canCancel: o.status === ORDER_STATUS.PENDING,
    canReturn,
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

export function toOrderSummary(o: OrderRow): OrderSummaryResponse {
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
    createdAt: o.createdAt.toISOString(),
  };
}

export function toReturnResponse(r: { id: string; orderCode: string; status: string; reason: string; detail: string | null; rejectReason: string | null; refundAmount: { toString(): string }; evidence: unknown; processedAt: Date | null; createdAt: Date; items: Array<{ orderItemId: string; name: string; color: string; size: string; quantity: number; imageUrl: string | null }> }): ReturnRequestResponse {
  return {
    id: r.id,
    orderCode: r.orderCode,
    status: r.status,
    reason: r.reason,
    detail: r.detail,
    rejectReason: r.rejectReason,
    refundAmount: money(r.refundAmount.toString()),
    items: r.items.map((i) => ({ orderItemId: i.orderItemId, name: i.name, color: i.color, size: i.size, quantity: i.quantity, imageUrl: i.imageUrl })),
    evidence: Array.isArray(r.evidence) ? (r.evidence as Array<{ type: string; url: string; name: string }>) : [],
    processedAt: r.processedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
