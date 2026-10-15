# PLAN-0018 — Sàn thu MỌI khoản tiền (PayOS + COD), tự động đối soát & chi trả shop; bỏ VNPay, chuyển khoản tay, ví quỹ COD

> Status: **đang triển khai (2026-10-15)**
> Owner: Agent
> Related Phase: Phase 5 — Marketplace
> Phụ thuộc: PLAN-0014 (Shop, OrderGroup), PLAN-0015/0017 (PayOS, ví COD, đối soát — plan này THAY ĐỔI luồng tiền của hai plan đó)
> Quyết định của chủ dự án (2026-10-15): *"dù chuyển tiền hay COD đều chuyển về sàn, rồi sàn tự động trừ (hoa hồng) và tự động đưa cho người bán; chỉ dùng PayOS và COD, không dùng VNPay; khoá PayOS thu/chi sẽ cung cấp sau."*

## 1. Mục tiêu (luồng tiền MỚI)

1. **Chỉ còn 2 phương thức thanh toán: `payos` và `cod`.** Bỏ hẳn VNPay và chuyển khoản VietQR đối soát tay (`bank_transfer`) khỏi code, env, seed, FE, tài liệu.
2. **Mọi khoản tiền của khách đều về SÀN:**
   * `payos`: khách trả qua link PayOS → tiền vào tài khoản PayOS/ngân hàng của sàn (như cũ).
   * `cod`: đơn vị vận chuyển thu hộ tiền mặt rồi **nộp về SÀN** (không còn shop giữ tiền mặt). Khi đơn được xác nhận giao thành công, sàn ghi nhận đã thu COD (`markCodCollected`, như cũ) → `Payment` = `paid`.
3. **Sàn tự động đối soát và trả tiền cho shop** (cả đơn PayOS lẫn COD, cùng MỘT đường): chờ hết hạn đổi trả (escrow) → trừ hoa hồng (`commissionRateSnapshot`) → trừ hoàn tiền + nợ mang sang → chi PayOS "Lệnh chi" về tài khoản ngân hàng của shop. Chạy **tự động theo lịch** (cron trong worker), không cần kế toán bấm "chạy kỳ" (nút chạy tay vẫn giữ để chạy bù).
4. **Bỏ ví quỹ COD**: không còn `ShopWallet`, nạp quỹ, trừ hoa hồng COD khỏi ví, khoá COD khi ví ≤ 0, `Shop.codEnabled`.
5. Khoá PayOS **thu** (`EF_PAYOS_CLIENT_ID/API_KEY/CHECKSUM_KEY`) và **chi** (`EF_PAYOS_PAYOUT_*`) để TRỐNG vẫn chạy được (method `payos` tự ẩn, chi không gọi mạng); chủ dự án cung cấp sau. Chỉ còn `cod` hiển thị khi chưa có khoá.

## 2. Việc đổi so với PLAN-0015/0017

| Chủ đề | Trước | Sau PLAN-0018 |
|---|---|---|
| Phương thức | cod · bank_transfer · vnpay · payos | **cod · payos** |
| Tiền COD | shop giữ tiền mặt, sàn trừ hoa hồng vào ví COD | **sàn thu COD**, đối soát/chi trả như đơn online |
| Ví / nạp quỹ / khoá COD | có (module `shop-wallet`, `shop.wallet.*`, `supplier.wallet.*`) | **bỏ hẳn** |
| Đối soát chi trả | chỉ đơn online; kế toán chạy tay | **cả COD + PayOS**; **cron tự chạy**, chạy tay để bù |
| Hoàn tiền | VNPay API / PayOS payout / tay | **PayOS payout (khi đủ số TK) / tay**; COD hoàn tay |
| Quyền | 83 mã | bỏ `shop.wallet.read`, `shop.wallet.deposit_request`, `supplier.wallet.read`, `supplier.wallet.adjust` → **79 mã** |

## 3. Phạm vi kỹ thuật (backend)

