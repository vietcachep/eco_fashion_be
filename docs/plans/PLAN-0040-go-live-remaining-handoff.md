# PLAN-0040 — Hoàn tất phần còn lại để chạy thử tiền thật (plan bàn giao cho một phiên)

> Status: Ready · P0 · Plan cha: PLAN-0023 · Nguồn sự thật: `docs/13_E2E_TEST_REPORT.md` (audit E2E 2026-10-27 + §11 đợt sửa 3 lỗi P0) · Phụ thuộc: không
> Repo: `eco_backend` · `fashion_frontend_admin` · `fashion_frontend_user` (cùng thư mục cha `D:\Fullstack\eco_fashion`)
> Plan này **không thay** các plan WP đã có (PLAN-0025…0034, 0037) — nó là **thứ tự làm việc + tiêu chí xong + bài học vận hành** để một phiên duy nhất đi hết phần còn lại. Thiết kế chi tiết của từng mục nằm ở plan WP được trỏ tới; chỗ nào plan WP và plan này lệch nhau, **plan WP thắng về thiết kế, plan này thắng về thứ tự**.

## 0. Dán vào phiên mới (lời giao việc)

```text
Bạn là phiên thực hiện PLAN-0040 (dự án FITLY: eco_backend + fashion_frontend_admin + fashion_frontend_user ở D:\Fullstack\eco_fashion).
Đọc theo thứ tự: eco_backend/docs/plans/PLAN-0040-go-live-remaining-handoff.md (toàn bộ), eco_backend/docs/13_E2E_TEST_REPORT.md (§0, §5, §7, §11),
eco_backend/docs/plans/PLAN-0023-order-lifecycle-go-live.md (§5 luật phiên, §8 mẫu báo cáo), rồi plan WP được trỏ tới ở từng tầng,
eco_backend/docs/10_ORDER_LIFECYCLE.md, các mã kịch bản liên quan trong eco_backend/docs/11_SCENARIO_CATALOGUE.md, AGENTS.md của từng repo sẽ sửa
(FE: Next.js bản mới — đọc node_modules/next/dist/docs/ trước khi viết code Next).
Làm tuần tự theo TẦNG (§5); hết mỗi tầng phải xanh (§7) và tick checklist §9 trước khi sang tầng sau. Không chạy git ghi (commit/push/branch/stash/reset),
không đọc/in .env hay khoá PayOS, không gọi PayOS/ngân hàng/email thật. Gặp việc ngoài plan → ghi vào "Quyết định phát sinh" (§10), đừng tự đổi luật ở docs/10.
Hết phiên (hoặc hết tầng nếu cạn ngữ cảnh): báo cáo theo mẫu §8 và để §9 phản ánh đúng chỗ đã dừng — phiên sau tiếp tục từ đó.
```

**Cỡ việc & cách dừng:** toàn bộ plan là rất lớn. Tầng **0 → 7 là bắt buộc** trước khi chạy tiền thật (PLAN-0037); tầng **8** làm sau. Nếu hết ngữ cảnh giữa chừng, **dừng ở cuối một tầng** (không dừng giữa tầng), cập nhật §9, báo cáo — đừng để code nửa vời trong cây làm việc.

## 1. Mục tiêu & "xong" nghĩa là gì

Chạy được PLAN-0037 (E2E-01…10, tiền thật số nhỏ) mà không còn lỗi đã biết gây **mất/kẹt tiền, chi sai người, đơn kẹt không lối thoát**, và giao diện khớp backend. Cụ thể, **xong** khi:

1. Bộ audit (`docs/plans/assets/e2e-audit/run-all.sh`) chạy lại trên DB sạch: **0 ✘ ngoài danh sách "để sau" ở §6**; không hồi quy so với baseline §2.3.
2. `npm run verify` xanh ở cả 3 repo (BE: lint + boundaries + build + test; admin: lint + typecheck + build; storefront: lint + typecheck + build) và `migration:check` xanh.
3. Mọi hạng mục của 5 "lưu ý" bàn giao (§4) đã xử lý hoặc có quyết định ghi rõ.
4. `docs/10`, `docs/11` (cột HT), `docs/13` (§12 mới), `docs/06_FE_CONTRACT.md`, plan WP liên quan đã cập nhật; có checklist triển khai (§7.3) cho chủ dự án.

## 2. Hiện trạng bàn giao (2026-10-27)

### 2.1 Đã làm — CHƯA commit, CHƯA deploy (chủ dự án điều khiển git)
- **AUD-01** deadlock webhook ↔ khách huỷ: thứ tự khoá bất biến **ĐƠN → PAYMENT** (`OrderPaymentGateway.lockOrder`, `settlePayosOnce`, `finalizeRefundOnce`) + `retryOnDeadlock` (`src/common/prisma/errors.ts`).
- **AUD-02** mã kỳ chi trùng: `uniquePayoutCode` (hậu tố **chữ** `-B`, `-C`…; **không** dùng hậu tố số vì `gatewayKey` đã dùng `-<lần thử>`).
- **AUD-03** đổi TK ngân hàng: `PATCH /shop/me` nhận `currentPassword` (400 `SHOP_BANK_PASSWORD_REQUIRED/INVALID`, `@RateLimit` 10/10 phút) + ô mật khẩu ở `shop-bank-account-card.tsx`.
- Không có migration mới trong đợt sửa P0. Chi tiết + bằng chứng: `docs/13` §11.

### 2.2 Công cụ kiểm thử đã có — `docs/plans/assets/e2e-audit/`
`README.md` (cách dựng) · `reset-env.sh` · `run-all.sh` · `merge-results.cjs` (gộp kết quả, loại lỗi do bài test) · `compare-baseline.cjs` + `baseline-2026-10-27.json` (phát hiện hồi quy ✔→✘) · `mark-docs11.cjs` (đánh dấu cột HT của docs/11) · `lib.mjs` (helper) · `mock-payos.mjs` (PayOS giả điều khiển được) · `jobs.cjs` (chạy job nền theo yêu cầu — **có hàng rào từ chối chạy nếu DB không phải DB audit**) · `prep-accounts.mjs` · các bài `t01…t08` (mã kịch bản = mã `docs/11`). `t08-p0-verify.mjs` là bài hồi quy 3 lỗi P0 — giữ nguyên, đừng xoá. `t09-explore-money.mjs` (khảo sát ngoại lệ về tiền sau Tầng 2) **cố ý có check ✘** — là tiêu chí xong của Tầng 2b, KHÔNG nằm trong `run-all.sh` cho tới khi 2b xong.

### 2.3 Baseline kết quả (lần chạy sạch sau đợt sửa P0): **290 ✔ · 18 ✘ · 33 ℹ trên 341 mã**
18 ✘ còn lại, ánh xạ sang tầng làm:

| ✘ | Tầng | Việc |
|---|---|---|
| PAY-07b, PAY-08, PAY-09 | 1.1 | trả thiếu / thừa / trả hai lần |
| PAY-10b | 1.2 | thanh toán lại không gia hạn hạn đơn |
| REF-04b2 (+REF-04b) | 1.6 | hoàn tay không tra PayOS (AUD-14) |
| STL-13 | 2.1 | giữ tay chi trả một shop |
| CAN-03, CAN-07, CAN-08, CAN-14, FUL-04a, SHOP-01c, SHOP-01f, SHP-04 | 3.x | huỷ `confirmed`/`packing`, đổi địa chỉ, hạn SLA, khoá shop, tự hoàn tất vs đổi trả mở |
| COD-08b, SHP-09 | 3.6–3.7 | COD "chưa nhận" đảo thu; hàng về sau giao thất bại |
| NTF-03 | 4.1 | spam thông báo nhân viên sàn |
| CK-05 | 8 | `expectedTotal` (WP-08, để sau) |

Các mã ✔ trước đó là lỗi của chính bài test đã được xử lý (`docs/13` §7): COD-03b, SHP-07, NTF-01a, STL-08e, RET-29, WAL-05, CMP-01b — **đừng sửa code vì chúng**.

## 3. Luật phiên & bài học bắt buộc nhớ

