import type { ShopCodTopup, ShopCodTopupReceipt } from '../../../generated/prisma/client';
import type { TOPUP_STATUS } from '../foundation/payment.constants';

/*
 * Kiểu dùng chung cho nạp cọc COD qua PayOS (PLAN-0041 §6). Dùng bởi ShopWalletTopupService (tạo/đọc/huỷ link),
 * ShopWalletTopupSettleService (ghi có ví, dò, đóng link) và controller/mapper.
 * TopupRow/TopupReceiptRow là đúng model Prisma — CHỈ dùng trong module payment; ra ngoài API phải đổi sang DTO (mapper), không trả model thô.
 */
export type TopupRow = ShopCodTopup;
export type TopupReceiptRow = ShopCodTopupReceipt;
export type TopupStatus = (typeof TOPUP_STATUS)[keyof typeof TOPUP_STATUS];

/* Kết quả xử lý một webhook PayOS đã xác minh chữ ký (settleWebhookIfTopup). Các nhánh chi tiết do WP-3 định nghĩa theo §6.4. */
export interface TopupWebhookResult {
  outcome: 'credited' | 'replay' | 'noop' | 'ignored' | 'unkeyed';
  message: string;
}

/* Kết quả một lần dò/làm mới khoản nạp với PayOS (reconcileOne): có ghi có thêm, đã đóng link, không đổi, PayOS không rõ, bỏ qua do vừa hỏi, hoặc không có khoản. */
export type TopupReconcileOutcome = 'credited' | 'closed' | 'unchanged' | 'unknown' | 'skipped' | 'not_found';

/* Thông tin gian hàng cần để tạo link nạp: mã gian hàng dựng mô tả đối soát trên link, tên để hiển thị cho sàn. */
export interface TopupShopContext {
  shopId: string;
  shopCode: string;
  shopName: string;
}

/* Tóm tắt cho GET /shop/wallet (WalletResponse.payosTopup): cờ bật, mức tiền, và khoản còn mở (còn hạn) nếu có. */
export interface TopupSummary {
  enabled: boolean;
  minAmount: number;
  maxAmount: number;
  active: TopupRow | null;
}
