# 02 — Bản đồ module (as-built)

Cập nhật sau mỗi plan. Cột "Đọc chéo" = queryapi module khác mà module này gọi; "Gateway cài" = interface ở
`common/gateway` do module này cài đặt.

Từ PLAN-0014/0015/0016/0017/0018 hệ thống là **sàn đa gian hàng, đa ngành hàng** (không còn "một cửa hàng"): có thêm module
**shop** (§12), đơn cha `OrderGroup` + đơn con theo shop (§6), voucher sàn + voucher shop (§5), PayOS + COD (sàn thu mọi khoản tiền, PLAN-0018) + đối soát
chi trả shop tự động (§7), ngành hàng có bộ thuộc tính riêng (§2/§3). Ranh giới import do `.dependency-cruiser.cjs` gác: module chỉ
được import `queryapi/` (đọc), `applicationapi/` (use case GHI công khai, hiếm — hiện chỉ `identity/applicationapi`), `enums/`, `security/` (guard dùng chung của `/shop/**`) và file `*.module.ts` của module khác; mọi thứ khác là ruột.
Danh sách sự kiện outbox + ai nghe nằm ở §13.

## 0. common ✅ PLAN-0001

```text
common
├── response/       ApiResponse · ApiError · PageResponse
├── exception/      BusinessException (+ NotFound/Conflict/Forbidden/Unauthorized/ServiceUnavailable) · GlobalExceptionFilter
├── request/        RequestTraceContext (AsyncLocalStorage requestId/ip/ua) · RequestTraceMiddleware (X-Request-Id, X-Forwarded-For theo số proxy)
├── security/       AuthenticatedActor · @CurrentActor/@Public/@OptionalAuth/@RequirePermission · JwtAuthGuard · PermissionGuard · RateLimitGuard (@RateLimit, Redis)
│                   PermissionAuthorizationGateway + TokenValidationGateway (identity cài)
├── gateway/        UserDirectoryGateway (findSnapshot[s]/staffUserIdsWithPermission) · NotificationGateway · InventoryGateway (availableOf/reserve/release/commit/restock) · ProductStatsGateway · CategoryStatsGateway · CartGateway (removeLines/addItem)
│                   PromotionGateway (scopeOf/quote/consume/release — voucher sàn gắn mã đơn CHA, voucher shop gắn mã đơn CON) · PaymentGateway (initiate/cancel/markCodCollected/requestRefund{shopId,paymentId?}/isMethodActive)
│                   OrderPaymentGateway (onPaid/onPaymentFailed/onRefunded{fullyRefunded}/canRetryPayment/markReturnRefunded) · OrderActionsGateway (cancelByCustomer — ai sau khi khách xác nhận)
├── prisma/         PrismaService (PrismaClient + adapter pg, global) · Tx = Prisma.TransactionClient · isPrismaError/prismaErrorTarget
├── audit/          writeAuditLog(delegate, moduleCode, actor, entry) + sanitizeSummary (che password/token/secret/otp/hash)
├── outbox/         writeOutboxEvent(delegate, input) · OutboxRelay (claim FOR UPDATE SKIP LOCKED, backoff mũ, MAX_RETRY 8, hồi phục PROCESSING kẹt >10')
├── idempotency/    IdempotencyService.begin/complete (bảng của module) · hashRequest
├── cache/          CacheService (cache-aside, jitter, single-flight nhẹ, delByPrefix)
├── redis/ queue/ mail/ storage/ logger/   ioredis · BullMQ (default/mail/ai) · MailService (+MailProcessor ở worker) · Cloudinary · pino
├── response/       + MoneyResponse `{amount,display,currency,symbol}` (money(), moneyOrNull())
└── utils/          PageQuery · money (bigint VND, formatVnd, percentOf) · slugify/unaccent/makeSku · @NormalizeEmail/@ToBoolean
```

## 1. identity ✅ PLAN-0002

```text
identity                              schema identity · @Global (cung cấp 3 cổng cho guard/module khác)
├── foundation/      IDENTITY_ERR · IDENTITY_AUDIT · IDENTITY_EVENT · REDIS_KEY · hằng số khoá/OTP/TTL cache
├── permission/      catalog.ts (79 mã `module.resource.action` — 78 đang dùng + `catalog.brand.manage` deprecated; PLAN-0018 bỏ 4 mã ví; 9 vai: 7 vai nền tảng `scope=platform` +
│                    `shop_owner`/`shop_staff` `scope=shop`; ROLE_PRESETS — nguồn sự thật, perms:sync đồng bộ DB). Namespace `supplier.*` = nhân viên SÀN thao tác trên MỌI shop,
│                    `shop.*` = chủ/nhân viên shop trên CHÍNH shop mình (kiểm bằng ShopContextGuard từ ShopMember.roleId, KHÔNG qua PermissionGuard — vai shop không gán vào User.roleId)
│                    PermissionService (quyền hiệu lực = vai ∪ cấp riêng − chặn riêng; cache `effective-perms:<uid>:<pv>` 300s)
│                    AdminRoleController /admin/roles[/:code/permissions GET|PUT] · AdminPermissionController /admin/permissions, /admin/users/:id/permissions GET|PUT
├── auth/            AuthService (register/login/refresh/logout/change-password/forgot+reset OTP) · TokenService (JWT 15' + refresh rotation, family, reuse-detect;
│                    blacklist jti; cache `user-auth:<uid>` 60s) · AuthController /auth/* (@RateLimit theo ip)
├── user/            UserService (me: profile/avatar; admin: list/create staff/update/role/lock/reset pw — bump pv + thu hồi phiên + xoá cache)
│                    MeController /users/me[/avatar] · AdminUserController /admin/users
├── address/         AddressService (≤10 địa chỉ, một mặc định — transaction) · /users/me/addresses CRUD + /:id/default
├── loginhistory/    LoginHistoryService · /admin/login-histories · /users/me/login-histories
├── audit/           IdentityAuditLogService (ghi) · IdentityAuditQueryService + /admin/audit-logs/identity (đọc)
├── outbox/          IdentityOutboxService (publish trong tx, markProcessed idempotent)
├── gateway/         TokenValidationGatewayImpl · PermissionAuthorizationGatewayImpl · UserDirectoryGatewayImpl
├── queryapi/        IdentityQueryApi (findUserBrief[s]/findUserBriefByEmail/findAddress/defaultAddress + cho shop: findShopRoleByCode/shopRoleContext/findRoleBriefs) — cổng ĐỌC công khai của identity
├── applicationapi/  IdentityApplicationApi — cổng GHI công khai duy nhất của identity cho module khác (PLAN-0017 §12, 2026-10-13): `hashPassword(password)` (kiểm luật mật khẩu 8–64 ký tự có chữ và số → 400 IDENTITY_PASSWORD_WEAK rồi băm, NGOÀI transaction) +
│                    `createCustomerAccount(actor, {email, fullName, passwordHash}, tx)` (tạo user vai `customer`, status active, `email_verified_at` rỗng, createdBy = người tạo, + audit `USER_CREATED` có `via: 'shop_staff'`, TRONG transaction của người gọi; 409 IDENTITY_EMAIL_EXISTS) — chỉ module `shop` dùng, để chủ shop tạo tài khoản nhân viên; KHÔNG tạo được vai nhân viên sàn
├── identity.module.ts · identity-worker.module.ts (relay outbox 3s, listener USER_REGISTERED→mail chào mừng, USER_LOCKED→mail; cron 03:00 dọn token/login_histories)
```

