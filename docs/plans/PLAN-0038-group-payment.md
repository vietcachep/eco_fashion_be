# PLAN-0038 — WP-14: Một QR thanh toán cho cả nhóm đơn (giai đoạn 2)

> Status: Draft · Đợt 5 (sau go-live) · P2 · Phụ thuộc: WP-13 · Plan cha: PLAN-0023
> Lỗ hổng: G68 · Kịch bản mới sẽ thêm vào `docs/11` nhóm `PAY-G*` khi bắt đầu

## 1. Vấn đề

Giỏ nhiều shop ⇒ mỗi đơn con một QR; khách phải chuyển N lần, trả thiếu ⇒ các đơn còn lại tự huỷ ⇒ giảm chuyển đổi.

## 2. Thiết kế đề xuất (chốt lại khi bắt đầu)

- Payment cấp **nhóm** (`payment_groups`: `group_code`, `amount = Σ total`, PayOS orderCode riêng) + payment đơn con trỏ tới nhóm; một link PayOS cho nhóm.
- Webhook nhóm `paid` ⇒ phân bổ `paid` cho từng đơn con (cùng tx, idempotent) ⇒ mỗi đơn con đi tiếp như hiện tại (shop xác nhận độc lập).
- Trả thiếu cho nhóm ⇒ không đơn nào `paid`; hết hạn ⇒ huỷ cả nhóm + hoàn số đã nhận (`mismatch`, WP-01).
- Huỷ/hoàn một đơn con sau khi nhóm đã trả ⇒ refund theo đơn con, tham chiếu payment nhóm (payee = người trả nhóm).
- Đối soát/kỳ chi không đổi (vẫn theo đơn con). Đối chiếu WP-10 thêm loại payment nhóm.
- Tương thích: đơn cũ giữ payment đơn con; cờ setting `payment.group_checkout_enabled`.

## 3. Rủi ro

Thứ tự khoá nhóm ↔ đơn con; voucher sàn chia theo nhóm (đã có); khách huỷ một đơn con khi nhóm chưa trả (cập nhật số tiền link — PayOS không sửa được link ⇒ huỷ link, tạo lại).

## 4. Bước

- [ ] Viết plan chi tiết + kịch bản `PAY-G*` · [ ] BE · [ ] FE storefront (checkout/thanh toán) · [ ] review R1 bổ sung · [ ] UAT tiền thật nhỏ.
