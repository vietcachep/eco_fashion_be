/* Phần CÔNG KHAI của order cho module khác (listener ở worker của payment/system nghe sự kiện outbox của order). */
export const ORDER_MODULE = 'order';

export const ORDER_EVENT = {
  CREATED: 'ORDER_CREATED',
  STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  CANCELLED: 'ORDER_CANCELLED',
  PAID: 'ORDER_PAID',
  DELIVERED: 'ORDER_DELIVERED',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  /* PLAN-0022: MỌI lần yêu cầu đổi trả đổi trạng thái (payload {returnId, orderCode, userId, shopId, from, to}) — thay cho RETURN_PROCESSED kiểu cũ. */
  RETURN_STATUS_CHANGED: 'RETURN_STATUS_CHANGED',
  /* PLAN-0027 (cho WP-04 gắn email): khách yêu cầu huỷ đơn đang đóng gói (payload {orderCode, userId, shopId, reasonCode, dueAt}) · shop/hệ thống chốt yêu cầu (payload {orderCode, userId, shopId, decision}). */
  CANCEL_REQUESTED: 'ORDER_CANCEL_REQUESTED',
  CANCEL_REQUEST_RESOLVED: 'ORDER_CANCEL_REQUEST_RESOLVED',
  /* PLAN-0027: khách đổi địa chỉ nhận (payload {orderCode, userId, shopId}) · job SLA nhắc shop sắp quá hạn (payload {orderCode, shopId, kind: confirm | ship, dueAt}). */
  ADDRESS_CHANGED: 'ORDER_ADDRESS_CHANGED',
  SLA_REMINDER: 'ORDER_SLA_REMINDER',
  /* PLAN-0031 §2.4: shop báo giao thất bại (payload {orderCode, userId, shopId, reasonCode, paymentMethod, customerFault}) — WP-08 đếm "bom" của khách; chưa có consumer trong order. */
  DELIVERY_FAILED: 'ORDER_DELIVERY_FAILED',
} as const;
