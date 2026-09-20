# 02 — Bản đồ module (as-built)

Cập nhật sau mỗi plan. Cột "Đọc chéo" = queryapi module khác mà module này gọi; "Gateway cài" = interface ở
`common/gateway` do module này cài đặt.

## 0. common ✅ PLAN-0001

```text
common
├── response/       ApiResponse · ApiError · PageResponse
├── exception/      BusinessException (+ NotFound/Conflict/Forbidden/Unauthorized/ServiceUnavailable) · GlobalExceptionFilter
├── request/        RequestTraceContext (AsyncLocalStorage requestId/ip/ua) · RequestTraceMiddleware (X-Request-Id, X-Forwarded-For theo số proxy)
├── security/       AuthenticatedActor · @CurrentActor/@Public/@OptionalAuth/@RequirePermission · JwtAuthGuard · PermissionGuard · RateLimitGuard (@RateLimit, Redis)
│                   PermissionAuthorizationGateway + TokenValidationGateway (identity cài)
├── gateway/        UserDirectoryGateway · NotificationGateway · InventoryGateway (reserve/release/commit/restock) · ProductStatsGateway · CategoryStatsGateway · CartGateway (removeLines)
│                   PromotionGateway (quote/consume/release) · PaymentGateway (initiate/cancel/markCodCollected/requestRefund) · OrderPaymentGateway (onPaid/onPaymentFailed/onRefunded/markReturnRefunded)
│                   OrderActionsGateway (cancelByCustomer — ai sau khi khách xác nhận) · CartGateway.addItem
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
├── permission/      catalog.ts (52 mã `module.resource.action`, 7 vai, ROLE_PRESETS — nguồn sự thật, perms:sync đồng bộ DB)
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
├── queryapi/        IdentityQueryApi (findUserBrief/findUserBriefs) — thứ DUY NHẤT module khác được import
├── identity.module.ts · identity-worker.module.ts (relay outbox 3s, listener USER_REGISTERED→mail chào mừng, USER_LOCKED→mail; cron 03:00 dọn token/login_histories)
```

Bất biến nhanh: mọi bump `permission_version` (đổi vai/quyền/khoá/đổi mật khẩu) → `TokenService.invalidateUserAuth` (hoặc `invalidateAllUserAuth` khi đổi preset vai) — nếu quên, token mới bị coi là STALE cho tới khi cache 60s hết.

## 2. catalog ✅ PLAN-0003

```text
catalog                               schema catalog
├── enums/           GENDERS · CATALOG_MODULE/CATALOG_EVENT  (phần công khai — product import được)
├── category/        CategoryService (cache 10', product_count) · GET /categories · /admin/categories CRUD + ảnh
├── collection/      CollectionService · GET /collections[/:slug] · /admin/collections CRUD + ảnh
├── attribute/       AttributeService (color hex / size group / material) · GET /attributes · PUT/DELETE /admin/attributes/:code/values
├── gateway/         CategoryStatsGatewayImpl (adjustProductCount trong tx của product)
├── queryapi/        CatalogQueryApi (findCategoryById/BySlug, colorMap, sizeMap)
└── audit/ outbox/   CATEGORY_CHANGED → product worker đồng bộ category_slug
```

## 3. product ✅ PLAN-0004

```text
product                               schema product
├── product/         ProductQueryService (đọc công khai, cache list/detail/filters/related) · ProductService (ghi: tạo/sửa/biến thể/đăng/ẩn/xoá)
│                    GET /products[…] · /admin/products CRUD + variants + publish/hide
├── image/           ProductImageService (Cloudinary, ảnh theo màu, ảnh chính, sắp xếp) · /admin/products/:id/images
├── inventory/       InventoryService (FOR UPDATE theo id, sổ kho, phiếu nhập idempotent, điều chỉnh) · /admin/inventory/*
├── gateway/         InventoryGatewayImpl · ProductStatsGatewayImpl
├── enums/           PRODUCT_MODULE · PRODUCT_EVENT (phần công khai — ai/reporting import được)
├── queryapi/        ProductQueryApi (variantSnapshots cho giỏ/đơn, cardsByIds, findProductBrief[BySlug], searchCards, recommend, garmentForTryOn, listForEmbedding/embeddingSource)
├── product-worker.module.ts   relay outbox catalog+product · listener CATEGORY_CHANGED · dọn idempotency_keys
└── audit/ outbox/   PRODUCT_PUBLISHED/UPDATED/HIDDEN · STOCK_LOW
```

