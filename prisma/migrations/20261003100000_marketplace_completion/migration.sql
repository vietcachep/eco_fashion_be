-- =====================================================================
-- marketplace_completion (PLAN-0017) — nền dữ liệu cho phần còn lại của sàn đa gian hàng:
--   - promotion.scope/shop_id : voucher sàn (platform) vs voucher gian hàng (shop) + CHECK nhất quán
--   - shop.bank_*             : tài khoản nhận tiền đối soát (payout) do vendor tự khai
--   - payment.refunds.shop_id : snapshot gian hàng của đơn bị hoàn (backfill từ orders)
--   - payment.shop_wallets / shop_wallet_transactions / shop_wallet_deposit_requests : ví quỹ COD (sổ cái append-only)
--   - payment.shop_payouts / shop_payout_lines : đối soát định kỳ, (order_code, kind) unique chống tính hai kỳ
--   - đổi tên các index cũ cho khớp quy ước Prisma (migration:check sạch)
-- Chỉ THÊM (additive) — không đụng dữ liệu hiện có ngoài backfill refunds.shop_id và tạo ví cho shop đã duyệt.
-- =====================================================================

-- AlterTable
ALTER TABLE "payment"."refunds" ADD COLUMN     "shop_id" UUID;

-- AlterTable
ALTER TABLE "promotion"."promotions" ADD COLUMN     "scope" VARCHAR(10) NOT NULL DEFAULT 'platform',
ADD COLUMN     "shop_id" UUID;

-- AlterTable
ALTER TABLE "shop"."shops" ADD COLUMN     "bank_account_name" VARCHAR(120),
ADD COLUMN     "bank_account_number" VARCHAR(30),
ADD COLUMN     "bank_code" VARCHAR(20);

-- CreateTable
CREATE TABLE "payment"."shop_wallets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "balance" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."shop_wallet_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "order_code" VARCHAR(30),
    "amount" DECIMAL(14,0) NOT NULL,
    "balance_after" DECIMAL(14,0) NOT NULL,
    "note" VARCHAR(500),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."shop_wallet_deposit_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "proof_url" VARCHAR(500),
    "note" VARCHAR(500),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decide_note" VARCHAR(500),
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_wallet_deposit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."shop_payouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(30) NOT NULL,
    "shop_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "gross_revenue" DECIMAL(14,0) NOT NULL,
    "commission" DECIMAL(14,0) NOT NULL,
    "refund_amount" DECIMAL(14,0) NOT NULL,
    "carried_debt" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "net_payout" DECIMAL(14,0) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "provider_ref" VARCHAR(120),
    "fail_reason" VARCHAR(500),
    "bank_snapshot" JSONB,
    "paid_at" TIMESTAMPTZ,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."shop_payout_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payout_id" UUID NOT NULL,
    "order_code" VARCHAR(30) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "gross" DECIMAL(14,0) NOT NULL,
    "commission" DECIMAL(14,0) NOT NULL,

    CONSTRAINT "shop_payout_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_wallets_shop_id_key" ON "payment"."shop_wallets"("shop_id");

