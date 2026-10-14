-- =====================================================================
-- payout_status_carried_settled (PLAN-0017) — sửa lỗi CHECK quá hẹp ở marketplace_completion:
--   kỳ đối soát có net < 0 ghi status 'carried' (không chi, mang nợ sang kỳ sau), net = 0 ghi 'settled' (không có gì để chi) —
--   ShopPayoutService ghi hai trạng thái này nhưng CHECK cũ chỉ cho pending|processing|paid|failed ⇒ INSERT bị Postgres từ chối.
-- =====================================================================
ALTER TABLE "payment"."shop_payouts" DROP CONSTRAINT "chk_shop_payouts_status";
ALTER TABLE "payment"."shop_payouts" ADD CONSTRAINT "chk_shop_payouts_status"
  CHECK ("status" IN ('pending', 'processing', 'paid', 'failed', 'carried', 'settled'));
