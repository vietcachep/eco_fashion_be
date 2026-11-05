# PLAN-0024 — WP-00: Nền tảng kiểm thử (môi trường cô lập + smoke theo mã kịch bản)

> Status: Ready · Đợt 0 · P0 · Phụ thuộc: — · Plan cha: PLAN-0023
> Lỗ hổng: G57, G58 · Kịch bản: hạ tầng cho mọi mã mức **S** và **B** trong `docs/11_SCENARIO_CATALOGUE.md`

## 1. Mục tiêu

Mọi phiên sau có thể, bằng **một lệnh**, dựng backend cô lập (Postgres + Redis Docker riêng, dữ liệu mẫu, toàn bộ migration, env trung tính không gửi gì ra ngoài) và chạy kịch bản smoke theo mã (`--id PAY-07`, `--tag RET`). Cách làm hiện tại chỉ nằm trong ghi chép tay của PLAN-0022 — đóng gói thành script trong repo.

## 2. Thiết kế

### 2.1 `scripts/test-env/` (backend)
- `up.mjs`
  1. Từ chối chạy nếu thấy `EF_DATABASE_URL` trỏ host khác `localhost/127.0.0.1` (chống chạy nhầm production).
  2. `docker run` `fitly-smoke-db` (`pgvector/pgvector:pg16`, cổng `SMOKE_DB_PORT` mặc định 55432) + `fitly-smoke-redis` (`redis:7-alpine`, 56379); chờ `pg_isready`.
  3. Dump mẫu (`scripts/db/demo-data/ecofashion-demo.dump`) thường cũ hơn migration hiện tại ⇒ tạo thư mục tạm chỉ chứa các migration liệt kê trong `manifest.json` (`appMigrations`) + `migration_lock.toml`; tạo file cấu hình Prisma tạm **dạng `.mjs` xuất object thường** (KHÔNG `import 'prisma/config'` — không resolve được ngoài repo); `npx prisma migrate deploy --config <tệp tạm>`.
  4. `npm run db:restore -- --yes` với `EF_DB_CONTAINER=fitly-smoke-db`, `EF_REDIS_CONTAINER=fitly-smoke-redis`.
  5. `npx prisma migrate deploy` (đủ migration) → `npm run perms:sync`.
  6. Build nếu `dist` cũ hơn `src` (so mtime) → chạy `node dist/src/main.js` và `node dist/src/worker.js` nền, ghi PID vào `scripts/test-env/.pids` (gitignore), log vào `scripts/test-env/.logs/`.
  7. Chờ `GET /api/v1/health` = UP; in URL + tài khoản test (README §tài khoản).
- `env.mjs` — **env trung tính ghi đè toàn bộ khoá thật** (process env thắng `.env`): `EF_PORT=4010`, `EF_SWAGGER_ENABLED=true`, `EF_API_PUBLIC_URL=EF_PUBLIC_URL=http://localhost:4010`, `EF_CORS_ORIGINS` gồm `3401,3402`, mọi `EF_PAYOS_*`=rỗng, `EF_MAIL_HOST=127.0.0.1 EF_MAIL_PORT=2525` (không có SMTP ⇒ thư thất bại tại chỗ), `EF_MAIL_USER/PASSWORD`=rỗng, `EF_OPENAI_API_KEY`, `EF_REPLICATE_API_TOKEN`, `EF_CLOUDINARY_*`, `EF_GOOGLE_CLIENT_ID`, `EF_PEXELS_API_KEY` = rỗng, `NODE_ENV=development`. Biến `SMOKE_PAYOS_MOCK=1` (mục 2.3).
- `down.mjs` — dừng PID, `docker rm -f` hai container, **xoá thư mục `uploads/`** do API cục bộ tạo (không bị gitignore), xoá `.pids`.
- `reset-ratelimit.mjs` — xoá khoá Redis `ef:rl:*` (đăng nhập nhiều lần trong kịch bản sẽ dính 429).
- `package.json`: `smoke:env:up`, `smoke:env:down`, `smoke` (runner), `job` (mục 2.4).

