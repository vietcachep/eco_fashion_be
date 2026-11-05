export const PAYMENT_MODULE = 'payment';

export const PAYMENT_ERR = {
  NOT_FOUND: 'PAYMENT_NOT_FOUND',
  METHOD_INACTIVE: 'PAYMENT_METHOD_INACTIVE',
  PAYOS_NOT_CONFIGURED: 'PAYMENT_PAYOS_NOT_CONFIGURED',
  INVALID_SIGNATURE: 'PAYMENT_INVALID_SIGNATURE',
  AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  ALREADY_PAID: 'PAYMENT_ALREADY_PAID',
  INVALID_STATE: 'PAYMENT_INVALID_STATE',
  REFUND_NOT_FOUND: 'PAYMENT_REFUND_NOT_FOUND',
  REFUND_EXCEEDS: 'PAYMENT_REFUND_EXCEEDS',
  /* Cổng PayOS từ chối / báo thất bại lệnh hoàn tiền (502). */
  REFUND_FAILED: 'PAYMENT_REFUND_FAILED',
  /* Không có đường tự chi (thiếu tài khoản nhận / chưa cấu hình payout) — kế toán chuyển tay rồi nhập mã giao dịch. */
  REFUND_MANUAL_REQUIRED: 'PAYMENT_REFUND_MANUAL_REQUIRED',
  /* AUD-14: lệnh chi hoàn tiền ở trạng thái KHÔNG RÕ (PayOS có thể ĐÃ chi) mà kế toán đòi ghi sổ chuyển tay ⇒ 409 — đối chiếu PayOS trước, hoặc xác nhận lệnh chưa chạy (confirmGatewayNotExecuted). */
  REFUND_RECONCILE_REQUIRED: 'PAYMENT_REFUND_RECONCILE_REQUIRED',
  /* PLAN-0022: mã giao dịch hoàn tay (providerRef) đã được một khoản hoàn khác dùng (409). Tên theo hợp đồng FE của plan (không tiền tố PAYMENT_). */
  REFUND_PROVIDER_REF_DUPLICATE: 'REFUND_PROVIDER_REF_DUPLICATE',
  /* PLAN-0022: tài khoản nhận hoàn do khách khai sai định dạng (400). Thiếu tài khoản KHÔNG còn bị chặn — refund vẫn được tạo, kế toán liên hệ khách rồi chuyển tay. */
  REFUND_PAYEE_INVALID: 'PAYMENT_REFUND_PAYEE_INVALID',
  /* PLAN-0022: refund chưa có tài khoản nhận nào để xem (không có tài khoản đã trả tiền, khách cũng chưa khai) — 404. */
  REFUND_PAYEE_NOT_FOUND: 'PAYMENT_REFUND_PAYEE_NOT_FOUND',
} as const;

/* PLAN-0020 — ví đặt cọc COD của gian hàng. */
export const WALLET_ERR = {
  DEPOSIT_NOT_FOUND: 'WALLET_DEPOSIT_NOT_FOUND',
  DEPOSIT_PENDING_EXISTS: 'WALLET_DEPOSIT_PENDING_EXISTS',
  DEPOSIT_TOO_SMALL: 'WALLET_DEPOSIT_TOO_SMALL',
  INVALID_STATE: 'WALLET_INVALID_STATE',
  COD_NOT_AVAILABLE: 'WALLET_COD_NOT_AVAILABLE',
  TRANSFER_REF_DUPLICATE: 'WALLET_TRANSFER_REF_DUPLICATE',
  /* PLAN-0041 — nạp cọc qua PayOS (§5.4). */
  TOPUP_DISABLED: 'WALLET_TOPUP_DISABLED',
  TOPUP_UNAVAILABLE: 'WALLET_TOPUP_UNAVAILABLE',
  TOPUP_LINK_FAILED: 'WALLET_TOPUP_LINK_FAILED',
  TOPUP_TOO_LARGE: 'WALLET_TOPUP_TOO_LARGE',
  TOPUP_NOT_FOUND: 'WALLET_TOPUP_NOT_FOUND',
  TOPUP_INVALID_STATE: 'WALLET_TOPUP_INVALID_STATE',
  TOPUP_IN_PROGRESS: 'WALLET_TOPUP_IN_PROGRESS',
  DEPOSIT_PAYOS_NOT_MANUAL: 'WALLET_DEPOSIT_PAYOS_NOT_MANUAL',
} as const;
export const WALLET_AUDIT = { DEPOSIT_REQUESTED: 'WALLET_DEPOSIT_REQUESTED', DEPOSIT_APPROVED: 'WALLET_DEPOSIT_APPROVED', DEPOSIT_REJECTED: 'WALLET_DEPOSIT_REJECTED', ADJUSTED: 'WALLET_ADJUSTED', TOPUP_CREATED: 'WALLET_TOPUP_CREATED', TOPUP_LINK_FAILED: 'WALLET_TOPUP_LINK_FAILED', TOPUP_CREDITED: 'WALLET_TOPUP_CREDITED', TOPUP_CANCELLED: 'WALLET_TOPUP_CANCELLED', TOPUP_EXPIRED: 'WALLET_TOPUP_EXPIRED' } as const;
/* cod_reversal (PLAN-0040 Tầng 3.6, COD-08b): đảo ghi thu cod_commission khi khách báo chưa nhận hàng. topup_payos (PLAN-0041): nạp cọc qua PayOS, luôn dương, có topup_id + ref_key.
 * Khớp CHECK chk_shop_cod_wallet_tx_type của migration 20261103090000_wallet_payos_topup (trước đó 20261028120000_delivery_proof) — thêm loại ở đây phải có migration nới CHECK tương ứng. */