Bất biến: tồn kho chỉ đổi qua InventoryService; biến thể chỉ dùng mã màu/size của catalog; xoá mềm sản phẩm xoá mềm cả biến thể.

## 4. cart ✅ PLAN-0005

```text
cart                                  schema cart (không audit/outbox)
├── cart/            CartService (Basket từ ProductQueryApi.variantSnapshots — giá/ảnh/tồn tươi; addItem/updateQuantity/setSelected/remove/clear/merge)
│                    WishlistService · CartController /cart[/items/:variantId[/select]|/merge] · WishlistController /wishlist/:productId[/toggle]
├── gateway/         CartGatewayImpl (removeLines — order xoá dòng đã đặt trong tx)
└── queryapi/        CartQueryApi (basketOf — order/promotion đọc giỏ)
```

## 5. promotion ✅ PLAN-0008

```text
promotion                             schema promotion
├── promotion.service.ts   discountOf (percentage trần / fixed ≤ base / free_shipping = phí ship; phạm vi all|category|product) · evaluate/quote/consume (FOR UPDATE, usages unique theo mã đơn)/release
│                          offers (công khai, giảm thật cho giỏ hiện tại) · admin CRUD + usages
├── promotion.controllers.ts   GET /promotions/offers · /admin/promotions[/:id[/usages]]
└── gateway: PromotionGateway (cài bởi PromotionService) · audit
```

## 6. order ✅ PLAN-0006

```text
order                                 schema order · @Global (cung cấp ORDER_PAYMENT_GATEWAY, OrderQueryApi)
├── foundation/      ORDER_STATUS · STAFF_TRANSITIONS · STATUS_LABEL · ORDER_EVENT
├── order/           OrderRepository (nextCode DHyymmddNNNN qua order_sequences, findByCodeForUpdate, purchasedItem) · OrderMapper (canCancel/canReturn/badge)
│                    OrderService (checkoutSummary, placeOrder [tx: mã đơn → snapshot → reserve kho → consume mã → xoá giỏ → initiate thanh toán → thông báo → outbox],
│                    myOrders/myOrder, cancelByCustomer, listAdmin/getAdmin/updateStatus/cancelByStaff, onPaid/onPaymentFailed/onRefunded, cancelExpired/autoComplete)
│                    OrderController /checkout/summary · /orders[/:code[/cancel|/returns]] · /returns · AdminOrderController /admin/orders[/:code[/status|/cancel]] · /admin/returns[/:id/process]
├── return/          ReturnService (tạo ≥1 minh chứng, hoàn theo tỉ lệ giảm, approve/reject, markRefunded)
├── gateway/         OrderPaymentGatewayImpl (payment gọi ngược khi paid/failed/refunded)
├── queryapi/        OrderQueryApi (purchasedItem, markItemsReviewed, recentOrders, findByCodeForUser, boughtTogether, purchasedProductIds)
├── order-worker.module.ts   relay outbox order+payment · OrderMailListeners (đặt/xác nhận/giao/huỷ/hoàn) · job huỷ quá hạn thanh toán (1'), auto-complete (giờ)
└── audit/ outbox/ idempotency (POST /orders)
```

Bất biến: kho chỉ đổi qua InventoryGateway; đơn pending giữ `reserved`, confirmed trừ `stock`; huỷ sau confirmed = restock. PaymentService lấy ORDER_PAYMENT_GATEWAY lười qua `ModuleRef` (tránh vòng DI).

## 7. payment ✅ PLAN-0007

```text
payment                               schema payment
├── foundation/      PAYMENT_STATUS · REFUND_STATUS · TX_TYPE · VNPAY_RESPONSE (mã → tiếng Việt)
├── vnpay/           VnpayService (buildPayUrl HMAC-SHA512, verify return/IPN, refund API; returnUrl = EF_WEB_URL/checkout/vnpay-return)
├── payment/         PaymentService (cài PaymentGateway: listMethods/isMethodActive, initiate COD|VietQR intent|VNPay URL, cancel, markCodCollected, requestRefund;
│                    handleVnpay return/ipn idempotent theo (type, provider_ref), retryVnpay, confirmTransfer, processRefund, extrasForOrder)
│                    PaymentController /payment-methods · /payments/vnpay/return|ipn · /payments/vnpay/retry/:code · AdminPaymentController /admin/payment-methods · /admin/payments[/:id/confirm-transfer] · /admin/refunds[/:id/process]
├── queryapi/        PaymentQueryApi
└── audit/ outbox/ processed (relay chung với order ở OrderWorkerModule)
```

