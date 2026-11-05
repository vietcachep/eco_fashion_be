# PLAN-0027 — WP-03: Xử lý đơn có hạn chót & lối thoát

> Status: Ready · Đợt 1 · P0 · Phụ thuộc: WP-00 · Plan cha: PLAN-0023
> Lỗ hổng: G08–G17, G70, G72 · Kịch bản: FUL-03, 04, 06, 07, 10, 11, 12, 14 · CAN-01…15 · SHP-02, 03, 04 · COD-10 · CONC-03, 05 · SEC-04 · DATA-02 · OPS-11 (module order) · SHOP-01, 02 (phần đơn)

## 1. Mục tiêu

Không còn đơn treo: mỗi trạng thái trước khi giao có hạn chót và người chịu trách nhiệm; mọi trạng thái trước khi giao đều có đường huỷ đúng vai; khách đổi được địa chỉ, huỷ được trước khi đóng gói, xác nhận "đã nhận hàng"; shop bị khoá không làm đơn đóng băng.

## 2. Thiết kế (đã chốt — luật ở `docs/10` §3, §4, §7)

### 2.1 Hạn chót & điểm vi phạm
- Cột mới `orders`: `confirm_due_at`, `ship_due_at`, `confirm_reminded_at`, `ship_reminded_at`, `ship_extended_at`, `ship_extend_reason`, `cancel_reason_code`, `cancelled_by` (`customer|shop|platform|system`).
- `confirm_due_at`: COD = lúc tạo + `order.shop_confirm_hours`; PayOS = lúc `onPaid` + giờ đó (đơn chưa trả do job huỷ quá hạn lo).
- `ship_due_at` = lúc `confirmed` + `order.shop_ship_hours`. `POST /shop/orders/:code/extend-ship {reason (≥10)}` — một lần, +`order.shop_ship_hours`, chỉ khi còn hạn.
- Job `order-sla` (5 phút, khoá advisory, theo lô 100, CAS theo trạng thái + hạn): nhắc (còn 6h xác nhận / 12h giao, đúng 1 lần) · tự huỷ quá hạn (`system`, `shop_confirm_timeout` / `shop_ship_timeout`) qua `doCancel` (hoàn tiền nếu đã trả, nhả/nhập kho) · tự chấp nhận yêu cầu huỷ quá hạn.
- Bảng `order.shop_violations (id, shop_id, order_code, kind, points, created_at)`: +1 khi quá hạn xác nhận/giao, shop huỷ lý do `out_of_stock`/`price_error`, shop từ chối yêu cầu huỷ rồi lại huỷ. Tổng 30 ngày ≥ `shop.violation_suspend_points` ⇒ thông báo quản lý (1 lần/7 ngày). API `GET /admin/shops/:id/violations` (`supplier.shop.read`), `GET /shop/violations` (chủ shop xem của mình).
- **Bật lần đầu (G72, FUL-14):** migration đặt `confirm_due_at`/`ship_due_at` cho đơn đang mở = **thời điểm migration + số giờ** (không lùi theo ngày tạo) ⇒ không huỷ hàng loạt.

### 2.2 Ma trận huỷ (G09, G11, G14, G15)
- Khách: `POST /orders/:code/cancel {reasonCode, note?}` cho `pending` + `confirmed`. `packing` ⇒ `POST /orders/:code/cancel-request {reasonCode, note?}` ⇒ cột `cancel_request_*` (`requested_at, reason_code, note, due_at, status pending|accepted|rejected|auto_accepted, resolved_by, reject_reason`).
- Shop: `POST /shop/orders/:code/cancel {reasonCode, note?}` cho `pending|confirmed|packing`; `POST /shop/orders/:code/cancel-request/accept` · `/reject {reason ≥ 10}`. Mã quyền mới `shop.order.cancel` (chủ shop; nhân viên theo cấp — thêm `SHOP_ASSIGNABLE_PERMISSIONS`).
- Sàn: `POST /admin/orders/:code/cancel` thêm `packing` (lý do ≥ 10, `reasonCode` sàn).
- `doCancel`: nhả/nhập kho theo trạng thái (packing = nhập lại — hàng chưa rời shop), voucher như cũ, hoàn tiền: `paid` ⇒ hoàn `total`; `partially_refunded` ⇒ hoàn `total − đã hoàn` (cổng mới `PaymentGateway.refundedTotal(orderCode)`); ghi `cancel_reason_code`, `cancelled_by`; **thông báo shop** mọi nguồn huỷ (trừ khi shop tự huỷ) + khách; outbox `ORDER_CANCELLED` có `cancelledBy`, `reasonCode`.
- Mọi đường huỷ khoá dòng đơn (`FOR UPDATE`) **trước** khi kiểm trạng thái (G15, CONC-03, CONC-05).

