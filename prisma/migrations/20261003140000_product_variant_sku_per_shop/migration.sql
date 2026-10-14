-- =====================================================================
-- product_variant_sku_per_shop (H9). SKU phải unique THEO GIAN HÀNG (PLAN-0014), nhưng migration
-- 20260915080000_catalog_product_init còn để lại `uq_product_variants_sku_active` = unique(sku) toàn sàn trên biến thể
-- sống → hai shop dùng cùng SKU vẫn bị 409. Đồng thời unique(shop_id, sku) do 20260929084707 thêm tính CẢ bản xoá mềm,
-- khiến vendor không dùng lại được SKU của biến thể đã xoá.
-- Thay cả hai bằng MỘT unique partial (shop_id, sku) WHERE is_deleted = false: shop A và B được trùng SKU, một shop thì
-- không; SKU của biến thể xoá mềm được dùng lại. Index partial không biểu diễn được trong Prisma schema nên
-- `@@unique([shopId, sku])` đã gỡ khỏi product.prisma (chốt chặn nằm ở đây, service kiểm trước để báo lỗi rõ).
-- An toàn dữ liệu: ràng buộc cũ (shop_id, sku) trên MỌI dòng đã đảm bảo không có cặp trùng, nên index partial mới (tập con)
-- không thể vi phạm — không cần dedupe.
-- =====================================================================

-- Unique(sku) toàn sàn — trái ý đồ "SKU unique theo shop".
DROP INDEX IF EXISTS "product"."uq_product_variants_sku_active";

-- Unique(shop_id, sku) tính cả xoá mềm. Tên có thể là product_variants_shop_id_sku_key (sau RENAME của
-- 20261003100000) hoặc uc_product_variants_shop_id_sku (DB chưa qua RENAME) — gỡ theo định nghĩa, không đoán tên.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'product.product_variants'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (shop_id, sku)'
  LOOP
    EXECUTE format('ALTER TABLE "product"."product_variants" DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
DROP INDEX IF EXISTS "product"."product_variants_shop_id_sku_key";
DROP INDEX IF EXISTS "product"."uc_product_variants_shop_id_sku";

-- Chốt cuối: SKU duy nhất trong phạm vi MỘT gian hàng, chỉ xét biến thể còn sống.
CREATE UNIQUE INDEX "uq_product_variants_shop_sku_active"
  ON "product"."product_variants" ("shop_id", "sku")
  WHERE "is_deleted" = false;
