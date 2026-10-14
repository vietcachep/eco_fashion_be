-- =====================================================================
-- wallet_cod_refund_type (PLAN-0017) — sổ cái ví COD thêm loại `cod_refund`:
--   hoàn tiền đơn COD đã hoàn tất: sàn chuyển tiền cho khách nhưng shop đang giữ tiền mặt đã thu ⇒ ví shop bị ghi nợ số hoàn,
--   đồng thời sàn hoàn lại phần hoa hồng tương ứng (khoá dòng `RF-<refundId>` chống ghi hai lần).
-- =====================================================================
ALTER TABLE "payment"."shop_wallet_transactions" DROP CONSTRAINT "chk_shop_wallet_tx_type";
ALTER TABLE "payment"."shop_wallet_transactions" ADD CONSTRAINT "chk_shop_wallet_tx_type"
  CHECK ("type" IN ('cod_commission', 'deposit', 'adjust', 'cod_refund'));
