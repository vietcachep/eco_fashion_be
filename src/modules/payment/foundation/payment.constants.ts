export const PAYMENT_MODULE = 'payment';

export const PAYMENT_ERR = {
  NOT_FOUND: 'PAYMENT_NOT_FOUND',
  METHOD_INACTIVE: 'PAYMENT_METHOD_INACTIVE',
  VNPAY_NOT_CONFIGURED: 'PAYMENT_VNPAY_NOT_CONFIGURED',
  BANK_NOT_CONFIGURED: 'PAYMENT_BANK_NOT_CONFIGURED',
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
  TRANSFER_CONFIRMED: 'BANK_TRANSFER_CONFIRMED',
  REFUND_REQUESTED: 'REFUND_REQUESTED',
  REFUND_PROCESSED: 'REFUND_PROCESSED',
  METHOD_UPDATED: 'PAYMENT_METHOD_UPDATED',
} as const;

export const PAYMENT_EVENT = { PAID: 'PAYMENT_PAID', REFUNDED: 'PAYMENT_REFUNDED' } as const;

export const METHOD = { COD: 'cod', BANK_TRANSFER: 'bank_transfer', VNPAY: 'vnpay' } as const;
export const PAY_STATUS = { PENDING: 'pending', PROCESSING: 'processing', PAID: 'paid', FAILED: 'failed', EXPIRED: 'expired', CANCELLED: 'cancelled', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded' } as const;
export const REFUND_STATUS = { REQUESTED: 'requested', PROCESSING: 'processing', DONE: 'done', FAILED: 'failed' } as const;
export const TX_TYPE = { CREATE_URL: 'create_url', IPN: 'ipn', RETURN: 'return', QUERY: 'query', REFUND: 'refund', MANUAL_CONFIRM: 'manual_confirm', COD_COLLECT: 'cod_collect' } as const;

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
