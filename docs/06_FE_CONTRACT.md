# 06 — Hợp đồng với FE bán hàng (`fashion_frontend_user`)

FE (Next.js, FITLY) đang chạy trên mock và tự khai DTO theo khuôn `eco_backend` (snake_case). Khi nối BE này, FE chạy
`API_SPEC_URL=http://localhost:4000/docs/openapi.json npm run api:sync` (Orval sinh type từ Swagger) và **bóc envelope trong hook** — nên BE giữ quy ước của
mình (camelCase, `ApiResponse{success,message,data,error{code,message,path,details},requestId}`,
`PageResponse{content,page,size,totalElements,totalPages}`), nhưng **tên trường, ngữ nghĩa, route và tham số lọc**
phải khớp 1-1 với màn hình FE để việc nối chỉ là đổi nguồn dữ liệu (FE Rule "gắn API = giữ nguyên giao diện").

Quyết định chung (đã chốt với `features/identity/api/auth-api.ts` của FE — nó nhận cả camelCase lẫn snake_case):

| Chủ đề | FE mong | BE | Ghi chú |
|---|---|---|---|
| id | `number` | `string` uuid | FE type `id: number \| string`; Orval sinh lại là xong |
| Tiền | `MoneyResponse{amount,display,currency,symbol}` | `MoneyResponse{amount: "159000", display: "159.000 ₫", currency:"VND", symbol:"₫"}` | BE tính mọi số tiền (Money Rule của FE) |
| Body có cả `full_name` lẫn `fullName` | — | `ValidationPipe whitelist: true, forbidNonWhitelisted: false` | key lạ bị BỎ, không 400 |
| Thẻ quốc tế (`card` + số thẻ) | form mô phỏng | **VNPay** redirect (`paymentUrl`), BE KHÔNG nhận số thẻ | FE gửi `paymentMethodCode: "vnpay"` (hoặc `card` → BE hiểu là VNPay thẻ quốc tế) |
| Địa chỉ | nhập tay tỉnh/huyện/xã (chuỗi) | `provinceName` bắt buộc, `provinceCode` tuỳ chọn (BE tự khớp theo tên với `system.provinces` để tính phí ship) | |

## identity (PLAN-0002 + 0002b)

| FE gọi | BE route | Response |
|---|---|---|
| `POST /api/v1/auth/login` `{email,password}` | ✅ | `{accessToken, refreshToken, accessExpiresIn, tokenType:"bearer", user{id,email,fullName,roleCode,status,avatarUrl,phone,createdAt}}` |
| `POST /api/v1/auth/register` `{email,password,full_name/fullName,phone?}` | ✅ | như login (đăng nhập luôn). OTP đúng ⇒ `emailVerifiedAt` được đặt ngay (từ 2026-10-04; tài khoản nhân viên gian hàng do chủ shop tạo để `emailVerifiedAt` rỗng — xem mục "thêm nhân viên gian hàng") |
| `POST /api/v1/auth/forgot-password` | ✅ | `message` |
| `POST /api/v1/auth/reset-password` `{email,otp,newPassword}` | ✅ | |
| `POST /api/v1/auth/logout` `{refreshToken}` | ✅ | |
| `POST /api/v1/auth/refresh` `{refreshToken}` | ✅ | cặp mới |
| `POST /api/v1/auth/google` `{idToken}` | 0002b | như login; tạo user `customer` nếu email chưa có |
| `GET /api/v1/auth/me` | ✅ | hồ sơ + `permissionCodes` |
| `PUT /api/v1/users/me` `{fullName,phone}` | 0002b (alias của PATCH) | `UserProfileResponse` |
| `POST /api/v1/users/me/change-password` `{currentPassword,newPassword}` | 0002b (alias của `/auth/change-password`) | |
| `GET/POST /api/v1/users/me/addresses`, `PATCH/DELETE .../{id}`, `PUT .../{id}/default` | ✅ | `AddressResponse{id,recipientName,phone,provinceName,districtName,wardName,street,isDefault}` |
| `POST /api/v1/admin/users` `{email,fullName,roleCode,password,phone?}` (web quản trị `/identity/users`, nút "Tạo nhân viên") | ✅ có sẵn | `UserProfileResponse` — quyền `identity.user.create`; TẠO NHÂN VIÊN SÀN: `roleCode` ∈ `admin\|manager\|sales\|warehouse\|accountant\|marketing` (không tạo được `customer`/`shop_owner`/`shop_staff`); đổi vai/sửa hồ sơ `PATCH /admin/users/{id}`, khoá/mở khoá `PUT /admin/users/{id}/status`, đặt lại mật khẩu `POST /admin/users/{id}/reset-password`. Nhân viên GIAN HÀNG thì do chủ shop thêm bằng `POST /shop/members` (mục "thêm nhân viên gian hàng") |

## catalog + product (PLAN-0003/0004)

| FE cần (mock) | BE route | Trường (camelCase) |
|---|---|---|
| `DANH_MUC` | `GET /categories` ✅ | `{id,slug,name,imageUrl,productCount}` (chỉ ngành hàng đang bán) |
| `BO_SUU_TAP` | `GET /collections` ✅ (+ `/collections/{slug}`) | `{id,slug,name,tagline,imageUrl,query{category?,gender?,tag?}}` |
| `MOI_MAU`, `MOI_SIZE` (bộ lọc) | `GET /products/filters` ✅ (+ `GET /attributes` đầy đủ) | `{colors[{code,name,hex}], sizes[], priceRange{min,max}}` — chỉ màu/size đang có hàng |
| `SAN_PHAM` + `ProductQuery` | `GET /products?q&category&gender&size&color&minPrice&maxPrice&sale&tag&sort&page&pageSize` ✅ | `PageResponse<ProductCardResponse>`; `size` = size quần áo, cỡ trang là `pageSize` (mặc định 12); sort = `featured\|newest\|bestselling\|priceAsc\|priceDesc`; `q` không dấu / gõ sai vẫn ra |
| `ProductCardResponse` | — ✅ | `{id,slug,name,categorySlug,gender(nam\|nu\|unisex),price,listPrice,imageUrl,hoverImageUrl,colors[{code,name,hex,imageUrl}],sizes[],avgRating,reviewCount,soldCount,isNew,badge,inStock}` |
| `chiTietSanPham(slug)` | `GET /products/{slug}` ✅ | Card + `{shortDescription,description,images[{id,url,color,colorCode,isPrimary}],variants[{id,color,colorCode,size,sku,stock(có thể bán),price}],material,care[]}` |
| `getProductsByIds` (so sánh, yêu thích) | `GET /products/by-ids?ids=a,b,c` ✅ | thẻ theo thứ tự ids |
| `searchProducts(q)` | `GET /products/suggest?q=&limit=` ✅ | thẻ (≤ 8) |
| `getFeaturedProducts` | `GET /products?sort=bestselling&pageSize=8` ✅ | |
| `related-products` | `GET /products/{slug}/related` ✅ | thẻ cùng ngành hàng |
| Đánh giá ở chi tiết | `GET /products/{slug}/reviews?page&size&rating` ✅ | `PageResponse<ReviewResponse{id,author(che tên),avatarUrl,rating,content,variantLabel,media[],images[],reply{staffName,content,createdAt},createdAt}>` + `summary{avgRating,reviewCount,distribution{1..5}}`; `reply.staffName` = tên shop hiện tại nếu shop trả lời, "Sàn FITLY" nếu nhân viên sàn trả lời — không bao giờ là họ tên người |

