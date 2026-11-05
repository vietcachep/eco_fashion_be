# PLAN-0025 — WP-01: Thanh toán vào an toàn (PayOS)

> Status: **BE XONG (2026-10-27, PLAN-0040 Tầng 1)** — §2.1 link sau commit, §2.2 hạn thống nhất, §2.3 poll định kỳ, §2.4 tiền thừa/thiếu/trùng, §2.5 tự chi hoàn nhỏ, §2.6 khoá; AUD-14 hoàn tay tra PayOS. CHƯA làm: FE (storefront `paymentUrl:null` + nút Thanh toán lại, admin nhãn `mismatch`), mô tả chuyển khoản ≤ giới hạn PayOS (cần kiểm tài liệu), PAY-14 (cần khoá PayOS thật). Migration `20261028090000_payment_received_amount` · Đợt 1 · P0 · Phụ thuộc: WP-00 · Plan cha: PLAN-0023
> Lỗ hổng: G01, G02, G03, G04, G05, G07 · Kịch bản: CK-15, CK-16, PAY-04…08, PAY-10, PAY-12…14, CAN-02 (phần tự chi), REF-01, REF-02, REF-12, OPS-03 (= PAY-13), CONC-02 (= PAY-12)

## 1. Mục tiêu

Khách đã trả tiền thì đơn **không bao giờ** bị huỷ oan; tiền lệch không bị bỏ quên; hoàn tiền nhỏ tự chạy; checkout không nghẽn vì chờ PayOS.

## 2. Thiết kế (đã chốt)

### 2.1 Tạo link PayOS SAU khi commit (G01)
- `PaymentGateway.initiate(..., tx)` cho PayOS **không gọi HTTP**: chỉ tạo payment `pending` (`checkoutUrl=null`, `expiresAt` = now + `order.vnpay_timeout_minutes`).
- Hàm mới `PaymentGateway.createCheckoutLinks(orderCodes: string[]): Promise<Map<code, {paymentUrl, qrCode, expiresAt} | {error}>>` — gọi **sau** khi transaction `placeOrder` commit; mỗi link timeout 8s, chạy song song có giới hạn (3).
- Lỗi tạo link ⇒ payment giữ `pending` + `link_error` (cột mới `last_link_error`, `link_attempts`); response đặt hàng trả `paymentUrl: null, linkRetryable: true` ⇒ FE hiện "Chưa tạo được mã thanh toán — bấm Thanh toán để thử lại" (dùng `POST /payments/payos/retry/:code` sẵn có).
- Bỏ đọc giỏ/trạng thái shop ngoài tx là việc của WP-08; WP-01 chỉ đưa HTTP ra ngoài.