export const WALLET_TX_TYPE = { DEPOSIT: 'deposit', COD_COMMISSION: 'cod_commission', COD_REFUND: 'cod_refund', ADJUST: 'adjust', COD_REVERSAL: 'cod_reversal', TOPUP_PAYOS: 'topup_payos' } as const;
export const DEPOSIT_STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' } as const;

/* PLAN-0041 — khoản nạp cọc COD qua PayOS (bảng payment.shop_cod_topups). Trạng thái khớp CHECK chk_shop_cod_topups_status. */
export const TOPUP_STATUS = { CREATING: 'creating', PENDING: 'pending', PARTIAL: 'partial', PAID: 'paid', EXPIRED: 'expired', CANCELLED: 'cancelled', FAILED: 'failed' } as const;
export const TOPUP_STATUS_VALUES: readonly string[] = Object.values(TOPUP_STATUS);
/* Khoản "còn mở" — chiếm slot một-khoản-mở/shop (chỉ mục uq_shop_cod_topups_active_per_shop). Mảng readonly: đưa vào Prisma `in` PHẢI trải ra [...TOPUP_OPEN_STATUSES]. */
export const TOPUP_OPEN_STATUSES: readonly string[] = [TOPUP_STATUS.CREATING, TOPUP_STATUS.PENDING, TOPUP_STATUS.PARTIAL];
export const TOPUP_CLOSED_STATUSES: readonly string[] = [TOPUP_STATUS.EXPIRED, TOPUP_STATUS.CANCELLED, TOPUP_STATUS.FAILED];
/* Mốc thời gian (ms) của máy trạng thái nạp cọc (PLAN-0041 §4, §6). EXPIRE_GRACE_MS: chỉ đóng link sau hạn + 2 phút (lệch đồng hồ, tiền về sát giờ — D20).
 * STALE_CREATING_MS: dòng `creating` còn được coi là "đang tạo" trong 60 giây; ORPHAN_MS: quá 90 giây mà PayOS không biết link ⇒ failed (mồ côi). TAIL_*: quét đuôi 72 giờ cho khoản đã đóng. OPEN_RECHECK/ONDEMAND: chu kỳ/khoảng chống hỏi PayOS dày. */
export const TOPUP_TIMING = { EXPIRE_GRACE_MS: 2*60_000, ORPHAN_MS: 90_000, STALE_CREATING_MS: 60_000, TAIL_MS: 72*3_600_000, TAIL_RECHECK_MS: 6*3_600_000, OPEN_RECHECK_MS: 60_000, ONDEMAND_RECHECK_MS: 8_000 } as const;
/* Tiền tố khoá idempotent của sổ cái ví: ref_key = `payos-topup:<topupId>:<mục tiêu luỹ kế>` (PLAN-0041 D8). */
export const TOPUP_REF_PREFIX = 'payos-topup:';
/* Dải mã PayOS RIÊNG cho nạp cọc (PLAN-0041 D4): 5e15..6e15. Mã đơn hàng ≈ 1,8e15 nên hai dải không giao nhau; CHECK ở DB chặn mã ngoài dải. */
export const TOPUP_PAYOS_CODE_BASE = 5_000_000_000_000_000;
/* Trần cột numeric(14,0) — số tiền nạp phải nằm trong đây trước khi ghi DB. */
export const TOPUP_MAX_AMOUNT_COLUMN = 99_999_999_999_999n;

