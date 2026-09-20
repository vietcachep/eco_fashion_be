import type { CacheSpec } from '@common/cache/cache.service';

export const SYSTEM_MODULE = 'system';

export const SYSTEM_ERR = {
  SETTING_NOT_FOUND: 'SYSTEM_SETTING_NOT_FOUND',
  PROVINCE_NOT_FOUND: 'SYSTEM_PROVINCE_NOT_FOUND',
  BANNER_NOT_FOUND: 'SYSTEM_BANNER_NOT_FOUND',
  NOTIFICATION_NOT_FOUND: 'SYSTEM_NOTIFICATION_NOT_FOUND',
  CONTACT_NOT_FOUND: 'SYSTEM_CONTACT_NOT_FOUND',
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
  [SETTING_KEY.ORDER_VNPAY_TIMEOUT_MINUTES]: { value: 30, group: 'order', description: 'Đơn VNPay chưa thanh toán quá hạn (phút) → huỷ, nhả kho', isPublic: false },
  [SETTING_KEY.ORDER_BANK_TRANSFER_TIMEOUT_HOURS]: { value: 24, group: 'order', description: 'Đơn chuyển khoản chưa xác nhận quá hạn (giờ) → huỷ', isPublic: false },
  [SETTING_KEY.ORDER_COD_MAX_AMOUNT]: { value: 5000000, group: 'order', description: 'Giá trị đơn tối đa cho COD (VND)', isPublic: true },
  [SETTING_KEY.ORDER_AUTO_COMPLETE_DAYS]: { value: 7, group: 'order', description: 'Đã giao N ngày không khiếu nại → hoàn tất', isPublic: false },
  [SETTING_KEY.RETURN_WINDOW_DAYS]: { value: 7, group: 'order', description: 'Số ngày sau khi giao được yêu cầu đổi trả', isPublic: true },
  [SETTING_KEY.CART_MAX_QTY_PER_LINE]: { value: 10, group: 'cart', description: 'Số lượng tối đa mỗi dòng giỏ', isPublic: true },
};

export const NOTIFICATION_TYPE = { ORDER: 'order', PAYMENT: 'payment', PROMOTION: 'promotion', REVIEW: 'review', SUPPORT: 'support', SYSTEM: 'system', AI: 'ai', INVENTORY: 'inventory' } as const;

export const SYSTEM_CACHE = {
  settings: { module: SYSTEM_MODULE, purpose: 'settings', ttlSeconds: 600 } satisfies CacheSpec,
  provinces: { module: SYSTEM_MODULE, purpose: 'provinces', ttlSeconds: 3600 } satisfies CacheSpec,
  banners: { module: SYSTEM_MODULE, purpose: 'banners', ttlSeconds: 300 } satisfies CacheSpec,
  faqs: { module: SYSTEM_MODULE, purpose: 'faqs', ttlSeconds: 600 } satisfies CacheSpec,
  pages: { module: SYSTEM_MODULE, purpose: 'pages', ttlSeconds: 600 } satisfies CacheSpec,
};
