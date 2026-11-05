import type { WalletTopupDetailResponse, WalletTopupReceiptResponse, WalletTopupResponse } from '../dto/shop-wallet-topup.dto';
import { TOPUP_STATUS } from '../../foundation/payment.constants';
import type { TopupReceiptRow, TopupRow, TopupStatus } from '../shop-wallet-topup.types';

/*
 * Mapper khoản nạp PayOS → DTO trả ra API (PLAN-0041 §5.1–5.2). Đây là ĐIỂM DUY NHẤT quyết định trường nhạy cảm:
 * - checkoutUrl/qrCode CHỈ lộ cho chủ shop (exposeLink) và khi khoản còn chờ thanh toán (pending|partial) VÀ chưa quá hạn; sàn không bao giờ thấy link.
 * - canCancel chỉ đúng với chủ shop (có route huỷ); sàn xem-only nên luôn false.
 * - Tiền ra dạng chuỗi số nguyên VND (toFixed(0)), thời gian ISO-8601 — không float, không trả model Prisma thô.
 * Dùng chung cho ShopWalletTopupController và ShopWalletController (GET /shop/wallet · payosTopup.active).
 */
export interface TopupViewOptions {
  shopName?: string;
  exposeLink: boolean;
}

/* Trạng thái còn có thể thanh toán / huỷ (không gồm creating: chưa có link để trả). */
const PAYABLE_STATUSES: readonly string[] = [TOPUP_STATUS.PENDING, TOPUP_STATUS.PARTIAL];

export function toTopupResponse(t: TopupRow, opts: TopupViewOptions): WalletTopupResponse {
  const payable = PAYABLE_STATUSES.includes(t.status);
  const showLink = opts.exposeLink && payable && t.expiresAt.getTime() > Date.now();
  return {
    id: t.id,
    shopId: t.shopId,
    shopName: opts.shopName,
    amount: t.amount.toFixed(0),
    receivedAmount: t.receivedAmount.toFixed(0),
    // DB CHECK chk_shop_cod_topups_status đã giới hạn đúng 7 giá trị — ép kiểu sang union của DTO là an toàn.
    status: t.status as TopupStatus,
    payosOrderCode: t.payosOrderCode,
    checkoutUrl: showLink ? t.checkoutUrl : null,
    qrCode: showLink ? t.qrCode : null,
    expiresAt: t.expiresAt.toISOString(),
    paidAt: t.paidAt?.toISOString() ?? null,
    closedAt: t.closedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    canCancel: opts.exposeLink && payable,
  };
}

export function toTopupReceipt(r: TopupReceiptRow): WalletTopupReceiptResponse {
  return { reference: r.reference, amount: r.amount.toFixed(0), createdAt: r.createdAt.toISOString() };
}

/* Chi tiết cho sàn: không bao giờ kèm link thanh toán; thêm biên nhận và thông tin dò PayOS để kế toán đối chiếu. */
export function toTopupDetail(t: TopupRow, receipts: TopupReceiptRow[], shopName?: string): WalletTopupDetailResponse {
  return {
    ...toTopupResponse(t, { shopName, exposeLink: false }),
    receipts: receipts.map(toTopupReceipt),
    lastGatewayStatus: t.lastGatewayStatus,
    lastCheckedAt: t.lastCheckedAt?.toISOString() ?? null,
  };
}
