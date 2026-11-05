# PLAN-0028 — WP-04: Thông báo & email đủ người

> Status: Ready · Đợt 1 · P0 · Phụ thuộc: WP-00 · Plan cha: PLAN-0023
> Lỗ hổng: G06, G12 (kênh), G28 (kênh), G47, G48, G49, G50 · Kịch bản: NTF-01…05, CMP-04, WAL-01 (thông báo), CK-18

## 1. Mục tiêu

Mọi việc cần người làm đến được người đó: nhân viên sàn và shop có **chuông/hộp thư** trên web quản trị; việc khẩn có **email**; không spam; nội dung người dùng trong email được escape. Ma trận chuẩn: `docs/10` §11.

## 2. Thiết kế (đã chốt)

### 2.1 Hộp thư trong app cho web quản trị (G47)
- Backend: `GET /notifications?type=&unread=&page=&size=` (sửa: hiện bỏ qua `type`), `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all` — rà cái nào đã có, chỉ thêm phần thiếu; dùng chung cho mọi user (khách, nhân viên sàn, thành viên shop).
- Admin FE: chuông ở `components/layout/header.tsx` cho cả hai cổng (`(dashboard)` và `(vendor)`), dropdown 10 mục mới nhất + trang `/notifications` (sàn) và `/vendor/notifications` (shop); `link` của BE là route của web quản trị (`/order/...`, `/payment/...`, `/vendor/...`) — chuẩn hoá: link không khớp route ⇒ mở trang hộp thư.
- Đếm chưa đọc: `refetchInterval` 60s + khi focus cửa sổ. **Cập nhật `AGENTS.md` (admin) Rule 1** trong cùng thay đổi: thêm ngoại lệ polling "số thông báo chưa đọc 60s".

### 2.2 Email cho shop & nhân viên sàn (G48, G50)
- Lớp gửi email theo sự kiện ở module `system` (nghe outbox các module — đúng khuôn `system-worker.module.ts` đang nghe `ORDER_CREATED`): bảng ánh xạ `sự kiện → nhóm người nhận → mẫu email` theo `docs/10` §11 (cột E).
- Người nhận: shop = thành viên có quyền liên quan (`ShopQueryApi.memberUserIdsWithPermission`); kế toán = `staffUserIdsWithPermission('payment.refund.process' | 'supplier.payout.process' | 'supplier.wallet.approve')`.
- Tuỳ chọn nhận email: bảng `system.notification_preferences (user_id, group, email_enabled)`; nhóm `order|return|payout|wallet|review|system`; mặc định bật; nhóm bắt buộc (không tắt được): `payout` (đổi TK, chi trả thất bại), `security`. Màn "Cài đặt thông báo" trong hồ sơ tài khoản web quản trị.
- Chống trùng: khoá chống lặp `(event_id, user_id, channel)`; gộp "đơn mới" theo nhóm đơn cho shop (1 email / nhóm / shop).
- Nhà cung cấp email giao dịch: chỉ cấu hình (Brevo / Amazon SES / Resend qua SMTP) — `docs/08_DEPLOY.md` §4.2 thêm SPF/DKIM, `EF_MAIL_FROM` tên miền riêng — tuỳ chọn: Gmail cá nhân đủ cho demo (~500 thư/ngày), chỉ đổi khi vượt mức (chỉ đổi biến `EF_MAIL_*`).

### 2.3 Sự kiện còn thiếu (G49) — thêm thông báo trong app qua listener (không sửa service nghiệp vụ nếu sự kiện đã phát)
| Sự kiện | Người nhận | Ghi chú |
|---|---|---|
| Hoàn tiền mới cần kế toán (không đủ điều kiện tự chi) | Kế toán | WP-01 phát sự kiện; WP-04 lo kênh E |
| Tiền lệch (mismatch) | Kế toán | WP-01 |
| Kỳ chi `awaiting_approval` / `failed` / `unknown` / `held` | Kế toán (+ shop với `held`/`failed`) | WP-02 phát sự kiện |
| Nộp cọc mới / duyệt / từ chối; ví thấp; COD tắt | Kế toán / shop | thêm outbox ở `shop-wallet` nếu chưa có (chạm nhẹ, khoá vùng) |
| Đánh giá mới / shop trả lời | Shop / khách | thêm outbox ở `review` nếu chưa có |
| Đổi trả mọi bước | + kênh E cho khách và shop | PLAN-0022 đã có A |
| Huỷ đơn mọi nguồn, yêu cầu huỷ, đổi địa chỉ, nhắc hạn | Shop (A do WP-03, E do WP-04) | |
- Bỏ: thông báo "đơn mới"/"đã thanh toán" gửi **mọi** nhân viên sàn cho từng đơn con (spam; gửi theo quyền đã ngừng dùng) — thay bằng số đếm dashboard.

