/* Phần CÔNG KHAI của order cho module khác (listener ở worker của payment/system nghe sự kiện outbox của order). */
export const ORDER_MODULE = 'order';

export const ORDER_EVENT = {
  CREATED: 'ORDER_CREATED',
  STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  CANCELLED: 'ORDER_CANCELLED',
  PAID: 'ORDER_PAID',
  DELIVERED: 'ORDER_DELIVERED',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURN_PROCESSED: 'RETURN_PROCESSED',
} as const;
