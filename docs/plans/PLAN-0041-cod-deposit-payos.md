# PLAN-0041 — Nạp cọc COD qua PayOS (ví đặt cọc của gian hàng)

> Status: **Draft — sẵn sàng giao cho agent code** (2026-11-03) · Chưa có dòng code nào được viết
> Owner: Agent điều phối (chạy harness/verify/git theo luật dự án) + các agent code (mỗi gói WP một agent — xem §11)
> Related Phase: Go-live — tiền vào ví cọc COD (nối tiếp PLAN-0020 ví cọc, PLAN-0025/0040 an toàn tiền vào)
> Related Roadmap: `docs/04_ROADMAP.md`
> Repo bị đụng: `eco_backend` (chính) · `fashion_frontend_admin` (giao diện cổng chủ shop + cổng sàn). KHÔNG đụng `fashion_frontend_user`.

> Luật ownership: sàn đa gian hàng — `shopId` của vendor CHỈ lấy từ ngữ cảnh phiên (`@CurrentShop()`), không từ URL/body; nhân viên sàn phân quyền theo `supplier.*`, vendor theo `shop.*`. Plan này KHÔNG thêm mã quyền mới.

---

## 0. Luật phiên cho MỌI agent code (đọc trước khi mở file nào)

1. Chỉ sửa/tạo ĐÚNG các file ghi trong gói WP của mình (§11). File ngoài danh sách = dừng và báo, không tự sửa. Đụng file của gói khác = bug.
2. KHÔNG chạy: `git` lệnh ghi (commit/push/branch/stash/reset/checkout), `npm run build|verify|lint` toàn repo, `prisma migrate *`, docker, harness (`docs/plans/assets/e2e-audit/*`), dev server (`next dev`, `nest start`). KHÔNG đọc/in `.env*`, khoá PayOS. KHÔNG gọi mạng ngoài. Chỉ chạy lệnh kiểm GHI TRONG WP của mình (`npx eslint <file>`, `npx tsc --noEmit`, `npm test -- <đường dẫn>`); riêng WP-1 được chạy `npx prisma generate` (sinh `src/generated/prisma`, thư mục này bị `.gitignore`).
3. Cây làm việc đã có HÀNG TRĂM thay đổi chưa commit của các phiên khác (CRLF, `autocrlf`). Chỉ dùng công cụ Edit (đọc file bằng Read trước); KHÔNG ghi đè cả file bằng script/`Write` nếu file đã tồn tại; KHÔNG "dọn" file lạ; kiểm `git diff --stat` không phình bất thường.
4. Code: TypeScript strict, không `any`, không `console.*` (dùng `Logger` của Nest, thông điệp log TIẾNG VIỆT, định danh kỹ thuật tiếng Anh), comment khối tiếng Việt giải thích VÌ SAO (luật AGENTS.md "Code Comment Rule"). Tiền: `bigint`/`vnd()` (`@common/utils/money`), DB `numeric(14,0)` truyền vào Prisma bằng CHUỖI (`amount.toString()`), không float.
5. **Bài học bắt buộc nhớ** (nguồn: PLAN-0025, PLAN-0040 §3):
   - Thứ tự khoá toàn cục: **ĐƠN → PAYMENT → KHOẢN NẠP PayOS (`shop_cod_topups`) → VÍ**. Luồng nạp cọc chỉ dùng `KHOẢN NẠP → VÍ`. TUYỆT ĐỐI không khoá ví rồi mới khoá khoản nạp; không đụng ĐƠN/PAYMENT từ luồng nạp.
   - Trong một transaction Postgres, một lỗi UNIQUE (`P2002`) làm HỎNG cả transaction (`25P02`) — KHÔNG `try { create } catch (P2002) { tiếp tục }` bên trong `$transaction`. Kiểm trùng bằng đọc TRƯỚC dưới khoá; chỉ mục UNIQUE là chốt cuối (vi phạm ⇒ rollback + lỗi nổi lên).
   - Jest dùng DB giả: không bắt được deadlock/trùng chỉ mục thật. Mọi thứ liên quan khoá/đồng thời PHẢI kiểm trên Postgres thật bằng harness `t11` (điều phối viên chạy).
   - Không gọi mạng (PayOS) trong transaction. Thông báo gửi SAU commit, best-effort (lỗi thông báo không được làm rollback tiền).
   - Hậu tố mã/khoá đi vào khoá idempotent KHÔNG dùng số trần (xung đột `<mã>-<lần thử>`); khoá sổ cái của plan này là chuỗi có tiền tố cố định `payos-topup:`.
   - Khoá `audit` bị che nếu tên chứa `password|token|secret|otp|cvv|card|api_key|apikey|hash` (hàm `sanitizeSummary`, `src/common/audit/audit.ts`) — đặt tên khoá audit tránh các chuỗi đó (vd KHÔNG dùng `discardedAmount`, `cardinal`…).
   - Mảng hằng `readonly` (vd `TOPUP_OPEN_STATUSES`) đưa vào `where: { status: { in: … } }` của Prisma PHẢI trải ra `[...TOPUP_OPEN_STATUSES]` — Prisma không nhận `readonly string[]` (mẫu: `AUTO_REFUND_EXCLUDED_METHODS` ở `payment.service.ts` ~84 và ~599).
   - Webhook hợp lệ chữ ký luôn trả **200** (trừ lỗi hệ thống 500 để PayOS gửi lại). Chữ ký sai ⇒ 401 (đã có).
6. **File nóng** (nhiều phiên cùng sửa; chỉ gói ghi tên mới được đụng, sửa tối thiểu đúng chỗ nêu): `src/modules/payment/payment/payment.service.ts` · `src/modules/payment/shop-wallet/shop-wallet.service.ts` · `src/modules/payment/foundation/payment.constants.ts` · `src/modules/system/enums/setting-keys.ts` · `src/modules/system/foundation/system.constants.ts` · `docs/06_FE_CONTRACT.md` · `docs/02_MODULE_MAP.md` · admin FE `src/lib/constants.ts` · `src/lib/labels.ts`.
7. Gặp điều không rõ / tên hàm không khớp code thật ⇒ DỪNG và báo (kèm file:dòng), không đoán.

---

## 1. Mục tiêu · Bối cảnh · Phạm vi

### 1.1 Mục tiêu
Hiện chủ shop nạp cọc COD bằng chuyển khoản tay: gửi yêu cầu (số tiền + mã giao dịch) → kế toán đối chiếu sao kê → duyệt tay (`POST /admin/wallet-deposits/:id/approve`, PLAN-0020). Chậm, tốn người, dễ sai. Plan này **thêm** đường nạp qua PayOS: chủ shop nhập số tiền → hệ thống tạo link PayOS → chủ shop trả → webhook/job dò xác nhận → **ví tự được ghi có đúng số tiền thực nhận, đúng một lần**, COD mở ngay (nếu ví ≥ `wallet.min_balance_for_cod`). Luồng nạp tay cũ GIỮ NGUYÊN làm dự phòng (khi PayOS chưa cấu hình / tạm tắt).

Tiêu chí "xong": mọi tình huống ở bảng §6.6 chạy đúng trên Postgres thật (harness `t11`), bất biến §10 đúng sau bài, 0 deadlock, `npm run verify` xanh ở BE + admin, thử trình duyệt đủ vai (§9.3).

**Luồng một nhìn (chi tiết ở §6):**
1. Chủ shop nhập số tiền → `POST /shop/wallet/topups` → dòng `creating` → gọi PayOS tạo link (NGOÀI transaction) → dòng `pending` (+ `checkoutUrl`) → FE chuyển sang trang PayOS.
2. Chủ shop trả (có thể thiếu / thừa / nhiều lần) → PayOS gửi webhook ký HMAC tới `POST /payments/payos/webhook` (CHUNG URL với đơn hàng).
3. `handlePayos`: mã không phải đơn hàng → `ShopWalletTopupSettleService.settleWebhookIfTopup` → khoá dòng nạp → ghi biên nhận (UNIQUE theo `reference`) → mục tiêu = `max(Σ biên nhận, luỹ kế PayOS)` → ghi có phần chênh vào ví (khoá ví; UNIQUE `ref_key`) → cập nhật dòng nạp → commit → thông báo.
4. Mất webhook / khách mở trang quay lại: job 2 phút + `GET` làm mới hỏi PayOS (`getPaymentLink`) → cùng hàm ghi nhận (nguồn `poll`).
5. Hết hạn / huỷ: job (hoặc PayOS báo) đóng link; tiền về SAU VẪN được ghi có.
6. Ví ≥ `wallet.min_balance_for_cod` ⇒ COD mở (cơ chế cũ, không đổi).

### 1.2 Bối cảnh (đã đọc code thật)
- Ví cọc = sổ cái tiền CỦA SHOP: `payment.shop_cod_wallets` (số dư, có thể âm) + `payment.shop_cod_wallet_transactions` (chỉ thêm; `UNIQUE(shop_id, type, order_code)`; mọi ghi qua `ShopWalletService.post` sau `lockWallet` — `shop-wallet.service.ts` ~229–243). COD mở khi `balance ≥ wallet.min_balance_for_cod` (mặc định 200.000). Hiện **không có đường rút tiền khỏi ví** (grep `withdraw|COD_WALLET_TOPUP` trong `src` = 0) — tiền nạp vào chỉ để bảo đảm hoa hồng COD.
- PayOS thu tiền đơn hàng đã có đủ bài học: webhook là nguồn sự thật (`handlePayos` ~641), `settlePayosOnce` ~703 khoá ĐƠN → PAYMENT, khử trùng theo `reference` (`eventRefOf` ~361), `received_amount` cộng dồn, job dò `reconcilePendingPayos` ~546 (CAS `last_checked_at`), tiền về muộn `settleLateMoney` ~802, `UNIQUE(type, provider_ref)` của `payment_transactions` (`uq_payment_transactions_provider_ref`).
- Mã PayOS đơn hàng: `PayosService.generateOrderCode()` = `Date.now()*1000 + randomInt(1000)` ≈ 1,8e15 (`payos.service.ts` ~34). Webhook tra payment đơn qua `paymentTransaction(type=create_url, providerRef=<mã>)` (`findPayosPayment` ~687).
- Quyền đã có sẵn, đủ dùng: `shop.wallet.read`, `shop.wallet.deposit_request` (chỉ chủ shop — `shop_staff` KHÔNG có cả hai), `supplier.wallet.read` (quản lý, kế toán), `supplier.wallet.approve` (kế toán, admin), `supplier.wallet.adjust` (admin). (`src/modules/identity/permission/catalog.ts` ~127–131, 206, 237.)

### 1.3 Trong phạm vi
1. Bảng khoản nạp PayOS + bảng biên nhận (mỗi khoản tiền PayOS báo về) + 2 cột/1 loại dòng mới ở sổ cái (migration chỉ THÊM).
2. API vendor: tạo link / xem / danh sách / huỷ / tra theo mã PayOS (cho trang quay lại); API sàn: danh sách + chi tiết (xem-only).
3. Ghi có ví qua MỘT hàm duy nhất, idempotent bằng chỉ mục UNIQUE; xử lý đủ/thiếu/thừa/trùng/muộn/mất webhook/đồng thời.
4. Webhook định tuyến (đơn hàng trước, nạp cọc sau, lạ ⇒ 200 bỏ qua); job dò + hết hạn + quét đuôi 72 giờ.
5. Thông báo (chủ shop khi ghi có; kế toán khi bất thường), nhãn tiếng Việt.
6. Giao diện admin FE: `/vendor/wallet` (nút "Nạp qua PayOS" + trang quay lại) và `/shop/wallets` (tab xem-only "Nạp qua PayOS").
7. Setting mới (cờ bật/tắt, trần mỗi lần, hạn link), env mới `EF_ADMIN_URL`, tài liệu, harness `t11`, test jest.

### 1.4 Ngoài phạm vi (KHÔNG làm, KHÔNG "tiện thể")
- **Rút cọc / hoàn khoản nạp cho shop / đóng shop tất toán** (PLAN-0030 §2.3, Tầng 8.3). Khi làm rút cọc phải chặn rút về TK ngoài TK ngân hàng đã xác minh của shop (ghi ở §12 rủi ro).
- Bù trừ ví ↔ kỳ chi trả (`COD_WALLET_TOPUP`), tự nạp từ kỳ chi.
- Tự trừ ví khi PayOS đảo/hoàn một giao dịch đã báo thành công (kế toán chỉnh tay `adjust` âm có lý do).
- Đổi/xoá luồng nạp tay hiện có (chỉ THÊM nhánh 409 khi duyệt/từ chối nhầm id khoản PayOS).
- Đổi `PaymentService.handlePayosReturn` (route công khai của storefront) — khoản nạp dùng endpoint có đăng nhập riêng.
- Thêm mã quyền, đổi preset vai, đổi catalog quyền; sửa `fashion_frontend_user`.
- Seed dữ liệu demo cho khoản nạp PayOS (dữ liệu vận hành gắn mã PayOS thật — theo "Seed Rule" không seed; bảng trống là hợp lệ).
- Hạn mức ngày/tháng cho nạp; xác minh webhook bằng gọi ngược PayOS API trước khi ghi có (hardening — ghi ở §13 câu hỏi).

---

## 2. Quyết định đã chốt (kèm lý do & đã đánh giá lại)

| # | Quyết định | Lý do / đánh giá lại |
|---|---|---|
| D1 | **Bảng MỚI** `payment.shop_cod_topups` (+ `shop_cod_topup_receipts`), KHÔNG tái dùng `shop_cod_deposits` | `shop_cod_deposits` mang ngữ nghĩa "yêu cầu chờ KẾ TOÁN DUYỆT": CHECK `status IN (pending, approved, rejected)`, `amount > 0`, `transfer_ref NOT NULL`, chỉ mục UNIQUE một phần theo `lower(transfer_ref)`; và MỌI nơi đọc nó coi `pending` = chờ duyệt (`getWallet.pendingDeposit`, `requestDeposit` "một yêu cầu chờ", tab "Chờ duyệt" của kế toán, FE `DEPOSIT_STATUS_META[status]` — gặp trạng thái lạ là `undefined.tone` ⇒ màn trắng). Trộn vào sẽ buộc sửa mọi nơi đó và có nguy cơ làm đổi hành vi luồng tay (đã cam kết KHÔNG đổi). Máy trạng thái PayOS (7 trạng thái, tiền về nhiều lần, hết hạn, trễ) và khoá UNIQUE khác hẳn. Bảng mới: migration chỉ THÊM bảng, luồng tay nguyên vẹn. Hệ quả: phía sàn thêm tab riêng xem-only; duyệt/từ chối nhầm id khoản PayOS ⇒ 409 `WALLET_DEPOSIT_PAYOS_NOT_MANUAL` (D16). |
| D2 | **Công thức ghi có**: `mục tiêu = max(Σ biên nhận webhook, luỹ kế PayOS báo ở lần dò gần nhất)`; ghi có `mục tiêu − đã ghi có`; không bao giờ giảm | Hai nguồn đều là CẬN DƯỚI của tổng tiền thật đã nhận (webhook từng khoản có `reference` — khử trùng chính xác theo khoản; poll/return báo luỹ kế của link). `max` của hai cận dưới bảo đảm: replay không cộng, poll-trước-webhook-sau không cộng đôi, webhook-trước-poll-sau không cộng đôi, mất webhook vẫn được bù từ luỹ kế. KHÔNG bắt chước heuristic "webhook đầu tiên sau poll là cùng khoản" của đường đơn hàng (nó có thể cộng dư khi poll thấy 2 khoản rồi 2 webhook đến sau). |
| D3 | **Ghi có đúng số THỰC NHẬN** cho mọi tình huống thừa/thiếu/trùng/muộn; KHÔNG tạo hoàn tiền | Đây là tiền của CHÍNH shop gửi vào ví của chính shop — không có "bên thứ ba bị thiệt" như khách thanh toán đơn, nên không cần quy trình hoàn; hoàn sẽ tạo thêm dòng tiền ra phải kiểm soát. Đã đánh giá gian lận/rửa tiền (demo): (a) tiền nạp KHÔNG rút ra được hiện nay (không có đường rút; kỳ chi trả không đụng ví); (b) trần mỗi lần + min + rate-limit + một link hoạt động/shop; (c) mọi khoản lưu `reference` + tài khoản đối ứng (`raw`) cho kế toán; (d) khoản BẤT THƯỜNG (thừa, trùng, muộn, kết thúc thiếu) báo kế toán. **Trường hợp PHẢI xử lý tay (ngoài hệ thống, kế toán + chỉnh ví `adjust` âm có lý do + hoàn tay qua PayOS dashboard)**: shop báo chuyển nhầm/đòi lại tiền; PayOS đảo/hoàn một giao dịch đã báo thành công; nghi tiền bẩn. Hệ thống KHÔNG tự trừ ví vì PayOS "báo thấp hơn" ở lần dò (có thể chỉ là PayOS trễ). |
| D4 | **Mã PayOS cho nạp cọc ở dải riêng** `5.000.000.000.000.000 ≤ mã < 6.000.000.000.000.000`: `5e15 + (Date.now() % 1e12) * 1000 + randomInt(1000)`; DB CHECK `payos_order_code ~ '^[5-8][0-9]{15}$'` + UNIQUE | Mã đơn hàng ≈ 1,8e15 (< 5e15 đến năm 2127) ⇒ hai dải không giao nhau theo cấu trúc, DB còn chặn mã nạp lệch dải; vẫn ≤ `Number.MAX_SAFE_INTEGER` (9,007e15) nên PayOS nhận được. Webhook: tra payment đơn TRƯỚC (kết quả luôn trống với mã dải 5e15), rồi tra khoản nạp. Trùng mã giữa hai khoản nạp: UNIQUE + thử sinh lại tối đa 5 lần. |
| D5 | Ghi **dòng `creating` TRƯỚC khi gọi PayOS**, gọi PayOS NGOÀI transaction, rồi chốt `pending` | Webhook không thể đến trước khi dòng tồn tại (PayOS chưa biết link). Nếu webhook đến lúc dòng còn `creating` (tạo link xong chưa kịp chốt) vẫn ghi có; bước chốt KHÔNG ghi đè trạng thái đã sang `partial/paid`. PayOS lỗi/timeout ⇒ dòng `failed`, không để link mồ côi thành "đang chờ". |
| D6 | **Mỗi shop tối đa MỘT khoản mở** (`creating|pending|partial`) — chỉ mục UNIQUE một phần `uq_shop_cod_topups_active_per_shop`; tạo lần hai ⇒ trả link cũ còn hạn (`reused:true`, kể cả số tiền khác); link quá hạn chưa quét ⇒ đóng rồi tạo mới; có nút "Huỷ link" | Chốt chặn ở DB chứ không chỉ kiểm trong code. Tạo đồng thời hai request ⇒ một thắng, một bắt `P2002` NGOÀI transaction đã rollback rồi trả dòng đang có. Không khoá ví khi tạo link (D7). |
| D7 | **Thứ tự khoá** `KHOẢN NẠP → VÍ`; đường tạo link KHÔNG khoá ví | Nếu đường tạo giữ khoá ví rồi chèn dòng nạp (chỉ mục "một link/shop" chờ giao dịch của webhook đang giữ dòng nạp cũ) trong khi webhook giữ dòng nạp chờ khoá ví ⇒ vòng chờ ⇒ deadlock. Bỏ khoá ví ở đường tạo + mọi đường ghi có là `KHOẢN NẠP → VÍ` ⇒ không có chu trình. Bọc `retryOnDeadlock` làm lớp phòng thủ. Không đụng thứ tự ĐƠN→PAYMENT→ví hiện có (đường đơn không bao giờ chạm khoản nạp). |
| D8 | **Một hàm ghi sổ duy nhất** cho tiền nạp: `ShopWalletService.creditPayosTopup` → `post`; khoá idempotent mức DB `ref_key = 'payos-topup:<topupId>:<mục tiêu luỹ kế>'` với chỉ mục UNIQUE một phần `uq_shop_cod_wallet_tx_ref_key` + CHECK `chk_shop_cod_wallet_tx_topup` (dòng `topup_payos` phải có `topup_id`, `ref_key`, `amount > 0`) | Mục tiêu luỹ kế tăng NGẶT sau mỗi lần ghi nên mỗi bước ghi có một khoá riêng; hai transaction cùng ghi một bước ⇒ UNIQUE chặn. CHECK `amount > 0` ⇒ "ví không bao giờ giảm vì luồng nạp" là bất biến mức DB. Test quét mã nguồn bảo đảm chỉ có đúng MỘT chỗ `shopCodWalletTransaction.create(` và MỘT chỗ `shopCodWallet.update(` (hàm `post`). |
| D9 | Thông báo gửi **SAU commit, best-effort** | Thông báo lỗi trong transaction (như một số chỗ ở đường đơn) làm rollback cả khoản ghi có ⇒ tiền kẹt nếu lỗi kéo dài. Mất một thông báo chấp nhận được (FE tự cập nhật bằng truy vấn). |
| D10 | Cờ `wallet.payos_deposit_enabled` **mặc định `false`**; cờ chỉ chặn TẠO link mới, KHÔNG chặn ghi có | Theo tiền lệ `payout.auto_enabled`/`order.sla_enabled` (tắt cho tới khi thử PayOS thật). Tắt cờ lúc còn link đang chờ ⇒ tiền về vẫn được ghi có (tiền đã đi thì phải vào sổ). Chủ dự án bật sau khi thử 1 khoản PayOS thật (§12). |
| D11 | `returnUrl = cancelUrl = ${EF_ADMIN_URL}/vendor/wallet/payos-return` (env mới `EF_ADMIN_URL`, mặc định `http://localhost:3001`); trang quay lại hỏi BE bằng endpoint CÓ ĐĂNG NHẬP `GET /shop/wallet/topups/by-order-code/:orderCode` | Mẫu giống storefront (`/checkout/payos-return`: PayOS tự thêm `?code=&id=&cancel=&status=&orderCode=`, FE không tin `status` trên URL). Endpoint có đăng nhập ⇒ lọc theo `shopId` của phiên (shop khác ⇒ 404). Thiếu/sai `EF_ADMIN_URL` ở production ⇒ tính năng nạp trả 503 `WALLET_TOPUP_UNAVAILABLE` (KHÔNG làm app không khởi động được). |
| D12 | Poll đọc `amountPaid` của PayOS **bất kể `status`** (PAID/UNDERPAID/EXPIRED/CANCELLED…) | Trả thiếu là UNDERPAID (không phải PAID); chỉ chờ PAID sẽ bỏ sót tiền đã vào tài khoản. `status` chỉ dùng để quyết định ĐÓNG (CANCELLED/EXPIRED). |
| D13 | Webhook **thiếu cả `reference` lẫn `transactionDateTime`** ⇒ không ghi biên nhận, KHÔNG ghi có, trả 200 + báo kế toán; job/endpoint dò sẽ ghi có theo luỹ kế PayOS (≤ vài phút) | Không phân biệt được "gửi lại" với "chuyển thêm" (AUD-21 của đường đơn). Chọn phía an toàn: chậm vài phút tự lành, không bao giờ cộng dư. PayOS thật luôn có `reference`. |
| D14 | Không tự trừ ví khi poll báo luỹ kế THẤP hơn đã ghi có (chỉ `logger.warn`, không thông báo — tránh spam mỗi 2 phút) | Webhook đã ký là bằng chứng mạnh hơn một lần đọc API có thể trễ; tự trừ có thể làm shop mất COD oan. Đảo/hoàn thật được kế toán phát hiện qua đối chiếu sao kê PayOS (WP-10, ngoài phạm vi) rồi `adjust`. |
| D15 | Giới hạn: tối thiểu `wallet.min_deposit` (500.000 sẵn có); **trần/lần** `wallet.max_topup_amount` (mới, mặc định 50.000.000); hạn link `wallet.payos_topup_expire_minutes` (mới, mặc định 60); rate-limit tạo link 10/10 phút/người | Trần chống nhập nhầm 14 chữ số/lạm dụng; min/max chỉ áp lúc TẠO link (tiền thật về khác số vẫn ghi có đủ). |
| D16 | `POST /admin/wallet-deposits/:id/approve|reject` với id của khoản nạp PayOS ⇒ **409 `WALLET_DEPOSIT_PAYOS_NOT_MANUAL`** (id không có ở cả hai bảng ⇒ 404 như cũ) | Yêu cầu "khoản PayOS không duyệt/từ chối tay được (409 rõ ràng)". Chỉ là nhánh thêm khi `deposit` không tìm thấy. |
| D17 | Không thêm mã quyền; tạo/huỷ link dùng `shop.wallet.deposit_request`, xem dùng `shop.wallet.read`; sàn xem-only dùng `supplier.wallet.read`; thông báo kế toán gửi cho người có `supplier.wallet.approve` | Yêu cầu của chủ dự án: chủ shop tạo, nhân viên shop không có, kế toán/QL chỉ xem. Không cần `perms:sync` (vẫn chạy cho chắc ở Pha 3). |
| D18 | FE gọi API qua `customInstance` (như `use-wallet.ts` hiện có), kiểu chép từ DTO backend; KHÔNG chờ `api:sync` | Để FE chạy SONG SONG với BE. Sau khi BE xong, điều phối viên chạy `api:sync` (cập nhật spec đã commit); chuyển sang hook sinh ra là tuỳ chọn, không bắt buộc. |
| D19 | KHÔNG ghi vào `payment.payment_transactions` / `payments` của đường đơn hàng | Bảng đó khoá theo `payment_id` (FK tới payment đơn) và `UNIQUE(type, provider_ref)` buộc hậu tố mã khoản — bài học đã trả giá ở PLAN-0025/0040. Tương đương cho khoản nạp là `shop_cod_topup_receipts` với `UNIQUE(topup_id, reference)` (biên nhận thứ hai cùng link không cần hậu tố). Tách hẳn nên webhook nạp không thể làm hỏng đối soát/hoàn tiền của đơn. |
| D21 | **PayOS là đường nạp cọc DUY NHẤT của chủ shop** (chủ dự án chốt 2026-11-03: nạp tay và nạp PayOS đều là chuyển khoản nên hai nút gây khó hiểu); cờ `wallet.payos_deposit_enabled` mặc định **BẬT** | Màn chủ shop chỉ còn một nút "Nạp tiền vào ví"; PayOS tắt/chưa cấu hình ⇒ thông báo "tạm thời không khả dụng", không còn đường dự phòng. Backend + màn sàn của luồng tay GIỮ NGUYÊN để xử lý các khoản đã gửi từ trước (không xoá bảng/route). Thử một khoản nhỏ qua PayOS thật trước khi mở cho chủ shop vẫn là khuyến nghị (§12.5). |
| D20 | Hết hạn **không đóng ngay** khi quá `expires_at`: job hỏi PayOS trước (ghi có nếu có), chỉ đóng khi `expires_at + 2 phút` đã qua (hoặc PayOS báo EXPIRED/CANCELLED); quét thêm "đuôi" 72 giờ cho khoản `expired|cancelled` | Lệch đồng hồ + tiền về sát giờ. Tiền về sau khi đóng VẪN được ghi có (D3) nên đóng sớm/muộn không làm mất tiền — chỉ ảnh hưởng hiển thị. |

