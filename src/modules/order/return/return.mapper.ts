import type { RefundSummary } from '@common/gateway/payment.gateway';
import { money } from '@common/response/money-response';
import type { Prisma } from '@common/prisma/types';
import { RETURN_STATUS } from '../foundation/order.constants';
import { MediaItemResponse, ReturnRequestResponse } from './dto/return.responses';
import { canCancel, canEscalate, canShipBack, deadlineOf, maskAccountNumber, readRefundAccount, readReturnAddress } from './return.rules';

export const RETURN_INCLUDE = { items: true } as const;
export type ReturnRow = Prisma.ReturnRequestGetPayload<{ include: typeof RETURN_INCLUDE }>;

/* Ai đang xem: quyết định phần nào được lộ (tài khoản nhận hoàn của khách KHÔNG ra cho shop; id nhân viên phân xử chỉ ra cho sàn). */
export type ReturnViewer = 'customer' | 'shop' | 'admin';

export interface ReturnResponseContext {
  shopName: string;
  /* Khoản hoàn mới nhất của ĐƠN (payment) — chỉ gắn vào yêu cầu đã received/refunded. */
  refund: RefundSummary | null;
  now: Date;
  viewer: ReturnViewer;
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

function media(raw: unknown): MediaItemResponse[] {
  return Array.isArray(raw) ? (raw as MediaItemResponse[]).map((m) => ({ type: m.type, url: m.url, name: m.name })) : [];
}

/* Dòng yêu cầu → ReturnRequestResponse (PLAN-0022 §4.1). Hạn + cờ hành động tính ở return.rules.ts từ cùng một mốc `now` nên khớp tuyệt đối với kiểm tra ở service. */
export function toReturnResponse(r: ReturnRow, ctx: ReturnResponseContext): ReturnRequestResponse {
  const { at, kind } = deadlineOf(r);
  const account = ctx.viewer === 'shop' ? null : readRefundAccount(r.refundAccount);
  const address = r.status === RETURN_STATUS.APPROVED ? readReturnAddress(r.returnAddress) : null;
  const hasRefund = r.status === RETURN_STATUS.RECEIVED || r.status === RETURN_STATUS.REFUNDED;
  return {
    id: r.id,
    orderCode: r.orderCode,
    shopId: r.shopId,
    shopName: ctx.shopName,
    status: r.status,
    reasonCode: r.reasonCode,
    requireReturn: r.requireReturn,
    reason: r.reason,
    detail: r.detail,
    refundAmount: money(r.refundAmount.toString()),
    calculatedRefundAmount: money((r.calculatedRefundAmount ?? r.refundAmount).toString()),
    adjustReason: r.adjustReason,
    items: r.items.map((i) => ({ orderItemId: i.orderItemId, name: i.name, color: i.color, size: i.size, quantity: i.quantity, imageUrl: i.imageUrl })),
    evidence: media(r.evidence),
    deadlineAt: iso(at),
    deadlineKind: kind,
    approvedAt: iso(r.approvedAt),
    returnAddress: address,
    carrier: r.carrier,
    trackingCode: r.trackingCode,
    shippedBackAt: iso(r.shippedBackAt),
    receivedAt: iso(r.receivedAt),
    receivedCondition: r.receivedCondition,
    receivedNote: r.receivedNote,
    receivedEvidence: media(r.receivedEvidence),
    rejectedBy: r.rejectedBy,
    rejectReason: r.rejectReason,
    rejectEvidence: media(r.rejectEvidence),
    escalatedAt: iso(r.escalatedAt),
    escalateReason: r.escalateReason,
    escalateSource: r.escalateSource,
    resolvedBy: ctx.viewer === 'admin' ? r.resolvedBy : null,
    resolvedAt: iso(r.resolvedAt),
    resolveDecision: r.resolveDecision,
    resolveNote: r.resolveNote,
    refundAccount: account ? { bankBin: account.bankBin, bankName: account.bankName ?? null, accountNumberMasked: maskAccountNumber(account.accountNumber), accountName: account.accountName } : null,
    refund: hasRefund && ctx.refund ? { status: ctx.refund.status, amount: money(ctx.refund.amount) } : null,
    // COD-08b: "chưa nhận hàng" trên đơn COD đã ghi thu kết thúc bằng ĐẢO ghi thu (refundAmount = 0, không có khoản hoàn) — FE hiện thay cho "đã hoàn tiền".
    codReversed: r.reasonCode === 'not_received' && r.status === RETURN_STATUS.REFUNDED && r.refundAmount.toString() === '0',
    canCancel: canCancel(r),
    canShipBack: canShipBack(r, ctx.now),
    canEscalate: canEscalate(r, ctx.now),
    processedAt: iso(r.processedAt),
    refundedAt: iso(r.refundedAt),
    createdAt: r.createdAt.toISOString(),
  };
}
