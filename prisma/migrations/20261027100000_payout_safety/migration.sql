-- payout_safety (PLAN-0026 / WP-02) — chi trả shop an toàn:
--   * Kỳ chi thêm trạng thái: awaiting_approval (vượt hạn mức tự chi), unknown (gửi lệnh mà không rõ kết quả — KHÔNG chi lại, KHÔNG đánh dấu tay),
--     held (shop bị khoá / giữ tiền), deferred (dưới mức chi tối thiểu, dồn kỳ sau).
--   * Cột kết quả cổng + lần gửi (khoá `<mã kỳ>-<n>` chỉ tăng sau khi PayOS TỪ CHỐI chắc chắn) + người duyệt + lý do giữ.
--   * `provider_ref` (mã lệnh chi PayOS / mã chuyển khoản tay) duy nhất toàn bảng (unique một phần) — một chứng từ không thể làm "đã chi" hai kỳ.
-- Chỉ thêm cột NULL/DEFAULT; không đổi dữ liệu cũ. Nếu dữ liệu cũ đã có provider_ref trùng thì tạo index sẽ lỗi — chạy truy vấn kiểm tra ở runbook trước khi deploy.

ALTER TABLE "payment"."shop_payouts"
  ADD COLUMN IF NOT EXISTS "gateway_status" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "gateway_attempted_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "gateway_attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "approved_by" UUID,
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "hold_reason" VARCHAR(255);

ALTER TABLE "payment"."shop_payouts" DROP CONSTRAINT IF EXISTS "chk_shop_payouts_status";
ALTER TABLE "payment"."shop_payouts" ADD CONSTRAINT "chk_shop_payouts_status"
  CHECK ("status" IN ('pending', 'awaiting_approval', 'processing', 'paid', 'failed', 'unknown', 'held', 'deferred', 'carried', 'settled'));

CREATE UNIQUE INDEX IF NOT EXISTS "uq_shop_payouts_provider_ref" ON "payment"."shop_payouts"("provider_ref") WHERE "provider_ref" IS NOT NULL;
