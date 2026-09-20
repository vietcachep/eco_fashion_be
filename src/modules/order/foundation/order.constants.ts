import type { CacheSpec } from '@common/cache/cache.service';

export const ORDER_MODULE = 'order';

export const ORDER_ERR = {
  NOT_FOUND: 'ORDER_NOT_FOUND',
  CART_EMPTY: 'ORDER_CART_EMPTY',
  CART_CHANGED: 'ORDER_CART_CHANGED',
  OUT_OF_STOCK: 'ORDER_OUT_OF_STOCK',
  ADDRESS_REQUIRED: 'ORDER_ADDRESS_REQUIRED',
  ADDRESS_NOT_FOUND: 'ORDER_ADDRESS_NOT_FOUND',
  PAYMENT_METHOD_INVALID: 'ORDER_PAYMENT_METHOD_INVALID',
  COD_LIMIT: 'ORDER_COD_LIMIT',
  PROMOTION_INVALID: 'ORDER_PROMOTION_INVALID',
  INVALID_TRANSITION: 'ORDER_INVALID_TRANSITION',
  CANNOT_CANCEL: 'ORDER_CANNOT_CANCEL',
  RETURN_WINDOW_CLOSED: 'ORDER_RETURN_WINDOW_CLOSED',
  RETURN_NOT_ALLOWED: 'ORDER_RETURN_NOT_ALLOWED',
  RETURN_NOT_FOUND: 'ORDER_RETURN_NOT_FOUND',
  RETURN_INVALID_STATE: 'ORDER_RETURN_INVALID_STATE',
  EVIDENCE_REQUIRED: 'ORDER_EVIDENCE_REQUIRED',
} as const;

export const ORDER_AUDIT = {
  CREATED: 'ORDER_CREATED',
  STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  CANCELLED: 'ORDER_CANCELLED',
  PAID: 'ORDER_PAID',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURN_PROCESSED: 'RETURN_PROCESSED',
} as const;

export const ORDER_EVENT = {
  CREATED: 'ORDER_CREATED',
  STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  CANCELLED: 'ORDER_CANCELLED',
  PAID: 'ORDER_PAID',
  DELIVERED: 'ORDER_DELIVERED',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURN_PROCESSED: 'RETURN_PROCESSED',
} as const;

export const ORDER_STATUS = { PENDING: 'pending', CONFIRMED: 'confirmed', PACKING: 'packing', SHIPPING: 'shipping', DELIVERED: 'delivered', COMPLETED: 'completed', CANCELLED: 'cancelled', RETURNED: 'returned' } as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
export const PAYMENT_STATUS = { UNPAID: 'unpaid', PROCESSING: 'processing', PAID: 'paid', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded' } as const;
export const RETURN_STATUS = { REQUESTED: 'requested', APPROVED: 'approved', REJECTED: 'rejected', REFUNDED: 'refunded' } as const;
export const PAYMENT_METHOD = { COD: 'cod', BANK_TRANSFER: 'bank_transfer', VNPAY: 'vnpay' } as const;

/* Lưới chuyển trạng thái do NHÂN VIÊN thao tác (khách chỉ huỷ ở pending). */
export const STAFF_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packing', 'cancelled'],
  packing: ['shipping'],
  shipping: ['delivered'],
  delivered: ['completed', 'returned'],
  completed: ['returned'],
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Chờ xác nhận',
  confirmed: 'Đã xác nhận',
  packing: 'Đang đóng gói',
  shipping: 'Đang giao',
  delivered: 'Đã giao',
  completed: 'Hoàn tất',
  cancelled: 'Đã huỷ',
  returned: 'Đã trả hàng',
};

export const ORDER_CACHE = {
  detail: { module: ORDER_MODULE, purpose: 'detail', ttlSeconds: 30 } satisfies CacheSpec,
};
