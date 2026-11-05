# PLAN-0026 — WP-02: Chi trả shop an toàn

> Status: **BE gần xong (2026-10-27, PLAN-0040 Tầng 2)** — §2.1–2.4 (kể cả cờ giữ tay `shop_payout_holds`, kiểm số dư PayOS trước khi gửi, `merged`, `shopName`/`shopCode`), 2.6, 2.7, AUD-03 phần mật khẩu; CHƯA làm: §2.5 phần email chủ shop + khớp tên chủ TK + hiệu chỉnh 72h (Tầng 5), lịch tuần, hiệu năng 100k đơn, FE (nút Duyệt/Đối chiếu/Mở giữ/Giữ tay), smoke. Migration `20261028100000_payout_holds_merged` · Đợt 1 · P0 · Phụ thuộc: WP-00 · Plan cha: PLAN-0023 · WP-06 sửa công thức kỳ SAU khi WP-02 xong
> Lỗ hổng: G30–G41 (+ G10 phần tiền, G33 phần code) · Kịch bản: STL-04…14, STL-17, STL-18, SEC-06, CONC-06, SHOP-01/02 (phần chi), FUL-10 (phần chi)

## 1. Mục tiêu

Không bao giờ chi trùng hay chi sai người; mọi kỳ chi có trạng thái rõ ràng; kế toán có công cụ duyệt / giữ / đối chiếu; chạy được cho một shop.

## 2. Thiết kế (đã chốt)

### 2.1 Trạng thái kỳ chi
`pending → (awaiting_approval) → processing → paid` · `failed` · `unknown` · `held` · `deferred` · `carried` · `settled`.
- `unknown` 🆕: gửi lệnh bị timeout / 5xx / mất kết nối / PayOS không trả mã lệnh ⇒ KHÔNG coi là thất bại.
- `awaiting_approval` 🆕: thực nhận > `payout.auto_max_amount`.
- `held` 🆕: shop bị khoá, có cờ giữ tay, hoặc đang trong `payout.bank_change_hold_hours`.
- `deferred` 🆕: 0 < thực nhận < `payout.min_amount` ⇒ dồn sang kỳ sau (số dư dương mang sang).

### 2.2 Gửi lệnh & đối chiếu (G30–G32)
- Phân loại phản hồi giống refund (PLAN-0022): từ chối chắc chắn (4xx / mã nghiệp vụ) ⇒ `failed` + `gatewayStatus='failed'`; không rõ ⇒ `unknown` + `gatewayAttemptedAt`.
- Job `payout-reconcile` (5 phút): kỳ `processing` **và** `unknown` (kể cả không có `providerRef`) ⇒ tra PayOS theo `referenceId` (kiểm tài liệu PayOS: tra theo id lệnh hoặc lọc danh sách theo `referenceId`; nếu PayOS chỉ cho tra theo id thì lưu id ngay khi có phản hồi và `unknown` không id ⇒ chỉ đánh dấu tay sau khi kế toán tra bảng điều khiển PayOS).
- `POST /admin/payouts/:id/mark-paid` **chặn** khi `processing`/`unknown`, trừ khi body có `confirmGatewayNotExecuted: true` (kế toán đã tra PayOS) hoặc `providerRef` là mã lệnh PayOS đã thành công. `providerRef` duy nhất (unique một phần, 409 `PAYOUT_PROVIDER_REF_DUPLICATE`).
- Chạy lại sau `failed` chắc chắn ⇒ khoá/`referenceId` mới `<mã kỳ>-<lần>`; sau `unknown` ⇒ cùng khoá.
- `POST /admin/payouts/:id/reconcile` 🆕: tra PayOS ngay (nút "Kiểm tra với PayOS").

### 2.3 Duyệt, hạn mức, số dư, lịch (G34)
- `payout.auto_enabled` mặc định **false** (migration chỉ đổi giá trị mặc định cho DB mới; DB có sẵn giữ giá trị hiện tại).
- `payout.schedule` = `daily` | `weekly`, `payout.schedule_weekday` = 1 (Thứ Hai); cron 02:00 VN chỉ tạo kỳ khi đúng lịch.
- Trước khi gửi lô: đọc số dư PayOS; không đủ cho cả lô ⇒ gửi theo thứ tự kỳ nhỏ trước tới khi hết số dư, phần còn lại giữ `pending` lý do `insufficient_balance` + báo kế toán.
- `awaiting_approval` ⇒ `POST /admin/payouts/:id/approve` (mã quyền mới `supplier.payout.approve`: admin + kế toán) ⇒ gửi lệnh.
- Cron chạy mà chưa cấu hình khoá chi ⇒ vẫn tạo kỳ (`pending`) và báo kế toán "cần chi tay" — không im lặng (G33).