Bất biến nhanh: mọi bump `permission_version` (đổi vai/quyền/khoá/đổi mật khẩu) → `TokenService.invalidateUserAuth` (hoặc `invalidateAllUserAuth` khi đổi preset vai) — nếu quên, token mới bị coi là STALE cho tới khi cache 60s hết.

## 2. catalog ✅ PLAN-0003 · PLAN-0016 (đa ngành hàng) · PLAN-0017

```text
catalog                               schema catalog · import ShopModule (guard của /shop/catalog)
├── enums/           GENDERS · CATALOG_MODULE/CATALOG_EVENT  (phần công khai — product import được)
├── category/        CategoryService (cache 10', product_count) · GET /categories · /admin/categories CRUD + ảnh
│                    Category.attributeMode `legacy_fashion` | `dynamic` (tường minh, KHÔNG suy từ cha); chỉ ngành LÁ mới gán được sản phẩm;
│                    đổi attributeMode bị khoá khi ngành đã có sản phẩm (CATALOG_CATEGORY_MODE_LOCKED — hỏi CatalogUsageRegistry)
├── collection/      CollectionService · GET /collections[/:slug] · /admin/collections CRUD + ảnh
├── attribute/       AttributeService — thuộc tính THỜI TRANG cũ (color hex / size group / material) · GET /attributes · PUT/DELETE /admin/attributes/:code/values
├── dynamic-attribute/  DynamicAttribute + DynamicAttributeValue (code/name/inputType select|text|number, extra {hex}) · /admin/dynamic-attributes[/:id[/values[/:valueId]]]
│                    quyền `catalog.dynamic_attribute.read|manage`; xoá giá trị đang dùng bị chặn (CATALOG_ATTRIBUTE_VALUE_IN_USE)
├── category-attribute/ CategoryAttribute (mẫu thuộc tính theo ngành: required · isVariantAxis — TỐI ĐA 2 trục biến thể/ngành) · GET/PUT /admin/categories/:categoryId/attributes
├── shop-catalog/    vendor đọc ngành + mẫu thuộc tính: GET /shop/catalog/categories/leaves · GET /shop/catalog/categories/:slug/attribute-template (shop.product.read)
├── gateway/         CategoryStatsGatewayImpl (adjustProductCount trong tx của product)
├── queryapi/        CatalogQueryApi (findCategoryById/BySlug, categoryHasChildren, listActiveCategories, getCategoryAttributeTemplate[{attributeId,required,isVariantAxis} — chưa có inputType],
│                    findDynamicAttributeValuesByIds/NamesByIds, colorMap[Fresh], sizeMap)
│                    CatalogUsageRegistry — ĐẢO CHIỀU phụ thuộc: product đăng ký provider lúc khởi động ("ngành/giá trị thuộc tính này còn được dùng không?"),
│                    catalog chỉ hỏi (catalog không đọc bảng product, cũng không import product → tránh vòng)
└── audit/ outbox/   CATEGORY_CHANGED → product worker đồng bộ category_slug
```

## 3. product ✅ PLAN-0004 · PLAN-0014 · PLAN-0016 · PLAN-0017

```text
product                               schema product · import CatalogModule + ShopModule
├── product/         ProductQueryService (đọc công khai, cache list 60s/detail 120s/filters 600s/related 300s; ẩn sản phẩm của shop chưa duyệt/bị khoá —
│                    loại theo ShopQueryApi.nonApprovedShopIds; `?shop=<slug>` lọc theo gian hàng) · ProductService (ghi: tạo/sửa/biến thể/đăng/ẩn/xoá)
│                    GET /products[…] · /admin/products CRUD + variants + publish/hide (nhân viên SÀN: xem/sửa sản phẩm của mọi shop; sản phẩm TẠO ở đây luôn thuộc
│                    gian hàng chính chủ FITLY Official `SHOP-000001`, SHOP_NOT_CONFIGURED nếu chưa seed shop)
│                    /shop/products CRUD + `PUT :id/variants` + `PUT :id/attributes` + publish/hide (vendor; Product.shopId CHỈ từ ShopContextGuard, không nhận từ body)
│                    Hai chế độ biến thể theo Category.attributeMode: `legacy_fashion` (colorCode×sizeCode) | `dynamic` (≤2 trục ProductVariantOption + ProductAttributeValue cấp sản phẩm);
│                    biến thể dynamic cập nhật TẠI CHỖ (giữ id/tồn kho, không xoá-tạo lại); sản phẩm chỉ gán vào ngành LÁ; SKU duy nhất TRONG shop (xem 03_DATABASE_RULES)
├── storefront/      GET /shops · GET /shops/:slug — trang gian hàng công khai (chỉ shop ĐÃ DUYỆT, còn lại 404). Đặt ở product (không phải shop) vì cần số sản phẩm/đánh giá đếm sẵn
│                    trên products mà shop không được import product (product đã phụ thuộc shop → ngược lại là vòng); hồ sơ shop lấy qua ShopQueryApi
├── image/           ProductImageService (Cloudinary, ảnh theo màu, ảnh chính, sắp xếp) · /admin/products/:id/images · ShopProductImageService + /shop/products/:id/images (chỉ sản phẩm của shop mình)
├── inventory/       InventoryService (FOR UPDATE theo id, sổ kho, phiếu nhập idempotent, điều chỉnh) · /admin/inventory/* · ShopInventoryService + /shop/inventory/* (chỉ biến thể/phiếu của shop mình; StockReceipt.shopId)
├── gateway/         InventoryGatewayImpl · ProductStatsGatewayImpl · CatalogUsageProviderImpl (đăng ký với CatalogUsageRegistry lúc onModuleInit)
├── enums/           PRODUCT_MODULE · PRODUCT_EVENT (phần công khai — ai/reporting/system import được)
├── queryapi/        ProductQueryApi (variantSnapshots cho giỏ/đơn, cardsByIds, findProductBrief[BySlug] (kèm shopId), getShopId, searchCards, recommend, garmentForTryOn, detailForAi[ById],
│                    variantStockSnapshot, listForEmbedding/embeddingSource) · variant-label.ts (nhãn biến thể ghép sẵn cho dòng giỏ/đơn của biến thể động) · attribute-lookup.ts
├── product-worker.module.ts   relay outbox catalog+product · listener CATEGORY_CHANGED · dọn idempotency_keys
└── audit/ outbox/   PRODUCT_PUBLISHED/UPDATED/HIDDEN · PRODUCT_STOCK_LOW
```