## cart / wishlist (PLAN-0005)

✅ `GET /cart` · `POST /cart/items {variantId,quantity}` · `PATCH /cart/items/{variantId} {quantity}` · `PATCH .../select {selected}` · `DELETE /cart/items/{variantId}` ·
`DELETE /cart` — dòng `{variantId,productId,slug,name,imageUrl,color,size,unitPrice,quantity,maxQuantity,lineTotal,selected,isSellable}` + `subtotal,itemCount`.
`GET /wishlist` (thẻ) · `POST /wishlist/{productId}` · `POST .../toggle` · `DELETE /wishlist/{productId}`. Khách chưa đăng nhập: FE giữ local; đăng nhập → `POST /cart/merge {lines:[{variantId,quantity}]}` — **cộng dồn** vào dòng đã có (FE chỉ gửi phần chênh so với giỏ server để bản sao giỏ cũ không bị cộng đôi).

## order / payment / promotion (PLAN-0006/0007/0008) ✅

- `GET /checkout/summary?voucherCode=` → `CheckoutSummaryResponse{subtotal,shippingFee,discount,total,promotionCode,promotionError,itemCount}`.
- `POST /orders` (header `Idempotency-Key`) body `{addressId? | address{recipientName,phone,provinceName,districtName,wardName,street}, paymentMethodCode: cod|bank_transfer|vnpay|payos, note?, voucherCode?}`
  → `OrderResponse{code,status,paymentMethodCode,paymentStatus,recipientName,recipientPhone,shippingAddress,customerNote,items[...],subtotal,shippingFee,discount,promotion{code,name},total,paymentIntent{bankCode,accountNumber,accountName,transferContent,qrUrl} | null, paymentUrl (VNPay) | null,history[{toStatus,createdAt,note}],createdAt}`.
- `GET /orders?page&size&status` (tóm tắt `OrderSummaryResponse`) · `GET /orders?full=true` → `PageResponse<OrderResponse>` đầy đủ items/history (size ≤ 20, cho màn "Đơn của tôi" hiện món + nút hành động không cần gọi từng đơn), `GET /orders/{code}`, `POST /orders/{code}/cancel {reason}`, `POST /orders/{code}/returns {reason,detail,items,evidence[]}`, `GET /returns`.
- `GET /promotions/offers` → `PromotionOfferResponse[]` (giảm thật cho giỏ hiện tại, `eligible`, `displayMissingAmount`).
- VNPay: `GET /payments/vnpay/return` (FE trang `/checkout/vnpay-return` gọi lại với query VNPay), `GET /payments/vnpay/ipn` (server-to-server), `POST /payments/vnpay/retry/{code}` (lấy URL mới khi còn hạn). `GET /payment-methods` → `{code,name,description,kind,isActive}` (chỉ cái đang bật; `payos` chỉ có mặt khi backend có khoá PayOS — xem mục "marketplace" bên dưới).

## review (PLAN-0009) ✅

`GET /products/{slug}/reviews/eligibility` → `{canReview,orderCode,variantLabel,reason}` (FE ẩn/hiện form) · `POST /products/{slug}/reviews {rating,content(≥10),media[{type,url,name}]≤5}`
(ảnh upload trước qua `POST /uploads/media` multipart `file` → `{type:"image",url,name}`; cùng route cho minh chứng đổi trả) ·
`GET /reviews/me` → `PageResponse<MyReviewResponse{id,productId,productName,productSlug,imageUrl,rating,content,media[],variantLabel,status,createdAt}>` ·
`PATCH/DELETE /reviews/me/{id}` · `GET /ai/review-summary/{productId}` → `{summary,pros[],cons[],reviewCount} | null` (tóm tắt AI khi ≥ 3 đánh giá).

## system (PLAN-0010) ✅

`POST /contact {name,email,phone?,message}` · `GET /provinces` → `{code,name,region,shippingFee}` · `GET /banners` · `GET /faqs` · `GET /pages/{slug}` (about/shipping/returns-policy/privacy/terms) ·
`GET /settings/public` → `{shop.name, shop.hotline, shipping.free_threshold, …}` · `GET /notifications` (+ `POST .../{id}/read`, `read-all`).

## ai (PLAN-0012/0013) ✅

Khách vãng lai gửi header `X-Guest-Key` (chuỗi 8–64 ký tự FE tự sinh, lưu localStorage); lần đầu không có → BE trả `guestKey` trong response, FE lưu lại.
Đăng nhập thì chỉ cần Bearer. `GET /ai/status` → `{chat,chatLlm,chatActions,styleAnalysis,styleAnalysisLlm,tryOn,compare,collections,productFaq}` để FE ẩn/hiện nút.

- **Chatbot (agent)**: `POST /ai/chat {sessionId?, message, contextProductSlug?}` → `{sessionId, guestKey, message{id,text,products[ProductCardResponse],source(llm|rule),needHuman,supportRequestId,actions[{id,kind,summary,params}],suggestions[],tools[],createdAt}}`
  (thay `traLoiChatMock`: `text` + `products`). `contextProductSlug` = widget mở ở trang sản phẩm ("cái này" = sản phẩm đó). `suggestions` = chip câu hỏi tiếp.
  `actions` = thẻ **Xác nhận / Bỏ qua** (thêm giỏ, huỷ đơn) → `POST /ai/chat/sessions/{id}/actions/{actionId}/confirm|reject` (đăng nhập; confirm lần 2 → 404).
  Tin chứa số thẻ ngân hàng → 400 `AI_CHAT_CARD_DATA` (không lưu). `GET /ai/chat/sessions[/{id}]` lịch sử (mỗi tin có `actions`, `actionResult`, `suggestions`).
  `POST /ai/support {sessionId?,summary,email?}` nút "gặp nhân viên". SSE không dùng — FE mock cũng nhận nguyên câu.
- Gợi ý theo ảnh: `POST /ai/style-analysis` (multipart `image`, `gender?` nam|nu, `occasion?`) → `{id,imageUrl,analysis{dangNguoi,mauPhuHop[],phongCach,tuVan,gender,categories[],colorCodes[]},products[],source,guestKey}`
  (= FE `AiAnalysisResult` camelCase + `fetchAiSuggestedProducts`). `GET /ai/style-analysis/{id}` xem lại.
- Thử đồ 2D: `POST /ai/try-on` (multipart `image` + `productId` + `colorCode?`) → 202 `{jobId,status:"queued",pollAfterMs:3000,…}`; FE poll `GET /ai/try-on/{jobId}` tới
  `status: done` (`resultUrl`) hoặc `failed` (`error`); `GET /ai/try-on` lượt của tôi. 503 `AI_TRYON_NOT_CONFIGURED` khi thiếu token Replicate.
  Worker thử lại `TRYON_MAX_ATTEMPTS` lần (lỗi mạng tạm thời); trong lúc còn lượt job vẫn `processing` — chỉ `failed` ở lần cuối, FE cứ poll.
