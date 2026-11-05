-- =====================================================================
-- return_roles_payment (PLAN-0022 — Đổi trả & hoàn tiền: đúng vai, đúng trách nhiệm; phần BE-Payment)
--   1. refunds.payee_*            : tài khoản ngân hàng NHẬN tiền hoàn do khách khai (bắt buộc với đơn COD; PayOS dùng tài khoản đã trả nếu có).
--   2. refunds.gateway_*          : lệnh chi PayOS — PayOS trả code "00" chỉ là ĐÃ NHẬN lệnh; refund chỉ `done` khi tra `getPayout` ra succeeded.
--                                   gateway_submitted_at != NULL ⇒ job đối soát tra kết quả (không nhả/chi lại); gateway_alerted_at ⇒ đã báo kế toán "treo bất thường" (1 lần).
--   3. refunds.needs_manual       : cột phi chuẩn hoá để màn kế toán lọc "chờ chuyển tay".
--   4. refunds.provider_ref DUY NHẤT (unique MỘT PHẦN, WHERE provider_ref IS NOT NULL) — mã giao dịch hoàn tay không được trùng.
--   5. shop_payout_lines.source_order_code : dòng trừ do hoàn tiền biết đơn nào (dòng cũ backfill theo khoá RF-…).
-- Mọi cột mới đều NULL hoặc có DEFAULT ⇒ an toàn deploy (không khoá bảng lâu, code cũ vẫn chạy).
-- =====================================================================

-- 1-3. Cột mới của refunds ------------------------------------------------------------------------------------------------------------
ALTER TABLE "payment"."refunds" ADD COLUMN "payee_bank_bin" VARCHAR(10);
ALTER TABLE "payment"."refunds" ADD COLUMN "payee_account_number" VARCHAR(34);
ALTER TABLE "payment"."refunds" ADD COLUMN "payee_account_name" VARCHAR(120);
ALTER TABLE "payment"."refunds" ADD COLUMN "payee_source" VARCHAR(12);
ALTER TABLE "payment"."refunds" ADD COLUMN "gateway_status" VARCHAR(16);
ALTER TABLE "payment"."refunds" ADD COLUMN "gateway_payout_id" VARCHAR(64);
ALTER TABLE "payment"."refunds" ADD COLUMN "gateway_attempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payment"."refunds" ADD COLUMN "gateway_submitted_at" TIMESTAMPTZ;
ALTER TABLE "payment"."refunds" ADD COLUMN "gateway_alerted_at" TIMESTAMPTZ;
ALTER TABLE "payment"."refunds" ADD COLUMN "needs_manual" BOOLEAN NOT NULL DEFAULT false;

-- Backfill needs_manual cho yêu cầu hoàn đang mở: hoàn tay (không qua cổng) hoặc qua cổng nhưng payment không có tài khoản đối ứng (webhook PayOS chưa mang counterAccount*).
UPDATE "payment"."refunds" r
SET "needs_manual" = true
WHERE r."status" IN ('requested', 'failed')
  AND (
    r."method" <> 'gateway'
    OR NOT EXISTS (
      SELECT 1
      FROM "payment"."payments" p
      WHERE p."id" = r."payment_id"
        AND COALESCE(p."gateway_response" ->> 'counterAccountNumber', '') <> ''
        AND COALESCE(p."gateway_response" ->> 'counterAccountBankId', '') <> ''
    )
  );

-- 4. provider_ref duy nhất ---------------------------------------------------------------------------------------------------------------
-- Gỡ trùng TRƯỚC khi tạo index (nếu có dữ liệu cũ trùng thì CREATE UNIQUE INDEX sẽ làm hỏng cả migration): giữ nguyên dòng cũ nhất của mỗi mã, các dòng sau đổi
-- thành "<mã gốc cắt 85 ký tự>#<id không gạch ngang 32 ký tự>" (≤ 118 ký tự, vừa VARCHAR(120), duy nhất vì chứa id) và ghi mã gốc vào note để người đối chiếu.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "provider_ref" ORDER BY "created_at", "id") AS rn
  FROM "payment"."refunds"
  WHERE "provider_ref" IS NOT NULL
)
UPDATE "payment"."refunds" r
SET "note" = LEFT(COALESCE(r."note" || ' | ', '') || 'Mã giao dịch gốc bị trùng: ' || r."provider_ref", 500),
    "provider_ref" = LEFT(r."provider_ref", 85) || '#' || REPLACE(r."id"::text, '-', '')
FROM ranked
WHERE r."id" = ranked."id" AND ranked.rn > 1;

CREATE UNIQUE INDEX "uq_refunds_provider_ref" ON "payment"."refunds" ("provider_ref") WHERE "provider_ref" IS NOT NULL;

-- 5. Dòng trừ kỳ chi trả có mã đơn --------------------------------------------------------------------------------------------------------
ALTER TABLE "payment"."shop_payout_lines" ADD COLUMN "source_order_code" VARCHAR(30);

-- Backfill dòng hoàn tiền cũ: order_code của dòng refund = 'RF-' + 26 ký tự hex đầu của id hoàn tiền (ShopPayoutService.refundLineKey) — khoá tất định nên khớp chính xác;
-- dòng nào không khớp (refund không còn) giữ NULL.
UPDATE "payment"."shop_payout_lines" l
SET "source_order_code" = r."order_code"
FROM "payment"."refunds" r
WHERE l."kind" = 'refund'
  AND l."source_order_code" IS NULL
  AND l."order_code" = 'RF-' || SUBSTRING(REPLACE(r."id"::text, '-', '') FROM 1 FOR 26);
