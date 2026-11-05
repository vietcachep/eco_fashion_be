# PLAN-0029 — WP-05: Công cụ vận hành & quan sát

> Status: Ready · Đợt 1 · P0 · Phụ thuộc: WP-00 · Plan cha: PLAN-0023
> Lỗ hổng: G44 (khung xuất), G51–G56 · Kịch bản: OPS-01, 02, 04, 05, 08, 09, 10, 11 (ngoài module order), 12 · SEC (quyền audit/outbox)

## 1. Mục tiêu

CSKH tìm được mọi đơn trong vài giây; ai cũng xem được "chuyện gì đã xảy ra với đơn này"; kỹ thuật biết ngay khi worker/PayOS/outbox hỏng; mỗi vai có số đếm hàng đợi của mình; kế toán xuất được dữ liệu; có sao lưu đêm tự động.

## 2. Thiết kế (đã chốt)

### 2.1 Tìm đơn toàn sàn (G51)
- `GET /admin/orders?q=&status=&paymentStatus=&shopId=&from=&to=&overdue=` — `q` khớp mã đơn con, **mã nhóm `DHN`**, SĐT/tên người nhận, **email khách** (tra `userId` qua queryapi identity). Không bắt chọn shop.
- Admin FE `/order/orders`: bỏ `ShopScope` bắt buộc ⇒ ô lọc shop tuỳ chọn (dùng `features/shop/components/platform/shop-filter.tsx` có sẵn); link từ dashboard giữ bộ lọc.
- Chi tiết đơn của sàn hiện tên shop + SĐT/email liên hệ shop + tên/SĐT/email khách.

### 2.2 Dòng thời gian một đơn (OPS-09)
- `GET /admin/orders/:code/timeline` (`order.order.read`): gộp theo thời gian — lịch sử trạng thái, audit order, giao dịch/audit payment, refund, đổi trả, kỳ chi chứa đơn, thông báo đã gửi (qua queryapi từng module; không truy vấn chéo schema).
- Admin FE: tab "Dòng thời gian" ở chi tiết đơn (sàn); bản rút gọn cho shop ở `/vendor/orders/[code]` (không lộ dữ liệu nội bộ của sàn: chỉ lịch sử + đổi trả + hoàn của chính đơn).

### 2.3 Xem audit (G53)
- `GET /admin/audit?module=order|payment|shop|identity&entityCode=&actorId=&action=&from=&to=` (mã quyền mới `system.audit.read`: admin, quản lý; kế toán chỉ `payment`). Màn `/system/audit-logs` thay/ mở rộng màn identity hiện có.

### 2.4 Outbox & job (G52, G56)
- `GET /admin/system/outbox?module=&status=FAILED` + `POST /admin/system/outbox/:module/:id/replay` (quyền mới `system.outbox.manage`: admin).
- Bọc job: `runTrackedJob(name, fn)` dùng cho MỌI `@Cron/@Interval` — (1) `pg_try_advisory_lock(hash(name))` (nhiều worker không chạy trùng), (2) ghi `system.job_heartbeats (job, last_started_at, last_succeeded_at, last_error, last_duration_ms, run_count)`.
- `GET /health/worker` (công khai nội bộ, không lộ chi tiết lỗi): job nào quá hạn (theo chu kỳ khai báo × 3) ⇒ 503. Docker healthcheck cho service `worker` bằng script `node dist/scripts/worker-health.js` đọc bảng heartbeat.
- Cảnh báo: job `ops-alert` (5 phút) — job trễ, outbox `FAILED` > 0 mới, PayOS lỗi liên tiếp ≥ 5 (đếm ở `payos.service.ts` — chạm nhẹ), refund/payout `unknown` > 30', số dư PayOS < ngưỡng ⇒ gửi **email** `EF_ALERT_EMAILS` và/hoặc **Telegram** `EF_ALERT_TELEGRAM_BOT_TOKEN` + `EF_ALERT_TELEGRAM_CHAT_ID`; chống lặp 1 lần/giờ/loại.
- Mọi `@Cron` ngoài module order thêm `timeZone: 'Asia/Ho_Chi_Minh'` (OPS-11).

### 2.5 Dashboard theo vai (G54)
- `pending` mở rộng: `refundsNeedManual`, `refundsFailed`, `payoutsAwaitingApproval`, `payoutsFailedOrUnknown`, `payoutsHeld`, `depositsPending`, `returnsEscalated` (có), `ordersSlaOverdue` (WP-03 thêm), `shippingLost` (WP-07 thêm), `reconciliationOpen` (WP-10 thêm) — **mỗi WP thêm bộ đếm của mình** vào truy vấn này (khối có comment).
- Thẻ "Việc chờ" chỉ hiện mục người xem có quyền; CSKH được cấp `reporting.dashboard.read` (nay không có).
- Dashboard shop: thêm "đổi trả chờ duyệt", "yêu cầu huỷ chờ xử lý", "đơn sắp quá hạn".

