-- delivery_proof (PLAN-0031 / PLAN-0040 Tầng 3.6–3.7) — giao hàng có bằng chứng & COD "chưa nhận hàng":
--  * order.orders: `carrier` + `tracking_code` (BẮT BUỘC từ API khi chuyển `shipping`; đơn cũ giữ NULL), `tracking_reused` (cùng mã vận đơn dùng cho đơn khác của shop — nghi gian lận, SHP-13),
--    `delivery_failed_at` / `delivery_failed_reason` / `goods_returned_at` (giao thất bại + "hàng đã về kho" — nhập kho đúng MỘT lần, SHP-09). Đơn đã huỷ vì giao thất bại TRƯỚC migration
--    này (chưa có delivery_failed_at) KHÔNG dùng được route "hàng đã về" — cố ý: không biết hàng đã nhập kho chưa.
--  * payment.payments: `reversed_at` — mốc ĐẢO ghi thu COD (khách báo chưa nhận hàng ⇒ khách chưa trả tiền mặt ⇒ payment về `cancelled`, KHÔNG hoàn tiền). COD-08b.
--  * payment.shop_cod_wallet_transactions: nới CHECK loại giao dịch thêm `cod_reversal` (dòng đảo ghi thu cod_commission của đơn; UNIQUE(shop, type, order_code) ⇒ đảo đúng một lần).
--  * return.not_received_days: mặc định mới 7 (PLAN-0031 §2.3) — chỉ đổi khi giá trị hiện tại vẫn là 3 cũ; đã chỉnh tay thì giữ.
-- Chỉ thêm cột NULL/DEFAULT + nới CHECK + index thường ⇒ chạy lại an toàn, code cũ vẫn chạy được.
ALTER TABLE "order"."orders"
  ADD COLUMN IF NOT EXISTS "carrier" varchar(20),
  ADD COLUMN IF NOT EXISTS "tracking_code" varchar(60),
  ADD COLUMN IF NOT EXISTS "tracking_reused" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "delivery_failed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "delivery_failed_reason" varchar(20),
  ADD COLUMN IF NOT EXISTS "goods_returned_at" timestamptz;

-- Tra "mã vận đơn này shop đã dùng cho đơn khác chưa" (SHP-13) không quét cả bảng đơn.
CREATE INDEX IF NOT EXISTS "orders_shop_id_tracking_code_idx" ON "order"."orders" ("shop_id", "tracking_code");

ALTER TABLE "payment"."payments" ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz;

ALTER TABLE "payment"."shop_cod_wallet_transactions" DROP CONSTRAINT IF EXISTS "chk_shop_cod_wallet_tx_type";
ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD CONSTRAINT "chk_shop_cod_wallet_tx_type"
  CHECK ("type" IN ('deposit', 'cod_commission', 'cod_refund', 'adjust', 'cod_reversal'));

UPDATE "system"."settings" SET "value" = '7'::jsonb, "updated_at" = now() WHERE "key" = 'return.not_received_days' AND "value" = '3'::jsonb;
