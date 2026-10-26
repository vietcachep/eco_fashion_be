import { SHOP_MODULE } from '../enums/shop-events';

export { SHOP_MODULE };

/* Gian hàng CHÍNH CHỦ của sàn (không phải vendor bên thứ 3) — tạo sẵn bởi migration product_shop_id để
   backfill sản phẩm cũ (trước khi có module shop). Mã cố định, ổn định dù sau này có thêm bao nhiêu shop
   vendor khác — dùng làm shopId mặc định khi NHÂN VIÊN SÀN (không phải vendor) tự tạo sản phẩm qua
   /admin/products (PLAN-0014 bước 5). KHÔNG suy ra bằng cách query "shop approved đầu tiên": một vendor
   được duyệt sớm hơn ngày seed lại DB sẽ vô tình trở thành shop mặc định — sai hoàn toàn. */
export const FITLY_OFFICIAL_SHOP_CODE = 'SHOP-000001';

/* Mã lỗi ổn định của module shop (AGENTS.md — common chỉ chuẩn hoá khuôn, module tự đặt mã). */
export const SHOP_ERR = {
  NOT_FOUND: 'SHOP_NOT_FOUND',
  CODE_EXISTS: 'SHOP_CODE_EXISTS',
  SLUG_EXISTS: 'SHOP_SLUG_EXISTS',
  INVALID_TRANSITION: 'SHOP_INVALID_TRANSITION',
  NOT_MEMBER: 'SHOP_NOT_MEMBER',
  NOT_APPROVED: 'SHOP_NOT_APPROVED',
  FORBIDDEN: 'SHOP_FORBIDDEN',
  MEMBER_NOT_FOUND: 'SHOP_MEMBER_NOT_FOUND',
  /* Chủ shop thêm nhân viên khi shop đã có SHOP_MEMBER_MAX_ACTIVE thành viên đang hoạt động — 409, "hãy gỡ bớt người không còn làm việc". */
  MEMBER_LIMIT_REACHED: 'SHOP_MEMBER_LIMIT_REACHED',
  /* Thêm lại một nhân viên cũ (đã bị gỡ khỏi CHÍNH shop này) nhưng tài khoản hiện không khôi phục được (đang là thành viên active của shop khác,
     bị khoá…) — 409, thông điệp trung tính ("dùng email khác"), không nói lý do để không lộ trạng thái tài khoản. */
  MEMBER_UNAVAILABLE: 'SHOP_MEMBER_UNAVAILABLE',
  ROLE_INVALID: 'SHOP_ROLE_INVALID',
  LAST_OWNER: 'SHOP_LAST_OWNER',
  /* Tài khoản ngân hàng gửi thiếu trường: lần đầu khai phải đủ 3 trường; đổi số tài khoản/BIN phải gửi lại tên chủ TK. */
  BANK_FIELD_INCOMPLETE: 'SHOP_BANK_FIELD_INCOMPLETE',
  /* PLAN-0019 — người bán tự đăng ký gian hàng (POST /shop/registrations). */
  /* 409: người nộp đã có một shop đang chờ duyệt. */
  REGISTRATION_PENDING: 'SHOP_REGISTRATION_PENDING',
  /* 409: người nộp đã là thành viên active của một gian hàng (mỗi người một shop active). */
  REGISTRATION_ALREADY_MEMBER: 'SHOP_REGISTRATION_ALREADY_MEMBER',
  /* 403: tài khoản nhân viên sàn (vai ≠ customer) hoặc tài khoản không còn active. */
  REGISTRATION_NOT_ELIGIBLE: 'SHOP_REGISTRATION_NOT_ELIGIBLE',
  /* 400: ngành hàng không tồn tại hoặc không hoạt động. */
  REGISTRATION_CATEGORY_INVALID: 'SHOP_REGISTRATION_CATEGORY_INVALID',
  /* 400: SĐT không phải số di động VN (đã chặn ở Request DTO — đây là lưới phòng thủ khi service được gọi không qua HTTP). */
  REGISTRATION_PHONE_INVALID: 'SHOP_REGISTRATION_PHONE_INVALID',
  /* 409: trùng tên (không phân biệt hoa/thường) với gian hàng đang chờ duyệt/đã duyệt/đang bị khoá. */
  NAME_TAKEN: 'SHOP_NAME_TAKEN',
  /* 409 khi DUYỆT: người đăng ký nay đã thuộc shop khác / tài khoản không còn hợp lệ — sàn không duyệt được (nên từ chối); trạng thái KHÔNG đổi. */
  OWNER_UNAVAILABLE: 'SHOP_OWNER_UNAVAILABLE',
} as const;

/* Tên hành động audit của module — ổn định, dùng lọc trên màn audit. */
export const SHOP_AUDIT = {
  APPROVED: 'SHOP_APPROVED',
  SUSPENDED: 'SHOP_SUSPENDED',
  REJECTED: 'SHOP_REJECTED',
  COMMISSION_UPDATED: 'SHOP_COMMISSION_UPDATED',
  PROFILE_UPDATED: 'SHOP_PROFILE_UPDATED',
  BANK_UPDATED: 'SHOP_BANK_UPDATED',
  /* Chủ shop tạo tài khoản + thêm nhân viên vào shop (POST /shop/members). Dòng audit cũ của luồng lời mời (SHOP_INVITATION_*) vẫn còn trong DB. */
  MEMBER_ADDED: 'SHOP_MEMBER_ADDED',
  MEMBER_UPDATED: 'SHOP_MEMBER_UPDATED',
  MEMBER_REMOVED: 'SHOP_MEMBER_REMOVED',
  /* Thành viên tự rời gian hàng (POST /shop/members/leave). */
  MEMBER_LEFT: 'SHOP_MEMBER_LEFT',
  /* Người bán nộp hồ sơ tự đăng ký gian hàng (POST /shop/registrations, PLAN-0019). */
  REGISTRATION_SUBMITTED: 'SHOP_REGISTRATION_SUBMITTED',
} as const;

