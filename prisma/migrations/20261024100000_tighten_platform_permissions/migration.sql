-- tighten_platform_permissions (PLAN-0021) — siết quyền của sàn:
--   * Kế toán chỉ DUYỆT / TỪ CHỐI khoản nộp cọc COD (mã mới supplier.wallet.approve, do perms:sync gán); CHỈNH ví tay (supplier.wallet.adjust) chỉ Admin
--     ⇒ gỡ adjust khỏi vai accountant (một người không tự cộng/trừ tiền ví khi không có chứng từ).
--   * Đặt % hoa hồng (supplier.shop.commission) chỉ Admin ⇒ gỡ khỏi vai manager.
--   * Tin khách gửi sàn có quyền riêng system.contact.read / reply (trước đây dùng chung system.notification.send) — perms:sync gán cho CSKH / Quản lý.
-- Idempotent. Người bị đổi quyền được tăng permission_version để token cũ mất hiệu lực.

DELETE FROM "identity"."role_permissions"
WHERE ("role_id" IN (SELECT "id" FROM "identity"."roles" WHERE "code" = 'accountant')
       AND "permission_id" IN (SELECT "id" FROM "identity"."permissions" WHERE "code" = 'supplier.wallet.adjust'))
   OR ("role_id" IN (SELECT "id" FROM "identity"."roles" WHERE "code" = 'manager')
       AND "permission_id" IN (SELECT "id" FROM "identity"."permissions" WHERE "code" = 'supplier.shop.commission'));

UPDATE "identity"."users" SET "permission_version" = "permission_version" + 1
WHERE "role_id" IN (SELECT "id" FROM "identity"."roles" WHERE "code" IN ('accountant', 'manager'));