### 2.4 Giữ tiền (G36, G10)
- Bảng `payment.shop_payout_holds (id, shop_id, reason, created_by, created_at, released_by, released_at)`.
- Tạo kỳ cho shop có hold đang hiệu lực **hoặc** shop `suspended` (qua `ShopQueryApi`) ⇒ kỳ `held`. Mở giữ ⇒ kỳ `held` về `pending` và đi tiếp.
- API: `POST /admin/payouts/holds {shopId, reason}`, `POST /admin/payouts/holds/:id/release`, `GET /admin/payouts/holds?shopId` (quyền `supplier.payout.process`).

### 2.5 Đổi TK ngân hàng (G35, G39) — module `shop`
- Body đổi TK bắt buộc `currentPassword` (xác thực qua cổng identity — thêm `IdentityApplicationApi.verifyPassword(userId, password)` nếu chưa có); chỉ chủ shop.
- Chuẩn hoá tên chủ TK (không dấu, in hoa) so với tên người đại diện / tên chủ shop đã đăng ký; **lệch ⇒ TK ở trạng thái `pending_verification`**, kỳ chi `held`, quản lý xác minh ở chi tiết shop (`supplier.shop.approve`) — duyệt ⇒ bắt đầu đếm `payout.bank_change_hold_hours`.
- Mỗi lần đổi: thông báo + **email** cho chủ shop (sự kiện outbox `SHOP_BANK_CHANGED`; email do WP-04 — nếu WP-04 chưa xong thì chỉ thông báo trong app).
- `payout.bank_change_hold_hours` = 72 (thay hằng số 24h). Hết giữ ⇒ kỳ `held` vì đổi TK tự về `pending` và **dùng TK mới** (cập nhật `bankSnapshot` khi mở giữ).

### 2.6 Chạy theo shop & hiệu năng (G41, G38, G40)
- `POST /admin/payouts/run {periodStart, periodEnd, shopId?}`; kiểm chồng kỳ theo shop; chạy toàn sàn và một shop cùng lúc ⇒ khoá advisory theo shop (CONC-06).
- Đọc đơn đủ điều kiện theo trang (cursor `deliveredAt`), cửa sổ 120 ngày + job quét đầy đủ hằng tháng; đọc refund theo trang.
- `carriedDebt` đọc dưới khoá dòng kỳ gần nhất của shop (`FOR UPDATE`) trong cùng tx.

### 2.7 Env & tài liệu
- `deploy/.env.production.example` thêm `EF_PAYOS_PAYOUT_CLIENT_ID/API_KEY/CHECKSUM_KEY` (để trống, chú thích).
- `docs/06_FE_CONTRACT.md` mục payouts: trạng thái mới, approve, holds, reconcile, mark-paid điều kiện.

## 3. Phạm vi file

Sở hữu: `src/modules/payment/shop-payout/**` (service — phần **thực thi chi**: submit/retry/reconcile/mark-paid/approve/hold/run; WP-06 sau đó sửa phần **công thức**), `auto-payout.job.ts`, `src/modules/shop/shop/**` (đổi TK), cổng identity `verifyPassword` (thêm hàm), `prisma/schema/payment.prisma` + `shop.prisma` + migration, `deploy/.env.production.example`.
FE admin: `/shop/payouts` (nhãn trạng thái, Duyệt, Kiểm tra PayOS, đánh dấu tay có xác nhận, chạy theo shop, giữ/mở giữ), chi tiết shop (xác minh TK), cổng shop `/vendor/shop` (đổi TK cần mật khẩu + thông báo giữ 72h), `/vendor/payouts` (trạng thái mới).

## 4. Migration / setting / quyền

- `shop_payouts`: `status` thêm giá trị; `gateway_status`, `gateway_attempted_at`, `gateway_attempt int default 1`, `approved_by`, `approved_at`, `hold_reason`; unique một phần `provider_ref`; `carry_amount` có dấu (thay ý nghĩa `carriedDebt` chỉ âm — giữ cột cũ, backfill).
- Bảng `shop_payout_holds`. `shops`: `bank_status` (`verified|pending_verification`), `bank_changed_at` (nếu chưa có).
- Setting: `payout.auto_enabled` (default false), `payout.schedule`, `payout.schedule_weekday`, `payout.min_amount` (50.000), `payout.auto_max_amount` (20.000.000), `payout.bank_change_hold_hours` (72; 24–720).
- Quyền: `supplier.payout.approve` (admin, kế toán).

## 5. Bước