Luật chung: `PLAN-0023` §5 (không git ghi, không bí mật, khoá file nóng §6, migration viết tay thêm cột NULL/DEFAULT, setting mới có min/max, BE trước FE sau, test theo mã, cập nhật docs cùng thay đổi). Thêm các bài học từ đợt audit/sửa P0:

1. **Thứ tự khoá bất biến ĐƠN → PAYMENT** (rồi → ví). Mọi code MỚI khoá `payment` (FOR UPDATE) mà sau đó gọi sang order phải gọi `OrderPaymentGateway.lockOrder` trước. Test: `payment-payos.spec.ts` có bài kiểm thứ tự khoá — đừng làm hỏng; đặt thêm bài tương tự cho đường mới.
2. **Lỗi mật khẩu/hết quyền trả 400, không 401/403** khi phiên vẫn hợp lệ (FE hiểu 401 = hết phiên → đăng xuất; 403 = màn thiếu quyền).
3. **Hậu tố mã/khoá không bao giờ là số** nếu đi vào `gatewayKey` (`<mã>-<lần thử>`).
4. Working tree dùng **CRLF** (`autocrlf`). Sửa file bằng công cụ Edit (đọc file bằng Read trước); script sửa hàng loạt phải giữ CRLF — kiểm `git diff --stat` không phình bất thường.
5. Cây làm việc đã có **hàng trăm thay đổi chưa commit của các phiên trước** (PLAN-0022 …). Chỉ sửa vùng của mình, không "dọn" file lạ, không revert.
6. **Harness:** chỉ chạy **MỘT** driver (`run-all.sh` có khoá); **luôn nạp `auditenv.sh`** (kể cả khi chạy nền) — thiếu thì job/lib rơi về `.env` của bản sao (DB/Redis/SMTP dev); `L.api()` tự reset rate-limit và thử lại khi 429 (bài cần thấy 429 phải dùng `fetch` thô); `OUT=/tmp/...` trong Git Bash bị MSYS đổi sang đường dẫn Windows, trong `node -e` thì không (dùng `cygpath -m`); `t07` làm tắt Postgres/worker giữa chừng — **không chạy song song với bài khác**; **bỏ qua `t06`** (hỏng sẵn), dùng `t06b`.
7. **Bản sao backend KHÔNG chứa `.env` thật** (§5 Tầng 0): dùng `.env.example` + `auditenv.sh` ghi đè. Không bao giờ trỏ vào DB dev/prod; mọi script ghi thẳng DB (du hành thời gian).
8. Trình duyệt tích hợp: tab ẩn thì trang **không hydrate** (bấm bằng `.click()` JS không gửi form) → `tabs_select` + click toạ độ thật; FE test chạy trên **bản sao** `D:\fitly-e2e\<app>` (junction `node_modules`, `next dev --webpack -p <cổng>`, env `BACKEND_URL` + `NEXT_PUBLIC_API_URL` trỏ backend cô lập) — không chạy `next dev` trong repo thật (làm bẩn `.next`, làm `tsc` đỏ).
9. Cổng PayOS giả trả về `localhost:3000/checkout/payos-return` theo `returnUrl` backend — khi test cổng khác, mở tay `.../checkout/payos-return?code=00&id=<paymentLinkId>&cancel=false&status=PAID&orderCode=<orderCode>`.
10. **Dọn sau phiên** (§7.5) — container, tiến trình, `D:\fitly-snap`, `D:\fitly-e2e` (gỡ junction bằng `cmd /c rmdir` TRƯỚC khi xoá thư mục; tuyệt đối không xoá `node_modules` thật).

## 4. Năm "lưu ý" bàn giao → nơi xử lý trong plan

| # | Lưu ý (từ báo cáo sửa P0) | Xử lý ở |
|---|---|---|
| L1 | Web quản trị phải lên **cùng đợt** với backend (FE cũ đổi TK bị 400) | §7.3 checklist triển khai + Tầng 6.1 |
| L2 | AUD-03 còn thiếu: email riêng cho chủ shop khi đổi TK; khớp tên chủ TK; tài khoản Google không đổi được TK | **Tầng 5** (5.1, 5.2, 5.3) + 5.4 (lệch "24 giờ" ↔ setting 72 giờ phát hiện thêm) |
| L3 | `api:sync` chưa chạy; `currentPassword` khai tạm trong hook; là điều kiện của màn đối soát kế toán | **Tầng 6.1** (đồng bộ một lần) + 6.2 |
| L4 | Sai sót khi tự test: job chạy theo `.env` bản sao (DB/Redis/Gmail dev) | **Tầng 0** (bản sao không có `.env` thật, một driver, nạp env) + `jobs.cjs` đã có hàng rào; ghi vào §3.6–3.7 |
| L5 | Dọn dẹp môi trường test; `node_modules` thật còn nguyên | §7.5 quy trình dọn an toàn |

## 5. Các tầng làm việc (tuần tự)

Mỗi mục: **việc** · **chỗ sửa** · **xong khi** (mã kịch bản / cách kiểm). Thiết kế chi tiết: plan WP được trỏ.

### Tầng 0 — Dựng môi trường & chốt baseline (≈ 1 giờ)
- [x] **0.1 Dựng bản sao + hạ tầng** (xem §11 công thức). **Xong khi:** `curl :4030/api/v1/health` = 200, `mock-payos` ở :4020, `run-all.sh` chạy hết.
- [x] **0.2 Chốt baseline.** `REG_DIR="$(cygpath -m /tmp)/reg" node merge-results.cjs` kỳ vọng **290 ✔ · 18 ✘ · 33 ℹ** (cùng danh sách ✘ ở §2.3) và `node compare-baseline.cjs` báo **0 hồi quy**. Lệch ⇒ **dừng, điều tra trước khi sửa gì** (nghi ngờ: môi trường, hai driver chạy chồng, thiếu `auditenv.sh`).
- [x] **0.3 Bản sao không chứa `.env` thật** (§11 bước 1: loại `.env*`, chép `.env.example` → `.env`). Nếu `loadEnv` đòi giá trị mạnh hơn (vd `EF_JWT_SECRET`) thì thêm vào `auditenv.sh`, KHÔNG chép `.env` thật.

