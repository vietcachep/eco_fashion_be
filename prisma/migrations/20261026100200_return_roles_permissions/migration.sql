-- return_roles_permissions (PLAN-0022) — quyền đổi trả theo đúng vai:
--   * order.return.process (nhân viên sàn) nay CHỈ để PHÂN XỬ yêu cầu đã chuyển lên sàn (khiếu nại / shop quá hạn / hàng không khớp) — việc của admin + CSKH;
--     duyệt / từ chối / xác nhận nhận hàng là việc của SHOP (mã mới shop.return.read / shop.return.process, do perms:sync tạo + gán cho shop_owner / shop_staff).
--     ⇒ gỡ order.return.process khỏi vai manager (quản lý chỉ XEM: order.return.read). Kế toán vẫn chỉ xem.
--   * Quyền riêng đã cấp tay cho từng người (user_permissions) giữ nguyên — admin tự rà.
-- Idempotent. Người bị đổi quyền được tăng permission_version để token/cache cũ mất hiệu lực.

DELETE FROM "identity"."role_permissions"
WHERE "role_id" IN (SELECT "id" FROM "identity"."roles" WHERE "code" = 'manager')
  AND "permission_id" IN (SELECT "id" FROM "identity"."permissions" WHERE "code" = 'order.return.process');

UPDATE "identity"."users" SET "permission_version" = "permission_version" + 1
WHERE "role_id" IN (SELECT "id" FROM "identity"."roles" WHERE "code" = 'manager');
