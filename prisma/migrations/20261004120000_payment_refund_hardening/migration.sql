-- =====================================================================
-- payment_refund_hardening (PLAN-0017 — gia cố đường tiền trước khi chạy khoá thật)
--   1. refunds.kind: phân biệt hoàn THEO ĐƠN ('order') với hoàn khoản khách trả TRÙNG ('duplicate_payment'). Hoàn khoản trùng chỉ trả tiền
--      thừa cho khách — KHÔNG được đặt orders.payment_status = 'refunded' khi đơn vẫn còn khoản thanh toán hợp lệ khác đã 'paid'.
--   2. refunds.gateway_attempted_at: dấu ghi TRƯỚC khi gọi cổng không có idempotency-key (VNPay). Còn dấu mà chưa có provider_ref ⇒ chưa rõ cổng
--      đã hoàn hay chưa ⇒ không tự gọi lại cổng (tránh hoàn đôi), người xử lý phải đối chiếu.
-- =====================================================================
ALTER TABLE "payment"."refunds" ADD COLUMN "kind" VARCHAR(20) NOT NULL DEFAULT 'order';
ALTER TABLE "payment"."refunds" ADD COLUMN "gateway_attempted_at" TIMESTAMPTZ;

ALTER TABLE "payment"."refunds" ADD CONSTRAINT "chk_refunds_kind" CHECK ("kind" IN ('order', 'duplicate_payment'));

-- Backfill: yêu cầu hoàn khoản trùng đã tạo trước migration này (lý do do PaymentService.refundDuplicate ghi, luôn mở đầu bằng "Thanh toán trùng").
UPDATE "payment"."refunds" SET "kind" = 'duplicate_payment' WHERE "reason" LIKE 'Thanh toán trùng%';
