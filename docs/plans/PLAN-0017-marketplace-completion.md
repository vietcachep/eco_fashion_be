# PLAN-0017 — Hoàn thiện sàn đa gian hàng, đa ngành hàng (vendor vận hành · PayOS/ví/đối soát · dữ liệu mẫu · FE nối API thật)

> **Lưu ý (2026-10-15):** luồng ví COD / VNPay bị thay bởi PLAN-0018 — sàn thu mọi khoản (PayOS + COD), tự động đối soát/chi trả; các phần ví COD, VNPay, chuyển khoản bên dưới là lịch sử.

> Status: In progress — **BE xong** (Wave 0–2 + Track D dữ liệu mẫu, rà soát tài liệu theo mã nguồn 2026-10-04); còn: Wave 3 (FE — theo dõi ở plan của hai repo FE), Wave 4 (chạy lại `verify`/`migration:check`/boot app/click-through + review) và các giới hạn đã biết ở **§12**.
> **Đổi 2026-10-13**: luồng "mời nhân viên gian hàng có chấp nhận" (2026-10-04) **ĐÃ BỎ** — chủ dự án chọn **chủ shop THÊM nhân viên trực tiếp** (tạo tài khoản cho nhân viên, có hiệu lực ngay). Xem mục 18/20 ở §3b, nhật ký §9 và §12 › Shop / vendor.
> Owner: Agent (Sonnet điều phối; Haiku code song song; Sonnet tự làm phần lõi rủi ro cao)
> Related Phase: Phase 5 — Marketplace pivot (sau PLAN-0014/0015/0016)
> Quy trình bắt buộc: **plan → code → test → review** (mỗi đợt agent xong đều chạy lại `verify` trên trạng thái GỘP — không tin báo cáo "0 lỗi" của từng agent).

---

## 1. Mục tiêu

Đưa dự án từ "khung đã dựng" tới "chạy trọn vòng đời sàn": người bán (vendor) tự vận hành gian hàng đầu-cuối,
khách mua nhiều gian hàng/nhiều ngành hàng, tiền chảy đúng (PayOS thu · ví quỹ COD · đối soát chi trả shop), có dữ liệu
mẫu dày để nhìn là biết đây là sàn thương mại điện tử đa ngành hàng. **Mọi khoá bên thứ ba để TRỐNG** (§6) — hệ thống
tự lùi về đường không-khoá, người dùng điền sau.

## 2. Thực trạng LÚC BẮT ĐẦU PLAN (2026-10-03; đã kiểm chứng bằng grep/boot app, KHÔNG dựa checkbox plan cũ — checkbox PLAN-0014 đã lỗi thời)

> Cột "Còn thiếu" là việc lúc bắt đầu — toàn bộ phần BE đã làm xong (xem §4 và §12), riêng dòng "FE admin"/"FE user" vẫn là việc của hai repo FE.

| Mảng | Đã xong | Còn thiếu |
|---|---|---|
| shop | Shop/ShopMember, `/admin/shops/**`, `/shop/{me,members}`, ShopContextGuard, ràng buộc ≥1 owner, `Shop.ratingAvg` tự tính (shop-worker) | `/shop/me` chưa nhận tài khoản ngân hàng; seed shop = 0 (chỉ "FITLY Official") |
| product | `Product.shopId`, `/shop/products` CRUD + variants + publish/hide, SKU unique theo shop, thuộc tính động (PLAN-0016) | `/shop/inventory/*` (nhập kho/điều chỉnh), `/shop/products/:id/images` |
| order | OrderGroup + N đơn con theo shop, COD gating theo shop, race shop bị khoá, `commissionRateSnapshot` | `/shop/orders/**` (vendor xử lý đơn); voucher shop + luật cộng dồn (bước 8) |
| payment | VNPay, COD, chuyển khoản tay; **Payment gắn từng đơn CON** (không phải OrderGroup) | PayOS; ví quỹ COD; đối soát/payout; `Refund.shopId` |
| promotion | voucher sàn | `scope/shopId` (đã có cột — migration 20261003100000) + `/shop/promotions` |
| review | `Review.shopId`, `/shop/reviews` + trả lời (`shop.review.reply`) | — |
| reporting | `/admin/reports/**` toàn sàn | `/shop/reports/**` (lọc theo shop) |
| system | thông báo cho user | tự thông báo cho vendor: đơn mới, sắp hết hàng |
| ai | chatbot/FAQ/insight đã đổi sang khung sàn đa ngành | `/ai/image-search` (FE đã có màn, đang TODO) |
| identity | catalog quyền (đã thêm `shop.order/inventory/promotion/report/wallet/payout.*`, `supplier.wallet/payout.*`) | **preset `shop_owner` trước đây THIẾU `shop.product.*` → vendor không tạo được sản phẩm: đã sửa** |
| FE admin | 39 màn nhân viên sàn (real/mock theo `NEXT_PUBLIC_ENABLE_MOCK`, mặc định mock), 9 màn vendor **100% mock** | nối API thật; ma trận biến thể; màn sàn: shop/ví/payout |
| FE user | checkout đa shop (OrderGroup) chạy, cart nhóm theo shop, `/shop/[slug]` | trang chi tiết sản phẩm động (options), PayOS, `/account/notifications`, AI tìm bằng ảnh thật |
| Dữ liệu | 24 SP thời trang + 16 SP ngoài thời trang, 1 shop | **hàng trăm SP / 12 ngành hàng / nhiều shop / đơn / đánh giá / voucher + ảnh đúng ngành (§5)** |

## 3. Quyết định chốt (có lý do — người dùng chỉ cần phản hồi nếu muốn đổi)

1. **Payment giữ gắn từng đơn CON** (không migrate sang `orderGroupId` như PLAN-0015 §5). Lý do: luồng đang chạy ổn, FE đã xử lý
   "thanh toán lần lượt từng đơn"; migrate Payment là rủi ro lớn, lợi ích chỉ là 1 mã QR thay vì N. PayOS → một payment link / đơn con.
   (Có thể làm "1 link cho cả nhóm" ở plan sau — đã chừa `Payment.transactionCode` + `gatewayResponse` đủ chỗ.)
2. **PayOS chưa có khoá ⇒ phương thức `payos` tự tắt** (`isMethodActive=false`, không hiện ở checkout). Webhook luôn kiểm chữ ký bằng
   checksum key; key trống ⇒ từ chối. Chi trả shop khi chưa có khoá payout: kỳ đối soát vẫn tính + lưu `pending`, kế toán dùng
   `POST /admin/payouts/:id/mark-paid` (từ `pending` CHỈ khi chưa cấu hình PayOS payout — có cấu hình thì đi đường tự động + retry; từ `processing`/`failed` luôn được — quy tắc đầy đủ ở quyết định 12).
3. **Ví COD không có vùng đệm âm** (đúng PLAN-0015 §1): hoa hồng đơn COD hoàn tất trừ vào ví, `balance<=0` ⇒ `Shop.codEnabled=false` trong CÙNG tx.
4. **Escrow** theo hạn đổi trả hiện có của module order (không đặt số ngày mới); **payout âm mang sang kỳ sau** (`carriedDebt`).
5. **Voucher cộng dồn**: tối đa 1 voucher `platform` / OrderGroup + tối đa 1 voucher `shop` / đơn con (PLAN-0014 bước 8, đã chốt).
6. **Đăng ký shop vẫn do admin tạo** (đã xác nhận ở PLAN-0014) — KHÔNG làm form tự đăng ký đợt này. **→ Đảo ngược 2026-10-15:** chủ dự án chọn làm luồng người bán tự đăng ký — xem PLAN-0019.
7. **Báo cáo vendor tính trực tiếp bằng SQL có lọc `shop_id`** (cache Redis ngắn như báo cáo sàn) — KHÔNG đổi bảng `DailySales`.
8. **Ảnh dữ liệu mẫu**: tự sinh (nền gradient + biểu tượng đúng loại hàng, `scripts/seed/tools`), KHÔNG tải ảnh từ bên ngoài.
   Muốn ảnh thật: điền `EF_PEXELS_API_KEY` rồi chạy `npm run seed:images:pexels` (script thay ảnh theo từ khoá của từng SP). **Thực tế (2026-10-04):** `package.json` từng khai lệnh (đã gỡ)
   này nhưng file `scripts/seed/tools/fetch-pexels.ts` KHÔNG có trong repo ⇒ lệnh lỗi cho tới khi bổ sung (xem §12).

