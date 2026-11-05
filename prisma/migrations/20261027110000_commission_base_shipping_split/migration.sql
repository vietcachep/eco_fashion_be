-- commission_base_shipping_split (PLAN-0030 / WP-06) — hoa hồng KHÔNG tính trên phí ship:
--   tách phần giảm giá rơi vào phí ship (voucher freeship) khỏi phần giảm trên tiền hàng.
--   Đơn cũ: voucher có type = 'free_shipping' ⇒ toàn bộ phần giảm của voucher đó là giảm phí ship; voucher loại khác ⇒ giảm trên tiền hàng (mặc định 0).
--   Không đủ dữ liệu (mã voucher đã xoá / đổi loại) ⇒ coi là giảm trên tiền hàng. Không hồi tố kỳ chi đã chạy (xem scripts/ops/cod-voucher-shortfall.ts nếu có).
ALTER TABLE "order"."orders"
  ADD COLUMN IF NOT EXISTS "shop_shipping_discount" DECIMAL(14,0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "platform_shipping_discount" DECIMAL(14,0) NOT NULL DEFAULT 0;

UPDATE "order"."orders" o SET "platform_shipping_discount" = LEAST(o."platform_discount", o."shipping_fee")
FROM "promotion"."promotions" p
WHERE p."code" = o."promotion_code" AND p."type" = 'free_shipping' AND o."platform_discount" > 0 AND o."platform_shipping_discount" = 0;

UPDATE "order"."orders" o SET "shop_shipping_discount" = LEAST(o."shop_discount", o."shipping_fee")
FROM "promotion"."promotions" p
WHERE p."code" = o."shop_promotion_code" AND p."type" = 'free_shipping' AND o."shop_discount" > 0 AND o."shop_shipping_discount" = 0;
