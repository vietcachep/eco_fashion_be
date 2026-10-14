-- =====================================================================
-- order_voucher_split (PLAN-0017) — đơn con có thể mang HAI voucher: 1 voucher sàn + 1 voucher gian hàng.
--   shop_discount / platform_discount : tách số giảm theo bên chịu chi phí (discount = tổng hai phần)
--   shop_promotion_code / _name       : voucher gian hàng (promotion_code/_name giữ nguyên cho voucher SÀN)
-- Backfill: đơn cũ có promotion_code là voucher sàn duy nhất (trước đây chưa có voucher shop) ⇒ platform_discount = discount.
-- Chỉ THÊM cột — không xoá/đổi cột cũ.
-- =====================================================================

-- AlterTable
ALTER TABLE "order"."orders" ADD COLUMN     "platform_discount" DECIMAL(14,0) NOT NULL DEFAULT 0,
ADD COLUMN     "shop_discount" DECIMAL(14,0) NOT NULL DEFAULT 0,
ADD COLUMN     "shop_promotion_code" VARCHAR(40),
ADD COLUMN     "shop_promotion_name" VARCHAR(200);

-- Backfill
UPDATE "order"."orders" SET "platform_discount" = "discount" WHERE "promotion_code" IS NOT NULL AND "discount" > 0;
