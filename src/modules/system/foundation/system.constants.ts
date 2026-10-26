import type { CacheSpec } from '@common/cache/cache.service';

export const SYSTEM_MODULE = 'system';

export const SYSTEM_ERR = {
  SETTING_NOT_FOUND: 'SYSTEM_SETTING_NOT_FOUND',
  PROVINCE_NOT_FOUND: 'SYSTEM_PROVINCE_NOT_FOUND',
  BANNER_NOT_FOUND: 'SYSTEM_BANNER_NOT_FOUND',
  NOTIFICATION_NOT_FOUND: 'SYSTEM_NOTIFICATION_NOT_FOUND',
  CONTACT_NOT_FOUND: 'SYSTEM_CONTACT_NOT_FOUND',
  /* Liên hệ gửi cho gian hàng — sàn chỉ xem, trừ khi shop để quá hạn (CONTACT_SHOP_OVERDUE_HOURS). */
  CONTACT_SHOP_OWNED: 'SYSTEM_CONTACT_SHOP_OWNED',
  CONTACT_SHOP_INVALID: 'SYSTEM_CONTACT_SHOP_INVALID',
  FAQ_NOT_FOUND: 'SYSTEM_FAQ_NOT_FOUND',
  PAGE_NOT_FOUND: 'SYSTEM_PAGE_NOT_FOUND',
} as const;

export const SYSTEM_AUDIT = {
  SETTING_UPDATED: 'SETTING_UPDATED',
  PROVINCE_UPDATED: 'PROVINCE_UPDATED',
  BANNER_CREATED: 'BANNER_CREATED',
  BANNER_UPDATED: 'BANNER_UPDATED',
  BANNER_DELETED: 'BANNER_DELETED',
  CONTACT_HANDLED: 'CONTACT_HANDLED',
  FAQ_SAVED: 'FAQ_SAVED',
  FAQ_DELETED: 'FAQ_DELETED',
  PAGE_SAVED: 'PAGE_SAVED',
  NOTIFICATION_SENT: 'NOTIFICATION_SENT',
} as const;

export { SETTING_KEY } from '../enums/setting-keys';
import { SETTING_KEY } from '../enums/setting-keys';

export const SETTING_DEFAULTS: Record<string, { value: unknown; group: string; description: string; isPublic: boolean }> = {
  [SETTING_KEY.SHOP_NAME]: { value: 'FITLY', group: 'shop', description: 'Tên cửa hàng', isPublic: true },
  [SETTING_KEY.SHOP_HOTLINE]: { value: '1900 6868', group: 'shop', description: 'Hotline', isPublic: true },
  [SETTING_KEY.SHOP_EMAIL]: { value: 'hotro@ecofashion.vn', group: 'shop', description: 'Email hỗ trợ', isPublic: true },
  [SETTING_KEY.SHOP_ADDRESS]: { value: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh', group: 'shop', description: 'Địa chỉ cửa hàng', isPublic: true },
  [SETTING_KEY.SHIPPING_FREE_THRESHOLD]: { value: 500000, group: 'shipping', description: 'Miễn phí ship từ (VND)', isPublic: true },
  [SETTING_KEY.SHIPPING_DEFAULT_FEE]: { value: 30000, group: 'shipping', description: 'Phí ship mặc định khi không khớp tỉnh (VND)', isPublic: true },
  [SETTING_KEY.ORDER_ONLINE_PAYMENT_TIMEOUT_MINUTES]: { value: 30, group: 'order', description: 'Đơn PayOS chưa thanh toán quá hạn (phút) → huỷ, nhả kho', isPublic: false },
  [SETTING_KEY.ORDER_COD_MAX_AMOUNT]: { value: 5000000, group: 'order', description: 'Giá trị đơn tối đa cho COD (VND)', isPublic: true },
  [SETTING_KEY.ORDER_AUTO_COMPLETE_DAYS]: { value: 7, group: 'order', description: 'Đã giao N ngày không khiếu nại → hoàn tất', isPublic: false },
  [SETTING_KEY.RETURN_WINDOW_DAYS]: { value: 7, group: 'order', description: 'Số ngày sau khi giao được yêu cầu đổi trả', isPublic: true },
  [SETTING_KEY.CART_MAX_QTY_PER_LINE]: { value: 10, group: 'cart', description: 'Số lượng tối đa mỗi dòng giỏ', isPublic: true },
  [SETTING_KEY.PAYOUT_AUTO_ENABLED]: { value: true, group: 'payout', description: 'Tự động đối soát + chi trả shop hằng ngày lúc 02:00 (Asia/Ho_Chi_Minh); chỉ chạy khi PayOS chi đã cấu hình', isPublic: false },
  [SETTING_KEY.WALLET_MIN_DEPOSIT]: { value: 500000, group: 'wallet', description: 'Số tiền đặt cọc COD tối thiểu mỗi lần nộp (VND)', isPublic: false },
  [SETTING_KEY.WALLET_DEPOSIT_INSTRUCTIONS]: { value: 'Chuyển khoản tiền đặt cọc đến tài khoản của sàn FITLY (liên hệ hotline để nhận số tài khoản), nội dung: DATCOC <mã gian hàng>. Sau đó khai số tiền và mã giao dịch để sàn đối chiếu và duyệt.', group: 'wallet', description: 'Hướng dẫn chuyển khoản đặt cọc COD hiển thị cho shop', isPublic: false },
};

export const NOTIFICATION_TYPE = { ORDER: 'order', PAYMENT: 'payment', PROMOTION: 'promotion', REVIEW: 'review', SUPPORT: 'support', SYSTEM: 'system', AI: 'ai', INVENTORY: 'inventory' } as const;

export const SYSTEM_CACHE = {
  settings: { module: SYSTEM_MODULE, purpose: 'settings', ttlSeconds: 600 } satisfies CacheSpec,
  provinces: { module: SYSTEM_MODULE, purpose: 'provinces', ttlSeconds: 3600 } satisfies CacheSpec,
  banners: { module: SYSTEM_MODULE, purpose: 'banners', ttlSeconds: 300 } satisfies CacheSpec,
  faqs: { module: SYSTEM_MODULE, purpose: 'faqs', ttlSeconds: 600 } satisfies CacheSpec,
  pages: { module: SYSTEM_MODULE, purpose: 'pages', ttlSeconds: 600 } satisfies CacheSpec,
};

/* Liên hệ gửi shop mà shop chưa trả lời sau từng này giờ thì sàn được vào cuộc (khiếu nại shop không phản hồi). */
export const CONTACT_SHOP_OVERDUE_HOURS = 48;