### 3b. Quyết định bổ sung trong lúc làm (đã chốt, ghi để người dùng có thể đổi)
9. **Ai chịu chi phí voucher**: voucher SÀN do SÀN chịu — shop vẫn nhận đủ doanh thu (đối soát/hoa hồng tính trên `total + platformDiscount`, đơn COD ghi
   ví ròng = hoa hồng − voucher sàn, âm = cộng ví); voucher SHOP do SHOP chịu (`shopDiscount`, doanh thu shop = số khách trả). Cột mới trên đơn con:
   `shop_discount`, `platform_discount`, `shop_promotion_code/_name` (migration `20261003120000_order_voucher_split`, backfill: đơn cũ có voucher ⇒ voucher sàn).
10. **Phân bổ voucher**: voucher shop → đúng đơn con của shop; voucher sàn → theo tỉ lệ subtotal (freeship: theo phí ship từng gói), dồn phần dư làm tròn vào gói
    cuối có trọng số; mỗi đơn con không giảm quá `subtotal + ship` (shop discount ưu tiên, phần sàn bị cắt); tổng đơn cha = Σ đơn con. Voucher sàn gắn mã đơn CHA
    (lượt dùng nhả khi đơn con CUỐI còn hiệu lực bị huỷ), voucher shop gắn mã đơn CON.
11. **Hoàn tiền trong đối soát chia theo tỉ lệ LUỸ KẾ** trên số khách đã trả T: dòng refund = round(G × Σhoàn / T) − phần đã trừ trước đó (G = doanh thu đã tính cho shop, hoa hồng
    tương tự) ⇒ hoàn đủ ⇒ trừ đúng G và C (voucher sàn cũng được hoàn theo tỉ lệ), không lệch làm tròn. Khoá dòng refund = `RF-` + 26 hex đầu của `refund.id`.
12. **Trạng thái kỳ đối soát**: `pending` (chờ kế toán / chưa có khoá / thiếu TK ngân hàng) · `processing` (đã gửi PayOS, chờ xác nhận — có thể `retry` khi treo > 10 phút) ·
    `paid` · `failed` (retry được) · `carried` (net < 0, không chi, nợ sang kỳ sau) · `settled` (net = 0). `mark-paid`: từ `processing`/`failed` luôn được (đối chiếu PayOS /
    chuyển tay), từ `pending` chỉ khi CHƯA cấu hình khoá payout. Chưa có webhook payout của PayOS ⇒ `processing` do kế toán xác nhận (cần xác nhận công thức `x-signature` payout
    khi có khoá thật — xem ghi chú trong `PayosService.payout`).
13. **Phiên vendor**: `GET /shop/session` (chỉ cần là thành viên active, chạy cả khi shop chưa duyệt/bị khoá) trả shop + vai + MÃ QUYỀN `shop.*` — FE vendor dựng menu/ẩn nút theo đây
    (vai shop không nằm trong `/me` của identity).
14. **Tách module để phá vòng import**: đối soát chuyển sang `PaymentSettlementModule` (cần `OrderQueryApi`; `OrderModule` đã import `PaymentModule`). `PaymentModule` không import `OrderModule`.
15. **PayOS**: orderCode = `Date.now()*1000 + random(1000)` (cách cũ yymmdd+6 số trùng ~50% ở 1.000 đơn/ngày); link hết hạn 30 phút (như VNPay), có `POST /payments/payos/retry/:orderCode`;
    `GET /payments/payos/return?orderCode=` hỏi lại PayOS (server-to-server) rồi settle idempotent như webhook; số tiền PayOS là VND (không nhân 100).
16. **Hoàn tiền đơn COD đã hoàn tất**: sàn chuyển tiền cho khách nhưng shop đang giữ tiền mặt ⇒ ví shop bị ghi NỢ số hoàn và sàn hoàn lại phần hoa hồng tương ứng, một dòng sổ cái loại
    `cod_refund` khoá `RF-<26 hex đầu refund.id>` (migration `20261003160000_wallet_cod_refund_type` sửa CHECK `chk_shop_wallet_tx_type`); listener `PAYMENT_REFUNDED` ghi, idempotent.
17. **Giữ chi trả 24 giờ sau khi shop đổi tài khoản ngân hàng** (chống chiếm phiên đổi TK rồi rút kỳ gần nhất): chi tự động và "chạy lại" đều bị chặn; kỳ bị giữ ở `pending` + `failReason`. Mốc đổi TK lấy từ audit
    `SHOP_BANK_UPDATED` (không có cột riêng); cả retry cũng đọc TK HIỆN TẠI để áp giữ, dù kỳ đã có snapshot. Đổi TK ⇒ outbox `SHOP_BANK_CHANGED` ⇒ system báo mọi thành viên (chỉ 4 số cuối TK).
18. **Hardening vendor**: dữ liệu shop khác ⇒ 404 (không lộ tồn tại); chống mua chéo (thành viên shop không đặt được hàng shop mình ⇒ 409 `ORDER_SHOP_NOT_AVAILABLE`); nhân viên vào shop do chủ shop THÊM TRỰC TIẾP (từ 2026-10-13 — mục 20; luồng lời mời có chấp nhận 2026-10-04 và mã
    `SHOP_MEMBER_NOT_ADDABLE` đã gỡ) + `@RateLimit` 30/giờ; `POST /shop/members/leave`; khoá `FOR UPDATE` các dòng chủ trước khi đếm ⇒ shop không bao giờ về 0 chủ; DTO vendor không lộ
    `userId`/email/`paymentUrl`/mã đơn; `/shop/reviews` chỉ đánh giá `approved`, trả lời hiển thị TÊN SHOP.
19. **Trang gian hàng công khai** (`GET /shops`, `GET /shops/:slug`, `GET /products?shop=`) đặt ở `product/storefront` (không phải module `shop`): cần số sản phẩm/đánh giá đếm sẵn trên `products`, mà `product` đã phụ thuộc
    `shop` nên `shop` không được import ngược. Sản phẩm của shop chưa duyệt/bị khoá bị ẩn ở mọi đường công khai (lọc theo `ShopQueryApi.nonApprovedShopIds` lúc đọc — không qua sự kiện).
