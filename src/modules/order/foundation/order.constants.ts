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
  /* PLAN-0022 — đổi trả theo đúng vai: */
  /* Minh chứng sai (không https, không thuộc host upload của hệ thống, sai loại, quá 8 tệp). */
  RETURN_EVIDENCE_INVALID: 'ORDER_RETURN_EVIDENCE_INVALID',
  /* Đơn COD đã thu tiền mà khách chưa khai tài khoản nhận hoàn / tài khoản khai sai định dạng. */
  RETURN_REFUND_ACCOUNT_REQUIRED: 'ORDER_RETURN_REFUND_ACCOUNT_REQUIRED',
  RETURN_REFUND_ACCOUNT_INVALID: 'ORDER_RETURN_REFUND_ACCOUNT_INVALID',
  /* Số tiền hoàn sửa tay phải có lý do; shop chỉ được giảm, sàn ≤ tổng đơn − đã hoàn. */
  RETURN_ADJUST_REASON_REQUIRED: 'ORDER_RETURN_ADJUST_REASON_REQUIRED',
  RETURN_REFUND_TOO_HIGH: 'ORDER_RETURN_REFUND_TOO_HIGH',
  /* Shop duyệt yêu cầu cần trả hàng mà chưa có địa chỉ nhận hàng trả. */
  RETURN_ADDRESS_REQUIRED: 'ORDER_RETURN_ADDRESS_REQUIRED',
  /* Hết hạn của bước đó (gửi hàng trả / khiếu nại) — hệ thống đã/đang chuyển bước. */
  RETURN_DEADLINE_PASSED: 'ORDER_RETURN_DEADLINE_PASSED',
  /* Đơn đang có yêu cầu đổi trả chưa xử lý xong nên chưa huỷ / báo giao thất bại được. */
  HAS_OPEN_RETURN: 'ORDER_HAS_OPEN_RETURN',
  /* PLAN-0014 bước 7 — giỏ nhiều shop: một gian hàng trong giỏ ngừng hoạt động / khoá COD giữa lúc đặt hàng. */
  SHOP_NOT_AVAILABLE: 'ORDER_SHOP_NOT_AVAILABLE',
  /* PLAN-0040 tầng 8 (CK-05, PLAN-0032 §2.1): tổng tiền server tính lúc đặt khác `expectedTotal` khách đã thấy ⇒ 409, kèm báo giá mới ở `data`, KHÔNG tạo gì. */
  PRICE_CHANGED: 'ORDER_PRICE_CHANGED',
  /* PLAN-0040 Tầng 3.6–3.7 — giao hàng có bằng chứng (PLAN-0031): chuyển `shipping` thiếu hãng/mã vận đơn (400) · "Đã giao" khi khách đang báo chưa nhận hàng (409, SHP-06) ·
     "hàng đã về kho" cho đơn không đủ điều kiện (400) hoặc đã nhập kho rồi / quá hạn 30 ngày (409, SHP-09). */
  TRACKING_REQUIRED: 'ORDER_TRACKING_REQUIRED',
  NOT_RECEIVED_OPEN: 'ORDER_NOT_RECEIVED_OPEN',
  GOODS_RETURN_NOT_ALLOWED: 'ORDER_GOODS_RETURN_NOT_ALLOWED',
  GOODS_ALREADY_RETURNED: 'ORDER_GOODS_ALREADY_RETURNED',
} as const;

export const ORDER_AUDIT = {
  CREATED: 'ORDER_CREATED',
  STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  CANCELLED: 'ORDER_CANCELLED',
  PAID: 'ORDER_PAID',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURN_APPROVED: 'RETURN_APPROVED',
  RETURN_REJECTED: 'RETURN_REJECTED',
  RETURN_SHIPPED_BACK: 'RETURN_SHIPPED_BACK',
  RETURN_RECEIVED: 'RETURN_RECEIVED',
  RETURN_REFUNDED: 'RETURN_REFUNDED',
  RETURN_ESCALATED: 'RETURN_ESCALATED',
  RETURN_RESOLVED: 'RETURN_RESOLVED',
  RETURN_CANCELLED: 'RETURN_CANCELLED',
  RETURN_EXPIRED: 'RETURN_EXPIRED',
  /* Shop báo đơn `shipping` giao không thành công (từ chối nhận / không liên lạc được / thất lạc) ⇒ đơn huỷ. */
  DELIVERY_FAILED: 'ORDER_DELIVERY_FAILED',
  /* PLAN-0031 §2.4: shop xác nhận hàng của đơn giao thất bại đã về kho ⇒ nhập kho lại (một lần) · §2.1: mã vận đơn trùng đơn khác của shop · COD-08b: đảo ghi thu COD (khách chưa nhận hàng). */
  GOODS_RETURNED: 'ORDER_GOODS_RETURNED',
  TRACKING_REUSED: 'ORDER_TRACKING_REUSED',
  COD_REVERSED: 'ORDER_COD_REVERSED',
  /* Job cảnh báo đơn `shipping` quá hạn (shop + CSKH). */
  SHIPPING_OVERDUE_ALERTED: 'ORDER_SHIPPING_OVERDUE_ALERTED',
} as const;

