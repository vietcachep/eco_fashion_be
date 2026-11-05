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

/* `min`/`max` (tuỳ chọn, chỉ cho tham số số): SettingService.update chặn giá trị ngoài khoảng — hạn chót đổi trả không được 0/âm/quá lớn (sẽ tạo ngày sai hoặc chuyển bước ngay). */
export const SETTING_DEFAULTS: Record<string, { value: unknown; group: string; description: string; isPublic: boolean; min?: number; max?: number }> = {
  [SETTING_KEY.SHOP_NAME]: { value: 'FITLY', group: 'shop', description: 'Tên cửa hàng', isPublic: true },
  [SETTING_KEY.SHOP_HOTLINE]: { value: '1900 6868', group: 'shop', description: 'Hotline', isPublic: true },
  [SETTING_KEY.SHOP_EMAIL]: { value: 'hotro@ecofashion.vn', group: 'shop', description: 'Email hỗ trợ', isPublic: true },
  [SETTING_KEY.SHOP_ADDRESS]: { value: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh', group: 'shop', description: 'Địa chỉ cửa hàng', isPublic: true },
  [SETTING_KEY.SHIPPING_FREE_THRESHOLD]: { value: 500000, group: 'shipping', description: 'Miễn phí ship từ (VND)', isPublic: true },
  [SETTING_KEY.SHIPPING_DEFAULT_FEE]: { value: 30000, group: 'shipping', description: 'Phí ship mặc định khi không khớp tỉnh (VND)', isPublic: true },
  [SETTING_KEY.ORDER_ONLINE_PAYMENT_TIMEOUT_MINUTES]: { value: 30, group: 'order', description: 'Đơn PayOS chưa thanh toán quá hạn (phút) → huỷ, nhả kho', isPublic: false },
  [SETTING_KEY.ORDER_PAYMENT_GRACE_MINUTES]: { value: 10, group: 'order', description: 'Ân hạn (phút) sau hạn thanh toán PayOS trước khi tự huỷ đơn — job huỷ hỏi lại PayOS, khách trả trong ân hạn vẫn được ghi nhận', isPublic: false, min: 0, max: 60 },
  [SETTING_KEY.ORDER_COD_MAX_AMOUNT]: { value: 5000000, group: 'order', description: 'Giá trị đơn tối đa cho COD (VND)', isPublic: true },
  [SETTING_KEY.ORDER_AUTO_COMPLETE_DAYS]: { value: 7, group: 'order', description: 'Đã giao N ngày không khiếu nại → hoàn tất', isPublic: false, min: 3, max: 30 },
  // PLAN-0027 — hạn chót xử lý đơn của shop
  [SETTING_KEY.ORDER_SLA_ENABLED]: { value: false, group: 'order', description: 'Bật SLA: tự huỷ khi shop quá hạn xác nhận/giao (+ hoàn tiền, +1 điểm), tự chấp nhận huỷ quá hạn. Mặc định tắt; bỏ qua đơn cũ chưa có hạn. Khi bật, dời hạn đã trễ sang bây giờ + số giờ để tránh huỷ hàng loạt.', isPublic: false },
  [SETTING_KEY.ORDER_SHOP_CONFIRM_HOURS]: { value: 24, group: 'order', description: 'Số giờ shop phải xác nhận đơn (COD: từ lúc đặt; PayOS: từ lúc nhận tiền). Nhắc khi còn 6 giờ; quá hạn → tự huỷ + hoàn tiền + 1 điểm vi phạm', isPublic: false, min: 4, max: 168 },
  [SETTING_KEY.ORDER_SHOP_SHIP_HOURS]: { value: 48, group: 'order', description: 'Số giờ shop phải giao đơn (có mã vận đơn) kể từ lúc xác nhận; được gia hạn 1 lần thêm đúng số giờ này. Nhắc khi còn 12 giờ; quá hạn → tự huỷ + hoàn tiền + nhập kho + 1 điểm vi phạm', isPublic: false, min: 12, max: 336 },
  [SETTING_KEY.ORDER_CANCEL_REQUEST_HOURS]: { value: 24, group: 'order', description: 'Số giờ shop được duyệt / từ chối yêu cầu huỷ đơn đang đóng gói của khách — quá hạn thì tự chấp nhận', isPublic: false, min: 4, max: 72 },
  [SETTING_KEY.SHOP_VIOLATION_SUSPEND_POINTS]: { value: 10, group: 'shop', description: 'Tổng điểm vi phạm xử lý đơn của một gian hàng trong 30 ngày đạt mức này thì nhắc quản lý xem xét khoá (nhắc 1 lần / 7 ngày)', isPublic: false, min: 1, max: 100 },
  [SETTING_KEY.RETURN_WINDOW_DAYS]: { value: 7, group: 'order', description: 'Số ngày sau khi giao được yêu cầu đổi trả', isPublic: true },
  [SETTING_KEY.RETURN_SHOP_RESPOND_HOURS]: { value: 72, group: 'order', description: 'Số giờ shop được duyệt / từ chối yêu cầu đổi trả — quá hạn thì chuyển sàn phân xử', isPublic: false, min: 1, max: 8760 },
  [SETTING_KEY.RETURN_SHIP_BACK_DAYS]: { value: 7, group: 'order', description: 'Số ngày khách phải gửi hàng trả kể từ khi shop duyệt — quá hạn thì yêu cầu hết hiệu lực', isPublic: false, min: 1, max: 365 },
  [SETTING_KEY.RETURN_SHOP_RECEIVE_DAYS]: { value: 5, group: 'order', description: 'Số ngày shop phải xác nhận nhận lại hàng kể từ khi khách báo đã gửi — quá hạn thì chuyển sàn phân xử', isPublic: false, min: 1, max: 365 },
  [SETTING_KEY.RETURN_ESCALATE_DAYS]: { value: 3, group: 'order', description: 'Số ngày khách được khiếu nại lên sàn sau khi shop từ chối đổi trả', isPublic: false, min: 1, max: 365 },
  [SETTING_KEY.RETURN_NOT_RECEIVED_DAYS]: { value: 7, group: 'order', description: 'Số ngày sau khi đơn báo đã giao khách còn được báo "chưa nhận hàng" (PLAN-0031: mặc định 7, trước đây 3)', isPublic: false, min: 1, max: 365 },
  [SETTING_KEY.ORDER_SHIPPING_ALERT_DAYS]: { value: 10, group: 'order', description: 'Đơn đang giao quá N ngày thì cảnh báo shop + CSKH (một lần)', isPublic: false, min: 1, max: 365 },
  [SETTING_KEY.CART_MAX_QTY_PER_LINE]: { value: 10, group: 'cart', description: 'Số lượng tối đa mỗi dòng giỏ', isPublic: true },
  [SETTING_KEY.PAYOUT_AUTO_ENABLED]: { value: false, group: 'payout', description: 'Tự động đối soát + chi trả shop hằng ngày lúc 02:00 (Asia/Ho_Chi_Minh); chỉ chạy khi PayOS chi đã cấu hình. MẶC ĐỊNH TẮT (PLAN-0026): bật sau khi đã chi tay 2 kỳ và đối chiếu PayOS thật', isPublic: false },
  // PLAN-0030 — ví cọc COD: shop chỉ nhận COD khi số dư ≥ mức này (gian hàng chính chủ miễn)
  [SETTING_KEY.WALLET_MIN_BALANCE_FOR_COD]: { value: 200000, group: 'wallet', description: 'Số dư ví cọc tối thiểu (VND) để gian hàng nhận COD đơn mới; về dưới mức này thì COD tự đóng', isPublic: false, min: 1, max: 100000000 },
  // PLAN-0026 — chi trả shop an toàn
  [SETTING_KEY.PAYOUT_MIN_AMOUNT]: { value: 50000, group: 'payout', description: 'Kỳ chi trả có thực nhận dưới mức này (VND) thì dồn sang kỳ sau, không chi', isPublic: false, min: 0, max: 10000000 },
  [SETTING_KEY.REFUND_AUTO_MAX_AMOUNT]: { value: 2000000, group: 'payout', description: 'Hoàn tiền cho khách tự động qua PayOS khi số tiền ≤ mức này (VND); lớn hơn thì chờ kế toán bấm. 0 = tắt tự động', isPublic: false, min: 0, max: 50000000 },
  [SETTING_KEY.PAYOUT_AUTO_MAX_AMOUNT]: { value: 20000000, group: 'payout', description: 'Kỳ chi trả có thực nhận lớn hơn mức này (VND) phải chờ kế toán duyệt trước khi gửi PayOS', isPublic: false, min: 0, max: 1000000000 },
  [SETTING_KEY.PAYOUT_BANK_CHANGE_HOLD_HOURS]: { value: 72, group: 'payout', description: 'Số giờ tạm giữ chi trả sau khi shop đổi tài khoản ngân hàng', isPublic: false, min: 24, max: 720 },
  [SETTING_KEY.WALLET_MIN_DEPOSIT]: { value: 500000, group: 'wallet', description: 'Số tiền đặt cọc COD tối thiểu mỗi lần nộp (VND)', isPublic: false },
  [SETTING_KEY.WALLET_DEPOSIT_INSTRUCTIONS]: { value: 'Chuyển khoản tiền đặt cọc đến tài khoản của sàn FITLY (liên hệ hotline để nhận số tài khoản), nội dung: DATCOC <mã gian hàng>. Sau đó khai số tiền và mã giao dịch để sàn đối chiếu và duyệt.', group: 'wallet', description: 'Hướng dẫn chuyển khoản đặt cọc COD hiển thị cho shop', isPublic: false },
  [SETTING_KEY.WALLET_PAYOS_DEPOSIT_ENABLED]: { value: true, group: 'wallet', description: 'Nạp cọc COD qua PayOS, mặc định bật và là đường nạp duy nhất (chốt 2026-11-03); cần cấu hình khoá PayOS. Tắt chỉ chặn tạo link mới; tiền về từ link đang chờ vẫn được ghi có.', isPublic: false },
  [SETTING_KEY.WALLET_MAX_TOPUP_AMOUNT]: { value: 50000000, group: 'wallet', description: 'Số tiền tối đa (VND) mỗi lần nạp cọc qua PayOS', isPublic: false, min: 1000, max: 1000000000 },
  [SETTING_KEY.WALLET_PAYOS_TOPUP_EXPIRE_MINUTES]: { value: 60, group: 'wallet', description: 'Hạn của link nạp cọc PayOS (phút)', isPublic: false, min: 5, max: 1440 },
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