Bất biến: tồn kho chỉ đổi qua InventoryService; biến thể thời trang chỉ dùng mã màu/size của catalog, biến thể động chỉ dùng thuộc tính động của mẫu ngành lá;
xoá mềm sản phẩm xoá mềm cả biến thể; vendor chỉ đụng sản phẩm/kho/ảnh của shop mình (shopId lấy từ phiên, sản phẩm shop khác ⇒ 404).

## 4. cart ✅ PLAN-0005 · PLAN-0014 (nhóm theo shop)

```text
cart                                  schema cart (không audit/outbox)
├── cart/            CartService (Basket từ ProductQueryApi.variantSnapshots — giá/ảnh/tồn tươi; addItem/updateQuantity/setSelected/remove/clear/merge)
│                    CartItem.shopId = snapshot lúc thêm giỏ (đọc ProductQueryApi.getShopId) → dòng giỏ có shopId/shopSlug/shopName (ShopQueryApi.findManyBrief), FE nhóm giỏ theo shop
│                    WishlistService · CartController /cart[/items/:variantId[/select]|/merge] · WishlistController /wishlist/:productId[/toggle]
├── gateway/         CartGatewayImpl (removeLines — order xoá dòng đã đặt trong tx)
└── queryapi/        CartQueryApi (basketOf — order/promotion đọc giỏ)
```

## 5. promotion ✅ PLAN-0008 · PLAN-0014 · PLAN-0017

```text
promotion                             schema promotion · import CartModule + ShopModule
├── promotion.service.ts   discountOf (percentage trần / fixed ≤ base / free_shipping = phí ship; phạm vi sản phẩm all|category|product — mục tiêu `category` so slug NGÀNH LÁ bằng ===)
│                          Promotion.scope `platform` (SÀN chịu, áp trên cả giỏ nhiều shop) | `shop` (SHOP chịu, chỉ đơn con của shop phát hành; shopId bắt buộc khi scope=shop)
│                          scopeOf · evaluate/quote/consume (FOR UPDATE, usages unique theo mã đơn)/release — voucher sàn gắn mã đơn CHA, voucher shop gắn mã đơn CON
│                          offers (công khai, giảm thật cho giỏ hiện tại: voucher sàn + voucher của từng shop CÓ TRONG GIỎ, số giảm tính trên hàng của shop đó) · admin CRUD + usages
│                          các hàm admin nhận `ownerShopId` ⇒ dùng chung cho vendor (chỉ thấy/sửa mã của shop mình)
├── promotion.controllers.ts   GET /promotions/offers · /admin/promotions[/:id[/usages]] (nhân viên sàn, `promotion.promotion.*`)
├── shop-promotion.controller.ts   /shop/promotions[/:id[/usages]] (vendor tự quản voucher shop, `shop.promotion.read|manage`)
├── queryapi/        PromotionQueryApi (offersFor — ai đọc)
└── gateway: PromotionGateway (cài bởi PromotionService) · audit
```

Luật cộng dồn mỗi lần checkout: tối đa 1 voucher sàn + 1 voucher shop cho MỖI shop trong giỏ (chi tiết ở OrderService.applyVouchers, §6).

## 6. order ✅ PLAN-0006 · PLAN-0014 (đơn cha/đơn con) · PLAN-0017

```text
order                                 schema order · @Global (cung cấp ORDER_PAYMENT_GATEWAY, ORDER_ACTIONS_GATEWAY, OrderQueryApi) · import Cart/Product/Promotion/System/Payment/ShopModule
├── foundation/      ORDER_STATUS · STAFF_TRANSITIONS · STATUS_LABEL · ORDER_EVENT (ORDER_ERR có ORDER_SHOP_NOT_AVAILABLE / ORDER_PROMOTION_INVALID / ORDER_COD_LIMIT)
├── order/           OrderRepository (nextCode DHyymmddNNNN + nextGroupCode qua order_sequences, findByCodeForUpdate, purchasedItem) · OrderMapper (canCancel/canReturn/badge)
│                    MỘT lần checkout = 1 `OrderGroup` (đơn cha: địa chỉ giao, tổng tiền = Σ đơn con, KHÔNG có vòng đời riêng) + N `Order` CON (mỗi shop 1 đơn, vòng đời + Payment riêng;
│                    commissionRateSnapshot đóng băng hoa hồng lúc đặt; shop_discount/platform_discount/shop_promotion_code tách phần voucher shop vs voucher sàn)
│                    OrderService (checkoutSummary, placeOrder [tx: kiểm lại trạng thái từng shop + hạn mức COD → mã đơn → snapshot → reserve kho → applyVouchers (1 sàn + 1 shop/đơn con,
│                    phân bổ voucher sàn theo tỉ lệ subtotal, freeship theo phí ship từng gói, dồn dư làm tròn) → consume mã → xoá giỏ → initiate thanh toán từng đơn con → thông báo → outbox],
│                    myOrders/myOrder/myOrderGroup[s], cancelByCustomer, listAdmin/getAdmin/updateStatus/cancelByStaff, onPaid/onPaymentFailed/onRefunded, cancelExpired/autoComplete)
│                    ShopOrderService (vendor: chỉ đơn có shopId của phiên, đơn shop khác ⇒ 404; lưới chuyển trạng thái hẹp pending→confirmed→packing→shipping→delivered, huỷ khi pending/confirmed;
│                    response KHÔNG lộ paymentUrl/paymentIntent/transactionCode — `delivered→completed` do admin hoặc job auto-complete)
│                    OrderController /checkout/summary · /orders[/groups[/:code]|/:code[/cancel|/returns]] · /returns · AdminOrderController /admin/orders[/:code[/status|/cancel]] · /admin/returns[/:id[/process]]
│                    ShopOrderController /shop/orders[/summary|/:code[/status|/cancel]] (`shop.order.read|update`)
├── return/          ReturnService (tạo ≥1 minh chứng, hoàn theo tỉ lệ giảm, approve/reject, markRefunded) — sàn xử lý TẬP TRUNG (không có quyền đổi trả cho vendor)
├── gateway/         OrderPaymentGatewayImpl (payment gọi ngược khi paid/failed/refunded) · OrderActionsGatewayImpl (ai huỷ đơn thay khách)
├── queryapi/        OrderQueryApi (purchasedItem, markItemsReviewed, recentOrders, findByCodeForUser, boughtTogether, purchasedProductIds, recentPurchases, soldByVariant, coPurchasePairs;
│                    cho tiền/đối soát: shopIdOfOrder, commissionBasisOf, orderTotalsOf, settlementOrders — gom CẢ đơn online lẫn đơn COD đã `Payment=paid`)
├── order-worker.module.ts   relay outbox order+payment · OrderMailListeners (đặt/thanh toán/đổi trạng thái/giao/huỷ — idempotent qua processed_events) · job huỷ quá hạn thanh toán (1'), auto-complete (02:30), dọn idempotency (03:40)
└── audit/ outbox/ idempotency (POST /orders)
```

