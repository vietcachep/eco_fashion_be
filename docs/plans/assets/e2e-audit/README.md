# Bộ kiểm thử E2E vòng đời đơn (audit 2026-10-27)

Bộ script đã dùng để audit toàn bộ luồng mua bán (xem `docs/13_E2E_TEST_REPORT.md`). Dùng làm **nền cho WP-00 (PLAN-0024)** — chuyển dần thành bộ chạy lại được trong repo; chạy tay trước khi có WP-00.

## Cách dựng môi trường (đã chạy được)

1. **Snapshot backend** (không đụng DB dev): sao chép `eco_backend` sang thư mục riêng, `npm ci`, `npm run build`; đặt `BE_DIR` = thư mục đó.
2. **Postgres + Redis tạm** bằng Docker, cổng lẻ (55442 / 56389) — xem `auditenv.sh` (chỉ khoá giả, không có khoá thật). Nạp dump dữ liệu mẫu rồi `prisma migrate deploy`.
3. **PayOS giả:** `node mock-payos.mjs` (cổng 4020) — hỗ trợ tạo link, tra link, chi hộ, **cấu hình lỗi/timeout/trễ** qua `/_ctl`, trang thanh toán giả `/pay/:orderCode`, gửi webhook ký HMAC. Backend trỏ tới đây nhờ `EF_PAYOS_API_URL`.
4. **Chạy API + worker** từ `dist/` với `source auditenv.sh`.
5. **Job theo yêu cầu** (không chờ cron): `node jobs.cjs <tên-job>` (hủy quá hạn, đối chiếu chi/hoàn, tự hoàn tất, SLA đổi trả…).
6. Biến môi trường test: `SCR` (thư mục chứa script), `BE_DIR`, `E2E_PW_ADMIN`, `E2E_PW_NHANVIEN`, `E2E_PW_KHACH`, `E2E_PW_VENDOR` (mật khẩu tài khoản mẫu từ file seed — không commit).
7. Chạy **đúng một** driver, theo thứ tự: `prep-accounts.mjs` (tạo `khach46` — dump chỉ có khach1…45) → `t01-setup-happy` → `t02-checkout-pay` → `t02b-recheck` → `t03-lifecycle` → `t04-returns-refunds` → `t04b` → `t04c` → `t04d` → `t05-payouts` → `t05b` → `t06b` → `t07-misc-resilience` → `t07b` → `t08-p0-verify`. **Bỏ `t06-security-ops-conc`** (phần thông báo của nó hỏng sẵn — `t06b` chứa phần còn dùng được). Mỗi bài in PASS/FAIL theo mã kịch bản của `docs/11` và ghi `OUT` (mặc định `out-*.json`). Nạp `auditenv.sh` TRƯỚC khi chạy (kể cả khi chạy nền) — nếu không `jobs.cjs` sẽ dùng `.env` của bản sao backend (DB/Redis/SMTP dev).
8. `t08-p0-verify.mjs` là bài hồi quy 3 lỗi P0 (AUD-01 deadlock webhook ∥ huỷ — `CONC_ROUNDS` số vòng, mặc định 12; AUD-02 kỳ chi cùng ngày; AUD-03 đổi TK + mật khẩu + 429). Muốn kiểm tra độ nhạy của AUD-01: vô hiệu `lockOrder` và `retryOnDeadlock` trong bản dịch rồi chạy lại — code cũ cho 12/12 deadlock (`pg_stat_database.deadlocks`), webhook 500.
9a. `t09-explore-money.mjs` — khảo sát ngoại lệ về TIỀN sau Tầng 2 (trả thiếu/thừa/trùng, trả muộn sau khi huỷ, hoàn tự động, giữ tay, thanh toán lại). Sau Tầng 2b mọi check đều ✔ nên bài đã nằm trong `run-all.sh`; chạy riêng: `OUT=… node t09-explore-money.mjs`.
9b. `t10-lifecycle-extras.mjs` — vòng đời bổ sung của Tầng 3–5 trên Postgres thật (yêu cầu huỷ, SLA + rebase, gia hạn giao, điểm vi phạm + cảnh báo khoá, đổi địa chỉ, "Đã nhận hàng", tóm tắt đơn mở khi khoá shop, xác minh TK ngân hàng, health). Tự trả `order.sla_enabled` và TK ngân hàng của shop về như cũ. Cả t09 và t10 nay nằm trong `run-all.sh` (thứ tự: t09 TRƯỚC t10 — t10 đổi TK ngân hàng của shop nên chạy t09 sau t10 trên cùng DB có thể làm HLD-08 ✘ do nhiễu).
9c. `t11-wallet-topup-payos.mjs` — nạp cọc COD qua PayOS (PLAN-0041, WP-5) trên Postgres THẬT, bảng §6.6 WTP-01…32: ghi có đủ/thiếu/thừa/trùng, replay, mất webhook + job dò, tiền về muộn, hết hạn, lỗi PayOS khi tạo link, cờ và khoá shop, rollback bằng trigger (WTP-30), đồng thời đo `pg_stat_database.deadlocks` (WTP-08/28), COD ∥ nạp (WTP-29), E2E người dùng (WTP-31), bất biến §10 cộng "Σ ví ghi có = Σ tiền PayOS giả nhận" (WTP-32). Cần `auditenv.sh` (có `EF_ADMIN_URL`) và PayOS giả. Endpoint mới của `mock-payos.mjs`: `POST /_receive {orderCode, amount, reference?, webhook: 'send'|'skip'}` (PayOS nhận tiền + webhook ký), `GET /_transfers?orderCode=` (sổ tiền đã nhận — nguồn sự thật độc lập), `POST /_link_status {orderCode, status?, amountPaid?}` (đặt trạng thái / luỹ kế để thử poll); `/_confirm` cũng ghi vào sổ. Job mới: `node jobs.cjs topup-reconcile`. Biến: `CONC_ROUNDS` (WTP-08/28, mặc định 4), `CONC_COD_ROUNDS` (WTP-29, mặc định 6). Bài tự bật `wallet.payos_deposit_enabled` và trả lại cuối bài; khoản mở của bài được đóng khi dọn dẹp. Dòng cuối in `TỔNG nhóm 11`.

