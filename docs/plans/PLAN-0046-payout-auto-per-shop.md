# PLAN-0046 — Chi trả tự động theo từng shop + chọn shop khi chạy tay

Trạng thái: Đã làm backend (16/11/2026); frontend admin theo sau.

## 1. Vấn đề
Cron 02:00 (`AutoPayoutJob`) tự gom + chi PayOS cho MỌI shop khi `payout.auto_enabled` = true; kế toán chỉ chạy tay được cho "mọi shop" hoặc MỘT shop. Cần: chọn shop nào được tự chi, và chạy tay cho nhiều shop được chọn.

## 2. Quyết định
- Bảng mới `payment.shop_payout_settings (shop_id PK, auto_enabled default true, updated_by, updated_at)` — nằm trong schema payment (không đụng module shop). Shop chưa có dòng = BẬT ⇒ không đổi hành vi hiện tại.
- Cron gọi `run({..., autoOnly: true})` ⇒ bỏ qua shop tắt. **Chạy tay KHÔNG dùng `autoOnly` ⇒ vẫn chi được shop đang tắt** (yêu cầu của chủ dự án: chọn 1 shop chi ngay).
- Đơn của shop bị cron bỏ qua không mất: `collect` chọn đơn theo hạn đổi trả, không theo ngày bắt đầu kỳ.
- `RunPayoutRequest.shopIds?: string[]` (≤ 200) gộp với `shopId`; kiểm chồng kỳ chỉ trong phạm vi shop được chọn.
- API: `GET /admin/payouts/auto-settings` (supplier.payout.read), `PUT /admin/payouts/auto-settings/:shopId {enabled}` (supplier.payout.process) — dùng quyền sẵn có, không cần `perms:sync`. Audit `PAYOUT_AUTO_SETTING_CHANGED` mỗi lần đổi giá trị.

## 2b. Công cụ THỬ CHI (tài khoản nhập tay)
Để kiểm tra luồng tự chi mà không cần đơn/shop: màn Đối soát có nút "Thử chi tự động" (quyền `supplier.payout.approve`) — nhập ngân hàng + số tài khoản + số tiền rồi chuyển TIỀN THẬT từ tài khoản chi PayOS. Rào chắn: tham số `payout.test_enabled` (mặc định TẮT), trần `payout.test_max_amount` (mặc định 20.000đ, tối đa 1.000.000đ), khoá chi PayOS, kiểm số dư quỹ chi trước khi gửi, `clientKey` làm khoá idempotency PayOS, audit chỉ giữ 4 số cuối. Không ghi vào kỳ đối soát nào. Test TST-01…06.

## 3. Checklist
- [x] Prisma model + migration `20261116120000_shop_payout_auto_setting`
- [x] `ShopPayoutService`: `run` (shopIds, autoOnly), `autoDisabledShopIds`, `listAutoSettings`, `setAutoSetting`
- [x] Controller + DTO; cron truyền `autoOnly`
- [x] Test AUTO-01…07 (+ cập nhật spec cron); `npm test` payment xanh (942)
- [x] docs/06_FE_CONTRACT
- [x] Admin: hook + `PayoutAutoPanel` (công tắc từng shop) + hộp thoại chạy kỳ chọn nhiều shop; spec OpenAPI thêm tay 2 endpoint rồi `api:gen` — chạy `api:sync` thật khi có backend để đối chiếu
- [x] Công cụ thử chi (backend + màn Đối soát), test TST-01…06
- [ ] Thử trên backend thật với một vai kế toán (cần Docker/Redis)