export { ORDER_EVENT } from '../enums/order-events';

export const ORDER_STATUS = { PENDING: 'pending', CONFIRMED: 'confirmed', PACKING: 'packing', SHIPPING: 'shipping', DELIVERED: 'delivered', COMPLETED: 'completed', CANCELLED: 'cancelled', RETURNED: 'returned' } as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
export const PAYMENT_STATUS = { UNPAID: 'unpaid', PROCESSING: 'processing', PAID: 'paid', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded' } as const;
/*
 * Máy trạng thái đổi trả (PLAN-0022). `received` = hàng đã về kho shop (hoặc sàn phân xử hoàn tiền / không cần trả hàng) VÀ khoản hoàn đã được tạo bên payment;
 * payment báo xong ⇒ `refunded` (markReturnRefunded). Bảng RETURN_TRANSITIONS là NGUỒN SỰ THẬT duy nhất cho "từ đâu sang đâu được" — mọi chuyển đều qua nó.
 */
export const RETURN_STATUS = { REQUESTED: 'requested', APPROVED: 'approved', RECEIVED: 'received', REFUNDED: 'refunded', REJECTED: 'rejected', ESCALATED: 'escalated', CANCELLED: 'cancelled', EXPIRED: 'expired' } as const;
export type ReturnStatus = (typeof RETURN_STATUS)[keyof typeof RETURN_STATUS];

export const RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  // shop duyệt (cần trả hàng ⇒ approved; `not_received` ⇒ received/refunded ngay) · shop từ chối · quá hạn shop ⇒ escalated · khách rút
  requested: ['approved', 'received', 'refunded', 'rejected', 'escalated', 'cancelled'],
  // shop nhận đúng hàng ⇒ received (hoặc refunded khi không có tiền nào để hoàn) · hàng không khớp / shop quá hạn nhận ⇒ escalated · khách rút · khách không gửi ⇒ expired
  approved: ['received', 'refunded', 'escalated', 'cancelled', 'expired'],
  // sàn phân xử: hoàn tiền ⇒ received (hoặc refunded) · từ chối lần cuối ⇒ rejected
  escalated: ['received', 'refunded', 'rejected'],
  // chỉ shop bị từ chối mới khiếu nại lên sàn (trong hạn)
  rejected: ['escalated'],
  received: ['refunded'],
  refunded: [],
  cancelled: [],
  expired: [],
};
export const canReturnTransition = (from: string, to: string): boolean => (RETURN_TRANSITIONS[from as ReturnStatus] ?? []).includes(to as ReturnStatus);

/* Còn "mở" = chưa kết thúc: chặn đối soát chi trả shop (settlementOrders) và chặn huỷ/báo giao thất bại đơn. */
export const RETURN_OPEN_STATUSES: readonly ReturnStatus[] = [RETURN_STATUS.REQUESTED, RETURN_STATUS.APPROVED, RETURN_STATUS.ESCALATED, RETURN_STATUS.RECEIVED];
export const RETURN_CLOSED_STATUSES: readonly ReturnStatus[] = [RETURN_STATUS.REFUNDED, RETURN_STATUS.REJECTED, RETURN_STATUS.CANCELLED, RETURN_STATUS.EXPIRED];
/* Số hàng đã/đang "giữ chỗ" khi tính còn trả được bao nhiêu: đang mở + đã hoàn xong (rejected/cancelled/expired nhả lại số lượng). */
export const RETURN_COUNTED_STATUSES: readonly ReturnStatus[] = [...RETURN_OPEN_STATUSES, RETURN_STATUS.REFUNDED];
/* Hàng đã được hoàn tiền (hoặc đang chi) — dùng quyết định đơn đã trả HẾT chưa. */
export const RETURN_REFUNDED_STATUSES: readonly ReturnStatus[] = [RETURN_STATUS.RECEIVED, RETURN_STATUS.REFUNDED];

