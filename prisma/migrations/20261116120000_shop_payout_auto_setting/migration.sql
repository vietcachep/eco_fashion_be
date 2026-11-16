-- shop_payout_auto_setting — công tắc chi trả TỰ ĐỘNG theo từng shop (cron 02:00). Shop chưa có dòng = BẬT (giữ nguyên hành vi hiện tại).
-- Chỉ thêm bảng mới ⇒ chạy lại an toàn, code cũ vẫn chạy được. Tắt công tắc KHÔNG chặn kế toán chạy kỳ/chi tay cho shop đó.
CREATE TABLE IF NOT EXISTS "payment"."shop_payout_settings" (
  "shop_id" uuid NOT NULL,
  "auto_enabled" boolean NOT NULL DEFAULT true,
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shop_payout_settings_pkey" PRIMARY KEY ("shop_id")
);