### 2.2 `scripts/smoke/` — runner theo mã
- Mỗi kịch bản một file `scenarios/<mã-thường>.mjs`: `export default { id: 'PAY-07', tags: ['PAY','money'], title, async run(ctx) }`.
- `ctx`: `api(method, path, { as, body, headers })` (tự đăng nhập theo vai, cache token, tự gọi `reset-ratelimit` khi 429) · `as`: `'customer:35'`, `'shop:ngonviet'`, `'staff:sales'`, `'staff:accountant'`, `'admin'` · `db.query(sql, params)` (pg trên DB cô lập) · `fx` (fixture): `pickOrder({status, method, shopOwner})`, `setOrder(code, patch)`, `makeDelivered(code)`, `makeShipping(code)`, `pastDue(table, id, column)`, `job(name)` (chạy job một lần — 2.4), `waitFor(fn, {timeoutMs})` · `expect(cond, label, extra)` (PASS/FAIL theo mã).
- Mỗi kịch bản **tự chọn dữ liệu riêng** (đơn chưa bị kịch bản khác dùng: đánh dấu bằng bảng tạm `smoke_used(order_code)` trong DB cô lập) để chạy lại không phụ thuộc thứ tự; khi hết dữ liệu phù hợp ⇒ báo `SKIP: thiếu dữ liệu` thay vì FAIL.
- `run.mjs --id PAY-07 | --tag RET | --all` → in bảng kết quả, ghi `scripts/smoke/.reports/<giờ>.json` (gitignore), exit ≠ 0 khi có FAIL.
- **Chuyển kịch bản có sẵn:** `docs/plans/assets/plan-0022-smoke-returns.cjs` (42 bước đã chạy xanh) ⇒ tách thành `ret-01`, `ret-02`, `ret-03`, `ret-04…06` (dùng `fx.job('return-sla')` thay vì chờ 10 phút), `ret-08`, `ref-06`, `ref-08`, `shp-10`, `sec-03`. Xong thì xoá file asset.

### 2.3 Giả lập PayOS cho smoke
- `SMOKE_PAYOS_MOCK=1` ⇒ backend dùng **PayOS giả** thay HTTP thật: một provider thay thế `PayosService` chỉ khi `NODE_ENV !== 'production'` (chặn cứng) — tạo link trả URL giả, `getPaymentLinkInformation`/`getPayout` đọc trạng thái từ bảng `smoke_payos_state` do kịch bản ghi, `createPayout` trả "00" hoặc lỗi theo kịch bản.
- Webhook giả: tái dùng `scripts/dev/simulate-payos-webhook.mjs` (ký đúng checksum bằng khoá giả trong env smoke — khoá giả sinh ngẫu nhiên lúc `up`, không phải khoá thật).

### 2.4 Chạy job một lần
- `scripts/jobs/run-once.ts` (`npm run job -- <tên>`): `NestFactory.createApplicationContext(WorkerModule)` rồi gọi đúng một hàm job theo danh sách trắng (`return-sla`, `cancel-expired`, `auto-complete`, `refund-recover`, `refund-reconcile`, `payout-auto`, `payout-reconcile`, … — các WP thêm job mới tự đăng ký vào danh sách). Dùng cho smoke và cho vận hành (chạy lại job thủ công khi sự cố — ghi vào runbook §3.5).

### 2.5 Kiểm thử trình duyệt (mức B) — hướng dẫn chuẩn
- Bản sao FE để không đụng dev server của phiên khác: `robocopy <repo> D:\fitly-e2e\<admin|user> /E /XD node_modules .next .git .claude` + `mklink /J …\node_modules <repo>\node_modules`; chạy `npx next dev --webpack -p 3401` (admin, `BACKEND_URL=NEXT_PUBLIC_API_URL=http://localhost:4010`, `NEXT_PUBLIC_STOREFRONT_URL=http://localhost:3402`) và `-p 3402` (storefront, `NEXT_PUBLIC_API_URL=http://localhost:4010`). Xoá bằng `rmdir` junction trước rồi mới `Remove-Item`.
- Mẹo đã kiểm chứng: trang chỉ hydrate khi tab hiển thị (chụp màn hình trước khi tương tác); ô nhập React dùng `form_input` hoặc setter gốc + sự kiện `input`; đăng xuất bằng xoá `localStorage`; nút đăng nhập nhanh theo vai có sẵn ở màn login quản trị.
- Đặt thành `scripts/test-env/fe-copies.ps1 up|down` (PowerShell, chỉ Windows dev).