### Tầng 1 — Thu tiền vào & hoàn tiền (PLAN-0025 còn lại + AUD-14) — chạm `payment.service.ts`, `order.service.ts`
- [x] **1.1 Tiền lệch: thừa / thiếu / trùng (AUD-04, PLAN-0025 §2.4).** Migration `payments` (`received_amount`…); cộng dồn theo giao dịch; thừa ⇒ refund `mismatch` tự tạo; thiếu ⇒ không `paid`, hết hạn thì huỷ + hoàn đúng số đã nhận; **trả hai lần khác `reference` trên cùng link** ⇒ refund `duplicate_payment` (hiện chỉ có nhánh "payment khác trả sau" — `refundDuplicate`; nhánh cùng payment trả `already` và **không** hoàn). Thông báo kế toán. **Xong khi:** PAY-07/07b/08/09, REF-12 ✔ (t02).
- [x] **1.2 Hạn thống nhất (AUD-05, §2.2).** Hạn link PayOS = setting hạn đơn (bỏ hằng 30'); `retryPayos` gia hạn cả `payment.expiresAt` và `order.paymentExpiresAt` qua cổng mới `OrderPaymentGateway.extendPaymentDeadline(orderCode, until, tx)`. **Xong khi:** PAY-10b ✔.
- [x] **1.3 Gọi PayOS NGOÀI transaction (AUD-06, §2.1).** `initiate` PayOS không HTTP; `createCheckoutLinks` sau commit (timeout 8s, song song giới hạn 3); lỗi ⇒ payment `pending` + `last_link_error`, đơn **vẫn tạo**, response `paymentUrl: null, linkRetryable: true` (**không** 503 `PAYMENT_PAYOS_NOT_CONFIGURED`). **Xong khi:** CK-15 (đơn tạo, `link_failed`, thử lại được), CK-16 (6 checkout song song, PayOS chậm 3s: tổng thời gian ≪ 18,5s đã đo trước đây).
- [x] **1.4 Poll định kỳ `payos-reconcile-pending` (§2.3 phần còn lại).** Mỗi 2 phút, khoá advisory; PAID ⇒ đi đúng `settlePayos` (nguồn `poll`); lưu `last_checked_at`, `last_gateway_status`. **Xong khi:** PAY-04b (mất webhook, ghi nhận `paid` **trước** hạn huỷ + ân hạn) — E2E-05.
- [x] **1.5 Tự chi hoàn nhỏ (§2.5).** Setting `refund.auto_max_amount` (mặc định 2.000.000; 0 = tắt), job `refund-auto-process` (5 phút) dùng `processRefund` với actor hệ thống; khoản không tự chi được ⇒ báo kế toán **một lần**. **Xong khi:** REF-01, REF-02, CAN-02 (phần tự chi), PAY-06 — E2E-02.
- [x] **1.6 Hoàn tay phải tra PayOS (AUD-14).** Refund đang `processing` + `needsReconcile` (trạng thái "không rõ") mà kế toán ghi sổ tay `providerRef` ⇒ **409 `PAYMENT_REFUND_RECONCILE_REQUIRED`** trừ khi gửi cờ xác nhận (mẫu: `confirmGatewayNotExecuted` của `markPaid` ở `shop-payout.service.ts`); và/hoặc backend tự tra `findPayoutByReference` trước khi cho ghi sổ, chặn nếu PayOS **đã** nhận lệnh. **Xong khi:** `t04` REF-04b ✔ và `t04b` REF-04b2 ✔.
- [x] **1.7 Đóng tầng:** `docs/06_FE_CONTRACT.md` (mục thanh toán), `docs/10` §5/§9, `docs/11` HT; BE `npm run verify` xanh; `run-all.sh` — các ✘ của tầng này thành ✔, không hồi quy.

### Tầng 2 — Chi trả shop (PLAN-0026 còn lại) — chạm `shop-payout.service.ts`
- [x] **2.1 Giữ tay (STL-13, §2.4).** Bảng `payment.shop_payout_holds`, `POST /admin/payouts/holds {shopId, reason}`, `POST …/holds/:id/release`, `GET …/holds?shopId` (quyền `supplier.payout.process`); kỳ tạo cho shop có hold ⇒ `held`; mở giữ ⇒ về `pending` và đi tiếp. **Xong khi:** STL-13 ✔ — E2E-09.
- [x] **2.2 Số dư PayOS & từ chối thiếu số dư (AUD-07, §2.3).** Tra số dư trước khi gửi lô (đã có `payos-balance`); PayOS từ chối vì thiếu số dư ⇒ phân loại rõ (`failed` + `gatewayStatus=failed`, thông báo kế toán nạp quỹ), **không** để `processing`. **Xong khi:** STL-06 ✔ (đổi ghi chú thành kiểm).
- [x] **2.3 Gọn lỗi kỳ chi (AUD-08).** `run()` kiểm chồng kỳ **theo shop** (`shop-payout.service.ts`, đoạn `overlap`); "Mở giữ" khi shop còn khoá ⇒ **409 kèm lý do** (không 200 im lặng); kỳ `deferred` đã cộng sang kỳ sau ⇒ trạng thái mới `merged`. **Xong khi:** STL-12b2/STL-04d chuyển từ ghi chú sang kiểm ✔; thêm bài chạy kỳ cho shop A không bị chặn bởi kỳ của shop B.
- [x] **2.4 Backend trả tên shop (AUD-09 phần BE).** Kỳ chi + hoàn tiền thêm `shopName`, `shopCode` (kế toán không có `shop.read` nên FE đang hiện `Shop …de93db6c`). Không thêm quyền đọc shop cho kế toán.
- [x] **2.5 Đóng tầng:** như 1.7 (docs/06, docs/10 §10, docs/11, PLAN-0026 checklist).

### Tầng 2b — Vá sót phát hiện khi khảo sát độc lập sau Tầng 2 (2026-10-27) — LÀM NGAY, trước Tầng 3
Nguồn: §13. Bài kiểm chứng đã viết sẵn: `assets/e2e-audit/t09-explore-money.mjs` — các check đang ✘ chính là tiêu chí xong (chạy sau `run-all.sh`; khi sửa xong, đưa t09 vào `run-all.sh` và lưu baseline mới).
- [x] **2b.1 Tiền đến MUỘN trên payment đã huỷ/hết hạn (AUD-18 + AUD-19, P1 — kẹt tiền + webhook 500).** `settlePayosOnce`: payment KHÔNG còn `pending` (cancelled/expired) mà có khoản tiền mới ⇒ chỉ cộng `received_amount`, KHÔNG đẩy payment sang `paid`, và tạo/cộng dồn hoàn `mismatch` cho đúng `received − refunded − hoàn đang chờ` (dùng chung với `refundReceivedOfCancelled`, bỏ guard "đã có mismatch thì thôi"); idempotent theo `reference`; webhook luôn 200. (Đường thay thế: `OrderService.onPaid` nhánh "đến muộn sau huỷ" xin hoàn `min(order.total, trần còn lại)` — nhưng vẫn phải lo ca trả thiếu sau huỷ.) **Xong khi:** t09 MNY-02b, MNY-02c, MNY-08, MNY-09 ✔ và MNY-01/04/05/06/07 vẫn ✔; sửa câu thông báo kế toán "tiền đã nhận sẽ được hoàn" cho đúng thực tế.
- [x] **2b.2 Chặn tự chi hoàn cho tiền mặt chưa từng thu (AUD-20, P0 cho tới khi xong 3.6).** `autoProcessRefunds` bỏ qua refund của payment **COD** (hoặc lý do `not_received`) cho tới khi COD-08b xong; đồng thời ghi vào checklist triển khai (§7.3) và `docs/12`: **giữ `refund.auto_max_amount = 0` ở môi trường thật cho tới khi 3.6 xong**. **Xong khi:** bài mới "COD chưa nhận ⇒ job tự chi KHÔNG gửi PayOS" ✔ (thêm vào t09 nhóm AUTO) và COD-08b ✔ sau 3.6 thì mới bỏ ngoại lệ.
- [x] **2b.3 Củng cố (P3):** webhook thiếu `reference` + `transactionDateTime` ⇒ coi là replay (không cộng dồn) — t09 MNY-03a; bấm "Thanh toán lại" hai lần đồng thời ⇒ bắt `P2002` và trả link của payment đang chờ thay vì 409 `COMMON_DUPLICATE` — t09 RTY-02b (đang là ghi chú).

### Tầng 3 — Xử lý đơn có hạn chót & lối thoát (PLAN-0027) + giao hàng (lát PLAN-0031) — chạm `order.service.ts`, `shop-order.service.ts`, `order-worker.module.ts`
Làm theo thứ tự `PLAN-0027` §5 (ma trận huỷ → SLA → địa chỉ/đã nhận → khoá shop).
- [x] **3.1 Ma trận huỷ (§2.2).** Khách huỷ tức thì tới `confirmed` (nhập lại kho + hoàn); `packing` ⇒ khách **yêu cầu**, shop có quyền huỷ/từ chối, sàn (CSKH) huỷ được khi tranh chấp; `partially_refunded` hoàn phần còn lại. **Xong khi:** CAN-03, CAN-07, CAN-08, SHOP-01f ✔; thêm CONC-03/05 theo plan.
- [x] **3.2 Hạn SLA (§2.1) + ĐIỂM AN TOÀN G72.** `confirm_due_at`/`ship_due_at`, job leo thang + tự huỷ + hoàn + điểm vi phạm. **BẮT BUỘC:** lần bật đầu tiên **không** được huỷ hàng loạt đơn cũ đang treo (backfill hạn = now + hạn chuẩn, hoặc chỉ áp cho đơn tạo sau mốc bật — chốt trong "Quyết định phát sinh"). Trong dữ liệu mẫu có ~32 đơn `pending/confirmed/packing` > 7 ngày: dùng làm ca thử. **Xong khi:** FUL-04a, FUL-03/06/07/12/14 ✔ và bài "bật SLA không huỷ đơn cũ".
- [x] **3.3 Tự hoàn tất tôn trọng đổi trả mở (SHP-04, G13).** `autoComplete` bỏ qua đơn có yêu cầu đổi trả mở (dùng `repo.hasOpenReturn`). **Xong khi:** SHP-04 ✔.
- [x] **3.4 Đổi địa chỉ + "Đã nhận hàng" (§2.3–2.4).** CAN-14 ✔; khách có nút "Đã nhận hàng" (rút ngắn escrow theo plan).
- [x] **3.5 Shop bị khoá (§2.5).** Đơn mở của shop bị khoá không đóng băng: pending/confirmed tự huỷ + hoàn, `packing` CSKH huỷ được. **Xong khi:** SHOP-01c ✔.
- [x] **3.6 Giao có hãng + mã vận đơn & COD "chưa nhận" (PLAN-0031 §2.1–2.3).** Hãng + mã vận đơn bắt buộc khi chuyển `shipping`; khách báo "chưa nhận hàng" với đơn COD đã báo giao ⇒ **đảo ghi thu COD, không hoàn tiền mặt chưa từng thu** (G19). **Xong khi:** COD-08/COD-08b ✔; E2E-01 có bước "giao (hãng + mã vận đơn)".
- [x] **3.7 Giao thất bại & hàng về (PLAN-0031 §2.4).** Đường "hàng đã về kho" khi `goodsReturned=false` (SHP-09 ✔). §2.5 (leo thang > 20 ngày, SHP-08) và §2.6 (né hoa hồng COD) → Tầng 8.
- [x] **3.8 Đóng tầng:** docs/06, docs/10 §3/§4/§7/§8, docs/11, docs/12 (runbook nếu đổi thao tác); `verify` + `run-all.sh`.

### Tầng 4 — Thông báo & vận hành tối thiểu (PLAN-0028/0029 phần cần cho tiền thật)
- [x] **4.1 Thông báo đúng người (AUD-11).** (a) 5 vai nhân viên sàn đang nhận "Đơn mới" cho **mỗi đơn con** ⇒ gộp theo nhóm `DHN`/chỉ vai liên quan, dashboard dùng số đếm (NTF-03 ✔); (b) **shop được báo khi khách huỷ** (kể cả đơn đã thanh toán — G12; làm cùng 3.1 nếu tiện); (c) **email không escape** `${reason}`/nội dung khách nhập (`order-worker.module.ts` → `OrderMailListeners`; rà MỌI template mail dùng chung một hàm escape — thêm test nội dung chứa `<script>`).
- [x] **4.2 Sức khoẻ hệ thống (AUD-12).** `/health` trả **503** khi DB DOWN (hiện 200, chỉ body báo); worker chết ⇒ không còn "UP" im lặng (heartbeat worker trong Redis + health đọc); admin tìm đơn toàn sàn theo **mã nhóm `DHN`** và **email khách** (`q` mở rộng, tra `userId` qua `IdentityQueryApi`). **Xong khi:** OPS-04d/OPS-01y chuyển từ ghi chú sang kiểm ✔; thêm bài tìm DHN/email.
- [x] **4.3 Đóng tầng:** docs/12 (cảnh báo/heartbeat), docs/06, docs/11.

### Tầng 5 — Phần còn lại của AUD-03 (xử lý lưu ý L2) — module `shop` + `identity` + `system`
- [x] **5.1 Email riêng cho chủ shop khi đổi TK.** Hiện `SHOP_BANK_CHANGED` chỉ tạo thông báo trong app (`ShopNotificationListeners.onShopBankChanged`, `system-worker.module.ts`). Thêm **email tới chủ shop** (qua `common/mail/mail.service.ts`, hàng đợi BullMQ `mail`; mẫu dùng ở `identity-worker.module.ts`): chỉ 4 số cuối + người đổi + thời điểm + hướng dẫn "không phải bạn → khoá/liên hệ sàn"; **escape** mọi giá trị chèn vào HTML; idempotent theo `eventId` như listener hiện có. **Xong khi:** test đơn vị + bài harness kiểm job `mail` xuất hiện (SMTP giả; đọc hàng đợi Redis `ef:mail:*` — đừng bật SMTP thật).
- [x] **5.2 Khớp tên chủ TK (PLAN-0026 §2.5).** So tên chủ TK (bỏ dấu, IN HOA, gộp khoảng trắng — dùng lại `normalizeBankAccountName` của FE làm chuẩn) với **tên chủ shop** (`fullName` của `ownerUserId` qua `IdentityQueryApi.findUserBriefs`); **lệch ⇒ TK ở trạng thái chờ xác minh**: kỳ chi `held` (`holdReason` rõ), báo quản lý; quản lý xác minh ở chi tiết shop (quyền `supplier.shop.approve`) ⇒ bắt đầu đếm `payout.bank_change_hold_hours`. Migration thêm cột NULL (vd `shops.bank_verified_at`). **Xong khi:** thêm bài STL-11d (tên lệch ⇒ `held` + lý do), STL-11e (quản lý xác minh ⇒ chạy tiếp sau thời gian giữ); STL-11a/b/c vẫn ✔.
- [x] **5.3 Tài khoản đăng nhập Google.** Tài khoản tạo bằng Google có mật khẩu **ngẫu nhiên không ai biết** (`auth.service.ts`, dòng tạo `randomBytes`) ⇒ đổi TK luôn 400 `SHOP_BANK_PASSWORD_INVALID`. Giải pháp tối thiểu, không migration: backend thêm `IdentityQueryApi.isGoogleLinked(userId)`; khi mật khẩu sai **và** tài khoản gắn Google ⇒ giữ mã lỗi nhưng thêm `details.googleLinked = 'true'` + thông điệp "Tài khoản đăng nhập bằng Google: hãy đặt mật khẩu bằng Quên mật khẩu rồi thử lại"; FE hiện liên kết tới "Quên mật khẩu" (OTP email có sẵn). **Xong khi:** test đơn vị + thử trình duyệt với một tài khoản có `google_sub`.
- [x] **5.4 Lệch số giờ giữ chi trả.** Setting `payout.bank_change_hold_hours` mặc định **72**, nhưng FE (`shop-bank-account-card.tsx`: `HOLD_NOTICE` + toast thành công) và comment ở `shop-payout.service.ts` ghi cứng "24 giờ". Đưa giá trị thật vào `GET /shop/me`/phiên vendor (`bankChangeHoldHours`) và FE đọc; sửa comment. **Xong khi:** đổi setting sang 48 ⇒ FE hiện 48.
- [x] **5.5 Đóng tầng:** PLAN-0026 §2.5 tick, docs/10 §10, docs/11 STL-11, `docs/13` ghi nhận.

### Tầng 6 — Đồng bộ hợp đồng API & giao diện (xử lý lưu ý L1, L3)
**6.1 và 6.2 chỉ làm SAU khi Tầng 1–5 (BE) xong** — không chạy `api:sync` khi còn sửa BE.
- [x] **6.1 Đồng bộ một lần.** Dựng backend cô lập có `EF_SWAGGER_ENABLED=true` (đã có trong `auditenv.sh`); admin: `npm run api:sync` + `npm run perms:sync`; storefront: `npm run api:sync`. Commit-ready (KHÔNG commit). Sau đó **xoá kiểu tạm** `UpdateMyShopBody` ở `features/shop/hooks/use-shop-profile.ts` (model sinh đã có `currentPassword`) và các `as unknown as` thừa của endpoint nay đã có schema. **Xong khi:** `tsc --noEmit` sạch; spec có `approve|reconcile|release` của kỳ chi.
- [x] **6.2 Admin — màn đối soát kế toán (AUD-09).** `payouts-screen.tsx`: tab thêm **Chờ duyệt · Không rõ kết quả · Đang giữ · Dồn kỳ sau (merged)**; chi tiết kỳ: nút **Duyệt**, **Đối chiếu PayOS**, **Mở giữ** (báo lý do khi bị từ chối), **Thử lại**; hiển thị `holdReason`; cột shop dùng `shopName`/`shopCode` (bỏ gọi danh sách shop khi thiếu quyền); màn **giữ tay** (2.1) trong chi tiết shop; nhãn `mismatch` ở hoàn tiền; thông báo/chuông theo vai (số đếm hàng đợi thay vì từng đơn). Luật FE: `AGENTS.md` admin (Rule 0–4, 3 lớp quyền, không import hook sinh trực tiếp).
- [x] **6.3 Storefront.** `paymentUrl: null` + nút "Thanh toán lại" (1.3); huỷ khi `confirmed` + yêu cầu huỷ `packing` (3.1); đổi địa chỉ, "Đã nhận hàng" (3.4); **form huỷ đơn đã thanh toán nói trước tiền hoàn về đâu/bao lâu** (AUD-15); hiện hạn link thanh toán sau gia hạn (1.2).
- [x] **6.4 Admin — cổng nhà bán.** Gợi ý Google (5.3), số giờ giữ thật (5.4), trạng thái "chờ xác minh" của TK (5.2), hạn SLA + nút huỷ/từ chối yêu cầu huỷ (3.x), hãng + mã vận đơn khi giao (3.6).
- [~] **6.5 Kiểm trình duyệt theo vai** trên bản sao FE (§3.8): khách, chủ shop, NV shop, kế toán, CSKH — mỗi vai ≥ 2 việc được và 2 việc KHÔNG được (PLAN-0037 §5). **Xong khi:** `npm run verify` xanh ở admin + `lint`/`typecheck`/`build` ở storefront; ảnh chụp/ghi chú từng vai trong báo cáo.

### Tầng 7 — Rà soát, triển khai, bàn giao (xử lý lưu ý L1, L5)
- [x] **7.1 Chạy lại toàn bộ audit** (`run-all.sh`) trên DB sạch. **Xong khi:** 0 ✘ ngoài §6 (`node merge-results.cjs`); `node compare-baseline.cjs` thoát mã 0 (không có mã ✔ → ✘). Cập nhật cột HT `docs/11` bằng `node mark-docs11.cjs ../../../11_SCENARIO_CATALOGUE.md` và viết `docs/13` §12 (kết quả đợt này; mã nào mới thì lưu baseline mới `baseline-<ngày>.json`).
- [ ] **7.2 Rà soát độc lập (PLAN-0023 §7).** Giao cho phiên/agent **không** viết code đó (chỉ đọc), trọng tâm: thứ tự khoá, idempotency chi/hoàn, quyền (3 lớp ở FE; `PermissionGuard` ở BE), race (huỷ ∥ thanh toán ∥ SLA ∥ tự hoàn tất), lộ thông tin (log/audit/email), migration an toàn.
- [ ] **7.3 Checklist triển khai (đưa cho chủ dự án).**
  1. Danh sách migration mới (liệt kê theo thời gian) + `migration:check` xanh; **sao lưu `pg_dump` trước**; **KHÔNG** dùng `--with-demo-data` (xoá dữ liệu thật).
  2. **Backend và web quản trị lên CÙNG đợt** (FE cũ đổi TK bị 400 — an toàn nhưng chủ shop không đổi được TK). Storefront lên cùng đợt nếu có đổi hợp đồng thanh toán/huỷ (1.3, 3.1).
  3. `perms:sync` (mã quyền mới: `supplier.payout.approve`…, theo catalog); setting mới có giá trị mặc định an toàn: `payout.auto_enabled=false`, `refund.auto_max_amount`, hạn SLA **chưa bật** cho tới khi chủ dự án quyết ngày bật (G72).
  4. Env production: khoá PayOS thu + **chi** (chưa kiểm với PayOS thật — chữ ký lệnh chi theo tài liệu), webhook trỏ `https://<api>/api/v1/payments/payos/webhook`; xoay khoá PayOS từng lộ.
  5. Kiểm sau deploy chỉ bằng đường không cần đăng nhập (health, danh mục, 401 ở route bảo vệ, CORS); `docker compose up -d --force-recreate caddy` nếu Caddyfile đổi.
  6. Rollback: code rollback **không đủ** nếu có migration phá cấu trúc — phải `pg_restore` từ bản sao lưu.
- [ ] **7.4 Việc CHỦ DỰ ÁN phải làm trước PLAN-0037** (phiên chỉ nhắc, không tự làm): đổi mật khẩu tài khoản mẫu (admin, kế toán, CSKH, shop T + nhân viên — G71); TK ngân hàng shop T = TK của người thử; nạp quỹ PayOS; `payout.auto_enabled=false`; chốt ngày bật SLA; sao lưu DB.
- [ ] **7.5 Dọn môi trường (an toàn).** Dừng API/worker/mock/dev server (theo cổng 4030/4020/3401/3402); `docker rm -f fitly-audit-db fitly-audit-redis`; **gỡ junction trước** (`cmd /c rmdir D:\fitly-snap\be\node_modules`, `…\fitly-e2e\<app>\node_modules`), xác nhận `node_modules` thật còn (`Test-Path …\eco_backend\node_modules\@nestjs`), rồi mới `Remove-Item -Recurse D:\fitly-snap, D:\fitly-e2e`; xoá `eco_backend/uploads` nếu API cục bộ tạo ra; trả viewport trình duyệt (`resize_window desktop`).

### Tầng 8 — Để sau (không chặn E2E tiền thật; làm nếu còn sức, thứ tự gợi ý)
- [ ] **8.1 WP-10 đối chiếu tiền hằng ngày (PLAN-0034)** — cần cho **E2E-10**; nếu chưa làm thì E2E-10 đối chiếu tay bằng bảng biên bản PLAN-0037 §7 (ghi rõ trong báo cáo).
- [ ] **8.2 WP-08 `expectedTotal` (CK-05)** + rủi ro COD khách (PLAN-0032). — `expectedTotal` + 409 `ORDER_PRICE_CHANGED` ĐÃ xong (CK-05 ✔ 2026-10-27, giao diện đã kiểm); còn lại: rủi ro COD khách.
- [ ] **8.3 WP-06 phần còn lại (PLAN-0030):** bù trừ ví COD ↔ kỳ chi (STL-16), nợ quá hạn, rút cọc/đóng shop, sao kê.
- [ ] **8.4 PLAN-0031 §2.5–2.6:** leo thang đơn `shipping` > 20 ngày (SHP-08), phát hiện né hoa hồng COD.
- [ ] **8.5 WP-04/05 còn lại**, WP-09 đổi trả đợt 2, **WP-00 đầy đủ** (đưa harness thành `npm run smoke`/`scripts/test-env`, bỏ thủ thuật `renameCodes` trong `t05b.mjs`).

## 6. Danh sách ✘ được phép còn lại khi kết thúc phiên
Chỉ các mã thuộc Tầng 8: CK-05 (8.2) và mọi mã nêu ở 8.3–8.4 nếu có. Mã nào khác còn ✘ ⇒ ghi lý do trong báo cáo, **không** đánh dấu ✔ giả.

## 7. Định nghĩa "xong" mỗi tầng (kiểm trước khi sang tầng sau)
1. BE: `npm run lint` · `npm run check:boundaries` · `npx tsc --noEmit` · `npm test` (toàn bộ, hiện 1967/1967 — không giảm) · `migration:check` nếu có migration.
2. Mọi mã kịch bản của tầng có test đơn vị `it('[MÃ] …')` hoặc bài harness; riêng lỗi đồng thời/khoá phải kiểm trên **Postgres thật** (harness), không chỉ DB giả (jest dùng DB giả — nó **không** bắt được deadlock; đo `pg_stat_database.deadlocks`).
3. `run-all.sh` không có mã ✔ → ✘; các ✘ của tầng chuyển ✔.
4. Docs cập nhật cùng thay đổi (§1.4). FE chỉ làm ở Tầng 6 (sau đồng bộ API).

## 8. Báo cáo cuối phiên (mẫu — PLAN-0023 §8)
Nêu: tầng đã xong / dừng ở đâu · file đã sửa (nhóm theo repo) · migration mới (tên + mục đích) · setting/quyền mới · kết quả `verify` từng repo · kết quả `run-all.sh` (✔/✘/ℹ + so baseline) · việc chưa làm + lý do · "Quyết định phát sinh" · rủi ro/triển khai cần lưu ý · xác nhận đã dọn môi trường. **Không** báo "xong" nếu `verify` đỏ hoặc có ✔ → ✘.

## 9. Theo dõi tiến độ (phiên cập nhật — tick khi XONG, ghi ngày)

| Tầng | Trạng thái | Ghi chú |
|---|---|---|
| 0 Môi trường & baseline | ☑ 2026-10-27 | Dựng bản sao `D:\fitly-snap\be` (không có `.env` thật) + Postgres/Redis tạm + PayOS giả; baseline **290 ✔ · 18 ✘ · 33 ℹ**, 0 hồi quy. Lần chạy đầu lệch (t05 dừng giữa chừng vì lỗi thoáng qua `INVALID_PERIOD`) — chạy lại trên DB sạch thì khớp. |
| 1 Thu tiền vào & hoàn (1.1–1.7) | ☑ 2026-10-27 | 1.1–1.6 xong + kiểm trên Postgres thật; PAY-07b/08/09/10b, REF-04b2 ✘→✔. Migration `20261028090000_payment_received_amount`. FE (nút Thanh toán lại, nhãn `mismatch`) để Tầng 6. |
| 2 Chi trả shop (2.1–2.5) | ☑ 2026-10-27 | Giữ tay (`shop_payout_holds`), kiểm số dư PayOS trước khi gửi + báo kế toán, mở giữ ⇒ 409 kèm lý do, `merged`, chồng kỳ theo shop, `shopName`/`shopCode` ở kỳ + hoàn tiền. Migration `20261028100000_payout_holds_merged`. |
| 2b Vá sót khảo sát (2b.1–2b.3) | ☑ 2026-10-27 | AUD-18/19 tiền đến muộn (webhook luôn 200; hoàn `mismatch` đúng phần chưa hoàn), AUD-20 hoàn COD không bao giờ tự chi, củng cố replay/thanh toán lại đồng thời. t09 **36/36 ✔** trên Postgres thật. |
| 3 Xử lý đơn & giao (3.1–3.8) | ☑ 2026-10-27 | Ma trận huỷ + yêu cầu huỷ `packing`, SLA (**mặc định TẮT**, không backfill, rebase), gia hạn giao, điểm vi phạm + cảnh báo khoá, đổi địa chỉ, "Đã nhận hàng", khoá shop tự xử lý đơn mở, hãng + mã vận đơn bắt buộc, COD "chưa nhận" đảo ghi thu, hàng về kho. Migration `20261028110000_order_sla_cancel_requests`, `20261028120000_delivery_proof`. 13 mã ✘→✔; t10 **55/55 ✔** (SQL mới kiểm trên Postgres thật). |
| 4 Thông báo & vận hành (4.1–4.3) | ☑ 2026-10-27 | NTF-03 (không bắn "Đơn mới" cho nhân viên sàn), `/health` 503 khi DB/Redis chết, nhịp tim worker + `/health/worker`, escape HTML email. |
| 5 AUD-03 còn lại (5.1–5.5) | ☑ 2026-10-27 | Email chủ shop khi đổi TK (kiểm trên Redis thật), khớp tên chủ TK ⇒ `pending_verification` + `POST /admin/shops/{id}/bank/verify`, gợi ý Google (`details.googleLinked`), `bankChangeHoldHours`. Migration `20261028130000_shop_bank_verification`. |
| 6 API sync & giao diện (6.1–6.5) | ☑ 2026-10-27 (6.5 một phần) | `api:sync` + `perms:sync` (admin) + `api:sync` (storefront) xong từ backend đã kiểm; kiểu tạm `UpdateMyShopBody` đã xoá; 4 agent FE xong. `verify` xanh ở cả 3 repo. Kiểm trình duyệt 5 vai (kế toán, chủ shop, quản lý, CSKH, khách) — xem docs/13 §13.3; **chưa kiểm:** nhân viên shop thiếu `shop.order.cancel`, 390px, tài khoản Google. |
| 7 Rà soát, triển khai, dọn (7.1–7.5) | ◐ 2026-10-27 | 7.1 ☑ (**409 ✔ · 0 ✘ · 36 ℹ / 445 mã**, 0 hồi quy; baseline `baseline-2026-10-27-final.json`). 7.2 rà soát độc lập, 7.3 checklist triển khai (chủ dự án), 7.4 việc của chủ dự án: CHƯA. 7.5 dọn môi trường: xem báo cáo cuối phiên. |
| 8 Để sau | ☐ | |

## 10. Quyết định đã chốt & quyết định phát sinh

**Đã chốt (đừng hỏi lại, đừng đổi):**
- Thứ tự khoá **ĐƠN → PAYMENT → ví**; webhook/hoàn khoá đơn trước.
- Mã kỳ chi trùng ⇒ hậu tố **chữ** `-B`…`-Z` (tối đa 26 kỳ/shop/ngày), không đổi schema.
- Đổi TK ngân hàng: mật khẩu của **chính người thao tác**, lỗi **400**, `@RateLimit` 10/10 phút, chỉ đòi khi bank thực sự đổi. Giữ chi trả sau đổi TK theo setting `payout.bank_change_hold_hours` (mặc định 72).
- Dự án **demo**: thuế/hoá đơn/pháp lý/dữ liệu cá nhân ngoài phạm vi; mục tiêu là luồng mua–bán end-to-end bằng tiền thật số nhỏ.
- Tên chủ TK so với **tên chủ shop** (`fullName` của owner) — không dùng tên shop.
- Tài khoản Google: gợi ý "Quên mật khẩu" (không thêm cột/migration).

**Phát sinh (phiên ghi tại đây):**
| Ngày | Vấn đề | Quyết định | Lý do |
|---|---|---|---|
| 2026-10-27 | Khách trả HAI LẦN cùng một link (khác `reference`) trên MỘT payment | Hoàn `duplicate_payment` trên CHÍNH payment đó (cap hoàn = max(số phải trả, số thực nhận)); webhook đầu sau khi return/poll đã ghi `paid` là CÙNG khoản (không hoàn) | Tránh hoàn nhầm khi return/poll thắng webhook |
| 2026-10-27 | Chỉ mục UNIQUE `(type, provider_ref)` của `payment_transactions` | Hàng `payos_webhook` đầu giữ `providerRef = mã PayOS`; các hàng sau mang `<mã PayOS>:<reference>` | jest dùng DB giả không bắt được trùng chỉ mục — lỗi 500 lộ ra khi chạy trên Postgres thật; DB giả nay ném P2002 như Postgres |
| 2026-10-27 | `CONC-07` (2 webhook đồng thời) gửi hai `reference` khác nhau | Sửa bài test: PayOS gửi LẠI cùng một khoản ⇒ cùng `reference` | Hai `reference` khác nhau là hai lần chuyển tiền thật — xử lý như PAY-09 (hoàn khoản thứ hai) |
| 2026-10-27 | Hoàn tay khi lệnh chi PayOS KHÔNG RÕ (AUD-14) | Cờ tên `confirmGatewayNotExecuted` (theo mẫu `markPaid`), không dùng `confirmGatewayNotRefunded` như dòng cũ ở docs/06 | Một tên cờ cho cả kỳ chi và hoàn tiền; docs/06 đã sửa |
| 2026-10-27 | Đơn `confirmed` khách huỷ tức thì; `packing` chỉ gửi YÊU CẦU huỷ (shop xử lý trong `order.cancel_request_hours`, im lặng ⇒ tự chấp nhận) | Khách huỷ thẳng tới `confirmed`; `packing` ⇒ 409 `ORDER_CANNOT_CANCEL` + `details.hint = cancel_request` | Hàng đã đóng gói có chi phí thật; shop có quyền từ chối |
| 2026-10-27 | SLA tự huỷ | Hạn LUÔN ghi, job chỉ chạy khi `order.sla_enabled`=true (mặc định TẮT); không backfill đơn cũ; lần đầu bật/nghỉ > 30 phút ⇒ đẩy hạn đã trễ sang "bây giờ + số giờ" | Điểm an toàn G72 — bật SLA không huỷ hàng loạt |
| 2026-10-27 | Hoàn của đơn COD | KHÔNG BAO GIỜ tự chi (`AUTO_REFUND_EXCLUDED_METHODS`); luôn `requested` chờ kế toán | Tiền mặt chưa chắc đã thu (COD-08b) |
| 2026-10-27 | COD "chưa nhận hàng" (`not_received`) đã báo giao | Đảo ghi thu COD (ví `cod_reversal`), KHÔNG hoàn tiền, khách không cần khai TK nhận hoàn | Khách chưa từng trả tiền |
| 2026-10-27 | Quyền huỷ đơn của shop | Mã MỚI `shop.order.cancel` (chủ shop có sẵn; nhân viên chỉ khi chủ giao) thay vì dùng `shop.order.update` | Huỷ có hậu quả tiền + điểm vi phạm; UI giao quyền đã thêm |
| 2026-10-27 | `/health` khi Redis chết | 503 (như DB chết); worker kiểm riêng ở `/health/worker` (nhịp tim Redis > 60s ⇒ 503) | Redis là điều kiện bắt buộc (cache, rate-limit, hàng đợi) |
| 2026-10-27 | Tên chủ TK lệch tên chủ shop | `bank_status=pending_verification`, kỳ chi `held`; quản lý (`supplier.shop.approve`) xác minh kèm số TK đầy đủ; từ lúc xác minh mới đếm `payout.bank_change_hold_hours` | Chống đổi TK sang người lạ; AUD-03 |
| 2026-10-27 | Gợi ý "Quên mật khẩu" cho tài khoản Google | Chỉ hướng dẫn bằng chữ (không link) | `/forgot-password` nằm sau `GuestGuard` — người đang đăng nhập bị đẩy đi; đổi guard là thay đổi xác thực chung, để chủ dự án quyết |
| 2026-10-27 | Chạy `npm run verify` / việc nặng TRONG LÚC bộ audit đang chạy | KHÔNG làm — làm STL-08d/08e (job Nest chạy bằng `execSync` 120s) hỏng thoáng qua | CPU bị chiếm; chỉ chạy việc nặng khi audit đã DONE |

## 11. Công thức dựng môi trường cô lập (đã chạy thật 2026-10-27; Windows + Git Bash + Docker)

Yêu cầu: Docker chạy được; `node_modules` của `eco_backend` đã cài. Đường dẫn dưới đây dùng `D:\fitly-snap\be` — đổi nếu muốn, nhưng sửa cả `reset-env.sh` (`BE_POSIX`) và `mig-old/prisma.old.config.mjs`.

1. **Bản sao backend KHÔNG có `.env` thật** (PowerShell):
```powershell
$src='D:\Fullstack\eco_fashion\eco_backend'; $dst='D:\fitly-snap\be'; New-Item -ItemType Directory -Force $dst | Out-Null
robocopy $src $dst /E /XD node_modules dist .git uploads .next coverage mig-old /XF *.log .env .env.* /NFL /NDL /NJH /NJS /NP
Copy-Item "$src\.env.example" "$dst\.env"
cmd /c mklink /J "$dst\node_modules" "$src\node_modules"
```
Mỗi lần sửa code ở repo thật: chạy lại `robocopy` (giữ `mig-old`) rồi `npx nest build` trong bản sao.
2. **Postgres (pgvector) + Redis tạm, cổng lẻ:**
```bash
docker run -d --name fitly-audit-db -p 55442:5432 -e POSTGRES_USER=ecofashion -e POSTGRES_PASSWORD=ecofashion -e POSTGRES_DB=ecofashion pgvector/pgvector:pg16
docker run -d --name fitly-audit-redis -p 56389:6379 redis:7-alpine
```
3. **Migration ở mức dump → nạp dữ liệu mẫu → migration đầy đủ → quyền → build** (trong `D:\fitly-snap\be`, Git Bash):
```bash
export EF_DATABASE_URL="postgresql://ecofashion:ecofashion@localhost:55442/ecofashion" EF_REDIS_URL="redis://localhost:56389" EF_DB_CONTAINER=fitly-audit-db EF_REDIS_CONTAINER=fitly-audit-redis
mkdir -p mig-old/migrations
node -e "const fs=require('fs');const m=require('./scripts/db/demo-data/manifest.json');for(const d of m.appMigrations)fs.cpSync('prisma/migrations/'+d,'mig-old/migrations/'+d,{recursive:true});fs.copyFileSync('prisma/migrations/migration_lock.toml','mig-old/migrations/migration_lock.toml')"
printf 'export default { schema: "D:/fitly-snap/be/prisma/schema", migrations: { path: "D:/fitly-snap/be/mig-old/migrations" }, datasource: { url: process.env.EF_DATABASE_URL } };\n' > mig-old/prisma.old.config.mjs
npx prisma migrate deploy --config mig-old/prisma.old.config.mjs
npx ts-node -T -r tsconfig-paths/register scripts/db/restore.ts --yes
npx prisma migrate deploy
npm run perms:sync
npx nest build
```
(Dump `ecofashion-demo.dump` ở mức migration cũ hơn repo ⇒ phải dùng thư mục `mig-old` chỉ gồm migration trong `manifest.json`; `db:restore` kiểm khớp phiên bản. Với môi trường MỚI, bước 3 chỉ cần tạo `mig-old` + `nest build` là đủ cho `reset-env.sh` ở bước 4 — script đó tự tạo lại DB và nạp dữ liệu mẫu; các lệnh `migrate/restore/perms` ở trên dùng khi muốn dựng tay từng bước.)
4. **PayOS giả + API + worker:** (`E2E_PW_*` do bạn export, lấy từ file seed — không ghi vào repo)
```bash
cd /d/Fullstack/eco_fashion/eco_backend/docs/plans/assets/e2e-audit
(nohup node mock-payos.mjs > /tmp/mock.log 2>&1 &)
BE_POSIX=/d/fitly-snap/be ./reset-env.sh        # dựng lại DB sạch + bật API :4030 + worker (cấu hình cô lập auditenv.sh)
```
5. **Chạy bộ audit** (một driver):
```bash
export E2E_PW_ADMIN=… E2E_PW_NHANVIEN=… E2E_PW_KHACH=… E2E_PW_VENDOR=…
REG_DIR=/tmp/reg BE_DIR=D:/fitly-snap/be ./run-all.sh
# đọc tiến độ: cat /tmp/reg/progress.log ; kết quả: /tmp/reg/out-*.json  (≈ 5 phút)
```
6. **Bản sao FE để thử trình duyệt:** robocopy `fashion_frontend_admin` (hoặc `_user`) → `D:\fitly-e2e\<app>` loại `node_modules .next .git`, junction `node_modules`, rồi `BACKEND_URL=http://localhost:4030 NEXT_PUBLIC_API_URL=http://localhost:4030 npx next dev --webpack -p 3401` (admin) / `-p 3402` (storefront). Backend cô lập đã cho phép CORS `http://localhost:3401,http://localhost:3402`. Khoá đăng nhập bị rate-limit sau nhiều lần ⇒ xoá khoá Redis `ef:rl:*` trong container audit.
7. **Hàng rào đã có:** `jobs.cjs` từ chối chạy nếu `EF_DATABASE_URL`/`EF_REDIS_URL` không phải :55442/:56389; `run-all.sh` từ chối nếu thiếu mật khẩu hoặc đã có driver.

## 12. Tài liệu & file cần chạm (tra nhanh)
- Thiết kế: `PLAN-0025` (§2.1–2.5) · `PLAN-0026` (§2.3–2.5) · `PLAN-0027` (§2.1–2.6) · `PLAN-0028` · `PLAN-0029` · `PLAN-0031` (§2.1–2.4) · `PLAN-0037` (E2E-01…10, §3 chuẩn bị) · luật `docs/10` · kịch bản `docs/11` · vận hành `docs/12` · báo cáo `docs/13`.
- Kế hoạch FE: `fashion_frontend_admin/docs/plans/PLAN-0005-order-lifecycle-go-live.md` · `fashion_frontend_user/docs/plans/PLAN-0012-order-lifecycle-go-live.md` (có sẵn mục "Phát hiện từ audit E2E").
- Mã nóng (khoá theo `PLAN-0023` §6): `order.service.ts`, `shop-order.service.ts`, `payment.service.ts`, `shop-payout.service.ts`, `order-worker.module.ts`, `identity/permission/catalog.ts`, `system/enums/setting-keys.ts` + `system/foundation/system.constants.ts`, admin `src/lib/constants.ts` · `labels.ts`.

## 13. Khảo sát độc lập sau Tầng 0–2 (2026-10-27) — kết quả

Người khảo sát: phiên khác với phiên làm Tầng 0–2, chỉ đọc code + chạy lại trên Postgres thật (bản sao backend dựng lại từ **mã nguồn hiện tại**, DB sạch).

### 13.1 Những gì đã kiểm và ĐẠT
- Backend: `lint` · `tsc --noEmit` · `check:boundaries` xanh; jest **2011/2011** (69 suite); `prisma migrate diff` trên DB đã áp đủ migration: **không lệch schema**. Hai migration mới (`20261028090000_payment_received_amount`, `20261028100000_payout_holds_merged`) chỉ thêm cột/bảng/index và nới CHECK — an toàn deploy.
- Bộ audit đầy đủ (`run-all.sh`): **304 ✔ · 12 ✘ · 30 ℹ trên 346 mã**; `compare-baseline.cjs` so cả baseline gốc lẫn baseline sau Tầng 2: **0 hồi quy**; 9 mã cải thiện (PAY-07b/08/09/10b, REF-04b2, STL-04d/06/12b2/13). 12 ✘ còn lại đều đúng danh sách dự kiến: CK-05, Tầng 3 (CAN-03/07/08/14, FUL-04a, SHOP-01c/f, SHP-04, SHP-09, COD-08b), NTF-03.
- Khảo sát ngoại lệ (t09, 31/36): trả thiếu rồi trả nốt trước hạn; trả thừa → huỷ; trả hai lần cùng link → huỷ (hoàn = 2 × đơn); ba webhook giống hệt đồng thời; trả thiếu → thanh toán lại → trả đủ link mới; trả thiếu rồi trả vượt; gia hạn hạn đơn khi thanh toán lại; poll mất webhook (không cộng dồn lần hai); tự chi hoàn (đúng 1 lệnh PayOS/khoản, chạy lại không gửi thêm, vượt ngưỡng/ngưỡng 0 không tự chi); giữ tay (thiếu lý do 400, CSKH/chủ shop 403, giữ lần hai kể cả đồng thời 409, mở giữ tự đẩy kỳ đi tiếp, kỳ `held` khi chạy kỳ **và khi job chi tự động chạy**); thiếu số dư PayOS ⇒ kỳ `pending` + lý do + không gọi PayOS, nạp quỹ rồi gửi lại được; kỳ `merged` không retry/mark-paid/approve/release được; API trả `shopName`/`shopCode` cho kế toán.
- Storefront (chưa sửa ở Tầng 1–2) **tương thích** với `paymentUrl: null` (`hasLivePaymentLink` → không có link còn hạn thì gọi `POST /payments/payos/retry`).

### 13.2 Vấn đề CÒN LẠI (mới phát hiện — đã đưa vào Tầng 2b)
| Mã | Mức | Vấn đề | Bằng chứng | Hướng sửa |
|---|---|---|---|---|
| **AUD-18** | **P1 — tiền kẹt + webhook 500 mãi** | Khách **trả thiếu → đơn huỷ/hết hạn (đã tạo hoàn `mismatch` cho phần đã nhận) → khách chuyển nốt phần còn lại**: `settlePayosOnce` đẩy payment `cancelled` lên `paid`, `OrderService.onPaid` (nhánh "đến muộn sau huỷ") xin hoàn **cả `order.total`** > trần còn lại ⇒ `PAYMENT_REFUND_EXCEEDS` ⇒ rollback ⇒ webhook **HTTP 500** (PayOS gửi lại vô hạn); phần tiền đã về PayOS **không được ghi** (`received_amount` vẫn 100k) | t09 **MNY-02b/02c** (log API: "Số tiền hoàn vượt phần còn lại (449.000 ₫)") | Tầng 2b.1 |
| **AUD-19** | **P1 — tiền kẹt** | Payment đã huỷ + khách chuyển **thêm** một khoản vẫn CHƯA đủ (hoặc chuyển khoản đầu tiên vào link của đơn đã huỷ): chỉ cộng `received_amount` + báo kế toán ("tiền đã nhận sẽ được hoàn" — **sai**), **không** tạo/cộng dồn yêu cầu hoàn. `refundReceivedOfCancelled` chỉ chạy lúc huỷ và có guard "đã có mismatch thì bỏ qua" | t09 **MNY-08** (nhận 150k, hoàn 100k), **MNY-09** (nhận 100k, **0** hoàn) | Tầng 2b.1 (cùng chỗ sửa với AUD-18) |
| **AUD-20** | **P0 cho tới khi xong 3.6 (hoặc tắt tự chi)** | **Tự chi hoàn × lỗi COD-08b còn mở:** khoản hoàn "Đổi trả: Chưa nhận được hàng" của đơn **COD** (khách chưa từng trả tiền mặt) đủ điều kiện tự chi (`method=gateway`, có TK khách khai, ≤ `refund.auto_max_amount` mặc định **2.000.000**) ⇒ **job tự gửi lệnh chi PayOS** (đã thấy 308.000đ ở `processing`/`submitted`). Tức Tầng 1.5 biến G19 thành **dòng tiền ra tự động** | Truy vấn DB sau t04+t09: refund 308000, `pay_method=cod`, `gateway_status=submitted` | Tầng 2b.2: loại COD khỏi tự chi cho tới khi 3.6 xong; **giữ `refund.auto_max_amount=0` ở môi trường thật** cho tới lúc đó |
| AUD-21 | P3 (củng cố) | Webhook THIẾU `reference` + `transactionDateTime` (PayOS thật luôn có) bị cộng dồn khi gửi lại ⇒ hai webhook nửa tiền ⇒ `paid` | t09 MNY-03a | 2b.3 |
| AUD-22 | P3 (UX) | Hai lần bấm "Thanh toán lại" đồng thời: một lần 200, một lần **409 `COMMON_DUPLICATE`** (đụng chỉ mục "một payment chờ/đơn") — đúng bất biến nhưng khách thấy lỗi; nên trả link của payment đang chờ | t09 RTY-02b | 2b.3 |
| AUD-23 | P2 (đã thuộc Tầng 6) | FE quản trị chưa có nhãn cho trạng thái kỳ `merged` và loại hoàn `mismatch` (`lib/labels.ts` chỉ tới `settled`) — màn đối soát sẽ hiện mã thô | đọc `labels.ts` | Tầng 6.2 |

### 13.3 Việc vệ sinh đã xử lý trong lúc khảo sát
- Hàng "Tầng 0" của §9 có ký tự điều khiển (`\f`, `\b`) làm hỏng đường dẫn `D:\fitly-snap\be` — đã sửa. (Bài học: đừng đưa chuỗi có `\f \b \e` vào chuỗi JS/shell thường — dùng `Write`/`Edit` thay vì nhúng trong script.)
- Phiên trước **không dọn môi trường** (`D:\fitly-snap\be` + junction `node_modules` còn đó, 2 container `fitly-audit-*` ở trạng thái Exited) — hợp lệ vì chưa tới Tầng 7, nhưng nhắc: khi dừng giữa chừng vẫn nên dọn (§7.5) vì bản sao dễ lệch mã nguồn. Phiên khảo sát này đã dọn sau khi xong.
- Bản sao của phiên trước dùng `.env.example` (không chứa khoá thật) — đã kiểm bằng so sánh băm, **không** trùng `.env` thật.

### 13.4 Thứ tự khuyến nghị cho phiên tiếp theo
1. **Tầng 2b** (AUD-18/19/20) — nhỏ về số dòng, quan trọng về tiền; t09 đã sẵn là bộ kiểm.
2. Tầng 3 (xử lý đơn/giao, gồm 3.6 sửa COD-08b — sau đó mới gỡ ngoại lệ COD khỏi tự chi).
3. Các tầng còn lại theo §5.
