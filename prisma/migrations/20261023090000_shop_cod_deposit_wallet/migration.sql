-- =====================================================================
-- shop_cod_deposit_wallet (PLAN-0020) — ví đặt cọc COD của gian hàng (chủ dự án đổi lại luật COD của PLAN-0018):
--   * Shop CHỈ được bán COD khi đã nộp tiền đặt cọc cho sàn (ví balance > 0); mỗi đơn COD giao thành công, sàn tự trừ hoa hồng của đơn khỏi ví;
--     về 0 hoặc âm ⇒ khoá COD cho đơn mới; số âm được bù bằng khoản nộp thêm kế tiếp.
--   * Thêm payment.shop_cod_wallets / shop_cod_wallet_transactions (sổ cái chỉ thêm) / shop_cod_deposits (yêu cầu nộp cọc chờ kế toán duyệt).
--   * Bật lại 4 mã quyền ví (shop.wallet.read, shop.wallet.deposit_request, supplier.wallet.read, supplier.wallet.adjust) mà PLAN-0018 đã tắt.
-- KHÔNG sửa migration cũ. Idempotent ở phần dữ liệu.
-- =====================================================================

CREATE TABLE "payment"."shop_cod_wallets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "balance" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_cod_wallets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment"."shop_cod_wallet_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "balance_after" DECIMAL(14,0) NOT NULL,
    "order_code" VARCHAR(30),
    "deposit_id" UUID,
    "note" VARCHAR(500),
    "meta" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_cod_wallet_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment"."shop_cod_deposits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "transfer_ref" VARCHAR(120) NOT NULL,
    "note" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "reject_reason" VARCHAR(500),
    "requested_by" UUID,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_cod_deposits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_cod_wallets_shop_id_key" ON "payment"."shop_cod_wallets"("shop_id");
CREATE UNIQUE INDEX "shop_cod_wallet_transactions_shop_id_type_order_code_key" ON "payment"."shop_cod_wallet_transactions"("shop_id", "type", "order_code");
CREATE INDEX "shop_cod_wallet_transactions_shop_id_created_at_idx" ON "payment"."shop_cod_wallet_transactions"("shop_id", "created_at" DESC);
CREATE INDEX "shop_cod_deposits_shop_id_created_at_idx" ON "payment"."shop_cod_deposits"("shop_id", "created_at" DESC);
CREATE INDEX "shop_cod_deposits_status_created_at_idx" ON "payment"."shop_cod_deposits"("status", "created_at" DESC);

ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD CONSTRAINT "shop_cod_wallet_transactions_wallet_id_fkey"
  FOREIGN KEY ("wallet_id") REFERENCES "payment"."shop_cod_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD CONSTRAINT "chk_shop_cod_wallet_tx_type"
  CHECK ("type" IN ('deposit', 'cod_commission', 'cod_refund', 'adjust'));
ALTER TABLE "payment"."shop_cod_deposits" ADD CONSTRAINT "chk_shop_cod_deposit_status"
  CHECK ("status" IN ('pending', 'approved', 'rejected'));
ALTER TABLE "payment"."shop_cod_deposits" ADD CONSTRAINT "chk_shop_cod_deposit_amount" CHECK ("amount" > 0);

-- Ví cho mọi shop hiện có (số dư 0 ⇒ COD đóng cho tới khi shop nộp cọc).
INSERT INTO "payment"."shop_cod_wallets" ("shop_id")
SELECT "id" FROM "shop"."shops"
ON CONFLICT ("shop_id") DO NOTHING;

-- Bật lại mã quyền ví (PLAN-0018 đã tắt); sync-permissions cũng tự bật theo catalog.
UPDATE "identity"."permissions" SET "is_active" = true, "updated_at" = CURRENT_TIMESTAMP
WHERE "code" IN ('shop.wallet.read', 'shop.wallet.deposit_request', 'supplier.wallet.read', 'supplier.wallet.adjust') AND "is_active" = false;