export const PAYMENT_AUDIT = {
  INITIATED: 'PAYMENT_INITIATED',
  PAID: 'PAYMENT_PAID',
  FAILED: 'PAYMENT_FAILED',
  CANCELLED: 'PAYMENT_CANCELLED',
  REFUND_REQUESTED: 'REFUND_REQUESTED',
  REFUND_PROCESSED: 'REFUND_PROCESSED',
  /* Phục hồi refund treo ở `processing` (nhả về requested / đánh failed chờ đối chiếu) — không tự chi tiền. */
  REFUND_RECOVERED: 'REFUND_RECOVERED',
  /* PLAN-0022: PayOS NHẬN lệnh chi (chưa chốt) · lệnh chi bị báo thất bại · treo bất thường quá hạn (đã báo kế toán). */
  REFUND_GATEWAY_SUBMITTED: 'REFUND_GATEWAY_SUBMITTED',
  REFUND_FAILED: 'REFUND_FAILED',
  REFUND_GATEWAY_STALLED: 'REFUND_GATEWAY_STALLED',
  /* Kế toán xem SỐ TÀI KHOẢN ĐẦY ĐỦ của khoản hoàn (GET /admin/refunds/:id/payee) — ghi ai, refundId, orderCode; KHÔNG ghi số tài khoản. */
  REFUND_PAYEE_VIEWED: 'REFUND_PAYEE_VIEWED',
  METHOD_UPDATED: 'PAYMENT_METHOD_UPDATED',
  /* PLAN-0040 Tầng 3.6 (COD-08b): đảo ghi thu COD — khách báo chưa nhận hàng nên khách chưa trả tiền mặt; payment `paid` → `cancelled` kèm reversed_at, KHÔNG hoàn tiền. */
  COD_REVERSED: 'PAYMENT_COD_REVERSED',
} as const;

export const PAYMENT_EVENT = { PAID: 'PAYMENT_PAID', REFUNDED: 'PAYMENT_REFUNDED', PAYOUT_CREATED: 'PAYOUT_CREATED', PAYOUT_PROCESSING: 'PAYOUT_PROCESSING', PAYOUT_PAID: 'PAYOUT_PAID', PAYOUT_FAILED: 'PAYOUT_FAILED' } as const;

/* Đối soát shop (payout): lỗi + audit + trạng thái. `carried` = net âm, không chi, mang sang kỳ sau; `settled` = net 0, không có gì để chi. */
export const PAYOUT_ERR = {
  NOT_FOUND: 'PAYOUT_NOT_FOUND',
  INVALID_STATE: 'PAYOUT_INVALID_STATE',
  INVALID_PERIOD: 'PAYOUT_INVALID_PERIOD',
  PERIOD_OVERLAP: 'PAYOUT_PERIOD_OVERLAP',
  AUTO_PAYOUT_ACTIVE: 'PAYOUT_AUTO_ACTIVE',
  /* PLAN-0026 */
  PROVIDER_REF_DUPLICATE: 'PAYOUT_PROVIDER_REF_DUPLICATE',
  GATEWAY_NOT_CONFIRMED: 'PAYOUT_GATEWAY_NOT_CONFIRMED',
  NOT_APPROVABLE: 'PAYOUT_NOT_APPROVABLE',
  /* PLAN-0040 Tầng 2: mở giữ kỳ khi lý do giữ vẫn còn (409 kèm lý do) · lệnh giữ tay đã có / không tồn tại. */
  STILL_HELD: 'PAYOUT_STILL_HELD',
  HOLD_EXISTS: 'PAYOUT_HOLD_EXISTS',
  HOLD_NOT_FOUND: 'PAYOUT_HOLD_NOT_FOUND',
} as const;
export const PAYOUT_AUDIT = { CREATED: 'PAYOUT_CREATED', SENT: 'PAYOUT_SENT', FAILED: 'PAYOUT_FAILED', RETRIED: 'PAYOUT_RETRIED', MARKED_PAID: 'PAYOUT_MARKED_PAID', APPROVED: 'PAYOUT_APPROVED', UNKNOWN: 'PAYOUT_UNKNOWN', RECONCILED: 'PAYOUT_RECONCILED', HOLD_CREATED: 'PAYOUT_HOLD_CREATED', HOLD_RELEASED: 'PAYOUT_HOLD_RELEASED' } as const;
/* PLAN-0026: unknown = gửi lệnh nhưng không rõ kết quả (không chi lại, không đánh dấu tay) · awaiting_approval = vượt hạn mức tự chi, chờ kế toán duyệt · held = shop bị khoá / đang giữ · deferred = dưới mức chi tối thiểu, dồn kỳ sau. */
export const PAYOUT_STATUS = { PENDING: 'pending', AWAITING_APPROVAL: 'awaiting_approval', PROCESSING: 'processing', PAID: 'paid', FAILED: 'failed', UNKNOWN: 'unknown', HELD: 'held', DEFERRED: 'deferred', MERGED: 'merged', CARRIED: 'carried', SETTLED: 'settled' } as const;
export const PAYOUT_LINE_KIND = { SALE: 'sale', REFUND: 'refund' } as const;