Bất biến: kho chỉ đổi qua InventoryGateway; đơn pending giữ `reserved`, confirmed trừ `stock`; huỷ sau confirmed = restock. PaymentService lấy ORDER_PAYMENT_GATEWAY lười qua `ModuleRef` (tránh vòng DI).
placeOrder đọc lại trạng thái từng shop TRONG transaction: shop không còn `approved` (hoặc người mua là thành viên chính shop đó — chống mua chéo) ⇒ 409 `ORDER_SHOP_NOT_AVAILABLE`,
hạn mức COD (tham số hệ thống) kiểm theo TỪNG đơn con; không còn khoá COD theo shop/ví (PLAN-0018) — các lỗi này chặn CẢ lần checkout (không loại riêng dòng của shop đó khỏi giỏ); đơn con bị giảm hết (total 0) ⇒ 409.
Mã đơn cha `DHN<yymmdd><4 số>` (bảng `order_group_sequences`), mã đơn con `DH<yymmdd><4 số>`.
Ai chịu voucher: voucher sàn do SÀN chịu (shop vẫn nhận đủ doanh thu — đối soát/hoa hồng tính trên `total + platformDiscount`), voucher shop do SHOP chịu.

## 7. payment ✅ PLAN-0007 · PLAN-0015 · PLAN-0017 · PLAN-0018 (sàn thu mọi khoản tiền)

Hai module Nest cùng schema `payment`: **PaymentModule** (thu tiền PayOS + COD, hoàn tiền) và **PaymentSettlementModule** (đối soát chi trả shop). Tách vì đối soát cần
`OrderQueryApi` mà `OrderModule` đã import `PaymentModule` — `PaymentModule` KHÔNG import `OrderModule` (nhận ORDER_PAYMENT_GATEWAY do OrderModule @Global cung cấp).
Payment gắn từng đơn CON (không phải OrderGroup): mỗi đơn con có payment/link thanh toán riêng.

```text
payment                               schema payment · PaymentModule import ShopModule + SystemModule
├── foundation/      PAYMENT_STATUS · REFUND_STATUS · TX_TYPE · METHOD (cod · payos) · PAYOUT_STATUS/PAYOUT_ERR/PAYOUT_AUDIT
├── payos/           PayosService — thu: createPaymentLink (POST /v2/payment-requests, ký HMAC-SHA256, orderCode = Date.now()*1000 + random(1000), link hết hạn 30'), verifyWebhookSignature (HMAC-SHA256, so sánh hằng-thời-gian),
│                    getPaymentLink, cancelPaymentLink; chi: payout (POST /v1/payouts từng khoản + x-idempotency-key), payoutBalance. Hai cặp khoá RIÊNG (thu / chi); khoá thu trống ⇒ `isConfigured=false` ⇒ method `payos` tự tắt, webhook từ chối;
│                    khoá chi trống ⇒ `isPayoutConfigured=false` ⇒ kỳ đối soát để `pending` cho kế toán chi tay. Header `x-signature` của API chi CHƯA được gửi/xác nhận (xem PLAN-0017 "Việc còn lại")
├── payment/         PaymentService (cài PaymentGateway: listMethods/isMethodActive, initiate COD|PayOS link, cancel, markCodCollected, requestRefund{shopId};
│                    handlePayos (webhook)/handlePayosReturn idempotent theo (type, provider_ref), retryPayos, extrasForOrder; markCodCollected = sàn ghi nhận đã thu COD khi giao thành công (Payment=paid);
│                    processRefund: CHIẾM yêu cầu (requested|failed → processing, compare-and-set) rồi mới gọi cổng — PayOS payout CHỈ khi webhook gốc có tài khoản đối ứng
│                    + có khoá chi (không thì kế toán chuyển tay + nhập providerRef), COD luôn hoàn tay; thanh toán đến muộn/trả trùng ⇒ tự tạo refund (refundDuplicate))
│                    PaymentPublicController /payment-methods (chỉ cod · payos) · /payments/payos/webhook|return · PaymentController /payments/payos/retry/:orderCode
│                    AdminPaymentController /admin/payment-methods · /admin/payments · /admin/refunds[/:id/process]
├── shop-payout/     (thuộc PaymentSettlementModule) ShopPayoutService — đối soát chi trả shop: gom đơn PayOS VÀ đơn COD (đã `delivered/completed` + `Payment=paid` do sàn xác nhận thu) đã qua hạn đổi trả (escrow) chưa thuộc kỳ nào, trừ hoa hồng theo snapshot trên đơn, hoàn tiền đã chi
│                    (chia theo tỉ lệ luỹ kế), nợ mang sang. net>0 ⇒ chi PayOS tự động (nếu có khoá chi + TK ngân hàng shop, trừ 24 giờ giữ chi trả sau khi shop đổi TK) hoặc `pending` cho kế toán `mark-paid`;
│                    net=0 ⇒ `settled`; net<0 ⇒ `carried` (không chi, nợ sang kỳ sau). UNIQUE(shopId, kỳ) + UNIQUE(orderCode, kind) ⇒ chạy lại không trùng; gọi PayOS NGOÀI transaction; gọi PayOS thành công ⇒ kỳ ở `processing` (CHƯA có webhook payout nên không tự thành `paid` — kế toán đối chiếu rồi `mark-paid`; `processing` treo > 10 phút được `retry`)
│                    /admin/payouts[/:id[/retry|mark-paid]] · /admin/payouts/run · /admin/payouts/payos-balance · /shop/payouts[/:id] — **cron tự động** (ShopPayoutCron trong worker, 02:00 Asia/Ho_Chi_Minh, kỳ `[ngày sau kỳ gần nhất, hết hôm qua]`; chỉ chạy khi setting `payout.auto_enabled`=true và PayOS chi đã cấu hình; kỳ rỗng bỏ qua); chạy tay `/admin/payouts/run` vẫn giữ để chạy bù
├── queryapi/        PaymentQueryApi (extrasForOrder, activeMethods, paidSummaryBetween)
├── payment-worker.module.ts   relay outbox payment · PaymentEventListeners (không còn listener ví COD; hoàn tiền đơn COD đã đối soát ⇒ dòng REFUND ở kỳ sau qua đối soát)
│                    · cron chi trả shop tự động (xem shop-payout)
└── audit/ outbox/ processed (relay chạy ở PaymentWorkerModule và cả OrderWorkerModule — claim SKIP LOCKED nên không xử lý đôi)
```

