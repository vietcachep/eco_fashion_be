-- =====================================================================
-- product_shop_id (PLAN-0014 bước 5). Thêm cột shopId vào product/product_variants,
-- đổi SKU constraint từ unique(productId, colorCode, sizeCode) toàn bảng thành unique(shopId, sku).
-- Migration 2 bước: thêm cột nullable → backfill vào shop mặc định → NOT NULL.
-- =====================================================================

-- Bước 1: tạo FITLY Official shop trong schema `shop` để backfill sản phẩm hiện có
INSERT INTO "shop"."shops" (
  "id", "code", "slug", "name", "status", "commission_rate", "cod_enabled", "owner_user_id", "created_at", "updated_at"
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'SHOP-000001',
  'fitly-official',
  'FITLY Official',
  'approved',
  '0.00',
  true,
  '00000000-0000-0000-0000-000000000001',
  now(),
  now()
) ON CONFLICT DO NOTHING;

-- Bước 2: thêm cột shopId (nullable) vào products
ALTER TABLE "product"."products" ADD COLUMN "shop_id" UUID;

-- Bước 3: backfill tất cả products vào FITLY Official shop
UPDATE "product"."products" SET "shop_id" = '00000000-0000-0000-0000-000000000001'
WHERE "shop_id" IS NULL;

-- Bước 4: đặt NOT NULL
ALTER TABLE "product"."products" ALTER COLUMN "shop_id" SET NOT NULL;

-- Bước 5: thêm index trên shopId
CREATE INDEX "idx_products_shop_id" ON "product"."products" ("shop_id");

-- Bước 6: thêm cột shopId (nullable) vào product_variants
ALTER TABLE "product"."product_variants" ADD COLUMN "shop_id" UUID;

-- Bước 7: backfill product_variants từ product.shop_id (join)
UPDATE "product"."product_variants" pv
SET "shop_id" = p."shop_id"
FROM "product"."products" p
WHERE pv."product_id" = p."id";

-- Bước 8: đặt NOT NULL trên product_variants.shop_id
ALTER TABLE "product"."product_variants" ALTER COLUMN "shop_id" SET NOT NULL;

-- Bước 9: thêm unique constraint (shopId, sku) — 2 shop khác nhau được phép có SKU trùng
ALTER TABLE "product"."product_variants" ADD CONSTRAINT "uc_product_variants_shop_id_sku" UNIQUE ("shop_id", "sku");

-- Bước 10: thêm index trên shopId
CREATE INDEX "idx_product_variants_shop_id" ON "product"."product_variants" ("shop_id");
