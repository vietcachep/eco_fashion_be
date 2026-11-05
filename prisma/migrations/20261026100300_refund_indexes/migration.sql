-- =====================================================================
-- refund_indexes (PLAN-0022 — review độc lập): chỉ mục cho các truy vấn tra cứu hoàn tiền theo mã đơn / giao dịch / yêu cầu đổi trả.
--   - order_code        : refundSummaries (IN (...) theo danh sách mã đơn của trang danh sách đơn), tìm kiếm theo đơn ở màn kế toán.
--   - payment_id        : tổng hoàn đang chờ của một giao dịch (requestRefund: aggregate theo payment_id), `refunds: { none: … }` của khoản trả trùng; cột FK nhưng Postgres KHÔNG tự tạo index cho FK.
--   - return_request_id : tra khoản hoàn của một yêu cầu đổi trả.
-- Tên theo quy ước Prisma (`<bảng>_<cột>_idx`) để `prisma migrate diff` khớp với `@@index` trong prisma/schema/payment.prisma. IF NOT EXISTS: chạy lại / môi trường đã có sẵn không lỗi.
-- =====================================================================
CREATE INDEX IF NOT EXISTS "refunds_order_code_idx" ON "payment"."refunds" ("order_code");
CREATE INDEX IF NOT EXISTS "refunds_payment_id_idx" ON "payment"."refunds" ("payment_id");
CREATE INDEX IF NOT EXISTS "refunds_return_request_id_idx" ON "payment"."refunds" ("return_request_id");
