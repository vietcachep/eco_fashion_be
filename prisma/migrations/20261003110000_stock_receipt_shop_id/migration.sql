-- stock_receipt_shop_id (PLAN-0017): phiếu nhập kho của vendor gắn shop_id (NULL = phiếu của sàn). Backfill: phiếu cũ toàn bộ thuộc FITLY Official.
-- AlterTable
ALTER TABLE "product"."stock_receipts" ADD COLUMN     "shop_id" UUID;

-- CreateIndex
CREATE INDEX "stock_receipts_shop_id_created_at_idx" ON "product"."stock_receipts"("shop_id", "created_at" DESC);


-- phiếu hiện có đều do sàn lập cho shop mặc định FITLY Official → gắn shop_id để vendor Official thấy đúng
UPDATE "product"."stock_receipts" SET "shop_id" = '00000000-0000-0000-0000-000000000001' WHERE "shop_id" IS NULL;