/* PLAN-0018: chỉ còn cod + payos. Payment lịch sử có methodCode vnpay/bank_transfer vẫn đọc được (cột chuỗi tự do) nhưng không tạo mới. */
export const METHOD = { COD: 'cod', PAYOS: 'payos' } as const;
export const PAY_STATUS = { PENDING: 'pending', PROCESSING: 'processing', PAID: 'paid', FAILED: 'failed', EXPIRED: 'expired', CANCELLED: 'cancelled', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded' } as const;
export const REFUND_STATUS = { REQUESTED: 'requested', PROCESSING: 'processing', DONE: 'done', FAILED: 'failed' } as const;
/*
 * Lệnh chi PayOS của refund (cột gateway_status): `submitted` PayOS mới NHẬN lệnh (code "00" ≠ tiền đã đi) · `processing` đã tra, còn đang xử lý · `succeeded` PayOS xác nhận đã chuyển · `failed` lỗi/từ chối/huỷ/hoàn.
 * CHỈ `succeeded` mới được ghi sổ `done`.
 */
export const GATEWAY_STATUS = { SUBMITTED: 'submitted', PROCESSING: 'processing', SUCCEEDED: 'succeeded', FAILED: 'failed' } as const;
/* Nguồn tài khoản nhận hoàn: payer = tài khoản ĐÃ TRẢ tiền (counterAccount* của webhook PayOS, ưu tiên) · customer = khách khai · none = chưa có (chuyển tay). */
export const PAYEE_SOURCE = { PAYER: 'payer', CUSTOMER: 'customer', NONE: 'none' } as const;
/* providerRef do hệ thống sinh khi PayOS xác nhận đã chi: `payos-refund:<payoutId>`. Mã nhập tay KHÔNG được mở đầu bằng tiền tố này (tránh giả mạo/đụng mã). */
export const GATEWAY_REF_PREFIX = 'payos-refund:';
/* Quyền xử lý hoàn tiền — người nhận thông báo "hoàn thất bại / cần chuyển tay / PayOS treo" (UserDirectoryGateway.staffUserIdsWithPermission). */
export const REFUND_PROCESS_PERMISSION = 'payment.refund.process';
/* order = hoàn theo đơn · duplicate_payment = hoàn khoản khách trả TRÙNG (không đổi trạng thái thanh toán của đơn). Khớp CHECK chk_refunds_kind. */
export const REFUND_KIND = { ORDER: 'order', DUPLICATE_PAYMENT: 'duplicate_payment', MISMATCH: 'mismatch' } as const;
/* mismatch (PLAN-0025 §2.4) = hoàn phần tiền LỆCH: khách trả thừa, hoặc đã trả thiếu rồi đơn bị huỷ. Như duplicate_payment: không đổi trạng thái thanh toán của đơn, không đảo hoa hồng/doanh thu. */
/* Refund `processing` quá hạn này mà không có kết quả ⇒ coi là treo (tiến trình chết giữa chừng) — cùng mốc với kỳ đối soát shop treo. */
export const REFUND_STUCK_MS = 10 * 60_000;
/* Lệnh chi PayOS đã nhận mà quá mốc này vẫn chưa chốt ⇒ bất thường: đánh dấu cần người xem + báo kế toán (một lần). */
export const REFUND_GATEWAY_STALL_MS = 30 * 60_000;
export const TX_TYPE = { CREATE_URL: 'create_url', IPN: 'ipn', PAYOS_WEBHOOK: 'payos_webhook', RETURN: 'return', QUERY: 'query', REFUND: 'refund', MANUAL_CONFIRM: 'manual_confirm', COD_COLLECT: 'cod_collect', COD_REVERSE: 'cod_reverse' } as const;
