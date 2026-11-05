-- wallet_payos_topup (PLAN-0041) — nạp cọc COD qua PayOS:
--  * payment.shop_cod_topups          khoản nạp (link PayOS do chủ shop tạo); `received_amount` = tổng đã GHI CÓ vào ví cho khoản này.
--  * payment.shop_cod_topup_receipts  mỗi khoản tiền PayOS báo về qua webhook (khử trùng theo `reference`).
--  * payment.shop_cod_wallet_transactions: thêm cột topup_id + ref_key, loại dòng mới 'topup_payos' (+ CHECK), chỉ mục UNIQUE một phần theo ref_key.
-- Chỉ thêm bảng/cột/chỉ mục + nới CHECK ⇒ chạy lại an toàn. KHÔNG sửa migration cũ.

CREATE TABLE IF NOT EXISTS "payment"."shop_cod_topups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "payos_order_code" VARCHAR(20) NOT NULL,
    "payment_link_id" VARCHAR(64),
    "checkout_url" VARCHAR(500),
    "qr_code" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'creating',
    "received_amount" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "polled_amount" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "paid_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,
    "last_checked_at" TIMESTAMPTZ,
    "last_gateway_status" VARCHAR(30),
    "link_error" VARCHAR(255),
    "requested_by" UUID,
    "cancelled_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_cod_topups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_shop_cod_topups_status" CHECK ("status" IN ('creating', 'pending', 'partial', 'paid', 'expired', 'cancelled', 'failed')),
    CONSTRAINT "chk_shop_cod_topups_amounts" CHECK ("amount" > 0 AND "received_amount" >= 0 AND "polled_amount" >= 0),
    -- Dải mã riêng cho nạp cọc: 5e15..8,99e15 (mã đơn hàng ≈ 1,8e15) — mã nạp KHÔNG BAO GIỜ trùng/nhầm mã đơn hàng.
    CONSTRAINT "chk_shop_cod_topups_code" CHECK ("payos_order_code" ~ '^[5-8][0-9]{15}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "shop_cod_topups_payos_order_code_key" ON "payment"."shop_cod_topups" ("payos_order_code");
CREATE INDEX IF NOT EXISTS "shop_cod_topups_shop_id_created_at_idx" ON "payment"."shop_cod_topups" ("shop_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "shop_cod_topups_status_expires_at_idx" ON "payment"."shop_cod_topups" ("status", "expires_at");
-- Chốt cuối ở DB: mỗi shop tối đa MỘT khoản đang mở. (Prisma không biểu diễn được chỉ mục một phần — chỉ có trong SQL, giống uq_payments_order_live.)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shop_cod_topups_active_per_shop" ON "payment"."shop_cod_topups" ("shop_id") WHERE "status" IN ('creating', 'pending', 'partial');

CREATE TABLE IF NOT EXISTS "payment"."shop_cod_topup_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "topup_id" UUID NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_cod_topup_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_shop_cod_topup_receipts_amount" CHECK ("amount" > 0)
);

-- Khử trùng webhook theo TỪNG khoản tiền (mã giao dịch `reference` của PayOS) ở mức DB.
CREATE UNIQUE INDEX IF NOT EXISTS "shop_cod_topup_receipts_topup_id_reference_key" ON "payment"."shop_cod_topup_receipts" ("topup_id", "reference");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shop_cod_topup_receipts_topup_id_fkey') THEN
    ALTER TABLE "payment"."shop_cod_topup_receipts" ADD CONSTRAINT "shop_cod_topup_receipts_topup_id_fkey"
      FOREIGN KEY ("topup_id") REFERENCES "payment"."shop_cod_topups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Sổ cái ví: dòng sinh từ khoản nạp PayOS mang topup_id + ref_key (khoá idempotent mức DB).
ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD COLUMN IF NOT EXISTS "topup_id" UUID;
ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD COLUMN IF NOT EXISTS "ref_key" VARCHAR(120);
CREATE INDEX IF NOT EXISTS "shop_cod_wallet_transactions_topup_id_idx" ON "payment"."shop_cod_wallet_transactions" ("topup_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shop_cod_wallet_tx_ref_key" ON "payment"."shop_cod_wallet_transactions" ("ref_key") WHERE "ref_key" IS NOT NULL;

ALTER TABLE "payment"."shop_cod_wallet_transactions" DROP CONSTRAINT IF EXISTS "chk_shop_cod_wallet_tx_type";
ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD CONSTRAINT "chk_shop_cod_wallet_tx_type"
  CHECK ("type" IN ('deposit', 'cod_commission', 'cod_refund', 'adjust', 'cod_reversal', 'topup_payos'));
-- "Ví không bao giờ giảm vì luồng nạp": dòng topup_payos luôn DƯƠNG và luôn có khoá nguồn.
ALTER TABLE "payment"."shop_cod_wallet_transactions" DROP CONSTRAINT IF EXISTS "chk_shop_cod_wallet_tx_topup";
ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD CONSTRAINT "chk_shop_cod_wallet_tx_topup"
  CHECK ("type" <> 'topup_payos' OR ("topup_id" IS NOT NULL AND "ref_key" IS NOT NULL AND "amount" > 0));