- Dải gợi ý (mỗi dải trả `{source, items[ProductCardResponse], generatedAt}` — `source` gửi lại trong events): `GET /ai/recommendations?limit` (for_you, thẻ),
  `GET /ai/products/{slug}/similar`, `GET /ai/products/{slug}/bought-together`, `GET /ai/cart-suggestions` (đăng nhập).
- `GET /ai/collections` → `{day, generatedByAi, collections[{title,subtitle,query,items[]}]}` (trang chủ, cache 24h; rỗng thì ẩn khối).
- `POST /ai/compare {slugs[2..3]}` → `{products[], criteria[{name,values[]}], verdicts[{slug,bestFor}], summary, generatedByAi}` (không AI → `criteria` rỗng, vẫn 3 thẻ).
- `GET /ai/products/{slug}/faq` → `{status: ready|pending|none, items[{question,answer}], isStale, updatedAt}` — `pending` thì thăm dò lại sau 3–5 giây.
- Tín hiệu: `POST /ai/events {productId, eventType: view|add_to_cart|click|impression, source?}` · `POST /ai/events/batch {events[≤50]}` (202, `{accepted}`; loại/nguồn lạ bị bỏ) · `POST /ai/events/view` (alias). FE gửi `impression` cho cả dải khi hiện, `click` khi bấm thẻ, kèm `source` của dải.
- `GET /ai/review-summary/{productId}` → `{summary,pros[],cons[],reviewCount} | null`.

## marketplace — đa gian hàng, đa ngành hàng, voucher sàn+shop, PayOS (PLAN-0014/0016/0017) ✅

Thay đổi hợp đồng cho web bán hàng (cộng thêm lên các mục trên):

- **Checkout nhiều shop**: `GET /checkout/summary?voucherCode=&voucherCodes=A,B` → thêm `vouchers[{code,scope(platform|shop),shopId,shopName,ok,error,discount}]` (mỗi mã khách nhập: nhận hay bị từ chối + lý do + số giảm THỰC áp) và `shopGroups[{shopId,shopName,itemCount,subtotal,shippingFee,discount,total}]`.
  `promotionCode`/`promotionError` giữ cho FE cũ (mã đầu được nhận / lỗi đầu tiên). Luật: tối đa **1 mã sàn + 1 mã gian hàng cho mỗi shop trong giỏ**; mã shop không có trong giỏ bị từ chối; mã sàn do SÀN chịu, mã shop do SHOP chịu.
- `POST /orders` thêm `voucherCodes?: string[]` (gộp với `voucherCode`). Trả `OrderGroupResponse{code (DHN…),recipientName,recipientPhone,shippingAddress,subtotal,shippingFee,discount,total,orders[OrderResponse],createdAt}` (đơn cha + `orders[]` đơn con theo shop, mỗi đơn con thanh toán riêng; giỏ 1 shop vẫn trả đúng dạng này — nhóm 1 đơn; nhóm KHÔNG có `status` riêng, đọc ở từng đơn con). Chọn VNPay thì body có thêm `bankCode?` (`VNBANK`\|`INTCARD`\|`VNPAYQR`). Mã bị từ chối ⇒ 400 `ORDER_PROMOTION_INVALID` với message `<MÃ>: <lý do>`;
  đơn con bị giảm hết (total = 0) ⇒ 409 `ORDER_PROMOTION_INVALID`; thành viên shop mua hàng shop mình ⇒ 409 `ORDER_SHOP_NOT_AVAILABLE`; shop tắt COD ⇒ 409 `ORDER_SHOP_COD_DISABLED`.
- `OrderResponse` thêm `shopId`, `shopName` (mỗi đơn thuộc ĐÚNG 1 shop), `shopPromotion{code,name}`, `shopDiscount`, `platformDiscount` (giảm của shop / giảm do sàn chịu), `promotion` là voucher SÀN.
- Đơn của tôi theo nhóm: `GET /orders/groups?page&size` → `PageResponse<OrderGroupResponse>` · `GET /orders/groups/{code}` (`code` = mã đơn CHA `DHN…`). Các route `GET /orders` (kể cả `?full=true`), `GET /orders/{code}`, `POST /orders/{code}/cancel`, `POST /orders/{code}/returns` làm việc theo mã đơn CON (`orders[].code`), không gộp nhóm.
- `GET /promotions/offers` → mỗi phần tử thêm `scope`, `shopId`, `shopName` (voucher sàn + voucher của từng shop CÓ TRONG GIỎ; số giảm tính trên riêng hàng của shop đó).
- **PayOS** (`paymentMethodCode: "payos"`, chỉ hiện ở `GET /payment-methods` khi backend có khoá): `paymentUrl` = link thanh toán (hết hạn 30 phút). Trang `/checkout/payos-return` gọi `GET /payments/payos/return?orderCode=<orderCode PayOS trong query>` → `{success,orderCode,status,message}`
  (BE hỏi lại PayOS rồi ghi nhận, idempotent). Thử lại link: `POST /payments/payos/retry/{orderCode}` → `{paymentUrl}` (`{orderCode}` = mã đơn CON của FITLY, KHÁC `orderCode` PayOS ở `/return`; đơn phải còn chờ thanh toán; 10 lần/10 phút/người; VNPay `POST /payments/vnpay/retry/{orderCode}` cũng theo mã đơn CON). `POST /payments/payos/webhook` là server-to-server (công khai, xác minh chữ ký) — FE không gọi. Mỗi đơn con có link riêng — FE thanh toán lần lượt từng đơn con.
