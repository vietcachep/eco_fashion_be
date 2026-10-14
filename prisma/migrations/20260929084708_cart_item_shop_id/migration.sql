-- =====================================================================
-- cart_item_shop_id (PLAN-0014 bước 6). Thêm cột shopId vào cart_items
-- để denormalize shopId từ product lúc thêm giỏ, phục vụ tách giỏ theo shop khi checkout.
-- =====================================================================

-- Thêm cột shopId (nullable) vào cart_items
ALTER TABLE "cart"."cart_items" ADD COLUMN "shop_id" UUID;

-- Backfill từ product.shop_id (JOIN qua productId)
UPDATE "cart"."cart_items" ci
SET "shop_id" = p."shop_id"
FROM "product"."products" p
WHERE ci."product_id" = p."id";

-- Đặt NOT NULL
ALTER TABLE "cart"."cart_items" ALTER COLUMN "shop_id" SET NOT NULL;

-- Thêm index trên shopId
CREATE INDEX "idx_cart_items_shop_id" ON "cart"."cart_items" ("shop_id");
