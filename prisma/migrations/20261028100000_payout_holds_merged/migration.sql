-- payout_holds_merged (PLAN-0026 §2.4 / PLAN-0040 Tầng 2) — kế toán/quản lý GIỮ TAY tiền chi trả của một shop (có lý do, mở giữ được) + trạng thái kỳ `merged`.
--  * payment.shop_payout_holds: mỗi shop tối đa MỘT lệnh giữ đang hiệu lực (unique một phần). Kỳ tạo cho shop có lệnh giữ ⇒ `held`; mở giữ ⇒ kỳ `held` về `pending`.
--  * shop_payouts.status thêm `merged`: kỳ `deferred` (dưới mức chi tối thiểu) đã được CỘNG vào kỳ sau — không còn là khoản chờ chi riêng.
-- Chỉ thêm bảng mới + nới CHECK ⇒ chạy lại an toàn, code cũ vẫn chạy được.
CREATE TABLE IF NOT EXISTS "payment"."shop_payout_holds" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL,
  "reason" varchar(255) NOT NULL,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "released_by" uuid,
  "released_at" timestamptz,
  CONSTRAINT "shop_payout_holds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shop_payout_holds_active" ON "payment"."shop_payout_holds" ("shop_id") WHERE "released_at" IS NULL;
CREATE INDEX IF NOT EXISTS "shop_payout_holds_shop_id_created_at_idx" ON "payment"."shop_payout_holds" ("shop_id", "created_at" DESC);

ALTER TABLE "payment"."shop_payouts" DROP CONSTRAINT IF EXISTS "chk_shop_payouts_status";
ALTER TABLE "payment"."shop_payouts" ADD CONSTRAINT "chk_shop_payouts_status"
  CHECK ("status" IN ('pending', 'awaiting_approval', 'processing', 'paid', 'failed', 'unknown', 'held', 'deferred', 'merged', 'carried', 'settled'));