- **Thanh toán đến muộn / trả trùng** do BE tự hoàn (không cần FE làm gì); khách thấy thông báo "Đơn đã huỷ — khoản thanh toán sẽ được hoàn".
- **Sản phẩm ngành động**: biến thể có `options[{attributeId,attributeValueId,displayValue,attributeName?}]` (attributeName = tên trục, vd "Màu sắc"; có từ 2026-10-04) thay vì chỉ `color/size` (ở ngành động `variants[].color/colorCode/size` là `null`); dòng giỏ/đơn của biến thể động có `color`/`size` là chuỗi tuỳ chọn ghép sẵn (vd "Đen" / "128GB") để UI cũ không hiện trống. Ngành lá có mẫu thuộc tính riêng: vendor đọc ở `GET /shop/catalog/categories/{slug}/attribute-template`, sàn ở `/admin/categories/{categoryId}/attributes` (xem hai mục dưới). Web bán hàng CHƯA có route công khai `GET /categories/{slug}`, và `GET /products/filters` CHƯA lọc theo thuộc tính động (chỉ màu/size/khoảng giá). Chi tiết sản phẩm (`GET /products/{slug}`) thêm `attributeValues[{attributeId,attributeName,attributeValueId (null nếu nhập tay),value}]` (thuộc tính cấp sản phẩm); `GET /categories` thêm `parentId` (dựng menu theo nhóm ngành) và `attributeMode` (`legacy_fashion`\|`dynamic` — chỉ `legacy_fashion` dùng bộ lọc màu/size/giới).
- **Gắn gian hàng vào thẻ**: `ProductCardResponse` (và chi tiết) thêm `shop{id,slug,name,logoUrl,ratingAvg}` (`ratingAvg` có thể null); dòng giỏ `GET /cart` thêm `shopSlug`, `shopName` (FE nhóm giỏ theo shop), kèm `sku` và `status` (`ok`\|`low_stock`\|`unavailable`) — dòng giỏ thực tế KHÔNG có `isSellable` như bảng cart ở trên. Ở `/admin/products` và `/shop/products` trường `shop` luôn `null`.
- **AI tìm bằng ảnh**: `POST /ai/image-search` (multipart `image` ≤ 5MB, jpeg/png/webp) → `{available, description?, keywords[], message?, items[ProductCardResponse]}` (`description` = mô tả ngắn do vision sinh, `keywords` ≤ 6, `items` ≤ 12 (CHỈ sản phẩm đúng ngành + đúng loại, không đệm cho đủ 12 — ít kết quả thì `message` có thêm câu "rất ít kết quả"; `keywords` = loại sản phẩm trước, rồi màu/chất liệu chỉ để hiển thị); cho cả khách vãng lai — gửi `X-Guest-Key`; 10 lần/giờ); `available:false` khi backend chưa có khoá OpenAI (FE ẩn nút hoặc báo "chưa khả dụng") — `GET /ai/status` có thêm cờ `imageSearch` cho việc này; không tìm thấy ⇒ `items: []` + `message` (vision lỗi ⇒ `available:true`, `items: []`, `message` báo thử lại, không ném lỗi).
- **Trang gian hàng công khai** (chỉ shop ĐÃ DUYỆT; chờ duyệt/khoá/từ chối ⇒ 404):
  `GET /shops?q=&page=&pageSize=` (`pageSize` ≤ 48, mặc định 12; điểm đánh giá cao trước) và `GET /shops/{slug}` → `{slug,name,logoUrl,bannerUrl,description,ratingAvg|null,reviewCount,productCount}`
  (`reviewCount` = tổng lượt đánh giá của sản phẩm đang bán; `productCount` = số sản phẩm đang bán). Sản phẩm của shop: `GET /products?shop=<slug>` (shop không tồn tại/chưa duyệt ⇒ danh sách rỗng).
  Hoa hồng, tài khoản ngân hàng, chủ shop, ví, đối soát KHÔNG lộ ra web bán hàng. Sản phẩm của shop bị khoá/chờ duyệt bị ẩn khỏi danh sách, gợi ý, `by-ids`, liên quan và chi tiết (404) — cache công khai có thể trễ (danh sách 60s, chi tiết 2 phút, liên quan 5 phút, bộ lọc 10 phút; BE KHÔNG xoá cache khi sàn đổi trạng thái shop, chỉ chờ hết hạn).
- Sửa lỗi lọc giá: `GET /products?minPrice=&maxPrice=` giờ áp CẢ HAI đầu (trước đây `maxPrice` đè mất `minPrice`).
- Thông báo cho khách: hoàn tiền, thanh toán đến muộn, đơn huỷ… qua `GET /notifications` như cũ (`type: order|payment`).

## vendor — cổng gian hàng `/shop/*` (PLAN-0014/0017)

Cho web quản trị (route `(vendor)`): chủ/nhân viên gian hàng tự vận hành CHÍNH shop của mình. Cơ chế chung của mọi route `/shop/**` (`src/modules/shop/security/shop-context.guard.ts`):

- Bearer access token như mọi route (JwtAuthGuard toàn cục chạy trước), rồi `ShopContextGuard` (gắn `@UseGuards` trên controller/route) làm ba việc theo thứ tự: (1) `userId` trong token → ShopMember `active` → `shopId`; không có ⇒ 403 `SHOP_NOT_MEMBER`; (2) đọc THẲNG `Shop.status` từ DB — chỉ `approved` đi tiếp, ngược lại ⇒ 403 `SHOP_NOT_APPROVED` (sàn khoá shop là 403 ngay cả khi ShopMember còn active); (3) route có `@RequireShopPermission(...)` thì mã quyền phải nằm trong quyền của vai ShopMember, thiếu ⇒ 403 `SHOP_FORBIDDEN` kèm `error.details.required` (cùng dạng với 403 quyền toàn cục).
- `shopId` KHÔNG BAO GIỜ nhận từ URL/query/body — chỉ suy từ phiên thành viên (mỗi người chỉ thuộc MỘT gian hàng active). `{id}`/`{code}` trên URL chỉ có nghĩa TRONG shop của mình; thuộc shop khác ⇒ 404 (không lộ có/không tồn tại).
- Mã `shop.*` kiểm bằng `@RequireShopPermission` (ShopContextGuard), KHÔNG phải `@RequirePermission`/PermissionGuard toàn cục: vai scope=shop (`shop_owner`, `shop_staff`) không gán vào `User.roleId` nên `GET /auth/me` → `permissionCodes` KHÔNG chứa `shop.*` — FE lấy mã ở `GET /shop/session` → `permissions[]`. Ngược lại tài khoản nhân viên sàn không là thành viên shop ⇒ `/shop/**` trả 403 `SHOP_NOT_MEMBER`.
- Ngoại lệ trạng thái: `GET /shop/session` và `POST /shop/members/leave` có `@AllowAnyShopStatus` — chạy cả khi shop `pending`/`suspended`/`rejected` (vẫn phải là thành viên active) để FE hiện màn "chờ duyệt"/"đã bị khoá". MỌI route khác yêu cầu shop `approved`.
- Vai (preset ban đầu ở `identity/permission/catalog.ts`): `shop_owner` = toàn bộ `shop.*`; `shop_staff` = `shop.profile.read`, `shop.staff.read`, `shop.product.read`, `shop.product.manage`, `shop.order.read`, `shop.order.update`, `shop.inventory.read`, `shop.review.read`, `shop.review.reply` (không nhân sự, kho-ghi, khuyến mãi, báo cáo, ví, đối soát, sửa hồ sơ).
- Vendor KHÔNG làm được: đổi `code`/`slug`/`status`/hoa hồng của shop; đặt `isFeatured`/`isNew`/`tags` cho sản phẩm (body tạo/sửa riêng — key lạ bị bỏ); chuyển đơn sang `completed`; thấy thông tin thanh toán của khách, `userId` thành viên. Hiện KHÔNG có route đăng ký/tạo gian hàng và KHÔNG có route vendor xử lý đổi trả (chỉ `/admin/returns`) — hiện shop chỉ được tạo bằng seed (`scripts/seed/marketplace.seed.ts`); nhân viên vào shop do chủ shop THÊM TRỰC TIẾP bằng `POST /shop/members` (tạo tài khoản cho nhân viên, có hiệu lực ngay, không mời/không chờ chấp nhận — mục "thêm nhân viên gian hàng" bên dưới).
- Ghi có `@RateLimit` theo user (số lần ghi ở cột ý nghĩa). Danh sách phân trang `page`/`size` (riêng `/shop/products`: `page`/`pageSize`).

