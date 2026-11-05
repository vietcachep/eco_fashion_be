-- PLAN-0043: schema shipping và snapshot tuyến giao/thu, không đổi nghĩa đơn cũ.


-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "shipping";

-- CreateTable
CREATE TABLE "shipping"."shipping_quotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "user_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "environment" VARCHAR(30) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "shipping_fee" DECIMAL(14,0) NOT NULL,
    "fee_source" VARCHAR(20) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "shipping_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping"."shipments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "order_id" UUID NOT NULL,
    "order_code" VARCHAR(30) NOT NULL,
    "shop_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "environment" VARCHAR(30) NOT NULL,
    "account_scope" VARCHAR(50) NOT NULL,
    "client_order_code" VARCHAR(50) NOT NULL,
    "carrier_order_code" VARCHAR(60),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "create_status" VARCHAR(20) NOT NULL DEFAULT 'creating',
    "cancel_status" VARCHAR(20) NOT NULL DEFAULT 'none',
    "status" VARCHAR(30),
    "raw_status" VARCHAR(50),
    "snapshot" JSONB NOT NULL,
    "quoted_fee" DECIMAL(14,0) NOT NULL,
    "actual_fee" DECIMAL(14,0),
    "cod_amount" DECIMAL(14,0) NOT NULL,
    "expected_delivery_at" TIMESTAMPTZ,
    "picked_up_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "last_event_at" TIMESTAMPTZ,
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "tracking_url" VARCHAR(500),
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ,
    "retry_at" TIMESTAMPTZ,
    "last_error" VARCHAR(1000),

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping"."shipment_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "dedup_key" VARCHAR(64) NOT NULL,
    "shipment_id" UUID,
    "provider" VARCHAR(20) NOT NULL,
    "environment" VARCHAR(30) NOT NULL,
    "carrier_order_code" VARCHAR(60),
    "client_order_code" VARCHAR(50),
    "raw_status" VARCHAR(50) NOT NULL,
    "event_time" TIMESTAMPTZ NOT NULL,
    "payload" JSONB NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "retry_at" TIMESTAMPTZ,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "processed_at" TIMESTAMPTZ,
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping"."fake_carrier_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "client_order_code" VARCHAR(50) NOT NULL,
    "carrier_order_code" VARCHAR(60) NOT NULL,
    "raw_status" VARCHAR(50) NOT NULL DEFAULT 'ready_to_pick',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "fee" DECIMAL(14,0) NOT NULL,
    "cod_amount" DECIMAL(14,0) NOT NULL,
    "event_time" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "fake_carrier_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipping_quotes_user_id_expires_at_idx" ON "shipping"."shipping_quotes"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "shipments_active_retry_at_idx" ON "shipping"."shipments"("active", "retry_at");

-- CreateIndex
CREATE INDEX "shipments_shop_id_created_at_idx" ON "shipping"."shipments"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "shipments_order_code_idx" ON "shipping"."shipments"("order_code");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_order_id_attempt_no_key" ON "shipping"."shipments"("order_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_provider_environment_account_scope_client_order_c_key" ON "shipping"."shipments"("provider", "environment", "account_scope", "client_order_code");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_provider_environment_account_scope_carrier_order__key" ON "shipping"."shipments"("provider", "environment", "account_scope", "carrier_order_code");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_events_dedup_key_key" ON "shipping"."shipment_events"("dedup_key");

-- CreateIndex
CREATE INDEX "shipment_events_status_retry_at_idx" ON "shipping"."shipment_events"("status", "retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "fake_carrier_states_client_order_code_key" ON "shipping"."fake_carrier_states"("client_order_code");

-- CreateIndex
CREATE UNIQUE INDEX "fake_carrier_states_carrier_order_code_key" ON "shipping"."fake_carrier_states"("carrier_order_code");

-- AddForeignKey
ALTER TABLE "shipping"."shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipping"."shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order"."orders" ADD COLUMN "fulfilment_mode" VARCHAR(20) NOT NULL DEFAULT 'self', ADD COLUMN "collection_mode" VARCHAR(30), ADD COLUMN "shipping_provider" VARCHAR(20), ADD COLUMN "shipping_environment" VARCHAR(30), ADD COLUMN "shipping_quote_id" UUID, ADD COLUMN "shipping_snapshot" JSONB;
ALTER TABLE "payment"."payments" ADD COLUMN "collection_mode" VARCHAR(30), ADD COLUMN "cod_collected_at" TIMESTAMPTZ, ADD COLUMN "cod_remitted_at" TIMESTAMPTZ, ADD COLUMN "cod_remitted_by" UUID, ADD COLUMN "cod_remittance_ref" VARCHAR(100), ADD COLUMN "cod_remitted_amount" DECIMAL(14,0);
CREATE UNIQUE INDEX "payments_cod_remittance_ref_key" ON "payment"."payments"("cod_remittance_ref");
ALTER TABLE "shop"."shops" ADD COLUMN "shipping_carrier_enabled" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "shipping_pickup" JSONB, ADD COLUMN "shipping_return" JSONB;
ALTER TABLE "identity"."addresses" ADD COLUMN "address_system" VARCHAR(30) NOT NULL DEFAULT 'legacy_3level', ADD COLUMN "ghn_province_id" INTEGER, ADD COLUMN "ghn_district_id" INTEGER, ADD COLUMN "ghn_ward_code" VARCHAR(20);
ALTER TABLE "product"."product_variants" ADD COLUMN "weight_gram" INTEGER, ADD COLUMN "length_cm" INTEGER, ADD COLUMN "width_cm" INTEGER, ADD COLUMN "height_cm" INTEGER;
CREATE UNIQUE INDEX "uq_shipments_one_active_order" ON "shipping"."shipments"("order_id") WHERE "active" = true AND "is_deleted" = false;
ALTER TABLE "shipping"."shipments" ADD CONSTRAINT "chk_shipping_attempt_positive" CHECK ("attempt_no" > 0), ADD CONSTRAINT "chk_shipping_money_nonnegative" CHECK ("quoted_fee" >= 0 AND "cod_amount" >= 0 AND ("actual_fee" IS NULL OR "actual_fee" >= 0));