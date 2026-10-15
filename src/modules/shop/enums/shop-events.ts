/* Phần CÔNG KHAI của shop cho module khác (listener ở worker của payment nghe sự kiện outbox của shop). */
export const SHOP_MODULE = 'shop';

export const SHOP_EVENT = {
  APPROVED: 'SHOP_APPROVED',
  SUSPENDED: 'SHOP_SUSPENDED',
  REJECTED: 'SHOP_REJECTED',
  BANK_CHANGED: 'SHOP_BANK_CHANGED',
  /* Thành viên tự rời gian hàng — payload {shopId, memberId, roleCode}; chưa có listener. */
  MEMBER_LEFT: 'SHOP_MEMBER_LEFT',
  /* Chủ shop vừa thêm một nhân viên (tài khoản mới) vào shop — payload {shopId, memberId, roleId}; chưa có listener. */
  MEMBER_JOINED: 'SHOP_MEMBER_JOINED',
  /* Người bán nộp hồ sơ đăng ký gian hàng (PLAN-0019) — payload {shopId, code, name, applicantUserId}, KHÔNG có SĐT/email; chưa có listener. */
  REGISTRATION_SUBMITTED: 'SHOP_REGISTRATION_SUBMITTED',
} as const;