Bất biến tiền: sàn thu mọi khoản (PayOS + COD) và là bên duy nhất trả shop — không có ví/sổ quỹ COD; đối soát idempotent theo UNIQUE(shopId, kỳ) + UNIQUE(orderCode, kind);
voucher sàn do sàn chịu (đối soát tính trên `total + platformDiscount`); chi PayOS có idempotency-key = mã kỳ nên retry không chi đôi.

## 8. review ✅ PLAN-0009 · PLAN-0014 (đánh giá theo shop)

```text
review                                schema review · import ProductModule + ShopModule
├── enums/           REVIEW_MODULE · REVIEW_EVENT (REVIEW_CREATED — ai + shop tiêu thụ; REVIEW_RATING_CHANGED khai báo + shop worker nghe nhưng CHƯA nơi nào phát)
├── review.service.ts   listForProduct (+summary phân bố sao) · eligibility · create (purchasedItem → unique dòng đơn → markItemsReviewed → setRating cùng tx → outbox; Review.shopId = snapshot của sản phẩm)
│                       · mine/updateMine/deleteMine · listAdmin · moderate (ẩn/hiện, rating tính lại chỉ approved) · reply (một trả lời/đánh giá) · maskName
│                       listShop/replyShop (vendor: CHỈ đánh giá đã duyệt của sản phẩm thuộc shop mình, DTO ShopReviewResponse không lộ userId/orderCode/email/ghi chú kiểm duyệt;
│                       phần trả lời hiển thị TÊN SHOP, không phải họ tên nhân viên)
├── review.controllers.ts   /products/:slug/reviews[/eligibility] · /reviews/me[/:id] · /admin/reviews[/:id/moderate|/reply]
├── shop-review.controller.ts   /shop/reviews · /shop/reviews/:id/reply (`shop.review.read|reply`, shopId từ ShopContextGuard)
├── queryapi/        ReviewQueryApi (approvedForProduct, findById — ai đọc)
└── audit/ outbox/ processed (relay ở AiWorkerModule)
```

## 9. system ✅ PLAN-0010 · PLAN-0017 (thông báo cho shop)

```text
system                                schema system
├── enums/           SETTING_KEY (phần công khai)
├── foundation/      SETTING_DEFAULTS (12 khoá) · SYSTEM_CACHE
├── setting/ province/ banner/ notification/ content/   SettingService (cache) · ProvinceService (resolve không dấu, shippingFeeFor freeship ≥ ngưỡng) · BannerService
│                    NotificationService (cài NotificationGateway: notify/notifyMany/notifyStaff/listMine/markRead/broadcast) · ContentService (faq/page/contact)
├── upload/          UploadController POST /uploads/media (Cloudinary user-media — đánh giá, minh chứng đổi trả)
├── health/          GET /health
├── system.controllers.ts   SystemPublicController (/settings/public, /provinces, /banners, /faqs, /pages/:slug, POST /contact) · NotificationController · AdminSystemController /admin/*
├── system-worker.module.ts   listener thông báo cho THÀNH VIÊN gian hàng (qua ShopQueryApi.activeMemberUserIds): ORDER_CREATED (đơn mới) · ORDER_PAID (đơn ONLINE vừa nhận tiền; COD bỏ qua) ·
│                    PRODUCT_STOCK_LOW (dedupe theo biến thể + ngày VN) · SHOP_BANK_CHANGED (báo mọi thành viên, chỉ 4 số cuối TK). system KHÔNG có processed_events nên dedupe bằng
│                    `payload.eventId` trong chính bảng notifications; `suppressErrors:false` để lỗi ném lên relay ⇒ FAILED + retry
└── queryapi/        SystemQueryApi (setting, settingNumber, shippingFeeFor, resolveProvince, shopName) · audit
```

## 10. reporting ✅ PLAN-0011 · PLAN-0017 (báo cáo theo shop)

```text
reporting                             schema reporting (daily_sales) — CHỈ ĐỌC xuyên schema (raw SQL SELECT, ngoại lệ có chủ đích) · import ShopModule (guard)
├── reporting.service.ts   dashboard (hôm nay/tháng/7 ngày/top/trạng thái/phương thức + việc đang chờ) · revenue (ngày|tháng, kỳ trống = 0) · topProducts · lowStock · inventorySummary
│                          recomputeDay/recomputeRange (worker + admin) · cache Redis 60–300s — số liệu TOÀN SÀN (đọc bảng daily_sales, không phân theo shop)
├── reporting.controllers.ts   /admin/reports/dashboard|revenue|top-products|low-stock|inventory · POST /admin/reports/recompute
├── shop-reporting.service.ts  báo cáo CỦA MỘT SHOP: SQL trực tiếp lọc `o.shop_id` (KHÔNG dùng daily_sales), cache Redis có shopId trong khoá (60–300s); khoảng ngày kiểm bằng reporting-range.ts
├── shop-reporting.controller.ts   /shop/reports/dashboard|revenue|top-products|low-stock (`shop.report.read`, shopId từ ShopContextGuard)
└── reporting-worker.module.ts   DailySalesJob: khởi động bù 35 ngày · mỗi 5' hôm nay · 00:05 VN tính lại 14 ngày gần nhất (đơn COD thu tiền muộn)
```

