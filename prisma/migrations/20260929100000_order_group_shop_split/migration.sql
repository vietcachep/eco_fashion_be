-- =====================================================================
-- order_group_shop_split (PLAN-0014 bước 7). Tách đơn theo gian hàng:
--   - OrderGroup: đơn CHA (1 lần checkout), không có lifecycle riêng.
--   - Order (đã có từ trước) trở thành đơn CON theo shop: thêm shop_id, order_group_id,
--     commission_rate_snapshot.
--   - OrderItem: thêm shop_id (đồng bộ với Order.shopId của đơn cha nó).
-- Đơn cũ (single-shop, trước bước 7) được backfill thành OrderGroup 1-đơn — mọi Order từ nay
-- LUÔN thuộc đúng 1 OrderGroup (không có nhánh "đơn không nhóm"), FE/BE chỉ cần xử lý một hình dạng.
-- Toàn bộ sản phẩm hiện có đã nằm trong 1 shop mặc định (migration product_shop_id) nên backfill
-- shop_id cho orders/order_items ở đây chắc chắn resolve về đúng shop đó.
-- =====================================================================

-- Bước 1: bảng order_groups
CREATE TABLE "order"."order_groups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(30) NOT NULL,
  "user_id" UUID NOT NULL,
  "recipient_name" VARCHAR(120) NOT NULL,
  "recipient_phone" VARCHAR(20) NOT NULL,
  "shipping_address" VARCHAR(500) NOT NULL,
  "subtotal" DECIMAL(14,0) NOT NULL,
  "shipping_fee" DECIMAL(14,0) NOT NULL,
  "discount" DECIMAL(14,0) NOT NULL DEFAULT 0,
  "total" DECIMAL(14,0) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by" UUID,
  CONSTRAINT "order_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_groups_code_key" ON "order"."order_groups" ("code");
CREATE INDEX "idx_order_groups_user_id" ON "order"."order_groups" ("user_id", "created_at" DESC);

-- Bước 2: bảng order_group_sequences (bộ đếm mã theo ngày, tách riêng khỏi order_sequences)
CREATE TABLE "order"."order_group_sequences" (
  "day" VARCHAR(6) NOT NULL,
  "counter" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "order_group_sequences_pkey" PRIMARY KEY ("day")
);

-- Bước 3: orders.shop_id — thêm cột (nullable) → backfill qua order_items→products → NOT NULL → index
ALTER TABLE "order"."orders" ADD COLUMN "shop_id" UUID;

UPDATE "order"."orders" o
SET "shop_id" = COALESCE(
  (SELECT p."shop_id" FROM "order"."order_items" oi JOIN "product"."products" p ON p."id" = oi."product_id" WHERE oi."order_id" = o."id" LIMIT 1),
  '00000000-0000-0000-0000-000000000001'
)
WHERE "shop_id" IS NULL;

ALTER TABLE "order"."orders" ALTER COLUMN "shop_id" SET NOT NULL;
CREATE INDEX "idx_orders_shop_id" ON "order"."orders" ("shop_id", "created_at" DESC);

-- Bước 4: orders.order_group_id — mỗi Order hiện có (single-shop) được gói vào 1 OrderGroup riêng,
-- mã nhóm suy trực tiếp từ mã đơn cũ (đổi tiền tố "DH" → "DHN", giữ nguyên phần ngày+số thứ tự
-- nên chắc chắn duy nhất vì orders.code vốn đã unique).
ALTER TABLE "order"."orders" ADD COLUMN "order_group_id" UUID;

INSERT INTO "order"."order_groups" ("id", "code", "user_id", "recipient_name", "recipient_phone", "shipping_address", "subtotal", "shipping_fee", "discount", "total", "created_at", "created_by")
SELECT gen_random_uuid(), 'DHN' || substring(o."code" FROM 3), o."user_id", o."recipient_name", o."recipient_phone", o."shipping_address", o."subtotal", o."shipping_fee", o."discount", o."total", o."created_at", o."created_by"
FROM "order"."orders" o
WHERE o."order_group_id" IS NULL;

UPDATE "order"."orders" o
SET "order_group_id" = g."id"
FROM "order"."order_groups" g
WHERE g."code" = 'DHN' || substring(o."code" FROM 3) AND o."order_group_id" IS NULL;

ALTER TABLE "order"."orders" ALTER COLUMN "order_group_id" SET NOT NULL;
ALTER TABLE "order"."orders" ADD CONSTRAINT "orders_order_group_id_fkey" FOREIGN KEY ("order_group_id") REFERENCES "order"."order_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "idx_orders_order_group_id" ON "order"."orders" ("order_group_id");

-- Bước 5: orders.commission_rate_snapshot — đóng băng % hoa hồng của shop tại thời điểm đơn đã tồn tại
-- (đơn cũ trước khi có module shop) — lấy từ shop.shops.commission_rate hiện tại (mặc định 10.00 nếu
-- không tìm thấy shop, không nên xảy ra vì shop mặc định luôn tồn tại từ migration product_shop_id).
ALTER TABLE "order"."orders" ADD COLUMN "commission_rate_snapshot" DECIMAL(5,2);

UPDATE "order"."orders" o
SET "commission_rate_snapshot" = COALESCE(
  (SELECT s."commission_rate" FROM "shop"."shops" s WHERE s."id" = o."shop_id"),
  10.00
)
WHERE "commission_rate_snapshot" IS NULL;

ALTER TABLE "order"."orders" ALTER COLUMN "commission_rate_snapshot" SET NOT NULL;

-- Bước 6: order_items.shop_id — copy từ Order cha (đơn con chỉ chứa hàng của đúng 1 shop)
ALTER TABLE "order"."order_items" ADD COLUMN "shop_id" UUID;

UPDATE "order"."order_items" oi
SET "shop_id" = o."shop_id"
FROM "order"."orders" o
WHERE oi."order_id" = o."id" AND oi."shop_id" IS NULL;

ALTER TABLE "order"."order_items" ALTER COLUMN "shop_id" SET NOT NULL;
CREATE INDEX "idx_order_items_shop_id" ON "order"."order_items" ("shop_id");
