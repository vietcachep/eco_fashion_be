-- =====================================================================
-- shop_init (PLAN-0014 bước 1). Phần Prisma không tả được SỬA TAY ở cuối file: CHECK cho các cột kiểu
-- "enum bằng string" (status) — AGENTS.md § Migration / Schema Rule.
-- =====================================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "shop";

-- CreateTable
CREATE TABLE "shop"."shops" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(20) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "logo_url" VARCHAR(500),
    "banner_url" VARCHAR(500),
    "description" VARCHAR(2000),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "commission_rate" DECIMAL(5,2) NOT NULL DEFAULT 10.00,
    "cod_enabled" BOOLEAN NOT NULL DEFAULT true,
    "rating_avg" DECIMAL(3,2),
    "total_products" INTEGER NOT NULL DEFAULT 0,
    "owner_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop"."shop_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "shop_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop"."audit_logs" (
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
CREATE TABLE "shop"."outbox_events" (
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
CREATE TABLE "shop"."processed_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "handler" VARCHAR(120) NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_code_key" ON "shop"."shops"("code");

-- CreateIndex
CREATE UNIQUE INDEX "shops_slug_key" ON "shop"."shops"("slug");

-- CreateIndex
CREATE INDEX "shops_status_idx" ON "shop"."shops"("status");

-- CreateIndex
CREATE INDEX "shops_owner_user_id_idx" ON "shop"."shops"("owner_user_id");

-- CreateIndex
CREATE INDEX "shop_members_user_id_status_idx" ON "shop"."shop_members"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shop_members_shop_id_user_id_key" ON "shop"."shop_members"("shop_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "shop"."audit_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "shop"."audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "shop"."audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "shop"."outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_event_id_handler_key" ON "shop"."processed_events"("event_id", "handler");

-- AddForeignKey
ALTER TABLE "shop"."shop_members" ADD CONSTRAINT "shop_members_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"."shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sửa tay: giá trị hợp lệ của các cột "enum bằng string" (SHOP_STATUS/SHOP_MEMBER_STATUS ở foundation/shop.constants.ts)
ALTER TABLE "shop"."shops" ADD CONSTRAINT "ck_shops_status"
  CHECK ("status" IN ('pending', 'approved', 'suspended', 'rejected'));

ALTER TABLE "shop"."shop_members" ADD CONSTRAINT "ck_shop_members_status"
  CHECK ("status" IN ('active', 'removed'));

-- Hoa hồng phải trong khoảng 0–100%; tồn/đánh giá không âm.
ALTER TABLE "shop"."shops" ADD CONSTRAINT "ck_shops_commission_rate"
  CHECK ("commission_rate" >= 0 AND "commission_rate" <= 100);

ALTER TABLE "shop"."shops" ADD CONSTRAINT "ck_shops_total_products"
  CHECK ("total_products" >= 0);