/* Sự kiện outbox module shop phát — định nghĩa ở enums/shop-events.ts (phần công khai cho module khác nghe). */
export { SHOP_EVENT } from '../enums/shop-events';

export const SHOP_STATUS = { PENDING: 'pending', APPROVED: 'approved', SUSPENDED: 'suspended', REJECTED: 'rejected' } as const;
export type ShopStatus = (typeof SHOP_STATUS)[keyof typeof SHOP_STATUS];

export const SHOP_MEMBER_STATUS = { ACTIVE: 'active', REMOVED: 'removed' } as const;

/*
 * Trần số thành viên ĐANG HOẠT ĐỘNG của MỘT gian hàng. Chủ shop tự tạo tài khoản nhân viên nên cần chặn việc "đẻ" tài khoản hàng loạt
 * (rate-limit 30 lần/giờ/người chỉ chặn tốc độ). Vượt trần ⇒ 409 SHOP_MEMBER_LIMIT_REACHED; gỡ nhân viên cũ thì thêm lại được.
 */
export const SHOP_MEMBER_MAX_ACTIVE = 50;

/*
 * Mã vai gán được cho ShopMember.roleId — PHẢI khớp `SHOP_ROLE_CODES` ở identity/permission/catalog.ts.
 * Không import trực tiếp từ identity (dependency-cruiser chỉ cho phép cross-module qua queryapi/enums —
 * catalog.ts nằm ngoài các thư mục đó) nên khai lặp danh sách ở đây CHỈ để validate format request DTO;
 * nguồn sự thật cuối cùng vẫn là `identity.queryapi.findShopRoleByCode()` (đọc DB, chặn cả sai scope).
 */
export const SHOP_MEMBER_ROLE_CODES = ['shop_owner', 'shop_staff'] as const;

/* Vai shop có quyền chủ — dùng chặn "gỡ/hạ/rời" người chủ cuối cùng (khớp identity ROLE_CODES.SHOP_OWNER; khai lặp vì không import catalog). */
export const SHOP_OWNER_ROLE_CODE = 'shop_owner';

/* Quyền giữ riêng cho chủ shop (không giao được): nhân sự, sửa hồ sơ/ngân hàng, đối soát, ví đặt cọc. */
export const SHOP_OWNER_ONLY_PERMISSIONS: readonly string[] = ['shop.staff.read', 'shop.staff.invite', 'shop.staff.update', 'shop.staff.remove', 'shop.profile.update', 'shop.payout.read', 'shop.wallet.read', 'shop.wallet.deposit_request'];

/*
 * Quyền CHỦ SHOP có thể giao cho nhân viên — chủ shop tự chọn cho từng người (PUT /shop/members/:id/permissions); SÀN không can thiệp phân quyền trong shop.
 * Quyền giữ riêng cho chủ (không có trong danh sách): nhân sự (shop.staff.*), sửa hồ sơ/ngân hàng, đối soát, ví đặt cọc.
 */
export const SHOP_ASSIGNABLE_PERMISSIONS: readonly string[] = [
  'shop.profile.read',
  'shop.product.read',
  'shop.product.manage',
  'shop.order.read',
  'shop.order.update',
  'shop.inventory.read',
  'shop.inventory.manage',
  'shop.promotion.read',
  'shop.promotion.manage',
  'shop.report.read',
  'shop.review.read',
  'shop.review.reply',
  'shop.contact.read',
  'shop.contact.reply',
];

/* Quyền hiệu lực của một thành viên: chủ = đủ quyền của vai; nhân viên = quyền riêng chủ đã đặt (lọc trong phạm vi được giao), chưa đặt thì preset của vai. */
export function effectiveShopPermissions(roleCode: string, rolePermissions: readonly string[], custom: unknown): string[] {
  if (roleCode === SHOP_OWNER_ROLE_CODE || !Array.isArray(custom)) return [...rolePermissions];
  return (custom as unknown[]).filter((c): c is string => typeof c === 'string' && SHOP_ASSIGNABLE_PERMISSIONS.includes(c));
}

/*
 * Vai NỀN TẢNG duy nhất của tài khoản được phép thêm làm nhân viên gian hàng: khách thường ('customer', khớp identity
 * ROLE_CODES.CUSTOMER — khai lặp vì không import catalog). Tài khoản mang vai nhân viên sàn (admin/manager/…) bị từ chối.
 */
export const SHOP_MEMBER_ELIGIBLE_PLATFORM_ROLE = 'customer';

export const SHOP_STATUS_LABEL: Record<string, string> = {
  pending: 'Chờ duyệt',
  approved: 'Đã duyệt',
  suspended: 'Đã khoá',
  rejected: 'Đã từ chối',
};

/*
 * Lưới chuyển trạng thái do NHÂN VIÊN SÀN thao tác (AdminShopController — quyền `supplier.shop.*`), cùng kiểu
 * với STAFF_TRANSITIONS của order: pending → approved|rejected (duyệt/từ chối lần đầu); approved → suspended
 * (khoá vi phạm); suspended → approved (mở khoá lại); rejected là trạng thái cuối (đăng ký lại = người bán nộp hồ sơ MỚI
 * → tạo shop mới, PLAN-0019 — không "mở lại" shop đã từ chối).
 */
export const SHOP_TRANSITIONS: Record<string, string[]> = {
  pending: [SHOP_STATUS.APPROVED, SHOP_STATUS.REJECTED],
  approved: [SHOP_STATUS.SUSPENDED],
  suspended: [SHOP_STATUS.APPROVED],
  rejected: [],
};