### 2.4 Escape (G06)
- Hàm `escapeHtml` dùng chung (`src/common/mail/` hoặc `common/utils`) cho mọi chỗ ghép chuỗi người dùng vào HTML email: `OrderMailListeners` (lý do huỷ, tên, ghi chú), email đổi trả, liên hệ. Test với `<script>` và `"`.

## 3. Phạm vi file

Sở hữu: `src/modules/system/**` (notification controller/service, listener email, preferences, mẫu email), `src/modules/order/order-worker.module.ts` **chỉ phần `OrderMailListeners`** (khoá vùng — WP-03 sở hữu phần job), chạm nhẹ phát outbox ở `shop-wallet`, `review` khi thiếu, `prisma/schema/system.prisma` + migration, `docs/08_DEPLOY.md` §4.2.
Admin FE: `components/layout/header.tsx` (chuông), `features/system/**` (hộp thư, cài đặt thông báo — bọc hook Orval), `app/(dashboard)/notifications`, `app/(vendor)/vendor/notifications`, `AGENTS.md` Rule 1.
Storefront: chỉ kiểm `notification-link.ts` nhận đủ link mới của khách (`/account/returns/{id}`, `/account/orders/{code}`).

## 4. Migration / setting / quyền

- Bảng `notification_preferences`, bảng/khoá chống lặp gửi email (`notification_deliveries (event_id, user_id, channel, sent_at)` unique).
- Không mã quyền mới (hộp thư là của chính người dùng).

## 5. Bước

- [ ] 2.4 escape + test CK-18/NTF-04.
- [ ] 2.1 BE API hộp thư + test.
- [ ] 2.3 listener trong app cho sự kiện thiếu + bỏ spam + NTF-03.
- [ ] 2.2 email + preferences + chống trùng + NTF-01 (kiểm bảng `notifications` và hàng đợi mail trong DB cô lập — SMTP 127.0.0.1:2525 nên thư "thất bại" nhưng job đã tạo đúng người nhận).
- [ ] FE (sau đồng bộ API): chuông 2 cổng + trang hộp thư + cài đặt; NTF-02 trình duyệt.
- [ ] NTF-05 với nhà cung cấp email thật: để WP-13.

## 6. Test

U: ma trận người nhận cho từng sự kiện (bảng kỳ vọng sinh từ `docs/10` §11), chống trùng, preferences, escape. S: `--tag NTF`. B: shop + kế toán + CSKH thấy chuông, bấm mở đúng màn.

## 7. Review — trọng tâm riêng

- Có thông báo/email nào lộ dữ liệu của shop khác hoặc số TK đầy đủ?
- Một sự kiện có thể gửi trùng (outbox phát lại, hai listener)?
- Người bị gỡ khỏi shop / bị khoá còn nhận email không?

## 8. Quyết định phát sinh

_(phiên thực hiện ghi tại đây)_

## Phát hiện từ audit E2E (2026-10-27) — phải xử lý trong WP này

> Nguồn: `docs/13_E2E_TEST_REPORT.md` (t06b + kiểm tra bảng `system.notifications` sau khi thử giao diện).

- [ ] **AUD-11a (NTF-03, G49)** — 5 vai nhân viên sàn (admin, quản lý, CSKH, kế toán, kho) đều nhận "Đơn mới" cho **mỗi đơn con** (10 thông báo cho 1 lần đặt 2 shop). Gộp theo nhóm `DHN`/chỉ gửi vai liên quan; dùng số đếm dashboard cho hàng đợi.
- [ ] **AUD-11b (G12)** — shop **không** nhận thông báo khi khách huỷ đơn (đơn đã trả PayOS: khách huỷ ⇒ chỉ khách nhận "đã huỷ"; shop chỉ nhận "đã hoàn tiền" về sau).
- [ ] **AUD-11c (G06)** — `OrderMailListeners` ghép `${reason}` vào HTML email không escape.
- Đã đúng (đừng đổi): chủ shop + nhân viên shop nhận "Đơn mới #…" và "đã thanh toán"; khách nhận từng bước trạng thái và "đã hoàn tiền".
