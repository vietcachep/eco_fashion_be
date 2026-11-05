-- order_sla_cancel_requests (PLAN-0027 / PLAN-0040 Tầng 3) — hạn chót xử lý đơn của shop, yêu cầu huỷ đơn đang đóng gói, mã lý do huỷ, điểm vi phạm của shop.
--  * order.orders: confirm_due_at / ship_due_at (+ nhắc 1 lần, gia hạn giao 1 lần), cancel_reason_code + cancel_source, cancel_request_* (yêu cầu huỷ của khách), completed_by.
--  * order.shop_violations (UNIQUE(order_code, kind) ⇒ không cộng điểm hai lần), order.shop_violation_alerts (nhắc quản lý 1 lần / 7 ngày), order.job_state (nhịp job SLA).
-- KHÔNG backfill hạn cho đơn đang mở (điểm an toàn G72): đơn cũ có confirm_due_at / ship_due_at = NULL ⇒ job SLA không bao giờ động tới chúng, bật `order.sla_enabled` không huỷ hàng loạt.
-- Chỉ ADD COLUMN IF NOT EXISTS (NULL) + bảng mới ⇒ chạy lại an toàn, code cũ vẫn chạy được.
ALTER TABLE "order"."orders"
  ADD COLUMN IF NOT EXISTS "confirm_due_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "ship_due_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "confirm_reminded_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "ship_reminded_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "ship_extended_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "ship_extend_reason" varchar(500),
  ADD COLUMN IF NOT EXISTS "cancel_reason_code" varchar(30),
  ADD COLUMN IF NOT EXISTS "cancel_source" varchar(20),
  ADD COLUMN IF NOT EXISTS "cancel_request_status" varchar(20),
  ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "cancel_request_reason_code" varchar(30),
  ADD COLUMN IF NOT EXISTS "cancel_request_note" varchar(500),
  ADD COLUMN IF NOT EXISTS "cancel_request_due_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "cancel_request_resolved_by" uuid,
  ADD COLUMN IF NOT EXISTS "cancel_request_reject_reason" varchar(500),
  ADD COLUMN IF NOT EXISTS "completed_by" varchar(20);

CREATE INDEX IF NOT EXISTS "orders_status_confirm_due_at_idx" ON "order"."orders" ("status", "confirm_due_at");
CREATE INDEX IF NOT EXISTS "orders_status_ship_due_at_idx" ON "order"."orders" ("status", "ship_due_at");
CREATE INDEX IF NOT EXISTS "orders_cancel_request_status_cancel_request_due_at_idx" ON "order"."orders" ("cancel_request_status", "cancel_request_due_at");

-- Đơn đã huỷ trước đợt này: gắn nguồn huỷ suy ra từ người thao tác để lịch sử/báo cáo không để trống (khách tự huỷ = người huỷ trùng chủ đơn; còn lại để NULL — không đoán).
UPDATE "order"."orders" SET "cancel_source" = 'customer'
WHERE "status" = 'cancelled' AND "cancel_source" IS NULL AND "cancelled_by" IS NOT NULL AND "cancelled_by" = "user_id";

CREATE TABLE IF NOT EXISTS "order"."shop_violations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL,
  "order_code" varchar(30) NOT NULL,
  "kind" varchar(30) NOT NULL,
  "points" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shop_violations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "shop_violations_order_code_kind_key" ON "order"."shop_violations" ("order_code", "kind");
CREATE INDEX IF NOT EXISTS "shop_violations_shop_id_created_at_idx" ON "order"."shop_violations" ("shop_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "order"."shop_violation_alerts" (
  "shop_id" uuid NOT NULL,
  "alerted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shop_violation_alerts_pkey" PRIMARY KEY ("shop_id")
);

CREATE TABLE IF NOT EXISTS "order"."job_state" (
  "key" varchar(60) NOT NULL,
  "last_run_at" timestamptz NOT NULL,
  CONSTRAINT "job_state_pkey" PRIMARY KEY ("key")
);