-- CreateIndex
CREATE INDEX "shop_wallet_transactions_shop_id_created_at_idx" ON "payment"."shop_wallet_transactions"("shop_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "shop_wallet_transactions_shop_id_type_order_code_key" ON "payment"."shop_wallet_transactions"("shop_id", "type", "order_code");

-- CreateIndex
CREATE INDEX "shop_wallet_deposit_requests_shop_id_status_idx" ON "payment"."shop_wallet_deposit_requests"("shop_id", "status");

-- CreateIndex
CREATE INDEX "shop_wallet_deposit_requests_status_created_at_idx" ON "payment"."shop_wallet_deposit_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "shop_payouts_code_key" ON "payment"."shop_payouts"("code");

-- CreateIndex
CREATE INDEX "shop_payouts_status_created_at_idx" ON "payment"."shop_payouts"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "shop_payouts_shop_id_period_start_period_end_key" ON "payment"."shop_payouts"("shop_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "shop_payout_lines_payout_id_idx" ON "payment"."shop_payout_lines"("payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_payout_lines_order_code_kind_key" ON "payment"."shop_payout_lines"("order_code", "kind");

-- CreateIndex
CREATE INDEX "refunds_shop_id_idx" ON "payment"."refunds"("shop_id");

-- CreateIndex
CREATE INDEX "promotions_scope_shop_id_idx" ON "promotion"."promotions"("scope", "shop_id");

-- AddForeignKey
ALTER TABLE "payment"."shop_wallet_transactions" ADD CONSTRAINT "shop_wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "payment"."shop_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment"."shop_payout_lines" ADD CONSTRAINT "shop_payout_lines_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payment"."shop_payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "cart"."idx_cart_items_shop_id" RENAME TO "cart_items_shop_id_idx";

-- RenameIndex
ALTER INDEX "order"."idx_order_groups_user_id" RENAME TO "order_groups_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "order"."idx_order_items_shop_id" RENAME TO "order_items_shop_id_idx";

-- RenameIndex
ALTER INDEX "order"."idx_orders_order_group_id" RENAME TO "orders_order_group_id_idx";

-- RenameIndex
ALTER INDEX "order"."idx_orders_shop_id" RENAME TO "orders_shop_id_created_at_idx";

-- RenameIndex
ALTER INDEX "product"."idx_product_variants_shop_id" RENAME TO "product_variants_shop_id_idx";

-- RenameIndex
ALTER INDEX "product"."uc_product_variants_shop_id_sku" RENAME TO "product_variants_shop_id_sku_key";

-- RenameIndex
ALTER INDEX "product"."idx_products_shop_id" RENAME TO "products_shop_id_idx";

-- RenameIndex
ALTER INDEX "review"."idx_reviews_shop_id" RENAME TO "reviews_shop_id_idx";


-- ---------------------------------------------------------------------
-- Ràng buộc nghiệp vụ không biểu diễn được trong Prisma
-- ---------------------------------------------------------------------
-- voucher sàn không gắn shop; voucher shop bắt buộc gắn shop
ALTER TABLE "promotion"."promotions" ADD CONSTRAINT "chk_promotions_scope"
  CHECK (("scope" = 'platform' AND "shop_id" IS NULL) OR ("scope" = 'shop' AND "shop_id" IS NOT NULL));

ALTER TABLE "payment"."shop_payouts" ADD CONSTRAINT "chk_shop_payouts_status"
  CHECK ("status" IN ('pending', 'processing', 'paid', 'failed'));
ALTER TABLE "payment"."shop_wallet_deposit_requests" ADD CONSTRAINT "chk_shop_wallet_deposit_status"
  CHECK ("status" IN ('pending', 'approved', 'rejected') AND "amount" > 0);
ALTER TABLE "payment"."shop_wallet_transactions" ADD CONSTRAINT "chk_shop_wallet_tx_type"
  CHECK ("type" IN ('cod_commission', 'deposit', 'adjust'));
ALTER TABLE "payment"."shop_payout_lines" ADD CONSTRAINT "chk_shop_payout_lines_kind"
  CHECK ("kind" IN ('sale', 'refund'));

-- ---------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------
-- refunds.shop_id từ đơn gốc (đối soát payout cần biết shop)
UPDATE "payment"."refunds" r
SET "shop_id" = o."shop_id"
FROM "order"."orders" o
WHERE o."code" = r."order_code" AND r."shop_id" IS NULL;

-- mỗi gian hàng đã duyệt có sẵn một ví (số dư 0)
INSERT INTO "payment"."shop_wallets" ("shop_id")
SELECT s."id" FROM "shop"."shops" s
WHERE s."status" = 'approved' AND s."is_deleted" = false
ON CONFLICT ("shop_id") DO NOTHING;