20. **Chủ shop THÊM nhân viên TRỰC TIẾP (đổi 2026-10-13; thay luồng lời mời có chấp nhận 2026-10-04 — luồng đó ĐÃ BỎ HẲN: chủ dự án chọn thêm trực tiếp)**. `POST /shop/members` `{email, fullName, password, roleCode: shop_owner|shop_staff}` (quyền `shop.staff.invite` — TÊN CŨ giữ nguyên để khỏi đổi catalog/vai đã gán, mô tả hiển thị
    "Thêm nhân viên vào gian hàng của mình (tạo tài khoản nhân viên)"; chỉ `shop_owner` có; 30 lần/giờ/user). Chủ shop TẠO TÀI KHOẢN mới (vai identity `customer`, active, `email_verified_at` rỗng, `createdBy` = chủ shop; mật khẩu 8–64 ký tự có chữ và số — luật do identity kiểm, 400 `IDENTITY_PASSWORD_WEAK`)
    + một dòng ShopMember `active` trong CÙNG một transaction, qua `IdentityApplicationApi` (cổng GHI công khai mới của identity ở `identity/applicationapi/`: `hashPassword` + `createCustomerAccount(actor, {email, fullName, passwordHash}, tx)`; `.dependency-cruiser.cjs` cho phép `applicationapi/`). Có hiệu lực ngay, nhân viên đăng nhập luôn.
    Trả `AddShopMemberResponse` = `ShopMemberResponse` + `restored`. Lỗi: 409 `IDENTITY_EMAIL_EXISTS` (email đã có tài khoản — một mã chung, kể cả khi thuộc người ở shop khác, để không dò được tài khoản) · 409 `SHOP_MEMBER_LIMIT_REACHED` (trần `SHOP_MEMBER_MAX_ACTIVE = 50` thành viên active/shop, khoá advisory theo shop) ·
    409 `SHOP_MEMBER_UNAVAILABLE` (khôi phục nhân viên cũ không được) · 400 `SHOP_ROLE_INVALID`. **Khôi phục nhân viên cũ**: email đã có tài khoản mà tài khoản TỪNG là thành viên (`removed`) của CHÍNH shop này, còn active + khách thường + không ở shop khác ⇒ kích hoạt lại ShopMember với vai mới, `restored: true`, KHÔNG đổi mật khẩu/hồ sơ
    (chủ shop không bao giờ đặt lại mật khẩu của tài khoản cá nhân). Audit `SHOP_MEMBER_ADDED` (after `{roleCode, restored}`) ở `shop.audit_logs`; `USER_CREATED` (`via: 'shop_staff'`) ở `identity.audit_logs`; outbox `SHOP_MEMBER_JOINED` (chưa listener). Luật "mỗi người một shop active" vẫn có chốt DB `uq_shop_members_one_active_per_user` (migration `20261004090000`, giữ nguyên).
    Migration `20261013090000_drop_shop_invitations` chỉ `DROP TABLE shop.shop_invitations`. Phía SÀN không đổi: `POST /admin/users` (`identity.user.create`, vai nhân viên sàn) + màn web quản trị `/identity/users`. Chi tiết route/mã lỗi: `06_FE_CONTRACT.md` (mục "thêm nhân viên gian hàng").
    *Lịch sử (ĐÃ BỎ 2026-10-13)*: 2026-10-04 từng thay luồng "mời = thêm ngay" bằng lời mời có chấp nhận (bảng `shop_invitations`, `/shop/invitations`, `/me/shop-invitations`, outbox `SHOP_INVITATION_CREATED` → email + thông báo `/account/invitations`, trần 50 lời mời pending, script `identity:backfill-email-verified`). Toàn bộ code/route/sự kiện/mã lỗi đó đã gỡ khỏi BE; `register()` (OTP) vẫn đặt `email_verified_at` (đúng ngữ nghĩa, chỉ là không còn ai dựa vào nó cho lời mời).
20. **SKU duy nhất TRONG shop**: partial unique `uq_product_variants_shop_sku_active (shop_id, sku) WHERE is_deleted = false` (migration `20261003140000_product_variant_sku_per_shop`, thay `unique(sku)` toàn sàn còn sót);
    biến thể `dynamic` cập nhật TẠI CHỖ (giữ id/tồn kho) qua `PUT /shop/products/:id/variants`; sản phẩm chỉ gán vào ngành LÁ; khoá đổi `attributeMode` khi ngành đã có sản phẩm (`CatalogUsageRegistry`).

## 4. Gói việc (WP) — wave, người làm, file sở hữu

Luật chung cho MỌI agent code (đưa nguyên văn vào prompt): `eco_backend/AGENTS.md`; ranh giới module (chỉ import `queryapi` của module khác,
KHÔNG gọi Prisma delegate của schema khác — `src/prisma-boundaries.spec.ts` bắt); mã quyền khớp `^[a-z]+(\.[a-z_]+){2,3}$`; route vendor dùng
`@RequireShopPermission` + `ShopContextGuard` + `@CurrentShop()` (mẫu: `shop-product.controller.ts`), `imports: [ShopModule]` ở module dùng guard;
DTO có `@ApiProperty` (Orval cần); ghi → audit log của module + outbox nếu đổi trạng thái; tiền `Decimal(14,0)`; file dùng chung
(`*.module.ts`, `app.module.ts`, `worker.module.ts`, `foundation/*.constants.ts`) chỉ sửa bằng **Edit** (không Write đè). **Không chạy build/migrate/seed**;
được chạy `npx tsc --noEmit` rồi lọc lỗi theo file của mình và `npx eslint <file mình>`.

### Wave 0 — Nền (Sonnet, XONG)
- [x] Migration `20261003100000_marketplace_completion` (promotion scope/shopId + CHECK, shop bank_*, refunds.shop_id, ví/đối soát 5 bảng, đổi tên index cũ) — đã áp, `migration:check` sạch.
- [x] Catalog quyền + preset vai (`shop_owner = codesOfModules('shop')`, `shop_staff` rộng hơn, `accountant`/`manager` có `supplier.wallet/payout.*`).
- [x] `env.ts` + `.env.example`: `EF_PAYOS_*`, `EF_PAYOS_PAYOUT_*`, `EF_PEXELS_API_KEY` (trống).

### Wave 1 — Backend song song (XONG — agent viết, Sonnet viết lại/sửa phần tiền: B3 voucher, B6 PayOS, B7 ví, B8 đối soát)
| WP | Người | Phạm vi (thư mục sở hữu) | API / hành vi |
|---|---|---|---|
| B1 shop-orders | Haiku | `order/order/controller/shop-order.controller.ts`, `service/shop-order.service.ts` (file MỚI; không sửa `order.service.ts`) | `GET /shop/orders`, `/shop/orders/summary`, `/shop/orders/:code`, `PUT /shop/orders/:code/status`, `POST /shop/orders/:code/cancel` — chỉ đơn có `shopId` của JWT; đơn shop khác ⇒ 404 |
| B2 shop-inventory | Haiku | `product/inventory/controller/shop-inventory.controller.ts`, `product/product/controller/shop-product-image.controller.ts` + service bọc | `GET /shop/inventory/stock`, `/stock/:variantId/movements`, `GET/POST /shop/inventory/receipts`, `/receipts/:id`, `POST /receipts/:id/post`, `POST /shop/inventory/adjust`; ảnh: `POST/PATCH/PUT order/DELETE /shop/products/:id/images` — chỉ biến thể/sản phẩm của shop mình |
| B3 promotion-scope | **Sonnet (tự làm)** | `promotion/**`, `order.service.ts#placeOrder` | `GET/POST/PATCH/DELETE /shop/promotions`; `quote()` có tham số shop + luật cộng dồn §3.5; `/promotions/offers` trả voucher sàn + của các shop trong giỏ |
| B4 shop-reports | Haiku | `reporting/**` (không đổi schema) | `GET /shop/reports/{dashboard,revenue,top-products,low-stock}` — SQL lọc `o.shop_id`, quyền `shop.report.read` |
| B5 shop-notify | Haiku | `system/notification/**` (+ listener worker) | Đơn mới (`ORDER_CREATED`) và `STOCK_LOW` ⇒ thông báo cho mọi ShopMember active; idempotent theo `ProcessedEvent` |
| B6 payos | Haiku | `payment/payos/**`, `payment.service.ts` (nhánh `payos` + refund payos), `payment.module.ts`, `payment.seed.ts` | `PayosService` (tạo link, verify chữ ký webhook, query link, `payout()` + idempotency-key); `POST /payments/payos/webhook`, `GET /payments/payos/return`; method `payos` tắt khi thiếu khoá; `Refund.shopId` snapshot |
| B7 shop-wallet | Haiku | `payment/shop-wallet/**`, gateway `SHOP_COD_GATEWAY` (common) + impl ở `shop` | `GET /shop/wallet`, `POST /shop/wallet/deposit-requests`, `GET /admin/shops/:id/wallet`, `POST /admin/shops/:id/wallet/adjust`, `GET /admin/wallet-deposits`, `POST /admin/wallet-deposits/:id/{approve,reject}` (thực tế là POST, không phải PATCH); listener `ORDER_STATUS_CHANGED→completed` (COD) trừ hoa hồng 1 lần |
| B8 shop-payout | Haiku | `payment/shop-payout/**`, `order/queryapi` (thêm `settlementOrders`) | `POST /admin/payouts/run`, `GET /admin/payouts`, `POST /admin/payouts/:id/{retry,mark-paid}`, `GET /admin/payouts/payos-balance`, `GET /shop/payouts` — escrow + carriedDebt + chạy lại không tạo trùng |
| B9 ai-image-search | Haiku | `ai/**` (file mới) | `POST /ai/image-search` (multipart): vision → từ khoá/ngành → tìm SP; không có `EF_OPENAI_API_KEY` ⇒ trả `{available:false}` |
| B10 shop-profile-bank | Haiku | `shop/shop/**` | `PATCH /shop/me` nhận `bankCode/bankAccountNumber/bankAccountName` (validate); admin xem được; đổi tài khoản ghi audit |