* `payment`: xoá `vnpay/` (service, controller IPN/return/retry, spec), nhánh `bank_transfer` (intent VietQR, `confirmTransfer`, env `EF_BANK_TRANSFER_*`), `METHOD.VNPAY`/`BANK_TRANSFER`, `VNPAY_RESPONSE`; xoá `shop-wallet/` (controller/service/repository/dto/spec), `ShopCodGateway` + impl ở `shop`, hook trừ hoa hồng COD ở `payment-worker`/outbox, thông báo ví.
* `payment-methods` seed: chỉ `cod`, `payos`. Dữ liệu cũ có `methodCode` vnpay/bank_transfer vẫn đọc được (không crash mapper), nhưng không tạo mới được.
* `shop-payout`: `settlementOrders()` của order phải gom CẢ đơn COD (đã `delivered/completed` + `Payment.paid` qua `markCodCollected`) lẫn đơn online; cùng hạn đổi trả; cùng dòng `SALE`/`REFUND`. Hoàn tiền đơn COD đã đối soát: ghi dòng REFUND (ghi nợ mang sang) như đơn online.
* **Cron chi trả tự động** trong worker (`@nestjs/schedule`): mỗi ngày 02:00 Asia/Ho_Chi_Minh chạy kỳ `[ngày sau kỳ gần nhất, hết hôm qua]` (kỳ đầu: hôm qua); chỉ chạy khi setting `payout.auto_enabled` = true (mặc định true, sửa ở màn tham số) và PayOS chi đã cấu hình; idempotent nhờ UNIQUE(kỳ, shop) + idempotency-key PayOS; kỳ rỗng thì bỏ qua; ghi audit + outbox + thông báo cho thành viên shop (đã có).
* `order`: bỏ kiểm `ORDER_SHOP_COD_DISABLED`, bỏ gọi trừ ví khi `completed`, giữ giới hạn COD theo tham số hệ thống; vendor KHÔNG còn nút "thu COD" (sàn xác nhận khi giao).
* `shop`: bỏ `codEnabled` khỏi DTO/mapper/repository; hồ sơ shop vẫn có TK ngân hàng nhận tiền (bắt buộc để được chi).
* `identity/permission/catalog.ts`: bỏ 4 mã ví, cập nhật preset vai (accountant, shop_owner) + test đếm quyền (83 → 79).
* `prisma`: schema `payment.prisma`/`shop.prisma` bỏ `ShopWallet`, `ShopWalletTransaction`, `ShopWalletDepositRequest`, `Shop.codEnabled`, loại sổ `cod_refund`; **migration MỚI** `payment_platform_collects_all` (không sửa migration cũ): DROP 3 bảng ví + cột `shops.cod_enabled`, `UPDATE payment.payment_methods SET is_active=false WHERE code IN ('vnpay','bank_transfer')`, thêm setting `payout.auto_enabled`. `npm run migration:check` phải xanh.
* `seed`: bỏ ví/nạp quỹ khỏi `marketplace/settlement/activity/payment` seed; đơn COD mẫu đã giao có `Payment.paid`; kỳ đối soát mẫu gồm cả COD; `ai/chat-tools` bỏ nhắc VNPay/ví. `scripts/db/demo-data/*.dump` KHÔNG sinh lại được nếu không có DB — ghi chú "cần dump lại".
* `env`: bỏ `EF_VNPAY_*`, `EF_BANK_TRANSFER_*`; `.env.example` + `docs/07_KEYS_CHECKLIST.md` chỉ còn PayOS thu + PayOS chi (+ ghi rõ "chủ dự án cung cấp sau").
* Test: xoá spec của VNPay/ví; sửa spec đang nhắc ví/VNPay/bank_transfer (`payment-payos`, `payment-worker`, `vendor-isolation`, `shop-payout`, `shop-*`, `order-*`, `image-search`, ...); thêm test: COD vào đối soát, cron chi trả tự động (idempotent, tắt khi setting false hoặc chưa cấu hình PayOS chi), method chỉ còn cod/payos. `npm run build`, `npm run lint`, `npm run check:boundaries`, `npm test` phải xanh.

## 4. Phạm vi frontend