### 2.6 Xuất CSV (G44 — khung)
- `GET /admin/exports/:type?from&to&shopId` — `orders`, `refunds`, `payouts`, `payout-lines`, `wallet-transactions`; stream, UTF-8 BOM, ngày giờ VN, tiền số nguyên; quyền theo loại (kế toán/admin; `orders` thêm quản lý). WP-10 thêm `commission`, `reconciliation`.
- Nút "Xuất CSV" trên các màn tương ứng.

### 2.7 Sao lưu đêm (G55, OPS-05)
- `deploy/backup.sh` (pg_dump `-Fc` 01:30, giữ 14 bản trong `/root/backups/daily`, tuỳ chọn đẩy ra ngoài bằng `rclone` nếu có cấu hình) + hướng dẫn cài cron máy chủ ở `docs/08_DEPLOY.md`; `deploy/restore-drill.md` các bước diễn tập khôi phục vào DB phụ và kiểm số dòng.

## 3. Phạm vi file

Sở hữu: `src/modules/reporting/**` (pending, exports), `src/modules/system/**` (outbox monitor, heartbeat, alert, audit aggregator — trừ phần notification của WP-04: phối hợp bằng khoá vùng), `src/common/jobs/tracked-job.ts` (mới), mọi `*-worker.module.ts` **chỉ bọc lời gọi job** (khoá vùng; `order-worker.module.ts` phối hợp với WP-03), `order` controller/repository **chỉ** route `GET /admin/orders` + timeline, `deploy/**`, `docker-compose*.yml` (healthcheck worker).
Admin FE: `features/order/components/orders/*` (danh sách sàn + timeline), `features/reporting/components/dashboard/*`, `features/system/**` (audit, outbox), nút xuất CSV ở màn hoàn/chi/ví.

## 4. Migration / setting / quyền

- Bảng `system.job_heartbeats`, (tuỳ chọn) `system.alert_log`.
- Env mới: `EF_ALERT_EMAILS`, `EF_ALERT_TELEGRAM_BOT_TOKEN`, `EF_ALERT_TELEGRAM_CHAT_ID` (thêm vào `env.ts` + `.env.production.example`, để trống = tắt).
- Quyền: `system.audit.read`, `system.outbox.manage`; preset CSKH thêm `reporting.dashboard.read`.

## 5. Bước

- [ ] 2.4 bọc job + heartbeat + advisory lock + `/health/worker` + healthcheck + cảnh báo (OPS-01, OPS-12).
- [ ] 2.1 + OPS-08 · 2.2 + OPS-09 · 2.3 · 2.4 outbox monitor (OPS-02).
- [ ] 2.5 dashboard · 2.6 xuất CSV (OPS-10) · 2.7 sao lưu (OPS-05 diễn tập trên Docker cô lập).
- [ ] FE (sau đồng bộ API) + trình duyệt CSKH / kế toán / admin.

## 6. Test

U: tìm kiếm (mọi loại `q`), timeline gộp đúng thứ tự, advisory lock (2 lần chạy song song ⇒ 1 chạy), heartbeat quá hạn ⇒ 503, chống lặp cảnh báo, CSV (BOM, escape dấu phẩy/xuống dòng, quyền). S: tắt worker 10' trong môi trường cô lập ⇒ `/health/worker` đỏ + cảnh báo ghi log (email tới SMTP giả).

## 7. Review — trọng tâm riêng

- Tìm kiếm/timeline/xuất CSV có lộ dữ liệu ngoài quyền (kế toán thấy audit identity, shop thấy dữ liệu nội bộ)?
- CSV injection (ô bắt đầu bằng `=`, `+`, `-`, `@`) đã chặn?
- Advisory lock có bị giữ mãi khi worker chết giữa chừng (dùng lock theo phiên/tx đúng cách)?

## 8. Quyết định phát sinh

_(phiên thực hiện ghi tại đây)_

## Phát hiện từ audit E2E (2026-10-27) — phải xử lý trong WP này

> Nguồn: `docs/13_E2E_TEST_REPORT.md` (t07/t07b).

- [ ] **AUD-12a (G82)** — `/health` trả **HTTP 200** khi DB DOWN (chỉ body `db=DOWN`) ⇒ load balancer/uptime monitor không thấy; trả 503. Worker chết vẫn `status=UP` (health chỉ kiểm DB + Redis) ⇒ job nền, email, outbox dừng im lặng: thêm heartbeat worker (OPS-01y). Khi Postgres tắt, webhook PayOS trả 500 (đúng — PayOS gửi lại).
- [ ] **AUD-12b (G51)** — tìm đơn toàn sàn theo **mã nhóm DHN** và **email khách** chưa có.
- [ ] Harness `assets/e2e-audit` có thể là nền cho WP-00 — chuyển thành `npm run smoke` trong repo.
