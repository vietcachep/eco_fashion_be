export const PAYMENT_MODULE = 'payment';

export const PAYMENT_ERR = {
  NOT_FOUND: 'PAYMENT_NOT_FOUND',
  METHOD_INACTIVE: 'PAYMENT_METHOD_INACTIVE',
  VNPAY_NOT_CONFIGURED: 'PAYMENT_VNPAY_NOT_CONFIGURED',
  PAYOS_NOT_CONFIGURED: 'PAYMENT_PAYOS_NOT_CONFIGURED',
  BANK_NOT_CONFIGURED: 'PAYMENT_BANK_NOT_CONFIGURED',
  INVALID_SIGNATURE: 'PAYMENT_INVALID_SIGNATURE',
  AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  ALREADY_PAID: 'PAYMENT_ALREADY_PAID',
  INVALID_STATE: 'PAYMENT_INVALID_STATE',
  REFUND_NOT_FOUND: 'PAYMENT_REFUND_NOT_FOUND',
  REFUND_EXCEEDS: 'PAYMENT_REFUND_EXCEEDS',
  /* Cổng (VNPay) từng được gọi mà không rõ kết quả — phải đối chiếu trên cổng trước khi xử lý lại (chống hoàn đôi). */
  REFUND_RECONCILE_REQUIRED: 'PAYMENT_REFUND_RECONCILE_REQUIRED',
} as const;

export const PAYMENT_AUDIT = {
  INITIATED: 'PAYMENT_INITIATED',
  PAID: 'PAYMENT_PAID',
  FAILED: 'PAYMENT_FAILED',
  CANCELLED: 'PAYMENT_CANCELLED',
  TRANSFER_CONFIRMED: 'BANK_TRANSFER_CONFIRMED',
  REFUND_REQUESTED: 'REFUND_REQUESTED',
  REFUND_PROCESSED: 'REFUND_PROCESSED',
  /* Phục hồi refund treo ở `processing` (nhả về requested / đánh failed chờ đối chiếu) — không tự chi tiền. */
  REFUND_RECOVERED: 'REFUND_RECOVERED',
  /* Gọi cổng hoàn tiền mà không rõ kết quả (đánh failed chờ đối chiếu). */
  REFUND_UNCERTAIN: 'REFUND_OUTCOME_UNKNOWN',
  METHOD_UPDATED: 'PAYMENT_METHOD_UPDATED',
} as const;

export const PAYMENT_EVENT = { PAID: 'PAYMENT_PAID', REFUNDED: 'PAYMENT_REFUNDED', PAYOUT_CREATED: 'PAYOUT_CREATED', PAYOUT_PROCESSING: 'PAYOUT_PROCESSING', PAYOUT_PAID: 'PAYOUT_PAID', PAYOUT_FAILED: 'PAYOUT_FAILED' } as const;