| Route | Mã quyền | Ý nghĩa |
|---|---|---|
| **session · hồ sơ** | | |
| `GET /shop/session` | — (chỉ cần là thành viên active; `@AllowAnyShopStatus`) | Khởi động phiên: `{shop: ShopResponse, roleCode, roleName, permissions[]}` — FE dựng menu/ẩn nút theo `permissions`, hiện màn trạng thái nếu `shop.status` ≠ `approved` |
| `GET /shop/me` | `shop.profile.read` | Hồ sơ shop: `code, slug, name, logoUrl, bannerUrl, description, status, commissionRate, codEnabled, ratingAvg, totalProducts, ownerUserId, bankCode, bankAccountName, bankAccountNumberMasked` |
| `PATCH /shop/me` | `shop.profile.update` | Sửa `name/logoUrl/bannerUrl/description` (`null` = xoá) và tài khoản ngân hàng `bankCode` (BIN 6 số) + `bankAccountNumber` (6–20 số) + `bankAccountName` — gửi đủ cả ba hoặc không gửi; số tài khoản trả về luôn che `••••1234`; đổi ngân hàng được ghi audit và báo cho mọi thành viên shop |
| **members** | | |
| `GET /shop/members` | `shop.staff.read` | Nhân viên của shop (không có `userId`) |
| `POST /shop/members` | `shop.staff.invite` ("Thêm nhân viên vào gian hàng của mình (tạo tài khoản nhân viên)"; mã giữ tên cũ) | THÊM nhân viên `{email, fullName, password, roleCode: shop_owner\|shop_staff}` — chủ shop TẠO TÀI KHOẢN cho nhân viên, có hiệu lực ngay (KHÔNG mời, KHÔNG chờ chấp nhận); 201, trả `AddShopMemberResponse` (= `ShopMemberResponse` + `restored`); 30 lần/giờ; tối đa 50 thành viên active/shop; lỗi 409 `IDENTITY_EMAIL_EXISTS` · `SHOP_MEMBER_UNAVAILABLE` · `SHOP_MEMBER_LIMIT_REACHED`, 400 `IDENTITY_PASSWORD_WEAK` · `SHOP_ROLE_INVALID` (chi tiết ở mục "thêm nhân viên gian hàng") |
| `POST /shop/members/leave` | — (thành viên active; `@AllowAnyShopStatus`) | Tôi tự rời shop; chủ cuối cùng ⇒ 409 `SHOP_LAST_OWNER`; dùng được cả khi shop chưa duyệt/đã khoá |
| `PATCH /shop/members/{id}` | `shop.staff.update` | Đổi vai `{roleCode}` (không hạ chủ cuối cùng); `{id}` = id ShopMember; 60 lần/giờ |
| `DELETE /shop/members/{id}` | `shop.staff.remove` | Gỡ nhân viên (không gỡ chủ cuối cùng); 60 lần/giờ |
| **orders** (đơn CON của shop) | | |
| `GET /shop/orders?status&paymentStatus&paymentMethodCode&q` | `shop.order.read` | Danh sách `OrderSummaryResponse` của shop; `q` tìm mã đơn/tên/SĐT người nhận |
| `GET /shop/orders/summary` | `shop.order.read` | Đếm đơn theo trạng thái `{pending,confirmed,packing,shipping,delivered,completed,cancelled,returned}` |
| `GET /shop/orders/{code}` | `shop.order.read` | Chi tiết `OrderResponse` (không kèm thông tin thanh toán của khách) |
| `PUT /shop/orders/{code}/status` | `shop.order.update` | `{status: confirmed\|packing\|shipping\|delivered, trackingUrl? (chỉ https), note?}` theo thứ tự pending→confirmed→packing→shipping→delivered; KHÔNG được `completed` (quyền sàn) |
| `POST /shop/orders/{code}/cancel` | `shop.order.update` | `{reason 5–255}`; chỉ khi `pending`/`confirmed`, đóng gói trở đi ⇒ 409 `ORDER_CANNOT_CANCEL` |
| **reports** (dữ liệu của shop; `from`/`to` dạng `YYYY-MM-DD`, mặc định đầu tháng → hôm nay) | | |
| `GET /shop/reports/dashboard` | `shop.report.read` | Tổng quan: hôm nay, tháng này, việc đang chờ, 7 ngày, top 5, trạng thái đơn |
| `GET /shop/reports/revenue?from&to&granularity=day\|month` | `shop.report.read` | Doanh thu theo ngày/tháng (tối đa 400 ngày hoặc 60 tháng) |
| `GET /shop/reports/top-products?from&to&limit` | `shop.report.read` | Sản phẩm bán chạy của shop (`limit` ≤ 50, mặc định 10; tối đa 400 ngày) |
| `GET /shop/reports/low-stock?threshold&limit` | `shop.report.read` | Biến thể sắp hết (khả dụng ≤ `threshold`, mặc định 5; `limit` ≤ 500, mặc định 100) |
| **wallet** (ví quỹ COD) | | |
| `GET /shop/wallet` | `shop.wallet.read` | `{shopId, balance, codEnabled, pendingDeposit{id,amount}\|null}` — ví ≤ 0 thì COD bị khoá |
| `GET /shop/wallet/transactions` | `shop.wallet.read` | Sổ cái ví, mới nhất trước |
| `GET /shop/wallet/deposit-requests?status=pending\|approved\|rejected` | `shop.wallet.read` | Lịch sử yêu cầu nộp quỹ của shop |
| `POST /shop/wallet/deposit-requests` | `shop.wallet.deposit_request` | Xin nộp thêm quỹ `{amount ≥ 10.000, proofUrl?, note?}` → 201; mỗi lúc chỉ một yêu cầu chờ duyệt |
| **payouts** (đối soát/chi trả) | | |
| `GET /shop/payouts?status` | `shop.payout.read` | Các kỳ đối soát của shop (`status`: pending·processing·paid·failed·carried·settled); số TK chỉ `****1234`; lỗi cổng chi của kỳ `failed` bị thay bằng lời nhắn chung |
| `GET /shop/payouts/{id}` | `shop.payout.read` | `{payout, lines[{id,orderCode,kind,gross,commission}]}`; kỳ của shop khác ⇒ 404 |
| **products** | | |
| `GET /shop/products?q&category&gender&status&sort&page&pageSize` | `shop.product.read` | Sản phẩm của shop, MỌI trạng thái (draft/active/hidden) — thẻ + `status`; các lọc khác của `/products` (size/color/giá/sale/tag/shop) không có tác dụng |
| `GET /shop/products/{id}` | `shop.product.read` | `ProductAdminResponse` (thêm `status, tags, categoryId, totalStock, totalReserved, publishedAt…`) |
| `POST /shop/products` | `shop.product.manage` | Tạo sản phẩm NHÁP (kèm `variants?`, `attributeValues?`); không nhận `isNew/isFeatured/tags` |
| `PATCH /shop/products/{id}` | `shop.product.manage` | Sửa thông tin/giá/ngành hàng |
| `PUT /shop/products/{id}/variants` | `shop.product.manage` | Thay TOÀN BỘ biến thể (khớp màu×size hoặc tổ hợp trục → giữ id & tồn; thiếu = xoá mềm, 409 `PRODUCT_VARIANT_IN_USE` nếu đang giữ hàng/nằm trong phiếu nhập nháp); 120 lần/giờ |
| `PUT /shop/products/{id}/attributes` | `shop.product.manage` | Thay toàn bộ thuộc tính cấp sản phẩm (ngành động), kiểm theo mẫu thuộc tính của ngành; 120 lần/giờ |
| `POST /shop/products/{id}/publish` | `shop.product.manage` | Đăng bán (cần ≥ 1 biến thể, ≥ 1 ảnh, đủ thuộc tính bắt buộc của ngành) |
| `POST /shop/products/{id}/hide` | `shop.product.manage` | Ẩn khỏi web bán hàng |
| `DELETE /shop/products/{id}` | `shop.product.manage` | Xoá mềm |
| `POST /shop/products/{id}/images` | `shop.product.manage` | Thêm ảnh: multipart `file` (JPG/PNG/WEBP/GIF ≤ 5MB, kiểm nội dung thật; tối đa 12 ảnh) + `colorCode?`, `alt?`, `isPrimary?`; trả `ProductAdminResponse`; 60 lần/giờ |
| `PATCH /shop/products/{id}/images/{imageId}` | `shop.product.manage` | Đổi màu gắn / alt / đặt ảnh chính (không bỏ cờ chính của ảnh chính hiện tại — chọn ảnh khác) |
| `PUT /shop/products/{id}/images/order` | `shop.product.manage` | Sắp xếp `{imageIds[]}` (ảnh đầu = ảnh chính); 120 lần/giờ |
| `DELETE /shop/products/{id}/images/{imageId}` | `shop.product.manage` | Xoá ảnh; ảnh cuối của sản phẩm đang bán ⇒ 409 `PRODUCT_IMAGE_REQUIRED` |
| **inventory** (kho của shop) | | |
| `GET /shop/inventory/stock?q&lowStockOnly` | `shop.inventory.read` | Bảng tồn biến thể của shop |
| `GET /shop/inventory/stock/{variantId}/movements` | `shop.inventory.read` | Sổ kho 50 dòng gần nhất; biến thể shop khác ⇒ 404 |
| `GET /shop/inventory/receipts?status` | `shop.inventory.read` | Phiếu nhập của shop |
| `GET /shop/inventory/receipts/{id}` | `shop.inventory.read` | Chi tiết phiếu nhập |
| `POST /shop/inventory/receipts` | `shop.inventory.manage` | Lập phiếu nhập (nháp, chưa cộng tồn; mọi dòng phải là biến thể của shop) |
| `POST /shop/inventory/receipts/{id}/post` | `shop.inventory.manage` | Duyệt phiếu → cộng tồn + ghi sổ; header `Idempotency-Key` (gửi lại cùng key không cộng đôi) |
| `POST /shop/inventory/adjust` | `shop.inventory.manage` | Điều chỉnh tồn (kiểm kê/hư hỏng) kèm lý do, ghi sổ |
| **reviews** | | |
| `GET /shop/reviews` | `shop.review.read` | Đánh giá ĐÃ DUYỆT của sản phẩm thuộc shop — `ShopReviewResponse` (tên khách che, không `userId`/mã đơn/ghi chú kiểm duyệt) |
| `POST /shop/reviews/{id}/reply` | `shop.review.reply` | Trả lời một đánh giá đã duyệt `{content}` — hiện công khai dưới tên gian hàng |
| **promotions** (mã giảm giá của shop; mã duy nhất toàn hệ thống, shop chịu chi phí, chỉ áp cho đơn con của shop) | | |
| `GET /shop/promotions?q&active` | `shop.promotion.read` | Mã của shop (không nhận `scope`/`shopId` từ request) |
| `GET /shop/promotions/{id}` | `shop.promotion.read` | Chi tiết mã; mã của shop khác/mã sàn ⇒ 404 |
| `GET /shop/promotions/{id}/usages` | `shop.promotion.read` | Lượt dùng của mã (ẩn danh khách) |
| `POST /shop/promotions` | `shop.promotion.manage` | Tạo mã `scope=shop` gắn `shopId` của phiên |
| `PATCH /shop/promotions/{id}` | `shop.promotion.manage` | Sửa/bật tắt mã |
| `DELETE /shop/promotions/{id}` | `shop.promotion.manage` | Xoá mã |
| **catalog** (đọc để dựng form sản phẩm; dữ liệu dùng chung, không có route ghi) | | |
| `GET /shop/catalog/categories/leaves` | `shop.product.read` | Ngành LÁ đang bật `[{id,slug,name,parentName,path,attributeMode}]` — chỉ ngành lá nhận sản phẩm |
| `GET /shop/catalog/categories/{slug}/attribute-template` | `shop.product.read` | Mẫu thuộc tính `{categoryId,slug,name,attributeMode,attributes[{attributeId,code,name,inputType(select\|text\|number),required,isVariantAxis,sortOrder,values[{id,value,hex}]}]}`; `legacy_fashion` ⇒ `attributes` rỗng (form thời trang cũ) |

