-- =====================================================================
-- platform_shop_separation (PLAN-0021) — tách rạch ròi việc của SÀN và việc của CHỦ SHOP:
--   * Sàn không tạo/sửa/xoá sản phẩm, không nhập/điều chỉnh kho, không xác nhận/đóng gói/giao đơn, không trả lời đánh giá thay shop
--     ⇒ 7 mã quyền chuyển sang deprecated (is_active=false) và gỡ khỏi mọi vai/quyền riêng đã gán.
--   * Chủ shop tự đặt quyền cho từng nhân viên: thêm cột shop.shop_members.custom_permissions (mảng mã shop.*; NULL = theo preset của vai).
-- KHÔNG sửa migration cũ. Idempotent ở phần dữ liệu.
-- =====================================================================

ALTER TABLE "shop"."shop_members" ADD COLUMN IF NOT EXISTS "custom_permissions" JSONB;

UPDATE "identity"."permissions" SET "is_active" = false, "updated_at" = CURRENT_TIMESTAMP
WHERE "code" IN ('product.product.create', 'product.product.update', 'product.product.delete', 'product.inventory.receive', 'product.inventory.adjust', 'order.order.status.update', 'review.review.reply')
  AND "is_active" = true;

DELETE FROM "identity"."role_permissions"
WHERE "permission_id" IN (SELECT "id" FROM "identity"."permissions" WHERE "is_active" = false AND "code" IN ('product.product.create', 'product.product.update', 'product.product.delete', 'product.inventory.receive', 'product.inventory.adjust', 'order.order.status.update', 'review.review.reply'));

DELETE FROM "identity"."user_permissions"
WHERE "permission_id" IN (SELECT "id" FROM "identity"."permissions" WHERE "is_active" = false AND "code" IN ('product.product.create', 'product.product.update', 'product.product.delete', 'product.inventory.receive', 'product.inventory.adjust', 'order.order.status.update', 'review.review.reply'));

-- Mã quyền đổi ⇒ token/cache quyền cũ mất hiệu lực.
UPDATE "identity"."users" SET "permission_version" = "permission_version" + 1;