export const RETURN_REASON_CODES = ['defective', 'wrong_item', 'not_as_described', 'damaged_shipping', 'size_issue', 'changed_mind', 'not_received', 'other'] as const;
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];
export const RETURN_REASON_LABEL: Record<ReturnReasonCode, string> = {
  defective: 'Hàng bị lỗi',
  wrong_item: 'Giao sai hàng',
  not_as_described: 'Không đúng mô tả',
  damaged_shipping: 'Hư hỏng khi vận chuyển',
  size_issue: 'Không vừa kích cỡ',
  changed_mind: 'Đổi ý, không muốn mua nữa',
  not_received: 'Chưa nhận được hàng',
  other: 'Lý do khác',
};
export const RETURN_REJECTED_BY = { SHOP: 'shop', PLATFORM: 'platform' } as const;
export const RETURN_ESCALATE_SOURCE = { CUSTOMER: 'customer', SHOP_TIMEOUT: 'shop_timeout', SHOP_RECEIVE_TIMEOUT: 'shop_receive_timeout', SHOP_NOT_MATCHING: 'shop_not_matching' } as const;
export const RETURN_DEADLINE_KIND = { SHOP_RESPOND: 'shop_respond', SHIP_BACK: 'ship_back', SHOP_RECEIVE: 'shop_receive', ESCALATE: 'escalate' } as const;
export const RETURN_RECEIVED_CONDITION = { OK: 'ok', NOT_MATCHING: 'not_matching' } as const;
export const RETURN_RESOLVE_DECISION = { REFUND: 'refund', REJECT: 'reject' } as const;
/* Số minh chứng tối đa mỗi lần đính kèm (khách tạo yêu cầu / shop từ chối / shop xác nhận nhận hàng). */
export const RETURN_EVIDENCE_MAX = 8;

/* Lý do shop báo đơn `shipping` giao không thành công. */
export const DELIVERY_FAILED_REASONS = ['refused', 'unreachable', 'wrong_address', 'lost', 'damaged', 'other'] as const;
export type DeliveryFailedReason = (typeof DELIVERY_FAILED_REASONS)[number];
export const DELIVERY_FAILED_LABEL: Record<DeliveryFailedReason, string> = {
  refused: 'Khách từ chối nhận hàng',
  unreachable: 'Không liên lạc được với khách',
  wrong_address: 'Sai địa chỉ / không tìm thấy địa chỉ giao',
  lost: 'Hàng thất lạc trong quá trình vận chuyển',
  damaged: 'Hàng hư hỏng trong quá trình vận chuyển',
  other: 'Giao không thành công',
};
/* Lý do tính vào "bom hàng" của KHÁCH (WP-08): khách từ chối nhận / không liên lạc được. Các lý do còn lại là lỗi giao nhận hoặc địa chỉ — không phạt khách. */
export const DELIVERY_FAILED_CUSTOMER_FAULT: readonly DeliveryFailedReason[] = ['refused', 'unreachable'];
/* PLAN-0031 §2.4: shop xác nhận "hàng đã về kho" trong vòng N ngày kể từ lúc báo giao thất bại — quá hạn thì không nhập kho tự động nữa (CSKH xử lý tay: kho có thể đã bán/điều chỉnh). */
export const GOODS_RETURN_WINDOW_DAYS = 30;

// ====================================================================== PLAN-0031 §2.1 — hãng vận chuyển + mã vận đơn
/*
 * Danh mục hãng (cố định, không phải setting): `trackUrl` = mẫu link tra cứu công khai ({code} thay bằng mã vận đơn đã encode); null = không có mẫu ⇒ shop tự nhập link https (chỉ hãng
 * `other` / hãng chưa có mẫu). Mẫu sai/đổi thì sửa Ở ĐÂY — không lưu mẫu vào dữ liệu đơn (link sinh lúc chuyển `shipping`, lưu ở orders.tracking_url để đơn cũ không đổi theo).
 */
