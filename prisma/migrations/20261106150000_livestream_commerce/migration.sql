-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "livestream";

-- AlterTable
ALTER TABLE "cart"."cart_items" ADD COLUMN     "source_lots" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "order"."order_items" ADD COLUMN     "discount_allocation" JSONB,
ADD COLUMN     "live_sources" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "promotion"."promotions" ADD COLUMN     "live_campaign_id" UUID;

-- CreateTable
CREATE TABLE "cart"."source_receipts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reference_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart"."mutations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "request_id" VARCHAR(100) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mutations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "host_user_id" UUID,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "cover_url" VARCHAR(1000),
    "state" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "mode" VARCHAR(20) NOT NULL DEFAULT 'public',
    "scheduled_at" TIMESTAMPTZ,
    "schedule_version" INTEGER NOT NULL DEFAULT 0,
    "provider_room_id" VARCHAR(160),
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "end_reason" VARCHAR(500),
    "reconnect_until" TIMESTAMPTZ,
    "start_deadline" TIMESTAMPTZ,
    "media_stop_status" VARCHAR(20) NOT NULL DEFAULT 'none',
    "pinned_product_id" UUID,
    "pinned_message_id" UUID,
    "next_sequence" INTEGER NOT NULL DEFAULT 0,
    "next_display_number" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "unique_viewers" INTEGER NOT NULL DEFAULT 0,
    "peak_viewers" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."session_products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "display_number" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "session_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_message_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "body" VARCHAR(300) NOT NULL,
    "reply_to_id" UUID,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."mutes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT true,
    "reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "mutes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."moderators" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "moderators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" VARCHAR(100) NOT NULL,
    "description" VARCHAR(2000),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "resolution_note" VARCHAR(2000),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."shop_restrictions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "restricted" BOOLEAN NOT NULL DEFAULT true,
    "reason" VARCHAR(500) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "shop_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."admissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "user_id" UUID,
    "guest_hash" VARCHAR(64),
    "participant_identity" VARCHAR(160) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ,

    CONSTRAINT "admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."source_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "eligible_until" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."media_inbox" (
    "id" VARCHAR(160) NOT NULL,
    "event" VARCHAR(80) NOT NULL,
    "room_id" VARCHAR(160) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "media_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livestream"."audit_logs" (
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
CREATE TABLE "livestream"."outbox_events" (
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
CREATE TABLE "livestream"."processed_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "handler" VARCHAR(120) NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."checkout_intents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "mode" VARCHAR(30) NOT NULL,
    "request_key" VARCHAR(100),
    "request_hash" VARCHAR(64),
    "state" VARCHAR(20) NOT NULL DEFAULT 'active',
    "lines" JSONB NOT NULL,
    "result_group_code" VARCHAR(30),
    "version" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "checkout_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."checkout_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "intent_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "request_key" VARCHAR(100) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "command" JSONB NOT NULL,
    "lease_until" TIMESTAMPTZ,
    "state" VARCHAR(20) NOT NULL DEFAULT 'processing',
    "group_code" VARCHAR(30),
    "error_code" VARCHAR(100),
    "message" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion"."live_campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "claim_limit" INTEGER NOT NULL DEFAULT 100,
    "claimed_count" INTEGER NOT NULL DEFAULT 0,
    "redeem_until" TIMESTAMPTZ,
    "policy_version" VARCHAR(40) NOT NULL DEFAULT 'FITLY_LIVE_V1',
    "reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "live_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion"."live_claims" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "state" VARCHAR(30) NOT NULL DEFAULT 'available',
    "active_use_id" UUID,
    "recovery_entitlement_id" UUID,
    "recovery_lines" JSONB,
    "restore_reason" VARCHAR(255),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion"."live_uses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "claim_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "promotion_usage_id" UUID NOT NULL,
    "order_code" VARCHAR(30) NOT NULL,
    "covered" JSONB NOT NULL,
    "discount" DECIMAL(14,0) NOT NULL,
    "policy_version" VARCHAR(40) NOT NULL DEFAULT 'FITLY_LIVE_V1',
    "state" VARCHAR(30) NOT NULL DEFAULT 'active',
    "restored_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_uses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion"."live_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "entity_id" UUID NOT NULL,
    "summary" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop"."shop_follows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "following" BOOLEAN NOT NULL DEFAULT true,
    "notify_live" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "shop_follows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_receipts_user_id_created_at_idx" ON "cart"."source_receipts"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "mutations_user_id_request_id_key" ON "cart"."mutations"("user_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_provider_room_id_key" ON "livestream"."sessions"("provider_room_id");

-- CreateIndex
CREATE INDEX "sessions_state_mode_scheduled_at_idx" ON "livestream"."sessions"("state", "mode", "scheduled_at");

-- CreateIndex
CREATE INDEX "sessions_shop_id_state_idx" ON "livestream"."sessions"("shop_id", "state");

-- CreateIndex
CREATE INDEX "session_products_session_id_removed_position_idx" ON "livestream"."session_products"("session_id", "removed", "position");

-- CreateIndex
CREATE UNIQUE INDEX "session_products_session_id_product_id_key" ON "livestream"."session_products"("session_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_products_session_id_display_number_key" ON "livestream"."session_products"("session_id", "display_number");

-- CreateIndex
CREATE UNIQUE INDEX "messages_session_id_user_id_client_message_id_key" ON "livestream"."messages"("session_id", "user_id", "client_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_session_id_sequence_key" ON "livestream"."messages"("session_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "mutes_session_id_user_id_key" ON "livestream"."mutes"("session_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "moderators_session_id_user_id_key" ON "livestream"."moderators"("session_id", "user_id");

-- CreateIndex
CREATE INDEX "reports_status_created_at_idx" ON "livestream"."reports"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shop_restrictions_shop_id_key" ON "livestream"."shop_restrictions"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_participant_identity_key" ON "livestream"."admissions"("participant_identity");

-- CreateIndex
CREATE INDEX "admissions_session_id_expires_at_idx" ON "livestream"."admissions"("session_id", "expires_at");

-- CreateIndex
CREATE INDEX "admissions_user_id_session_id_idx" ON "livestream"."admissions"("user_id", "session_id");

-- CreateIndex
CREATE INDEX "source_grants_user_id_eligible_until_idx" ON "livestream"."source_grants"("user_id", "eligible_until");

-- CreateIndex
CREATE INDEX "media_inbox_processed_at_created_at_idx" ON "livestream"."media_inbox"("processed_at", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "livestream"."audit_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "livestream"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "livestream"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "livestream"."outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_event_id_handler_key" ON "livestream"."processed_events"("event_id", "handler");

-- CreateIndex
CREATE INDEX "checkout_intents_user_id_created_at_idx" ON "order"."checkout_intents"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_intents_user_id_request_key_key" ON "order"."checkout_intents"("user_id", "request_key");

-- CreateIndex
CREATE INDEX "checkout_attempts_intent_id_created_at_idx" ON "order"."checkout_attempts"("intent_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_attempts_user_id_request_key_key" ON "order"."checkout_attempts"("user_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "live_campaigns_promotion_id_key" ON "promotion"."live_campaigns"("promotion_id");

-- CreateIndex
CREATE INDEX "live_campaigns_session_id_state_idx" ON "promotion"."live_campaigns"("session_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "live_claims_recovery_entitlement_id_key" ON "promotion"."live_claims"("recovery_entitlement_id");

-- CreateIndex
CREATE INDEX "live_claims_user_id_created_at_idx" ON "promotion"."live_claims"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "live_claims_campaign_id_user_id_key" ON "promotion"."live_claims"("campaign_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_uses_promotion_usage_id_key" ON "promotion"."live_uses"("promotion_usage_id");

-- CreateIndex
CREATE INDEX "live_uses_state_created_at_idx" ON "promotion"."live_uses"("state", "created_at");

-- CreateIndex
CREATE INDEX "live_audit_logs_entity_id_created_at_idx" ON "promotion"."live_audit_logs"("entity_id", "created_at");

-- CreateIndex
CREATE INDEX "shop_follows_shop_id_following_idx" ON "shop"."shop_follows"("shop_id", "following");

-- CreateIndex
CREATE UNIQUE INDEX "shop_follows_user_id_shop_id_key" ON "shop"."shop_follows"("user_id", "shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_live_campaign_id_key" ON "promotion"."promotions"("live_campaign_id");