---

## 3. Thiết kế DB

### 3.1 Migration

Tên: `prisma/migrations/20261103090000_wallet_payos_topup/migration.sql` (ngày thực hiện 2026-11-03; nếu thư mục tên này đã có thì tăng giờ — KHÔNG sửa migration cũ). Quy ước CRLF: file mới viết LF cũng được (autocrlf). **Chỉ THÊM** bảng/cột/chỉ mục + NỚI một CHECK (cùng kiểu đã làm ở `20261028120000_delivery_proof`) — chạy lại an toàn, code cũ vẫn chạy.

```sql
-- wallet_payos_topup (PLAN-0041) — nạp cọc COD qua PayOS:
--  * payment.shop_cod_topups          khoản nạp (link PayOS do chủ shop tạo); `received_amount` = tổng đã GHI CÓ vào ví cho khoản này.
--  * payment.shop_cod_topup_receipts  mỗi khoản tiền PayOS báo về qua webhook (khử trùng theo `reference`).
--  * payment.shop_cod_wallet_transactions: thêm cột topup_id + ref_key, loại dòng mới 'topup_payos' (+ CHECK), chỉ mục UNIQUE một phần theo ref_key.
-- Chỉ thêm bảng/cột/chỉ mục + nới CHECK ⇒ chạy lại an toàn. KHÔNG sửa migration cũ.

CREATE TABLE IF NOT EXISTS "payment"."shop_cod_topups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "payos_order_code" VARCHAR(20) NOT NULL,
    "payment_link_id" VARCHAR(64),
    "checkout_url" VARCHAR(500),
    "qr_code" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'creating',
    "received_amount" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "polled_amount" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "paid_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,
    "last_checked_at" TIMESTAMPTZ,
    "last_gateway_status" VARCHAR(30),
    "link_error" VARCHAR(255),
    "requested_by" UUID,
    "cancelled_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_cod_topups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_shop_cod_topups_status" CHECK ("status" IN ('creating', 'pending', 'partial', 'paid', 'expired', 'cancelled', 'failed')),
    CONSTRAINT "chk_shop_cod_topups_amounts" CHECK ("amount" > 0 AND "received_amount" >= 0 AND "polled_amount" >= 0),
    -- Dải mã riêng cho nạp cọc: 5e15..8,99e15 (mã đơn hàng ≈ 1,8e15) — mã nạp KHÔNG BAO GIỜ trùng/nhầm mã đơn hàng.
    CONSTRAINT "chk_shop_cod_topups_code" CHECK ("payos_order_code" ~ '^[5-8][0-9]{15}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "shop_cod_topups_payos_order_code_key" ON "payment"."shop_cod_topups" ("payos_order_code");
CREATE INDEX IF NOT EXISTS "shop_cod_topups_shop_id_created_at_idx" ON "payment"."shop_cod_topups" ("shop_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "shop_cod_topups_status_expires_at_idx" ON "payment"."shop_cod_topups" ("status", "expires_at");
-- Chốt cuối ở DB: mỗi shop tối đa MỘT khoản đang mở. (Prisma không biểu diễn được chỉ mục một phần — chỉ có trong SQL, giống uq_payments_order_live.)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shop_cod_topups_active_per_shop" ON "payment"."shop_cod_topups" ("shop_id") WHERE "status" IN ('creating', 'pending', 'partial');

CREATE TABLE IF NOT EXISTS "payment"."shop_cod_topup_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "topup_id" UUID NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_cod_topup_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_shop_cod_topup_receipts_amount" CHECK ("amount" > 0)
);

-- Khử trùng webhook theo TỪNG khoản tiền (mã giao dịch `reference` của PayOS) ở mức DB.
CREATE UNIQUE INDEX IF NOT EXISTS "shop_cod_topup_receipts_topup_id_reference_key" ON "payment"."shop_cod_topup_receipts" ("topup_id", "reference");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shop_cod_topup_receipts_topup_id_fkey') THEN
    ALTER TABLE "payment"."shop_cod_topup_receipts" ADD CONSTRAINT "shop_cod_topup_receipts_topup_id_fkey"
      FOREIGN KEY ("topup_id") REFERENCES "payment"."shop_cod_topups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Sổ cái ví: dòng sinh từ khoản nạp PayOS mang topup_id + ref_key (khoá idempotent mức DB).
ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD COLUMN IF NOT EXISTS "topup_id" UUID;
ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD COLUMN IF NOT EXISTS "ref_key" VARCHAR(120);
CREATE INDEX IF NOT EXISTS "shop_cod_wallet_transactions_topup_id_idx" ON "payment"."shop_cod_wallet_transactions" ("topup_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shop_cod_wallet_tx_ref_key" ON "payment"."shop_cod_wallet_transactions" ("ref_key") WHERE "ref_key" IS NOT NULL;

ALTER TABLE "payment"."shop_cod_wallet_transactions" DROP CONSTRAINT IF EXISTS "chk_shop_cod_wallet_tx_type";
ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD CONSTRAINT "chk_shop_cod_wallet_tx_type"
  CHECK ("type" IN ('deposit', 'cod_commission', 'cod_refund', 'adjust', 'cod_reversal', 'topup_payos'));
-- "Ví không bao giờ giảm vì luồng nạp": dòng topup_payos luôn DƯƠNG và luôn có khoá nguồn.
ALTER TABLE "payment"."shop_cod_wallet_transactions" DROP CONSTRAINT IF EXISTS "chk_shop_cod_wallet_tx_topup";
ALTER TABLE "payment"."shop_cod_wallet_transactions" ADD CONSTRAINT "chk_shop_cod_wallet_tx_topup"
  CHECK ("type" <> 'topup_payos' OR ("topup_id" IS NOT NULL AND "ref_key" IS NOT NULL AND "amount" > 0));
```

Danh sách chỉ mục UNIQUE bắt buộc (mức DB): (1) `shop_cod_topups_payos_order_code_key` — mã PayOS; (2) `uq_shop_cod_topups_active_per_shop` — một khoản mở/shop; (3) `shop_cod_topup_receipts_topup_id_reference_key` — `reference` giao dịch theo khoản; (4) `uq_shop_cod_wallet_tx_ref_key` — khoá ghi sổ ví. Cộng CHECK: `chk_shop_cod_topups_{status,amounts,code}`, `chk_shop_cod_topup_receipts_amount`, `chk_shop_cod_wallet_tx_{type,topup}`.

Tên chỉ mục/ràng buộc PHẢI khớp tên Prisma tự sinh (xem model bên dưới) để `npm run migration:check` (`prisma migrate diff --exit-code`) không báo lệch. Prisma bỏ qua CHECK và chỉ mục một phần.

### 3.2 `prisma/schema/payment.prisma` (WP-1 sửa)

Thêm 2 model sau ngay sau `ShopCodDeposit` (trước `PaymentAuditLog`), và thêm 2 trường + 1 chỉ mục vào `ShopCodWalletTransaction`; cập nhật comment đầu model ledger: thêm "· topup_payos (PLAN-0041: nạp cọc qua PayOS, luôn dương, `topup_id`+`ref_key` bắt buộc)".

```prisma
/**
 * PLAN-0041 — khoản NẠP CỌC QUA PAYOS của gian hàng: chủ shop tạo link PayOS; tiền PayOS xác nhận đã nhận được GHI CÓ vào ví đúng số THỰC NHẬN (xem PLAN-0041 §6).
 * status: creating | pending | partial | paid | expired | cancelled | failed. `received_amount` = tổng đã ghi có cho khoản này = max(Σ biên nhận webhook, polled_amount).
 * Mỗi shop tối đa MỘT khoản mở (creating|pending|partial) — chỉ mục một phần `uq_shop_cod_topups_active_per_shop` (chỉ ở SQL migration). payos_order_code nằm dải 5e15 (CHECK ở SQL).
 * Chứng từ tiền, chỉ thêm/đổi trạng thái, không xoá ⇒ miễn cột `is_deleted` (ghi lý do theo Base Columns Rule).
 */
model ShopCodTopup {
  id                String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  shopId            String    @map("shop_id") @db.Uuid
  amount            Decimal   @db.Decimal(14, 0)
  payosOrderCode    String    @unique @map("payos_order_code") @db.VarChar(20)
  paymentLinkId     String?   @map("payment_link_id") @db.VarChar(64)
  checkoutUrl       String?   @map("checkout_url") @db.VarChar(500)
  qrCode            String?   @map("qr_code") @db.Text
  status            String    @default("creating") @db.VarChar(20)
  receivedAmount    Decimal   @default(0) @map("received_amount") @db.Decimal(14, 0)
  polledAmount      Decimal   @default(0) @map("polled_amount") @db.Decimal(14, 0)
  expiresAt         DateTime  @map("expires_at") @db.Timestamptz
  paidAt            DateTime? @map("paid_at") @db.Timestamptz
  closedAt          DateTime? @map("closed_at") @db.Timestamptz
  lastCheckedAt     DateTime? @map("last_checked_at") @db.Timestamptz
  lastGatewayStatus String?   @map("last_gateway_status") @db.VarChar(30)
  linkError         String?   @map("link_error") @db.VarChar(255)
  requestedBy       String?   @map("requested_by") @db.Uuid
  cancelledBy       String?   @map("cancelled_by") @db.Uuid
  version           Int       @default(0)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt         DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  receipts ShopCodTopupReceipt[]

  @@index([shopId, createdAt(sort: Desc)])
  @@index([status, expiresAt])
  @@map("shop_cod_topups")
  @@schema("payment")
}

/// Mỗi khoản tiền PayOS báo về qua webhook cho một khoản nạp (khử trùng theo `reference`); bảng kỹ thuật chỉ thêm ⇒ miễn cột chuẩn (version/updated/is_deleted).
model ShopCodTopupReceipt {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  topupId   String   @map("topup_id") @db.Uuid
  reference String   @db.VarChar(120)
  amount    Decimal  @db.Decimal(14, 0)
  raw       Json?
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  topup ShopCodTopup @relation(fields: [topupId], references: [id], onDelete: Cascade)

  @@unique([topupId, reference])
  @@map("shop_cod_topup_receipts")
  @@schema("payment")
}
```

Trong `ShopCodWalletTransaction`, thêm (sau `depositId`):

```prisma
  /**
   * PLAN-0041 — khoản nạp PayOS sinh dòng này (chỉ type = topup_payos) + khoá idempotent `payos-topup:<topupId>:<luỹ kế>`; UNIQUE một phần ở SQL (`uq_shop_cod_wallet_tx_ref_key`)
   */
  topupId      String?  @map("topup_id") @db.Uuid
  refKey       String?  @map("ref_key") @db.VarChar(120)
```
và `@@index([topupId])` (tên tự sinh `shop_cod_wallet_transactions_topup_id_idx` — trùng SQL).

Sau khi sửa: `npx prisma generate` (WP-1). Sau khi cả đợt xong: điều phối viên chạy `npm run migration:check` trên DB trống và nhắc chủ dự án `npm run db:dump` lại (dump demo ở mức migration cũ; `docs/05_SEED_AND_REPRODUCE.md`) — plan này KHÔNG chạy `db:dump`.

DBML `docs/database/eco_fashion.dbml` hiện KHÔNG có các bảng ví cọc (kiểm bằng grep) ⇒ không cập nhật DBML; ghi vào §16 DoD là N/A có lý do.

---

## 4. Máy trạng thái khoản nạp PayOS

### 4.1 Trạng thái
| Trạng thái | Nghĩa | Còn "mở"? (chiếm slot một-khoản-mở/shop) |
|---|---|---|
| `creating` | Đã ghi dòng, đang/chưa xong việc gọi PayOS tạo link. | có |
| `pending` | Link đã tạo, CHƯA nhận đồng nào (`received_amount = 0`). | có |
| `partial` | Đã nhận và ghi có một phần: `0 < received < amount`, link còn sống. | có |
| `paid` | `received ≥ amount` (đủ hoặc thừa). Bất biến: `status = 'paid' ⇔ received_amount ≥ amount`. | không |
| `expired` | Hết hạn (job / PayOS báo EXPIRED). Có thể có `received > 0` (kết thúc thiếu). | không |
| `cancelled` | Chủ shop huỷ link / PayOS báo CANCELLED. Có thể có `received > 0`. | không |
| `failed` | Tạo link thất bại (PayOS lỗi / dòng mồ côi). `received = 0` lúc đóng. | không |

### 4.2 Bảng chuyển (sự kiện → trạng thái mới). `—` = không đổi; `✗` = từ chối (409 hoặc bỏ qua); "TIỀN" = có khoản ghi có > 0 (kết quả `received` mới so với `amount`)
| Từ \ Sự kiện | LINK_OK (chốt tạo link) | LINK_FAIL | TIỀN, received < amount | TIỀN, received ≥ amount | HUỶ (chủ shop / PayOS CANCELLED) | HẾT HẠN (job / PayOS EXPIRED) | MỒ CÔI (`creating` quá 90 s, PayOS không biết link) |
|---|---|---|---|---|---|---|---|
| `creating` | `pending` | `failed` | `partial` | `paid` | ✗ (409 `WALLET_TOPUP_INVALID_STATE`; riêng PayOS CANCELLED ⇒ `cancelled`) | `expired` | `failed` |
| `pending` | — | — | `partial` | `paid` | `cancelled` | `expired` | — |
| `partial` | — | — | `partial` (cộng dồn) | `paid` | `cancelled` | `expired` | — |
| `paid` | — | — | `paid` (vẫn ghi có phần thêm — **trả trùng/thừa**, báo kế toán) | `paid` | ✗ 409 | — | — |
| `expired` | — | — | giữ `expired` (ghi có, báo kế toán "tiền về muộn") | `paid` (ghi có, báo "tiền về muộn") | ✗ 409 | — | — |
| `cancelled` | — | — | giữ `cancelled` (ghi có, báo muộn) | `paid` (ghi có, báo muộn) | ✗ 409 | — | — |
| `failed` | — | — | giữ `failed` (ghi có, báo muộn) | `paid` (ghi có, báo muộn) | ✗ 409 | — | — |

Quy tắc hàm thuần (có test riêng, export để test):
```ts
nextStatusAfterMoney(status, received, amount):
  received >= amount                                   → 'paid'            // mọi trạng thái, kể cả đã đóng
  received > 0 && status ∈ {creating,pending,partial}   → 'partial'
  còn lại                                              → status            // expired/cancelled/failed + tiền chưa đủ: giữ nguyên
```

### 4.3 Tiền về muộn / bất thường — xử lý theo trạng thái
Mọi trạng thái đều NHẬN tiền (D3). Khác nhau ở thông báo và trạng thái cuối:

| Khi tiền về, khoản đang ở | Ghi có ví? | Trạng thái sau | Báo kế toán? (người có `supplier.wallet.approve`) | Báo chủ shop? |
|---|---|---|---|---|
| `creating` / `pending` / `partial`, tổng ≤ amount | có, đúng phần mới | `partial` hoặc `paid` | không | có ("+X, số dư Y") |
| `creating` / `pending` / `partial`, tổng > amount (trả thừa) | có, TOÀN BỘ phần mới | `paid` | có — "trả thừa" (không hoàn) | có |
| `paid` (khách chuyển lần nữa — trùng) | có, đúng số lần này | `paid` | có — "trả trùng" | có |
| `expired` / `cancelled` / `failed` (muộn) | có | `paid` nếu `received ≥ amount`, ngược lại giữ nguyên | có — "tiền về muộn sau khi link đã đóng" | có |
| Đóng (`expired`/`cancelled`) khi `0 < received < amount` | (đã ghi có từ trước) | giữ | có — "kết thúc thiếu: shop đã nạp X / yêu cầu Y" (gửi MỘT lần lúc đóng) | không |

Trường hợp KHÔNG ghi có (và báo kế toán): webhook thành công nhưng `amount` không hợp lệ (không phải số nguyên dương hữu hạn ≤ 99.999.999.999.999); webhook thiếu cả `reference` lẫn `transactionDateTime` (D13 — job/endpoint dò ghi có sau). Webhook không thành công (`code ≠ "00"`) ⇒ 200 bỏ qua, không ghi gì.

---

## 5. Hợp đồng API

Quy ước: `ApiResponse{success,message,data,error{code,message,path,details},requestId}`, `PageResponse{content,page,size,totalElements,totalPages}` (page từ 1), camelCase, tiền là CHUỖI số nguyên VND, thời gian ISO-8601. Lỗi nghiệp vụ = `BusinessException(errorCode, message, httpStatus)` (`@common/exception/business.exception`). Controller MỚI: `src/modules/payment/shop-wallet/controller/shop-wallet-topup.controller.ts`, `@ApiTags('wallet')` (cùng nhóm Swagger với ví hiện có), `@Controller()` với đường dẫn đầy đủ trên từng route. Route tĩnh (`by-order-code`) khai báo TRƯỚC `:id`.

### 5.1 Vendor — `@UseGuards(ShopContextGuard)`, `shopId` CHỈ từ `@CurrentShop()`
| Route | Quyền | Body / query | Trả | Ghi chú |
|---|---|---|---|---|
| `POST /shop/wallet/topups` | `shop.wallet.deposit_request` | `{ amount: "1000000" }` (chuỗi VND `^[1-9]\d{0,13}$`) | 201 `CreateTopupResponse` | Tạo link PayOS. Đã có khoản mở còn hạn ⇒ trả lại nó với `reused: true`. `@RateLimit({ name: 'wallet-topup-create', limit: 10, windowSeconds: 600, by: 'user' })`. Audit `WALLET_TOPUP_CREATED`. |
| `GET /shop/wallet/topups?page&size&status` | `shop.wallet.read` | `status` ∈ 7 trạng thái (tuỳ chọn) | 200 `PageResponse<WalletTopupResponse>` | Mới nhất trước. `shopId` trong query bị BỎ QUA. |
| `GET /shop/wallet/topups/by-order-code/:orderCode` | `shop.wallet.read` | `orderCode` = mã PayOS (`^\d{1,16}$`, sai ⇒ 404 không chạm DB) | 200 `WalletTopupResponse` | Trang quay lại từ PayOS. Còn mở ⇒ LÀM MỚI từ PayOS (xem §6.4). Khoản của shop khác ⇒ 404. `@RateLimit({ name: 'wallet-topup-read', limit: 200, windowSeconds: 600, by: 'user' })`. |
| `GET /shop/wallet/topups/:id` | `shop.wallet.read` | `id` uuid | 200 `WalletTopupResponse` | Như trên (FE gọi định kỳ 3 giây khi đang chờ). Cùng rate-limit `wallet-topup-read`. |
| `POST /shop/wallet/topups/:id/cancel` | `shop.wallet.deposit_request` | — | 200 `WalletTopupResponse` | `pending|partial` ⇒ `cancelled`; trạng thái khác ⇒ 409 `WALLET_TOPUP_INVALID_STATE`. `@HttpCode(200)`, `@RateLimit({ name: 'wallet-topup-cancel', limit: 10, windowSeconds: 600, by: 'user' })`. Gọi huỷ link PayOS SAU commit, best-effort. |
| `GET /shop/wallet` (đã có) | `shop.wallet.read` | — | `WalletResponse` + trường MỚI `payosTopup: PayosTopupInfoResponse` | Chỉ route vendor trả `payosTopup`; `GET /admin/shops/:id/wallet` không có trường này. |

### 5.2 Sàn — `@RequirePermission` (xem-only)
| Route | Quyền | Trả |
|---|---|---|
| `GET /admin/wallet-topups?page&size&status&shopId` | `supplier.wallet.read` | `PageResponse<WalletTopupResponse>` (có `shopName`; `checkoutUrl`/`qrCode` luôn `null`) |
| `GET /admin/wallet-topups/:id` | `supplier.wallet.read` | `WalletTopupDetailResponse` (thêm `receipts[]`) |

Duyệt/từ chối: KHÔNG có route cho khoản PayOS. `POST /admin/wallet-deposits/:id/approve|reject` với id của khoản nạp PayOS ⇒ 409 `WALLET_DEPOSIT_PAYOS_NOT_MANUAL` ("Khoản nạp qua PayOS tự ghi có, không duyệt tay").

