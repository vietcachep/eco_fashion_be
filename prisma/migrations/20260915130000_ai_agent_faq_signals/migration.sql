-- AlterTable
ALTER TABLE "ai"."chat_messages" ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "ai"."product_view_events" ADD COLUMN     "event_type" VARCHAR(15) NOT NULL DEFAULT 'view',
ADD COLUMN     "source" VARCHAR(30);

-- CreateTable
CREATE TABLE "ai"."product_faqs" (
    "product_id" UUID NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "source_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "model" VARCHAR(80),
    "error" VARCHAR(500),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_faqs_pkey" PRIMARY KEY ("product_id")
);

-- CreateIndex
CREATE INDEX "product_faqs_status_idx" ON "ai"."product_faqs"("status");

-- CreateIndex
CREATE INDEX "product_view_events_event_type_created_at_idx" ON "ai"."product_view_events"("event_type", "created_at" DESC);


-- Sửa tay: loại sự kiện hợp lệ (view/thêm giỏ = tín hiệu sở thích; click/impression = đo hiệu quả dải gợi ý)
ALTER TABLE "ai"."product_view_events" ADD CONSTRAINT "ck_product_view_events_type"
  CHECK ("event_type" IN ('view', 'add_to_cart', 'click', 'impression'));
