-- =====================================================================
-- multi_category_attributes (PLAN-0016). Sàn đa ngành hàng: thêm hệ thống thuộc tính động
-- (DynamicAttribute/CategoryAttribute) cho ngành hàng NGOÀI thời trang, KHÔNG đụng dữ liệu/hành vi
-- thời trang hiện có (Product.gender/material/care, ProductVariant.colorCode/colorName/sizeCode
-- giữ nguyên bắt buộc cho category.attribute_mode = 'legacy_fashion').
-- =====================================================================

-- Bước 1: category.attribute_mode — mặc định 'dynamic' cho category MỚI, backfill toàn bộ category
-- HIỆN CÓ thành 'legacy_fashion' (toàn bộ dữ liệu hiện tại là thời trang).
ALTER TABLE "catalog"."categories" ADD COLUMN "attribute_mode" VARCHAR(20) NOT NULL DEFAULT 'dynamic';
UPDATE "catalog"."categories" SET "attribute_mode" = 'legacy_fashion';

-- Bước 2: bảng thuộc tính động (KHÁC bảng attributes/attribute_values cũ — bảng cũ giữ nguyên cho thời trang)
CREATE TABLE "catalog"."dynamic_attributes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(60) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "input_type" VARCHAR(20) NOT NULL DEFAULT 'select',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "dynamic_attributes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dynamic_attributes_code_key" ON "catalog"."dynamic_attributes" ("code");

CREATE TABLE "catalog"."dynamic_attribute_values" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "attribute_id" UUID NOT NULL,
  "value" VARCHAR(100) NOT NULL,
  "extra" JSONB,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "dynamic_attribute_values_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dynamic_attribute_values_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "catalog"."dynamic_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "dynamic_attribute_values_attribute_id_value_key" ON "catalog"."dynamic_attribute_values" ("attribute_id", "value");

-- Bước 3: mẫu thuộc tính theo ngành hàng (category lá)
CREATE TABLE "catalog"."category_attributes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "category_id" UUID NOT NULL,
  "attribute_id" UUID NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "is_variant_axis" BOOLEAN NOT NULL DEFAULT false,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "category_attributes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "category_attributes_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "catalog"."categories"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "category_attributes_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "catalog"."dynamic_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "category_attributes_category_id_attribute_id_key" ON "catalog"."category_attributes" ("category_id", "attribute_id");

-- Bước 4: product_variants — colorCode/colorName/sizeCode thành NULLABLE (dữ liệu hiện có không đổi giá
-- trị, chỉ nới lỏng ràng buộc NOT NULL để category "dynamic" tạo variant không cần 2 field này).
ALTER TABLE "product"."product_variants" ALTER COLUMN "color_code" DROP NOT NULL;
ALTER TABLE "product"."product_variants" ALTER COLUMN "color_name" DROP NOT NULL;
ALTER TABLE "product"."product_variants" ALTER COLUMN "size_code" DROP NOT NULL;

-- Bước 5: thuộc tính cấp sản phẩm (không tạo biến thể) cho ngành hàng "dynamic"
CREATE TABLE "product"."product_attribute_values" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "product_id" UUID NOT NULL,
  "attribute_id" UUID NOT NULL,
  "attribute_value_id" UUID,
  "custom_value" VARCHAR(255),
  CONSTRAINT "product_attribute_values_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_attribute_values_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "product_attribute_values_product_id_attribute_id_key" ON "product"."product_attribute_values" ("product_id", "attribute_id");

-- Bước 6: trục biến thể (thay colorCode/sizeCode) cho ngành hàng "dynamic" — tối đa 2 dòng/variant (service validate)
CREATE TABLE "product"."product_variant_options" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "variant_id" UUID NOT NULL,
  "attribute_id" UUID NOT NULL,
  "attribute_value_id" UUID NOT NULL,
  "display_value" VARCHAR(100) NOT NULL,
  CONSTRAINT "product_variant_options_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_variant_options_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product"."product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "product_variant_options_variant_id_attribute_id_key" ON "product"."product_variant_options" ("variant_id", "attribute_id");
