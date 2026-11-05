# PLAN-0031 — WP-07: Giao hàng có bằng chứng & chống gian lận giao

> Status: Ready · Đợt 2 · P0 · Phụ thuộc: WP-03 (cùng vùng `updateStatus`) · Plan cha: PLAN-0023
> Lỗ hổng: G18–G22 · Kịch bản: FUL-08 · SHP-01, 05, 06, 07 (lặp), 08, 09, 13 · COD-03 (điều kiện mã vận đơn), COD-05 (phần shop), COD-08, COD-09

## 1. Mục tiêu

"Đã giao" phải có căn cứ; khách đủ thời gian báo chưa nhận; đơn COD báo giao sai không làm sàn chuyển tiền mặt cho khách; thất lạc có đường xử lý; né hoa hồng COD bị phát hiện.

## 2. Thiết kế (đã chốt — `docs/10` §4, §6, §8)

### 2.1 Hãng + mã vận đơn
- Danh mục hằng số `CARRIERS` (`ghn`, `ghtk`, `viettel_post`, `jnt`, `spx`, `ahamove`, `ninja_van`, `vnpost`, `other`) kèm mẫu URL tra cứu (nếu biết) — đặt ở `order.constants.ts`.
- Chuyển sang `shipping` bắt buộc `{carrier, trackingCode (4–40 ký tự [A-Za-z0-9-])}`; `trackingUrl` tự sinh theo mẫu, hoặc shop nhập (https) khi `other`. Cột mới `orders.carrier`, `orders.tracking_code`.
- Cùng `trackingCode` đã dùng cho đơn khác của cùng shop (trừ đơn bị huỷ) ⇒ cho qua nhưng ghi cờ `tracking_reused` + thông báo CSKH (SHP-13).

### 2.2 Đã giao
- `shipping → delivered` cần có mã vận đơn; ảnh bằng chứng tuỳ chọn (`deliveryProof` ≤ 3 ảnh từ `/uploads/media`, cùng luật URL tin cậy như minh chứng đổi trả).
- **Chặn** khi có yêu cầu đổi trả `not_received` đang mở ⇒ 409 `ORDER_NOT_RECEIVED_OPEN` (SHP-06).
- Email/thông báo khách kèm 2 nút: "Đã nhận hàng" (WP-03) / "Chưa nhận được hàng".

### 2.3 Chưa nhận hàng
- `return.not_received_days` mặc định **7** (migration: nếu giá trị hiện tại = 3 cũ thì đổi thành 7; đã chỉnh tay thì giữ).
- **COD đã báo giao + khách báo chưa nhận** (COD-08): không đòi TK nhận hoàn (khách chưa trả tiền). Khi shop duyệt / sàn phân xử "hoàn": thay vì tạo refund ⇒ gọi cổng mới `PaymentGateway.reverseCodCollection(orderCode, reason, tx)`: payment về `unpaid` (`reversed_at`), giao dịch ví **đảo** ghi thu (cộng lại hoa hồng, trừ lại trợ giá — WP-06 công thức), yêu cầu đổi trả → `refunded` với `refundAmount = 0`, đơn → `returned` như hiện tại. Sửa luật tạo yêu cầu ở `return.rules`/`return.service` cho trường hợp này.

### 2.4 Giao thất bại & hàng về sau
- `POST /shop/orders/:code/delivery-failed`: quyền `shop.order.update` (thay `shop.return.process`); bắt buộc có mã vận đơn; `reasonCode` thêm `refused` · `unreachable` · `wrong_address` · `lost` · `damaged` · `other`.
- `goodsReturned=false` ⇒ sau đó `POST /shop/orders/:code/goods-returned` (một lần, trong 30 ngày) ⇒ nhập kho số đã giao, lịch sử + audit (SHP-09).
- Sự kiện outbox `ORDER_DELIVERY_FAILED {reasonCode, paymentMethod, userId}` — WP-08 dùng để đếm "bom" cho khách.

### 2.5 Leo thang giao quá hạn & thất lạc
- Cảnh báo `order.shipping_alert_days` (10) lặp lại mỗi 5 ngày (không chỉ 1 lần); bỏ giới hạn 90 ngày cho bước leo thang.
- `order.shipping_escalate_days` (20): đơn vẫn `shipping` ⇒ cột `lost_case_opened_at` + thông báo CSKH + số đếm dashboard `shippingLost` (khối của WP-05). Màn CSKH: `/order/orders?overdue=lost` + hành động sẵn có "Huỷ khi tranh chấp" với `reasonCode=lost` (hoàn khách nếu đã trả; không nhập kho; ghi `shop_violations` +2).