**Xác minh Wave 1 theo mã nguồn (2026-10-04):** cả 10 WP đều có controller + service + test (`*.spec.ts` đã đọc, chưa chạy) — B1 `shop-order.controller.ts`/`shop-order.service.spec.ts` · B2 `shop-inventory.controller.ts`,
`shop-product-image.controller.ts` + spec · B3 `shop-promotion.controller.ts`, `promotion-scope.spec.ts`, `order-voucher.spec.ts` · B4 `shop-reporting.controller.ts` + `shop-reporting*.spec.ts` · B5 `system-worker.module.ts` +
`system-worker.module.spec.ts` · B6 `payos.service.ts`, `payment.service.ts` + `payment-payos.spec.ts`, `payos.service.spec.ts` · B7 `shop-wallet/**` + `shop-wallet.spec.ts`, `payment-worker.spec.ts` · B8 `shop-payout/**` + `shop-payout.spec.ts` ·
B9 `ai/image-search/**` + `image-search.spec.ts` · B10 `shop.service.ts#updateMe` + `bank-info.spec.ts`, `shop-update.spec.ts`.
Làm khác bảng dự kiến ở trên (đã tính vào code, KHÔNG phải thiếu sót):
- B7: duyệt/từ chối nộp quỹ là `POST` (không `PATCH`); thêm `GET /admin/wallets?lowOnly`, `GET /admin/shops/:id/wallet/transactions`, `GET /shop/wallet/transactions`, `GET /shop/wallet/deposit-requests`; sổ cái thêm loại `cod_refund`; ví tạo lúc nghe `SHOP_APPROVED` (và backfill migration).
- B8: chi PayOS gọi LẺ từng khoản `POST /v1/payouts` (không dùng `/v1/payouts/batch` như PLAN-0015 dự kiến); thêm `GET /admin/payouts/:id` và `GET /shop/payouts/:id`; `mark-paid` có (PLAN-0015 bỏ); **chưa có cron** chạy kỳ — chạy tay `POST /admin/payouts/run`.
- B6: `Payment` vẫn gắn đơn CON (quyết định 1); webhook payout của PayOS CHƯA có; hoàn tiền `payos` tự động chỉ khi webhook gốc có tài khoản đối ứng VÀ đã có khoá payout, còn lại kế toán chuyển tay + nhập `providerRef`.
- B3: `PromotionGateway` thêm `scopeOf(code)`; lượt dùng voucher sàn gắn mã đơn CHA, voucher shop gắn mã đơn CON.

### Wave 2 — Tích hợp & kiểm thử (Sonnet, XONG theo nhật ký 2026-10-03: tsc/lint/test/build/boot API+worker sạch) → `verify` GỘP + boot app/worker + smoke test curl theo vai (admin, vendor owner, vendor staff, khách) + chạy `perms:sync` + `api:sync` hai FE.
> Kết quả chạy lệnh ở trên là theo báo cáo lúc đó — đợt rà soát tài liệu 2026-10-04 KHÔNG chạy lại lệnh nào; chạy lại `npm run verify` + `migration:check` + boot trước khi phát hành.

### Wave 3 — Frontend song song (sau khi OpenAPI mới sinh xong) — CHƯA tick ở đây: theo dõi ở `fashion_frontend_admin/docs/plans/PLAN-0002-vendor-portal.md` và `fashion_frontend_user/docs/plans/PLAN-0008-marketplace-storefront-payos.md`
| WP | Repo | Phạm vi |
|---|---|---|
| F-A1 | admin | vendor: đơn hàng + dashboard/báo cáo (`features/shop/**`) |
| F-A2 | admin | vendor: sản phẩm (+ảnh, ma trận biến thể trục động, trường thuộc tính theo category) + kho |
| F-A3 | admin | vendor: khuyến mãi, ví, đối soát, thông báo, hồ sơ + tài khoản ngân hàng |
| F-A4 | admin | sàn: shops, ví/duyệt nộp quỹ, payouts (chạy kỳ/retry/mark-paid), gán mẫu thuộc tính theo category, bỏ cast `PermissionCode`, tắt mock mặc định |
| F-U1 | user | trang chi tiết/quick-view/thẻ/giỏ cho sản phẩm động (options), bỏ chuỗi thời trang cứng |
| F-U2 | user | PayOS ở checkout + trang return, `/account/notifications`, AI tìm bằng ảnh nối API thật |

### Wave 4 — Test + Review
- [x] Test viết xong (đọc `*.spec.ts` 2026-10-04): cách ly dữ liệu chéo shop (đơn/kho/báo cáo/đánh giá/voucher/ví), idempotent webhook PayOS + ví + payout — chi tiết ở §7.
- [ ] Test: `verify` cả 3 repo; boot app+worker; click-through trình duyệt theo 4 vai — chưa chạy lại sau đợt hoàn thiện.
- [~] Review: đã có review code BE theo từng wave (nhật ký §9: PayOS ×100, orderCode trùng, vòng DI, worker thiếu import…) và rà soát hardening vendor (quyết định 18); CHƯA có review FE (permission 3 lớp, mobile 390px).
- [x] Docs (2026-10-04): `06_FE_CONTRACT.md`, `02_MODULE_MAP.md`, `eco_fashion.dbml` (đã đối chiếu từng cột với `prisma/schema/*.prisma` — khớp 98/98 bảng), `03_DATABASE_RULES.md`, `05_SEED_AND_REPRODUCE.md`, README §Trạng thái, tick PLAN-0014/0015/0016/0017.
  Còn lại ngoài phạm vi tài liệu BE: `PLANS.md` (dòng 8 vẫn ghi "một cửa hàng thời trang").

### Track D — Dữ liệu mẫu + ảnh (song song với Wave 1–3)
| WP | Người | Việc |
|---|---|---|
| D0 | Sonnet | [x] DSL `scripts/seed/data/types.ts`, seeder tổng quát `marketplace.seed.ts`, bộ sinh ảnh `tools/` (`export-image-manifest.ts` + `gen_images.py`), shop + chủ shop (`data/shops.ts`), chuyển 16 SP cũ sang DSL (đã xoá `dynamic-attribute.seed.ts`/`marketplace-product.seed.ts`) |
| D1–D4 | Haiku ×4 | [x] Mỗi agent 3 ngành hàng: `data/dept/<ngành>.ts` (category + thuộc tính + SP có biến thể/ảnh/số bán) — 12 file |
| D5 | Haiku | [x] Hoạt động: `activity.seed.ts` (40 khách + ~320 đơn con/~270 nhóm), `settlement.seed.ts` (ví + đối soát), `promotion-marketplace.seed.ts`, `review-marketplace.seed.ts`, `content-marketplace.seed.ts` (banner/FAQ/tri thức AI cho ngành mới) |

