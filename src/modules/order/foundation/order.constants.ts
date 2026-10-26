import type { CacheSpec } from '@common/cache/cache.service';

import { ORDER_MODULE } from '../enums/order-events';

export { ORDER_MODULE };

export const ORDER_ERR = {
  NOT_FOUND: 'ORDER_NOT_FOUND',
  CART_EMPTY: 'ORDER_CART_EMPTY',
  CART_CHANGED: 'ORDER_CART_CHANGED',
  OUT_OF_STOCK: 'ORDER_OUT_OF_STOCK',
  ADDRESS_REQUIRED: 'ORDER_ADDRESS_REQUIRED',
  ADDRESS_NOT_FOUND: 'ORDER_ADDRESS_NOT_FOUND',
  PAYMENT_METHOD_INVALID: 'ORDER_PAYMENT_METHOD_INVALID',
  COD_LIMIT: 'ORDER_COD_LIMIT',
  /* PLAN-0020: gian hàng chưa đặt cọc (hoặc ví ≤ 0) nên không nhận COD. */
  COD_NOT_AVAILABLE: 'ORDER_COD_NOT_AVAILABLE',
  PROMOTION_INVALID: 'ORDER_PROMOTION_INVALID',
  INVALID_TRANSITION: 'ORDER_INVALID_TRANSITION',
  CANNOT_CANCEL: 'ORDER_CANNOT_CANCEL',
  RETURN_WINDOW_CLOSED: 'ORDER_RETURN_WINDOW_CLOSED',
  RETURN_NOT_ALLOWED: 'ORDER_RETURN_NOT_ALLOWED',
  RETURN_NOT_FOUND: 'ORDER_RETURN_NOT_FOUND',
  RETURN_INVALID_STATE: 'ORDER_RETURN_INVALID_STATE',
  EVIDENCE_REQUIRED: 'ORDER_EVIDENCE_REQUIRED',
  /* PLAN-0014 bước 7 — giỏ nhiều shop: một gian hàng trong giỏ ngừng hoạt động / khoá COD giữa lúc đặt hàng. */
  SHOP_NOT_AVAILABLE: 'ORDER_SHOP_NOT_AVAILABLE',
} as const;

export const ORDER_AUDIT = {
  CREATED: 'ORDER_CREATED',
  STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  CANCELLED: 'ORDER_CANCELLED',
  PAID: 'ORDER_PAID',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURN_PROCESSED: 'RETURN_PROCESSED',
} as const;

export { ORDER_EVENT } from '../enums/order-events';

export const ORDER_STATUS = { PENDING: 'pending', CONFIRMED: 'confirmed', PACKING: 'packing', SHIPPING: 'shipping', DELIVERED: 'delivered', COMPLETED: 'completed', CANCELLED: 'cancelled', RETURNED: 'returned' } as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
export const PAYMENT_STATUS = { UNPAID: 'unpaid', PROCESSING: 'processing', PAID: 'paid', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded' } as const;
export const RETURN_STATUS = { REQUESTED: 'requested', APPROVED: 'approved', REJECTED: 'rejected', REFUNDED: 'refunded' } as const;
export const PAYMENT_METHOD = { COD: 'cod', PAYOS: 'payos' } as const;

/* Lưới chuyển trạng thái do NHÂN VIÊN thao tác (khách chỉ huỷ ở pending). */
export const STAFF_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packing', 'cancelled'],
  packing: ['shipping'],
  shipping: ['delivered'],
  // `returned` KHÔNG nằm ở đây: trả hàng chỉ đi qua ReturnService (hoàn kho + hoàn tiền + đảo hoa hồng); chuyển tay sang returned sẽ mất đơn khỏi đối soát mà khách không được hoàn.
  delivered: ['completed'],
  completed: [],
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
