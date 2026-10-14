-- =====================================================================
-- identity_role_scope_and_shop_permissions (PLAN-0014 bước 2). Chỉ đổi schema `identity`: cột `roles.scope`
-- phân biệt vai áp dụng toàn hệ thống (platform, 7 vai cũ) hay chỉ trong phạm vi một gian hàng (shop, vai mới
-- shop_owner/shop_staff — seed bởi scripts/sync-permissions.ts đọc identity/permission/catalog.ts, không seed
-- ở migration này). Mã quyền `supplier.shop.*` / `shop.profile.*` / `shop.staff.*` cũng nạp qua perms:sync.
-- =====================================================================

-- AlterTable
ALTER TABLE "identity"."roles" ADD COLUMN     "scope" VARCHAR(20) NOT NULL DEFAULT 'platform';

-- Sửa tay: giá trị hợp lệ (RoleScope ở identity/permission/catalog.ts)
ALTER TABLE "identity"."roles" ADD CONSTRAINT "ck_roles_scope"
  CHECK ("scope" IN ('platform', 'shop'));