## thêm nhân viên gian hàng — chủ shop tạo tài khoản (PLAN-0017 §12, đổi 2026-10-13)

Luồng "lời mời → chấp nhận" (2026-10-04) đã **BỎ HẲN** theo quyết định của chủ dự án: không còn `GET/DELETE /shop/invitations`, `/me/shop-invitations/**`, bảng `shop_invitations`, email/thông báo lời mời, route `/account/invitations`. Nay chủ shop **THÊM nhân viên trực tiếp**: tạo tài khoản cho họ, có hiệu lực ngay, nhân viên đăng nhập luôn (web quản trị, cổng `/vendor`; `GET /shop/session` trả shop như thường).

- **`POST /shop/members`** (quyền `shop.staff.invite` — tên cũ giữ nguyên để khỏi đổi catalog/vai đã gán, mô tả hiển thị "Thêm nhân viên vào gian hàng của mình (tạo tài khoản nhân viên)"; chỉ `shop_owner` có; 30 lần/giờ/user ⇒ 429 `COMMON_RATE_LIMITED`; 201):
  body `{email, fullName, password, roleCode}` — `email` đúng định dạng (BE chuẩn hoá chữ thường), `fullName` 2–120 ký tự, `password` 8–64 ký tự **có cả chữ và số** (luật do identity kiểm), `roleCode` ∈ `shop_owner` · `shop_staff`.
  Response **`AddShopMemberResponse`** = `ShopMemberResponse` `{id, email, fullName, roleId, roleCode, roleName, status, isSelf, createdAt, updatedAt}` (KHÔNG có `userId`) **+ `restored: boolean`**.
- **Điều gì xảy ra**: chủ shop TẠO TÀI KHOẢN mới (vai identity `customer`, status `active`, `emailVerifiedAt` RỖNG, `createdBy` = chủ shop) + một dòng ShopMember `active` — CÙNG một transaction (lỗi giữa chừng ⇒ không để lại tài khoản mồ côi). Có hiệu lực ngay, không cần nhân viên chấp nhận. BE KHÔNG gửi email/thông báo nào cho nhân viên: **mật khẩu ban đầu do chủ shop đặt và tự gửi cho nhân viên** (FE nên nhắc chủ shop dặn nhân viên đổi mật khẩu sau lần đăng nhập đầu — `POST /users/me/change-password`; hiện BE chưa cưỡng bức đổi mật khẩu lần đầu).
- **Khôi phục nhân viên cũ** (`restored: true`): nếu email đã có tài khoản mà tài khoản đó **TỪNG là thành viên của CHÍNH shop này** (đã bị gỡ — `DELETE /shop/members/{id}` giữ lại tài khoản) và tài khoản còn `active`, là khách thường, không đang ở shop khác ⇒ kích hoạt lại dòng thành viên cũ với vai mới. **KHÔNG đổi mật khẩu/hồ sơ** — mật khẩu chủ shop vừa nhập KHÔNG được áp dụng (nhân viên dùng mật khẩu cũ của họ; chủ shop không bao giờ đặt lại mật khẩu của một tài khoản cá nhân). FE nên hiện thông báo khác khi `restored: true` ("Đã thêm lại nhân viên — họ dùng mật khẩu cũ"). Với tài khoản mới (`restored: false`) mới đúng là "mật khẩu vừa đặt".
- **Lỗi**:

