-- =====================================================================
-- payment_platform_collects_all (PLAN-0018) — sàn thu MỌI khoản tiền (PayOS + COD), tự động đối soát/chi trả shop.
--   * Bỏ ví quỹ COD: DROP 3 bảng payment.shop_wallets / shop_wallet_transactions / shop_wallet_deposit_requests
--     (kèm index/CHECK/FK của chúng) + cột shop.shops.cod_enabled. Dữ liệu ví (sổ cái hoa hồng COD, yêu cầu nộp quỹ) MẤT theo bảng; dòng audit
--     WALLET_* trong payment.audit_logs và sự kiện outbox cũ vẫn được giữ làm lịch sử.
--   * Chỉ còn cod + payos: TẮT (không xoá) phương thức vnpay + bank_transfer trong payment.payment_methods — payment/refund lịch sử mang
--     method_code cũ vẫn đọc được; bảng bank_transfer_confirmations giữ nguyên làm dữ liệu lịch sử.
--   * Mã quyền ví (shop.wallet.*, supplier.wallet.*) bị bỏ khỏi catalog ⇒ đánh is_active=false ở DB (không xoá — gán vai cũ còn nguyên làm lịch sử).
--   * Thêm tham số payout.auto_enabled (mặc định true — cron chi trả tự động 02:00 Asia/Ho_Chi_Minh); bỏ tham số order.bank_transfer_timeout_hours.
-- Idempotent ở phần dữ liệu (ON CONFLICT / IF EXISTS); KHÔNG sửa migration cũ.
-- =====================================================================

-- 1. Ví quỹ COD: bảng con trước (FK wallet_id → shop_wallets), rồi ví, rồi yêu cầu nộp quỹ.
DROP TABLE IF EXISTS "payment"."shop_wallet_transactions";
DROP TABLE IF EXISTS "payment"."shop_wallet_deposit_requests";
DROP TABLE IF EXISTS "payment"."shop_wallets";

-- 2. Cờ COD theo shop không còn ý nghĩa (sàn thu COD; chặn shop vi phạm bằng tạm khoá shop).
ALTER TABLE "shop"."shops" DROP COLUMN IF EXISTS "cod_enabled";

-- 3. Phương thức thanh toán: chỉ còn cod + payos.
UPDATE "payment"."payment_methods" SET "is_active" = false, "updated_at" = CURRENT_TIMESTAMP
WHERE "code" IN ('vnpay', 'bank_transfer') AND "is_active" = true;

-- 4. Mã quyền ví đã bỏ khỏi catalog.
UPDATE "identity"."permissions" SET "is_active" = false, "updated_at" = CURRENT_TIMESTAMP
WHERE "code" IN ('shop.wallet.read', 'shop.wallet.deposit_request', 'supplier.wallet.read', 'supplier.wallet.adjust') AND "is_active" = true;

-- 5. Tham số vận hành.
INSERT INTO "system"."settings" ("key", "value", "group_code", "description", "is_public")
VALUES ('payout.auto_enabled', 'true'::jsonb, 'payout', 'Tự động đối soát + chi trả shop hằng ngày lúc 02:00 (Asia/Ho_Chi_Minh); chỉ chạy khi PayOS chi đã cấu hình', false)
ON CONFLICT ("key") DO NOTHING;
DELETE FROM "system"."settings" WHERE "key" = 'order.bank_transfer_timeout_hours';
