/* Phần CÔNG KHAI của payment cho module khác (listener ở worker của system nghe sự kiện outbox chi trả shop). */
export const PAYMENT_MODULE_NAME = 'payment';

export const PAYOUT_EVENT = {
  PROCESSING: 'PAYOUT_PROCESSING',
  PAID: 'PAYOUT_PAID',
  FAILED: 'PAYOUT_FAILED',
} as const;
