-- wallet_transfer_ref_unique (PLAN-0030 / G27) — mã giao dịch nộp cọc duy nhất (không phân biệt hoa thường) trên các khoản ĐANG CHỜ hoặc ĐÃ DUYỆT:
-- một chứng từ chuyển khoản không thể cộng cọc hai lần (kể cả giữa hai shop). Khoản bị từ chối không chiếm mã.
-- Nếu dữ liệu cũ đã có mã trùng (pending/approved) thì tạo index lỗi — kiểm tra trước:
--   SELECT lower(transfer_ref), count(*) FROM payment.shop_cod_deposits WHERE status <> 'rejected' GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shop_cod_deposits_transfer_ref" ON "payment"."shop_cod_deposits" (lower("transfer_ref")) WHERE "status" <> 'rejected';