9. Script tiện ích: `reset-env.sh` (DB sạch + API + worker), `run-all.sh` (đúng một driver, có khoá), `merge-results.cjs` (gộp kết quả, loại lỗi do bài test), `compare-baseline.cjs` + `baseline-2026-10-27.json` (hồi quy ✔→✘), `mark-docs11.cjs` (đánh dấu docs/11). Kế hoạch dùng bộ này để hoàn tất phần còn lại: `docs/plans/PLAN-0040-go-live-remaining-handoff.md`.
10. Mẹo: `L.api()` TỰ reset rate-limit và thử lại khi gặp 429 — bài cần thấy 429 phải dùng `fetch` thô (như AUD-03h). Biến `OUT` kiểu `/tmp/...` trong Git Bash được MSYS đổi thành đường dẫn Windows; trong `node -e` thì không — dùng `cygpath -m`.

## Kỹ thuật chính
- **Du hành thời gian bằng DB:** lùi `delivered_at`, `payment_expires_at`, `gateway_attempted_at`… để kích hoạt SLA/escrow/ân hạn mà không phải chờ.
- **Webhook giả có chữ ký:** `L.sendWebhook(orderCode, amount, { payer })` (kiểm thử trả thừa/thiếu/trùng/mất webhook).
- **Reset rate-limit:** `L.resetRateLimit()` (xoá khoá `ef:rl:*` trong Redis tạm) — nếu không, bài test đăng nhập/đặt hàng liên tục bị 429.
- Mã kỳ chi trả `PAY-<yymmdd>-<yymmdd>-<shop>` trùng trong cùng ngày (lỗi STL-16x) nên các bài chạy kỳ nhiều lần phải đổi mã kỳ cũ (`renameCodes` trong `t05b.mjs`) — bỏ thủ thuật này khi lỗi được sửa.
- Bài `t04*` cần TK nhận hoàn mẫu; `prep-cart.mjs` đổ sẵn giỏ cho khách thử khi test giao diện.

## Lưu ý
- KHÔNG trỏ vào DB dev/prod; mọi script ghi thẳng DB (du hành thời gian, dọn dữ liệu).
- Tắt worker thật/đổi SMTP về cổng giả khi chạy (tránh gửi mail thật — xem bộ nhớ dự án).

## Cập nhật 2026-10-28 (PLAN-0040 Tầng 0–2)
- Job theo yêu cầu mới trong `jobs.cjs`: `payos-poll` (hỏi PayOS link pending), `refund-auto` (tự chi hoàn nhỏ).
- Baseline mới: `baseline-2026-10-27-tang2.json` (304 ✔ · 12 ✘ · 30 ℹ trên 346 mã) — `node compare-baseline.cjs baseline-2026-10-27-tang2.json`.
- Baseline sau Tầng 2b–6: `baseline-2026-10-27-final.json` (**409 ✔ · 0 ✘ · 36 ℹ trên 445 mã**) — `node compare-baseline.cjs baseline-2026-10-27-final.json` (docs/13 §13).
- **Không chạy việc nặng (`npm run verify`, build…) khi `run-all.sh` đang chạy** — `jobs.cjs` bật cả ứng dụng Nest bằng `execSync` (120s) và thất bại im lặng khi thiếu CPU.
- Mật khẩu tài khoản mẫu là **công khai trong mã seed** (`scripts/seed/identity.seed.ts`, `scripts/seed/data/shops.ts`) — không phải bí mật, nhưng cũng đừng ghi vào repo ngoài seed.