export const CARRIERS = {
  ghn: { name: 'Giao Hàng Nhanh (GHN)', trackUrl: 'https://donhang.ghn.vn/?order_code={code}' },
  ghtk: { name: 'Giao Hàng Tiết Kiệm (GHTK)', trackUrl: 'https://i.ghtk.vn/{code}' },
  viettel_post: { name: 'Viettel Post', trackUrl: 'https://viettelpost.vn/tra-cuu-hanh-trinh-don?code={code}' },
  jnt: { name: 'J&T Express', trackUrl: 'https://jtexpress.vn/vi/tracking?type=track&billcode={code}' },
  spx: { name: 'Shopee Express (SPX)', trackUrl: 'https://spx.vn/track?{code}' },
  ahamove: { name: 'Ahamove', trackUrl: null },
  ninja_van: { name: 'Ninja Van', trackUrl: 'https://www.ninjavan.co/vi-vn/tracking?id={code}' },
  vnpost: { name: 'VNPost', trackUrl: 'https://www.vnpost.vn/vi-vn/tra-cuu-hanh-trinh/buu-pham?key={code}' },
  other: { name: 'Hãng khác', trackUrl: null },
} as const satisfies Record<string, { name: string; trackUrl: string | null }>;
export type CarrierCode = keyof typeof CARRIERS;
export const CARRIER_CODES = Object.keys(CARRIERS) as CarrierCode[];
/* Mã vận đơn: 4–40 ký tự chữ/số/gạch ngang (không khoảng trắng, không ký tự điều khiển) — đủ cho mọi hãng lớn và không thể mang HTML/URL độc vào thông báo/email. */
export const TRACKING_CODE_PATTERN = /^[A-Za-z0-9-]{4,40}$/;
export const PAYMENT_METHOD = { COD: 'cod', PAYOS: 'payos' } as const;

// ====================================================================== PLAN-0027 — hạn chót & lối thoát (huỷ, yêu cầu huỷ, SLA, đổi địa chỉ)
/* Ai khởi xướng việc huỷ — lưu ở `orders.cancel_source` (cột `cancelled_by` cũ là id người thao tác, giữ nguyên). */
export const CANCEL_SOURCE = { CUSTOMER: 'customer', SHOP: 'shop', PLATFORM: 'platform', SYSTEM: 'system' } as const;
export type CancelSource = (typeof CANCEL_SOURCE)[keyof typeof CANCEL_SOURCE];
export const CANCEL_SOURCE_LABEL: Record<CancelSource, string> = { customer: 'Khách hàng', shop: 'Gian hàng', platform: 'Sàn FITLY', system: 'Hệ thống' };

/* Mã lý do huỷ theo bên (docs/10 §7). Mã hệ thống do job/listener đặt, không nhận từ request. */
export const CUSTOMER_CANCEL_REASONS = ['changed_mind', 'wrong_address', 'found_cheaper', 'slow_confirm', 'other'] as const;
export const SHOP_CANCEL_REASONS = ['out_of_stock', 'price_error', 'cannot_contact', 'customer_request', 'other'] as const;
export const PLATFORM_CANCEL_REASONS = ['dispute', 'fraud', 'other'] as const;
export const SYSTEM_CANCEL_REASONS = ['payment_expired', 'shop_confirm_timeout', 'shop_ship_timeout', 'shop_suspended'] as const;
export const CANCEL_REASON_LABEL: Record<string, string> = {
  changed_mind: 'Đổi ý, không muốn mua nữa',
  wrong_address: 'Nhập sai địa chỉ / thông tin nhận hàng',
  found_cheaper: 'Tìm được nơi bán giá tốt hơn',
  slow_confirm: 'Shop xác nhận đơn quá chậm',
  out_of_stock: 'Hết hàng',
  price_error: 'Sai giá niêm yết',
  cannot_contact: 'Không liên lạc được với khách',
  customer_request: 'Theo yêu cầu của khách',
  dispute: 'Tranh chấp',
  fraud: 'Nghi ngờ gian lận',
  other: 'Lý do khác',
  payment_expired: 'Quá hạn thanh toán',
  shop_confirm_timeout: 'Shop không xác nhận đơn đúng hạn',
  shop_ship_timeout: 'Shop không giao hàng đúng hạn',
  shop_suspended: 'Gian hàng bị tạm khoá',
};

/* Yêu cầu huỷ đơn `packing` của khách: shop chấp nhận/từ chối, im lặng quá `order.cancel_request_hours` ⇒ job tự chấp nhận. */
export const CANCEL_REQUEST_STATUS = { PENDING: 'pending', ACCEPTED: 'accepted', REJECTED: 'rejected', AUTO_ACCEPTED: 'auto_accepted' } as const;
export type CancelRequestStatus = (typeof CANCEL_REQUEST_STATUS)[keyof typeof CANCEL_REQUEST_STATUS];

