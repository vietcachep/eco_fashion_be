-- remove_warehouse_role (PLAN-0021) — bỏ vai "Nhân viên kho" của sàn: kho là việc của từng shop.
-- Tài khoản đang giữ vai chuyển sang "Bán hàng & CSKH" để không ai mất quyền đăng nhập; vai bị xoá mềm + gỡ quyền.
UPDATE "identity"."users" SET "role_id" = (SELECT "id" FROM "identity"."roles" WHERE "code" = 'sales' LIMIT 1), "permission_version" = "permission_version" + 1 WHERE "role_id" IN (SELECT "id" FROM "identity"."roles" WHERE "code" = 'warehouse') AND EXISTS (SELECT 1 FROM "identity"."roles" WHERE "code" = 'sales');
DELETE FROM "identity"."role_permissions" WHERE "role_id" IN (SELECT "id" FROM "identity"."roles" WHERE "code" = 'warehouse');
UPDATE "identity"."roles" SET "is_deleted" = true, "updated_at" = CURRENT_TIMESTAMP WHERE "code" = 'warehouse';
