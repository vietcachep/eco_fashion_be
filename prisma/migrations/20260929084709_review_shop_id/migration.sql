-- =====================================================================
-- review_shop_id (PLAN-0014 bước 9). Thêm cột shopId vào review
-- để snapshot shopId lúc tạo review, phục vụ shop.review.reply (vendor trả lời review).
-- =====================================================================

-- Thêm cột shopId (nullable) vào reviews
ALTER TABLE "review"."reviews" ADD COLUMN "shop_id" UUID;

-- Backfill từ product.shop_id (JOIN qua productId)
UPDATE "review"."reviews" r
SET "shop_id" = p."shop_id"
FROM "product"."products" p
WHERE r."product_id" = p."id";

-- Đặt NOT NULL
ALTER TABLE "review"."reviews" ALTER COLUMN "shop_id" SET NOT NULL;

-- Thêm index trên shopId
CREATE INDEX "idx_reviews_shop_id" ON "review"."reviews" ("shop_id");