/* Điểm vi phạm của gian hàng (bảng order.shop_violations; UNIQUE(order_code, kind) ⇒ job chạy lại không cộng hai lần). */
export const VIOLATION_KIND = {
  CONFIRM_TIMEOUT: 'confirm_timeout',
  SHIP_TIMEOUT: 'ship_timeout',
  CANCEL_OUT_OF_STOCK: 'cancel_out_of_stock',
  CANCEL_PRICE_ERROR: 'cancel_price_error',
  CANCEL_PACKING: 'cancel_packing',
  REJECT_THEN_CANCEL: 'reject_then_cancel',
} as const;
export type ViolationKind = (typeof VIOLATION_KIND)[keyof typeof VIOLATION_KIND];
export const VIOLATION_KIND_LABEL: Record<ViolationKind, string> = {
  confirm_timeout: 'Quá hạn xác nhận đơn',
  ship_timeout: 'Quá hạn giao hàng',
  cancel_out_of_stock: 'Huỷ đơn vì hết hàng',
  cancel_price_error: 'Huỷ đơn vì sai giá',
  cancel_packing: 'Huỷ đơn đã đóng gói',
  reject_then_cancel: 'Từ chối yêu cầu huỷ của khách rồi tự huỷ đơn',
};
/* Cửa sổ cộng dồn điểm + khoảng nhắc quản lý (docs/10 §3: `shop.violation_suspend_points` / 30 ngày; nhắc 1 lần / 7 ngày). */
export const VIOLATION_WINDOW_DAYS = 30;
export const VIOLATION_ALERT_INTERVAL_DAYS = 7;

/* Mã lỗi mới của đợt này (thêm vào ORDER_ERR ở dưới bằng spread để không đụng khối mã cũ). */
export const ORDER_AUDIT_V2 = {
  CANCEL_REQUESTED: 'ORDER_CANCEL_REQUESTED',
  CANCEL_REQUEST_ACCEPTED: 'ORDER_CANCEL_REQUEST_ACCEPTED',
  CANCEL_REQUEST_REJECTED: 'ORDER_CANCEL_REQUEST_REJECTED',
  SHIP_EXTENDED: 'ORDER_SHIP_EXTENDED',
  ADDRESS_CHANGED: 'ORDER_ADDRESS_CHANGED',
  RECEIVED: 'ORDER_RECEIVED_BY_CUSTOMER',
  SLA_REMINDED: 'ORDER_SLA_REMINDED',
} as const;

export const ORDER_ERR_V2 = {
  /* Khách đã có yêu cầu huỷ cho đơn này (đang chờ hoặc đã bị từ chối) — không gửi lại. */
  CANCEL_REQUEST_EXISTS: 'ORDER_CANCEL_REQUEST_EXISTS',
  CANCEL_REQUEST_NOT_FOUND: 'ORDER_CANCEL_REQUEST_NOT_FOUND',
  SHIP_ALREADY_EXTENDED: 'ORDER_SHIP_ALREADY_EXTENDED',
  SHIP_NO_DEADLINE: 'ORDER_SHIP_NO_DEADLINE',
  SHIP_OVERDUE: 'ORDER_SHIP_OVERDUE',
  ADDRESS_LOCKED: 'ORDER_ADDRESS_LOCKED',
  ADDRESS_PROVINCE_CHANGED: 'ORDER_ADDRESS_PROVINCE_CHANGED',
  NOT_DELIVERED: 'ORDER_NOT_DELIVERED',
} as const;

/* Lưới chuyển trạng thái do NHÂN VIÊN thao tác (khách chỉ huỷ ở pending; shop báo giao thất bại ⇒ cancelled qua OrderService.deliveryFailed). */
export const STAFF_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packing', 'cancelled'],
  // PLAN-0027 (CAN-08, SHOP-01f): sàn (CSKH/Admin) huỷ được đơn ĐÓNG GÓI khi tranh chấp / shop mất liên lạc — trước đây đơn `packing` kẹt vì không ai huỷ được.
  packing: ['shipping', 'cancelled'],
  // PLAN-0022: huỷ đơn ĐANG GIAO khi tranh chấp (nhân viên sàn, bắt buộc lý do) — hàng đang ở đơn vị vận chuyển nên KHÔNG tự nhập kho lại; hoàn tiền nếu đã thu online.
  shipping: ['delivered', 'cancelled'],
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