| HTTP | Mã | Khi nào |
|---|---|---|
| 400 | `IDENTITY_PASSWORD_WEAK` | mật khẩu không đạt luật (8–64 ký tự, có chữ và số) |
| 400 | `SHOP_ROLE_INVALID` · `COMMON_VALIDATION_ERROR` | `roleCode` không phải vai shop · email/họ tên/độ dài mật khẩu sai |
| 403 | `SHOP_FORBIDDEN` (kèm `error.details.required: "shop.staff.invite"`) | thiếu quyền — nhân viên `shop_staff` không thêm được người |
| 409 | `IDENTITY_EMAIL_EXISTS` | email đã có tài khoản — dùng email khác. **Một mã chung** cả khi email thuộc người đang ở shop khác (không phân biệt để không dò được tài khoản của người khác); cũng là lỗi khi email là nhân viên đang `active` của chính shop này |
| 409 | `SHOP_MEMBER_LIMIT_REACHED` | shop đã đủ 50 thành viên `active` (`SHOP_MEMBER_MAX_ACTIVE`) — gỡ bớt người không còn làm việc rồi thêm lại; có khoá advisory theo shop nên không vượt khi nhiều request đồng thời |
| 409 | `SHOP_MEMBER_UNAVAILABLE` | khôi phục nhân viên cũ không được (tài khoản bị khoá / đang ở shop khác / đua ở chốt unique DB `uq_shop_members_one_active_per_user`) — thông điệp trung tính "hãy dùng email khác cho nhân viên", không nêu lý do |
| 429 | `COMMON_RATE_LIMITED` | quá 30 lần/giờ |

- **Các route còn lại của `/shop/members` KHÔNG đổi**: `GET /shop/members` (`shop.staff.read`), `PATCH /shop/members/{id}` `{roleCode}` (đổi vai, `shop.staff.update`), `DELETE /shop/members/{id}` (gỡ, `shop.staff.remove` — người bị gỡ GIỮ tài khoản và có thể được thêm lại bằng đúng email cũ = khôi phục), `POST /shop/members/leave` (tự rời). Chủ cuối cùng không bị hạ/gỡ/rời (409 `SHOP_LAST_OWNER`); mỗi người chỉ thuộc MỘT gian hàng active (DB chặn gốc bằng unique một phần `uq_shop_members_one_active_per_user`).
- **Audit / sự kiện** (không ảnh hưởng FE): `shop.audit_logs` ghi `SHOP_MEMBER_ADDED` (after `{roleCode, restored}`, không có email/mật khẩu); `identity.audit_logs` ghi `USER_CREATED` (after có `via: 'shop_staff'`); outbox `SHOP_MEMBER_JOINED` (chưa có listener). Dòng audit cũ `SHOP_INVITATION_*` vẫn nằm trong DB làm lịch sử.
- **Phía SÀN** (nhân viên sàn, không liên quan gian hàng): đã có sẵn, không đổi — `POST /admin/users` (quyền `identity.user.create`, xem bảng identity) + màn web quản trị `/identity/users` nút "Tạo nhân viên".
- **Đổi so với luồng lời mời (2026-10-04 → 2026-10-13) — FE cần làm theo**: `POST /shop/members` đổi body từ `{email, roleCode}` sang `{email, fullName, password, roleCode}` và response từ `ShopInvitationResponse` sang `AddShopMemberResponse`; GỠ màn "Lời mời" ở cổng vendor và route `/account/invitations` + mục thông báo "Lời mời tham gia gian hàng" ở web bán hàng; mã lỗi `SHOP_INVITATION_*` · `SHOP_MEMBER_EXISTS` · `SHOP_ALREADY_IN_SHOP` · `SHOP_MEMBER_NOT_ADDABLE` đã gỡ khỏi BE; `GET /me/shop-invitations` và `/shop/invitations` không còn (404).

## sàn — route quản trị marketplace `/admin/*` mới

Nhân viên SÀN (vai nền tảng admin/manager/kế toán…) thao tác XUYÊN mọi gian hàng. Gác bằng PermissionGuard toàn cục + `@RequirePermission` (mã `supplier.*` cho tài nguyên mới) — KHÔNG qua ShopContextGuard, nhân viên sàn không là thành viên shop nào. Thiếu quyền ⇒ 403 `COMMON_FORBIDDEN` kèm `error.details.required`. Preset: `admin` có tất cả; `manager` có `supplier.shop.*` + `supplier.wallet.read` + `supplier.payout.read`; `accountant` có `supplier.wallet.read/adjust` + `supplier.payout.read/process`.

