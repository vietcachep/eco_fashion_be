# PLAN-0033 — WP-09: Đổi trả đợt 2

> Status: Ready · Đợt 3 · P1 · Phụ thuộc: WP-07 (luật `not_received`) · Plan cha: PLAN-0023 · Nền: PLAN-0022
> Lỗ hổng: G64, G65, G66 · Kịch bản: SHP-11 · RET-10, 11, 12, 15, 16 · CMP-02, 03 · DATA-03

## 1. Mục tiêu

Đóng các mục "còn mở" của PLAN-0022 và các tình huống thật chưa có đường: giao thiếu/sai một phần, khách bổ sung tài khoản nhận hoàn, phí ship theo lỗi, xem trước số tiền, công khai hạn.

## 2. Thiết kế (đã chốt — `docs/10` §9)

### 2.1 Lý do `missing_item` (G64)
- Áp cho đơn `delivered|completed` trong `return.window_days`; chọn dòng + số lượng thiếu; **bắt buộc minh chứng** (video/ảnh mở hộp — 1–8 tệp); `requireReturn=false`; shop duyệt ⇒ `received` (hoàn phần món thiếu, không nhập kho). Phần còn lại giữ luồng PLAN-0022 (shop từ chối ⇒ khách khiếu nại ⇒ CSKH).

### 2.2 Khách bổ sung/sửa TK nhận hoàn (PLAN-0022 mở)
- `PUT /returns/:id/refund-account {bankBin, accountNumber, accountName}` khi yêu cầu còn mở hoặc `received` mà refund chưa `done`; cổng mới `PaymentGateway.updateRefundPayee(returnRequestId, payee)` cập nhật refund đang mở (chặn khi refund `processing`/đã gửi PayOS). Thông báo kế toán nếu refund đang `needsManual` vì thiếu TK.

### 2.3 Phí ship theo lỗi (đã chốt)
- Lỗi người bán (`defective`, `wrong_item`, `not_as_described`, `damaged_shipping`, `missing_item`): hoàn phần hàng + **phần phí ship gốc theo tỉ lệ** (như hiện tại) + **phí gửi trả** khách khai ở bước gửi hàng (`returnShippingFee`, ≤ `return.shipping_claim_max` = 50.000, kèm ảnh biên nhận) — shop chịu (cộng vào số hoàn, trừ vào tiền shop như hoàn).
- Lỗi người mua (`changed_mind`, `size_issue`): **không hoàn phí ship gốc**; khách tự trả phí gửi trả.
- `other`: như lỗi người mua, shop/CSKH có thể nâng số hoàn (lý do bắt buộc — luật PLAN-0022).

### 2.4 Xem trước & công khai
- `POST /orders/:code/returns/preview {reasonCode, items}` ⇒ `{itemsAmount, shippingAmount, maxReturnShippingClaim, total}` (cùng hàm tính với lúc tạo — không trùng logic).
- Setting `return.*` (trừ nội bộ) chuyển `isPublic: true` ⇒ trang chính sách storefront đọc qua API setting công khai; bỏ hằng số trong `features/order/lib/return-policy.ts`.

### 2.5 Response & chữa dữ liệu
- `ReturnRequestResponse` (API sàn + shop) thêm `customerName` (che một phần cho shop: "Nguyễn V. A."), `maxRefundAmount` (tổng đơn − đã hoàn ở yêu cầu khác) — FE hộp thoại phân xử dùng làm trần.
- Job `return-refund-heal` (phía payment, 30 phút): refund `done` có `returnRequestId` mà yêu cầu còn `received` ⇒ gọi `markReturnRefunded` (idempotent).

### 2.6 Sau hoàn tất (G66)
- Trả hàng xong ⇒ `sold_count` trừ đúng số (cổng product, không âm).
- `review.window_days` (30): viết đánh giá trong 30 ngày sau `deliveredAt` (module review — chạm nhẹ).

## 3. Phạm vi file

Sở hữu: `src/modules/order/return/**`, `PaymentGateway.updateRefundPayee` + cài đặt (khoá vùng `payment.service.ts`), job heal trong `payment-worker.module.ts` (khối riêng), setting `return.*` public, `review` (hạn), cổng product `decrementSold` (thêm hàm), migration.
Storefront: form đổi trả (lý do `missing_item`, xem trước số tiền, khai phí gửi trả + biên nhận), chi tiết đổi trả (bổ sung TK khi thiếu), trang chính sách đọc setting.
Admin FE: hiện `customerName`, `maxRefundAmount` (trần thật trong hộp thoại Phân xử), phí gửi trả trong chi tiết.

## 4. Migration / setting

- `return_requests`: `return_shipping_fee`, `return_shipping_receipt jsonb`, `refund_breakdown jsonb` (`items`, `shipping`, `returnShipping`).
- Setting: `return.shipping_claim_max` (50.000), `review.window_days` (30); `return.*` → `isPublic: true`.

## 5. Bước

- [ ] 2.1 + SHP-11 · 2.2 + RET-10 · 2.3 + RET-11 · 2.4 + RET-12, RET-16 · 2.5 + RET-15/DATA-03 · 2.6 + CMP-02, CMP-03.
- [ ] Cập nhật `docs/06`, PLAN-0022 mục "Còn mở" → trỏ về đây.
- [ ] FE (sau đồng bộ API) + trình duyệt khách / shop / CSKH.

## 6. Test

U: bảng số học phí ship (từng lý do × hoàn một phần/đủ × có/không phí gửi trả), cập nhật payee khi refund ở từng trạng thái. S: `--tag RET`.

## 7. Review — trọng tâm riêng

- Phí gửi trả có thể đẩy tổng hoàn vượt tổng đơn / vượt trần?
- `missing_item` có thể bị lạm dụng để nhận tiền mà vẫn giữ hàng (không yêu cầu minh chứng, không giới hạn số lượng)?
- Cập nhật payee có thể đổi TK của refund đã gửi PayOS?

## 8. Quyết định phát sinh

_(phiên thực hiện ghi tại đây)_
