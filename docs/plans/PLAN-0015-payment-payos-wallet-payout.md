# PLAN-0015 — Thanh toán PayOS + Ví quỹ COD (ShopWallet) + Đối soát/Payout theo shop

> **Lưu ý (2026-10-15):** luồng ví COD / VNPay bị thay bởi PLAN-0018 — sàn thu mọi khoản (PayOS + COD), không còn ví quỹ COD; nội dung bên dưới là lịch sử thiết kế.

> Status: **BE ✅ đã triển khai — nhưng trong PLAN-0017, không theo đúng bản thiết kế này.** File này giữ làm bản thiết kế + lý do; các điểm LÀM KHÁC (Payment vẫn gắn đơn con, chi PayOS từng khoản, thêm `mark-paid`, thêm loại sổ ví `cod_refund`,
> giữ chi trả 24 giờ khi đổi TK…) và phần còn dang dở (chữ ký `x-signature` của Lệnh chi chưa xác nhận, chưa có webhook payout, chưa có cron chạy kỳ) ghi ở **§14** (rà soát mã nguồn 2026-10-04). Checklist §7/§8 bên dưới đã tick theo mã nguồn.
> Owner: Agent
> Related Phase: Phase 5 — Marketplace pivot
> Related Roadmap: `docs/04_ROADMAP.md`
> Phụ thuộc: **PLAN-0014** (Shop, OrderGroup, commissionRateSnapshot) phải xong trước (đã xong). Triển khai: **PLAN-0017** (Wave 1 B6/B7/B8 + Wave 0 migration `20261003100000_marketplace_completion`).

> Luật ownership: dòng tiền TÁCH BẠCH — (1) khách trả tiền cho SÀN qua PayOS/VNPay/COD như cũ, (2) sàn
> giữ hộ tiền rồi định kỳ trả về shop TRỪ hoa hồng (payout), (3) đơn COD-hoa-hồng theo dõi riêng qua ví
> (không chờ payout mới thu hoa hồng COD, vì tiền COD sàn không giữ được).

---

## 1. Mục tiêu

* Thay thế thiết kế "SePay" từng dự tính (chưa có trong code — chỉ có ở `docs/design/README.md`, xem
  PLAN-0014 §2) bằng **PayOS** làm cổng thanh toán chuyển khoản/QR tự động, đứng CẠNH VNPay hiện có
  (không xoá VNPay — vẫn dùng cho thanh toán thẻ nếu người dùng chọn).
* Tự động hoá bước "kế toán xác nhận tay chuyển khoản" (`confirmTransfer()` hiện tại) bằng webhook PayOS.
* **PayOS có cả 2 chiều thu/chi — đã xác nhận với tài liệu API thật
  (`https://payos.vn/docs/api/#tag/payout`, đọc 2026-09-28) — dùng CẢ HAI chiều:** payment link (`POST
  /v2/payment-requests`) để THU tiền khách, "Lệnh chi" (`POST /v1/payouts`) để CHI tiền ra — dùng
  `PayosService.payout()` (gọi `/v1/payouts`) cho CẢ trả tiền shop (`ShopPayout`) LẪN hoàn tiền khách khi
  có đủ số tài khoản ngân hàng đích. **1 điểm quan trọng khác thiết kế nháp đầu, đọc kỹ §3 "refund"**:
  "Lệnh chi" của PayOS là chuyển khoản THẲNG tới 1 số tài khoản (`toBin`+`toAccountNumber`) — KHÔNG PHẢI
  API "hoàn tiền theo giao dịch gốc" tự tra ra người nhận, nên hoàn tiền tự động chỉ thực hiện được khi
  HỆ THỐNG CÓ SẴN số tài khoản khách (xem giới hạn 3 ngân hàng ở §3).
