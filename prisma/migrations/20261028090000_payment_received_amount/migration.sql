-- payment_received_amount (PLAN-0025 §2.1–2.4 / PLAN-0040 Tầng 1) — tiền khách THỰC TRẢ tách khỏi số phải trả; theo dõi tạo link và hỏi PayOS.
--  * received_amount: cộng dồn theo từng giao dịch PayOS đã nhận (thiếu/thừa/trùng). Backfill = amount cho payment đã thu.
--  * link_attempts / last_link_error: tạo link PayOS NGOÀI transaction đặt hàng; lỗi ⇒ payment vẫn `pending`, khách bấm thử lại.
--  * last_checked_at / last_gateway_status: job hỏi PayOS định kỳ (mất webhook).
--  * refunds.kind thêm 'mismatch' (hoàn phần tiền lệch / tiền nhận mà đơn không được thanh toán) — không đổi trạng thái thanh toán của đơn.
-- Chỉ thêm cột có DEFAULT/NULL và nới CHECK ⇒ chạy lại an toàn, code cũ vẫn chạy được.
ALTER TABLE "payment"."payments" ADD COLUMN IF NOT EXISTS "received_amount" numeric(14,0) NOT NULL DEFAULT 0;
ALTER TABLE "payment"."payments" ADD COLUMN IF NOT EXISTS "link_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "payment"."payments" ADD COLUMN IF NOT EXISTS "last_link_error" varchar(255);
ALTER TABLE "payment"."payments" ADD COLUMN IF NOT EXISTS "last_checked_at" timestamptz;
ALTER TABLE "payment"."payments" ADD COLUMN IF NOT EXISTS "last_gateway_status" varchar(30);

UPDATE "payment"."payments" SET "received_amount" = "amount" WHERE "status" IN ('paid', 'refunded', 'partially_refunded') AND "received_amount" = 0;

ALTER TABLE "payment"."refunds" DROP CONSTRAINT IF EXISTS "chk_refunds_kind";
ALTER TABLE "payment"."refunds" ADD CONSTRAINT "chk_refunds_kind" CHECK ("kind" IN ('order', 'duplicate_payment', 'mismatch'));

-- Job hỏi PayOS chỉ quét payment PayOS đang chờ: index một phần giữ truy vấn rẻ.
CREATE INDEX IF NOT EXISTS "ix_payments_pending_payos" ON "payment"."payments" ("expires_at") WHERE "status" = 'pending' AND "method_code" = 'payos';