### 5.3 DTO (file `shop-wallet/dto/shop-wallet-topup.dto.ts` — WP-1; có `@ApiProperty` đủ để Orval sinh kiểu)
```ts
export class CreateTopupRequest { @Matches(VND, { message: 'Số tiền không hợp lệ' }) amount!: string }   // VND = /^[1-9]\d{0,13}$/ — khai lại hằng CỤC BỘ cùng mẫu (hằng ở shop-wallet.dto.ts không export; file mới KHÔNG import ngược shop-wallet.dto.ts để tránh vòng)
export class TopupListQuery extends PageQuery { @IsOptional() @IsIn(TOPUP_STATUS_VALUES) status?: string; @IsOptional() @IsUUID('loose') shopId?: string }
export class WalletTopupReceiptResponse { reference!: string; amount!: string; createdAt!: string }
export class WalletTopupResponse {
  id; shopId; shopName?: string;
  amount: string;            // số tiền yêu cầu (= số tiền link PayOS)
  receivedAmount: string;    // tổng ĐÃ GHI CÓ vào ví cho khoản này
  status: 'creating'|'pending'|'partial'|'paid'|'expired'|'cancelled'|'failed';
  payosOrderCode: string;    // mã PayOS (để kế toán đối chiếu bảng điều khiển PayOS)
  checkoutUrl: string | null; // CHỈ route vendor và CHỈ khi status ∈ {pending, partial} và chưa quá expiresAt; còn lại null
  qrCode: string | null;      // như checkoutUrl
  expiresAt: string; paidAt: string | null; closedAt: string | null; createdAt: string;
  canCancel: boolean;         // vendor: status ∈ {pending, partial}
}
export class CreateTopupResponse extends WalletTopupResponse { reused!: boolean }
export class WalletTopupDetailResponse extends WalletTopupResponse { receipts!: WalletTopupReceiptResponse[]; lastGatewayStatus!: string | null; lastCheckedAt!: string | null }
export class PayosTopupInfoResponse { enabled!: boolean; minAmount!: number; maxAmount!: number; active!: WalletTopupResponse | null }   // enabled = cờ bật VÀ PayOS cấu hình VÀ EF_ADMIN_URL dùng được; active = khoản pending|partial còn hạn của shop, ngược lại null
```
Sửa `shop-wallet.dto.ts` (WP-1): `WalletResponse` thêm `@ApiPropertyOptional({ type: () => PayosTopupInfoResponse }) payosTopup?: PayosTopupInfoResponse`; `WalletTransactionResponse.type` thêm `'topup_payos'` vào `enum` và vào mô tả ("topup_payos = nạp cọc qua PayOS, luôn dương").

### 5.4 Mã lỗi nghiệp vụ mới (`WALLET_ERR` trong `payment.constants.ts`)
| Hằng | Mã | HTTP | Khi nào |
|---|---|---|---|
| `TOPUP_DISABLED` | `WALLET_TOPUP_DISABLED` | 409 | Cờ `wallet.payos_deposit_enabled` tắt (chỉ lúc TẠO link) — "Nạp qua PayOS đang tạm tắt, dùng chuyển khoản" |
| `TOPUP_UNAVAILABLE` | `WALLET_TOPUP_UNAVAILABLE` | 503 | PayOS chưa cấu hình khoá, hoặc production mà `EF_ADMIN_URL` không phải `https://` |
| `TOPUP_LINK_FAILED` | `WALLET_TOPUP_LINK_FAILED` | 503 | PayOS lỗi/timeout lúc tạo link (dòng thành `failed`, thử lại tạo link mới) |
| `TOPUP_TOO_LARGE` | `WALLET_TOPUP_TOO_LARGE` | 400 | `amount` > `wallet.max_topup_amount` |
| (dùng lại) `DEPOSIT_TOO_SMALL` | `WALLET_DEPOSIT_TOO_SMALL` | 400 | `amount` < `wallet.min_deposit` |
| `TOPUP_NOT_FOUND` | `WALLET_TOPUP_NOT_FOUND` | 404 | không có / của shop khác / mã PayOS sai định dạng |
| `TOPUP_INVALID_STATE` | `WALLET_TOPUP_INVALID_STATE` | 409 | huỷ khoản không ở `pending|partial` |
| `TOPUP_IN_PROGRESS` | `WALLET_TOPUP_IN_PROGRESS` | 409 | shop đang có một yêu cầu tạo link khác đang chạy (`creating` < 60 s) — thử lại sau vài giây |
| `DEPOSIT_PAYOS_NOT_MANUAL` | `WALLET_DEPOSIT_PAYOS_NOT_MANUAL` | 409 | duyệt/từ chối nhầm id khoản PayOS |

Lỗi validate body/query ⇒ `COMMON_VALIDATION_ERROR` 400 (sẵn có). Shop chưa duyệt/bị khoá ⇒ 403 `SHOP_NOT_APPROVED` (do `ShopContextGuard`, sẵn có). Thiếu quyền ⇒ 403 `COMMON_FORBIDDEN` kèm `details.required`.

### 5.5 Đoạn cần thêm vào `docs/06_FE_CONTRACT.md` (WP-8 làm, chỉ THÊM, không sửa dòng khác của file)
**(a)** Trong bảng "wallet" của mục vendor (ngay sau dòng `POST /shop/wallet/deposit-requests …`) thêm:
```
| `GET /shop/wallet` | — | (bổ sung PLAN-0041) thêm `payosTopup{enabled,minAmount,maxAmount,active}`; sổ cái thêm `type = topup_payos` (nạp qua PayOS, luôn dương) |
| `POST /shop/wallet/topups {amount}` | `shop.wallet.deposit_request` | **Nạp cọc qua PayOS (PLAN-0041)**: tạo link PayOS → `{id,status,amount,receivedAmount,checkoutUrl,qrCode,expiresAt,reused,…}`. Mỗi shop MỘT khoản mở; gọi lại khi còn hạn ⇒ trả link cũ (`reused:true`). Tối thiểu `wallet.min_deposit`, tối đa `wallet.max_topup_amount`. Lỗi: 409 `WALLET_TOPUP_DISABLED`, 503 `WALLET_TOPUP_UNAVAILABLE`/`WALLET_TOPUP_LINK_FAILED`, 400 `WALLET_DEPOSIT_TOO_SMALL`/`WALLET_TOPUP_TOO_LARGE` |
| `GET /shop/wallet/topups?status` · `GET /shop/wallet/topups/{id}` · `GET /shop/wallet/topups/by-order-code/{orderCode}` | `shop.wallet.read` | Danh sách / chi tiết / tra theo mã PayOS (trang quay lại `/vendor/wallet/payos-return?orderCode=…`). Còn mở ⇒ backend hỏi lại PayOS rồi ghi nhận (giống `GET /payments/payos/return`); FE gọi 3 giây/lần tới khi `status` ∈ {paid, expired, cancelled, failed} |
| `POST /shop/wallet/topups/{id}/cancel` | `shop.wallet.deposit_request` | Huỷ link (`pending|partial` → `cancelled`); trạng thái khác 409 `WALLET_TOPUP_INVALID_STATE`. Tiền chuyển muộn vào link đã huỷ VẪN được ghi có |
```
**(b)** Trong bảng "wallets" của mục sàn (sau dòng `POST /admin/wallet-deposits/{id}/approve · /reject`) thêm:
```
| `GET /admin/wallet-topups?status&shopId` · `GET /admin/wallet-topups/{id}` | `supplier.wallet.read` | Khoản nạp qua PayOS (xem-only; chi tiết có `receipts[{reference,amount}]` để đối chiếu PayOS). Khoản PayOS TỰ ghi có — duyệt/từ chối nhầm id ⇒ 409 `WALLET_DEPOSIT_PAYOS_NOT_MANUAL` |
```
**(c)** Thêm mục cuối file `## Nạp cọc COD qua PayOS (PLAN-0041, 2026-11-03)` mô tả ngắn: luồng (tạo link → trả → webhook/dò → ví tăng đúng số thực nhận → COD mở nếu ví ≥ `wallet.min_balance_for_cod`), mọi tình huống thiếu/thừa/trùng/muộn đều GHI CÓ đúng số thực nhận (không hoàn), cờ `wallet.payos_deposit_enabled` (mặc định tắt) chỉ chặn tạo link mới, webhook PayOS dùng chung `POST /payments/payos/webhook` (mã dải 5e15 ⇒ khoản nạp), env `EF_ADMIN_URL`, 3 setting mới, mã lỗi §5.4, `returnUrl = ${EF_ADMIN_URL}/vendor/wallet/payos-return`.

---

## 6. Thiết kế xử lý (webhook · dò · hết hạn · đồng thời)

### 6.1 Thứ tự khoá & nguyên tắc (BẤT BIẾN)
- Thứ tự khoá toàn cục: **ĐƠN → PAYMENT → KHOẢN NẠP (`shop_cod_topups`) → VÍ (`shop_cod_wallets`)**. Luồng nạp cọc chỉ lấy `KHOẢN NẠP → VÍ`:
  `SELECT id FROM "payment"."shop_cod_topups" WHERE id = ${id}::uuid FOR UPDATE` rồi mới (trong `ShopWalletService.lockWallet`) upsert + `FOR UPDATE` dòng ví. Tuyệt đối KHÔNG khoá ví rồi mới khoá khoản nạp; KHÔNG gọi `orders.lockOrder`/khoá payment từ luồng nạp.
- Đường TẠO link không khoá ví và không giữ khoá nào khi gọi PayOS.
- Bảng khoá theo từng đường (để người rà soát đối chiếu):

| Đường | Khoá, theo thứ tự | Ghi chú |
|---|---|---|
| `settleWebhookIfTopup` (webhook) | KHOẢN NẠP → VÍ | retryOnDeadlock; không đụng đơn/payment |
| `reconcileOne` (job · GET làm mới · đóng link cũ lúc tạo) | (HTTP PayOS, không khoá) → KHOẢN NẠP → VÍ | CAS `last_checked_at` TRƯỚC khi gọi PayOS (CAS là một câu UPDATE ngắn, không giữ khoá lâu) |
| `markLinkCreated` / `markLinkFailed` / `cancel` | KHOẢN NẠP | không chạm ví |
| `create` (chèn dòng `creating`) | không khoá (INSERT một câu) | chỉ mục "một khoản mở/shop" là chốt |
| `approveDeposit` / `rejectDeposit` (tay, đã có) | VÍ (như cũ) | nhánh 409 thêm chỉ ĐỌC bảng khoản nạp (không khoá) |
| `applyCodCommission` / `applyCodRefund` / `reverseCodCommission` (đã có) | ĐƠN → PAYMENT → VÍ | không bao giờ chạm khoản nạp ⇒ không tạo chu trình |
| `settlePayosOnce` (đơn hàng, đã có) | ĐƠN → PAYMENT | không chạm khoản nạp/ví |
- Mọi ghi sổ ví đi qua `ShopWalletService.creditPayosTopup` → `post` (idempotent theo `ref_key` UNIQUE).
- Cập nhật dòng nạp (`received_amount`, `status`…) là câu GHI CUỐI CÙNG của transaction (sau biên nhận + sổ cái + ví) — harness `WTP-30` dựa vào đó để chứng minh rollback.
- Bọc cả transaction ghi có bằng `retryOnDeadlock` (`@common/prisma/errors`).
- Không gọi PayOS (HTTP) trong transaction. Thông báo SAU commit.

### 6.2 Hợp đồng bề mặt Prisma (agent code CHỈ dùng đúng các lời gọi này — DB giả của test `fixture` chỉ mô phỏng đúng bấy nhiêu; cần thêm ⇒ báo điều phối viên)
Trong `ShopWalletTopupService` + `ShopWalletTopupSettleService` (module payment; model chỉ gọi trong `src/modules/payment/**`):
- `shopCodTopup`: `findUnique({where:{id}|{payosOrderCode}})`, `findUniqueOrThrow({where:{id}})`, `findFirst({where, orderBy?})`, `findMany({where, orderBy, skip?, take?})`, `count({where})`, `create({data})`, `update({where:{id}, data})`, `updateMany({where, data})`. Toán tử `where` được dùng: bằng, `in`, `lt`, `lte`, `gte`, `not`, `OR`, `null`. `data` có thể có `{ version: { increment: 1 } }`.
- `shopCodTopupReceipt`: `findFirst({where:{topupId, reference}, select?})`, `findMany({where:{topupId}, orderBy:{createdAt:'asc'}})`, `create({data})`, `aggregate({where:{topupId}, _sum:{amount:true}})`.
- Khoá: `` tx.$queryRaw`SELECT id FROM "payment"."shop_cod_topups" WHERE id = ${id}::uuid FOR UPDATE` `` (đúng chuỗi này).
- Ví/sổ cái: CHỈ qua `ShopWalletService` (settle KHÔNG gọi `shopCodWallet*` trực tiếp).
- Audit: `PaymentAuditLogService.write(tx|null, actor|null, entry)`.

### 6.3 Hàm thuần dùng chung (WP-3 cài trong `shop-wallet-topup-settle.service.ts` và `export` để WP-4 viết test)
```ts
export function parseMoney(v: unknown, allowZero = false): bigint | null
  // number|string → số nguyên hữu hạn ≤ 99_999_999_999_999 (và > 0 trừ khi allowZero); ngược lại null
export function receiptRef(payosOrderCode: string, data: Record<string, unknown>): string | null
  // data.reference (chuỗi không rỗng) → trim().slice(0, 100);
  // else data.transactionDateTime (chuỗi không rỗng) → `${code}:${transactionDateTime}:${amount}`.slice(0, 100); else null
export function targetCumulative(sumReceipts: bigint, polled: bigint, alreadyReceived: bigint): bigint
  // max(sumReceipts, polled, alreadyReceived)   // không bao giờ thấp hơn đã ghi có
export function nextStatusAfterMoney(status: TopupStatus, received: bigint, amount: bigint): TopupStatus   // §4.2
```

### 6.4 Pseudo-code (viết đúng thứ tự khoá)

**(A) `ShopWalletTopupService.create(actor, shop, amount)`** — `shop = { shopId, shopCode, shopName }` từ `@CurrentShop()`:
```
0. flag = system.settingBool(WALLET_PAYOS_DEPOSIT_ENABLED); !flag ⇒ 409 TOPUP_DISABLED
   !payos.isConfigured || !adminUrlUsable() ⇒ 503 TOPUP_UNAVAILABLE      // adminUrlUsable: NODE_ENV !== 'production' || EF_ADMIN_URL bắt đầu 'https://'
   min = settingNumber(WALLET_MIN_DEPOSIT); max = settingNumber(WALLET_MAX_TOPUP_AMOUNT); ttl = settingNumber(WALLET_PAYOS_TOPUP_EXPIRE_MINUTES)
   amount < min ⇒ 400 DEPOSIT_TOO_SMALL; amount > max ⇒ 400 TOPUP_TOO_LARGE
1. open = findFirst({shopId, status in OPEN}, orderBy createdAt desc)            // KHÔNG khoá
   nếu open:
     stale = (open.status==='creating' && tuổi > 60s) || (open.status!=='creating' && open.expiresAt <= now)
     !stale ⇒ open.status==='creating' ? 409 TOPUP_IN_PROGRESS : return { topup: open, reused: true }
     stale ⇒ settle.reconcileOne(open.id, { forceClose: true }) ; open = findFirst lại
             open còn (vd vừa nhận tiền ⇒ vẫn partial & chưa quá hạn) ⇒ như nhánh !stale
2. lặp tối đa 5 lần:
     code = String(PayosService.generateTopupOrderCode())
     thử prisma.shopCodTopup.create({ shopId, amount, payosOrderCode: code, status:'creating', expiresAt: now+ttl phút, requestedBy })   // MỘT câu autocommit, không $transaction
     bắt P2002: winner = findFirst({shopId, status in OPEN}); có winner ⇒ (creating ? 409 TOPUP_IN_PROGRESS : return reused); không winner ⇒ coi là trùng mã, lặp lại. Hết 5 lần ⇒ 503 TOPUP_LINK_FAILED
3. // NGOÀI transaction
   link = await payos.createPaymentLink({ orderCode: Number(code), amount, description: topupDescription(shop.shopCode),
            returnUrl: `${adminUrl}/vendor/wallet/payos-return`, cancelUrl: (như returnUrl), expiresAt: row.expiresAt })      // try/catch ⇒ coi như thất bại
   !link.checkoutUrl ⇒ settle.markLinkFailed(row.id, 'PayOS không tạo được link') ; 503 TOPUP_LINK_FAILED
   topup = settle.markLinkCreated(row.id, { checkoutUrl, qrCode, paymentLinkId }, actor)
   return { topup, reused: false }
```
`topupDescription(shopCode)` = `('NAPCOC ' + shopCode).toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 25)`. `adminUrl = env.EF_ADMIN_URL.replace(/\/$/, '')`. Nguyên mẫu gọi PayOS ngoài transaction + lưu link: `PaymentService.requestPayosLink` (~174), `saveLink` (~184), `createCheckoutLinks` (~203).

**(B) Lõi ghi nhận `applyInTx(tx, t, ev)`** (private, trong settle service; `t` đã đọc LẠI dưới khoá; `ev` = `{source:'webhook', reference, amount, raw}` hoặc `{source:'poll', cumulative, gatewayStatus}`):
```
received = vnd(t.receivedAmount)
1. nếu webhook:
     dup = tx.shopCodTopupReceipt.findFirst({ where:{topupId:t.id, reference} })
     dup ⇒ return { kind:'replay' }                                   // replay: KHÔNG làm gì thêm
     tx.shopCodTopupReceipt.create({ topupId, reference, amount, raw: gọn(data) })   // raw: lọc bỏ khoá rỗng, ép InputJsonObject
2. sum = vnd(aggregate(_sum.amount))                                  // sau khi chèn biên nhận mới
   polled = poll ? max(vnd(t.polledAmount), ev.cumulative) : vnd(t.polledAmount)
   target = targetCumulative(sum, polled, received)
   delta = target - received
3. nếu delta > 0:
     r = wallet.creditPayosTopup(tx, { shopId: t.shopId, topupId: t.id, refKey: `payos-topup:${t.id}:${target}`, amount: delta,
           note: `Nạp cọc qua PayOS (mã ${t.payosOrderCode})`,
           meta: { topupId, payosOrderCode, source, reference|null, cumulative: target.toString(), delta: delta.toString() } })
4. next = nextStatusAfterMoney(t.status, target, vnd(t.amount))
   có gì đổi (target≠received || polled≠t.polledAmount || next≠t.status || gatewayStatus đổi) ⇒
     tx.shopCodTopup.update({ where:{id}, data:{ receivedAmount: target, polledAmount: polled, status: next,
           ...(next==='paid' && !t.paidAt ? { paidAt: now } : {}), ...(poll && gatewayStatus ? { lastGatewayStatus: gatewayStatus.slice(0,30) } : {}), version:{increment:1} } })   // GHI CUỐI
5. delta > 0 ⇒ audit WALLET_TOPUP_CREDITED { shopId, delta, received: target, amount, balanceAfter, source, reference, statusFrom, statusTo }
return { kind:'applied', before:{status:t.status, received}, after:{status:next, received:target}, credited: delta, balanceAfter: r?.balanceAfter ?? null }
```
Sau commit, người gọi tính cảnh báo từ `before/after`: `duplicate` nếu `credited>0 && before.received ≥ amount`; `overpaid` nếu `credited>0 && after.received > amount && !duplicate`; `late` nếu `credited>0 && before.status ∈ {expired,cancelled,failed}` ⇒ MỘT thông báo kế toán gộp lý do (ưu tiên duplicate > overpaid > late); luôn thông báo chủ shop khi `credited>0`.

**(C) `settleWebhookIfTopup(payosOrderCode, data, paidOk)`**:
```
!/^\d{1,16}$/.test(code) ⇒ return null                              // KHÔNG chạm DB
topup = prisma.shopCodTopup.findUnique({ where:{ payosOrderCode: code } }) ; !topup ⇒ return null
!paidOk ⇒ return { outcome:'ignored', message:'Ignored: not a success event' }
amount = parseMoney(data.amount) ; null ⇒ logger.error + báo kế toán ('webhook nạp cọc có số tiền không hợp lệ') ⇒ return { outcome:'ignored', message:'Ignored: invalid amount' }
reference = receiptRef(code, data) ; null ⇒ logger.warn + báo kế toán ⇒ return { outcome:'unkeyed', message:'Ignored: no transaction reference — will reconcile with PayOS' }
res = retryOnDeadlock(() => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "payment"."shop_cod_topups" WHERE id = ${topup.id}::uuid FOR UPDATE`   // khoá #1
        t = tx.shopCodTopup.findUniqueOrThrow({ where:{id: topup.id} })
        return applyInTx(tx, t, { source:'webhook', reference, amount, raw: data })
     }))