## 8. review ✅ PLAN-0009

```text
review                                schema review
├── enums/           REVIEW_MODULE · REVIEW_EVENT (REVIEW_CREATED — ai tiêu thụ)
├── review.service.ts   listForProduct (+summary phân bố sao) · eligibility · create (purchasedItem → unique dòng đơn → markItemsReviewed → setRating cùng tx → outbox) · mine/updateMine/deleteMine
│                       listAdmin · moderate (ẩn/hiện, rating tính lại chỉ approved) · reply (một trả lời/đánh giá) · maskName
├── review.controllers.ts   /products/:slug/reviews[/eligibility] · /reviews/me[/:id] · /admin/reviews[/:id/moderate|/reply]
├── queryapi/        ReviewQueryApi (approvedForProduct, findById — ai đọc)
└── audit/ outbox/ processed (relay ở AiWorkerModule)
```

## 9. system ✅ PLAN-0010

```text
system                                schema system
├── enums/           SETTING_KEY (phần công khai)
├── foundation/      SETTING_DEFAULTS (12 khoá) · SYSTEM_CACHE
├── setting/ province/ banner/ notification/ content/   SettingService (cache) · ProvinceService (resolve không dấu, shippingFeeFor freeship ≥ ngưỡng) · BannerService
│                    NotificationService (cài NotificationGateway: notify/notifyMany/notifyStaff/listMine/markRead/broadcast) · ContentService (faq/page/contact)
├── upload/          UploadController POST /uploads/media (Cloudinary user-media — đánh giá, minh chứng đổi trả)
├── health/          GET /health
├── system.controllers.ts   SystemPublicController (/settings/public, /provinces, /banners, /faqs, /pages/:slug, POST /contact) · NotificationController · AdminSystemController /admin/*
└── queryapi/        SystemQueryApi (setting, settingNumber, shippingFeeFor, resolveProvince, shopName) · audit
```

## 10. reporting ✅ PLAN-0011

```text
reporting                             schema reporting (daily_sales) — CHỈ ĐỌC xuyên schema (raw SQL SELECT, ngoại lệ có chủ đích)
├── reporting.service.ts   dashboard (hôm nay/tháng/7 ngày/top/trạng thái/phương thức + việc đang chờ) · revenue (ngày|tháng, kỳ trống = 0) · topProducts · lowStock · inventorySummary
│                          recomputeDay/recomputeRange (worker + admin) · cache Redis 60–300s
├── reporting.controllers.ts   /admin/reports/dashboard|revenue|top-products|low-stock|inventory · POST /admin/reports/recompute
└── reporting-worker.module.ts   DailySalesJob: khởi động bù 7 ngày · mỗi 5' hôm nay · 00:05 VN chốt hôm qua
```

## 11. ai ✅ PLAN-0012 / 0013

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

## Ma trận phụ thuộc

| Module gọi | queryapi của | Gateway cài | Outbox phát |
|---|---|---|---|
| common | — | — | — |
| identity | — | TokenValidation · PermissionAuthorization · UserDirectory | USER_REGISTERED · USER_LOCKED |
| catalog | — | CategoryStats | CATEGORY_CHANGED |
| product | catalog | Inventory · ProductStats | PRODUCT_PUBLISHED · PRODUCT_UPDATED · PRODUCT_HIDDEN · STOCK_LOW |
| cart | product | Cart | — |
| promotion | — | Promotion | — |
| order | product · cart · identity · system | OrderPayment | ORDER_CREATED · ORDER_STATUS_CHANGED · ORDER_CANCELLED · ORDER_PAID · ORDER_DELIVERED · RETURN_REQUESTED · RETURN_PROCESSED |
| payment | (order qua ORDER_PAYMENT_GATEWAY, lười) | Payment | PAYMENT_PAID · PAYMENT_REFUNDED |
| review | product · order · identity (UserDirectory) | — | REVIEW_CREATED · REVIEW_RATING_CHANGED |
| system | identity (UserDirectory: nhân viên theo quyền) | Notification | — |
| reporting | — (SELECT chỉ đọc xuyên schema) | — | — |
| ai | product · catalog · order · review · system · cart · promotion · payment · reporting · identity (UserDirectory) · Notification · CartGateway.addItem · OrderActionsGateway | — | — (tiêu thụ product/review) |
| order | (thêm) | OrderActions (ai huỷ đơn thay khách sau khi khách bấm Xác nhận) | |
