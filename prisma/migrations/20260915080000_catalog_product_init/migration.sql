-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "catalog";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "product";

-- CreateTable
CREATE TABLE "catalog"."categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "image_url" VARCHAR(500),
    "image_public_id" VARCHAR(255),
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "product_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."collections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "tagline" VARCHAR(200),
    "image_url" VARCHAR(500),
    "image_public_id" VARCHAR(255),
    "query_category_slug" VARCHAR(120),
    "query_gender" VARCHAR(10),
    "query_tag" VARCHAR(40),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."attributes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'text',
    "is_filterable" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."attribute_values" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attribute_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "hex" VARCHAR(9),
    "group_code" VARCHAR(20),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "actor_email" VARCHAR(255),
    "action" VARCHAR(80) NOT NULL,
    "module_code" VARCHAR(40) NOT NULL,
    "entity_type" VARCHAR(80) NOT NULL,
    "entity_id" VARCHAR(64),
    "entity_code" VARCHAR(100),
    "request_id" VARCHAR(64),
    "idempotency_key" VARCHAR(128),
    "before_summary" JSONB,
    "after_summary" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" VARCHAR(80) NOT NULL,
    "event_version" VARCHAR(10) NOT NULL DEFAULT 'v1',
    "aggregate_type" VARCHAR(80) NOT NULL,
    "aggregate_id" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_message" TEXT,
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category_id" UUID NOT NULL,
    "category_slug" VARCHAR(120) NOT NULL,
    "gender" VARCHAR(10) NOT NULL DEFAULT 'unisex',
    "short_description" VARCHAR(500),
    "description" TEXT,
    "material" VARCHAR(200),
    "care" JSONB NOT NULL DEFAULT '[]',
    "base_price" DECIMAL(14,0) NOT NULL,
    "list_price" DECIMAL(14,0),
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "is_new" BOOLEAN NOT NULL DEFAULT false,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "sold_count" INTEGER NOT NULL DEFAULT 0,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "avg_rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMPTZ,
    "search_vector" tsvector,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."product_variants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "color_code" VARCHAR(40) NOT NULL,
    "color_name" VARCHAR(120) NOT NULL,
    "color_hex" VARCHAR(9),
    "size_code" VARCHAR(40) NOT NULL,
    "price" DECIMAL(14,0),
    "stock" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."product_images" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "public_id" VARCHAR(255),
    "color_code" VARCHAR(40),
    "alt" VARCHAR(200),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."stock_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(30) NOT NULL,
    "supplier_name" VARCHAR(200),
    "note" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "total_cost" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "posted_at" TIMESTAMPTZ,
    "posted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "stock_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."stock_receipt_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "receipt_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost" DECIMAL(14,0) NOT NULL DEFAULT 0,

    CONSTRAINT "stock_receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."stock_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "stock_after" INTEGER NOT NULL,
    "ref_type" VARCHAR(40),
    "ref_id" VARCHAR(64),
    "note" VARCHAR(255),
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "actor_email" VARCHAR(255),
    "action" VARCHAR(80) NOT NULL,
    "module_code" VARCHAR(40) NOT NULL,
    "entity_type" VARCHAR(80) NOT NULL,
    "entity_id" VARCHAR(64),
    "entity_code" VARCHAR(100),
    "request_id" VARCHAR(64),
    "idempotency_key" VARCHAR(128),
    "before_summary" JSONB,
    "after_summary" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" VARCHAR(80) NOT NULL,
    "event_version" VARCHAR(10) NOT NULL DEFAULT 'v1',
    "aggregate_type" VARCHAR(80) NOT NULL,
    "aggregate_id" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_message" TEXT,
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."processed_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "handler" VARCHAR(120) NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product"."idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" VARCHAR(60) NOT NULL,
    "actor_key" VARCHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "result_ref" VARCHAR(64),
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "catalog"."categories"("parent_id");

-- CreateIndex
CREATE INDEX "categories_is_active_sort_order_idx" ON "catalog"."categories"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "collections_is_active_sort_order_idx" ON "catalog"."collections"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "attributes_code_key" ON "catalog"."attributes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_values_attribute_id_code_key" ON "catalog"."attribute_values"("attribute_id", "code");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "catalog"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "catalog"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "catalog"."outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "product"."products"("category_id");

