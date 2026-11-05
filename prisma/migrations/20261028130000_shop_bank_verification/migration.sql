-- shop_bank_verification (PLAN-0026 §2.5 / PLAN-0040 Tầng 5.2) — xác minh tài khoản ngân hàng nhận tiền của shop khi tên chủ TK lệch tên chủ shop.
--  * shop.shops.bank_status: `verified` (mặc định — tên khớp tên chủ shop, hoặc quản lý sàn đã xác minh) | `pending_verification` (tên lệch: kỳ chi của shop vào `held` cho tới khi quản lý xác minh).
--  * shop.shops.bank_verified_at: lúc quản lý sàn xác minh tay; NULL = chưa xác minh tay. Từ mốc này mới đếm `payout.bank_change_hold_hours` (không đếm từ lúc đổi TK).
-- Shop có sẵn trước migration giữ `verified` (không tính lại hồi tố) — việc so khớp tên chỉ áp từ lần đổi TK kế tiếp.
-- Chỉ thêm cột NOT NULL có DEFAULT + cột NULL + CHECK ⇒ chạy lại an toàn, code cũ vẫn chạy được.
ALTER TABLE "shop"."shops" ADD COLUMN IF NOT EXISTS "bank_status" VARCHAR(20) NOT NULL DEFAULT 'verified';
ALTER TABLE "shop"."shops" ADD COLUMN IF NOT EXISTS "bank_verified_at" TIMESTAMPTZ;

ALTER TABLE "shop"."shops" DROP CONSTRAINT IF EXISTS "chk_shops_bank_status";
ALTER TABLE "shop"."shops" ADD CONSTRAINT "chk_shops_bank_status" CHECK ("bank_status" IN ('verified', 'pending_verification'));