Mục tiêu số liệu: **12 ngành hàng gốc (~35 ngành lá), ≥ 250 sản phẩm, ≥ 10 gian hàng (có shop chờ duyệt/bị khoá để demo), ≥ 600 ảnh, ≥ 40 khách, ≥ 150 đơn, ≥ 500 đánh giá, ≥ 15 voucher**.
Đạt theo mã/DSL (đếm ở repo, chưa chạy seed): 12 ngành gốc dynamic (+ nhóm thời trang 7 ngành `legacy_fashion`) · **48 ngành lá** · **343 sản phẩm** mới (+24 thời trang) · **18 gian hàng** (1 `pending`, 1 `suspended`) ·
**~930 file ảnh** trong `scripts/seed/assets` · **45 khách** (`khach1..45`) · **~320 đơn con lịch sử** (+14 `DHDEMO*`) · voucher: 5 cũ + 16 voucher sàn + 2–3 mã/shop đã duyệt (≥ 15).
Số đánh giá thực tế (mục tiêu ≥ 500) CHƯA xác nhận bằng số liệu sau khi chạy seed — `review-marketplace.seed.ts` sinh theo ~50% dòng đơn `completed` + ~20% `delivered`, xem log bước `review-marketplace`.

## 5. Dữ liệu mẫu — quy ước

- Mọi seed **idempotent theo slug/code** (chạy lại không trùng, không ghi đè phần đã sửa tay), tồn kho qua phiếu nhập `PN-SEED-*` đã duyệt có sổ kho.
- Ảnh: sản phẩm thời trang gốc `scripts/seed/assets/product/<slug>/{main,hover,mau-*}.jpg` (Pexels); sản phẩm các ngành mới `assets/product/<slug>/{a,b}.jpg` (tự sinh bởi `tools/gen_images.py`),
  logo/banner shop `assets/shop/<slug>/{logo,banner}.jpg`, bìa ngành `assets/catalog/categories/`, bìa bộ sưu tập `assets/catalog/collections/`, banner `assets/banners/` (~930 file, commit cùng repo).
  Cloudinary: `SeedImages` có manifest cache `assets/.cloudinary-manifest.json` để chạy lại không gọi lại Admin API (giới hạn 500 lệnh/giờ).
- Ngành hàng gốc mới (mode `dynamic`): Máy tính & Thiết bị điện tử · Giày dép & Túi xách · Đồng hồ & Phụ kiện · Thể thao & Dã ngoại · Mẹ & Bé ·
  Sách & Văn phòng phẩm · Thực phẩm & Đồ uống · Thú cưng · Ô tô & Xe máy (+ mở rộng 3 ngành đã có: Điện thoại, Nhà cửa, Sắc đẹp).
- Tối đa 2 trục biến thể / sản phẩm (đã chốt PLAN-0016).

## 6. KHOÁ / CẤU HÌNH để người dùng tự điền (tất cả đang TRỐNG — thiếu thì tính năng tương ứng tự lùi về đường không-khoá)