## 11. ai ✅ PLAN-0012 / 0013 · PLAN-0016/0017 (khung sàn đa ngành hàng + tìm bằng ảnh)

Prompt/ngữ cảnh AI đã đổi sang khung "sàn thương mại điện tử đa gian hàng, đa ngành hàng" (không còn "cửa hàng thời trang"); `ProductQueryApi.detailForAi` trả thêm
`attributeMode`/`attributesText`/`optionsText` cho sản phẩm ngành động. Thử đồ 2D (`tryon/`) và phân tích ảnh người (`style/`) là tính năng thời trang cũ, route còn nhưng FE đã ẩn khỏi menu.

```text
ai                                    schema ai · mọi tính năng có ĐƯỜNG LÙI không-AI
├── enums/           AI_MODULE · AI_JOB (try-on, index-document, embed-product)
├── foundation/      AI_ERR · AI_FEATURE · TRYON_CATEGORY (ngành hàng → upper_body/lower_body/dresses) · RULE (từ khoá) · chunkText (thuần, seed dùng)
├── provider/        OpenAiProvider (CHỖ DUY NHẤT gọi OpenAI: embed/chatJson/visionJson; kiểm ngân sách trước, ghi usage sau) · ReplicateProvider (REST, token chỉ vào header)
├── usage/           AiUsageService (usage_logs, assertBudget theo EF_AI_DAILY_TOKEN_BUDGET, summary)
├── embedding/       EmbeddingService (pgvector raw SQL: embedProduct/reindexProducts/searchProducts/similarProducts, indexDocument/searchChunks; không key → chunk không vector + ILIKE)
├── knowledge/       KnowledgeService (CRUD documents → job index)
├── chat/            ChatService (guest key; rule HUMAN→support; AGENT tool-calling qua ToolBox — search/details/reviews/knowledge/orders/promotions/shipping/payment/recommend/support
│                    + add_to_cart/cancel_order chỉ ĐỀ XUẤT; gợi ý câu hỏi tiếp; meta tools/misses/actions/guard; lùi answerByRule; history; admin che PII; draft-reply)
│                    ChatActionService (đề xuất Redis 30' → confirm ghi qua CartGateway.addItem / OrderActionsGateway.cancelByCustomer; reject) · chat-guard (Luhn, injection) · chat-tools (ToolBox, pickVariant)
├── recommendation/  RecommendationService (similar vector · boughtTogether đồng đơn · forCart · collections theo dịp LLM/rule cache 24h · compare 2–3 LLM cache 6h)
├── faq/             ProductFaqService (đọc lười: hash nguồn lệch → job `product-faq` → LLM 3–6 hỏi-đáp; invalidate khi PRODUCT_*/REVIEW_CREATED)
├── signal/          SignalService (events view/add_to_cart/click/impression + source; stats phễu hiển thị→click→giỏ→mua 7 ngày)
├── style/           StyleAnalysisService (Cloudinary → vision JSON ràng buộc màu/ngành catalog → ProductQueryApi.recommend; lùi ruleResult)
├── image-search/    ImageSearchService — POST /ai/image-search (multipart `image` ≤ 5MB jpeg/png/webp, kiểm magic bytes; ảnh KHÔNG được lưu): OpenAI vision → {description, keywords, categorySlugHint}
│                    → mỗi từ khoá tra riêng (ProductQueryApi.searchCards) → xếp theo số từ khoá khớp → soldCount; không khớp ⇒ lùi về gợi ý THEO NGÀNH + message, không có ngành ⇒ `items: []`;
│                    không có EF_OPENAI_API_KEY ⇒ `available:false` (không gọi mạng)
├── tryon/           TryOnService (create → try_on_jobs queued → BullMQ ai; process ở worker: Replicate IDM-VTON poll ≤4' → lưu ảnh về Cloudinary; purgeOld 7 ngày)
├── review-ai/       ReviewAiService (moderate: nhãn đề xuất LLM/rule → moderation_flags; summarize ≥3 đánh giá → review_summaries; summary cache)
├── insight/         AiInsightService (support requests, recommendations [xem+mua → similar → bán chạy], generateCopy, purge retention)
│                    ChatInsightsService (bot bí: gom cụm embedding + LLM đặt tên/bài nên viết, cache 1h) · MetricsAgentService (ask: agent gọi ReportingQueryApi/usage/stats — không SQL)
│                    StaffInsightService (classify · precheck · inventoryInsights · revenueInsight · comboSuggestions; lùi rule)
├── ai.controllers.ts   AiController /ai/status|chat[/sessions/:id/actions/:aid/confirm|reject]|support|style-analysis|try-on|recommendations|products/:slug/similar|bought-together|faq|cart-suggestions|collections|compare|events[/batch|/view]|review-summary
│                    AdminAiController /admin/ai/documents[/:id/reindex]|index/status|index/rebuild|support[/:id/draft-reply]|chat/sessions|chat-insights|moderation-flags|copy|classify-product|precheck-product/:id|inventory-insights|revenue-insight|combo-suggestions|ask|usage|recommendation-stats
├── ai-worker.module.ts   ReviewOutboxRelayJob · AiEventListeners (PRODUCT_* → nhúng lại + FAQ stale; REVIEW_CREATED → kiểm duyệt + tóm tắt + FAQ stale) · AiQueueProcessor (try-on, index-document, embed-product, product-faq) · AiHousekeepingJob
└── audit/ processed_events (ai không phát outbox)
```

## 12. shop ✅ PLAN-0014 · PLAN-0015 (TK ngân hàng) · PLAN-0017