-- CreateIndex
CREATE INDEX "products_status_published_at_idx" ON "product"."products"("status", "published_at" DESC);

-- CreateIndex
CREATE INDEX "products_gender_idx" ON "product"."products"("gender");

-- CreateIndex
CREATE INDEX "product_variants_sku_idx" ON "product"."product_variants"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_product_id_color_code_size_code_key" ON "product"."product_variants"("product_id", "color_code", "size_code");

-- CreateIndex
CREATE INDEX "product_images_product_id_sort_order_idx" ON "product"."product_images"("product_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "stock_receipts_code_key" ON "product"."stock_receipts"("code");

-- CreateIndex
CREATE INDEX "stock_receipts_status_created_at_idx" ON "product"."stock_receipts"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "stock_receipt_items_receipt_id_variant_id_key" ON "product"."stock_receipt_items"("receipt_id", "variant_id");

-- CreateIndex
CREATE INDEX "stock_movements_variant_id_created_at_idx" ON "product"."stock_movements"("variant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_ref_type_ref_id_idx" ON "product"."stock_movements"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "product"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "product"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "product"."outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_event_id_handler_key" ON "product"."processed_events"("event_id", "handler");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "product"."idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_actor_key_idempotency_key_key" ON "product"."idempotency_keys"("scope", "actor_key", "idempotency_key");

-- AddForeignKey
ALTER TABLE "catalog"."categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "catalog"."categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog"."attribute_values" ADD CONSTRAINT "attribute_values_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "catalog"."attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product"."product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product"."product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product"."stock_receipt_items" ADD CONSTRAINT "stock_receipt_items_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "product"."stock_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== Sửa tay (Prisma không biểu diễn được) =====
-- Slug duy nhất cho bản ghi sống (xoá mềm rồi tạo lại slug cũ vẫn được)
CREATE UNIQUE INDEX "uq_categories_slug_active" ON "catalog"."categories" ("slug") WHERE "is_deleted" = false;
CREATE UNIQUE INDEX "uq_collections_slug_active" ON "catalog"."collections" ("slug") WHERE "is_deleted" = false;
CREATE UNIQUE INDEX "uq_products_slug_active" ON "product"."products" ("slug") WHERE "is_deleted" = false;
CREATE UNIQUE INDEX "uq_product_variants_sku_active" ON "product"."product_variants" ("sku") WHERE "is_deleted" = false;
-- Mỗi sản phẩm tối đa một ảnh chính
CREATE UNIQUE INDEX "uq_product_images_primary" ON "product"."product_images" ("product_id") WHERE "is_primary" = true;
-- Tồn kho không âm — chốt cuối dù code có lỗi
ALTER TABLE "product"."product_variants" ADD CONSTRAINT "ck_product_variants_stock_nonneg" CHECK ("stock" >= 0 AND "reserved" >= 0 AND "reserved" <= "stock");

-- unaccent() không IMMUTABLE nên không dùng trực tiếp trong index — bọc lại (kỹ thuật chuẩn của Postgres)
CREATE OR REPLACE FUNCTION public.f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

-- Tìm kiếm: tsvector (unaccent + simple, tên nặng hơn mô tả) do trigger duy trì + GIN; pg_trgm cho gõ sai trên tên
CREATE OR REPLACE FUNCTION "product".products_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(NEW.name, ''))), 'A') ||
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(NEW.category_slug, ''))), 'B') ||
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(NEW.short_description, ''))), 'C') ||
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(NEW.material, ''))), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_products_search_vector"
  BEFORE INSERT OR UPDATE OF name, category_slug, short_description, material ON "product"."products"
  FOR EACH ROW EXECUTE FUNCTION "product".products_search_vector_update();

CREATE INDEX "idx_products_search_vector" ON "product"."products" USING GIN ("search_vector");
CREATE INDEX "idx_products_name_trgm" ON "product"."products" USING GIN (public.f_unaccent(lower("name")) gin_trgm_ops);
