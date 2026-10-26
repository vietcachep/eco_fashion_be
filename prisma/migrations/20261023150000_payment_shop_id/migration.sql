-- payment_shop_id (PLAN-0021) — gắn gian hàng vào giao dịch thanh toán để sàn lọc/giám sát theo shop.
ALTER TABLE "payment"."payments" ADD COLUMN IF NOT EXISTS "shop_id" UUID;
UPDATE "payment"."payments" p SET "shop_id" = o."shop_id" FROM "order"."orders" o WHERE o."id" = p."order_id" AND p."shop_id" IS NULL;
CREATE INDEX IF NOT EXISTS "payments_shop_id_created_at_idx" ON "payment"."payments"("shop_id", "created_at" DESC);