### 2.3 Đổi địa chỉ (G11)
- `PUT /orders/:code/address {recipientName, recipientPhone, addressLine, ward, district, province}` khi `pending|confirmed`; ghi lịch sử (trước/sau), thông báo shop; KHÔNG tính lại phí ship (ghi chú: đổi tỉnh làm lệch phí ⇒ chặn đổi khác tỉnh, gợi ý huỷ đặt lại).

### 2.4 "Đã nhận hàng" & tự hoàn tất (G13)
- `POST /orders/:code/received` (khách, `delivered`, không có đổi trả mở) ⇒ `completed` + `completedBy='customer'`; escrow vẫn theo `deliveredAt + return.window_days` (đã đúng ở `settlementOrders`).
- `autoComplete`: bỏ qua đơn có đổi trả mở (`hasOpenReturn`); mọi `@Cron` trong module order dùng `timeZone: 'Asia/Ho_Chi_Minh'`; `order.auto_complete_days` có `min 3 / max 30`.

### 2.5 Shop bị khoá (G10)
- Module shop phát outbox `SHOP_SUSPENDED` / `SHOP_REINSTATED` (thêm nếu chưa có). Order-worker nghe `SHOP_SUSPENDED`: đơn `pending|confirmed` ⇒ huỷ `system / shop_suspended` + hoàn; đơn `packing|shipping` ⇒ thông báo CSKH kèm danh sách (CSKH quyết từng đơn). Chi trả bị giữ do WP-02 (đọc trạng thái shop).
- Dialog khoá shop ở web quản trị hiện số đơn đang mở theo trạng thái (API `GET /admin/shops/:id/open-orders-summary`).

### 2.6 Khác
- Nhóm đơn (G16): `OrderGroupResponse.summary {activeCount, cancelledCount, refundedAmount}`.
- Quyền nhân viên shop (G17): báo giao thất bại đổi sang yêu cầu `shop.order.update` (người giao hàng); cảnh báo giao quá hạn gửi người có `shop.order.update`.
- Sản phẩm bị chặn bán khi có đơn đang mở (G70): thông báo CSKH số đơn bị ảnh hưởng (nghe sự kiện sản phẩm bị chặn; đơn vẫn xử lý bình thường).
- Thông báo `onPaid` cho nhân viên sàn theo quyền đã bỏ: xoá (dashboard đủ) — WP-04 rà toàn bộ.

## 3. Phạm vi file

Sở hữu: `src/modules/order/order/service/order.service.ts` (vùng `updateStatus`, `cancel*`, `doCancel`, `autoComplete`, hàm mới), `shop-order.service.ts`, `order/controller/*` (route khách/shop/admin mới), `order.constants.ts` (lý do, trạng thái yêu cầu huỷ), `order-worker.module.ts`, `order.repository.ts`, mapper/DTO/request, `prisma/schema/order.prisma` + migration, `identity/permission/catalog.ts` (khối `shop.order.cancel`), `shop/foundation/shop.constants.ts` (assignable), shop outbox `SHOP_SUSPENDED` (chạm nhẹ), `PaymentGateway.refundedTotal` (thêm hàm + cài đặt nhỏ cuối `PaymentService` — giữ khoá vùng).
FE storefront: chi tiết đơn (huỷ `confirmed`, yêu cầu huỷ `packing` + trạng thái, đổi địa chỉ, "Đã nhận hàng", tóm tắt nhóm). FE admin: cổng shop — cột "Hạn xác nhận/giao" đếm ngược trên `/vendor/orders`, xử lý yêu cầu huỷ, gia hạn giao, huỷ `packing`, chọn mã lý do, trang vi phạm của shop; cổng sàn — huỷ `packing`, tab "Vi phạm" ở chi tiết shop, dialog khoá shop hiện đơn đang mở.
KHÔNG đụng: vùng `placeOrder`/`cancelExpired`/`onPaid` (WP-01), nhánh `shipping`/`delivered` (WP-07 — đợt sau).