* Thêm `ShopWallet` (ví quỹ COD của từng shop) và `ShopPayout` (đối soát định kỳ, trả tiền bán online về
  shop trừ hoa hồng, đóng băng số liệu theo kỳ). **Luật ví (chốt lại theo yêu cầu chủ dự án, KHÔNG có
  vùng đệm âm):** mỗi đơn COD *hoàn tất* trừ đúng hoa hồng của đơn đó khỏi ví; ngay khi
  `balance <= 0`, shop bị khoá COD cho đơn MỚI (`Shop.codEnabled` tự bật/tắt theo dấu số dư, không cấu
  hình ngưỡng riêng) — đơn COD đang giao dở dang không bị huỷ. Muốn mở lại: shop nộp thêm quỹ
  (`ShopWalletDepositRequest`), sàn duyệt → `balance += amount`; chỉ khi `balance > 0` sau khi cộng thì
  COD mở lại (nạp vừa đủ trả nợ âm mà không dư ra vẫn CÒN bị khoá, đúng nghĩa "trừ khoản âm rồi mới tính
  dư ra mở lại được" — dùng đúng phép cộng đại số, không cần logic tách riêng "trả nợ" và "nạp mới").
* Payment giờ gắn với `OrderGroup` (PLAN-0014) chứ không phải 1 `Order` đơn lẻ — 1 lần trả tiền cho
  nhiều đơn con thuộc nhiều shop.

---

## 2. Bối cảnh

Từ khảo sát `src/modules/payment/*` (payment.controllers.ts, payment.service.ts, vnpay/vnpay.service.ts):
cổng thật đang chạy là **VNPay** (thẻ) + **COD** + **chuyển khoản thủ công** (VietQR tĩnh, kế toán bấm
xác nhận tay qua `confirmTransfer()`). Toàn bộ đi qua 1 interface chung mà `order` module gọi
(`src/modules/order/gateway/order-payment.gateway.impl.ts`) — đây là điểm cắm PayOS vào ít tốn công nhất:
viết gateway mới cùng interface, `order`/`OrderGroup` không cần biết PayOS là gì.

Bảng `PaymentTransaction` đã có unique `(type, provider_ref)` chống double-credit — cơ chế idempotent
webhook dùng lại y nguyên cho PayOS, chỉ thêm giá trị enum `type='payos'`.

Tham khảo `eco_books/eco_backend`: không có PayOS thật (chỉ sandbox), nhưng có 2 bài học áp dụng được:
1. Interface 2 lớp (nội bộ gọi payment thế nào / payment gọi nhà cung cấp cụ thể thế nào) — ta ĐÃ CÓ sẵn
   kiểu này (`PaymentGateway` interface hiện tại), chỉ cần thêm 1 implementation.
2. Tách 2 dòng tiền: ví tạm ứng COD (realtime mỗi đơn) và payout định kỳ (theo kỳ đối soát) — áp dụng y
   nguyên cho `ShopWallet` / `ShopPayout`.

**Quyết định chốt với chủ dự án (2026-09-28), thay đổi so với bản nháp đầu:** PayOS hỗ trợ CHI TIỀN tự
động (không chỉ thu tiền qua payment link như VNPay) — dùng luôn cho cả hoàn tiền khách VÀ trả tiền shop,
KHÔNG dừng ở mức thiết kế "kế toán làm tay" nữa. Bảng dưới so hiện trạng / thiết kế cũ / thiết kế mới:

| Việc | Hiện tại (trước PLAN-0015) | Bản nháp đầu PLAN-0015 | Chốt lại (bản này) |
|---|---|---|---|
| Hoàn tiền đơn `vnpay` | Tự động qua `VnpayService.refund()` | (không đổi) | (không đổi) |
| Hoàn tiền đơn `payos`, KHÁCH TRẢ TỪ MB Bank/ACB/KienlongBank | — (chưa có payos) | Ghi nhận tay | **Tự động qua `PayosService.payout()`** — webhook thanh toán gốc có sẵn `counterAccountBankId/Number` |
| Hoàn tiền đơn `payos`, KHÁCH TRẢ TỪ NGÂN HÀNG KHÁC | — (chưa có payos) | Ghi nhận tay | **VẪN GHI NHẬN TAY** — PayOS chỉ trả về số tài khoản người chuyển (`counterAccount*`) cho 3 ngân hàng trên (xác nhận từ tài liệu API thật); ngân hàng khác trường này rỗng, không có số để tự chi |
| Hoàn tiền đơn `cod`/`bank_transfer` | Ghi nhận tay (không có gateway để hoàn tự động) | (không đổi) | (không đổi — không có API để gọi, giữ tay) |
| Trả tiền shop (`ShopPayout`) | — (module payout chưa tồn tại) | Kế toán chuyển khoản tay + tự bấm "đã trả" | **Tự động qua `PayosService.payout()`** — shop tự khai số TK khi tạo hồ sơ, luôn có sẵn, không bị giới hạn 3 ngân hàng |

---

## 3. Phạm vi

### Trong phạm vi

* `src/modules/payment/payos/payos.service.ts` — implement `PaymentGateway`: tạo payment link
  (`createPaymentLink`), verify webhook signature (HMAC theo tài liệu PayOS: checksum key + data string
  theo đúng thứ tự field PayOS yêu cầu), truy vấn trạng thái link.
* `PaymentMethod` thêm giá trị `payos`; `Payment.initiate()` khi method=`payos` gọi PayOS tạo link, trả
  `checkoutUrl` + `qrCode` cho FE (thay vì VietQR tĩnh + chờ kế toán).
* Endpoint webhook công khai `POST /api/v1/payments/payos/webhook` — xác thực chữ ký PayOS, idempotent
  qua `PaymentTransaction(type='payos', provider_ref=orderCode)`, khi hợp lệ → đánh dấu `OrderGroup.paid`
  → gọi `orders.onPaid` cho TỪNG `Order` con thuộc group (qua gateway, giữ nguyên logic `onPaid` hiện có
  của từng đơn — không đổi).
* `Payment` đổi tham chiếu chính từ `orderId` sang `orderGroupId` (migration thêm cột, giữ `orderId`
  nullable cho dữ liệu cũ/tương thích ngược nếu cần đọc lịch sử trước pivot).
* `PaymentController.retry` áp dụng theo `orderGroupCode` (không theo từng `orderCode` con).
* `refund`: refund vẫn thực hiện Ở MỨC TỪNG `Order` con (khách trả riêng sản phẩm của 1 shop) —
  `Refund.orderId` giữ nguyên tham chiếu `Order` (không đổi sang OrderGroup), chỉ thêm
  `Refund.shopId` snapshot để lọc theo shop.
  **Hoàn tiền `payos` — CÓ ĐIỀU KIỆN, đã xác nhận với tài liệu API thật:** "Lệnh chi" PayOS
  (`POST /v1/payouts`) là chuyển khoản THẲNG tới `toBin`+`toAccountNumber` do MÌNH cung cấp — KHÔNG PHẢI
  API "hoàn đúng giao dịch gốc" tự tra người nhận (khác với `VnpayService.refund()` hiện có, gọi theo
  đúng transaction VNPay nên luôn tự động được). Số tài khoản người đã chuyển chỉ có trong webhook thanh
  toán gốc (`counterAccountBankId`/`counterAccountNumber`) — và theo đúng ghi chú trên trang API, CHỈ
  ĐƯỢC PAYOS TRẢ VỀ cho 3 ngân hàng: **MB Bank, ACB, KienlongBank**. Vậy:
  - Khách trả bằng 1 trong 3 ngân hàng trên → webhook có sẵn số TK → `processRefund()` tự gọi
    `PayosService.payout({ toBin: counterAccountBankId, toAccountNumber: counterAccountNumber, ... })`,
    kế toán KHÔNG cần nhập gì.
  - Khách trả bằng ngân hàng KHÁC (đa số trường hợp thực tế) → webhook không có số TK người chuyển →
    **GIỮ NGUYÊN luồng tay hiện có** (`AdminPaymentController` hiện form nhập `providerRef` như trước,
    kế toán tự chuyển khoản ngoài hệ thống rồi ghi nhận) — `payos` xếp CHUNG nhóm với `cod`/
    `bank_transfer` cho trường hợp này, KHÔNG như bản nháp trước coi `payos` luôn tự động 100% như
    `vnpay`. `PaymentService` kiểm tra `counterAccountNumber` có rỗng không để rẽ nhánh, không cần hỏi
    thêm quyết định nghiệp vụ — đây là giới hạn kỹ thuật của PayOS, không phải lựa chọn.
* `ShopWallet` (1-1 với `Shop`, tạo tự động khi shop được duyệt) + `ShopWalletTransaction` (append-only,
  mỗi đơn COD *hoàn tất* (`completed`) trừ đúng 1 lần hoa hồng — unique theo `(shopId, orderId)` chống
  trừ trùng) + `ShopWalletDepositRequest` (shop xin nộp thêm quỹ khi ví về 0/âm, sàn duyệt).
* `ShopPayout` — kỳ đối soát (vd theo tuần), snapshot `grossRevenue/commission/refundAmount/netPayout`
  cho các đơn **online đã thanh toán** (không phải COD — COD xử lý qua ví) trong kỳ. **Trả tiền TỰ ĐỘNG
  qua PayOS "Lệnh chi hàng loạt"** (`POST /v1/payouts/batch` — đã xác nhận với tài liệu API thật, có sẵn
  endpoint riêng cho việc này, tốt hơn gọi lẻ từng shop): chạy kỳ xong, gom TẤT CẢ shop có `netPayout > 0`
  thành 1 lô, gửi 1 lần `{ referenceId: <mã kỳ đối soát>, payouts: [{ referenceId: <shopPayoutId>, amount,
  toBin: Shop.bankCode, toAccountNumber: Shop.bankAccountNumber, description }, ...] }` — PayOS trả về
  trạng thái RIÊNG từng dòng (`transactions[].state`), map ngược về từng `ShopPayout.status`. Vendor tự
  khai `Shop.bankAccountNumber/bankAccountName/bankCode` trong hồ sơ shop, sàn xác minh trước khi duyệt
  shop; `status` do PHẢN HỒI API/`GET /v1/payouts/{payoutId}` xác nhận (state PayOS: PROCESSING→SUCCEEDED
  hoặc FAILED — map sang `processing`/`paid`/`failed` của mình), KHÔNG còn API "tự bấm đã trả" thủ công
  của bản nháp đầu — chỉ giữ 1 nút "Chạy lại" cho payout nào `status=failed`, dùng LẠI `providerRef` cũ
  làm 1 phần `x-idempotency-key` mới (chống chi đôi nếu PayOS thật ra đã xử lý xong nhưng phản hồi rớt).
  **Ràng buộc vận hành phát hiện từ tài liệu (không code giải quyết được)**: PayOS "Lệnh chi" trừ vào MỘT
  TÀI KHOẢN CHI RIÊNG của merchant (`GET /v1/payouts-account/balance`) — KHÔNG tự động lấy từ tiền khách
  đã thanh toán qua payment link. Sàn phải NẠP TIỀN vào tài khoản chi này (ngoài hệ thống, qua PayOS
  dashboard) đủ để trả các kỳ payout — nếu thiếu, API trả lỗi "Số dư không đủ" và payout đó vào
  `status=failed` (retry được sau khi nạp thêm, không mất dữ liệu). Thêm màn chỉ-đọc
  `GET /admin/payouts/payos-balance` (bọc `GET /v1/payouts-account/balance`) để kế toán biết trước khi
  chạy kỳ, tránh chạy `run` rồi cả loạt payout fail vì hết số dư.
* **Escrow (giữ lại chờ hết hạn đổi trả) — chốt với chủ dự án:** đơn online `completed` CHƯA được tính
  vào `grossRevenue` của kỳ payout ngay; chỉ tính khi đã QUA hạn đổi trả của đơn đó (dùng đúng hạn hiện
  có của `order.return` — theo `Order.completedAt + N ngày`, N lấy từ hạn đổi trả đang áp dụng, không
  đặt số N mới). Kỳ chạy payout (`ShopPayout.periodEnd`) chỉ gom các đơn đã qua hạn đổi trả TÍNH ĐẾN thời
  điểm chạy, đơn nào chưa qua hạn thì dồn sang kỳ payout kế tiếp (không loại bỏ, không mất doanh thu).
* **Payout âm mang sang kỳ sau — chốt với chủ dự án:** nếu 1 kỳ có `refundAmount` (đơn hoàn tiền tính
  trong kỳ) vượt `grossRevenue - commission` của shop đó, `netPayout` của kỳ này ĐƯỢC PHÉP âm — KHÔNG gọi
  `PayosService.payout()` (không có gì để chi), và số âm CỘNG DỒN trừ vào `netPayout` của kỳ payout KẾ
  TIẾP của chính shop đó (giống ghi nợ, không phải charge ngược tài khoản shop). `ShopPayout` cần thêm
  cột `carriedDebt` (nợ mang từ kỳ trước sang, 0 nếu không nợ) để mỗi kỳ tính đúng
  `netPayout = grossRevenue - commission - refundAmount - carriedDebtKỳTrước`.
* **KHÔNG tự động bù trừ ví COD âm bằng payout online — chốt với chủ dự án:** 2 dòng tiền vẫn tách bạch
  hoàn toàn (không đổi so với bản nháp đầu); kế toán muốn bù thì tự dùng `supplier.wallet.adjust` sau khi
  thấy payout đã chạy, hệ thống không tự làm thay.
* **Chặn COD — KHÔNG có vùng đệm âm** (chốt theo §1): mỗi lần `ShopWalletTransaction` trừ hoa hồng xong,
  nếu `balance <= 0` thì set `Shop.codEnabled = false` NGAY trong cùng transaction; checkout đọc thẳng
  `Shop.codEnabled` (không cần đọc lại `balance` mỗi lần đặt hàng, tránh race điều kiện đua khi nhiều
  đơn COD hoàn tất gần nhau). Duyệt `ShopWalletDepositRequest` xong, nếu `balance > 0` thì set lại
  `Shop.codEnabled = true` trong cùng transaction. Không dùng ngưỡng cấu hình `system.settings` như bản
  nháp trước — bỏ hẳn khái niệm "vùng đệm".
* Permission mới: `supplier.wallet.read`, `supplier.wallet.adjust` (sàn xem/chỉnh ví BẤT KỲ shop),
  `supplier.payout.read`, `supplier.payout.process` (sàn chạy kỳ đối soát — tự động chi tiền, không còn
  là "đánh dấu đã trả") — **khác mã** với `shop.wallet.read`, `shop.wallet.deposit-request`,
  `shop.payout.read` (vendor CHỈ xem ví/payout CỦA MÌNH). Đây là đúng bài học lỗ hổng của eco_books —
  không dùng chung mã.

### Ngoài phạm vi

* Xác minh tài khoản ngân hàng shop lúc duyệt hồ sơ (KYC ngân hàng) — coi `Shop.bankAccountNumber` do
  vendor tự khai đúng, sàn duyệt bằng mắt qua ảnh sao kê/xác nhận thủ công NGOÀI hệ thống trong plan này
  (không tích hợp API xác thực tên chủ tài khoản của PayOS/ngân hàng, dù PayOS có hỗ trợ — để plan sau
  nếu cần, tránh phình phạm vi PLAN-0015).
* Gỡ bỏ VNPay — vẫn giữ song song.
* Migrate dữ liệu "thiết kế SePay" trong `docs/design/` — coi như tài liệu cũ, đánh dấu deprecated, viết
  tài liệu PayOS mới thay thế (không xoá file cũ, thêm ghi chú ở đầu file).

---

## 4. Module ảnh hưởng

* `payment` (module chính bị sửa), `shop` (thêm sub-domain `wallet`/`payout` — có thể đặt trong chính
  module `payment` dưới dạng `payment/shop-wallet/`, `payment/shop-payout/` để tránh vòng phụ thuộc
  `shop → payment → shop`; quyết định: đặt trong `payment` vì đây bản chất là nghiệp vụ tiền, `payment`
  đã có `queryapi` cho `order` đọc, giờ `shop` đọc ví/payout của mình qua `payment.queryapi` tương tự).
* `order` (đổi tham chiếu Payment→OrderGroup, không đổi máy trạng thái từng Order).
* `identity` (thêm permission `supplier.wallet.*`, `supplier.payout.*`, `shop.wallet.*`, `shop.payout.*`).

---

## 5. Thiết kế DB

### `prisma/schema/payment.prisma` — thêm

```
enum PaymentMethodCode { cod bank_transfer vnpay payos }   // thêm payos

model Payment {
  ...existing...
  orderGroupId String              // MỚI — tham chiếu order.OrderGroup
  orderId      String?             // giữ nullable cho dữ liệu lịch sử trước pivot, không dùng cho đơn mới
}

model ShopWallet {
  id         String  @id @default(uuid())
  shopId     String  @unique
  balance    BigInt  @default(0)     // VND, có thể ÂM
  createdAt/updatedAt
}

model ShopWalletTransaction {
  id          String  @id @default(uuid())
  shopId      String
  orderId     String                // Order (đơn con) COD đã completed
  amount      BigInt                // âm = trừ hoa hồng
  balanceAfter BigInt
  createdAt   DateTime @default(now())
  @@unique([shopId, orderId])       // chống trừ trùng
}

model ShopWalletDepositRequest {
  id        String @id @default(uuid())
  shopId    String
  amount    BigInt
  status    DepositStatus @default(pending)  // pending|approved|rejected
  proofUrl  String?
  createdAt/updatedAt
}

model ShopPayout {
  id                  String @id @default(uuid())
  shopId              String
  periodStart         DateTime
  periodEnd           DateTime
  grossRevenue        BigInt             // chỉ đơn đã QUA hạn đổi trả tính đến lúc chạy kỳ (escrow)
  commission          BigInt
  refundAmount        BigInt
  carriedDebt         BigInt  @default(0)  // netPayout ÂM của kỳ TRƯỚC mang sang, trừ tiếp vào kỳ này
  netPayout           BigInt             // = grossRevenue - commission - refundAmount - carriedDebt; CÓ THỂ ÂM
  status              PayoutStatus @default(pending)  // pending|processing|paid|failed (chỉ có ý nghĩa khi netPayout > 0)
  providerRef          String?            // mã giao dịch chi tiền PayOS, để tra soát/chống chi trùng
  failReason           String?            // lý do lỗi lần chi gần nhất, hiện cho kế toán khi status=failed
  paidAt              DateTime?
  createdAt           DateTime @default(now())
  @@unique([shopId, periodStart, periodEnd])
}
enum PayoutStatus { pending processing paid failed }

// Bổ sung vào bảng `Shop` (đã tồn tại từ PLAN-0014, module `shop` — migration NÀY chỉ ALTER thêm cột,
// không định nghĩa lại bảng): nơi PayOS chi tiền payout tới. Vendor tự khai trong hồ sơ shop
// (`PATCH /shop/me`), sàn duyệt shop bằng mắt (xem "Ngoài phạm vi").
//   bankAccountNumber String?
//   bankAccountName   String?
//   bankCode          String?   // mã ngân hàng theo chuẩn PayOS/Napas
```

### Migration

* `src/modules/payment/migration/V<...>_payos_method_and_order_group.ts` — thêm enum value `payos`,
  cột `Payment.orderGroupId`.
* `src/modules/payment/migration/V<...>_shop_wallet_and_payout.ts` — 4 bảng `ShopWallet`,
  `ShopWalletTransaction`, `ShopWalletDepositRequest`, `ShopPayout`.
* `src/modules/shop/migration/V<...>_shop_bank_account.ts` — ALTER `shop.Shop` thêm 3 cột ngân hàng ở
  trên (bảng `Shop` đã tồn tại từ PLAN-0014 bước 1, migration này chỉ thêm cột — không phải tạo bảng
  mới, đặt trong module `shop` vì đúng schema đó, dù mục đích dùng là phục vụ payout của PLAN-0015 này).
* Backfill: mỗi `Shop` đã duyệt (từ PLAN-0014) → tạo `ShopWallet(balance=0)`.

### Luật

* `ShopWalletTransaction` append-only — KHÔNG update/xoá dòng cũ, muốn điều chỉnh thì thêm dòng bù trừ
  mới (đúng luật sổ cái chứng từ hiện hành của dự án).
* `ShopPayout.status` chỉ đi MỘT CHIỀU `pending → processing → paid`, hoặc `pending/processing → failed
  → processing` (được retry, không giới hạn số lần retry) — KHÔNG có endpoint đổi `paid` ngược lại
  `pending` (tránh đối soát 2 lần, đúng tinh thần `isPaid` một chiều học từ eco_books, áp dụng cho enum
  thay vì boolean).
* `commissionRateSnapshot` (từ PLAN-0014, trên `Order`) là nguồn DUY NHẤT tính hoa hồng cho payout — KHÔNG
  đọc lại `Shop.commissionRate` hiện tại (đã có thể bị sàn sửa sau khi đơn được tạo).
* `netPayout < 0` → KHÔNG BAO GIỜ chuyển sang `status=processing` (không có gì để PayOS chi) — payout kỳ
  đó tạo ra với `status=paid`, `paidAt=null`, chỉ mang ý nghĩa SỔ SÁCH (ghi nhận nợ), số âm đi vào
  `carriedDebt` của kỳ kế tiếp qua job tính payout (đọc §9 rủi ro về giới hạn "nợ dây chuyền").

---

## 6. API

```text
POST   /api/v1/payments/payos/webhook          # public, verify chữ ký PayOS
GET    /api/v1/payments/payos/return           # FE redirect sau khi thanh toán (giống vnpay/return)

# Ví quỹ
GET    /api/v1/admin/shops/:id/wallet                 # supplier.wallet.read
POST   /api/v1/admin/shops/:id/wallet/adjust          # supplier.wallet.adjust
PATCH  /api/v1/admin/wallet-deposits/:id/approve      # supplier.wallet.read (hoặc mã riêng nếu cần)
GET    /api/v1/shop/wallet                            # shop.wallet.read (shopId từ JWT)
POST   /api/v1/shop/wallet/deposit-requests           # shop.wallet.deposit-request

# Payout — TỰ ĐỘNG chi qua PayOS, không còn endpoint "đánh dấu đã trả" thủ công
POST   /api/v1/admin/payouts/run                      # supplier.payout.process — chạy 1 kỳ cho toàn sàn:
                                                        # tính netPayout từng shop (trừ escrow + carriedDebt)
                                                        # → shop nào netPayout>0 tự gọi PayosService.payout()
POST   /api/v1/admin/payouts/:id/retry                # supplier.payout.process — chạy lại 1 payout status=failed
GET    /api/v1/admin/payouts                          # supplier.payout.read
GET    /api/v1/shop/payouts                            # shop.payout.read (shopId từ JWT)

# refund tự động cho payos/vnpay đi qua endpoint SẴN CÓ `POST /admin/refunds/:id/process` — không đổi
# path, chỉ đổi hành vi bên trong: method='payos' → gọi PayosService.payout() thay vì yêu cầu
# providerRef nhập tay (xem §3 Trong phạm vi, mục "refund").
```

---

## 7. Bước triển khai

* [~] Bước 1 (xong trừ chữ ký payout — `payment/payos/payos.service.ts` + `payos.service.spec.ts`; làm khác: `orderCode` PayOS = `Date.now()*1000 + random(1000)` ánh xạ qua `payment_transactions.provider_ref` chứ không dùng mã nhóm/cột `payosOrderCode`; chi từng khoản `POST /v1/payouts`, không dùng `/batch`;
      **header `x-signature` CHƯA gửi/chưa xác nhận** — xem §14): `PayosService` — **đã xác nhận với tài liệu API thật** (`https://payos.vn/docs/api`,
      2026-09-28), viết đúng theo đây (không còn là giả định):
      - `createPaymentLink()` — `POST /v2/payment-requests`, body `{ orderCode: number (int, DÙNG
        orderGroupCode dạng số — xem lưu ý bên dưới), amount, description (≤ 9 ký tự nếu tài khoản khách
        không liên kết payOS!), cancelUrl, returnUrl, expiredAt, signature }`; `signature` = HMAC_SHA256
        (checksum key của kênh thanh toán) trên chuỗi
        `amount=$amount&cancelUrl=$cancelUrl&description=$description&orderCode=$orderCode&returnUrl=$returnUrl`
        (field sort alphabet, ĐÚNG như plan đã đoán trước — xác nhận khớp). `orderCode` là SỐ NGUYÊN, còn
        `OrderGroup.code` hiện thiết kế dạng chuỗi ("ORD-GRP-000456") — cần map 2 chiều (vd cột
        `Payment.payosOrderCode BigInt` riêng để tra ngược, không đổi định dạng `OrderGroup.code` đang
        dùng cho khách).
      - `getPaymentLink(id)` — `GET /v2/payment-requests/{id}` (id = orderCode hoặc paymentLinkId), trả
        `status/amountPaid/amountRemaining/transactions[]`.
      - `payout(items)` — `POST /v1/payouts` (1 khoản) hoặc `POST /v1/payouts/batch` (nhiều khoản, dùng
        cho `ShopPayout`, xem §3) — header `x-idempotency-key` (BẮT BUỘC, tự sinh chuỗi ổn định theo
        `Refund.id`/`ShopPayout` kỳ đối soát để retry an toàn) + `x-signature` (CHƯA xác nhận công thức
        ký chính xác trong lần đọc tài liệu này — khác `signature` body của payment-requests; PHẢI đọc kỹ
        mục chữ ký của "Lệnh chi" trên trang API TRƯỚC khi viết hàm này, không suy đoán từ payment-requests
        vì tài liệu ghi rõ đây là 2 API khác nhau); body `{ referenceId, amount, description, toBin,
        toAccountNumber, category? }` — **KHÔNG có field tên người nhận trong request** (PayOS tự tra
        `toAccountName` từ số tài khoản, trả về trong response, không cần/không được tự điền).
      - **Rủi ro xác nhận thêm trước khi code**: tài liệu ghi banner "PayOS ra mắt tính năng Chi hộ" —
        đây có vẻ là tính năng MỚI, merchant có thể cần đăng ký/kích hoạt riêng trên `my.payos.vn` ngoài
        việc tạo "kênh thanh toán" thường — xác nhận việc này với tài khoản PayOS thật trước khi code
        (lỗi API liệt kê sẵn `"Không có quyền chuyển khoản"` xác nhận đây đúng là quyền tách biệt).
        Cũng cần NẠP TIỀN vào "tài khoản chi" riêng (`GET /v1/payouts-account/balance`) trước khi test —
        không tự động lấy từ tiền khách đã thanh toán (xem §3 "Ràng buộc vận hành").
* [x] Bước 2 (`payment.service.ts` `createPayosLink`/`handlePayos`/`handlePayosReturn`/`retryPayos`; `payment.controllers.ts` `POST /payments/payos/webhook`, `GET /payments/payos/return`, `POST /payments/payos/retry/:orderCode`; link hết hạn 30 phút; `provider_ref` = orderCode PayOS, KHÔNG phải mã nhóm): `Payment.initiate()` nhánh `payos`; endpoint webhook + return; cập nhật
      `PaymentTransaction` idempotent theo `provider_ref = orderGroupCode`.
* [ ] Bước 3 (**KHÔNG LÀM — chủ ý**, PLAN-0017 §3 quyết định 1: `Payment` vẫn gắn từng đơn CON, mỗi đơn con một link/payment riêng, FE thanh toán lần lượt; không có cột `Payment.orderGroupId`; `placeOrder` gọi `payment.initiate` cho TỪNG đơn con): Migration `Payment.orderGroupId`; cập nhật mọi chỗ tạo `Payment` để trỏ `OrderGroup` (từ
      PLAN-0014 bước 7 — `placeOrder()` gọi `payment.initiate({ orderGroupId, amount: totalAmount })`).
* [x] Bước 4 (`payment.service.ts#processRefund`: CHIẾM yêu cầu `requested|failed → processing` rồi mới gọi cổng; PayOS tự động chỉ khi webhook gốc có `counterAccountBankId/Number` VÀ có khoá payout, không thì `PAYMENT_REFUND_MANUAL_REQUIRED` → nhập `providerRef`; idempotency-key = `refund.id`; test `payment-payos.spec.ts`): Sửa `PaymentService.processRefund()` — đơn `method=payos` (và `vnpay` như hiện có) gọi
      gateway `refund`/`payout` tự động; đơn `cod`/`bank_transfer` giữ luồng tay hiện có (nhập
      `providerRef`). Idempotent theo `Refund.id` (mỗi `Refund` chỉ gọi API chi 1 lần — lưu `providerRef`
      trả về, retry chỉ được phép khi trạng thái trước đó là lỗi rõ ràng, không phải "không chắc").
* [x] Bước 5 (`payment/shop-wallet/service/shop-wallet.service.ts` + `PaymentEventListeners` ở `payment-worker.module.ts` nghe `ORDER_STATUS_CHANGED → completed`; unique `(shop_id, type, order_code)`; `ShopCodGateway.setCodEnabled` đổi `Shop.codEnabled` NGAY trong tx; làm thêm job bù mỗi 10' và loại sổ `cod_refund`; test `shop-wallet.spec.ts`, `payment-worker.spec.ts`): `ShopWallet`/`ShopWalletTransaction` — trigger trừ ví khi 1 `Order` COD chuyển
      `completed` (hook vào đúng chỗ `updateStatus()` hiện có xử lý COD, KHÔNG viết lại máy trạng thái);
      set `Shop.codEnabled` theo dấu `balance` NGAY trong cùng transaction (§3).
* [x] Bước 6 (`createDepositRequest`/`approveDeposit`/`rejectDeposit`; route `POST /shop/wallet/deposit-requests`, `POST /admin/wallet-deposits/:id/{approve,reject}` — POST chứ không PATCH; mỗi shop một yêu cầu chờ duyệt): `ShopWalletDepositRequest` + duyệt → cộng `balance`, set lại `codEnabled` nếu `balance > 0`.
* [x] Bước 7 (migration `20261003100000_marketplace_completion` + `shop.service.ts#updateMe`/`PATCH /shop/me`; `payment/shop-payout/shop-payout.service.ts#run` thuộc `PaymentSettlementModule`: escrow theo `return.window_days` từ ngày giao, hoàn tiền chia tỉ lệ luỹ kế, nợ mang sang; `net<0 ⇒ carried`, `net=0 ⇒ settled` — KHÔNG phải `paid` như thiết kế, migration `20261003130000` sửa CHECK; chi PayOS lẻ từng shop ngoài transaction, thành công ⇒ `processing`; test `shop-payout.spec.ts`): Migration `Shop.bankAccountNumber/bankAccountName/bankCode` (module `shop`) + form
      `PATCH /shop/me` cho vendor tự khai. `ShopPayout` — job/endpoint chạy theo kỳ: gom đơn ONLINE đã
      `paid` VÀ đã qua hạn đổi trả (escrow, §3) tính đến lúc chạy, trừ `Refund` xử lý trong kỳ, cộng
      `carriedDebt` từ kỳ trước → ra `netPayout`; `netPayout > 0` → gọi `PayosService.payout()` tới tài
      khoản ngân hàng shop, cập nhật `status`/`providerRef` theo kết quả; `netPayout <= 0` → không gọi
      API, ghi `status=paid, paidAt=null` (sổ sách), số âm chuyển thành `carriedDebt` của kỳ SAU (job kỳ
      sau tự đọc `netPayout` âm gần nhất của shop để cộng vào `carriedDebt`).
* [x] Bước 8 (`ShopPayoutService.retry`: cho `failed`, `pending` khi đã có khoá payout, `processing` treo > 10 phút; idempotency-key = mã kỳ `PAY-…`; bị chặn 24 giờ sau khi shop đổi TK; THÊM `POST /admin/payouts/:id/mark-paid` — thiết kế đã bỏ nhưng thực tế cần vì chưa có webhook payout): `POST /admin/payouts/:id/retry` — chỉ cho `status=failed`, gọi lại `PayosService.payout()`
      với CÙNG `idempotencyKey` (chống chi đôi nếu lần trước thật ra đã thành công nhưng phản hồi bị mất).
* [x] Bước 9 (`identity/permission/catalog.ts`: `supplier.wallet.read|adjust`, `supplier.payout.read|process`, `shop.wallet.read|deposit_request`, `shop.payout.read` — `deposit_request` có gạch dưới; preset `accountant`/`manager`/`shop_owner` đã gán): Permission mới (`supplier.wallet.*`, `supplier.payout.*`, `shop.wallet.*`, `shop.payout.*`)
      + `perms:sync`.
* [x] Bước 10 (`docs/design/README.md` đã có ghi chú đầu file đánh dấu SePay là thiết kế cũ, trỏ sang PayOS; `docs/06_FE_CONTRACT.md` có mục payout/ví/PayOS — vẫn còn đường `mark-paid` thủ công): Cập nhật `docs/design/README.md` (đánh dấu phần SePay là deprecated, trỏ sang PayOS), viết
      lại `docs/06_FE_CONTRACT.md` mục payment (bỏ hẳn mô tả "kế toán chuyển khoản tay" cho payout).

---

## 8. Kiểm thử

> Rà soát 2026-10-04: test được xác nhận bằng ĐỌC `*.spec.ts` (tồn tại + nội dung khớp), KHÔNG chạy lệnh nào. Các mục cần chạy lệnh/boot/sandbox PayOS để `[ ]`.

* [ ] `npm run build`/`lint`/`check:boundaries` xanh — chưa chạy lại
* [x] `npm test` (đã viết; `payment-payos.spec.ts`, `payos.service.spec.ts`): webhook PayOS gọi 2 lần cùng `provider_ref` → chỉ ghi nhận thanh toán 1 lần; chữ ký sai → 401, không đổi trạng thái; số tiền lệch → không `paid`.
      Mục "`OrderGroup` có 2 `Order` → cả 2 `onPaid` khi webhook 1 lần" **không áp dụng** (Payment gắn từng đơn con, mỗi đơn con một link riêng — xem Bước 3).
* [x] Ví (`shop-wallet.spec.ts`, `payment-worker.spec.ts`): COD `completed` trừ hoa hồng đúng 1 lần dù sự kiện lặp (idempotent theo unique `(shop_id, type, order_code)`); `balance ≤ 0` ⇒ `codEnabled` tắt NGAY (về đúng 0 vẫn khoá);
      nộp quỹ/điều chỉnh làm `> 0` ⇒ bật lại; race khoá ví. Phần "checkout COD của shop bị chặn ngay lần đặt kế tiếp" (nối PLAN-0014): code có (`ORDER_SHOP_COD_DISABLED`) nhưng CHƯA có test `placeOrder` cho nhánh này.
* [x] Payout (`shop-payout.spec.ts`): chạy lại cùng kỳ không tạo trùng, hai lần chạy đồng thời chỉ một kỳ + một lệnh chi; đối soát dùng `commissionRateSnapshot` của đơn (không đọc lại `Shop.commissionRate`).
* [x] Escrow: `OrderQueryApi.settlementOrders` chỉ lấy đơn `completed`, đã thanh toán, KHÔNG COD, qua hạn đổi trả tính từ ngày giao, KHÔNG có yêu cầu đổi trả đang mở; đơn chưa qua hạn dồn kỳ sau (test `shop-payout.spec.ts` "escrow & chống tính trùng").
* [x] `netPayout` âm: KHÔNG gọi `PayosService.payout()`; **status là `carried` (không phải `paid`)**, kỳ SAU có `carriedDebt` đúng bằng phần âm và trừ vào net; net = 0 ⇒ `settled`; chuỗi nhiều kỳ không cộng nợ hai lần.
* [x] Hoàn tiền tự động: `Refund` của đơn `method=payos` có tài khoản đối ứng + khoá payout ⇒ `PayosService.payout()` (mock), không cần `providerRef`; thiếu tài khoản đối ứng hoặc chưa có khoá payout ⇒ `PAYMENT_REFUND_MANUAL_REQUIRED` (nhả chiếm); đơn `cod`/`bank_transfer` ⇒ hoàn tay, bắt buộc `providerRef`.
* [x] `PayosService.payout()`/`processRefund` gọi lại cùng `idempotencyKey` (`refund.id`, hoặc mã kỳ `PAY-…` với đối soát) ⇒ không chi đôi (test retry refund `failed`, retry payout).
* [ ] `npm run migration:check` xanh — chưa chạy lại.
* [ ] Swagger đủ; thử tay với sandbox PayOS (đặt hàng 2 shop → link PayOS **cho từng đơn con** → quét QR → từng đơn con `confirmed` → huỷ 1 đơn con đã thanh toán → hoàn tiền tự động) — chưa làm; cần khoá PayOS thật/sandbox (xem `docs/07_KEYS_CHECKLIST.md`).

---

## 9. Rủi ro / Ghi chú

* **Đã xác nhận (2026-09-28, đọc `https://payos.vn/docs/api`)**: PayOS CÓ tính năng chi tiền tự động
  thật ("Lệnh chi"/"Chi hộ" — `POST /v1/payouts`, `/v1/payouts/batch`), không phải suy đoán nữa. Field
  request/response, header `x-idempotency-key`, endpoint list payout/xem chi tiết/ước tính phí/xem số dư
  tài khoản chi đã ghi đúng theo tài liệu vào §3/§7. Không còn là rủi ro "có hay không có tính năng".
* **Rủi ro còn lại (chưa xác nhận, PHẢI làm trước khi code Bước 1)** — **Cập nhật 2026-10-04: code đã viết mà CẢ BỐN mục dưới vẫn CHƯA xác nhận** (mục 1 chưa ký; mục 2–3 là việc vận hành với tài khoản PayOS thật; mục 4 đã phản ánh trong `processRefund`):
  1. Công thức `x-signature` của "Lệnh chi" — trang đã đọc chỉ liệt kê header là bắt buộc, CHƯA thấy công
     thức ký cụ thể (khác `signature` trong body của payment-requests, đã xác nhận field/thứ tự). Phải mở
     đúng mục chữ ký của "Lệnh chi" (thường có link riêng trên trang, hoặc mục Authentication tổng) trước
     khi viết `payout()`.
  2. Merchant có cần bật riêng tính năng "Chi hộ" trên `my.payos.vn` không (banner trang API gợi ý đây là
     tính năng mới ra mắt) — xác nhận qua tài khoản PayOS thật của chủ dự án.
  3. "Tài khoản chi" (payout account) cần nạp tiền riêng, KHÁC với tiền khách thanh toán qua payment link
     — đã xác nhận có `GET /v1/payouts-account/balance` riêng; cần hỏi chủ dự án ai/khi nào nạp tiền vào
     đây trong vận hành thật (việc vận hành, không phải code).
  4. Hoàn tiền `payos` chỉ tự động được cho khách trả từ MB Bank/ACB/KienlongBank (xác nhận từ ghi chú
     "counterAccount" trên trang) — đa số ngân hàng khác vẫn phải ghi nhận tay, đã cập nhật vào §3.
* **Rủi ro**: "Nợ dây chuyền" (`carriedDebt`) không có giới hạn trong bản chốt này — 1 shop có thể nợ
  nhiều kỳ liên tiếp nếu tỉ lệ hoàn tiền cao. Plan này CHƯA thiết kế cơ chế cảnh báo/khoá shop khi nợ kéo
  dài (vd giống `codEnabled` cho ví) — để ngỏ, có thể cần PLAN-0016 riêng nếu vận hành thật gặp trường
  hợp này.
* **Rủi ro**: Chuyển `Payment` từ gắn `Order` sang `OrderGroup` là thay đổi có breaking risk nếu có báo
  cáo/analytics cũ đọc thẳng `Payment.orderId` — kiểm tra `reporting` module trước khi migrate.
* **Giả định**: Payout period mặc định hàng tuần, có thể cấu hình qua `system.settings` — xác nhận lại
  chu kỳ thật với người vận hành sàn khi triển khai thật (không phải quyết định kỹ thuật, để mở nhưng
  không chặn code — dùng giá trị mặc định hợp lý trước).
* **Giả định**: Hạn đổi trả dùng để tính escrow lấy nguyên giá trị hạn đổi trả hiện có của `order.return`
  (không đặt số ngày escrow riêng) — nếu chủ dự án muốn escrow DÀI/NGẮN hơn hạn đổi trả thực tế, cần nói
  rõ số ngày cụ thể, hiện plan giả định 2 con số này bằng nhau.
* **Chặn**: Không (PLAN-0014 phải merge trước khi bắt đầu plan này).

---

## 10. Nhật ký tiến độ

| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| 2026-09-28 | Tạo plan | Sau PLAN-0014 |
| 2026-09-28 | Chốt lại với chủ dự án: (1) ví COD chặn ngay ≤0, bỏ vùng đệm âm; (2) hoàn tiền + payout đi qua PayOS TỰ ĐỘNG (`PayosService.payout()`), không còn thao tác tay của kế toán; (3) payout có escrow chờ hết hạn đổi trả; (4) không tự bù trừ ví COD bằng payout; (5) payout âm mang nợ (`carriedDebt`) sang kỳ sau | Sửa §1/§2/§3/§5/§6/§7/§8/§9 |
| 2026-09-28 | Đọc tài liệu API thật của PayOS (`https://payos.vn/docs/api`, chủ dự án gửi link) — xác nhận field `POST /v2/payment-requests` (payment link, đúng như đã đoán), phát hiện MỚI: `POST /v1/payouts`/`/v1/payouts/batch` là chuyển khoản THẲNG (không phải "hoàn đúng giao dịch gốc"), hoàn tiền `payos` tự động CHỈ khả thi khi khách trả từ MB Bank/ACB/KienlongBank (3 ngân hàng duy nhất PayOS trả về `counterAccountNumber` trong webhook), ngân hàng khác vẫn phải ghi nhận tay; có "tài khoản chi" (`GET /v1/payouts-account/balance`) TÁCH BIỆT cần nạp tiền riêng; có endpoint chi hàng loạt dùng cho `ShopPayout`. Sửa §1/§2/§3/§7/§9 theo đúng sự thật này, không còn là giả định | Chưa xác nhận: công thức `x-signature` của Lệnh chi, việc kích hoạt tính năng "Chi hộ" trên tài khoản PayOS thật |
| 2026-10-03 | Triển khai (không theo từng chữ của plan) trong PLAN-0017 Wave 0–2 | Migration `20261003100000_marketplace_completion` (ví, đối soát, `Shop.bank_*`, `Refund.shop_id`), `PayosService`, ví quỹ COD, `PaymentSettlementModule`. Điểm làm khác ở §14. Sửa sau review: PayOS so tiền ×100 (không bao giờ settle), orderCode trùng, CHECK status payout quá hẹp (`20261003130000`), thêm loại sổ `cod_refund` (`20261003160000`) |
| 2026-10-04 | Rà soát tài liệu theo mã nguồn (không chạy lệnh) | Tick §7/§8 theo mã + spec; viết §14 (làm khác + việc còn lại); Status → "BE ✅ (triển khai ở PLAN-0017)" |

---

## 11. File đã đổi

```text
# (triển khai trong PLAN-0017 — chi tiết file ở PLAN-0017 §10)
prisma/schema/payment.prisma · prisma/schema/shop.prisma (bank_*) · prisma/migrations/20261003100000_marketplace_completion · 20261003130000_payout_status_carried_settled · 20261003160000_wallet_cod_refund_type
src/modules/payment/payos/payos.service.ts                         (thu: createPaymentLink/verifyWebhookSignature/getPaymentLink/cancelPaymentLink; chi: payout/payoutBalance)
src/modules/payment/payment/payment.service.ts + payment.controllers.ts   (nhánh payos, webhook/return/retry, processRefund tự động có điều kiện)
src/modules/payment/shop-wallet/**                                  (ví quỹ COD + yêu cầu nộp quỹ; /shop/wallet, /admin/wallets, /admin/shops/:id/wallet*, /admin/wallet-deposits*)
src/modules/payment/shop-payout/** + payment-settlement.module.ts   (đối soát chi trả shop; /admin/payouts*, /shop/payouts*)
src/modules/payment/payment-worker.module.ts                        (listener hoa hồng COD / hoàn tiền COD / tạo ví + job bù hoa hồng)
src/common/gateway/shop-cod.gateway.ts + src/modules/shop/gateway/**   (ShopCodGateway)
src/modules/order/queryapi/order.queryapi.ts                        (settlementOrders, commissionBasisOf, orderTotalsOf, completedCodOrderCodesSince, shopIdOfOrder)
src/modules/identity/permission/catalog.ts                          (supplier.wallet/payout.*, shop.wallet/payout.*)
src/config/env.ts + .env.example                                    (EF_PAYOS_*, EF_PAYOS_PAYOUT_*)
scripts/seed/payment.seed.ts + settlement.seed.ts                   (4 phương thức; ví + yêu cầu nộp quỹ + kỳ đối soát mẫu)
```

---

## 12. Việc tiếp theo

* [ ] Xác nhận công thức `x-signature` của "Lệnh chi" + thử sandbox/khoá thật một kỳ nhỏ — chi tiết ở §14 và `PLAN-0017` §12 (việc quan trọng nhất trước khi bật chi tự động).
* [ ] Webhook payout của PayOS (hiện kỳ chi thành công kẹt ở `processing` tới khi kế toán `mark-paid`) và cron/lịch chạy kỳ đối soát (hiện chạy tay).
* [ ] Cảnh báo/khoá shop khi `carriedDebt` kéo dài nhiều kỳ (chưa thiết kế).
* [ ] Dashboard tài chính cho sàn (tổng hoa hồng thu được, ví các shop) — `reporting` module, plan riêng.

---

## 13. Definition of Done

* [ ] Build/lint/boundaries/test xanh — chưa chạy lại (xem §8)
* [x] Migration đủ (`20261003100000`, `…130000`, `…160000`); DBML cập nhật và khớp Prisma (đối chiếu 2026-10-04)
* [x] Không FK xuyên module (ví/đối soát dùng `shop_id` trần; `PaymentModule` không import `OrderModule`, đối soát qua `OrderQueryApi`)
* [x] Audit log + outbox cho các thao tác tiền (duyệt/từ chối nộp quỹ, điều chỉnh ví, hoa hồng COD, payout run/retry/mark-paid: `WALLET_*`, `PAYOUT_*`)
* [~] Swagger + `docs/06_FE_CONTRACT.md` cập nhật — contract có mục PayOS/ví/payout; KHÔNG áp dụng "response `POST /orders` có `checkoutUrl`" (mỗi đơn con có `paymentUrl` riêng trong `OrderGroupResponse.orders[]`)
* [x] Plan checklist + nhật ký + file đã đổi cập nhật
* [x] README §Trạng thái cập nhật

---

## 14. Làm khác thiết kế & việc còn lại (rà soát mã nguồn 2026-10-04)

**Làm khác bản thiết kế ở trên** (đã tính vào code, không phải thiếu sót):

| Thiết kế (§1–§7) | Thực tế trong mã |
|---|---|
| `Payment` đổi sang gắn `OrderGroup` (`orderGroupId`), 1 link PayOS cho cả nhóm | `Payment` vẫn gắn từng đơn CON; mỗi đơn con một payment + một link PayOS (hết hạn 30'); FE thanh toán lần lượt (PLAN-0017 §3 quyết định 1) |
| `orderCode` PayOS dạng số suy từ mã nhóm, cột `Payment.payosOrderCode` | `orderCode = Date.now()*1000 + random(1000)` (cách yymmdd+6 số trùng ~50% ở 1.000 đơn/ngày), lưu ở `payment_transactions.provider_ref` (type `create_url`); webhook tìm payment qua đó |
| Chi hàng loạt `POST /v1/payouts/batch` cho `ShopPayout` | Chi LẺ từng shop `POST /v1/payouts`, gọi NGOÀI transaction (ghi `processing` trước, gọi sau); `idempotencyKey` = mã kỳ `PAY-<từ>-<đến>-<8 hex shop>` |
| Header `x-signature` của Lệnh chi | CHƯA gửi (TODO trong `PayosService.payout`) — công thức ký chưa xác nhận |
| Kỳ `netPayout < 0` ghi `status=paid, paidAt=null` | `status = carried` (không chi, mang nợ); `netPayout = 0` ⇒ `settled`; CHECK DB sửa ở `20261003130000` |
| Không có "đánh dấu đã trả" thủ công | Có `POST /admin/payouts/:id/mark-paid` (từ `processing`/`failed` luôn được; từ `pending` chỉ khi chưa cấu hình khoá payout) — cần vì chưa có webhook payout nên chi PayOS thành công vẫn ở `processing` |
| Retry chỉ cho `failed` | Retry cho `failed`, `pending` (khi đã có khoá payout) và `processing` treo > 10 phút; bị chặn 24 giờ sau khi shop đổi TK (đọc TK hiện tại, kể cả khi kỳ đã có snapshot) |
| Duyệt nộp quỹ `PATCH /admin/wallet-deposits/:id/approve` | `POST /admin/wallet-deposits/:id/{approve,reject}`; thêm `GET /admin/wallets`, `GET /admin/shops/:id/wallet/transactions`, `GET /shop/wallet/{transactions,deposit-requests}`, `GET /admin/payouts/:id`, `GET /shop/payouts/:id` |
| Sổ ví chỉ `cod_commission`/`deposit`/`adjust`, unique `(shopId, orderId)` | Thêm loại `cod_refund` (hoàn tiền đơn COD đã hoàn tất: ghi nợ ví số hoàn + hoàn lại hoa hồng; `20261003160000`); unique `(shop_id, type, order_code)`; hoa hồng COD ròng = hoa hồng − voucher sàn (âm = cộng ví); job bù mỗi 10' |
| Hoa hồng/đối soát tính trên `total` | Tính trên `total + platformDiscount` (voucher SÀN do sàn chịu, shop vẫn nhận đủ doanh thu); hoàn tiền chia theo tỉ lệ luỹ kế |
| Mã quyền `shop.wallet.deposit-request` | `shop.wallet.deposit_request` (gạch dưới — khớp regex mã quyền) |
| Chạy kỳ bằng job theo tuần cấu hình qua `system.settings` | Chạy TAY `POST /admin/payouts/run` (kỳ không được chồng kỳ cũ, `periodEnd` ≤ hiện tại); chưa có cron, chưa có tham số chu kỳ |
| Hoàn tiền `payos` tự động cho khách trả từ MB/ACB/KienlongBank | Tự động khi webhook gốc có `counterAccountBankId`+`counterAccountNumber` VÀ có khoá payout; nếu không `PAYMENT_REFUND_MANUAL_REQUIRED` ⇒ kế toán chuyển tay + nhập `providerRef` |

**Việc còn lại / giới hạn** (đầy đủ ở `PLAN-0017` §12): xác nhận `x-signature` Lệnh chi + thử sandbox một kỳ nhỏ; chưa có webhook payout; chưa có cron chạy kỳ; `carriedDebt` chưa có cảnh báo/khoá shop khi nợ kéo dài;
hoàn tiền thanh toán trùng có thể đặt `payment_status=refunded` cho đơn; `processRefund` finalize lỗi để refund kẹt `processing`; job bù hoa hồng COD trần 1000 đơn/45 ngày.
