-- rename_sales_to_customer_care (PLAN-0021) — vai sales (mã giữ nguyên): đổi tên "Chăm sóc khách hàng", bỏ quyền xem tồn kho (kho là của shop).
UPDATE "identity"."roles" SET "name" = 'Chăm sóc khách hàng', "description" = 'Phân xử khiếu nại / đổi trả, huỷ đơn khi tranh chấp, kiểm duyệt đánh giá, hỗ trợ khách từ chatbot — sàn không bán hàng', "updated_at" = CURRENT_TIMESTAMP WHERE "code" = 'sales';
DELETE FROM "identity"."role_permissions" WHERE "role_id" IN (SELECT "id" FROM "identity"."roles" WHERE "code" = 'sales') AND "permission_id" IN (SELECT "id" FROM "identity"."permissions" WHERE "code" = 'product.inventory.read');
UPDATE "identity"."users" SET "permission_version" = "permission_version" + 1 WHERE "role_id" IN (SELECT "id" FROM "identity"."roles" WHERE "code" = 'sales');