```text
shop                                  schema shop (Shop · ShopMember · audit/outbox/processed — bảng ShopInvitation đã bỏ ở migration 20261013090000) · KHÔNG import module nghiệp vụ khác ở API (chỉ identity qua queryapi + applicationapi); ShopWorkerModule import ProductModule + ShopModule
├── enums/           SHOP_MODULE · SHOP_EVENT (phần công khai — payment/system import được)
├── foundation/      SHOP_ERR · SHOP_AUDIT · SHOP_STATUS (pending|approved|suspended|rejected) · SHOP_TRANSITIONS (pending→approved|rejected, approved→suspended, suspended→approved, rejected cuối) · FITLY_OFFICIAL_SHOP_CODE `SHOP-000001`
├── shop/            ShopService (duyệt/khoá/từ chối + sửa hoa hồng — không hồi tố đơn cũ; getMe/updateMe: hồ sơ + TK ngân hàng nhận tiền, số TK che ở response, đổi TK ghi audit `SHOP_BANK_UPDATED` + outbox SHOP_BANK_CHANGED.
│                    KHÔNG có cột "ngày đổi TK": mốc đổi gần nhất do `ShopQueryApi.bankAccountOf().changedAt` đọc từ audit log `SHOP_BANK_UPDATED` của chính module shop, đối soát dùng nó để giữ chi trả 24 giờ)
│                    AdminShopController /admin/shops (list/get/approve/suspend/reject/commission — `supplier.shop.*`; shop mới vào bằng luồng người bán tự đăng ký — xem registration/ — hoặc seed/script)
│                    ShopController /shop/session (@AllowAnyShopStatus — chạy cả khi shop chờ duyệt/bị khoá, trả shop + vai + mã quyền `shop.*` để FE vendor dựng menu) · /shop/me (GET/PATCH)
├── member/          ShopMemberService (PLAN-0017 §12, đổi 2026-10-13: chủ shop THÊM nhân viên TRỰC TIẾP — không mời, không chờ chấp nhận). `add` = `POST /shop/members` {email, fullName, password, roleCode}: băm mật khẩu NGOÀI transaction (IdentityApplicationApi.hashPassword) →
│                    transaction: advisory lock theo shop → đếm thành viên active (trần SHOP_MEMBER_MAX_ACTIVE = 50 ⇒ 409 SHOP_MEMBER_LIMIT_REACHED) → IdentityApplicationApi.createCustomerAccount (tài khoản khách) + ShopMember active + audit SHOP_MEMBER_ADDED + outbox SHOP_MEMBER_JOINED — CÙNG một transaction
│                    (không để lại tài khoản mồ côi). Email đã có tài khoản ⇒ 409 IDENTITY_EMAIL_EXISTS (một mã chung, không phân biệt để không dò được tài khoản). KHÔI PHỤC nhân viên cũ: tài khoản TỪNG là thành viên (status=removed) của CHÍNH shop này, còn active + khách thường +
│                    không ở shop khác ⇒ kích hoạt lại ShopMember với vai mới (`restored: true`), KHÔNG đổi mật khẩu/hồ sơ; không khôi phục được ⇒ 409 SHOP_MEMBER_UNAVAILABLE (cũng khi đua ở chốt unique DB). Đổi vai/gỡ/tự rời khoá FOR UPDATE các dòng chủ ⇒ shop không bao giờ về 0 chủ, 409 SHOP_LAST_OWNER ·
│                    GET /shop/members · POST /shop/members (quyền `shop.staff.invite` — tên cũ giữ nguyên, mô tả "Thêm nhân viên"; rate-limit 30/giờ/user) · PATCH|DELETE /shop/members/:id · POST /shop/members/leave (@AllowAnyShopStatus).
│                    Luật "mỗi người MỘT shop active" chốt bằng unique một phần uq_shop_members_one_active_per_user (migration 20261004090000, GIỮ nguyên sau khi bỏ bảng lời mời)
├── registration/    người bán TỰ ĐĂNG KÝ gian hàng (PLAN-0019): ShopRegistrationService `submit` = POST /shop/registrations (transaction: advisory lock theo người nộp → kiểm chưa là thành viên/chưa có shop pending →
│                    lock toàn cục cấp mã → kiểm trùng tên → mã SHOP-###### + slug → Shop(pending) + ShopRegistration → audit/outbox), `getMine` = GET /shop/registrations/me (data null nếu chưa đăng ký),
│                    `getForShop` = GET /admin/shops/:id/registration (supplier.shop.read, kèm người nộp). `prepareStatusChange`/`recordDecision` móc vào ShopService.changeStatus: DUYỆT lần đầu tạo ShopMember
│                    shop_owner cho người nộp (cùng transaction; không được ⇒ 409 SHOP_OWNER_UNAVAILABLE), ghi lý do/thời điểm quyết định. Controller công khai KHÔNG dùng ShopContextGuard. Ngành hàng lấy từ
│                    CatalogQueryApi qua ModuleRef lười (CatalogModule đã import ShopModule ⇒ import ngược là vòng). Bảng `shop.shop_registrations` (schema riêng file shop-registration.prisma)
├── security/        ShopContextGuard + @RequireShopPermission + @CurrentShop + @AllowAnyShopStatus — guard dùng CHUNG cho mọi controller `/shop/**` của các module khác (dependency-cruiser cho phép import `security/`)
│                    thứ tự: JWT → ShopMember active của actor (shopId CHỈ từ đây, không từ URL/body) → đọc THẲNG Shop.status (khác approved ⇒ 403 SHOP_NOT_APPROVED, trừ route AnyShopStatus)
│                    → mã quyền `shop.*` của ShopMember.roleId (qua IdentityQueryApi.shopRoleContext). Một user thuộc nhiều shop ⇒ lấy membership active CŨ NHẤT
├── queryapi/        ShopQueryApi (findBrief/findManyBrief, findPublicBySlug, listPublic, nonApprovedShopIds, findOfficialShopId, existsApproved, activeMemberUserIds, bankAccountOf)
├── shop-worker.module.ts   relay outbox shop (3s) · ShopEventListeners: REVIEW_CREATED / REVIEW_RATING_CHANGED ⇒ tính lại Shop.ratingAvg (trung bình đánh giá approved của mọi sản phẩm của shop,
│                    ghi đè nên idempotent; SQL thô JOIN review×product là ngoại lệ ranh giới có chủ đích, chờ ReviewQueryApi/ProductQueryApi có hàm tương ứng)
└── audit/ outbox/   SHOP_APPROVED · SHOP_SUSPENDED · SHOP_REJECTED · SHOP_BANK_CHANGED · SHOP_MEMBER_LEFT · SHOP_MEMBER_JOINED (audit thêm SHOP_MEMBER_ADDED; dòng audit cũ SHOP_INVITATION_* vẫn nằm trong shop.audit_logs làm lịch sử)
```

Bất biến: vendor KHÔNG BAO GIỜ truyền `shopId` qua URL/body/query; mọi repository/service vendor lọc thêm theo shopId của phiên, dữ liệu shop khác ⇒ 404 (không lộ tồn tại);
mã quyền `shop.*` (vendor, tự quản shop mình) KHÁC mã `supplier.*` (nhân viên sàn, thao tác mọi shop) — không dùng chung một mã cho hai phạm vi.
Hoa hồng, TK ngân hàng, đối soát KHÔNG lộ ra web bán hàng (`/shops/:slug` chỉ trả hồ sơ công khai).

## 13. Sự kiện outbox (ai phát · ai nghe)

Mỗi module có `<schema>.outbox_events` riêng; worker relay (claim `FOR UPDATE SKIP LOCKED`, backoff mũ, MAX_RETRY 8) phát `outbox.<module>.<EVENT>` qua EventEmitter, listener cùng process worker.
Listener ghi tiền/thông báo dùng `suppressErrors:false` (lỗi ném lên relay ⇒ FAILED + retry, không mất sự kiện) và idempotent (sổ cái theo khoá tự nhiên / `processed_events` / `payload.eventId`).

| Sự kiện | Module phát | Listener (worker) |
|---|---|---|
| `USER_REGISTERED` · `USER_LOCKED` | identity | identity (mail chào mừng / mail khoá) |
| `CATEGORY_CHANGED` | catalog | product (đồng bộ `category_slug`) |
| `PRODUCT_PUBLISHED` · `PRODUCT_UPDATED` · `PRODUCT_HIDDEN` | product | ai (nhúng lại vector + đánh dấu FAQ cũ) |
| `PRODUCT_STOCK_LOW` | product (kho) | system (thông báo thành viên shop, dedupe theo biến thể + ngày) |
| `ORDER_CREATED` | order (mỗi ĐƠN CON; payload có orderGroupCode, shopId) | order (mail khách) · system (báo thành viên shop) |
| `ORDER_PAID` | order | order (mail) · system (báo shop — đơn online) |
| `ORDER_STATUS_CHANGED` · `ORDER_DELIVERED` · `ORDER_CANCELLED` | order | order (mail khách) · (payment: không còn listener ví COD) |
| `RETURN_REQUESTED` · `RETURN_PROCESSED` | order | chưa có listener |
| `PAYMENT_PAID` | payment | chưa có listener (đơn được báo qua OrderPaymentGateway.onPaid trong cùng transaction) |
| `PAYMENT_REFUNDED` | payment (payload: refundId, orderCode, amount, methodCode, shopId) | chưa có listener (hoàn tiền vào đối soát qua dòng REFUND) |
| `PAYOUT_CREATED` · `PAYOUT_PROCESSING` · `PAYOUT_PAID` · `PAYOUT_FAILED` | payment (đối soát) | chưa có listener |
| `SHOP_APPROVED` | shop | chưa có listener |
| `SHOP_SUSPENDED` · `SHOP_REJECTED` | shop | chưa có listener (sản phẩm bị ẩn bằng cách lọc theo trạng thái shop lúc đọc, không qua sự kiện) |
| `SHOP_BANK_CHANGED` | shop | system (báo mọi thành viên, chỉ 4 số cuối TK) |
| `SHOP_MEMBER_LEFT` | shop | chưa có listener |
| `SHOP_MEMBER_JOINED` | shop (chủ shop vừa thêm/khôi phục một nhân viên; payload `{shopId, memberId, roleId}`) | chưa có listener |
| `REVIEW_CREATED` | review | ai (kiểm duyệt + tóm tắt + FAQ cũ) · shop (tính lại Shop.ratingAvg) |
| `REVIEW_RATING_CHANGED` | — (khai báo ở `review/enums`, CHƯA nơi nào phát) | shop (đã đăng ký nghe) |

Relay: `order` + `payment` ở OrderWorkerModule (payment còn được relay thêm ở PaymentWorkerModule — claim SKIP LOCKED nên không xử lý đôi) · `product`+`catalog` ở ProductWorkerModule ·
`identity` ở IdentityWorkerModule · `shop` ở ShopWorkerModule · `review` ở AiWorkerModule (ReviewOutboxRelayJob; `ReviewWorkerModule` cũng khai báo relay review).

## Ma trận phụ thuộc

"Đọc chéo" = module được import qua `queryapi/`/`applicationapi/`/`enums/`/`security/`/`*.module.ts` (kiểm bằng import thật trong `src/modules/**`, bỏ spec).

| Module | Đọc chéo (queryapi · enums · security) | Gateway cài | Outbox phát |
|---|---|---|---|
| common | — | — | — |
| identity | — | TokenValidation · PermissionAuthorization · UserDirectory | USER_REGISTERED · USER_LOCKED |
| shop | identity (queryapi + applicationapi; enum trạng thái user) · product (queryapi, ở worker) · review (enums, ở worker) | — | SHOP_APPROVED · SHOP_SUSPENDED · SHOP_REJECTED · SHOP_BANK_CHANGED · SHOP_MEMBER_LEFT · SHOP_MEMBER_JOINED |
| catalog | shop (security — guard `/shop/catalog`) | CategoryStats (+ CatalogUsageRegistry do product đăng ký) | CATEGORY_CHANGED |
| product | catalog · shop (queryapi + security) | Inventory · ProductStats | PRODUCT_PUBLISHED · PRODUCT_UPDATED · PRODUCT_HIDDEN · PRODUCT_STOCK_LOW |
| cart | product · shop · system | Cart | — |
| promotion | cart · shop (queryapi + security) | Promotion | — |
| order | product · cart · promotion · identity · system · payment (queryapi) · shop (queryapi + security) | OrderPayment · OrderActions | ORDER_CREATED · ORDER_STATUS_CHANGED · ORDER_CANCELLED · ORDER_PAID · ORDER_DELIVERED · RETURN_REQUESTED · RETURN_PROCESSED |
| payment (PaymentModule) | shop (queryapi + security + enums) · system · (order qua ORDER_PAYMENT_GATEWAY — lười, không import OrderModule) | Payment | PAYMENT_PAID · PAYMENT_REFUNDED |
| payment (PaymentSettlementModule) | order (queryapi) · shop · system · PaymentModule | — | PAYOUT_CREATED · PAYOUT_PROCESSING · PAYOUT_PAID · PAYOUT_FAILED |
| review | product · order · shop (queryapi + security) | — | REVIEW_CREATED |
| system | identity (UserDirectory) · shop · order · product (listener thông báo shop) | Notification | — |
| reporting | shop (security) — SELECT chỉ đọc xuyên schema | — | — |
| ai | product · catalog · order · review · system · cart · promotion · payment · reporting · identity (UserDirectory) · Notification · CartGateway.addItem · OrderActionsGateway | — | — (tiêu thụ product/review) |