| Biến | Ở đâu | Để làm gì | Khi trống |
|---|---|---|---|
| `EF_PAYOS_CLIENT_ID` / `EF_PAYOS_API_KEY` / `EF_PAYOS_CHECKSUM_KEY` | BE `.env` | Thu tiền QR/chuyển khoản tự động (PayOS) | Phương thức `payos` tắt, webhook từ chối |
| `EF_PAYOS_PAYOUT_CLIENT_ID` / `_API_KEY` / `_CHECKSUM_KEY` | BE `.env` | Chi trả shop + hoàn tiền tự động (khoá "Lệnh chi" — cặp khác ở trên) | Kỳ đối soát `pending`, kế toán đánh dấu đã trả tay |
| `EF_VNPAY_TMN_CODE` / `EF_VNPAY_HASH_SECRET` | BE `.env` | Thanh toán thẻ VNPay | VNPay tắt (như cũ) |
| `EF_OPENAI_API_KEY` | BE `.env` | Chatbot, FAQ, tóm tắt đánh giá, AI tìm bằng ảnh, insight | Mọi AI lùi về luật không-AI |
| `EF_REPLICATE_API_TOKEN` | BE `.env` | Thử đồ 2D (route cũ, đã ẩn khỏi menu) | Tính năng tắt |
| `EF_CLOUDINARY_*` | BE `.env` | Lưu ảnh upload + ảnh seed | Dùng `/static/seed` cục bộ |
| `EF_GOOGLE_CLIENT_ID` + `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (FE user) | BE + FE | Đăng nhập Google | Nút Google ẩn/lỗi nhẹ |
| `EF_MAIL_*` | BE `.env` | Gửi OTP/email đơn hàng | Dev dùng mailpit |
| `EF_PEXELS_API_KEY` | BE `.env` (chỉ seed) | Thay ảnh minh hoạ bằng ảnh thật | Giữ ảnh tự sinh |
| `NEXT_PUBLIC_API_URL` (FE user) / `NEXT_PUBLIC_ENABLE_MOCK` (FE admin) | FE `.env.local` | Nối backend thật (trống/true = mock) | Chạy mock |

## 7. Kiểm thử (Definition of Done từng đợt)
* [ ] `npm run verify` (lint+boundaries+build+test) xanh BE; `npm run migration:check` xanh.
* [ ] Boot `node dist/src/main.js` + worker không lỗi DI (bài học PLAN-0014: build xanh ≠ DI đúng).
* Test mới — đã VIẾT (đọc `*.spec.ts` 2026-10-04; kết quả chạy chưa xác nhận lại):
  * [x] cách ly dữ liệu chéo shop cho đơn (`shop-order.service.spec.ts`: đơn shop khác ⇒ NotFound), kho (`shop-inventory.service.spec.ts`: biến thể/phiếu shop khác ⇒ 404), báo cáo (`shop-reporting-isolation.spec.ts`),
        đánh giá (`review.spec.ts`: `listShop` khoá `status=approved` + `shopId`), voucher (`promotion-scope.spec.ts`: mã shop không áp cho giỏ shop khác), sản phẩm (`product.service.spec.ts`), guard (`shop-context.guard.spec.ts`).
  * [ ] cách ly ví/đối soát của vendor: controller lấy `shopId` từ `@CurrentShop()` nhưng CHƯA có test riêng "vendor A đọc kỳ/ví của shop B ⇒ 404" ở tầng service/controller (chỉ có test nợ/hoàn tiền không lẫn giữa các shop).
  * [x] webhook PayOS gọi 2 lần chỉ ghi nhận 1 lần, chữ ký sai ⇒ 401, số tiền lệch ⇒ không `paid` (`payment-payos.spec.ts`, `payos.service.spec.ts`).
  * [x] ví: hoa hồng COD ghi đúng 1 lần dù sự kiện lặp, `balance ≤ 0` ⇒ khoá COD ngay, nộp quỹ/điều chỉnh làm `> 0` ⇒ mở lại, race khoá ví (`shop-wallet.spec.ts`, `payment-worker.spec.ts`).
  * [x] payout: chạy lại cùng kỳ không trùng + hai lần chạy đồng thời chỉ một lệnh chi, escrow, `net < 0` ⇒ `carried` không gọi PayOS và mang nợ sang kỳ sau, hoàn tiền chia tỉ lệ luỹ kế, giữ chi trả 24 giờ (`shop-payout.spec.ts`).
  * [x] voucher: tối đa 1 sàn + 1 shop/đơn con, phân bổ theo tỉ lệ + dồn dư làm tròn, tổng đơn con = tổng nhóm (`order-voucher.spec.ts`, `promotion-scope.spec.ts`).
  * [ ] `placeOrder` nhánh "shop không `approved`" (409 `ORDER_SHOP_NOT_AVAILABLE`) và "COD khi shop tắt COD" (409 `ORDER_SHOP_COD_DISABLED`) CHƯA có test (chỉ có nhánh chống mua chéo).
* [ ] `npm run verify` FE admin + FE user xanh; click-through thật với ≥ 4 vai (admin, kế toán, chủ shop, nhân viên shop, khách) — chưa làm.
* [~] Dữ liệu mẫu đạt mục tiêu §4 Track D (đạt theo mã/DSL — số liệu ở §4); `npm run seed` hai lần liên tiếp không tạo trùng: thiết kế idempotent theo khoá tự nhiên (đã đọc mã từng bước), CHƯA xác nhận bằng chạy thật trong đợt rà soát tài liệu.

## 8. Rủi ro / Ghi chú
* Nhiều agent cùng sửa `payment.module.ts`/`order.module.ts`: chỉ dùng **Edit**; Wave 2 gộp rồi kiểm lại.
* Haiku từng báo "0 lỗi" nhưng `verify` gộp bắt 2 lỗi thật ⇒ **bắt buộc** chạy lại trên trạng thái gộp.
* Redis cache (danh mục/sản phẩm/bộ sưu tập) giữ dữ liệu cũ sau seed ghi thẳng DB ⇒ sau mỗi lần seed chạy `redis DEL ef:*` (cổng 6381).
* Chi trả PayOS trừ vào "tài khoản chi" riêng — phải nạp tiền ngoài hệ thống (chỉ-đọc `GET /admin/payouts/payos-balance` để biết số dư).

## 9. Nhật ký tiến độ
| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| 2026-10-03 | Khảo sát 4 agent + kiểm chứng; Wave 0 xong | Báo cáo agent mâu thuẫn nhau ⇒ kiểm chứng bằng grep; phát hiện preset `shop_owner` thiếu quyền sản phẩm (đã sửa) |
| 2026-10-03 | Wave 1+2 BE | 64 lỗi tsc gộp → sửa; viết lại ví/đối soát/PayOS/voucher; test agent lộ 4 bug thật (CHECK DB chặn `carried`/`settled`; refund + voucher sàn; làm tròn hoàn tiền; race nộp quỹ) → đã sửa + migration `20261003130000`; review code tìm thêm: PayOS so tiền ×100 (không bao giờ settle), orderCode trùng, không có route return, vòng DI Payment↔Order, worker thiếu import (boot worker mới bắt được) |
| 2026-10-03 | Track D + hardening + migration bổ sung | Seed 18 shop / 12 ngành gốc / 48 ngành lá / 343 sản phẩm / ~930 ảnh minh hoạ tự sinh / ~320 đơn lịch sử / voucher / ví + đối soát mẫu (15 bước `scripts/seed/index.ts`). Rà soát hardening vendor (cách ly chéo shop, chống mua chéo, DTO vendor, mời nhân viên, `leave`, chủ cuối cùng). Migration mới: `20261003110000_stock_receipt_shop_id`, `20261003120000_order_voucher_split`, `20261003130000_payout_status_carried_settled`, `20261003140000_product_variant_sku_per_shop`, `20261003160000_wallet_cod_refund_type` |
| 2026-10-04 | Rà soát tài liệu theo mã nguồn (không chạy lệnh nào) | Đối chiếu `02_MODULE_MAP`, DBML (98/98 bảng khớp Prisma), `03_DATABASE_RULES`, `06_FE_CONTRACT` (route/quyền khớp controller), README, `05_SEED_AND_REPRODUCE` với mã. Ghi "Việc còn lại / giới hạn đã biết" ở §12; phát hiện: script `seed:images:pexels` trỏ file không tồn tại, `REVIEW_RATING_CHANGED` không ai phát, test thiếu cho `placeOrder` nhánh shop khoá/COD tắt |
| 2026-10-04 | Mời nhân viên có chấp nhận + unique một phần `shop_members` — **luồng lời mời ĐÃ BỎ 2026-10-13 (dòng cuối bảng)** | Migration `20261004090000_shop_invitations` (áp lên dev DB, `migrate diff` không lệch); module `shop/invitation/**` (đã gỡ); listener email (shop-worker) + thông báo (system-worker) (đã gỡ); `register()` đặt `email_verified_at` (còn); test + docs (`02`/`03`/`06`/DBML). Phần còn hiệu lực: unique `uq_shop_members_one_active_per_user`. Chi tiết ở mục 18/20 + §12 |
| 2026-10-04 | Gia cố đường tiền + hoàn thiện phần còn lại (§12) | Migration `20261004100000_review_reply_author_kind`, `20261004120000_payment_refund_hardening` (áp dev DB, `migrate diff` không lệch). Hoàn thanh toán TRÙNG không còn đổi `payment_status` của đơn (`refunds.kind`); refund kẹt `processing` có đường phục hồi (`retry-finalize`, job `recoverStuckRefunds`, đối chiếu VNPay); job bù hoa hồng COD quét phân trang; tên người trả lời đánh giá trung tính (`author_kind`); trần 50 lời mời `pending`/shop (đã bỏ 2026-10-13 cùng luồng lời mời); tìm ảnh theo ngành + loại SP; `REVIEW_RATING_CHANGED` được phát; xoá cache khi shop đổi trạng thái; mọi đường ĐỌC của khách (AI, wishlist…) ẩn hàng shop chưa duyệt/bị khoá; báo cáo không cộng hoàn trùng; script backfill `email_verified_at` (đã gỡ 2026-10-13); CI ở cả 3 repo; FE: web khách nối API thật + lời mời (đã gỡ 2026-10-13) + thông báo, web quản trị nối `api:sync` mới |
| 2026-10-13 | **Bỏ luồng lời mời nhân viên — chủ shop THÊM nhân viên trực tiếp** (chủ dự án đổi quyết định) | Migration MỚI `20261013090000_drop_shop_invitations` (chỉ `DROP TABLE shop.shop_invitations`; GIỮ `uq_shop_members_one_active_per_user`); `IdentityApplicationApi` (`identity/applicationapi/`: `hashPassword` + `createCustomerAccount`); `ShopMemberService.add` (`POST /shop/members` `{email, fullName, password, roleCode}` → `AddShopMemberResponse`, trần 50 thành viên active/shop, rate-limit 30/giờ, **khôi phục nhân viên cũ** của chính shop, audit `SHOP_MEMBER_ADDED`/`USER_CREATED via shop_staff`, outbox `SHOP_MEMBER_JOINED`); GỠ `shop/invitation/**`, `ShopInvitationMailListener`, `onShopInvitationCreated` (system-worker), `ShopQueryApi.findInvitationNotice`, sự kiện `SHOP_INVITATION_CREATED`, mã lỗi `SHOP_INVITATION_*`/`SHOP_MEMBER_EXISTS`/`SHOP_ALREADY_IN_SHOP`, hằng `SHOP_INVITATION_*`, script `identity:backfill-email-verified`; FE hai web đã gỡ/đổi (grep `src/` hai repo FE: không còn mã `invitation`/màn lời mời; web quản trị có `features/shop/components/vendor/add-member-dialog.tsx` để chủ shop thêm nhân viên). Docs (`AGENTS`/`README`/`02`/`03`/`06`/`07`/DBML/`shop-modules-database-design`/`identity-database-design`/PLAN-0014) cập nhật theo mã nguồn, không chạy lệnh nào |

## 10. File đã đổi
```text
prisma/schema/{promotion,shop,payment,order,product}.prisma · prisma/migrations/2026100310*/ 2026100311*/ 2026100312*/ 2026100313*/ 2026100314*/ 2026100316*
src/modules/identity/permission/catalog.ts · src/config/env.ts · .env.example
src/modules/{payment,promotion,order,shop,system,product,reporting,ai,catalog,review}/** · src/common/gateway/*.ts (+ shop-cod.gateway.ts)
scripts/seed/** (DSL data/ + 15 bước, tools/ sinh ảnh, assets ~930 ảnh)
docs/{00,01,02,03,04,05,06,07}_*.md · docs/database/* · README.md · AGENTS.md
-- 2026-10-13 (bỏ lời mời nhân viên → chủ shop thêm trực tiếp):
prisma/migrations/20261013090000_drop_shop_invitations/ · prisma/schema/shop.prisma (bỏ model ShopInvitation)
src/modules/identity/applicationapi/identity.applicationapi.ts (MỚI) · src/modules/shop/member/** (service `add`, request/dto `AddShopMember*`) · src/modules/shop/{foundation,enums,queryapi,shop-worker.module.ts} · src/modules/system/system-worker.module.ts
GỠ: src/modules/shop/invitation/** · scripts identity:backfill-email-verified (+spec) · docs/{02,03,06,07}_*.md · docs/database/{eco_fashion.dbml,shop-modules-database-design.md,identity-database-design.md} · AGENTS.md · README.md
```

## 11. Việc tiếp theo
* [x] Wave 0–2 BE, Track D dữ liệu mẫu — xong.
* [ ] Wave 3 FE (hai repo FE) → Wave 4: chạy lại `verify`/`migration:check`/boot app+worker, click-through ≥ 4 vai, review FE.
* [ ] Xử lý các mục ở §12 theo mức ưu tiên (trước hết: xác nhận `x-signature` PayOS payout, `REVIEW_RATING_CHANGED`, `seed:images:pexels`).
* [x] Thêm nhân viên trực tiếp (2026-10-13) trên DB dev: migration `20261013090000_drop_shop_invitations` đã áp, `perms:sync` đã chạy, `migrate diff` không lệch, đã thử đầu-cuối `POST /shop/members` (API + giao diện web quản trị, kể cả nhánh khôi phục nhân viên cũ). CÒN: áp migration `20261013090000_drop_shop_invitations` lên mọi DB dùng chung (`prisma migrate deploy`), chạy `perms:sync` (đổi mô tả quyền `shop.staff.invite`), `npm run migration:check`; thử đầu-cuối `POST /shop/members` trên backend thật với chủ shop → nhân viên đăng nhập (kể cả nhánh khôi phục nhân viên cũ). Việc còn lại của luồng này: xem §12 › Shop / vendor.

## 12. Việc còn lại / giới hạn đã biết (rà soát mã nguồn 2026-10-04)

Không phải lỗi chặn phát hành trong môi trường dev, nhưng cần biết/xử lý trước khi chạy với tiền và dữ liệu thật. Mỗi mục kèm nơi trong mã.

**Tiền / thanh toán**
* **PayOS "Lệnh chi" (payout) — chữ ký `x-signature` CHƯA xác nhận với tài liệu PayOS.** `PayosService.payout()` (`src/modules/payment/payos/payos.service.ts`) hiện CHỈ gửi `x-client-id`/`x-api-key`/`x-idempotency-key`; dòng
  `x-signature` đang là TODO (có chú thích "CHƯA xác nhận công thức"). Chưa có webhook payout nên kỳ chi thành công ở `processing` và do kế toán `mark-paid`. **Phải thử sandbox/khoá thật MỘT kỳ nhỏ** (và xác nhận công thức ký, quyền
  "Chi hộ" của merchant, nạp tiền tài khoản chi) trước khi bật chi tự động hàng loạt. Cùng giới hạn áp cho hoàn tiền `payos` tự động (`processRefund`).
* **Chạy kỳ đối soát là thao tác tay** (`POST /admin/payouts/run`) — chưa có cron/lịch; chu kỳ vận hành thật chưa chốt.
* ~~**Hoàn tiền thanh toán trùng** làm sai `orders.payment_status`~~ — **ĐÃ SỬA 2026-10-04**: `refunds.kind` (`order` | `duplicate_payment`). Khoản trùng vẫn cập nhật payment trùng + giao dịch + audit nhưng KHÔNG gọi `OrderService.onRefunded`/`markReturnRefunded`, KHÔNG phát `PAYMENT_REFUNDED` (không đảo hoa hồng) ⇒ đơn vẫn `paid`; `requestRefund` bỏ qua khoản trùng đang chờ hoàn (trước đây chọn nhầm ⇒ `REFUND_EXCEEDS` chặn huỷ đơn); báo cáo doanh thu (`reporting`/`shop-reporting`) chỉ cộng hoàn `kind = 'order'`. Hệ quả chấp nhận: khách không còn nhận thông báo "đã hoàn tiền" cho khoản trùng (cần event/listener riêng ở module system nếu muốn).
* ~~**`processRefund` finalize lỗi để refund kẹt `processing`**~~ — **ĐÃ SỬA 2026-10-04**: cổng báo OK ⇒ ghi `providerRef` ngay (CAS) TRƯỚC khi ghi sổ; ghi sổ (`finalizeRefund`) khoá payment + CAS `processing → done` (idempotent). Phục hồi KHÔNG gọi lại cổng: `processRefund` trên refund `processing` quá 10 phút, `POST /admin/refunds/:id/retry-finalize`, job `recoverStuckRefunds` (5 phút). VNPay không có idempotency-key ⇒ cột `gateway_attempted_at` ghi trước khi gọi; mất kết nối/timeout ⇒ `failed` + `needsReconcile`, KHÔNG cho gọi lại mù — người xử lý đối chiếu trên cổng: đã hoàn ⇒ nhập `providerRef` (chỉ ghi sổ), chưa hoàn ⇒ `confirmGatewayNotRefunded: true` (gọi lại; mã lỗi `PAYMENT_REFUND_RECONCILE_REQUIRED` 409 nếu thiếu). PayOS gọi lại với cùng idempotency-key (= `refund.id`) — **chưa kiểm chứng sandbox** việc PayOS thực sự tôn trọng key này. Chưa chạy refund thật trên DB (chỉ DB giả + smoke cú pháp).
* ~~**Job bù hoa hồng COD chỉ quét 1000 đơn cũ nhất**~~ — **ĐÃ SỬA 2026-10-04**: `OrderQueryApi.completedCodOrderCodesSince(days, limit, cursor?)` trả `{ codes, next }`, con trỏ `(completedAt, code)` mới → cũ; job quét tối đa 20 lô × 1000/lượt, log cảnh báo khi chạm trần, vẫn per-order try/catch + không chạy chồng.
* **Freeship khi phí ship = 0** vẫn tiêu một lượt dùng của voucher; **voucher sàn theo ngành phân bổ theo tạm tính của nhóm** (không theo từng dòng thuộc ngành) — cả hai là hành vi đã chấp nhận, chưa có quyết định đổi.
* **Ví COD mẫu âm có chủ ý**: đúng một shop approved (shop có hoa hồng COD nặng nhất, bỏ FITLY Official; theo ghi nhận khi chạy seed là Nhà Xinh Decor) có ví ≤ 0 ⇒ COD bị khoá để demo màn nộp quỹ — không phải lỗi.

**Shop / vendor**
* ~~**Mời nhân viên shop KHÔNG có luồng chấp nhận**~~ — làm 2026-10-04 (lời mời có chấp nhận) rồi **ĐỔI 2026-10-13: luồng lời mời ĐÃ BỎ HẲN**, thay bằng chủ shop THÊM nhân viên trực tiếp (xem mục 20 + nhật ký §9): `POST /shop/members` `{email, fullName, password, roleCode}` tạo tài khoản khách + ShopMember trong một transaction (`IdentityApplicationApi`), có hiệu lực ngay, khôi phục được nhân viên cũ của chính shop, trần 50 thành viên active/shop; không còn dò được tài khoản (mọi email đã có tài khoản ⇒ cùng 409 `IDENTITY_EMAIL_EXISTS`) và không ai bị kéo vào shop khi chưa đồng ý (chỉ tài khoản MỚI hoặc nhân viên cũ của chính shop này).
* ~~**Chưa có unique index một phần `(user_id) WHERE status = 'active'` cho `shop.shop_members`**~~ — **ĐÃ LÀM 2026-10-04** và **vẫn hiệu lực**: migration `20261004090000_shop_invitations` thêm `uq_shop_members_one_active_per_user` (DB chặn gốc; giữ nguyên khi bảng lời mời bị bỏ ở `20261013090000`). Vi phạm unique (đua với shop khác lúc khôi phục nhân viên cũ) quy về 409 `SHOP_MEMBER_UNAVAILABLE` (mã `SHOP_ALREADY_IN_SHOP` cũ đã gỡ).
* **Luồng lời mời — KHÔNG còn hiệu lực (ĐÃ BỎ 2026-10-13)**: các mục "FE `/account/invitations` + tab Lời mời", "trần `SHOP_INVITATION_MAX_PENDING = 50` lời mời pending", "script backfill `identity:backfill-email-verified`" (kèm việc chủ dự án chạy `--confirm`), "email lời mời CHƯA từng đi qua SMTP thật" đều không còn vì tính năng đã gỡ. `EF_STOREFRONT_URL` hiện không module nào dùng (xem `07_KEYS_CHECKLIST.md`).
* **Còn lại của luồng thêm nhân viên trực tiếp (2026-10-13)**:
  * Nhân viên do chủ shop tạo có `email_verified_at` RỖNG (người tạo chỉ gõ địa chỉ, không chứng minh được chủ địa chỉ) — nhân viên (hoặc chủ thật của email nếu chủ shop gõ nhầm) chiếm lại tài khoản bằng "quên mật khẩu" (OTP về email).
  * Khách KHÔNG được thông báo khi bị thêm vào shop (không email, không thông báo trong-app); nhân viên cũ được khôi phục cũng không được báo — chủ shop tự báo.
  * Mật khẩu ban đầu do chủ shop đặt và gửi tay cho nhân viên; BE chưa cưỡng bức đổi mật khẩu lần đầu (FE chỉ nhắc).
  * Mã quyền `shop.staff.invite` giữ tên cũ ("invite") dù nghĩa là "thêm nhân viên" — chấp nhận để khỏi đổi catalog/vai đã gán; đổi tên là migration quyền riêng nếu muốn.
  * `IdentityQueryApi.UserBrief.emailVerified` không còn nơi dùng cho shop (có thể dọn ở plan sau); `SHOP_MEMBER_JOINED` chưa có listener.
* ~~**`Shop.ratingAvg` không tính lại khi đánh giá đổi**~~ — **ĐÃ SỬA 2026-10-04**: `ReviewService.syncStats` phát `REVIEW_RATING_CHANGED` qua outbox (aggregateType `product`); shop worker tính lại `ratingAvg`.
* ~~**DTO còn thiếu cho FE**~~ — **ĐÃ SỬA 2026-10-04**: `AdminShopSummaryResponse`/`AdminShopResponse` trả `ownerName`/`ownerEmail` (FE bỏ tra `/admin/users/:id` từng dòng — kế toán không có quyền đó); `ShopPayoutResponse` có `shopName` + `updatedAt`; `GET/POST/PATCH /admin/promotions` đều kèm `shopName`.

**Catalog / sản phẩm / đánh giá**
* ~~**`CategoryAttributeTemplateItem` chưa có `inputType`**~~ — đã có (`CatalogQueryApi.getCategoryAttributeTemplate` trả `inputType`, có test).
* ~~**Cache công khai trễ khi shop bị khoá/duyệt**~~ — **ĐÃ SỬA 2026-10-04**: `ProductShopStatusListeners` xoá cache danh sách/chi tiết/liên quan/bộ lọc khi nhận `SHOP_APPROVED|SUSPENDED|REJECTED` (độ trễ = chu kỳ relay outbox ~3s). Chi tiết/`related`/bộ lọc/gợi ý đều ẩn hàng của shop không `approved`; `related` của sản phẩm thuộc shop bị khoá ⇒ 404 như chi tiết.
* ~~**Mọi đường ĐỌC của khách lộ hàng shop bị khoá**~~ — **ĐÃ SỬA 2026-10-04**: `ProductQueryApi.cardsByIds/searchCards/recommend/garmentForTryOn/detailForAi` (chatbot, gợi ý, phân tích phong cách, tìm ảnh, thử đồ, wishlist, "đánh giá của tôi") loại shop chưa duyệt/bị khoá; `detailForAi(…, anyStatus=true)` (nhân viên sàn) không lọc. Snapshot biến thể cho giỏ/đơn KHÔNG lọc (đơn cũ vẫn phải đọc được).
* ~~**Trả lời đánh giá lộ họ tên nhân viên**~~ — **ĐÃ SỬA 2026-10-04**: `review.review_replies.author_kind` (`shop` | `platform`); API công khai/`reviews/me`/admin TÍNH tên lúc đọc (shop ⇒ tên shop hiện tại, platform ⇒ "Sàn FITLY"), không bao giờ đọc `staff_name` lưu sẵn. Cột `staff_name` cũ vẫn giữ họ tên (chỉ không còn ra API) — muốn xoá hẳn cần migration dữ liệu riêng.
* **`placeOrder`** chặn CẢ lần checkout (409) khi một shop trong giỏ không còn `approved` hoặc tắt COD (thay vì loại riêng dòng của shop đó như thiết kế PLAN-0014) — nay đã có test mô tả đúng hành vi hiện tại (thông điệp chỉ nêu tên shop; shop không còn tồn tại ⇒ thông điệp rơi về UUID). **Cần chủ dự án quyết định** có đổi sang "loại dòng của shop đó" hay không.
* **Tìm sản phẩm bằng ảnh (AI)** — **ĐÃ SỬA 2026-10-04**: vision chọn ngành từ danh sách ngành thật, `keywords` chỉ là loại sản phẩm (màu/chất liệu tách sang `attributes`), ngưỡng `keywordCoversName`, `rankRelevant` thay `mergeAndRank`, không bao giờ đệm cho đủ 12. Không dùng vector (đo `text-embedding-3-small` tiếng Việt: khoảng cách đúng/sai chồng lấn). `CatalogQueryApi.CategoryBrief` vẫn thiếu `parentId`/`productCount` nên AI không biết ngành nào là ngành nhóm (đang bỏ phạm vi ngành khi ngành đó không có sản phẩm).
* **Gợi ý kiến trúc chưa làm**: `ShopWalletRepository.listDeposits` coi `shopId` falsy là "tất cả shop" — vendor an toàn nhờ controller luôn truyền `shopId` từ ngữ cảnh (có test `vendor-isolation.spec.ts`), nhưng nên bắt buộc tham số ở tầng repository.

**Dữ liệu mẫu / công cụ**
* **Thay ảnh bằng Pexels**: chưa có script (`fetch-pexels.ts` không tồn tại; lệnh `seed:images:pexels` đã gỡ khỏi `package.json` 2026-10-04); ảnh minh hoạ tự sinh vẫn đủ dùng.
* Seed ghi thẳng DB ⇒ cache Redis có thể cũ sau seed (xoá `ef:*` để thấy ngay); `seed` chưa hỗ trợ cờ `--no-demo` (chỉ có `--force`).
* CI: đã thêm `.github/workflows/ci.yml` (2026-10-04) ở cả 3 repo (BE: verify + migration trên DB trống; 2 FE: lint/typecheck/build). Đẩy workflow lên GitHub cần token có quyền `workflow` (repo FE admin từng gỡ workflow vì PAT thiếu quyền này). Chưa có test e2e (`test/` chỉ có cấu hình).

**Frontend (theo dõi ở plan FE)**: đã nối API thật (2026-10-04) — web quản trị: vendor portal, màn sàn (shops/ví/payouts), thuộc tính động, màn hoàn tiền (loại hoàn, "Ghi sổ lại", đối chiếu VNPay); web khách: catalog/giỏ/checkout/đơn/đổi trả, PayOS return, `/shops`, `/shop/[slug]`, `/account/notifications` (chuông) (`/account/invitations` đã gỡ 2026-10-13 cùng luồng lời mời). Còn lại: thử đầu-cuối PayOS/VNPay thật khi có khoá; BE bỏ qua tham số `type` của `GET /notifications` nên FE lọc loại ở client (100 mới nhất); thông báo của nhân viên (`inventory`, link `/vendor|/admin`) hiện ở web khách như thông báo thường, không dẫn đi.