- [x] 2.2 + test STL-08, STL-09, STL-10 (+ kịch bản mark-paid khi `unknown` bị chặn). — `unknown` + phân loại từ chối chắc chắn/không rõ (`PayosService.payout().definite`), khoá `<kỳ>-<n>`, `reconcileOne` (theo mã lệnh hoặc `GET /v1/payouts?referenceId=`), `POST /admin/payouts/:id/reconcile`, `mark-paid` chặn + `confirmGatewayNotExecuted`, `providerRef` UNIQUE.
- [x] 2.3 (một phần) + STL-04, STL-05 — `payout.min_amount` (deferred, cộng dồn), `payout.auto_max_amount` (awaiting_approval + `POST /approve`, quyền `supplier.payout.approve`), `payout.auto_enabled` mặc định false cho DB mới. **Còn:** `payout.schedule`/`schedule_weekday`, STL-06 (kiểm số dư PayOS trước khi gửi lô), cron chưa có khoá chi ⇒ vẫn tạo kỳ + báo kế toán (cron hiện chỉ bỏ qua êm).
- [~] 2.4 + STL-12 — shop `suspended` ⇒ kỳ `held`; `releaseHeld` (job 5 phút + `POST /admin/payouts/:id/release`) mở giữ khi shop được mở khoá / hết thời gian giữ. **Còn:** bảng `shop_payout_holds` + API giữ tay có lý do (STL-13), FUL-10.
- [ ] 2.5 + STL-11, SEC-06. — CHƯA làm (đổi TK cần mật khẩu, email chủ shop, khớp tên chủ TK, `pending_verification`). Mới có: `payout.bank_change_hold_hours` (72h, setting 24–720) áp cho chạy kỳ/retry/approve/mở giữ.
- [~] 2.6 — `POST /admin/payouts/run {shopId?}` ✅; `carriedDebt` đọc dưới `FOR UPDATE` dòng kỳ gần nhất ✅ (STL-18 một phần). **Còn:** khoá advisory theo shop (CONC-06), đọc đơn theo trang/cửa sổ 120 ngày (STL-17).
- [x] 2.7 — `deploy/.env.production.example` thêm `EF_PAYOS_PAYOUT_*`; `docs/06_FE_CONTRACT.md` mục payouts + wallets cập nhật.
- [~] FE: mới thêm nhãn trạng thái mới (`labels.ts`). **Còn:** nút Duyệt / Kiểm tra PayOS / mở giữ / đánh dấu tay có xác nhận, chạy theo shop; trình duyệt các vai.

## 6. Test

U: các mã trên. S: `--tag STL`. B: kế toán duyệt kỳ lớn, giữ/mở giữ, đánh dấu tay (bị chặn khi `unknown`), chạy theo shop; chủ shop đổi TK (sai mật khẩu ⇒ 401; tên lệch ⇒ chờ xác minh).

## 7. Review — trọng tâm riêng

- Liệt kê mọi đường làm kỳ thành `paid`: có đường nào không cần PayOS xác nhận hoặc chứng từ duy nhất?
- Có thể gửi 2 lệnh PayOS khác khoá cho cùng một kỳ khi lệnh đầu chưa rõ kết quả không?
- Shop bị khoá / đang giữ có lọt kỳ nào sang `processing` không (kỳ tạo trước khi khoá)?
- Kẻ chiếm phiên chủ shop có đổi được TK mà không cần mật khẩu, hoặc rút ngắn thời gian giữ không?

## 8. Quyết định phát sinh

* **Chữ ký lệnh chi (G33):** theo trang "Kiểm tra dữ liệu với signature" của PayOS (mục lệnh chi): HMAC-SHA256 với checksum key của KÊNH CHI trên chuỗi `k=v&…` khoá sắp alphabet, **có `encodeURIComponent` cả khoá lẫn giá trị** (khác payment-request). Tài liệu mẫu ký phần `data` của PHẢN HỒI; áp công thức cho BODY request là suy ra — **chưa kiểm với tài khoản thật** (WP-13). Sai ⇒ PayOS trả 401 ⇒ kỳ `failed` rõ lý do. Hàm duy nhất cần chỉnh: `PayosService.signPayout`/`payoutCanonical`.
* **`definite` của lệnh chi:** từ chối chắc chắn = HTTP 4xx hoặc mã nghiệp vụ lỗi trong phản hồi hợp lệ < 500; 5xx / timeout / không đọc được = không rõ (`unknown`).
* **Kỳ `deferred` cộng dồn** bằng `carriedDebt` ÂM (số dương mang sang) để giữ công thức `net = gross − hoa hồng − hoàn − carriedDebt`.
* **Kỳ `held` không được `retry`** — phải qua `release` (hoặc job `releaseHeld`) để vừa kiểm lý do giữ vừa chụp lại TK hiện tại.
* **Chưa kiểm:** migration `20261027100000_payout_safety` tạo UNIQUE `provider_ref` — nếu dữ liệu thật đã có mã trùng thì lỗi; chạy truy vấn trong runbook trước khi deploy.