* `fashion_frontend_user`: bỏ VNPay + chuyển khoản khỏi checkout/đơn/thanh toán (`vnpay-return` page, `payment-method-list`, `use-pay-order`, schema, types, footer, trang sản phẩm/giỏ nhắc VNPay); chỉ còn chọn `COD` hoặc `PayOS`; mô tả COD: "thanh toán khi nhận hàng — shipper thu hộ cho sàn".
* `fashion_frontend_admin`: bỏ trang ví (`/shop/wallets`, `/shop/wallet-deposits`, `/vendor/wallet`) + menu + quyền `*.wallet.*`; cập nhật trang phương thức thanh toán (chỉ cod/payos), thanh toán/hoàn tiền (bỏ xác nhận chuyển khoản tay nếu có), payouts (cả COD, hiển thị "tự động chạy"), tham số `payout.auto_enabled`; vendor dashboard không còn khối ví.
* Client sinh bởi Orval (`src/lib/api/generated`, `openapi/`): sửa tay hoặc sinh lại từ Swagger; `npx tsc --noEmit` + `npm run lint` + `npm run build` phải xanh.

## 5. Ngoài phạm vi

* Khoá PayOS thật (chủ dự án cung cấp sau) — xác nhận chữ ký `x-signature` của API chi vẫn là việc MỞ (xem PLAN-0017 §12).
* Chia sẻ phí vận chuyển/đối soát với đơn vị vận chuyển (giả định: đơn vị vận chuyển nộp COD cho sàn đủ).
* Dump demo mới (`scripts/db/demo-data`).

## 6. Rủi ro / ghi chú

* Sàn phải có **dòng tiền đủ** trên tài khoản chi PayOS trước giờ cron chạy (nếu thiếu: payout `failed`, chạy lại được; đã có `GET /admin/payouts/payos-balance`).
* COD chưa nộp về sàn mà đơn đã `completed`: sàn tự chịu rủi ro nợ đơn vị vận chuyển — chỉ đưa vào đối soát khi `Payment=paid` (do sàn xác nhận thu COD), không dựa vào trạng thái đơn.
* Vì không còn ví khoá COD, việc chặn shop vi phạm làm qua **tạm khoá shop** (`supplier.shop.suspend`).

## 7. Nhật ký tiến độ

* 2026-10-15 — chủ dự án chốt luồng mới; viết plan; giao 4 luồng (BE code, BE docs, FE user, FE admin) + cập nhật bộ tài liệu Capstone (`docs-src`).
* 2026-10-15 — **BE docs xong** (chỉ chữ, không đụng .ts/.prisma/.sql/seed): `README.md`, `AGENTS.md` (Project Context, Marketplace/Vendor Rule, Payment Rule viết lại cho PayOS + COD + cron chi trả), `docs/00`–`08` (mô hình tiền, 79 mã quyền, bản đồ module payment/shop, DB rules + dòng migration `payment_platform_collects_all`, roadmap, seed, FE contract bỏ VNPay/bank_transfer/ví/`ORDER_SHOP_COD_DISABLED`/`codEnabled`, `07` chỉ còn PayOS thu/chi — chủ dự án cấp sau, `08`), `docs/database/eco_fashion.dbml` + `shop-modules-database-design.md` (bỏ 3 bảng ví, `shops.cod_enabled`), `docs/design/**/*.puml` + `eco_fashion-sepay.dbml` + `docs/design/README.md` (gắn cảnh báo "thiết kế cũ" + sửa danh sách method; KHÔNG đụng `usecase/` `screenflow/`), thêm con trỏ "bị thay bởi PLAN-0018" ở PLAN-0007/0014/0015/0017. Chưa sửa (ngoài phạm vi chữ): `.env.example`, `docker-compose.yml` còn nhắc VNPay/`EF_BANK_TRANSFER_*`; `docs/database` dbml cần khớp lại tên migration thật sau khi code agent tạo timestamp.
* 2026-10-15 — **thông báo chi trả shop**: `system-worker` thêm listener `PAYOUT_PROCESSING/PAID/FAILED` (idempotent theo `payload.eventId`, báo mọi thành viên active, link `/vendor/payouts`); payload `PAYOUT_FAILED` bổ sung `failReason`; enum công khai `payment/enums/payment-events.ts`.
* 2026-10-15 — tham số `payout.auto_enabled` đã có mô tả tiếng Việt trong `SETTING_DEFAULTS` + migration (seed upsert cập nhật mô tả); không cần migration mới.