/* Đối soát shop (payout): lỗi + audit + trạng thái. `carried` = net âm, không chi, mang sang kỳ sau; `settled` = net 0, không có gì để chi. */
export const PAYOUT_ERR = {
  NOT_FOUND: 'PAYOUT_NOT_FOUND',
  INVALID_STATE: 'PAYOUT_INVALID_STATE',
  INVALID_PERIOD: 'PAYOUT_INVALID_PERIOD',
  PERIOD_OVERLAP: 'PAYOUT_PERIOD_OVERLAP',
  AUTO_PAYOUT_ACTIVE: 'PAYOUT_AUTO_ACTIVE',
} as const;
export const PAYOUT_AUDIT = { CREATED: 'PAYOUT_CREATED', SENT: 'PAYOUT_SENT', FAILED: 'PAYOUT_FAILED', RETRIED: 'PAYOUT_RETRIED', MARKED_PAID: 'PAYOUT_MARKED_PAID' } as const;
export const PAYOUT_STATUS = { PENDING: 'pending', PROCESSING: 'processing', PAID: 'paid', FAILED: 'failed', CARRIED: 'carried', SETTLED: 'settled' } as const;
/* Ví quỹ COD của shop: lỗi + audit + sự kiện. */
export const WALLET_ERR = {
  NOT_FOUND: 'PAYMENT_WALLET_NOT_FOUND',
  DEPOSIT_NOT_FOUND: 'PAYMENT_WALLET_DEPOSIT_NOT_FOUND',
  DEPOSIT_DECIDED: 'PAYMENT_WALLET_DEPOSIT_DECIDED',
  DEPOSIT_PENDING_EXISTS: 'PAYMENT_WALLET_DEPOSIT_PENDING_EXISTS',
  INVALID_AMOUNT: 'PAYMENT_WALLET_INVALID_AMOUNT',
  NOTE_REQUIRED: 'PAYMENT_WALLET_NOTE_REQUIRED',
} as const;
export const WALLET_AUDIT = { COD_COMMISSION: 'WALLET_COD_COMMISSION', DEPOSIT_REQUESTED: 'WALLET_DEPOSIT_REQUESTED', DEPOSIT_APPROVED: 'WALLET_DEPOSIT_APPROVED', DEPOSIT_REJECTED: 'WALLET_DEPOSIT_REJECTED', ADJUSTED: 'WALLET_ADJUSTED', COD_REFUND: 'WALLET_COD_REFUND' } as const;
export const WALLET_TX_TYPE = { COD_COMMISSION: 'cod_commission', DEPOSIT: 'deposit', ADJUST: 'adjust', COD_REFUND: 'cod_refund' } as const;
export const WALLET_EVENT = { COD_DISABLED: 'WALLET_COD_DISABLED', COD_ENABLED: 'WALLET_COD_ENABLED', DEPOSIT_APPROVED: 'WALLET_DEPOSIT_APPROVED', DEPOSIT_REJECTED: 'WALLET_DEPOSIT_REJECTED' } as const;

export const PAYOUT_LINE_KIND = { SALE: 'sale', REFUND: 'refund' } as const;

export const METHOD = { COD: 'cod', BANK_TRANSFER: 'bank_transfer', VNPAY: 'vnpay', PAYOS: 'payos' } as const;
export const PAY_STATUS = { PENDING: 'pending', PROCESSING: 'processing', PAID: 'paid', FAILED: 'failed', EXPIRED: 'expired', CANCELLED: 'cancelled', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded' } as const;
export const REFUND_STATUS = { REQUESTED: 'requested', PROCESSING: 'processing', DONE: 'done', FAILED: 'failed' } as const;
/* order = hoàn theo đơn · duplicate_payment = hoàn khoản khách trả TRÙNG (không đổi trạng thái thanh toán của đơn). Khớp CHECK chk_refunds_kind. */
export const REFUND_KIND = { ORDER: 'order', DUPLICATE_PAYMENT: 'duplicate_payment' } as const;
/* Refund `processing` quá hạn này mà không có kết quả ⇒ coi là treo (tiến trình chết giữa chừng) — cùng mốc với kỳ đối soát shop treo. */
export const REFUND_STUCK_MS = 10 * 60_000;
export const TX_TYPE = { CREATE_URL: 'create_url', IPN: 'ipn', PAYOS_WEBHOOK: 'payos_webhook', RETURN: 'return', QUERY: 'query', REFUND: 'refund', MANUAL_CONFIRM: 'manual_confirm', COD_COLLECT: 'cod_collect' } as const;

/* Mã phản hồi VNPay → thông điệp tiếng Việt (vnp_ResponseCode / vnp_TransactionStatus). */
export const VNPAY_RESPONSE: Record<string, string> = {
  '00': 'Giao dịch thành công',
  '07': 'Trừ tiền thành công nhưng giao dịch bị nghi ngờ gian lận',
  '09': 'Thẻ/Tài khoản chưa đăng ký Internet Banking',
  '10': 'Xác thực thẻ/tài khoản sai quá 3 lần',
  '11': 'Hết hạn chờ thanh toán',
  '12': 'Thẻ/Tài khoản bị khoá',
  '13': 'Sai mật khẩu OTP',
  '24': 'Khách hàng huỷ giao dịch',
  '51': 'Tài khoản không đủ số dư',
  '65': 'Vượt hạn mức giao dịch trong ngày',
  '75': 'Ngân hàng đang bảo trì',
  '79': 'Sai mật khẩu thanh toán quá số lần',
  '99': 'Lỗi khác',
};