### 2.2 Hạn thống nhất (G05)
- Hạn link PayOS = `order.vnpay_timeout_minutes` (bỏ hằng số 30' trong `payment.service.ts`).
- `retryPayos` gia hạn **cả** `payment.expiresAt` **và** `order.paymentExpiresAt` = now + hạn (qua cổng `OrderPaymentGateway.extendPaymentDeadline(orderCode, until, tx)` mới).

### 2.3 Đối chiếu chủ động (G02)
- Job `payos-reconcile-pending` (mỗi 2 phút, khoá advisory): payment PayOS `pending` có (`expiresAt` < now + 2') hoặc (tạo > 10' trước và chưa hỏi trong 5') ⇒ `getPaymentLinkInformation(orderCode)` ⇒ `PAID` ⇒ đi **đúng đường webhook** (`settlePayos`, nguồn `poll`, idempotent); `CANCELLED/EXPIRED` ⇒ ghi nhận; lỗi mạng ⇒ bỏ qua lần này. Lưu `last_checked_at`, `last_gateway_status`.
- `cancelExpired` (order) chỉ huỷ khi: now > `paymentExpiresAt + order.payment_grace_minutes` **và** cổng mới `PaymentGateway.confirmUnpaid(orderCode)` trả `true` (hỏi PayOS ngoài tx; PayOS lỗi ⇒ `false` ⇒ để lần sau, nhưng quá hạn + 60' mà PayOS vẫn lỗi ⇒ huỷ và đánh dấu `needsReconcile` để job ngày WP-10 rà).

### 2.4 Tiền lệch (G03)
- `settlePayos` cộng dồn `received_amount` theo giao dịch (cột mới, mặc định 0).
- `received ≥ total` ⇒ `paid`; phần thừa (`received − total`) ⇒ refund `kind='mismatch'` tự tạo.
- `received < total` ⇒ không `paid`; ghi giao dịch `mismatch`; thông báo kế toán (A + D). Khi đơn bị huỷ do hết hạn ⇒ refund `kind='mismatch'` = `received_amount`.
- Refund `mismatch` **không** đổi trạng thái thanh toán đơn, **không** đảo hoa hồng (giống `duplicate_payment`).

### 2.5 Tự chi hoàn nhỏ (G04)
- Job `refund-auto-process` (mỗi 5 phút): refund `requested`, `method=gateway`, có payee xác định được, payout PayOS đã cấu hình, `amount ≤ refund.auto_max_amount` ⇒ `processRefund` với actor hệ thống. Không đủ điều kiện ⇒ thông báo kế toán **một lần** khi refund được tạo ("Khoản hoàn mới cần xử lý: <mã đơn> <số tiền> <lý do>").
- Setting mới `refund.auto_max_amount` (mặc định 2.000.000, min 0 = tắt tự chi, max 50.000.000).

### 2.6 Khoá & PayOS (G07)
- Thứ tự khoá thống nhất **đơn → payment**: đường webhook/poll gọi cổng mới `OrderPaymentGateway.lockOrder(orderCode, tx)` trước khi khoá payment.
- Mô tả chuyển khoản: hằng số cấu hình `EF_PAYOS_DESCRIPTION_MAX` (mặc định 25; đặt 9 nếu tài khoản PayOS chưa liên kết ngân hàng) — sinh mô tả ngắn từ mã PayOS số; kiểm với tài liệu PayOS hiện hành trước khi chốt.

## 3. Phạm vi file

Sở hữu: `src/modules/payment/payment/payment.service.ts` (initiate, createCheckoutLinks, retryPayos, settlePayos, confirmUnpaid, refund tự chi), `src/modules/payment/payos/payos.service.ts`, `src/modules/payment/payment-worker.module.ts` (job mới), `prisma/schema/payment.prisma` + migration, `src/common/gateway/payment.gateway.ts` (thêm hàm — thông báo trong báo cáo).
Vùng trong file nóng: `order.service.ts` → `placeOrder` (gọi `createCheckoutLinks` sau commit), `cancelExpired`, `onPaid`/`onPaymentFailed`; `order/gateway/order-payment.gateway.impl.ts` (`lockOrder`, `extendPaymentDeadline`).
FE storefront: trang thành công/thanh toán xử lý `paymentUrl: null` + nút thử lại; trạng thái "đang kiểm tra với PayOS". FE admin: nhãn `mismatch` ở hoàn tiền; giao dịch lệch hiển thị trên chi tiết thanh toán.
KHÔNG đụng: `shop-payout/**`, `shop-wallet/**`, return services.

## 4. API / migration / setting

- Response `POST /orders`: mỗi đơn con thêm `linkRetryable: boolean`; `paymentUrl` có thể `null`.
- `RefundResponse.kind` thêm `mismatch`; `PaymentResponse` thêm `receivedAmount`, `lastGatewayStatus`, `lastCheckedAt`.
- Migration `payments`: `received_amount numeric(14,0) default 0`, `link_attempts int default 0`, `last_link_error varchar(255)`, `last_checked_at timestamptz`, `last_gateway_status varchar(30)`; backfill `received_amount = amount` cho payment `paid`.
- Setting: `order.payment_grace_minutes` (10; 0–60), `refund.auto_max_amount` (2.000.000; 0–50.000.000).
- Cập nhật `docs/06_FE_CONTRACT.md` mục thanh toán.

## 5. Bước

- [x] BE 2.1 + test CK-15/CK-16 (đã xong: `createCheckoutLinks` sau commit, `linkRetryable`) (giả lập PayOS chậm 5s bằng PayOS giả của WP-00).
- [x] BE 2.2 + PAY-10 (hạn từ setting; retry gia hạn payment + đơn qua `OrderPaymentGateway.extendPaymentDeadline`).
- [x] BE 2.3 + PAY-04, PAY-05, PAY-13 — (đủ: thêm job poll `payos-reconcile-pending` 2 phút, `last_checked_at`/`last_gateway_status`) — `PaymentGateway.confirmPaymentStatus` (hỏi mọi link PayOS của đơn, ghi nhận qua `settlePayos` nếu PAID), `OrderService.cancelExpired` chỉ huỷ khi quá hạn + `order.payment_grace_minutes` và cổng xác nhận chưa trả (PayOS lỗi ⇒ để lần sau; quá hạn + ân hạn + 60' ⇒ huỷ). **Còn:** job poll định kỳ `payos-reconcile-pending` mỗi 2 phút (`last_checked_at`, `last_gateway_status`), cột theo dõi.
- [x] BE 2.4 + PAY-07, PAY-08, REF-12 (cộng dồn `received_amount`; khử trùng theo `reference`; hoàn `mismatch`/`duplicate_payment` cùng payment — chỉ mục UNIQUE `(type, provider_ref)` buộc các hàng giao dịch sau mang hậu tố mã khoản).
- [x] BE 2.5 + REF-01, REF-02, CAN-02, PAY-06 (job `refund-auto-process` 5 phút, setting `refund.auto_max_amount`, tác nhân hệ thống UUID rỗng).
- [x] BE 2.6 (thứ tự khoá ĐƠN → PAYMENT, AUD-01) + PAY-12 (test đồng thời webhook ↔ huỷ), PAY-14 (thủ công với PayOS — để WP-13 nếu chưa có khoá).
- [ ] (sau đồng bộ API) FE storefront + admin; trình duyệt: đặt PayOS khi PayOS giả lỗi → thử lại → trả → thành công.

## 6. Test

U: mọi mã ở đầu plan (đặt tên `[MÃ]`). S: `--tag PAY` + CK-15/16. B: storefront checkout/thanh toán lại; admin nhãn hoàn `mismatch`.
Thêm: tải 50 checkout đồng thời với PayOS giả trễ 5s ⇒ p95 < 3s và không lỗi timeout transaction.

## 7. Review — trọng tâm riêng

- Có đường nào đơn đã trả bị huỷ (poll lỗi + hết ân hạn)? Có đường nào ghi `paid` hai lần / cộng `received_amount` hai lần cho cùng giao dịch (webhook + poll)?
- Tự chi hoàn: có thể chi khoản đang được kế toán xử lý tay không (CAS trạng thái)?
- Thứ tự khoá mới có áp cho **mọi** đường (webhook, poll, return page, huỷ, retry)?

## 8. Quyết định phát sinh

* Cổng mới trả `'paid' | 'unpaid' | 'unknown'` (thay vì boolean `confirmUnpaid` của plan) để phân biệt "PayOS lỗi" với "chưa trả".
* `confirmPaymentStatus` hỏi tối đa 5 link PayOS gần nhất của đơn (khách có thể trả link CŨ sau khi bấm thanh toán lại).
* PAID nhưng số tiền lệch ⇒ trả `unpaid` (không ghi `paid`); xử lý tiền lệch tự hoàn thuộc §2.4 (chưa làm).

## Phát hiện từ audit E2E (2026-10-27) — phải xử lý trong WP này

> Nguồn: `docs/13_E2E_TEST_REPORT.md` · tái hiện bằng `docs/plans/assets/e2e-audit/` (t02, t02b, t06b). Chấp nhận WP khi chạy lại các bài này **không còn ✘ của mục tương ứng**.

- [x] **AUD-01 (P0, G07) — ĐÃ SỬA 2026-10-27** — webhook tiền về ∥ khách huỷ cùng đơn từng deadlock ⇒ webhook HTTP 500, đơn `cancelled` + payment `unpaid` + chưa refund (**CONC-08**). **Nguyên nhân:** đảo thứ tự khoá — webhook khoá payment rồi `onPaid` mới khoá đơn; khách huỷ khoá đơn rồi mới đụng payment. **Sửa:** thứ tự khoá bất biến ĐƠN → PAYMENT: thêm `OrderPaymentGateway.lockOrder` (order cài qua `OrderService.lockOrder` → `OrderRepository.lockByCode`), `settlePayos` và `finalizeRefund` khoá đơn TRƯỚC rồi mới khoá payment; thêm lớp phòng thủ `retryOnDeadlock` (`common/prisma/errors.ts`, 40P01/P2034, 3 lần) quanh hai transaction đó. Khi webhook đến sau huỷ ⇒ refund "Thanh toán đến sau khi đơn đã huỷ" (đã có). **Kiểm chứng trên Postgres thật** (`assets/e2e-audit/t08-p0-verify.mjs`, 12 vòng huỷ ∥ webhook): code cũ ⇒ 12/12 deadlock, webhook 500, đơn huỷ/unpaid/không refund; chỉ khoá-đơn-trước ⇒ 0 deadlock; bản đầy đủ ⇒ 0 deadlock, 12/12 `cancelled` + `paid` + đúng 1 refund. Test đơn vị: `payment-payos.spec.ts` (thứ tự khoá, thử lại khi 40P01, không thử lại lỗi khác).
- [x] **AUD-04 (G03) — ĐÃ SỬA (PLAN-0040 Tầng 1.1)** — hành vi hiện tại: trả thừa ⇒ phản hồi `Amount mismatch — recorded for review`, đơn vẫn `unpaid`, không hoàn (PAY-08); trả thiếu hết hạn ⇒ huỷ nhưng không hoàn số đã nhận (PAY-07b); trả lần 2 mã khác ⇒ `Success` nhưng không có refund `duplicate_payment` (PAY-09). Làm §2.4: refund `mismatch`/`duplicate_payment` tự tạo + thông báo kế toán.
- [x] **AUD-05 (G05) — ĐÃ SỬA (Tầng 1.2)** — thanh toán lại không gia hạn `paymentExpiresAt` ⇒ job huỷ ngay dù khách vừa tạo link (PAY-10b). Làm §2.2.
- [x] **AUD-06 (G01, G81) — ĐÃ SỬA (Tầng 1.3)** — PayOS chậm 3s: 6 checkout đồng thời mất tới **18,5s** (HTTP trong transaction, CK-16). PayOS lỗi 500: đơn **không được tạo**, trả 503 `PAYMENT_PAYOS_NOT_CONFIGURED` (sai nghĩa; kỳ vọng CK-15: đơn vẫn tạo, payment `link_failed`, khách bấm "Thanh toán lại"). Tạo đơn → commit → gọi PayOS.
- [x] **Job poll định kỳ — ĐÃ LÀM (Tầng 1.4)** `payos-reconcile-pending` (mỗi 2 phút) — hiện khách đã trả mà mất webhook phải chờ hết hạn + ân hạn mới được ghi nhận (PAY-04b).
- [x] **AUD-14 (G78) — ĐÃ SỬA (Tầng 1.6: tra PayOS theo referenceId, 409 `PAYMENT_REFUND_RECONCILE_REQUIRED`, cờ `confirmGatewayNotExecuted`)** — ghi sổ hoàn tay với `providerRef` nhập tay không đối chiếu PayOS.
- Không phải lỗi (đừng sửa code): CK-02a lần 1, PAY-04 lần 1 (xem docs/13 §7).
