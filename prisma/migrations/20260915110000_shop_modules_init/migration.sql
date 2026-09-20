-- pgvector cho embedding (image pgvector/pgvector:pg16 đã có extension)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ai";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "cart";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "order";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "payment";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "promotion";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "reporting";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "review";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "system";

-- CreateTable
CREATE TABLE "ai"."product_embeddings" (
    "product_id" UUID NOT NULL,
    "product_slug" VARCHAR(160) NOT NULL,
    "embedding" vector(1536),
    "source_hash" VARCHAR(64) NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error" VARCHAR(500),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_embeddings_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "ai"."documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'policy',
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."document_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."chat_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "guest_key" VARCHAR(64),
    "title" VARCHAR(200),
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."chat_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "content" TEXT NOT NULL,
    "product_ids" JSONB NOT NULL DEFAULT '[]',
    "source" VARCHAR(10) NOT NULL DEFAULT 'rule',
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."support_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID,
    "user_id" UUID,
    "email" VARCHAR(255),
    "summary" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "assigned_to" UUID,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."usage_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "feature" VARCHAR(40) NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_estimate" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."try_on_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "guest_key" VARCHAR(64),
    "product_id" UUID NOT NULL,
    "product_name" VARCHAR(200) NOT NULL,
    "garment_image_url" VARCHAR(500) NOT NULL,
    "person_image_url" VARCHAR(500) NOT NULL,
    "person_public_id" VARCHAR(255),
    "category" VARCHAR(20) NOT NULL DEFAULT 'upper_body',
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "provider_job_id" VARCHAR(120),
    "result_url" VARCHAR(500),
    "result_public_id" VARCHAR(255),
    "error" VARCHAR(500),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "try_on_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."style_analyses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "guest_key" VARCHAR(64),
    "image_url" VARCHAR(500) NOT NULL,
    "image_public_id" VARCHAR(255),
    "result" JSONB NOT NULL,
    "product_ids" JSONB NOT NULL DEFAULT '[]',
    "source" VARCHAR(10) NOT NULL DEFAULT 'rule',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "style_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."review_summaries" (
    "product_id" UUID NOT NULL,
    "summary" VARCHAR(2000) NOT NULL,
    "pros" JSONB NOT NULL DEFAULT '[]',
    "cons" JSONB NOT NULL DEFAULT '[]',
    "review_count" INTEGER NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_summaries_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "ai"."moderation_flags" (
    "review_id" UUID NOT NULL,
    "label" VARCHAR(20) NOT NULL,
    "score" DECIMAL(4,3) NOT NULL,
    "reason" VARCHAR(500),
    "model" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_flags_pkey" PRIMARY KEY ("review_id")
);

-- CreateTable
CREATE TABLE "ai"."product_view_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "guest_key" VARCHAR(64),
    "product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_view_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."audit_logs" (
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
CREATE TABLE "ai"."processed_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "handler" VARCHAR(120) NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart"."carts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart"."cart_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cart_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart"."wishlists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(30) NOT NULL,
    "user_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "payment_method_code" VARCHAR(20) NOT NULL,
    "payment_status" VARCHAR(20) NOT NULL DEFAULT 'unpaid',
    "recipient_name" VARCHAR(120) NOT NULL,
    "recipient_phone" VARCHAR(20) NOT NULL,
    "province_code" VARCHAR(10),
    "province_name" VARCHAR(100) NOT NULL,
    "district_name" VARCHAR(100),
    "ward_name" VARCHAR(100),
    "street" VARCHAR(255) NOT NULL,
    "shipping_address" VARCHAR(500) NOT NULL,
    "customer_note" VARCHAR(500),
    "subtotal" DECIMAL(14,0) NOT NULL,
    "shipping_fee" DECIMAL(14,0) NOT NULL,
    "discount" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "promotion_code" VARCHAR(40),
    "promotion_name" VARCHAR(200),
    "total" DECIMAL(14,0) NOT NULL,
    "item_count" INTEGER NOT NULL,
    "cancel_reason" VARCHAR(255),
    "cancelled_by" UUID,
    "tracking_url" VARCHAR(500),
    "payment_expires_at" TIMESTAMPTZ,
    "confirmed_at" TIMESTAMPTZ,
    "packed_at" TIMESTAMPTZ,
    "shipped_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "image_url" VARCHAR(500),
    "color" VARCHAR(120) NOT NULL,
    "size" VARCHAR(40) NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,0) NOT NULL,
    "line_total" DECIMAL(14,0) NOT NULL,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."order_status_histories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20) NOT NULL,
    "note" VARCHAR(500),
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."return_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "order_code" VARCHAR(30) NOT NULL,
    "user_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "reason" VARCHAR(255) NOT NULL,
    "detail" VARCHAR(1000),
    "reject_reason" VARCHAR(500),
    "refund_amount" DECIMAL(14,0) NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "processed_by" UUID,
    "processed_at" TIMESTAMPTZ,
    "refunded_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."return_request_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "return_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "color" VARCHAR(120) NOT NULL,
    "size" VARCHAR(40) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "image_url" VARCHAR(500),
    "unit_price" DECIMAL(14,0) NOT NULL,

    CONSTRAINT "return_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."order_sequences" (
    "day" VARCHAR(6) NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_sequences_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "order"."audit_logs" (
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
CREATE TABLE "order"."outbox_events" (
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
CREATE TABLE "order"."processed_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "handler" VARCHAR(120) NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."idempotency_keys" (
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

-- CreateTable
CREATE TABLE "payment"."payment_methods" (
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(300),
    "kind" VARCHAR(20) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "payment"."payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "order_code" VARCHAR(30) NOT NULL,
    "user_id" UUID NOT NULL,
    "method_code" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "transaction_code" VARCHAR(64),
    "bank_code" VARCHAR(20),
    "card_brand" VARCHAR(20),
    "card_last4" VARCHAR(4),
    "transfer_content" VARCHAR(60),
    "refunded_amount" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "gateway_response" JSONB,
    "paid_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."payment_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(14,0),
    "provider_ref" VARCHAR(120),
    "raw_request" JSONB,
    "raw_response" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."bank_transfer_confirmations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "bank_ref" VARCHAR(120),
    "note" VARCHAR(500),
    "confirmed_by" UUID NOT NULL,
    "confirmed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transfer_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "order_code" VARCHAR(30) NOT NULL,
    "return_request_id" UUID,
    "amount" DECIMAL(14,0) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "method" VARCHAR(20) NOT NULL,
    "provider_ref" VARCHAR(120),
    "reason" VARCHAR(255),
    "note" VARCHAR(500),
    "requested_by" UUID,
    "processed_by" UUID,
    "processed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."audit_logs" (
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
CREATE TABLE "payment"."outbox_events" (
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
CREATE TABLE "payment"."processed_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "handler" VARCHAR(120) NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion"."promotions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "type" VARCHAR(20) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "max_discount" DECIMAL(14,0),
    "min_order_amount" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "usage_limit" INTEGER,
    "usage_limit_per_user" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "applies_to" VARCHAR(20) NOT NULL DEFAULT 'all',
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion"."promotion_targets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "promotion_id" UUID NOT NULL,
    "target_type" VARCHAR(20) NOT NULL,
    "target_ref" VARCHAR(160) NOT NULL,

    CONSTRAINT "promotion_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion"."promotion_usages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "promotion_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "order_code" VARCHAR(30) NOT NULL,
    "discount_amount" DECIMAL(14,0) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ,

    CONSTRAINT "promotion_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion"."audit_logs" (
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
CREATE TABLE "reporting"."daily_sales" (
    "day" VARCHAR(10) NOT NULL,
    "order_count" INTEGER NOT NULL DEFAULT 0,
    "paid_count" INTEGER NOT NULL DEFAULT 0,
    "cancelled_count" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "shipping_fee" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "items_sold" INTEGER NOT NULL DEFAULT 0,
    "new_customers" INTEGER NOT NULL DEFAULT 0,
    "refunded" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_sales_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "review"."reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "product_slug" VARCHAR(160) NOT NULL,
    "product_name" VARCHAR(200) NOT NULL,
    "user_id" UUID NOT NULL,
    "author_name" VARCHAR(120) NOT NULL,
    "avatar_url" VARCHAR(500),
    "order_code" VARCHAR(30),
    "order_item_id" UUID,
    "variant_label" VARCHAR(160),
    "rating" INTEGER NOT NULL,
    "content" VARCHAR(2000) NOT NULL,
    "media" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL DEFAULT 'approved',
    "moderation_note" VARCHAR(500),
    "moderated_by" UUID,
    "moderated_at" TIMESTAMPTZ,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review"."review_replies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "review_id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "staff_name" VARCHAR(120) NOT NULL,
    "content" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review"."audit_logs" (
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
CREATE TABLE "review"."outbox_events" (
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
CREATE TABLE "review"."processed_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "handler" VARCHAR(120) NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system"."settings" (
    "key" VARCHAR(80) NOT NULL,
    "value" JSONB NOT NULL,
    "group_code" VARCHAR(40) NOT NULL DEFAULT 'general',
    "description" VARCHAR(255),
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "system"."provinces" (
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "region" VARCHAR(20) NOT NULL,
    "shipping_fee" DECIMAL(14,0) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provinces_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "system"."banners" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(200) NOT NULL,
    "subtitle" VARCHAR(300),
    "image_url" VARCHAR(500) NOT NULL,
    "image_public_id" VARCHAR(255),
    "link_url" VARCHAR(500),
    "position" VARCHAR(20) NOT NULL DEFAULT 'hero',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMPTZ,
    "ends_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system"."notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "content" VARCHAR(1000),
    "link" VARCHAR(500),
    "payload" JSONB,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system"."contact_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20),
    "message" VARCHAR(2000) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'new',
    "reply" VARCHAR(2000),
    "handled_by" UUID,
    "handled_at" TIMESTAMPTZ,
    "ip_address" VARCHAR(45),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system"."faqs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "question" VARCHAR(300) NOT NULL,
    "answer" TEXT NOT NULL,
    "group_code" VARCHAR(40) NOT NULL DEFAULT 'general',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system"."pages" (
    "slug" VARCHAR(60) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "system"."audit_logs" (
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

-- CreateIndex
CREATE INDEX "product_embeddings_status_idx" ON "ai"."product_embeddings"("status");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_document_id_chunk_index_key" ON "ai"."document_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "chat_sessions_user_id_last_message_at_idx" ON "ai"."chat_sessions"("user_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "chat_sessions_guest_key_idx" ON "ai"."chat_sessions"("guest_key");

-- CreateIndex
CREATE INDEX "chat_messages_session_id_created_at_idx" ON "ai"."chat_messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "support_requests_status_created_at_idx" ON "ai"."support_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "usage_logs_created_at_idx" ON "ai"."usage_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "usage_logs_feature_created_at_idx" ON "ai"."usage_logs"("feature", "created_at" DESC);

-- CreateIndex
CREATE INDEX "try_on_jobs_status_created_at_idx" ON "ai"."try_on_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "try_on_jobs_user_id_created_at_idx" ON "ai"."try_on_jobs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "style_analyses_user_id_created_at_idx" ON "ai"."style_analyses"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "moderation_flags_label_idx" ON "ai"."moderation_flags"("label");

-- CreateIndex
CREATE INDEX "product_view_events_user_id_created_at_idx" ON "ai"."product_view_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "product_view_events_product_id_created_at_idx" ON "ai"."product_view_events"("product_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "ai"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "ai"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_event_id_handler_key" ON "ai"."processed_events"("event_id", "handler");

-- CreateIndex
CREATE UNIQUE INDEX "carts_user_id_key" ON "cart"."carts"("user_id");

-- CreateIndex
CREATE INDEX "cart_items_variant_id_idx" ON "cart"."cart_items"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_cart_id_variant_id_key" ON "cart"."cart_items"("cart_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "wishlists_user_id_product_id_key" ON "cart"."wishlists"("user_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_code_key" ON "order"."orders"("code");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "order"."orders"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "order"."orders"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_payment_status_payment_expires_at_idx" ON "order"."orders"("payment_status", "payment_expires_at");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order"."order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order"."order_items"("product_id");

-- CreateIndex
CREATE INDEX "order_status_histories_order_id_created_at_idx" ON "order"."order_status_histories"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "return_requests_user_id_created_at_idx" ON "order"."return_requests"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "return_requests_status_created_at_idx" ON "order"."return_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "return_request_items_return_id_order_item_id_key" ON "order"."return_request_items"("return_id", "order_item_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "order"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "order"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "order"."outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_event_id_handler_key" ON "order"."processed_events"("event_id", "handler");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "order"."idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_actor_key_idempotency_key_key" ON "order"."idempotency_keys"("scope", "actor_key", "idempotency_key");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payment"."payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_order_code_idx" ON "payment"."payments"("order_code");

-- CreateIndex
CREATE INDEX "payments_status_expires_at_idx" ON "payment"."payments"("status", "expires_at");

-- CreateIndex
CREATE INDEX "payment_transactions_payment_id_created_at_idx" ON "payment"."payment_transactions"("payment_id", "created_at");

-- CreateIndex
CREATE INDEX "refunds_status_created_at_idx" ON "payment"."refunds"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "payment"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "payment"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "payment"."outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_event_id_handler_key" ON "payment"."processed_events"("event_id", "handler");

-- CreateIndex
CREATE INDEX "promotions_is_active_starts_at_ends_at_idx" ON "promotion"."promotions"("is_active", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_promotion_id_target_type_target_ref_key" ON "promotion"."promotion_targets"("promotion_id", "target_type", "target_ref");

-- CreateIndex
CREATE INDEX "promotion_usages_user_id_promotion_id_idx" ON "promotion"."promotion_usages"("user_id", "promotion_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_usages_promotion_id_order_code_key" ON "promotion"."promotion_usages"("promotion_id", "order_code");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "promotion"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "promotion"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "reviews_product_id_status_created_at_idx" ON "review"."reviews"("product_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reviews_user_id_created_at_idx" ON "review"."reviews"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reviews_user_id_order_item_id_key" ON "review"."reviews"("user_id", "order_item_id");

-- CreateIndex
CREATE INDEX "review_replies_review_id_idx" ON "review"."review_replies"("review_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "review"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "review"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "review"."outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_event_id_handler_key" ON "review"."processed_events"("event_id", "handler");

-- CreateIndex
CREATE INDEX "settings_group_code_idx" ON "system"."settings"("group_code");

-- CreateIndex
CREATE INDEX "banners_position_is_active_sort_order_idx" ON "system"."banners"("position", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "system"."notifications"("user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contact_messages_status_created_at_idx" ON "system"."contact_messages"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "system"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "system"."audit_logs"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "ai"."document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ai"."documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."chat_messages" ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai"."chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart"."cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "cart"."carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order"."order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"."orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order"."order_status_histories" ADD CONSTRAINT "order_status_histories_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"."orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order"."return_requests" ADD CONSTRAINT "return_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"."orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order"."return_request_items" ADD CONSTRAINT "return_request_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "order"."return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment"."payment_transactions" ADD CONSTRAINT "payment_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"."payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment"."bank_transfer_confirmations" ADD CONSTRAINT "bank_transfer_confirmations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"."payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment"."refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"."payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion"."promotion_targets" ADD CONSTRAINT "promotion_targets_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotion"."promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion"."promotion_usages" ADD CONSTRAINT "promotion_usages_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotion"."promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review"."review_replies" ADD CONSTRAINT "review_replies_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "review"."reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== Sửa tay (Prisma không biểu diễn được) =====
-- Mã khuyến mãi duy nhất cho bản ghi sống (không phân biệt hoa thường)
CREATE UNIQUE INDEX "uq_promotions_code_active" ON "promotion"."promotions" (upper("code")) WHERE "is_deleted" = false;
-- IPN/return của cổng nhận trùng → unique chặn, không cộng tiền 2 lần
CREATE UNIQUE INDEX "uq_payment_transactions_provider_ref" ON "payment"."payment_transactions" ("type", "provider_ref") WHERE "provider_ref" IS NOT NULL;
-- Mỗi đơn tối đa một giao dịch thanh toán đang sống (pending/processing/paid)
CREATE UNIQUE INDEX "uq_payments_order_live" ON "payment"."payments" ("order_id") WHERE "status" IN ('pending', 'processing', 'paid');
-- Tiền không âm
ALTER TABLE "order"."orders" ADD CONSTRAINT "ck_orders_money_nonneg" CHECK ("subtotal" >= 0 AND "shipping_fee" >= 0 AND "discount" >= 0 AND "total" >= 0);
ALTER TABLE "promotion"."promotions" ADD CONSTRAINT "ck_promotions_used_le_limit" CHECK ("usage_limit" IS NULL OR "used_count" <= "usage_limit");
-- Điểm đánh giá 1..5
ALTER TABLE "review"."reviews" ADD CONSTRAINT "ck_reviews_rating" CHECK ("rating" BETWEEN 1 AND 5);
-- pgvector HNSW cosine cho gợi ý / RAG
CREATE INDEX "idx_product_embeddings_hnsw" ON "ai"."product_embeddings" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "idx_document_chunks_hnsw" ON "ai"."document_chunks" USING hnsw ("embedding" vector_cosine_ops);
