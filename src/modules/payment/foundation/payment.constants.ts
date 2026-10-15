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
} as const;

export const PAYMENT_AUDIT = {
  INITIATED: 'PAYMENT_INITIATED',
  PAID: 'PAYMENT_PAID',
  FAILED: 'PAYMENT_FAILED',
  CANCELLED: 'PAYMENT_CANCELLED',
  REFUND_REQUESTED: 'REFUND_REQUESTED',
  REFUND_PROCESSED: 'REFUND_PROCESSED',
  /* Phục hồi refund treo ở `processing` (nhả về requested / đánh failed chờ đối chiếu) — không tự chi tiền. */
  REFUND_RECOVERED: 'REFUND_RECOVERED',
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
export const PAYOUT_LINE_KIND = { SALE: 'sale', REFUND: 'refund' } as const;

/* PLAN-0018: chỉ còn cod + payos. Payment lịch sử có methodCode vnpay/bank_transfer vẫn đọc được (cột chuỗi tự do) nhưng không tạo mới. */
export const METHOD = { COD: 'cod', PAYOS: 'payos' } as const;
export const PAY_STATUS = { PENDING: 'pending', PROCESSING: 'processing', PAID: 'paid', FAILED: 'failed', EXPIRED: 'expired', CANCELLED: 'cancelled', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded' } as const;
export const REFUND_STATUS = { REQUESTED: 'requested', PROCESSING: 'processing', DONE: 'done', FAILED: 'failed' } as const;
/* order = hoàn theo đơn · duplicate_payment = hoàn khoản khách trả TRÙNG (không đổi trạng thái thanh toán của đơn). Khớp CHECK chk_refunds_kind. */
export const REFUND_KIND = { ORDER: 'order', DUPLICATE_PAYMENT: 'duplicate_payment' } as const;
/* Refund `processing` quá hạn này mà không có kết quả ⇒ coi là treo (tiến trình chết giữa chừng) — cùng mốc với kỳ đối soát shop treo. */
export const REFUND_STUCK_MS = 10 * 60_000;
export const TX_TYPE = { CREATE_URL: 'create_url', IPN: 'ipn', PAYOS_WEBHOOK: 'payos_webhook', RETURN: 'return', QUERY: 'query', REFUND: 'refund', MANUAL_CONFIRM: 'manual_confirm', COD_COLLECT: 'cod_collect' } as const;