SAU commit: gửi thông báo (best-effort, nuốt lỗi)
return { outcome: res.kind==='replay' ? 'replay' : res.credited>0n ? 'credited' : 'noop', message:'Success' }
```
Cờ `wallet.payos_deposit_enabled` KHÔNG được đọc ở đây (D10).

**(D) `reconcileOne(topupId, opts?: { minIntervalMs?, forceClose? })`** (NGOÀI transaction cho PayOS; dùng bởi job, `GET` làm mới, `create` đóng link cũ):
```
!payos.isConfigured ⇒ 'unknown' ; row = findUnique ; !row ⇒ 'not_found'
nếu opts.minIntervalMs: chiếm lượt bằng CAS: updateMany({ where:{id, OR:[{lastCheckedAt:null},{lastCheckedAt:{lt: now-minIntervalMs}}]}, data:{lastCheckedAt: now} }) ; count 0 ⇒ 'skipped'
info = await payos.getPaymentLink(row.payosOrderCode)               // {} khi lỗi/không tìm thấy
cumulative = parseMoney(info.amountPaid, true) ; known = info.status !== undefined || cumulative !== null
retryOnDeadlock(transaction):
   khoá dòng nạp (khoá #1) ; t = findUniqueOrThrow
   cumulative !== null ⇒ applyInTx(tx, t, {source:'poll', cumulative, gatewayStatus: info.status ?? null}) ; t = đọc lại
   nếu t.status ∈ OPEN, quyết định ĐÓNG theo thứ tự:
       info.status === 'CANCELLED'                                         ⇒ cancelled
       info.status === 'EXPIRED'                                           ⇒ expired
       t.status==='creating' && !known && tuổi > 90s                       ⇒ failed (linkError 'PayOS không có link')
       opts.forceClose && t.status==='creating'                            ⇒ known ? expired : failed
       t.expiresAt + 2 phút < now  ||  (opts.forceClose && t.expiresAt <= now) ⇒ expired
     ĐÓNG ⇒ update { status, closedAt: now, version+1 (+linkError) } ; audit WALLET_TOPUP_EXPIRED|CANCELLED|LINK_FAILED ;
              nếu 0 < received < amount và đóng là expired|cancelled ⇒ đánh dấu cảnh báo "kết thúc thiếu" cho kế toán (gửi sau commit)
SAU commit: thông báo
return credited>0 ? 'credited' : closed ? 'closed' : known ? 'unchanged' : 'unknown'
```
Poll luỹ kế THẤP hơn đã ghi có ⇒ `targetCumulative` giữ nguyên `received` ⇒ delta 0 ⇒ không ghi gì; `logger.warn` (D14).

**(E) `markLinkCreated(topupId, link, actor)`** (transaction ngắn): khoá dòng nạp → đọc → `update({ checkoutUrl, qrCode, paymentLinkId, linkError: null, ...(status==='creating' ? { status:'pending' } : {}), version+1 })` → audit `WALLET_TOPUP_CREATED` (`actor`) → trả dòng. **Không** ghi đè trạng thái nếu webhook đã đưa dòng sang `partial/paid` (D5). **`markLinkFailed(topupId, message)`**: khoá → nếu `status==='creating'` ⇒ `failed` + `linkError` (cắt 250 ký tự) + `closedAt`; nếu đã khác `creating` (tiền về trước) ⇒ không làm gì; audit `WALLET_TOPUP_LINK_FAILED`.

**(F) `cancel(actor, shopId, topupId)`**: `findUnique` (không khoá) — không có/khác shop ⇒ 404 `WALLET_TOPUP_NOT_FOUND`; khoá dòng nạp → đọc lại → `status ∉ {pending, partial}` ⇒ 409 `WALLET_TOPUP_INVALID_STATE`; ngược lại `update { status:'cancelled', closedAt, cancelledBy: actor.userId, version+1 }` + audit; `0<received<amount` ⇒ cảnh báo kế toán sau commit. `ShopWalletTopupService.cancelMine` gọi hàm này rồi `payos.cancelPaymentLink(code)` NGOÀI transaction, `void … .catch(log)`.

**(G) Job `ShopWalletTopupSettleService.reconcilePending(limit = 30)`** (mỗi 2 phút; `{checked, credited, closed}`):
```
!payos.isConfigured ⇒ {0,0,0}
mở  = findMany({ status in OPEN, OR(lastCheckedAt null, lastCheckedAt < now-60s) }, orderBy createdAt asc, take limit)   // `creating` mồ côi (> 90s) do reconcileOne tự xử lý
đuôi = findMany({ status in (expired, cancelled), closedAt >= now-72h, OR(lastCheckedAt null, lastCheckedAt < now-6h) }, take 10)     // tiền về muộn mà mất webhook (không quét `failed`: PayOS không có link)
mỗi dòng (try/catch riêng — một dòng lỗi không dừng cả lô): reconcileOne(id, { minIntervalMs: 60_000 hoặc 6h cho đuôi })
```
Lớp bọc job: `WalletTopupJobs.reconcileWalletTopups()` (`@Interval(2 * 60_000)`, cờ chống chạy chồng, log `warn` khi `credited + closed > 0`, nuốt lỗi) trong `shop-wallet/shop-wallet-topup.job.ts`.

**(H) `GET /shop/wallet/topups/:id` & `/by-order-code/:orderCode`** (`ShopWalletTopupService.getMine / getMineByOrderCode`): đọc dòng theo (`id` hoặc `payosOrderCode`) VÀ `shopId` ngữ cảnh (khác ⇒ 404); nếu `status ∈ OPEN` ⇒ `settle.reconcileOne(id, { minIntervalMs: 8_000 })` (try/catch: lỗi chỉ log) rồi đọc lại; trả. Đây là "GET có tác dụng phụ" cùng tiền lệ `GET /payments/payos/return`; rate-limit ở §5.1 chặn lạm dụng; CAS `last_checked_at` bảo đảm ≤ 1 lần hỏi PayOS/8 giây/khoản dù nhiều tab.

### 6.5 Móc vào `PaymentService.handlePayos` (WP-3; sửa TỐI THIỂU 3 chỗ trong `payment/payment.service.ts`)
1. Import `ShopWalletTopupSettleService` từ `../shop-wallet/shop-wallet-topup-settle.service` (cạnh dòng import `ShopWalletService`, ~23).
2. Thêm tham số CUỐI của constructor (~98–108): `private readonly topups: ShopWalletTopupSettleService,`.
3. Trong `handlePayos` (~641–663), thay khối `if (!found) { warn; return 200 unknown }` bằng:
```ts
if (!found) {
  // PLAN-0041: mã không thuộc đơn hàng nào ⇒ thử khoản NẠP CỌC (dải mã riêng) rồi mới coi là mã lạ (vd mẫu kiểm tra URL orderCode=123).
  try {
    const topup = await this.topups.settleWebhookIfTopup(payosOrderCode, data, paidOk);
    if (topup) return { statusCode: 200, body: { code: '00', message: topup.message } };
  } catch (err) {
    this.logger.error({ err, payosOrderCode }, 'Xử lý webhook nạp cọc PayOS lỗi');
    return { statusCode: 500, body: { code: '99', message: 'Internal error' } };
  }
  this.logger.warn({ payosOrderCode }, 'Webhook PayOS cho orderCode không có trong hệ thống (có thể là mẫu kiểm tra URL)');
  return { statusCode: 200, body: { code: '00', message: 'Ignored: unknown order' } };
}
```
Thứ tự: đường đơn (`findPayosPayment`) vẫn chạy TRƯỚC; chữ ký đã kiểm trước đó (401 nếu sai). `payment-payos.spec.ts` dòng dựng `new PaymentService(...)` (~619) phải thêm đối số cuối `topups` (stub `{ settleWebhookIfTopup: jest.fn(() => Promise.resolve(null)) }`) — WP-3 sửa đúng dòng đó + khai báo stub, không sửa gì khác trong spec.

### 6.6 Bảng tình huống → kết quả mong đợi (mã `WTP-xx` dùng chung cho jest và harness `t11`)
Ký hiệu: X = `amount` của khoản; "ví" = `shop_cod_wallets.balance`; "sổ" = dòng `topup_payos` ở `shop_cod_wallet_transactions`.

| Mã | Tình huống | Kết quả mong đợi |
|---|---|---|
| WTP-01 | Trả đủ (1 webhook amount = X) | `paid`; `received = X`; ví +X; 1 biên nhận, 1 dòng sổ (có `topup_id`, `ref_key`); COD mở nếu ví ≥ ngưỡng; chủ shop có thông báo; kế toán KHÔNG |
| WTP-02 | Trả thiếu (a < X) | `partial`; ví +a; link còn sống (`checkoutUrl` còn); kế toán không bị báo |
| WTP-03 | Thiếu rồi trả nốt (a1 rồi a2, hai `reference` khác nhau, a1+a2 ≥ X) | `paid`; ví +(a1+a2); 2 dòng sổ |
| WTP-04 | Trả thừa (X + d) | `paid`; ví +(X+d) — ghi có TOÀN BỘ thực nhận; kế toán được báo "trả thừa"; KHÔNG có hoàn |
| WTP-05 | Replay tuần tự cùng `reference` | 200; không thêm biên nhận/dòng sổ; ví không đổi |
| WTP-06 | 3 webhook CÙNG `reference` đồng thời | cả 3 trả 200; đúng 1 biên nhận + 1 dòng sổ; ví +X một lần |
| WTP-07 | Trả lần 2 sau khi đã `paid` (khác `reference`) | ví +số lần 2; vẫn `paid`; kế toán được báo "trả trùng" |
| WTP-08 | 2 webhook khác `reference` đồng thời | cả hai được cộng; ví đúng tổng; 0 deadlock |
| WTP-09 | Mất webhook; job dò thấy `amountPaid` | job ghi có theo luỹ kế; chạy lại job: không cộng thêm |
| WTP-10 | Webhook đến trước, rồi poll báo luỹ kế cùng khoản | không cộng đôi |
| WTP-11 | Poll đến trước, rồi webhook cùng khoản | không cộng đôi; biên nhận vẫn được ghi |
| WTP-12 | Poll báo luỹ kế THẤP hơn đã ghi có | ví không đổi; không 5xx |
| WTP-13 | Link hết hạn, không có tiền | `expired`, `closed_at`; shop tạo link mới được; khoản cũ không còn "mở" |
| WTP-14 | Tiền về muộn: webhook vào khoản đã `expired` | ghi có đúng số; `paid` nếu `received ≥ X`, ngược lại giữ `expired`; kế toán được báo "về muộn" |
| WTP-15 | Hết hạn khi mới trả một phần | `expired` kèm `received > 0`; ví giữ phần đã nhận; kế toán được báo "kết thúc thiếu" đúng MỘT lần |
| WTP-16 | Webhook đến khi dòng còn `creating` | ghi có; sau đó `markLinkCreated` KHÔNG ghi đè `partial/paid` về `pending`, URL vẫn được lưu; `create` trả dòng đã `partial` |
| WTP-17 | PayOS lỗi lúc tạo link (5xx / timeout / mã lỗi) | 503 `WALLET_TOPUP_LINK_FAILED`; dòng `failed`; không còn khoản mở; ví không đổi; tạo lại được khi PayOS ổn |
| WTP-18 | Cờ tắt / PayOS thiếu cấu hình | cờ tắt: 409 `WALLET_TOPUP_DISABLED`, `payosTopup.enabled=false`; PayOS thiếu cấu hình: 503 `WALLET_TOPUP_UNAVAILABLE` (jest); cờ tắt mà webhook của link đang chờ về VẪN ghi có |
| WTP-19 | Shop bị khoá lúc đang nạp | tạo link mới 403 `SHOP_NOT_APPROVED`; link đang chờ vẫn được ghi có khi tiền về; mở khoá: ví đúng |
| WTP-20 | Tạo link lần 2 khi còn link hạn (cùng/khác số tiền) | trả đúng link cũ (`reused:true`, cùng `id`/`checkoutUrl`); không gọi PayOS lần nữa |
| WTP-21 | Hai request tạo link ĐỒNG THỜI | đúng 1 dòng mở (`creating→pending`); không 5xx (một bên nhận `reused` hoặc 409 `WALLET_TOPUP_IN_PROGRESS`) |
| WTP-22 | Link cũ quá hạn chưa quét + tạo mới | link cũ được đóng (`expired`), link mới tạo ra |
| WTP-23 | Số tiền sai | < min ⇒ 400 `WALLET_DEPOSIT_TOO_SMALL`; > max ⇒ 400 `WALLET_TOPUP_TOO_LARGE`; sai định dạng ⇒ 400 `COMMON_VALIDATION_ERROR`; đúng biên min/max ⇒ được |
| WTP-24 | Quyền | `shop_staff` 403; kế toán gọi `/shop/...` 403; chủ shop khác xem/huỷ khoản shop này ⇒ 404; admin/kế toán `GET /admin/wallet-topups` 200; `approve` với id khoản PayOS ⇒ 409 `WALLET_DEPOSIT_PAYOS_NOT_MANUAL` |
| WTP-25 | Huỷ link | `pending→cancelled`; `paid` ⇒ 409; sau huỷ, webhook vẫn ghi có (muộn) |
| WTP-26 | Chữ ký sai / mã lạ / mã đơn hàng | chữ ký sai 401; mã trong dải 5e15 không có ở DB ⇒ 200 `Ignored: unknown order`; thanh toán đơn PayOS bình thường VẪN chạy đúng (hồi quy định tuyến) |
| WTP-27 | Luồng nạp tay | `deposit-requests` + duyệt vẫn đúng, kể cả khi đang có link PayOS mở; hai luồng độc lập |
| WTP-28 | Đa luồng: 3 webhook (khác `reference`) ∥ job dò ∥ GET làm mới ∥ job hết hạn | tổng ví đúng = Σ PayOS nhận; 0 deadlock (`pg_stat_database.deadlocks` trước/sau); không 5xx |
| WTP-29 | Webhook nạp ∥ đơn COD giao thành công (cùng ví) | `balance = Σ sổ cái` (không lệch so với đầu bài); 0 deadlock |
| WTP-30 | Rollback an toàn | lỗi giữa chừng ⇒ webhook 500, KHÔNG có dữ liệu nửa chừng (biên nhận/sổ/ví/trạng thái nguyên); gỡ lỗi + PayOS gửi lại ⇒ ghi có đúng 1 lần |
| WTP-31 | E2E như người dùng (qua API): chủ shop tạo link → "trả" trên trang PayOS giả → ví tăng → COD mở → khách đặt COD → giao → hoa hồng trừ | từng bước đúng số, sổ cái khớp |
| WTP-32 | Bất biến cuối bài | toàn bộ truy vấn §10 đúng |

---

## 7. Thông báo & nhãn tiếng Việt

### 7.1 Ai được báo gì (gửi SAU commit qua `NOTIFICATION_GATEWAY`, `type: 'payment'`; lỗi thông báo bị nuốt + `logger.warn`, không ảnh hưởng tiền)
| Sự kiện | Người nhận | Nội dung | `link` |
|---|---|---|---|
| Ghi có thành công (`credited > 0`) | thành viên shop có quyền `shop.wallet.read` (`ShopQueryApi.memberUserIdsWithPermission(shopId, 'shop.wallet.read')` — chủ shop; nhân viên không có quyền thì không nhận) | tiêu đề `Nạp cọc qua PayOS thành công: +{money(delta).display}`; nội dung `Ví đặt cọc COD đã được cộng {delta}. Số dư hiện tại {balanceAfter}.` | `/vendor/wallet` |
| Trả thừa / trả trùng / tiền về muộn / kết thúc thiếu | người có `supplier.wallet.approve` (`UserDirectoryGateway.staffUserIdsWithPermission('supplier.wallet.approve')` — kế toán, admin; lỗi tra cứu ⇒ nuốt, coi như không có người nhận) | `Nạp cọc PayOS: {shopName} trả thừa` · `…chuyển thêm lần nữa` · `…tiền về muộn sau khi link đã đóng` · `…kết thúc thiếu`; nội dung nêu mã PayOS, yêu cầu X, đã nhận Y, "đã ghi có vào ví, không hoàn" (riêng kết thúc thiếu: "ví giữ phần đã nhận") | `/shop/wallets` |
| Webhook số tiền không hợp lệ / thiếu `reference` | người có `supplier.wallet.approve` | `Nạp cọc PayOS: webhook bất thường — mã {payosOrderCode}`; nội dung nói rõ "chưa ghi có; hệ thống sẽ dò lại PayOS" hoặc "cần kiểm tra thủ công" | `/shop/wallets` |
| Ghi có bình thường (đủ, không thừa) | kế toán KHÔNG được báo | — | — |

`payload` thông báo: `{ topupId, reason }` (reason ∈ `overpaid|duplicate|late|partial_closed|invalid_amount|unkeyed`). Tên khoá không chứa chuỗi bị `sanitizeSummary` che.

### 7.2 Nhãn (FE)
`lib/labels.ts` (thêm `TOPUP_STATUS: Record<string, StatusMeta>`, dùng `StatusMeta` sẵn có):
| Mã | Nhãn | Tông |
|---|---|---|
| `creating` | Đang tạo link | `pending` |
| `pending` | Chờ thanh toán | `warning` |
| `partial` | Đã nhận một phần | `warning` |
| `paid` | Đã nhận đủ | `success` |
| `expired` | Hết hạn | `neutral` |
| `cancelled` | Đã huỷ | `neutral` |
| `failed` | Tạo link lỗi | `danger` |

Hiển thị ghép: `expired|cancelled` mà `receivedAmount > 0` ⇒ thêm dòng phụ "đã ghi có {receivedAmount} / {amount}". `features/shop/components/wallet-labels.ts`: `WALLET_TX_LABEL.topup_payos = "Nạp cọc qua PayOS"` (và kiểu `WalletTxType` thêm `"topup_payos"` ở `features/shop/types/wallet.ts`).

---

## 8. Giao diện (chỉ `fashion_frontend_admin`; luật AGENTS.md của repo đó: Rule 0–4, 3 lớp quyền, không import chéo feature, mobile-first 390px, `features/shop/**` + `app/(vendor)/**` + `app/(dashboard)/shop/wallets/**`)

### 8.1 `/vendor/wallet` (cổng chủ shop) — sửa `vendor-wallet-screen.tsx`
- Thẻ số dư: giữ nguyên. Hai nút (đều bọc `PermissionGate permission={PERMISSIONS.shopWalletDepositRequest}`):
  - **"Nạp qua PayOS"** (nút chính) — chỉ hiện khi `wallet.payosTopup?.enabled`; mở `TopupDialog`. Có khoản mở (`payosTopup.active`) thì disabled + tooltip "Đang có link nạp chờ thanh toán".
  - **"Nạp bằng chuyển khoản"** — chính là nút "Nộp tiền đặt cọc" hiện có (đổi nhãn; hành vi cũ giữ NGUYÊN). Khi `payosTopup` vắng/`enabled=false` nút này thành nút chính (như cũ).
- **`ActiveTopupCard`** (hiện khi `payosTopup.active`): số tiền yêu cầu, đã nhận (nếu `partial`), nhãn trạng thái, đếm ngược đến `expiresAt` (`formatRemaining`), nút **"Mở trang thanh toán PayOS"** (mở `checkoutUrl`), **"Kiểm tra lại"** (refetch `GET /shop/wallet/topups/:id` — backend hỏi PayOS), **"Huỷ link"** (`ConfirmDialog` → `POST …/cancel`). Hết hạn mà chưa quét: thẻ biến mất, `TopupDialog` cho tạo mới.
- **`TopupDialog`**: ô số tiền (chỉ chữ số, mẫu `setValueAs` như `DepositDialog`), chip gợi ý 500.000 · 1.000.000 · 2.000.000 · 5.000.000 (≥ `minAmount`, ≤ `maxAmount`), Zod `z.string().regex(/^[1-9]\d{0,13}$/)` + `refine` min/max (đọc từ `payosTopup`). Gửi ⇒ `POST /shop/wallet/topups` ⇒ thành công: `window.location.assign(checkoutUrl)` (cùng tab; PayOS sẽ quay về `returnUrl`). `reused:true` ⇒ toast "Bạn đang có link nạp còn hạn — mở lại link đó" rồi chuyển hướng tới link cũ. Lỗi theo mã: `WALLET_TOPUP_DISABLED` / `WALLET_TOPUP_UNAVAILABLE` / `WALLET_TOPUP_LINK_FAILED` ⇒ toast thông điệp backend + gợi ý "dùng chuyển khoản"; 429 ⇒ thông điệp chung. Footer: nút Huỷ + "Tiếp tục tới PayOS" (spinner khi chờ, disabled khi đang gửi).
- Tab thứ ba cạnh "Lịch sử ví", "Yêu cầu nộp cọc": **"Nạp qua PayOS"** — `MyTopupsTable` (DataTable phân trang server, cột: Thời gian, Số tiền yêu cầu, Đã nhận, Trạng thái (`TOPUP_STATUS` + dòng phụ), Mã PayOS (`font-mono text-xs`)).
- Bốn ghi chú giải thích hiện có ở cuối giữ nguyên; thêm một dòng: "Nạp qua PayOS: ví tự được cộng ngay khi PayOS xác nhận — không cần chờ sàn duyệt."
- Skeleton khớp layout (đã có `Skeleton h-40`); 390px: hai nút xếp dọc, thẻ `ActiveTopupCard` không tràn ngang.

### 8.2 Trang quay lại `/vendor/wallet/payos-return` (mới)
- `src/app/(vendor)/vendor/wallet/payos-return/page.tsx` (server component; đọc `searchParams` là Promise ở Next bản mới — mẫu `fashion_frontend_user/src/app/(shop)/checkout/payos-return/page.tsx`): lấy `orderCode` (cắt 32 ký tự) và `daHuy` (`cancel=true` hoặc `status=CANCELLED`) rồi bọc `RoleGuard` + `PermissionGuard permission={PERMISSIONS.shopWalletRead}` → `<TopupReturnScreen orderCode daHuy />`. Thêm `ROUTES.vendor.walletPayosReturn = "/vendor/wallet/payos-return"` ở `lib/constants.ts`.
- `TopupReturnScreen` (`features/shop/components/vendor/topup-return-screen.tsx`): gọi `useMyTopupByOrderCode(orderCode)` — **polling 3 giây** khi `status ∈ {creating, pending, partial}`, dừng khi sang trạng thái cuối HOẶC sau 180 giây (đây là NGOẠI LỆ của luật "không polling", ghi vào `AGENTS.md` Rule 1 của repo admin — WP-6 làm). FE KHÔNG tin `status` trên URL — chỉ hiển thị kết quả backend trả. Các trạng thái giao diện:
  | Điều kiện | Hiển thị |
  |---|---|
  | đang tải | "Đang xác nhận với PayOS…" (skeleton) |
  | `paid` | "Nạp cọc thành công" + "Đã ghi có {receivedAmount} vào ví" (+ nhắc nếu `receivedAmount > amount`: "Bạn đã chuyển thừa {chênh} — số tiền thừa cũng đã nằm trong ví") + nút "Về ví đặt cọc" |
  | `partial` | "Đã nhận một phần {received} / {amount}" + "Link còn hiệu lực đến {expiresAt}: chuyển nốt phần còn lại" + nút "Mở lại trang thanh toán" |
  | `pending`/`creating` (đang poll) | "Đang chờ ngân hàng xác nhận…" — tự cập nhật; sau 180 giây: "Chưa nhận được. Nếu bạn đã chuyển tiền, ví sẽ tự cập nhật trong ít phút (hệ thống tự dò lại PayOS)" + nút "Kiểm tra lại" |
  | `cancelled` hoặc `daHuy` mà chưa nhận | "Bạn đã huỷ thanh toán" + "Nạp lại" |
  | `expired` | "Link đã hết hạn" + (nếu `received>0`: "đã ghi có {received}") + "Nạp lại" |
  | `failed` | "Không tạo được link thanh toán" + "Nạp lại" |
  | 404 / lỗi | thông báo đọc được + nút "Về ví" (không bao giờ trang trắng) |
  Thành công/đổi trạng thái ⇒ `invalidateByPath(qc, "/api/v1/shop/wallet")` để số dư/COD cập nhật.

### 8.3 `/shop/wallets` (cổng sàn) — sửa `wallets-screen.tsx`
- Thêm tab thứ ba **"Nạp qua PayOS"** (xem-only; không `PermissionGate` ghi vì không có hành động): `WalletTopupsTab` (`features/shop/components/platform/wallet-topups-tab.tsx`) — `FilterTabs` lọc theo MỘT `status`: Tất cả (mặc định `""`) · Chờ thanh toán (`pending`) · Một phần (`partial`) · Đã nhận đủ (`paid`) · Hết hạn (`expired`) · Đã huỷ (`cancelled`) · Tạo link lỗi (`failed`); bảng: Gửi lúc · Gian hàng (`shopName`) · Yêu cầu · Đã nhận (so màu: = hoặc > yêu cầu xanh; 0 < … < yêu cầu cam) · Trạng thái (`TOPUP_STATUS` + dòng phụ) · Mã PayOS · nút "Chi tiết" mở `Dialog` hiển thị các `receipts` (`reference`, số tiền, giờ) để đối chiếu PayOS (gọi `GET /admin/wallet-topups/:id`). KHÔNG có nút Duyệt/Từ chối.
- Tab "Khoản nộp cọc" (chuyển khoản tay): giữ nguyên hành vi; thêm một dòng chú thích dưới bảng "Khoản nạp qua PayOS tự ghi có ví khi PayOS xác nhận — xem tab 'Nạp qua PayOS'; không duyệt tay." (đây là chỗ thay cho "nhãn phương thức": mỗi phương thức một tab, vì là hai bảng riêng — D1).
- Bảng "Ví các gian hàng" không đổi. Sổ cái từng shop (nếu màn nào đang hiển thị) dùng `WALLET_TX_LABEL.topup_payos`.

### 8.4 Cấu hình `returnUrl` / `cancelUrl` PayOS cho cổng vendor
- Backend: env **`EF_ADMIN_URL`** (URL công khai của web quản trị, không dấu `/` cuối; mặc định `http://localhost:3001` = cổng dev `next dev -p 3001`). `returnUrl = cancelUrl = ${EF_ADMIN_URL}/vendor/wallet/payos-return` (PayOS tự thêm `?code=&id=&cancel=&status=&orderCode=`).
- Thêm vào `src/config/env.ts` (zod), `.env.example`, `deploy/.env.production.example` (cạnh `EF_WEB_URL`), `docs/07_KEYS_CHECKLIST.md`, `docs/08_DEPLOY.md`. Production: BẮT BUỘC `https://`; sai ⇒ chỉ tính năng nạp trả 503 `WALLET_TOPUP_UNAVAILABLE` (app vẫn chạy). Harness: `auditenv.sh` đặt `EF_ADMIN_URL=http://localhost:3401`.
- Webhook dùng CHUNG URL đã khai trong dashboard PayOS (`{EF_PUBLIC_URL}/api/v1/payments/payos/webhook`) — không cần khai thêm.
- Giới hạn PayOS: `description` ≤ 25 ký tự (≤ 9 nếu tài khoản PayOS chưa liên kết ngân hàng — xem PLAN-0025 §2.6): mô tả nạp cọc `NAPCOC <mã shop>` cắt 25; nếu PayOS thật từ chối vì mô tả dài, chỉnh MỘT chỗ `topupDescription`.

---

## 9. Ma trận kiểm thử BẮT BUỘC

### 9.1 (a) Unit test jest — liệt kê từng `it('[MÃ] …')` (WP-4 viết; test đồng thời dùng DB giả có KHOÁ DÒNG FIFO + transaction hoàn tác + giả lập P2002 cho 4 chỉ mục UNIQUE; mẫu: `payment-payos.spec.ts` `lock()` ~282, `$transaction` ~552, `p2002` ~215, `matchesRow` ~190)
Quy ước: khai báo test bằng chuỗi `'[MÃ] mô tả'`; cột "Phủ" = mã kịch bản §6.6.

**`shop-wallet/shop-wallet-topup.fixture.ts`** (file hỗ trợ, KHÔNG phải spec): DB giả `buildTopupFixture()` trả `{ service, settle, wallet, payos, db, state, calls, ... }` với: `shopCodTopup`, `shopCodTopupReceipt`, `shopCodWallet`, `shopCodWalletTransaction`, `paymentAuditLog` giả; `$queryRaw` chỉ chấp nhận câu `FOR UPDATE` của `shop_cod_topups` và `shop_cod_wallets` (ghi vào `calls` theo thứ tự để test thứ tự khoá); `$transaction` có rollback; P2002 cho: `payos_order_code`, "một khoản mở/shop" (status ∈ OPEN), `(topup_id, reference)`, `ref_key`; CHECK `topup_payos` amount > 0 giả lập; `PayosService` THẬT với `createPaymentLink/getPaymentLink/cancelPaymentLink` bị spy (fetch toàn cục bị chặn); notifier/users/shops giả; đồng hồ giả điều khiển được.

**`shop-wallet/shop-wallet-topup.service.spec.ts` — `ShopWalletTopupService`**
- `[WTU-01]` cờ tắt ⇒ 409 `WALLET_TOPUP_DISABLED`, không gọi PayOS, không ghi DB (WTP-18)
- `[WTU-02]` PayOS chưa cấu hình ⇒ 503 `WALLET_TOPUP_UNAVAILABLE` (WTP-18)
- `[WTU-03]` production + `EF_ADMIN_URL` là `http://…` ⇒ 503 `WALLET_TOPUP_UNAVAILABLE`; production + `https://…` ⇒ qua (WTP-18)
- `[WTU-04]` dưới min ⇒ 400 `WALLET_DEPOSIT_TOO_SMALL`; trên max ⇒ 400 `WALLET_TOPUP_TOO_LARGE`; đúng min và đúng max ⇒ được (WTP-23)
- `[WTU-05]` tạo thành công: thứ tự `create(creating)` → `createPaymentLink` → `markLinkCreated`; PayOS gọi NGOÀI transaction (số transaction đang mở lúc gọi = 0); mã trong dải `^5\d{15}$`; `description` = `NAPCOC <mã shop>` ≤ 25; `returnUrl` = `cancelUrl` = `${EF_ADMIN_URL}/vendor/wallet/payos-return`; `expiredAt` = now + setting phút; audit `WALLET_TOPUP_CREATED`; response có `checkoutUrl`, `reused:false` (WTP-01)
- `[WTU-06]` gọi lần hai khi còn link `pending` còn hạn ⇒ trả link cũ (`reused:true`), KHÔNG gọi PayOS, KHÔNG tạo dòng; số tiền khác vẫn trả link cũ (WTP-20)
- `[WTU-07]` hai lần tạo ĐỒNG THỜI ⇒ đúng 1 dòng; bên thua nhận `reused` hoặc 409 `WALLET_TOPUP_IN_PROGRESS`, không 500 (WTP-21)
- `[WTU-08]` link `pending` quá `expires_at` chưa quét ⇒ gọi `settle.reconcileOne(id,{forceClose:true})` rồi tạo mới (WTP-22)
- `[WTU-09]` dòng `creating` < 60 s ⇒ 409 `WALLET_TOPUP_IN_PROGRESS`; > 60 s ⇒ đóng rồi tạo mới
- `[WTU-10]` PayOS trả `checkoutUrl: null` hoặc ném ⇒ 503 `WALLET_TOPUP_LINK_FAILED`; `markLinkFailed` được gọi; không còn khoản mở; lần sau tạo được (WTP-17)
- `[WTU-11]` trùng mã PayOS (P2002, không có khoản mở) ⇒ sinh mã mới tối đa 5 lần rồi 503
- `[WTU-12]` `getMine`: dòng của shop khác ⇒ 404; khoản còn mở ⇒ gọi `reconcileOne` với `minIntervalMs ≥ 8000`; khoản đã đóng ⇒ KHÔNG gọi; `reconcileOne` ném ⇒ vẫn trả dòng (lỗi chỉ log) (WTP-24)
- `[WTU-13]` `getMineByOrderCode`: mã không phải `^\d{1,16}$` ⇒ 404 và KHÔNG chạm DB; của shop khác ⇒ 404
- `[WTU-14]` `cancelMine`: `pending` ⇒ `cancelled` rồi mới gọi `payos.cancelPaymentLink` (NGOÀI transaction, ném lỗi vẫn thành công); `paid` ⇒ 409 `WALLET_TOPUP_INVALID_STATE`; shop khác ⇒ 404 (WTP-25)
- `[WTU-15]` `summaryFor`: `enabled=false` khi cờ tắt / PayOS thiếu / `EF_ADMIN_URL` không dùng được; `active=null` khi hết hạn hoặc đã đóng; `minAmount`/`maxAmount` đúng setting
- `[WTU-16]` `listMine` lọc theo `shopId` ngữ cảnh + `status`, phân trang; `listAll` lọc `shopId`/`status`; `getForAdmin` trả kèm `receipts` theo thời gian

**`shop-wallet/shop-wallet-topup-settle.service.spec.ts` — `ShopWalletTopupSettleService`**
- `[WTS-01]` đủ tiền ⇒ `paid`, `paid_at`, ví +X, 1 biên nhận, 1 dòng sổ `topup_payos` có `topup_id`+`ref_key`, audit `WALLET_TOPUP_CREDITED`, thông báo chủ shop; KHÔNG báo kế toán (WTP-01)
- `[WTS-02]` thiếu ⇒ `partial`, ví +a; không báo kế toán (WTP-02)
- `[WTS-03]` thiếu rồi nốt (2 `reference`) ⇒ `paid`, 2 dòng sổ, Σ = tổng; `ref_key` hai dòng khác nhau (WTP-03)
- `[WTS-04]` thừa ⇒ ví +TOÀN BỘ thực nhận, `paid`, báo kế toán "overpaid", không hoàn (WTP-04)
- `[WTS-05]` replay cùng `reference` ⇒ không thêm biên nhận/dòng sổ/ví; kết quả `replay` (WTP-05)
- `[WTS-06]` 3 webhook cùng `reference` ĐỒNG THỜI (khoá dòng FIFO, xen kẽ ép buộc) ⇒ đúng 1 biên nhận + 1 dòng sổ (WTP-06)
- `[WTS-07]` đã `paid`, webhook khác `reference` ⇒ cộng thêm đúng số, báo kế toán "duplicate" (WTP-07)
- `[WTS-08]` 2 webhook khác `reference` đồng thời ⇒ cả hai cộng; Σ đúng; thứ tự khoá trong `calls`: `FOR UPDATE topups` TRƯỚC `wallet upsert/FOR UPDATE`; KHÔNG có lệnh khoá đơn/payment (WTP-08)
- `[WTS-09]` webhook thiếu `reference` nhưng có `transactionDateTime` ⇒ dùng khoá ghép `<mã>:<giờ>:<số tiền>`; thiếu CẢ HAI ⇒ outcome `unkeyed`, KHÔNG ghi có, báo kế toán, 200
- `[WTS-10]` `amount` không hợp lệ (NaN, ≤ 0, số thập phân, > 99.999.999.999.999) ⇒ outcome `ignored`, không ghi có, báo kế toán, `logger.error`
- `[WTS-11]` `paidOk=false` ⇒ `ignored`, không ghi gì
- `[WTS-12]` mã không thuộc khoản nạp nào ⇒ trả `null`; mã không phải số / 17 chữ số ⇒ `null` và KHÔNG chạm DB (WTP-26)
- `[WTS-13]` poll: `amountPaid` > đã ghi có ⇒ ghi có phần chênh, `ref_key` theo luỹ kế; chạy lại cùng số ⇒ không ghi thêm (WTP-09)
- `[WTS-14]` webhook rồi poll cùng khoản ⇒ không cộng đôi; poll rồi webhook cùng khoản ⇒ không cộng đôi, biên nhận vẫn ghi; poll luỹ kế gồm 2 khoản rồi 2 webhook đến sau ⇒ không cộng dư (WTP-10, WTP-11)
- `[WTS-15]` poll luỹ kế THẤP hơn đã ghi có ⇒ ví/`received` không đổi, không ném (WTP-12)
- `[WTS-16]` PayOS lỗi / trả `{}` ⇒ `reconcileOne` = `unknown`; khoản mở KHÔNG bị đóng (trừ `creating` mồ côi > 90 s ⇒ `failed`); không ghi gì
- `[WTS-17]` PayOS báo `EXPIRED`/`CANCELLED` + `received=0` ⇒ `expired`/`cancelled`, `closed_at`; có `received>0 & <amount` ⇒ giữ `received`, báo kế toán "partial_closed" đúng MỘT lần (WTP-13, WTP-15)
- `[WTS-18]` quá `expires_at` + 2 phút ⇒ hỏi PayOS TRƯỚC (có tiền thì ghi có) rồi mới `expired`; chưa quá 2 phút ⇒ chưa đóng (WTP-13)
- `[WTS-19]` webhook trên `expired` ⇒ ghi có; `≥ amount` ⇒ `paid`, `< amount` ⇒ giữ `expired`; báo kế toán "late" (WTP-14)
- `[WTS-20]` webhook trên `cancelled` / `failed` ⇒ ghi có như trên (WTP-14, WTP-25)
- `[WTS-21]` webhook trên `creating` ⇒ ghi có; rồi `markLinkCreated` KHÔNG đổi `partial/paid` về `pending` nhưng lưu `checkoutUrl`/`qrCode`/`paymentLinkId` (WTP-16)
- `[WTS-22]` `markLinkFailed`: `creating`→`failed` (+`linkError` ≤ 255, `closedAt`); nếu đã `partial` (tiền về trước) ⇒ không đổi
- `[WTS-23]` `cancel`: `pending`/`partial` ⇒ `cancelled` (+`cancelledBy`, `closedAt`); `creating`/`paid`/`expired`/`cancelled`/`failed` ⇒ 409; shop khác ⇒ 404 (WTP-25)
- `[WTS-24]` bảng chuyển §4.2 dạng `it.each` (trạng thái × {đủ, thiếu, thừa}) khớp hàm `nextStatusAfterMoney`
- `[WTS-25]` dính deadlock `40P01` lần đầu ⇒ thử lại CẢ transaction và ghi có đúng MỘT lần; lỗi khác không thử lại ⇒ ném (webhook 500)
- `[WTS-26]` lỗi ném ĐÚNG ở câu update dòng nạp (tức SAU khi đã ghi biên nhận + sổ + ví) ⇒ rollback sạch: không biên nhận, không dòng sổ, ví/`received`/`status` nguyên; gửi lại cùng webhook ⇒ ghi có đúng 1 lần (WTP-30)
- `[WTS-27]` DB giả ném P2002 ở `ref_key` (bỏ qua kiểm trước) ⇒ transaction rollback, lỗi nổi lên — không ghi nửa chừng
- `[WTS-28]` thông báo: chủ shop (có `shop.wallet.read`) nhận khi ghi có; thành viên không có quyền KHÔNG nhận; kế toán nhận khi bất thường; thông báo gọi SAU commit (không truyền `tx`); notifier ném ⇒ kết quả vẫn `credited`; `staffUserIdsWithPermission` ném ⇒ nuốt
- `[WTS-29]` `reconcilePending`: chọn đúng tập (mở + đuôi 72 giờ `expired|cancelled`, không có `failed`), chiếm lượt CAS (hai worker không hỏi trùng), tôn trọng `limit`, PayOS thiếu cấu hình ⇒ `{0,0,0}`, một dòng lỗi không dừng cả lô
- `[WTS-30]` shop bị khoá (`shops.existsApproved=false`) / không có trong `ShopQueryApi` ⇒ VẪN ghi có (settle không gọi `existsApproved`) (WTP-19)
- `[WTS-31]` cờ `wallet.payos_deposit_enabled=false` KHÔNG ngăn ghi có từ webhook (settle không đọc cờ) (WTP-18)
- `[WTS-32]` khoá audit không chứa từ nhạy cảm (kiểm bằng regex của `sanitizeSummary`): audit `after` giữ nguyên `received`, `delta`, `balanceAfter`…

**`shop-wallet/shop-wallet-topup.pure.spec.ts` — hàm thuần**
- `[WTX-01]` `parseMoney`: số/chuỗi nguyên hợp lệ ⇒ bigint; `0` chỉ khi `allowZero`; âm, thập phân, `NaN`, `Infinity`, chuỗi chữ, > 99.999.999.999.999, `null`/`undefined` ⇒ `null`
- `[WTX-02]` `receiptRef`: `reference` ưu tiên (trim, cắt 100); thiếu thì `<mã>:<transactionDateTime>:<amount>`; thiếu cả hai ⇒ `null`
- `[WTX-03]` `targetCumulative`: max ba đầu vào; không bao giờ thấp hơn đã ghi có
- `[WTX-04]` `nextStatusAfterMoney` bảng đủ (7 trạng thái × received 0 / < X / = X / > X)
- `[WTX-05]` `PayosService.generateTopupOrderCode()` ∈ [5e15, 6e15), khớp `^5\d{15}$`, ≤ `Number.MAX_SAFE_INTEGER`; 1.000 lần gọi không ra dải của `generateOrderCode()`; `generateOrderCode()` < 5e15 (bảo vệ giả định D4) (WTP-26)

**`shop-wallet/shop-wallet.spec.ts` (BỔ SUNG khối `describe` mới, giữ nguyên bài cũ) — `creditPayosTopup` + 409**
- `[WTW-01]` `creditPayosTopup` cộng đúng, ghi dòng type `topup_payos` có `refKey`/`topupId`, `balanceAfter`
- `[WTW-02]` cùng `refKey` lần hai ⇒ `credited:false`, ví không đổi
- `[WTW-03]` `amount ≤ 0` ⇒ ném, không ghi
- `[WTW-04]` khoá ví trước khi ghi; ví chưa có ⇒ tạo
- `[WTW-05]` ví âm: nợ −200.000 + nạp 500.000 ⇒ 300.000 (cộng đại số), COD mở (≥ 200.000)
- `[WTW-06]` ví 0 + nạp 150.000 ⇒ COD vẫn đóng (< `wallet.min_balance_for_cod`); nạp thêm ≥ ngưỡng ⇒ mở
- `[WTW-07]` `approveDeposit`/`rejectDeposit` với id của khoản PayOS ⇒ 409 `WALLET_DEPOSIT_PAYOS_NOT_MANUAL`; id lạ ⇒ 404 như cũ (WTP-24)
- `[WTW-08]` quét mã nguồn `src/modules/**` (trừ `*.spec.ts`): đúng 1 chỗ `shopCodWalletTransaction.create(` và đúng 1 chỗ `shopCodWallet.update(` (hàm `post`) — "một hàm ghi sổ duy nhất"
- `[WTW-09]` luồng tay (nộp cọc, duyệt, từ chối, chỉnh ví) giữ nguyên — chạy lại toàn bộ bài cũ của file, không sửa kết quả mong đợi (WTP-27)

**`payment/payment-topup-routing.spec.ts` — định tuyến webhook** (dựng `PaymentService` tối thiểu với stub; KHÔNG dùng `buildFixture` khổng lồ)
- `[WTR-01]` chữ ký sai ⇒ 401, không gọi `topups` (WTP-26)
- `[WTR-02]` mã tìm thấy là payment đơn ⇒ đi đường đơn, KHÔNG gọi `topups`
- `[WTR-03]` mã hợp lệ định dạng, không phải đơn, `topups` trả `null` ⇒ 200 `Ignored: unknown order`
- `[WTR-04]` `topups` trả kết quả ⇒ 200 `{code:'00', message}`; ném ⇒ 500 `{code:'99'}`
- `[WTR-05]` mã sai định dạng ⇒ không gọi `topups`; `paidOk=false` được truyền xuống `topups`
- `[WTR-06]` PayOS chưa cấu hình ⇒ 401 như cũ

**`shop-wallet/shop-wallet-topup.job.spec.ts` — `WalletTopupJobs`**
- `[WTJ-01]` gọi `settle.reconcilePending`; không có gì ⇒ im lặng; có `credited+closed>0` ⇒ `warn` kèm số liệu
- `[WTJ-02]` lỗi bị nuốt + log, cờ nhả nên lượt sau vẫn chạy; không chạy chồng
- `[WTJ-03]` `@Interval` = 120000 ms (`Reflect.getMetadata('SCHEDULE_INTERVAL_OPTIONS', …)`)

**`shop-wallet/shop-wallet-topup.controller.spec.ts` — route/DTO/cách ly**
- `[WTC-01]` mỗi route có đúng phương thức + đường dẫn; `by-order-code` khai báo TRƯỚC `:id`
- `[WTC-02]` route vendor có `ShopContextGuard` + `RequireShopPermission` đúng mã (`shop.wallet.deposit_request` cho tạo/huỷ, `shop.wallet.read` cho đọc); route sàn có `RequirePermission('supplier.wallet.read')`; `@RateLimit` có trên tạo/đọc/huỷ đúng tên-giới hạn
- `[WTC-03]` DTO: `amount` sai định dạng (0, âm, thập phân, chữ, 15 chữ số, rỗng) ⇒ bị `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`) từ chối; `status` ngoài tập ⇒ từ chối; `size` > 100 từ chối
- `[WTC-04]` response vendor có `checkoutUrl` chỉ khi `pending|partial` còn hạn; admin luôn `null`; `canCancel` đúng
- `[WTI-01]` cách ly: khoản của shop B không xem được qua `GET :id`, `by-order-code`, `list`, không huỷ được từ phiên shop A (404); `shopId` trong query/body bị bỏ qua
- `[WTI-02]` `GET /shop/wallet` trả `payosTopup`; `GET /admin/shops/:id/wallet` KHÔNG có trường đó

**`topup-migration.guard.spec.ts` (đặt cạnh các spec trên) — bảo vệ migration**
- `[WTM-01]` đọc `prisma/migrations/20261103090000_wallet_payos_topup/migration.sql`: mọi `CREATE TABLE/INDEX` có `IF NOT EXISTS`; có 4 chỉ mục UNIQUE bắt buộc (§3.1) + 6 CHECK; KHÔNG chứa `DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|ALTER COLUMN` và chỉ có `DROP CONSTRAINT IF EXISTS` cho đúng 2 CHECK của sổ cái

### 9.2 (b) Bài harness Postgres THẬT `t11-wallet-topup-payos.mjs` (WP-5; điều phối viên chạy — PayOS GIẢ, không mạng ngoài)
File: `docs/plans/assets/e2e-audit/t11-wallet-topup-payos.mjs` (mẫu cấu trúc: `t09-explore-money.mjs` — `group()/check()/note()`, `process.on('uncaughtException')`, `L.saveResults(process.env.OUT ?? 'out-t11.json')`, dòng cuối `TỔNG nhóm 11: x/y PASS` để `run-all.sh` gom). Mở rộng PayOS giả `mock-payos.mjs` (cùng WP) để có NGUỒN SỰ THẬT độc lập về tiền PayOS nhận:
- `POST /_receive { orderCode, amount, reference?, webhook: 'send'|'skip' }`: cộng `link.amountPaid += amount`, `link.status = amountPaid ≥ link.amount ? 'PAID' : 'UNDERPAID'`, ghi `S.transfers.push({ orderCode, reference, amount, at })`; `webhook:'send'` ⇒ gửi webhook ký HMAC (cùng cách `/_confirm`, dùng hàm dùng chung `buildWebhook(link, amount, reference)`) tới `process.env.BACKEND_WEBHOOK`; trả `{ reference, webhookStatus }`. `reference` mặc định `MOCK<Date.now()><ngẫu nhiên>`.
- `GET /_transfers?orderCode=` (liệt kê khoản đã nhận; `fresh()` khởi tạo `transfers: []`; `/_reset` xoá); `POST /_link_status { orderCode, status }` (đặt `EXPIRED`/`CANCELLED`/`PENDING` để thử poll); `/_confirm/:orderCode` cũng `push` vào `S.transfers` để bài "người dùng bấm trang PayOS giả" có số liệu gốc.
- `jobs.cjs`: thêm `case 'topup-reconcile': out = await topupJobs().reconcileWalletTopups(); break;` với `topupJobs = () => app.get(require(DIST + 'modules/payment/shop-wallet/shop-wallet-topup.job.js').WalletTopupJobs, { strict: false })`.
- `auditenv.sh`: thêm `export EF_ADMIN_URL="http://localhost:3401"`. `run-all.sh`: thêm `t11-wallet-topup-payos` SAU `t10-lifecycle-extras` vào danh sách bài. `README.md` (assets): thêm mục 9c mô tả t11 + endpoint mock mới.
- Đầu bài: `L.mockReset(); L.mockBalance(5e9); L.resetRateLimit();` lưu giá trị cũ của `wallet.payos_deposit_enabled` rồi `L.setSetting('wallet.payos_deposit_enabled', true)`; ghi `drift0[shop] = balance − Σ sổ cái` cho mọi shop dùng trong bài (bài `t03` ghi THẲNG `balance` nên bất biến "ví = Σ sổ" chỉ kiểm theo ĐỘ LỆCH không đổi). Cuối bài (kể cả khi lỗi, `try/finally`): đóng mọi khoản mở của các shop đã dùng (`UPDATE … SET status='cancelled', closed_at=now() WHERE status IN ('creating','pending','partial')`), trả setting về như cũ, gỡ trigger thử rollback.
- Helper trong bài: `owner(slug)`=`owner:${slug}`; `create(slug, amount)`=`api('POST','/shop/wallet/topups',{as:owner(slug),body:{amount:String(amount)}})`; `topupRow(id)`; `ledger(topupId)`; `walletOf(shopId)`→`{balance, ledgerSum, drift}`; `receive(code, amount, {reference, webhook})` (mock `/_receive`); `replay(code, amount, reference, n, parallel)` (`L.sendWebhook`); `cancelOpen(slug)`; `deadlocks()` (`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`; đọc lần sau CHỜ `await L.sleep(1500)` vì bộ đếm cập nhật trễ). Dùng nhiều shop (`techzone`, `mobilehub`, `sportplanet`, `sneaker`, `ngonviet`, `beautybox`) để mỗi nhóm bài có shop riêng (mỗi shop chỉ một khoản mở).
- Mã kịch bản: **mỗi dòng bảng §6.6 một `check('WTP-xx', …)`** (WTP-01…WTP-32), cộng các bài đặc biệt:
  - `WTP-08/28` ĐỒNG THỜI: `Promise.all` 3 webhook khác `reference` + `jobs.cjs topup-reconcile` + 5 × `GET /shop/wallet/topups/:id` (+ job hết hạn) ⇒ `deadlocks` sau − trước = 0, không 5xx, ví = Σ `/_transfers` của mã đó.
  - `WTP-29`: khoản đã nạp để COD mở; đặt đơn COD của shop đó, chuyển tới `delivered` (api tự thêm hãng + mã vận đơn) ĐỒNG THỜI với webhook nạp, 6 vòng ⇒ `balance − Σ sổ = drift0`, 0 deadlock.
  - `WTP-16` xen kẽ thật: `L.mockCtl({ delayMs: 4000 })` rồi bắn `POST /shop/wallet/topups` (không await); đọc dòng `creating` trong DB (≤ 3 s) lấy `payos_order_code`; `L.sendWebhook(code, a, { reference })`; await tạo link; `L.mockCtl({ delayMs: 0 })`; kiểm `status` ≠ `pending`, `received = a`, `checkout_url` có giá trị.
  - `WTP-30` rollback: `CREATE FUNCTION payment.t11_fail_topup() … RAISE EXCEPTION … IF NEW.received_amount = 777777` + `CREATE TRIGGER t11_fail_topup BEFORE UPDATE ON payment.shop_cod_topups …`; khoản X = 1.000.000; webhook amount 777777 ⇒ HTTP 500; kiểm biên nhận = 0, dòng sổ = 0, ví = như trước, `received = 0`, `status` nguyên; `DROP TRIGGER`; gửi LẠI đúng webhook (cùng `reference`) ⇒ 200, ví +777.777 đúng 1 lần; gửi lần nữa ⇒ không thêm. (Phụ thuộc: câu UPDATE dòng nạp là câu ghi CUỐI — §6.1.)
  - `WTP-31` "thao tác giả lập": xem §9.3-a.
  - `WTP-32` bất biến: chạy truy vấn §10, so với tổng `/_transfers` của PayOS giả.
- Báo cáo: mỗi `check` in PASS/FAIL; cuối bài in `deadlocks` trước/sau, tổng ví vs tổng PayOS giả (`note`).

### 9.3 (c) Thao tác giả lập qua API + kịch bản trình duyệt cho điều phối viên
**(a) `WTP-31` — như người dùng thật, chỉ qua API (trong t11):** (1) shop chưa đủ cọc (chọn shop có ví < ngưỡng; nếu cần dùng `POST /admin/shops/:id/wallet/adjust` để đưa về < 200.000 — KHÔNG ghi trực tiếp SQL) ⇒ khách đặt COD của shop đó ⇒ 409 `ORDER_COD_NOT_AVAILABLE`; (2) chủ shop `POST /shop/wallet/topups {amount:"600000"}` ⇒ 201 `checkoutUrl` trỏ PayOS giả; (3) "người trả" bấm trang PayOS giả: `POST http://127.0.0.1:4020/_confirm/<payosOrderCode>` (webhook thật được gửi); (4) chờ tối đa 10 s: `GET /shop/wallet/topups/:id` ⇒ `paid`; `GET /shop/wallet` ⇒ số dư +600.000, `codEnabled=true`; sổ cái có dòng `topup_payos`; (5) khách đặt COD ⇒ 201; shop chuyển `confirmed→packing→shipping→delivered` ⇒ hoa hồng trừ (`cod_commission`), `balance_after` nối đúng; (6) chủ shop thấy thông báo "Nạp cọc qua PayOS thành công", kế toán KHÔNG có thông báo cho khoản này.

**(b) Kịch bản trình duyệt (điều phối viên chạy trên bản sao FE `D:\fitly-e2e\admin` cổng 3401 trỏ backend cô lập :4030, PayOS giả :4020; luật PLAN-0040 §3.8: tab ẩn thì trang không hydrate ⇒ `tabs_select` + click toạ độ thật; `EF_ADMIN_URL=http://localhost:3401`; bật cờ `wallet.payos_deposit_enabled` bằng `/system/settings` hoặc SQL):**
| # | Vai | Thao tác | Kỳ vọng |
|---|---|---|---|
| B1 | Chủ shop | `/vendor/wallet` khi cờ TẮT, rồi BẬT | Tắt: chỉ có "Nạp bằng chuyển khoản" (như cũ). Bật: thêm nút "Nạp qua PayOS" (nút chính) |
| B2 | Chủ shop | "Nạp qua PayOS" → nhập 100.000 | Lỗi "Tối thiểu 500.000 ₫"; chip gợi ý hoạt động |
| B3 | Chủ shop | Nhập 600.000 → "Tiếp tục tới PayOS" → trang PayOS giả → bấm "Chuyển khoản thành công" | Tự quay về `/vendor/wallet/payos-return?…`: "Đang xác nhận…" rồi "Nạp cọc thành công — đã ghi có 600.000 ₫"; về ví: số dư tăng, COD mở, lịch sử có "Nạp cọc qua PayOS" |
| B4 | Chủ shop | Tạo link rồi đóng tab; mở lại `/vendor/wallet` | Thẻ "Link nạp đang chờ" còn, đếm ngược, "Mở trang thanh toán"; bấm "Nạp qua PayOS" lần nữa ⇒ toast "đang có link còn hạn" + chuyển tới link cũ |
| B5 | Chủ shop | "Huỷ link" | Thẻ biến mất; tab "Nạp qua PayOS" hiện "Đã huỷ" |
| B6 | Điều phối viên (API) → Chủ shop | `POST mock /_receive` trả thiếu 200.000/600.000 (webhook send) | Thẻ/return hiện "Đã nhận một phần 200.000 / 600.000", link còn hiệu lực; ví +200.000 |
| B7 | Điều phối viên | Gửi lại 3 lần cùng webhook | Số dư KHÔNG đổi thêm |
| B8 | Điều phối viên | SQL lùi `expires_at`, `node jobs.cjs topup-reconcile` | "Hết hạn" (kèm "đã ghi có 200.000"); tạo link mới được; chuông kế toán có "kết thúc thiếu" |
| B9 | Kế toán | `/shop/wallets` → tab "Nạp qua PayOS" | Thấy khoản (mã PayOS, đã nhận, trạng thái); "Chi tiết" hiện các `reference`; KHÔNG có nút Duyệt/Từ chối; tab "Khoản nộp cọc" tay vẫn duyệt được |
| B10 | Nhân viên shop (`shop_staff`) | `/vendor/wallet` | Màn 403 (thiếu `shop.wallet.read`); không thấy nút |
| B11 | Quản lý (chỉ `supplier.wallet.read`) | `/shop/wallets` | Xem được tab PayOS; không có nút nào ghi |
| B12 | Quản lý khoá shop khi link đang chờ | Chủ shop mở `/vendor/wallet` | 403 `SHOP_NOT_APPROVED` (như mọi route shop); trả tiền ở PayOS giả vẫn ghi có (kiểm bằng SQL/màn ví sàn); mở khoá ⇒ ví thấy tiền |
| B13 | Chủ shop | 390px: dialog, thẻ link, trang quay lại | Không tràn ngang; nút bấm được |
| B14 | Chủ shop + Kế toán | Chuông | Chủ shop có "Nạp cọc qua PayOS thành công"; kế toán chỉ có cảnh báo khi thừa/trùng/muộn/thiếu |

---

## 10. Bất biến (mỗi bất biến là một truy vấn SQL kiểm được; `0 dòng` = đúng)

```sql
-- I1  Σ ghi có ví loại nạp-PayOS của MỖI khoản = received_amount của khoản đó
SELECT t.id FROM payment.shop_cod_topups t
 WHERE t.received_amount <> COALESCE((SELECT SUM(l.amount) FROM payment.shop_cod_wallet_transactions l WHERE l.topup_id = t.id AND l.type = 'topup_payos'), 0);

-- I2  received = GREATEST(Σ biên nhận webhook, polled_amount)  (không bao giờ thấp hơn: ghi có là đơn điệu)
SELECT t.id FROM payment.shop_cod_topups t
 WHERE t.received_amount < GREATEST(COALESCE((SELECT SUM(r.amount) FROM payment.shop_cod_topup_receipts r WHERE r.topup_id = t.id), 0), t.polled_amount);

-- I3  Không có hai dòng sổ cái cùng khoá nguồn
SELECT ref_key, count(*) FROM payment.shop_cod_wallet_transactions WHERE ref_key IS NOT NULL GROUP BY ref_key HAVING count(*) > 1;

-- I4  Mỗi shop: balance − Σ sổ cái KHÔNG đổi so với đầu bài (harness so với drift0; DB sạch thì = 0)
SELECT w.shop_id, w.balance - COALESCE(SUM(l.amount), 0) AS drift FROM payment.shop_cod_wallets w
  LEFT JOIN payment.shop_cod_wallet_transactions l ON l.shop_id = w.shop_id GROUP BY w.shop_id, w.balance;

-- I5  Ví không bao giờ GIẢM vì luồng nạp: mọi dòng topup_payos > 0 và có đủ khoá nguồn (CHK cũng chặn ở DB)
SELECT id FROM payment.shop_cod_wallet_transactions WHERE type = 'topup_payos' AND (amount <= 0 OR topup_id IS NULL OR ref_key IS NULL);

-- I6  Trạng thái khớp con số: paid ⇔ received ≥ amount; pending/creating ⇒ received = 0; partial ⇒ 0 < received < amount
SELECT id, status FROM payment.shop_cod_topups
 WHERE (status = 'paid') <> (received_amount >= amount)
    OR (status IN ('creating', 'pending') AND received_amount > 0)
    OR (status = 'partial' AND NOT (received_amount > 0 AND received_amount < amount));

-- I7  Mỗi shop tối đa MỘT khoản mở
SELECT shop_id, count(*) FROM payment.shop_cod_topups WHERE status IN ('creating', 'pending', 'partial') GROUP BY shop_id HAVING count(*) > 1;

-- I8  Khoản đã đóng phải có closed_at; mã PayOS nằm đúng dải
SELECT id FROM payment.shop_cod_topups WHERE (status IN ('expired', 'cancelled', 'failed') AND closed_at IS NULL) OR payos_order_code !~ '^[5-8][0-9]{15}$';

-- I9  Mỗi biên nhận thuộc một khoản tồn tại (FK) và Σ biên nhận ≤ received
SELECT t.id FROM payment.shop_cod_topups t WHERE (SELECT COALESCE(SUM(r.amount), 0) FROM payment.shop_cod_topup_receipts r WHERE r.topup_id = t.id) > t.received_amount;
```
Bất biến TỔNG (harness `WTP-32`): `Σ ví được ghi có từ PayOS (Σ received_amount của mọi khoản của bài) = Σ tiền PayOS giả nhận (Σ /_transfers của đúng các mã đó)` — nguồn sự thật độc lập, không đi qua code của hệ thống. Cộng bài rollback (`WTP-30`) và đo `pg_stat_database.deadlocks` (trước/sau = 0) ở `WTP-08/28/29`.

---

## 11. Giao việc cho agent code — theo PHA (mỗi gói WP một agent Haiku)

Nguyên tắc chia: phân vùng file KHÔNG chồng nhau; mỗi file chỉ thuộc đúng MỘT gói. Hợp đồng giữa các gói (chữ ký hàm, hàm khởi tạo, tên hằng, DTO) được GHIM ở WP-1/WP-1F (Pha 1) nên các gói Pha 2 chạy song song mà không đợi nhau. Điều phối viên (không phải agent Haiku) chạy build/verify/harness/trình duyệt/git.

| Pha | Gói | Việc | Repo | Chạy |
|---|---|---|---|---|
| 1 | **WP-1** | Nền BE: migration + Prisma + hằng số + setting + env + `generateTopupOrderCode` + DTO + kiểu + khung hai service (chữ ký ghim) + đăng ký module | BE | tuần tự, MỘT agent |
| 1 | **WP-1F** | Nền FE: kiểu + hook + nhãn + hằng số route | admin FE | song song với WP-1 (không đợi BE) |
| — | **CỔNG 1** | Điều phối viên: `npx tsc --noEmit` (BE + admin), `npx prisma generate`, `npm run migration:check` trên DB trống (docker), lint file đổi | — | — |
| 2 | **WP-2** | Dịch vụ tạo link / đọc / huỷ + controller vendor & sàn | BE | song song |
| 2 | **WP-3** | Ghi có · webhook · dò · hết hạn · thông báo · job · `creditPayosTopup` · móc `PaymentService` | BE | song song |
| 2 | **WP-4** | Unit test jest + DB giả (`fixture`) | BE | song song |
| 2 | **WP-5** | Harness `t11` + mở rộng PayOS giả + `jobs.cjs` + `run-all.sh` + README harness | BE (assets) | song song |
| 2 | **WP-6** | FE vendor: `/vendor/wallet` + trang quay lại + AGENTS.md Rule 1 + plan FE | admin FE | song song (sau WP-1F) |
| 2 | **WP-7** | FE sàn: tab "Nạp qua PayOS" ở `/shop/wallets` | admin FE | song song (sau WP-1F) |
| 2 | **WP-8** | Tài liệu BE (`docs/06`, `02`, `07`, `08`, `12`, README) | BE (docs) | song song |
| — | **CỔNG 2** | Điều phối viên: BE `lint` + `check:boundaries` + `tsc` + `npm test` (toàn bộ, không giảm số test) + `build` + `migration:check`; admin `npm run verify`; vá lỗi do test báo (trả cho đúng gói) | — | — |
| 3 | điều phối viên | Dựng môi trường harness (PLAN-0040 §11) → `reset-env.sh` → `t11` (lặp tới 100% ✔) → `run-all.sh` (không hồi quy so `baseline-2026-10-27-final.json`) → `api:sync` + `perms:sync` (admin) → trình duyệt B1–B14 → `perms:sync` | — | — |
| 4 | agent KHÁC (không viết code này) | Rà soát độc lập (chỉ đọc): thứ tự khoá, idempotency, quyền, lộ thông tin, migration (§12.4) | — | — |

### WP-1 — Nền BE (Pha 1, MỘT agent)
**Đọc trước:** §2, §3, §5.3–5.4, §6.2–6.3, AGENTS.md BE (Migration/Schema Rule), `shop-wallet.service.ts`, `payos.service.ts`, `payment.constants.ts`.
**Tạo/sửa (đúng danh sách):**
1. TẠO `prisma/migrations/20261103090000_wallet_payos_topup/migration.sql` — chép NGUYÊN VĂN khối SQL §3.1.
2. SỬA `prisma/schema/payment.prisma` — thêm 2 model + 2 trường ledger + `@@index([topupId])` đúng §3.2; chạy `npx prisma generate`.
3. SỬA `src/modules/payment/foundation/payment.constants.ts` — thêm (KHÔNG đổi/xoá hằng cũ):
```ts
WALLET_ERR += { TOPUP_DISABLED:'WALLET_TOPUP_DISABLED', TOPUP_UNAVAILABLE:'WALLET_TOPUP_UNAVAILABLE', TOPUP_LINK_FAILED:'WALLET_TOPUP_LINK_FAILED', TOPUP_TOO_LARGE:'WALLET_TOPUP_TOO_LARGE', TOPUP_NOT_FOUND:'WALLET_TOPUP_NOT_FOUND', TOPUP_INVALID_STATE:'WALLET_TOPUP_INVALID_STATE', TOPUP_IN_PROGRESS:'WALLET_TOPUP_IN_PROGRESS', DEPOSIT_PAYOS_NOT_MANUAL:'WALLET_DEPOSIT_PAYOS_NOT_MANUAL' }
WALLET_AUDIT += { TOPUP_CREATED:'WALLET_TOPUP_CREATED', TOPUP_LINK_FAILED:'WALLET_TOPUP_LINK_FAILED', TOPUP_CREDITED:'WALLET_TOPUP_CREDITED', TOPUP_CANCELLED:'WALLET_TOPUP_CANCELLED', TOPUP_EXPIRED:'WALLET_TOPUP_EXPIRED' }
WALLET_TX_TYPE += { TOPUP_PAYOS: 'topup_payos' }                      // cập nhật comment: khớp CHECK chk_shop_cod_wallet_tx_type của migration 20261103090000
export const TOPUP_STATUS = { CREATING:'creating', PENDING:'pending', PARTIAL:'partial', PAID:'paid', EXPIRED:'expired', CANCELLED:'cancelled', FAILED:'failed' } as const;
export const TOPUP_STATUS_VALUES: readonly string[] = Object.values(TOPUP_STATUS);
export const TOPUP_OPEN_STATUSES: readonly string[] = [TOPUP_STATUS.CREATING, TOPUP_STATUS.PENDING, TOPUP_STATUS.PARTIAL];
export const TOPUP_CLOSED_STATUSES: readonly string[] = [TOPUP_STATUS.EXPIRED, TOPUP_STATUS.CANCELLED, TOPUP_STATUS.FAILED];
export const TOPUP_TIMING = { EXPIRE_GRACE_MS: 2*60_000, ORPHAN_MS: 90_000, STALE_CREATING_MS: 60_000, TAIL_MS: 72*3_600_000, TAIL_RECHECK_MS: 6*3_600_000, OPEN_RECHECK_MS: 60_000, ONDEMAND_RECHECK_MS: 8_000 } as const;
export const TOPUP_REF_PREFIX = 'payos-topup:';
export const TOPUP_PAYOS_CODE_BASE = 5_000_000_000_000_000;           // dải mã PayOS riêng cho nạp cọc (mã đơn hàng ≈ 1,8e15)
export const TOPUP_MAX_AMOUNT_COLUMN = 99_999_999_999_999n;           // numeric(14,0)
```
4. SỬA `src/modules/system/enums/setting-keys.ts` — thêm `WALLET_PAYOS_DEPOSIT_ENABLED: 'wallet.payos_deposit_enabled'`, `WALLET_MAX_TOPUP_AMOUNT: 'wallet.max_topup_amount'`, `WALLET_PAYOS_TOPUP_EXPIRE_MINUTES: 'wallet.payos_topup_expire_minutes'` (cạnh các khoá `WALLET_*`, ~dòng 34–37, kèm comment `PLAN-0041`). SỬA `src/modules/system/foundation/system.constants.ts` — thêm vào `SETTING_DEFAULTS` (cạnh các khoá `wallet.*`, ~dòng 62–69):
```ts
[SETTING_KEY.WALLET_PAYOS_DEPOSIT_ENABLED]: { value: false, group: 'wallet', description: 'Bật nạp cọc COD qua PayOS cho chủ gian hàng (tạo link thanh toán PayOS). MẶC ĐỊNH TẮT: bật sau khi thử PayOS thật một khoản nhỏ. Tắt chỉ chặn TẠO link mới — tiền của link đang chờ về vẫn được ghi có vào ví', isPublic: false },
[SETTING_KEY.WALLET_MAX_TOPUP_AMOUNT]: { value: 50000000, group: 'wallet', description: 'Số tiền tối đa (VND) mỗi lần nạp cọc qua PayOS', isPublic: false, min: 1000, max: 1000000000 },
[SETTING_KEY.WALLET_PAYOS_TOPUP_EXPIRE_MINUTES]: { value: 60, group: 'wallet', description: 'Hạn của link nạp cọc PayOS (phút)', isPublic: false, min: 5, max: 1440 },
```
5. SỬA `src/config/env.ts` — thêm sau `EF_WEB_URL` (~dòng 28): `/* URL web quản trị — PayOS redirect chủ shop về sau khi nạp cọc (PLAN-0041) */ EF_ADMIN_URL: z.string().url().default('http://localhost:3001'),`. SỬA `.env.example` (cạnh `EF_WEB_URL=…`: `EF_ADMIN_URL=http://localhost:3001`) và `deploy/.env.production.example` (cạnh `EF_WEB_URL=…`: `EF_ADMIN_URL=https://fitly-admin.vercel.app`). KHÔNG thêm kiểm bắt buộc ở `assertSecretsSafe` (thiếu biến không được làm app không khởi động).
6. SỬA `src/modules/payment/payos/payos.service.ts` — thêm cạnh `generateOrderCode` (~34): `static generateTopupOrderCode(): number { return TOPUP_PAYOS_CODE_BASE + (Date.now() % 1_000_000_000_000) * 1000 + randomInt(1000); }` (import hằng từ `../foundation/payment.constants`) kèm comment VÌ SAO dải riêng (D4); thêm một dòng vào comment của `generateOrderCode`: "luôn < 5e15 đến năm 2127 — dải ≥ 5e15 dành riêng cho nạp cọc (PLAN-0041)". KHÔNG đổi hàm khác.
7. SỬA `src/modules/payment/shop-wallet/dto/shop-wallet.dto.ts` — `WalletResponse` thêm `payosTopup?` (§5.3), `WalletTransactionResponse.type` thêm `'topup_payos'` vào enum. TẠO `src/modules/payment/shop-wallet/dto/shop-wallet-topup.dto.ts` — các class §5.3 (đủ `@ApiProperty/@ApiPropertyOptional`, validator; `TopupListQuery` dùng `TOPUP_STATUS_VALUES`). `PayosTopupInfoResponse` và `WalletTopupResponse` khai trong file MỚI; file `shop-wallet.dto.ts` import chúng.
8. TẠO `src/modules/payment/shop-wallet/shop-wallet-topup.types.ts` (kiểu §6): `TopupRow`, `TopupReceiptRow`, `TopupStatus`, `TopupWebhookResult { outcome: 'credited'|'replay'|'noop'|'ignored'|'unkeyed'; message: string }`, `TopupReconcileOutcome = 'credited'|'closed'|'unchanged'|'unknown'|'skipped'|'not_found'`, `TopupShopContext { shopId; shopCode; shopName }`, `TopupSummary { enabled; minAmount; maxAmount; active: TopupRow | null }`.
9. TẠO khung `src/modules/payment/shop-wallet/shop-wallet-topup.service.ts` (class `ShopWalletTopupService`) và `shop-wallet-topup-settle.service.ts` (class `ShopWalletTopupSettleService`). Hàm khởi tạo GHIM (đúng thứ tự tham số):
```ts
ShopWalletTopupSettleService(prisma: PrismaService, payos: PayosService, wallet: ShopWalletService, audit: PaymentAuditLogService, shops: ShopQueryApi,
  @Inject(NOTIFICATION_GATEWAY) notifier: NotificationGateway, @Inject(USER_DIRECTORY_GATEWAY) users: UserDirectoryGateway)
ShopWalletTopupService(prisma: PrismaService, payos: PayosService, settle: ShopWalletTopupSettleService, system: SystemQueryApi, shops: ShopQueryApi, @Inject(ENV) env: Env)
```
Chữ ký phương thức public GHIM (thân hàm: `return Promise.reject(new Error('NOT_IMPLEMENTED: WP-n'))` — không `async` rỗng để khỏi vướng `require-await`):
```ts
// ShopWalletTopupSettleService  (WP-3 cài)
settleWebhookIfTopup(payosOrderCode: string, data: Record<string, unknown>, paidOk: boolean): Promise<TopupWebhookResult | null>
reconcileOne(topupId: string, opts?: { minIntervalMs?: number; forceClose?: boolean }): Promise<TopupReconcileOutcome>
reconcilePending(limit?: number): Promise<{ checked: number; credited: number; closed: number }>
markLinkCreated(topupId: string, link: { checkoutUrl: string; qrCode: string | null; paymentLinkId: string | null }, actor: Pick<AuthenticatedActor, 'userId' | 'email'>): Promise<TopupRow>
markLinkFailed(topupId: string, message: string): Promise<void>
cancel(actor: AuthenticatedActor, shopId: string, topupId: string): Promise<TopupRow>
// ShopWalletTopupService  (WP-2 cài)
summaryFor(shopId: string): Promise<TopupSummary>
create(actor: AuthenticatedActor, shop: TopupShopContext, amount: bigint): Promise<{ topup: TopupRow; reused: boolean }>
listMine(shopId: string, filter: { status?: string }, skip: number, take: number): Promise<{ items: TopupRow[]; total: number }>
listAll(filter: { shopId?: string; status?: string }, skip: number, take: number): Promise<{ items: TopupRow[]; total: number }>
getMine(shopId: string, id: string): Promise<TopupRow>
getMineByOrderCode(shopId: string, payosOrderCode: string): Promise<TopupRow>
cancelMine(actor: AuthenticatedActor, shopId: string, id: string): Promise<TopupRow>
getForAdmin(id: string): Promise<{ topup: TopupRow; receipts: TopupReceiptRow[] }>
shopNames(shopIds: string[]): Promise<Map<string, string>>
```
Hàm thuần của §6.3 (`parseMoney`, `receiptRef`, `targetCumulative`, `nextStatusAfterMoney`): WP-1 KHÔNG cài (WP-3 cài trong `shop-wallet-topup-settle.service.ts` và `export`).
10. SỬA `src/modules/payment/payment.module.ts` — `providers` thêm `ShopWalletTopupService`, `ShopWalletTopupSettleService`; `exports` thêm `ShopWalletTopupSettleService` (job ở `PaymentWorkerModule` cần). KHÔNG thêm controller (WP-2 làm).
**Lệnh kiểm:** `npx prisma generate` · `npx tsc --noEmit` · `npx eslint <các file .ts đã sửa/tạo>` · `npm test -- src/modules/payment/shop-wallet/shop-wallet.spec.ts src/modules/payment/payos/payos.service.spec.ts` (bài cũ phải vẫn xanh).
**KHÔNG được làm:** chạy `prisma migrate`/`db push`; sửa migration cũ; đổi hằng/hàm cũ; viết logic nghiệp vụ (thuộc WP-2/3); thêm quyền; đụng `payment.service.ts`/`shop-wallet.service.ts`; làm hỏng test cũ.
**Xong khi:** `tsc` sạch, eslint sạch, `prisma generate` có `ShopCodTopup`, `ShopCodTopupReceipt`; bài cũ xanh.

### WP-1F — Nền FE (Pha 1, song song với WP-1)
**Đọc trước:** AGENTS.md + CLAUDE.md admin (Next bản mới: đọc `node_modules/next/dist/docs/` trước khi viết code Next), §5.3, §7.2, `features/shop/hooks/use-wallet.ts`, `features/shop/types/wallet.ts`, `lib/labels.ts`.
**Tạo/sửa:**
1. TẠO `src/features/shop/types/wallet-topup.ts` — chép từ backend `shop-wallet-topup.dto.ts` (ghi nguồn file trong comment): `TopupStatus` (7 giá trị), `WalletTopup` (= `WalletTopupResponse`: `id, shopId, shopName?, amount, receivedAmount, status, payosOrderCode, checkoutUrl, qrCode, expiresAt, paidAt, closedAt, createdAt, canCancel`), `CreateTopupResult extends WalletTopup { reused: boolean }`, `WalletTopupReceipt { reference, amount, createdAt }`, `WalletTopupDetail extends WalletTopup { receipts; lastGatewayStatus; lastCheckedAt }`, `PayosTopupInfo { enabled; minAmount; maxAmount; active: WalletTopup | null }`, `OPEN_TOPUP_STATUSES: readonly TopupStatus[] = ['creating','pending','partial']`.
2. SỬA `src/features/shop/types/wallet.ts` — `WalletTxType` thêm `"topup_payos"`; `ShopWallet` thêm `payosTopup?: PayosTopupInfo` (import kiểu từ `wallet-topup.ts`).
3. TẠO `src/features/shop/hooks/use-wallet-topups.ts` (mẫu: `use-wallet.ts` — gọi `customInstance`, `queryKey: [url, params]` để `invalidateByPath` hoạt động; comment giải thích VÌ SAO gọi thẳng: để chạy song song BE, sau `api:sync` có thể chuyển sang hook sinh ra). Hook GHIM:
   - `useCreateTopup()` — `useMutation` → `POST /api/v1/shop/wallet/topups` `{amount}` → `CreateTopupResult`; `onSuccess` `invalidateByPath(qc, "/api/v1/shop/wallet")`; `onError` toast `apiErrorMessage(e, "Không tạo được link nạp cọc.")`.
   - `useMyTopups(page, size, status?)` — `GET /api/v1/shop/wallet/topups`, `asPage<WalletTopup>`, `placeholderData: keepPreviousData`, `staleTime: 10_000`.
   - `useMyTopup(id: string | null)` — `GET /api/v1/shop/wallet/topups/:id`, `enabled: !!id`, `staleTime: 0`.
   - `useMyTopupByOrderCode(orderCode: string | null)` — `GET /api/v1/shop/wallet/topups/by-order-code/:orderCode`; `enabled: !!orderCode`; `retry: false`; `staleTime: 0`; `refetchOnWindowFocus: false`; **`refetchInterval: (q) => open(q.state.data?.status) && Date.now() - startedAt < 180_000 ? 3_000 : false`** (`startedAt` = thời điểm hook mount, `useRef`/`useState` khởi tạo một lần); khi dữ liệu chuyển sang trạng thái cuối (`paid|expired|cancelled|failed`) ⇒ `invalidateByPath(qc, "/api/v1/shop/wallet")`.
   - `useCancelTopup()` — `POST …/:id/cancel`; invalidate `/api/v1/shop/wallet`; toast thành công "Đã huỷ link nạp cọc."
   - `useAdminTopups({ status?, page, size })` — `GET /api/v1/admin/wallet-topups` (`status || undefined`), `asPage<WalletTopup>`, `staleTime: 10_000`; `useAdminTopup(id: string | null)` — `GET /api/v1/admin/wallet-topups/:id` → `WalletTopupDetail`, `enabled: !!id`.
4. SỬA `src/lib/labels.ts` — thêm `TOPUP_STATUS` đúng bảng §7.2 (cạnh `REFUND_STATUS`, comment `PLAN-0041`).
5. SỬA `src/features/shop/components/wallet-labels.ts` — `WALLET_TX_LABEL.topup_payos = "Nạp cọc qua PayOS"` (đúng kiểu `Record<WalletTxType, string>`).
6. SỬA `src/lib/constants.ts` — `ROUTES.vendor.walletPayosReturn: "/vendor/wallet/payos-return"` (cạnh `wallet`). KHÔNG thêm mã quyền (dùng sẵn `PERMISSIONS.shopWalletRead`, `shopWalletDepositRequest`, `supplierWalletRead`).
**Lệnh kiểm:** `npx eslint <file đã đổi>` · `npx tsc --noEmit` (trong `fashion_frontend_admin`).
**KHÔNG được làm:** `npm run build`/dev server/`api:sync`/sửa `src/lib/api/generated/**`; import hook sinh ra; tạo component (thuộc WP-6/7); polling ngoài `useMyTopupByOrderCode`.
**Xong khi:** `tsc` sạch; eslint sạch.

### WP-2 — Dịch vụ tạo link / đọc / huỷ + controller (BE, Pha 2)
**Đọc trước:** §2 (D1, D5–D7, D15–D17), §5, §6.4 (A)(F)(H), `shop-wallet.controller.ts`, `payment.service.ts` (`requestPayosLink` ~174, `saveLink` ~184, `createCheckoutLinks` ~203), `payment.controllers.ts` (`@RateLimit` ~71).
**Sửa/tạo (đúng danh sách):**
1. SỬA `src/modules/payment/shop-wallet/shop-wallet-topup.service.ts` — cài ĐỦ các phương thức `ShopWalletTopupService` theo §6.4 (A)(F)(H): `summaryFor`, `create`, `listMine`, `listAll`, `getMine`, `getMineByOrderCode`, `cancelMine`, `getForAdmin`, `shopNames`. Chỉ dùng bề mặt Prisma §6.2 (`shopCodTopup.*`, `shopCodTopupReceipt.findMany`) và gọi `this.settle.*` (WP-3 cài). Hằng thời gian lấy từ `TOPUP_TIMING`; trạng thái từ `TOPUP_STATUS`/`TOPUP_OPEN_STATUSES`; lỗi từ `WALLET_ERR` qua `BusinessException`/`NotFoundException`. Có block comment tiếng Việt đầu class theo "Service Note Rule" (use case, transaction ở đâu, khoá, idempotency, không log dữ liệu nhạy cảm). `topupDescription(shopCode)` là hàm `export` thuần trong file.
2. TẠO `src/modules/payment/shop-wallet/controller/shop-wallet-topup.controller.ts` — `ShopWalletTopupController` theo §5.1/§5.2: đúng đường dẫn, quyền (`@UseGuards(ShopContextGuard)` + `@RequireShopPermission(...)` cho route vendor; `@RequirePermission('supplier.wallet.read')` cho route sàn), `@RateLimit`, `@HttpCode`, `@ApiOperation`/`@ApiOkResponse`. `shopId` CHỈ từ `@CurrentShop()`. `ParseUUIDPipe` cho `:id`. Mapper `toTopupResponse(row, { shopName?, exposeLink })` trong file này (tiền `.toFixed(0)`; `checkoutUrl`/`qrCode` chỉ khi `exposeLink && status ∈ {pending, partial} && expiresAt > now`; `canCancel` theo trạng thái). `byOrderCode` khai báo TRƯỚC `:id`.
3. SỬA `src/modules/payment/shop-wallet/controller/shop-wallet.controller.ts` — thêm `private readonly topups: ShopWalletTopupService` vào constructor; `mine()` gắn `payosTopup` (từ `topups.summaryFor`, map `active` bằng `toTopupResponse(..., { exposeLink: true })` — import hàm mapper từ `shop-wallet-topup.controller.ts` hoặc đặt mapper ở file riêng `controller/topup.mapper.ts` do WP-2 tạo); các route khác KHÔNG đổi.
4. SỬA `src/modules/payment/payment.module.ts` — thêm `ShopWalletTopupController` vào `controllers`.
**Chữ ký/kiểu cần có:** đúng ghim ở WP-1 (không đổi tên/tham số).
**Test phải qua (WP-4 viết; chạy khi file đã có):** WTU-01…16, WTC-01…04, WTI-01…02.
**Lệnh kiểm:** `npx eslint <4 file>` · `npx tsc --noEmit` · `npm test -- src/modules/payment/shop-wallet` (nếu spec chưa có thì bỏ qua bước jest).
**KHÔNG được làm:** gọi PayOS trong transaction; khoá ví hay gọi `ShopWalletService`; sửa settle service / `shop-wallet.service.ts` / `payment.service.ts`; thêm route ngoài §5; trả `shopId` từ body/query; đổi route/DTO cũ; dùng `any`; log số tài khoản hay `checkoutUrl`.
**Nguyên mẫu bắt chước:** `ShopWalletService.requestDeposit` (~98–111: kiểm min, `lockWallet`, tạo dòng, audit), `PaymentService.createCheckoutLinks` (gọi PayOS NGOÀI transaction), `ShopWalletController.myDeposits/requestDeposit` (~156–173).

### WP-3 — Ghi có · webhook · dò · hết hạn · thông báo · job (BE, Pha 2)
**Đọc trước:** §2 (D2–D3, D5, D7–D10, D12–D14, D19–D20), §4, §6 TOÀN BỘ, `payment.service.ts` (`settlePayosOnce` ~703, `eventRefOf` ~361, `reconcilePendingPayos` ~546, `handlePayos` ~641, `accountantIds`/`notifyAccountants` ~1268–1290), `shop-wallet.service.ts` (`lockWallet` ~229, `post` ~235, `applyCodCommission` ~158), `payment-worker.module.ts` (~81–94 mẫu job).
**Sửa/tạo (đúng danh sách):**
1. SỬA `src/modules/payment/shop-wallet/shop-wallet-topup-settle.service.ts` — cài ĐỦ `ShopWalletTopupSettleService` (§6.4 B–G) + export 4 hàm thuần (§6.3). Thông báo SAU commit, nuốt lỗi (`try/catch` + `logger.warn`). Khoá: dòng nạp TRƯỚC, ví SAU (qua `wallet.creditPayosTopup`); không khoá đơn/payment; `retryOnDeadlock` bọc transaction ghi có/đóng. Câu update dòng nạp là câu GHI CUỐI (sau biên nhận + sổ + ví), audit sau nó.
2. SỬA `src/modules/payment/shop-wallet/shop-wallet.service.ts` — (a) `post` nhận thêm `topupId?`, `refKey?` trong `extra` và ghi vào dòng sổ; (b) thêm
```ts
async creditPayosTopup(tx: Tx, input: { shopId: string; topupId: string; refKey: string; amount: bigint; note: string; meta: Prisma.InputJsonObject }): Promise<{ credited: boolean; balanceAfter: bigint }>
// amount ≤ 0 ⇒ ném Error (lỗi lập trình, không ghi); await this.lockWallet(tx, shopId); đã có dòng cùng refKey (findFirst) ⇒ { credited:false, balanceAfter: số dư hiện tại }; ngược lại post(tx, shopId, WALLET_TX_TYPE.TOPUP_PAYOS, D(amount), { topupId, refKey, note, meta }) ⇒ { credited:true, balanceAfter }
```
(c) `approveDeposit` / `rejectDeposit`: trước khi ném `DEPOSIT_NOT_FOUND`, kiểm `tx.shopCodTopup.findUnique({ where:{ id }, select:{ id:true } })` ⇒ nếu có ném `BusinessException(WALLET_ERR.DEPOSIT_PAYOS_NOT_MANUAL, 'Khoản nạp qua PayOS tự ghi có khi PayOS xác nhận — không duyệt/từ chối tay', HttpStatus.CONFLICT)`. KHÔNG đổi gì khác (luồng tay nguyên vẹn; không đổi thứ tự khoá; không thêm đường ghi sổ nào khác ngoài `post`). Cập nhật comment đầu class: thêm "nạp qua PayOS (PLAN-0041) đi qua creditPayosTopup".
3. TẠO `src/modules/payment/shop-wallet/shop-wallet-topup.job.ts` — `WalletTopupJobs` (`@Injectable`, `constructor(private readonly settle: ShopWalletTopupSettleService)`), `@Interval(2 * 60_000) async reconcileWalletTopups(): Promise<{ checked: number; credited: number; closed: number } | null>`: cờ `running` chống chạy chồng, gọi `settle.reconcilePending()`, `logger.warn` khi `credited + closed > 0`, nuốt lỗi (`logger.error`), nhả cờ trong `finally`, trả `null` khi bỏ qua/lỗi (mẫu `PaymentJobs.reconcilePendingPayos` ~81–94).
4. SỬA `src/modules/payment/payment-worker.module.ts` — import `WalletTopupJobs` và thêm vào `providers` của `PaymentWorkerModule` (~132). KHÔNG sửa `PaymentJobs`.
5. SỬA `src/modules/payment/payment/payment.service.ts` — ĐÚNG 3 chỗ §6.5; KHÔNG đổi gì khác. SỬA `src/modules/payment/payment/payment-payos.spec.ts` — chỉ dòng dựng `new PaymentService(...)` (~619) thêm đối số cuối `topups` + khai báo stub ngay trên đó; không sửa test nào.
**Test phải qua (WP-4 viết):** WTS-01…32, WTX-01…05, WTW-01…09, WTR-01…06, WTJ-01…03 + toàn bộ `payment-payos.spec.ts`, `shop-wallet.spec.ts`, `payment-worker.spec.ts` cũ.
**Lệnh kiểm:** `npx eslint <các file đã sửa/tạo>` · `npx tsc --noEmit` · `npm test -- src/modules/payment` (nếu spec mới chưa có thì chạy phần cũ).
**KHÔNG được làm:** đọc cờ `wallet.payos_deposit_enabled` ở đường ghi có; gọi PayOS trong transaction; bắt `P2002` rồi tiếp tục trong transaction; khoá ví trước dòng nạp; khoá/đụng đơn hoặc payment; gửi thông báo trong transaction hay để lỗi thông báo làm rollback; tạo hoàn tiền (`refund`) từ luồng nạp; thêm đường ghi sổ ví ngoài `post`; tự trừ ví khi poll báo thấp hơn; đổi hành vi bất kỳ route cũ; `any`.
**Nguyên mẫu bắt chước:** `settlePayosOnce` (khoá → đọc dưới khoá → khử trùng theo `reference`), `reconcilePendingPayos` (CAS chiếm lượt hỏi `last_checked_at`; PayOS lỗi ⇒ bỏ qua), `applyCodCommission` (kiểm trùng dưới khoá + `post`), `PaymentJobs` (cờ chống chạy chồng).

### WP-4 — Unit test jest + DB giả (BE, Pha 2)
**Đọc trước:** §6 (đặc biệt §6.2, §6.6), §9.1, `payment-payos.spec.ts` (`matchesRow` ~190, `p2002` ~215, `lock()` ~282, `$transaction` ~552, `handlerOf` ~3836), `shop-wallet.spec.ts`, `payment-worker.spec.ts`.
**Tạo (file MỚI; chỉ được sửa `shop-wallet/shop-wallet.spec.ts` bằng cách THÊM một khối `describe` ở cuối — không sửa bài cũ):**
`shop-wallet/shop-wallet-topup.fixture.ts` · `shop-wallet/shop-wallet-topup.service.spec.ts` · `shop-wallet/shop-wallet-topup-settle.service.spec.ts` · `shop-wallet/shop-wallet-topup.pure.spec.ts` · `shop-wallet/shop-wallet-topup.job.spec.ts` · `shop-wallet/shop-wallet-topup.controller.spec.ts` · `payment/payment-topup-routing.spec.ts` · `shop-wallet/topup-migration.guard.spec.ts` · (bổ sung) `shop-wallet/shop-wallet.spec.ts`.
**Yêu cầu:** đủ MỌI `it('[MÃ] …')` ở §9.1, tên test đúng định dạng `'[WTx-nn] mô tả'`. DB giả phải: khoá dòng FIFO + xen kẽ ép buộc cho test đồng thời; `$transaction` hoàn tác khi lỗi; P2002 cho 4 chỉ mục UNIQUE (§3.1) và CHECK `topup_payos`; `$queryRaw` chỉ nhận `FOR UPDATE` của `shop_cod_topups`/`shop_cod_wallets` và ghi vào `calls` để kiểm THỨ TỰ KHOÁ (topup trước ví; không lệnh khoá đơn/payment). `fetch` toàn cục bị chặn; `PayosService` thật + spy 3 hàm mạng. Đồng hồ giả điều khiển được (hết hạn, ân hạn 2 phút, mồ côi 90 s, đuôi 72 giờ).
**Lệnh kiểm:** `npx eslint <file>` · `npx tsc --noEmit` · `npm test -- src/modules/payment/shop-wallet src/modules/payment/payment/payment-topup-routing.spec.ts`.
**KHÔNG được làm:** sửa code production (nếu test đỏ vì lỗi production ⇒ báo điều phối viên kèm tên test + kỳ vọng, KHÔNG làm yếu/xoá test); mô phỏng DB bằng `jest.fn` rời rạc không có khoá/rollback cho test đồng thời; gọi mạng thật; test phụ thuộc thời gian thật (`Date.now()` tự do) — dùng đồng hồ giả.
**Ghi chú:** các test có thể chưa chạy xanh cho tới khi WP-2/WP-3 xong; điều phối viên chạy lại ở CỔNG 2 và trả lỗi cho đúng gói.

### WP-5 — Harness Postgres thật `t11` (BE assets, Pha 2)
**Đọc trước:** §6.6, §9.2–9.3, §10, `docs/plans/assets/e2e-audit/` (`README.md`, `lib.mjs`, `mock-payos.mjs`, `t09-explore-money.mjs` làm mẫu, `t10-lifecycle-extras.mjs`, `jobs.cjs`, `run-all.sh`, `auditenv.sh`).
**Tạo/sửa (đúng danh sách):** TẠO `t11-wallet-topup-payos.mjs`; SỬA `mock-payos.mjs` (thêm `/_receive`, `/_transfers`, `/_link_status`, hàm `buildWebhook`, `S.transfers`; `/_confirm` ghi `transfers`; KHÔNG đổi hành vi endpoint cũ); SỬA `jobs.cjs` (case `topup-reconcile`); SỬA `auditenv.sh` (`EF_ADMIN_URL`); SỬA `run-all.sh` (thêm `t11-wallet-topup-payos` sau `t10-lifecycle-extras`); SỬA `README.md` (mục 9c). KHÔNG sửa `lib.mjs` (helper riêng nằm trong `t11`).
**Yêu cầu:** đủ `check('WTP-01'…'WTP-32')` đúng §6.6/§9.2 (kể cả bài ĐỒNG THỜI + đo deadlock, bài rollback bằng trigger, bài `creating` xen kẽ bằng `delayMs`, bài E2E người dùng, bất biến §10 + tổng ví = tổng PayOS giả); `try/finally` dọn dẹp (đóng khoản mở, trả setting, gỡ trigger). Mọi tiền chạy qua PayOS GIẢ; KHÔNG mạng ngoài; KHÔNG ghi trực tiếp `balance` (dùng `adjust` qua API khi cần chỉnh ví).
**Lệnh kiểm:** `node --check docs/plans/assets/e2e-audit/t11-wallet-topup-payos.mjs` và tương tự cho `mock-payos.mjs`, `jobs.cjs` (kiểm cú pháp). KHÔNG chạy harness/docker (điều phối viên chạy).
**KHÔNG được làm:** sửa/xoá bài `t01…t10` hay baseline; thêm phụ thuộc npm; hard-code mật khẩu (dùng `E2E_PW_*` như `lib.mjs`); chạy `run-all.sh`.

### WP-6 — FE vendor (admin FE, Pha 2, sau WP-1F)
**Đọc trước:** AGENTS.md + CLAUDE.md admin (đọc `node_modules/next/dist/docs/` khi viết code Next), §7–§8.1–8.2, `vendor-wallet-screen.tsx`, `features/shop/hooks/use-wallet-topups.ts` (WP-1F), `fashion_frontend_user/src/app/(shop)/checkout/payos-return/page.tsx` + `features/payment/components/payos-return-screen.tsx` (mẫu trang quay lại).
**Tạo/sửa (đúng danh sách):** TẠO `src/features/shop/components/vendor/topup-dialog.tsx`, `active-topup-card.tsx`, `my-topups-table.tsx`, `topup-return-screen.tsx`; TẠO `src/app/(vendor)/vendor/wallet/payos-return/page.tsx`; SỬA `src/features/shop/components/vendor/vendor-wallet-screen.tsx` (§8.1: hai nút, `ActiveTopupCard`, tab "Nạp qua PayOS", dòng ghi chú); SỬA `AGENTS.md` (Rule 1: thêm ngoại lệ polling "trang `/vendor/wallet/payos-return` poll 3 giây khi khoản nạp còn chờ, dừng ở trạng thái cuối hoặc sau 180 giây"); TẠO `docs/plans/PLAN-0006-wallet-payos-topup.md` (ngắn, theo `docs/plans/PLANS_TEMPLATE.md` của repo admin, trỏ về PLAN-0041 của BE, checklist FE).
**Yêu cầu:** đúng §8.1–8.2 (mọi trạng thái giao diện, thông điệp tiếng Việt, 390px, skeleton khớp layout, 3 lớp quyền: `PermissionGuard` ở page, `PermissionGate` ở nút, `ApiErrorState` + `isForbiddenError` khi có lỗi truy vấn); nút "Nạp bằng chuyển khoản" giữ NGUYÊN hành vi cũ; Zod `register(name, { setValueAs })` kiểu số như `DepositDialog`; `window.location.assign(checkoutUrl)` sau khi tạo link; không `setState` trong `useEffect` để reset (tách component con `key={id}`); tái dùng `DataTable`, `FilterTabs`, `StatusBadge`, `ConfirmDialog`, `FormMessage`, `formatVnd`, `formatDateTime`, `formatRemaining`; ảnh/QR nếu hiển thị dùng `<img>` kèm `eslint-disable-next-line @next/next/no-img-element`.
**Lệnh kiểm:** `npx eslint <file>` · `npx tsc --noEmit`.
**KHÔNG được làm:** `npm run build`/dev server/`api:sync`; sửa `src/lib/api/generated/**`, `lib/api*`, store, `lib/constants.ts`, `lib/labels.ts`, hook của WP-1F (cần đổi ⇒ báo); import chéo feature; import hook sinh ra; polling ở chỗ khác ngoài trang quay lại; tin `status`/`cancel` trên URL làm kết luận; đổi hành vi luồng nộp tay.

### WP-7 — FE sàn (admin FE, Pha 2, sau WP-1F)
**Đọc trước:** AGENTS.md admin, §8.3, `wallets-screen.tsx`, `use-wallet-topups.ts` (WP-1F).
**Tạo/sửa:** TẠO `src/features/shop/components/platform/wallet-topups-tab.tsx`; SỬA `src/features/shop/components/platform/wallets-screen.tsx` (thêm tab `{ key: "topups", label: "Nạp qua PayOS" }` + dòng chú thích dưới bảng "Khoản nộp cọc").
**Yêu cầu:** §8.3 — `FilterTabs` lọc: Tất cả (mặc định) · Chờ thanh toán (`pending`) · Một phần (`partial`) · Đã nhận đủ (`paid`) · Hết hạn (`expired`) · Đã huỷ (`cancelled`) · Tạo link lỗi (`failed`); bảng phân trang server; "Chi tiết" mở `Dialog` liệt kê `receipts`; KHÔNG nút Duyệt/Từ chối; `isForbiddenError` ⇒ `ApiErrorState`; xem-only nên không `PermissionGate` ghi; tông màu cột "Đã nhận" theo §8.3.
**Lệnh kiểm:** `npx eslint <file>` · `npx tsc --noEmit`.
**KHÔNG được làm:** như WP-6; sửa tab "Khoản nộp cọc"/"Ví các gian hàng" ngoài dòng chú thích.

### WP-8 — Tài liệu BE (Pha 2)
**Sửa (chỉ THÊM, đúng chỗ; các file này đang có thay đổi chưa commit của phiên khác — dùng Edit, không ghi đè):**
1. `docs/06_FE_CONTRACT.md` — đúng §5.5 (a)(b)(c).
2. `docs/02_MODULE_MAP.md` — mục payment: thêm dòng `shop-wallet/` (`ShopWalletTopupService`, `ShopWalletTopupSettleService`, `WalletTopupJobs`; model `ShopCodTopup`/`ShopCodTopupReceipt`; route `/shop/wallet/topups*`, `/admin/wallet-topups*`), nêu **thứ tự khoá toàn cục ĐƠN → PAYMENT → KHOẢN NẠP → VÍ**, định tuyến webhook (đơn trước, nạp cọc sau, lạ ⇒ 200), bất biến tiền §10 (tóm tắt).
3. `docs/07_KEYS_CHECKLIST.md` — thêm `EF_ADMIN_URL` (bảng env) + mục "Nạp cọc qua PayOS": webhook dùng chung URL, cờ `wallet.payos_deposit_enabled` mặc định tắt, thử 1 khoản nhỏ rồi bật.
4. `docs/08_DEPLOY.md` — dòng `EF_ADMIN_URL` cạnh `EF_WEB_URL`/`EF_CORS_ORIGINS` (~dòng 48).
5. `docs/12_OPERATIONS_RUNBOOK.md` — thêm hàng "Nạp cọc PayOS bất thường" vào mục 3 (kế toán): thừa/trùng/về muộn/kết thúc thiếu ⇒ tiền ĐÃ vào ví, không hoàn; đối chiếu sao kê PayOS bằng `payosOrderCode` + `receipts`; shop đòi lại tiền ⇒ quy trình tay (hoàn qua PayOS dashboard + `adjust` âm có lý do, admin); khoản kẹt `creating` > 10 phút ⇒ job tự `failed`/`expired`; tắt cờ để dừng tạo link mới.
6. `README.md` — §Trạng thái: thêm MỘT dòng "Nạp cọc COD qua PayOS (PLAN-0041)".
**KHÔNG được làm:** sửa file `docs/plans/**` (trừ khi điều phối viên yêu cầu tick checklist); đổi nội dung đã có.

### CỔNG 1 / CỔNG 2 / Pha 3 — việc của điều phối viên (không giao Haiku)
- Sau mỗi cổng: ghi kết quả vào §14. Cổng 2 đỏ ⇒ trả đúng gói (lỗi trong `settle` ⇒ WP-3; trong tạo link/controller ⇒ WP-2; test sai ⇒ WP-4 — nhưng KHÔNG làm yếu test để qua).
- Pha 3: dựng môi trường theo `PLAN-0040` §11 (bản sao BE không có `.env` thật + `auditenv.sh`; Docker Postgres 55442 / Redis 56389; `mock-payos.mjs`; admin FE bản sao `D:\fitly-e2e\admin` cổng 3401, `EF_ADMIN_URL=http://localhost:3401`); `reset-env.sh` → `t11` (sửa → chạy lại tới 100% ✔; `CONC_ROUNDS` tăng nếu cần) → `run-all.sh` (MỘT driver; không hồi quy so `baseline-2026-10-27-final.json`; lưu baseline mới) → `npm run perms:sync` + `api:sync` (admin) → trình duyệt B1–B14 → dọn môi trường (PLAN-0040 §7.5) → tick §12.5.
- Nhắc chủ dự án (không tự làm): `npm run db:dump` lại sau migration; bật cờ `wallet.payos_deposit_enabled` SAU khi thử PayOS thật.

---

## 12. Rủi ro · Rollout / Lùi · Checklist

### 12.1 Rủi ro & cách giảm
| # | Rủi ro | Cách giảm (và nơi kiểm) |
|---|---|---|
| R1 | Deadlock giữa webhook nạp ↔ job dò ↔ đơn COD (cùng ví) | Thứ tự khoá toàn cục (§6.1); đường tạo link không khoá ví; `retryOnDeadlock`; ĐO `pg_stat_database.deadlocks` trước/sau ở `WTP-08/28/29` trên Postgres thật |
| R2 | Cộng đôi / cộng dư tiền vào ví | 4 lớp: khoá dòng nạp (tuần tự hoá) → biên nhận UNIQUE `(topup_id, reference)` → công thức `max(Σ biên nhận, luỹ kế)` đơn điệu → sổ cái UNIQUE `ref_key` theo mục tiêu luỹ kế; bất biến I1–I3, I9; `WTP-05…11` |
| R3 | Ngữ nghĩa `amountPaid`/`status` của PayOS THẬT chưa kiểm (UNDERPAID, link hết hạn có còn nhận không, webhook có gửi cho trả thiếu không) | Webhook là đường chính; poll chỉ ghi có phần CHÊNH dương và đọc `amountPaid` bất kể `status`; poll thấp hơn ⇒ không làm gì. BẮT BUỘC thử 1 khoản PayOS thật trước khi bật cờ (§12.5) và ghi kết quả vào §14 |
| R4 | Khoá checksum PayOS lộ ⇒ kẻ xấu giả webhook ghi có ví | Cùng mức tin cậy với đường đơn hàng (đã có nhắc xoay khoá ở `07_KEYS`). Hardening tuỳ chọn ở §13 (Q9); hiện chưa có đường rút tiền khỏi ví nên thiệt hại giới hạn ở việc mở COD |
| R5 | Rửa tiền / dùng ví làm nơi cất tiền | Hiện KHÔNG có đường rút (grep xác nhận). Khi làm "rút cọc" (PLAN-0030 §2.3) bắt buộc: chỉ chi về TK ngân hàng ĐÃ XÁC MINH của shop (cùng tên chủ shop), có thời gian giữ, kế toán duyệt. Mọi khoản nạp lưu `reference` + tài khoản đối ứng (`raw`) |
| R6 | `EF_ADMIN_URL` sai ⇒ trang quay lại sai | Chỉ ảnh hưởng UX (tiền vẫn ghi có qua webhook/job); production không `https` ⇒ 503 `WALLET_TOPUP_UNAVAILABLE`; nút "Kiểm tra lại" + job dò |
| R7 | Mất webhook + PayOS API tạm chết | Job dò mỗi 2 phút + làm mới theo yêu cầu khi mở trang; đuôi 72 giờ; tiền về sau vẫn ghi có |
| R8 | Jest DB giả không bắt lỗi khoá/trùng chỉ mục thật | Harness `t11` bắt buộc ở CỔNG/Pha 3; chỉ mục UNIQUE + CHECK ở DB; test bảo vệ migration `WTM-01` |
| R9 | File nóng bị nhiều phiên sửa | Phân vùng file (§11); sửa tối thiểu; kiểm `git diff --stat` |
| R10 | Thông báo thất bại làm mất tiền | Thông báo SAU commit, nuốt lỗi (D9); test `WTS-28` |
| R11 | Người dùng bấm "tạo link" liên tục | Rate-limit 10/10 phút; một khoản mở/shop; link cũ được trả lại |
| R12 | Lệch đồng hồ giữa app và PayOS về hạn | Ân hạn 2 phút + tiền về muộn vẫn ghi có ⇒ chỉ ảnh hưởng nhãn hiển thị |
| R13 | `qr_code`/`checkout_url` quá dài so với cột | `checkout_url` VARCHAR(500), `qr_code` TEXT; PayOS trả < 400 ký tự thực tế |
| R14 | Ví của shop không tồn tại lúc tiền về (shop mới chưa có ví) | `lockWallet` tự tạo ví (upsert) trước khi ghi |

### 12.2 Rollout (thứ tự triển khai)
1. Sao lưu `pg_dump`. 2. Deploy migration `20261103090000_wallet_payos_topup` (chỉ thêm — code cũ vẫn chạy). 3. Deploy BE (cờ `wallet.payos_deposit_enabled` MẶC ĐỊNH TẮT ⇒ chưa ai thấy tính năng; webhook định tuyến mới vô hại khi chưa có khoản nạp). 4. Đặt env `EF_ADMIN_URL` (https). 5. Deploy web quản trị. 6. Chủ dự án thử PayOS thật 1 khoản (§12.5) rồi bật cờ ở `/system/settings`.

### 12.3 Lùi
- **Lùi mềm (ưu tiên):** tắt cờ `wallet.payos_deposit_enabled` ⇒ không tạo link mới; luồng tay nguyên vẹn; webhook của link đang chờ VẪN ghi có.
- **Lùi code:** KHÔNG lùi code khi còn khoản mở (webhook cũ sẽ bỏ qua mã dải 5e15 ⇒ tiền về mà không ghi có). Quy trình bắt buộc: tắt cờ → chờ quá `wallet.payos_topup_expire_minutes` + 10 phút → kiểm `SELECT count(*) FROM payment.shop_cod_topups WHERE status IN ('creating','pending','partial')` = 0 → mới lùi. Nếu lỡ lùi và có tiền về chưa ghi có: triển khai lại code mới (job dò sẽ ghi có theo luỹ kế PayOS) hoặc kế toán `adjust` tay. Migration KHÔNG có "down" (chỉ thêm; bảng giữ nguyên, vô hại với code cũ — loại dòng `topup_payos` ở sổ cái được code cũ hiển thị bằng nhãn dự phòng).

### 12.4 Trọng tâm rà soát độc lập (Pha 4 — agent KHÔNG viết code này, chỉ đọc)
(1) Có đường nào ghi sổ ví ngoài `post`/`creditPayosTopup`? (`WTW-08`) (2) Thứ tự khoá `KHOẢN NẠP → VÍ` áp cho MỌI đường (webhook, dò, GET làm mới, đóng, huỷ, markLinkCreated/Failed)? Có đường khoá ví trước? (3) Có `try/catch P2002` rồi tiếp tục trong transaction? (4) Thông báo có nằm trong transaction? (5) Cờ có bị đọc ở đường ghi có? (6) Quyền: route vendor lọc `shopId` ngữ cảnh? `by-order-code` có lộ khoản shop khác? Route sàn xem-only? (7) Lộ thông tin: log/audit/response có chứa số tài khoản đối ứng, `checkoutUrl` cho sàn, `qr_code` cho sàn? (8) Migration: chỉ thêm? tên khớp Prisma (`migrate diff`)? (9) FE: có tin `status` trên URL? polling có dừng? nút duyệt tay có ẩn cho khoản PayOS? (10) Đường poll có thể ghi có nhiều hơn tiền thật khi PayOS trả `amountPaid` bất thường (số rất lớn)? (kiểm `parseMoney` + trần cột).

### 12.5 Checklist (tick được)
**Pha 1**
- [x] WP-1: migration + `payment.prisma` + hằng số + setting + `EF_ADMIN_URL` + `generateTopupOrderCode` + DTO + kiểu + khung service + module; `prisma generate`; `tsc` + `eslint` sạch
- [x] WP-1F: kiểu + hook + nhãn + route FE; `tsc` + `eslint` sạch
- [x] CỔNG 1: `migration:check` xanh trên DB trống; `tsc` BE + admin xanh
**Pha 2**
- [x] WP-2: tạo/đọc/huỷ + controller (WTU, WTC, WTI xanh)
- [x] WP-3: settle + `creditPayosTopup` + 409 duyệt nhầm + job + móc `PaymentService` (WTS, WTX, WTW, WTR, WTJ xanh; bài cũ `payment-payos`, `shop-wallet`, `payment-worker` vẫn xanh)
- [x] WP-4: toàn bộ jest ở §9.1
- [x] WP-5: `t11` + mock + `jobs.cjs` + `run-all.sh` + README harness
- [x] WP-6: FE vendor + trang quay lại + AGENTS.md Rule 1 + PLAN-0006 FE
- [x] WP-7: FE sàn
- [x] WP-8: tài liệu BE
- [x] CỔNG 2: BE `lint` + `check:boundaries` + `tsc` + `npm test` (không giảm) + `build` + `migration:check`; admin `npm run verify`
**Pha 3 (điều phối viên)**
- [x] `t11` 100% ✔ trên Postgres thật; `deadlocks` trước/sau = 0 ở WTP-08/28/29; WTP-30 (rollback) ✔; WTP-32 (bất biến) ✔
- [x] `run-all.sh`: không hồi quy (so baseline `final`); lưu baseline mới (`baseline-<ngày>-topup.json`)
- [x] `npm run perms:sync` + `api:sync` (admin) — commit-ready, KHÔNG commit
- [ ] Trình duyệt B1–B14 đủ vai (chủ shop, nhân viên shop, kế toán, quản lý) + 390px
- [x] Dọn môi trường (PLAN-0040 §7.5) — đã dọn 2026-11-03: dừng dev server/API/worker/PayOS giả, xoá container Postgres/Redis cô lập, gỡ junction, xoá thư mục tạm bản sao BE và bản sao FE
**Pha 4 + bàn giao**
- [ ] Rà soát độc lập §12.4 — không còn lỗi mở
- [ ] Chủ dự án: `npm run db:dump` lại; đặt `EF_ADMIN_URL`; thử PayOS thật 1 khoản (trả đủ; nếu PayOS cho: trả thiếu) → ghi §14; rồi bật `wallet.payos_deposit_enabled`
- [ ] Cập nhật README §Trạng thái + `02_MODULE_MAP` (WP-8) khớp code

---

## 13. Câu hỏi cho chủ dự án (đều đã có MẶC ĐỊNH — không chặn công việc)

| # | Câu hỏi | Mặc định đã chọn trong plan |
|---|---|---|
| Q1 | Bật `wallet.payos_deposit_enabled` mặc định hay tắt? | **Tắt** (bật sau khi thử PayOS thật 1 khoản) |
| Q2 | Hạn link nạp? | **60 phút** (`wallet.payos_topup_expire_minutes`, 5–1440) |
| Q3 | Trần mỗi lần nạp? Có cần trần theo ngày? | **50.000.000 ₫/lần**; KHÔNG có trần ngày (thêm sau nếu cần) |
| Q4 | Tiền về muộn vào link đã hết hạn/huỷ: ghi có (mặc định) hay giữ lại chờ kế toán duyệt? | **Ghi có ngay** + báo kế toán |
| Q5 | Người nhận thông báo bất thường: kế toán + admin (`supplier.wallet.approve`); chủ shop nhận mỗi lần ghi có | như mặc định |
| Q6 | `EF_ADMIN_URL` production là gì? | cần chủ dự án điền (ví dụ `https://fitly-admin.vercel.app` ở file mẫu deploy) |
| Q7 | Cho phép nạp thiếu/lẻ (< `wallet.min_deposit`) khi tiền thật về? | **Có** (min/max chỉ áp lúc TẠO link) |
| Q8 | "Rút cọc"/hoàn khoản nạp: làm ở plan sau (PLAN-0030 §2.3)? | **Ngoài phạm vi**; ghi ràng buộc ở R5 |
| Q9 | Hardening: webhook chỉ là "kích hoạt", ghi có theo số `amountPaid` do chính hệ thống hỏi lại PayOS API (chống giả webhook nếu lộ checksum)? | **Chưa làm** (webhook ký là nguồn chính, cùng mức tin cậy đường đơn); nếu muốn: thêm `reconcileOne` đồng bộ trong `settleWebhookIfTopup` — thay đổi nhỏ |
| Q10 | Hạn mức tạo link 10 lần/10 phút/người có phù hợp? | như mặc định |
| Q11 | Tên shop trên nội dung chuyển khoản PayOS (`NAPCOC <mã shop>`) có ổn? (PayOS thật có thể giới hạn 9 ký tự nếu TK chưa liên kết ngân hàng) | như mặc định; chỉnh ở một hàm `topupDescription` nếu PayOS từ chối |

**Phát hiện ngoài phạm vi (ghi lại, KHÔNG sửa trong plan này):** ở đường thanh toán ĐƠN HÀNG (`settlePayosOnce` ~720–740) nhánh "webhook thứ hai sau khi return/poll đã ghi `paid`" có vẻ coi mọi webhook sau webhook đầu là "khách trả trùng"; nếu khách trả HAI khoản (thiếu rồi nốt), mất webhook của khoản sau, poll thấy luỹ kế đủ ⇒ `paid`, rồi webhook khoản sau đến muộn ⇒ bị cộng `received_amount` lần nữa và tạo hoàn `duplicate_payment` cho phần đã được tính trong luỹ kế. Công thức `max(Σ biên nhận, luỹ kế)` của plan này không mắc lỗi đó. Đề nghị chủ dự án cho một phiên kiểm lại đường đơn bằng bài `t09` thêm ca "mất webhook khoản 2 + webhook đến muộn".

---

## 14. Nhật ký tiến độ

| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| 2026-11-03 | Hoàn thành code + kiểm thử (Pha 1–3) | 8 gói WP do agent Haiku làm theo plan; điều phối viên kiểm: CỔNG 1 (migration áp sạch lên DB trống, `prisma migrate diff` không lệch, `tsc`). CỔNG 2: BE `verify` xanh (92 suite · **2429** test, +105), admin `verify` xanh. Harness Postgres thật: **t11 32/32 ✔** (WTP-01…32: đồng thời, 0 deadlock, rollback, bất biến I1–I9, Σ ví = Σ PayOS giả), `run-all.sh` **444 ✔ · 0 ✘ · 37 ℹ / 481 mã**, 0 hồi quy (baseline `baseline-2026-11-03-topup.json`). Hai lỗi đầu của t11 là lỗi BÀI TEST (đếm thông báo theo từng người nhận; `num()` của một đối tượng tiền ⇒ chữ ký webhook sai), không phải sản phẩm. Kiểm trình duyệt (bản sao FE + PayOS giả): chủ shop tạo link 600.000 ₫ → "trả" trên trang PayOS giả → trang quay lại "Nạp cọc thành công" → ví 6.100.000 → 6.700.000; kế toán thấy khoản ở tab sàn. **Phát hiện ngoài phạm vi và ĐÃ SỬA:** đường thanh toán ĐƠN (`settlePayosOnce`) hoàn nhầm khoản thứ hai khi khách chuyển 2 lần và poll/return thấy luỹ kế đủ trước webhook — nay chỉ hoàn phần VƯỢT (test jest PAY-09b…e + harness INS-01…03). |
| 2026-11-03 | Tạo plan (Draft) | Chưa có code. Đã đọc: AGENTS.md BE, PLAN-0020/0025/0040, `shop-wallet/*`, `payos.service.ts`, `payment.service.ts` (`handlePayos`, `settlePayosOnce`, `reconcilePendingPayos`), `payment-worker.module.ts`, `payment.prisma`, các migration ví, `catalog.ts`, settings, harness `e2e-audit/*`, FE admin ví (`vendor-wallet-screen`, `wallets-screen`, hook/kiểu/nhãn) và trang `payos-return` của storefront |
| | | |

---

## 15. File đã đổi (dự kiến)

```text
eco_backend
  prisma/migrations/20261103090000_wallet_payos_topup/migration.sql      (mới)
  prisma/schema/payment.prisma
  src/config/env.ts · .env.example · deploy/.env.production.example
  src/modules/payment/foundation/payment.constants.ts
  src/modules/payment/payos/payos.service.ts
  src/modules/payment/payment/payment.service.ts                          (3 chỗ)
  src/modules/payment/payment/payment-payos.spec.ts                       (1 dòng + stub)
  src/modules/payment/payment/payment-topup-routing.spec.ts               (mới)
  src/modules/payment/payment.module.ts · payment-worker.module.ts
  src/modules/payment/shop-wallet/shop-wallet.service.ts · shop-wallet.spec.ts (+khối mới)
  src/modules/payment/shop-wallet/shop-wallet-topup.service.ts (mới) · shop-wallet-topup-settle.service.ts (mới) · shop-wallet-topup.types.ts (mới) · shop-wallet-topup.job.ts (mới)
  src/modules/payment/shop-wallet/controller/shop-wallet-topup.controller.ts (mới) · shop-wallet.controller.ts · (tuỳ chọn) topup.mapper.ts
  src/modules/payment/shop-wallet/dto/shop-wallet.dto.ts · shop-wallet-topup.dto.ts (mới)
  src/modules/payment/shop-wallet/*.spec.ts + shop-wallet-topup.fixture.ts (mới)
  src/modules/system/enums/setting-keys.ts · src/modules/system/foundation/system.constants.ts
  docs/06_FE_CONTRACT.md · 02_MODULE_MAP.md · 07_KEYS_CHECKLIST.md · 08_DEPLOY.md · 12_OPERATIONS_RUNBOOK.md · README.md
  docs/plans/assets/e2e-audit/t11-wallet-topup-payos.mjs (mới) · mock-payos.mjs · jobs.cjs · auditenv.sh · run-all.sh · README.md
fashion_frontend_admin
  src/features/shop/types/wallet.ts · wallet-topup.ts (mới)
  src/features/shop/hooks/use-wallet-topups.ts (mới)
  src/features/shop/components/wallet-labels.ts
  src/features/shop/components/vendor/{vendor-wallet-screen,topup-dialog,active-topup-card,my-topups-table,topup-return-screen}.tsx
  src/features/shop/components/platform/{wallets-screen,wallet-topups-tab}.tsx
  src/app/(vendor)/vendor/wallet/payos-return/page.tsx (mới)
  src/lib/constants.ts · src/lib/labels.ts
  AGENTS.md (Rule 1) · docs/plans/PLAN-0006-wallet-payos-topup.md (mới)
```

---

## 16. Definition of Done

- [ ] Build/lint/boundaries/test xanh ở BE; `npm run verify` xanh ở admin FE; `migration:check` xanh
- [ ] Migration chỉ THÊM (+ nới 1 CHECK); DBML: N/A có lý do (DBML hiện không có bảng ví cọc)
- [ ] Không FK xuyên module; không import chéo repository/entity; model `ShopCodTopup*` chỉ gọi trong `src/modules/payment/**` (`prisma-boundaries.spec`, `check:boundaries` xanh)
- [ ] Audit log cho mọi thao tác ghi (tạo/chốt/lỗi/ghi có/huỷ/hết hạn); outbox: không cần (thông báo trực tiếp qua gateway sau commit — ghi lý do ở `Service Note`)
- [ ] Swagger có đủ route + DTO mới (`@ApiOperation`, `@ApiProperty`)
- [ ] `t11` 100% ✔ trên Postgres thật; bất biến §10 đúng; 0 deadlock; `run-all.sh` không hồi quy
- [ ] Seed: N/A có lý do (§1.4 — dữ liệu vận hành gắn mã PayOS thật, không seed)
- [ ] Plan checklist §12.5 + nhật ký §14 + file đã đổi §15 cập nhật
- [ ] README §Trạng thái + `02_MODULE_MAP` + `06_FE_CONTRACT` + `07_KEYS_CHECKLIST` + `08_DEPLOY` + `12_OPERATIONS_RUNBOOK` cập nhật
- [ ] Đã thử trình duyệt đủ vai (≥ 2 việc được + 2 việc KHÔNG được mỗi vai) và 390px
- [ ] Rà soát độc lập (§12.4) xong; chủ dự án đã `db:dump` lại và thử PayOS thật trước khi bật cờ