## Phát hiện từ audit E2E (2026-10-27) — phải xử lý trong WP này

> Nguồn: `docs/13_E2E_TEST_REPORT.md` · harness `docs/plans/assets/e2e-audit/` (t01, t05, t05b). Luồng chi trả đạt tới `paid`, reconcile `unknown` (quy tắc 10 phút), `held`, `deferred`/carry, duyệt hạn mức đều chạy đúng; còn các mục sau.

- [x] **AUD-02 (P0, G73) — ĐÃ SỬA 2026-10-27** — mã kỳ `PAY-<yymmdd>-<yymmdd>-<shop>` trùng khi chạy kỳ thứ hai của cùng shop trong cùng ngày ⇒ `P2002` bị `run()` coi là "chạy song song — bỏ qua" ⇒ "Đã tạo 0 kỳ", đơn mới bị bỏ sót (STL-16x; cũng là gốc CONC-06 lần đầu). **Sửa:** `uniquePayoutCode` (`shop-payout.service.ts`) — mã gốc đã tồn tại thì thêm hậu tố CHỮ `-B`, `-C`… (tối đa 26 kỳ/ngày/shop, vượt thì báo lỗi rõ); KHÔNG dùng hậu tố số vì `gatewayKey` đã dùng `-<lần thử>` làm khoá chi lại; vẫn ≤ VarChar(30); không đổi schema. Kiểm chứng trên Postgres thật (t08, 3 kỳ cùng ngày: kỳ 3 = mã kỳ 2 + `-B`, mỗi đơn nằm đúng một kỳ, không đơn nào bị bỏ sót) + test đơn vị `shop-payout.spec.ts` (AUD-02). **Còn lại (AUD-08):** `run` kiểm chồng khoảng toàn cục (không theo shop) — chưa sửa. Bỏ thủ thuật `renameCodes` trong `t05b.mjs` khi chuyển harness vào repo.
- [~] **AUD-03 (P0, G35) — ĐÃ SỬA phần mật khẩu 2026-10-27** — đổi TK ngân hàng từng KHÔNG cần mật khẩu (STL-11a: 200, `changed=true`). **Sửa:** `PATCH /shop/me` nhận `currentPassword`; khi bank THỰC SỰ đổi (BIN/số TK/tên chủ TK) thiếu ⇒ 400 `SHOP_BANK_PASSWORD_REQUIRED`, sai ⇒ 400 `SHOP_BANK_PASSWORD_INVALID` (cố ý KHÔNG dùng 401/403 vì FE hiểu là hết phiên/thiếu quyền); kiểm bằng `IdentityQueryApi.verifyPassword` (argon2, mật khẩu của CHÍNH người thao tác) TRƯỚC transaction, kiểm lại trong transaction chống race; chỉ sửa hồ sơ hoặc gửi lại TK cũ thì không đòi; `@RateLimit` 10 lần/10 phút/người chống dò mật khẩu; audit `BANK_UPDATED.after.reauthenticated=true`, mật khẩu không vào audit/outbox/log. FE cổng nhà bán (`shop-bank-account-card.tsx`) có thêm ô "Mật khẩu đăng nhập của bạn". Kiểm chứng trên Postgres thật (t08 AUD-03a…h) + `shop-update.spec.ts`. **Còn lại của §2.5:** email riêng cho chủ shop khi đổi TK (hiện chỉ thông báo trong app qua `SHOP_BANK_CHANGED`) và khớp tên chủ TK; giữ kỳ chi sau đổi TK đã có từ trước. Đăng nhập Google/không có mật khẩu: hiện không đổi được TK — cần luồng đặt mật khẩu trước (ghi nhận, chưa làm).
- [ ] **AUD-07 (G34)** — không tra số dư PayOS trước khi gửi lô; PayOS từ chối vì thiếu số dư ⇒ kỳ vẫn `processing` (STL-06). Làm §2.3 + phân loại "thiếu số dư" ⇒ `failed` + thông báo nạp quỹ.
- [ ] **AUD-08 (G74–G76)** — `run` kiểm chồng khoảng **toàn cục** (nên theo shop, `shop-payout.service.ts` ~dòng 91–96); "Mở giữ" khi shop còn khoá trả 200 im lặng (nên 409 kèm lý do); kỳ `deferred` đã cộng sang kỳ sau vẫn `deferred` (thêm `merged`).
- [ ] **STL-13** — giữ tay chi trả của một shop (có lý do) chưa có (404).
- [ ] **AUD-09 backend (G77)** — kỳ chi/hoàn tiền trả thêm `shopName`, `shopCode` (kế toán không có `shop.read`, FE đang hiện `Shop …de93db6c`). FE: xem plan FE admin.
- [ ] **AUD-14 (G78)** — hoàn tay với `providerRef` tự nhập không tra PayOS.