### 2.6 Phát hiện né hoa hồng COD (G22)
- Chỉ số mỗi shop 30 ngày: tỉ lệ đơn COD kết thúc bằng giao thất bại; đơn COD `shipping` quá `shipping_escalate_days`. Vượt 15% (hằng số cấu hình `cod.shop_fail_rate_alert` = 0.15, cần ≥ 10 đơn) ⇒ thông báo CSKH + quản lý hằng tuần (job `cod-risk-weekly`).
- CSKH xử lý theo runbook §3.8 (đối chiếu với hãng; truy thu bằng chỉnh ví tay có lý do).

## 3. Phạm vi file

Sở hữu: `order.service.ts` vùng nhánh `shipping`/`delivered` trong `updateStatus` + `deliveryFailed` + hàm mới (khoá vùng), `shop-order.service.ts`/controller/request (giao, giao thất bại, hàng về), `order.constants.ts` (CARRIERS, lý do), `order-worker.module.ts` khối job leo thang + `cod-risk-weekly` (khoá vùng — WP-03 sở hữu file), `return/*` (luật not_received COD), `PaymentGateway.reverseCodCollection` (thêm hàm; cài đặt trong `payment.service.ts` + `shop-wallet` — khoá vùng, phối hợp WP-06 dùng chung công thức), migration order + payment.
Admin FE: cổng shop — dialog giao (chọn hãng + mã), dialog đã giao (ảnh tuỳ chọn), giao thất bại (mã lý do), "Hàng đã về kho"; cổng sàn — hàng đợi "nghi thất lạc", cờ dùng lại mã vận đơn ở chi tiết đơn.
Storefront: chi tiết đơn hiện hãng + mã + link tra cứu; nút "Chưa nhận được hàng" tới hết 7 ngày.

## 4. Migration / setting / quyền

- `orders`: `carrier`, `tracking_code`, `tracking_reused bool default false`, `delivery_proof jsonb`, `lost_case_opened_at`, `shipping_alerted_count int default 0` (thay/ bổ sung `shipping_alerted_at`); `payments.reversed_at`.
- Setting: `return.not_received_days` (đổi giá trị như 2.3), `order.shipping_escalate_days` (20; 10–60), `cod.shop_fail_rate_alert` (0.15).
- Quyền: giao thất bại dùng `shop.order.update`.

## 5. Bước

- [ ] 2.1 + FUL-08, SHP-13 · 2.2 + SHP-01, SHP-06 · 2.3 + SHP-05, COD-08 (cả đường CSKH phân xử).
- [ ] 2.4 + SHP-09, COD-05 (phần shop) · 2.5 + SHP-07 (lặp), SHP-08 · 2.6 + COD-09.
- [ ] Docs 06/10/11/12 (runbook §3.8).
- [ ] FE (sau đồng bộ API) + trình duyệt: shop giao → khách báo chưa nhận → shop bị chặn báo giao; COD đảo thu.

## 6. Test

U: các mã trên + đơn PayOS không bị ảnh hưởng bởi nhánh đảo thu COD. S: `--tag SHP`, COD-05, COD-08.

## 7. Review — trọng tâm riêng

- Đảo thu COD có thể chạy hai lần / chạy trên đơn PayOS / làm ví lệch khi đơn đã vào kỳ?
- Có đường nào shop vẫn đưa đơn sang `delivered` khi đang có `not_received` mở (giao diện cũ, API khác)?
- Mã vận đơn có bị dùng để chèn link độc (URL `other`)?

## 8. Quyết định phát sinh

_(phiên thực hiện ghi tại đây)_

## Phát hiện từ audit E2E (2026-10-27) — phải xử lý trong WP này

- [ ] **AUD-13** — COD: khách báo "chưa nhận hàng" ⇒ hệ thống có thể tạo hoàn **tiền mặt chưa từng thu** (G19) — phải đảo ghi thu thay vì hoàn.
- [ ] **SHP-09** — chưa có đường "hàng đã về kho" sau giao thất bại `goodsReturned=false` (404).
- [ ] **SHP-08** — đơn `shipping` > 20 ngày chỉ cảnh báo một lần rồi im lặng — cần leo thang.
