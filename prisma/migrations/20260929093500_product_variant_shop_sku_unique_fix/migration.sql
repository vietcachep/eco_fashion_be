-- =====================================================================
-- product_variant_shop_sku_unique_fix. Migration 20260929084707_product_shop_id
-- dừng giữa chừng ở bước tạo unique(shop_id, sku) vì dữ liệu test cũ có SKU trùng
-- trong cùng 1 shop (3 sản phẩm test API đổi tên cùng SKU "AOTHUNTE20C0-DEN-*").
-- Dedupe an toàn (đổi tên SKU trùng, không xoá dữ liệu) rồi mới tạo lại constraint/index.
-- =====================================================================

-- Dedupe: SKU trùng trong cùng shop → giữ bản ghi cũ nhất, đổi tên các bản ghi sau bằng hậu tố -DUPn
WITH dups AS (
  SELECT id, row_number() OVER (PARTITION BY shop_id, sku ORDER BY id) AS rn
  FROM "product"."product_variants"
)
UPDATE "product"."product_variants" pv
SET "sku" = pv."sku" || '-DUP' || dups.rn
FROM dups
WHERE pv."id" = dups.id AND dups.rn > 1;

-- Tạo lại constraint/index mà migration trước dừng giữa chừng — kiểm tồn tại qua catalog trước khi tạo
-- (không dùng EXCEPTION duplicate_object: Postgres báo lỗi 42P07 "relation already exists" cho trường hợp
-- này, không phải 42710, nên bản trước bắt sai mã lỗi — trên DB sạch từ đầu, replay migration trước đã tự
-- tạo xong constraint/index này rồi, migration này phải NHẬN RA và bỏ qua thay vì thử tạo lại).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uc_product_variants_shop_id_sku') THEN
    ALTER TABLE "product"."product_variants" ADD CONSTRAINT "uc_product_variants_shop_id_sku" UNIQUE ("shop_id", "sku");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_product_variants_shop_id" ON "product"."product_variants" ("shop_id");