| Route | Mã quyền | Ý nghĩa |
|---|---|---|
| **shops** | | |
| `GET /admin/shops?status&q` | `supplier.shop.read` | Danh sách gian hàng (`status`: pending·approved·suspended·rejected; `q` tìm mã/tên/slug) — `ShopResponse` (số TK che) |
| `GET /admin/shops/{id}` | `supplier.shop.read` | Chi tiết — `AdminShopResponse` thêm `bankAccountNumber` ĐẦY ĐỦ (để xác thực chi trả) |
| `PATCH /admin/shops/{id}/approve` | `supplier.shop.approve` | Duyệt (pending→approved) hoặc mở khoá lại (suspended→approved) |
| `PATCH /admin/shops/{id}/suspend` | `supplier.shop.suspend` | Khoá shop vi phạm (approved→suspended) `{reason 3–500}`; từ lúc này mọi `/shop/**` của shop 403 |
| `PATCH /admin/shops/{id}/reject` | `supplier.shop.reject` | Từ chối đăng ký (pending→rejected) `{reason 3–500}` |
| `PATCH /admin/shops/{id}/commission` | `supplier.shop.commission` | Sửa % hoa hồng `{commissionRate 0–100, tối đa 2 số lẻ}`, không hồi tố đơn cũ |
| **wallet** (ví quỹ COD của shop) | | |
| `GET /admin/wallets?lowOnly` | `supplier.wallet.read` | Ví của các shop `{shopId,shopName,balance,codEnabled,updatedAt}`; `lowOnly=true` = ví ≤ 0 (COD đang khoá) |
| `GET /admin/shops/{id}/wallet` | `supplier.wallet.read` | Ví một shop `{shopId,balance,codEnabled,pendingDeposit}` |
| `GET /admin/shops/{id}/wallet/transactions` | `supplier.wallet.read` | Sổ cái ví của một shop |
| `POST /admin/shops/{id}/wallet/adjust` | `supplier.wallet.adjust` | Điều chỉnh ví `{amount (VND nguyên, dương = cộng / âm = trừ), note ≥ 5 ký tự}` — vào sổ cái + nhật ký |
| `GET /admin/wallet-deposits?status=pending\|approved\|rejected` | `supplier.wallet.read` | Yêu cầu nộp quỹ của mọi shop |
| `POST /admin/wallet-deposits/{id}/approve` | `supplier.wallet.adjust` | Duyệt `{note?}` → cộng ví, mở lại COD khi ví > 0 |
| `POST /admin/wallet-deposits/{id}/reject` | `supplier.wallet.adjust` | Từ chối `{note}` (bắt buộc lý do) |
| **payouts** (đối soát/chi trả shop) | | |
| `GET /admin/payouts/payos-balance` | `supplier.payout.read` | Số dư tài khoản chi PayOS (chỉ đọc) |
| `POST /admin/payouts/run` | `supplier.payout.process` | Chạy kỳ đối soát toàn sàn `{periodStart, periodEnd}` (ISO; `periodEnd` không muộn hơn hiện tại); idempotent — chạy lại cùng kỳ không tạo trùng; trả các kỳ vừa tạo |
| `GET /admin/payouts?status&shopId` | `supplier.payout.read` | Danh sách kỳ đối soát (`status`: pending·processing·paid·failed·carried·settled) |
| `GET /admin/payouts/{id}` | `supplier.payout.read` | `{payout, lines[{id,orderCode,kind,gross,commission}]}` |
| `POST /admin/payouts/{id}/retry` | `supplier.payout.process` | Gửi lại lệnh chi PayOS (kỳ `failed`; `pending` khi đã có khoá payout; `processing` treo > 10 phút). Bị chặn trong 24 giờ sau khi shop đổi tài khoản ngân hàng; cần có khoá payout (không thì dùng `mark-paid`) |
| `POST /admin/payouts/{id}/mark-paid` | `supplier.payout.process` | Kế toán đánh dấu đã chi `{providerRef, note?}` (chuyển tay / đối chiếu `processing`). Từ `processing`/`failed` luôn được; từ `pending` chỉ khi CHƯA cấu hình khoá payout. PayOS chi thành công vẫn để kỳ ở `processing` (chưa có webhook payout) nên bước này là cách duy nhất để thành `paid` |
| **catalog đa ngành** | | |
| `GET /admin/categories/{categoryId}/attributes` | `catalog.category.read` | Mẫu thuộc tính của ngành hàng |
| `PUT /admin/categories/{categoryId}/attributes` | `catalog.category.manage` | Thay TOÀN BỘ mẫu thuộc tính (tối đa 2 trục biến thể) |
| `POST /admin/categories`, `PATCH /admin/categories/{id}` | `catalog.category.manage` | Body có `parentId?` và `attributeMode?` (`legacy_fashion`\|`dynamic`, mặc định `dynamic`); đổi `attributeMode` chỉ khi ngành CHƯA có sản phẩm, nếu không 409 `CATALOG_CATEGORY_MODE_LOCKED` |
| `GET /admin/dynamic-attributes`, `GET /admin/dynamic-attributes/{id}` | `catalog.dynamic_attribute.read` | Thuộc tính động dùng chung giữa các ngành |
| `POST /admin/dynamic-attributes`, `POST …/{id}/values`, `PUT …/{id}/values/{valueId}`, `DELETE …/{id}/values/{valueId}` | `catalog.dynamic_attribute.manage` | Tạo thuộc tính / thêm-sửa-xoá giá trị |

Route admin CÓ SẴN nhưng nay chạy xuyên mọi shop (route không đổi, ngữ nghĩa đổi):

- `/admin/orders*` (`order.order.read`), `PUT /admin/orders/{code}/status` (`order.order.status.update`, được cả `completed`), `POST /admin/orders/{code}/cancel` (`order.order.cancel`), `/admin/returns*` (`order.return.read/process`): thao tác trên đơn CON của MỌI shop. `GET /admin/orders` KHÔNG có bộ lọc shop và `OrderSummaryResponse` không có `shopId/shopName` (chi tiết `GET /admin/orders/{code}` thì có).
- `/admin/products*` (`product.product.read/create/update/publish/delete`) và `/admin/products/{id}/images*` (`product.product.update`): sửa/ẩn/xoá được sản phẩm của MỌI shop. `POST /admin/products` luôn tạo cho gian hàng chính chủ FITLY Official (không chọn shop; chưa seed shop này ⇒ `PRODUCT_SHOP_NOT_CONFIGURED`). `GET /admin/products` KHÔNG lọc theo shop (Swagger khai `shop` nhưng BE bỏ qua) và `shop` trong thẻ/chi tiết luôn `null`.
- `/admin/inventory*` (`product.inventory.read/receive/adjust`): kho của MỌI shop, bảng tồn không có thông tin/lọc theo shop (SKU chỉ duy nhất TRONG shop nên có thể trùng giữa các shop).
- `/admin/promotions*` (`promotion.promotion.read/manage`): `GET` có thêm lọc `scope` (`platform` hoặc `shop`) và `shopId`; `POST` luôn tạo mã SÀN (`scope=platform`); `PATCH/DELETE` áp được cả cho mã của shop (sàn bật/tắt).
- `/admin/reports/*` (`reporting.*`) tính trên TOÀN SÀN, không lọc theo shop. `/admin/reviews*` (`review.review.*`) kiểm duyệt/trả lời thay shop mọi đánh giá.
- `GET /admin/payments?methodCode=` (`cod`/`bank_transfer`/`vnpay`/`payos`; `payment.payment.read`), `POST /admin/refunds/{id}/process` (`payment.refund.process`): hoàn tiền của đơn con kéo theo đảo hoa hồng/ghi nợ ví COD của shop qua sự kiện (không có route riêng).
  - `RefundResponse` có thêm `kind` (`order` | `duplicate_payment` — khoản khách trả trùng: KHÔNG đổi `payment_status` của đơn, KHÔNG đảo hoa hồng, KHÔNG tính vào `refunded` của báo cáo) và `needsReconcile` (refund VNPay `failed` mà cổng từng được gọi nhưng không rõ kết quả).
  - `POST /admin/refunds/{id}/process` body `{providerRef?, note?, confirmGatewayNotRefunded?}`: hoàn tay cần `providerRef`; `needsReconcile` ⇒ người xử lý đối chiếu trên cổng VNPay rồi gửi `providerRef` (ĐÃ hoàn ⇒ chỉ ghi sổ, không gọi cổng) hoặc `confirmGatewayNotRefunded: true` (CHƯA hoàn ⇒ gọi lại cổng); thiếu cả hai ⇒ 409 `PAYMENT_REFUND_RECONCILE_REQUIRED`.
  - `POST /admin/refunds/{id}/retry-finalize` (`payment.refund.process`, không body, trả `RefundResponse`): cổng ĐÃ chi (refund `processing` + có `providerRef`) nhưng ghi sổ lỗi ⇒ chỉ ghi sổ nốt, KHÔNG gọi cổng; idempotent. Worker cũng tự phục hồi mỗi 5 phút (`recoverStuckRefunds`).

Khi BE thêm/đổi route: cập nhật bảng này TRƯỚC, rồi báo FE chạy `api:sync`.