### 2.6 Sửa tài liệu lệch code (G58) — chỉ tài liệu/comment
- `docs/06_FE_CONTRACT.md`: bỏ `PUT /admin/orders/{code}/status` (không còn route); COD = **shop cầm tiền mặt, sàn trừ hoa hồng vào ví cọc lúc `delivered`** (không phải hãng nộp về sàn); đối soát KHÔNG gom COD; payout `processing` đã có đối chiếu `getPayout` mỗi 5 phút.
- Comment: `src/modules/payment/payment-worker.module.ts` ("sàn thu COD"), `order.service.ts` comment `autoComplete` (listener ví COD không tồn tại), `docs/05_SEED_AND_REPRODUCE.md` dòng nói "sàn thu COD".

## 3. Phạm vi file

Sở hữu: `scripts/test-env/**`, `scripts/smoke/**`, `scripts/jobs/run-once.ts`, provider PayOS giả (`src/modules/payment/payos/payos.mock.ts` + đăng ký có điều kiện trong module payment — chạm nhẹ), `package.json` (scripts), `.gitignore` (`scripts/test-env/.pids`, `.logs`, `scripts/smoke/.reports`), các dòng tài liệu ở 2.6. Không đổi logic nghiệp vụ.

## 4. Bước

- [ ] 2.1 test-env up/down/env/reset-ratelimit + npm scripts; thử 2 lần liên tiếp (up → down → up) trên máy trống Docker.
- [ ] 2.4 run-once + danh sách trắng job hiện có.
- [ ] 2.3 PayOS giả (chặn production) + webhook giả ký đúng.
- [ ] 2.2 runner + fixture + chuyển kịch bản PLAN-0022 → xanh toàn bộ.
- [ ] 2.5 fe-copies.ps1 + mục hướng dẫn trong `docs/05_SEED_AND_REPRODUCE.md`.
- [ ] 2.6 sửa tài liệu lệch.
- [ ] README: mục "Kiểm thử kịch bản".

## 5. Test

- `npm run smoke:env:up && npm run smoke -- --all && npm run smoke:env:down` xanh trên máy dev (Windows + Docker Desktop).
- Unit: provider PayOS giả không bao giờ được nạp khi `NODE_ENV=production` (test bắt buộc).
- `up.mjs` từ chối DB không phải localhost (test bằng chạy với URL giả).

## 6. Review (thêm vào mẫu PLAN-0023 §7.1)

- Có đường nào script smoke chạm DB/Redis/PayOS/SMTP thật không (env rò, `.env` thắng env)?
- PayOS giả có thể lọt vào image production không (import tĩnh, biến môi trường)?
- `down.mjs` có xoá nhầm gì ngoài container/thư mục của nó không?

## 7. Quyết định phát sinh

_(phiên thực hiện ghi tại đây)_

## Phát hiện từ audit E2E (2026-10-27)

- Đã có **harness chạy được** ở `docs/plans/assets/e2e-audit/` (PayOS giả có điều khiển lỗi/trễ, runner job theo yêu cầu, webhook ký HMAC, du hành thời gian bằng DB, 14 script bài test, ~220 kiểm tra; README hướng dẫn dựng môi trường). WP-00 nên **chuyển nó thành `npm run smoke`/`scripts/test-env` trong repo** thay vì viết lại từ đầu: tách `lib.mjs` (hạ tầng) khỏi các bài, đặt tên bài theo mã `docs/11`, thêm cờ `--tag`, bỏ phụ thuộc đường dẫn máy (`BE_DIR`, `SCR`) và mật khẩu mẫu (`E2E_PW_*`).
- Bài hồi quy bắt buộc có từ audit: **CONC-08** (webhook ∥ huỷ), **STL-16x** (kỳ chi lần 2 trong ngày), **SHP-04** (tự hoàn tất vs đổi trả mở), **NTF-03** (spam thông báo), **OPS-04d** (health khi DB tắt).
- Kỹ thuật cần giữ: `resetRateLimit()` giữa các bài, dọn hàng đợi mail/outbox, worker trỏ SMTP giả, không bao giờ trỏ vào DB dev/prod.
