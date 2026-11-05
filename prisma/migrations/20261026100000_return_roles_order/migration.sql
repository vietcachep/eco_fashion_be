-- =====================================================================
-- return_roles_order (PLAN-0022) — đổi trả: đúng vai, đúng trách nhiệm (phần module order).
--   * return_requests: lý do chuẩn, cờ cần-trả-hàng, shop_id, tài khoản nhận hoàn, địa chỉ trả hàng, dấu mốc từng bước (duyệt / gửi trả / nhận hàng / khiếu nại /
--     phân xử), hạn của từng bước + chỉ mục cho job SLA, cột nhắc shop; orders: mốc cảnh báo đơn `shipping` quá hạn.
--   * Chuyển dữ liệu cũ: kiểu cũ "approved" = ĐÃ nhập kho + ĐÃ yêu cầu hoàn tiền ⇒ nay là "received"; yêu cầu bị từ chối cũ do nhân viên sàn ⇒ rejected_by = 'platform'
--     (không khiếu nại lại được); yêu cầu "requested" đang chờ được cấp đủ hạn shop duyệt (72 giờ kể từ lúc deploy) để không dồn ồ ạt sang CSKH.
-- Chỉ THÊM cột NULL/DEFAULT + dữ liệu; không xoá cột — an toàn deploy. KHÔNG sửa migration cũ. DDL dùng IF NOT EXISTS; phần chuyển dữ liệu chạy MỘT lần (Prisma ghi nhận
-- migration đã áp) — chạy tay lại sẽ đổi nhầm các yêu cầu "approved" kiểu MỚI. Đã kiểm trên Postgres thật (PGlite) cả chuỗi migration và phần chuyển dữ liệu.
-- =====================================================================

-- orders ---------------------------------------------------------------
ALTER TABLE "order"."orders" ADD COLUMN IF NOT EXISTS "shipping_alerted_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "orders_status_shipped_at_idx" ON "order"."orders"("status", "shipped_at");

-- return_requests ------------------------------------------------------
ALTER TABLE "order"."return_requests"
  ADD COLUMN IF NOT EXISTS "adjust_reason" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "approved_by" UUID,
  ADD COLUMN IF NOT EXISTS "calculated_refund_amount" DECIMAL(14,0),
  ADD COLUMN IF NOT EXISTS "carrier" VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "escalate_due_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "escalate_reason" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "escalate_source" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "escalated_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "reason_code" VARCHAR(30) NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS "received_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "received_by" UUID,
  ADD COLUMN IF NOT EXISTS "received_condition" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "received_evidence" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "received_note" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "refund_account" JSONB,
  ADD COLUMN IF NOT EXISTS "reject_evidence" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "rejected_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "rejected_by" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "require_return" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "resolve_decision" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "resolve_note" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "resolved_by" UUID,
  ADD COLUMN IF NOT EXISTS "return_address" JSONB,
  ADD COLUMN IF NOT EXISTS "ship_back_due_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "ship_back_note" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "shipped_back_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "shop_id" UUID,
  ADD COLUMN IF NOT EXISTS "shop_receive_due_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "shop_reminded_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "shop_respond_due_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "tracking_code" VARCHAR(80);

-- shop_id: chép từ đơn rồi mới đặt NOT NULL (mọi yêu cầu đều có đơn — FK order_id).
UPDATE "order"."return_requests" rr
SET "shop_id" = o."shop_id"
FROM "order"."orders" o
WHERE o."id" = rr."order_id" AND rr."shop_id" IS NULL;

ALTER TABLE "order"."return_requests" ALTER COLUMN "shop_id" SET NOT NULL;

-- Số tiền hệ thống đã tính của dữ liệu cũ = số tiền hoàn hiện có.
UPDATE "order"."return_requests" SET "calculated_refund_amount" = "refund_amount" WHERE "calculated_refund_amount" IS NULL;

-- Kiểu cũ "approved" (đã restock + đã yêu cầu hoàn tiền) ⇒ "received"; hàng coi như đã về kho shop, đúng.
UPDATE "order"."return_requests"
SET "status" = 'received',
    "received_at" = COALESCE("processed_at", "updated_at"),
    "received_condition" = 'ok'
WHERE "status" = 'approved';

-- Yêu cầu đã refunded theo kiểu cũ cũng đã nhận hàng.
UPDATE "order"."return_requests"
SET "received_at" = COALESCE("processed_at", "refunded_at", "updated_at"),
    "received_condition" = 'ok'
WHERE "status" = 'refunded' AND "received_at" IS NULL;

-- Từ chối kiểu cũ là việc của nhân viên sàn ⇒ quyết định của sàn, khách không khiếu nại lại.
UPDATE "order"."return_requests"
SET "rejected_by" = 'platform', "rejected_at" = COALESCE("processed_at", "updated_at")
WHERE "status" = 'rejected' AND "rejected_by" IS NULL;

-- Yêu cầu đang chờ: cấp đủ 72 giờ cho shop kể từ lúc deploy (đúng mặc định setting return.shop_respond_hours).
UPDATE "order"."return_requests"
SET "shop_respond_due_at" = NOW() + INTERVAL '72 hours'
WHERE "status" = 'requested' AND "shop_respond_due_at" IS NULL;

-- Chỉ mục: danh sách theo shop/đơn + job SLA quét theo hạn.
CREATE INDEX IF NOT EXISTS "return_requests_shop_id_status_created_at_idx" ON "order"."return_requests"("shop_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "return_requests_order_id_idx" ON "order"."return_requests"("order_id");
CREATE INDEX IF NOT EXISTS "return_requests_status_shop_respond_due_at_idx" ON "order"."return_requests"("status", "shop_respond_due_at");
CREATE INDEX IF NOT EXISTS "return_requests_status_ship_back_due_at_idx" ON "order"."return_requests"("status", "ship_back_due_at");
CREATE INDEX IF NOT EXISTS "return_requests_status_shop_receive_due_at_idx" ON "order"."return_requests"("status", "shop_receive_due_at");
