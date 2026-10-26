-- contact_shop_routing (PLAN-0021) — liên hệ của khách gửi tới SHOP (shop_id) hoặc SÀN (shop_id NULL); tin cũ coi là gửi sàn.
ALTER TABLE "system"."contact_messages" ADD COLUMN IF NOT EXISTS "shop_id" UUID, ADD COLUMN IF NOT EXISTS "order_code" VARCHAR(30), ADD COLUMN IF NOT EXISTS "product_name" VARCHAR(200);
CREATE INDEX IF NOT EXISTS "contact_messages_shop_id_status_created_at_idx" ON "system"."contact_messages"("shop_id", "status", "created_at" DESC);
