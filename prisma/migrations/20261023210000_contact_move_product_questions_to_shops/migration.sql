-- contact_move_product_questions_to_shops (PLAN-0021) — chuyển các tin liên hệ cũ HỎI VỀ SẢN PHẨM sang đúng gian hàng bán sản phẩm đó
-- (trước đây mọi tin đều gửi sàn). Tin về chính sách / đổi trả / mã giảm giá của sàn giữ nguyên ở sàn. Idempotent: chỉ đụng tin chưa có shop.

-- 1. "Shop có size XXL cho áo thun cotton nam basic không ạ?" (cả bản đã trả lời)
UPDATE "system"."contact_messages" cm
SET "shop_id" = p."shop_id", "product_name" = p."name"
FROM "product"."products" p
WHERE cm."shop_id" IS NULL AND cm."message" ILIKE '%áo thun cotton nam basic%'
  AND p."is_deleted" = false AND p."name" ILIKE 'Áo thun cotton nam basic%';

-- 2. "Đầm dự tiệc body có màu đỏ đô không shop?"
UPDATE "system"."contact_messages" cm
SET "shop_id" = p."shop_id", "product_name" = p."name"
FROM "product"."products" p
WHERE cm."shop_id" IS NULL AND cm."message" ILIKE '%đầm dự tiệc body%'
  AND p."is_deleted" = false AND p."name" ILIKE 'Đầm dự tiệc body%';

-- 3. "Công ty muốn đặt 40 áo polo in logo ... báo giá riêng" → shop bán áo polo chạy nhất
UPDATE "system"."contact_messages" cm
SET "shop_id" = x."shop_id", "product_name" = x."name"
FROM (
  SELECT "shop_id", "name" FROM "product"."products"
  WHERE "is_deleted" = false AND "status" = 'active' AND "name" ILIKE 'Áo polo%'
  ORDER BY "sold_count" DESC LIMIT 1
) x
WHERE cm."shop_id" IS NULL AND cm."message" ILIKE '%áo polo in logo%';
