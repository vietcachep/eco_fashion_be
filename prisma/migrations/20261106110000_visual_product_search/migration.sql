CREATE TABLE "ai"."product_image_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "image_id" UUID NOT NULL,
    "source_url" VARCHAR(500) NOT NULL,
    "color_code" VARCHAR(40),
    "source_hash" VARCHAR(64) NOT NULL,
    "model_version" VARCHAR(160) NOT NULL,
    "embedding" vector(768),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error" VARCHAR(500),
    "retry_at" TIMESTAMPTZ,
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "product_image_embeddings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_image_embeddings_image_id_model_version_key" ON "ai"."product_image_embeddings"("image_id", "model_version");
CREATE INDEX "product_image_embeddings_model_version_status_product_id_idx" ON "ai"."product_image_embeddings"("model_version", "status", "product_id");