## 4. Migration / setting / quyền

- `orders`: các cột ở 2.1, 2.2; backfill hạn cho đơn mở (FUL-14). Bảng `shop_violations`.
- Setting: `order.shop_confirm_hours` (24; 4–168), `order.shop_ship_hours` (48; 12–336), `order.cancel_request_hours` (24; 4–72), `shop.violation_suspend_points` (10; 1–100); `order.auto_complete_days` thêm `min/max`.
- Quyền: `shop.order.cancel` (preset chủ shop; assignable cho nhân viên).

## 5. Bước

- [ ] 2.2 (khoá dòng, ma trận huỷ, lý do, thông báo shop, partially_refunded) + CAN-*, CONC-03, SEC-04.
- [ ] 2.1 (hạn, job, vi phạm, backfill) + FUL-03/04/06/07/12/14, COD-10, CONC-05.
- [ ] 2.3 + CAN-14 · 2.4 + SHP-02/03/04, OPS-11 · 2.5 + FUL-10/SHOP-01 (phần đơn) · 2.6 + FUL-11.
- [ ] `docs/06_FE_CONTRACT.md`, ký hiệu `docs/10` §3/§4/§7 và `docs/11`.
- [ ] FE (sau đồng bộ API); trình duyệt: khách huỷ `confirmed`, yêu cầu huỷ `packing` → shop từ chối/chấp nhận; shop gia hạn giao; quá hạn (dùng `npm run job -- order-sla` + chỉnh hạn trong DB cô lập).

## 6. Test

U: toàn bộ mã đầu plan. S: `--tag FUL`, `--tag CAN`. B: storefront (khách) + cổng shop + cổng sàn (CSKH huỷ `packing`, quản lý xem vi phạm).

## 7. Review — trọng tâm riêng

- Job tự huỷ và thao tác của người cùng lúc: có đơn nào vừa huỷ vừa chuyển trạng thái, hoặc hoàn tiền hai lần?
- Bật SLA trên dữ liệu thật có huỷ hàng loạt không (đọc migration backfill)?
- Hoàn phần còn lại khi `partially_refunded` có thể vượt số đã thu không?
- Điểm vi phạm có bị cộng hai lần khi job chạy lại?

## 8. Quyết định phát sinh

_(phiên thực hiện ghi tại đây)_

## Phát hiện từ audit E2E (2026-10-27) — phải xử lý trong WP này

> Nguồn: `docs/13_E2E_TEST_REPORT.md` · harness (t03).

- [ ] **AUD-10 (P0/P1)** — test xác nhận **chưa có**: CAN-03 (khách huỷ `confirmed`) · **CAN-07/08 + SHOP-01f (huỷ `packing` — đơn kẹt, trả 400 `ORDER_CANNOT_CANCEL`)** · CAN-14 (đổi địa chỉ) · **FUL-04a (không có `confirm_due_at`/`ship_due_at` — shop ngâm đơn vô hạn; trong dữ liệu mẫu có 32 đơn `pending/confirmed/packing` > 7 ngày, không job nào xử lý)** · **SHOP-01c (khoá shop: đơn mở đóng băng)**.
- [ ] **AUD-13 / G13 (SHP-04)** — tự hoàn tất vẫn chuyển `delivered` → `completed` dù khách vừa tạo yêu cầu đổi trả đang mở (tái hiện: yêu cầu 201 → trạng thái `completed`). Job `autoComplete` phải bỏ qua đơn có yêu cầu đổi trả mở.
- [ ] **G12 (NTF-cancel)** — shop không được báo khi khách huỷ (kể cả đơn đã thanh toán) — xác nhận lại trên giao diện; phối hợp WP-04.
- Giao diện đã khớp thiết kế hiện tại: shop ở `packing` không có nút Huỷ; cổng vendor có "Giao không thành công".
