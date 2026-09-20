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
| `POST /api/v1/auth/register` `{email,password,full_name/fullName,phone?}` | ✅ | như login (đăng nhập luôn) |
| `POST /api/v1/auth/forgot-password` | ✅ | `message` |
| `POST /api/v1/auth/reset-password` `{email,otp,newPassword}` | ✅ | |
| `POST /api/v1/auth/logout` `{refreshToken}` | ✅ | |
| `POST /api/v1/auth/refresh` `{refreshToken}` | ✅ | cặp mới |
| `POST /api/v1/auth/google` `{idToken}` | 0002b | như login; tạo user `customer` nếu email chưa có |
| `GET /api/v1/auth/me` | ✅ | hồ sơ + `permissionCodes` |
| `PUT /api/v1/users/me` `{fullName,phone}` | 0002b (alias của PATCH) | `UserProfileResponse` |
| `POST /api/v1/users/me/change-password` `{currentPassword,newPassword}` | 0002b (alias của `/auth/change-password`) | |
| `GET/POST /api/v1/users/me/addresses`, `PATCH/DELETE .../{id}`, `PUT .../{id}/default` | ✅ | `AddressResponse{id,recipientName,phone,provinceName,districtName,wardName,street,isDefault}` |

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
| Đánh giá ở chi tiết | `GET /products/{slug}/reviews?page&size&rating` ✅ | `PageResponse<ReviewResponse{id,author(che tên),avatarUrl,rating,content,variantLabel,media[],images[],reply{staffName,content,createdAt},createdAt}>` + `summary{avgRating,reviewCount,distribution{1..5}}` |

## cart / wishlist (PLAN-0005)

✅ `GET /cart` · `POST /cart/items {variantId,quantity}` · `PATCH /cart/items/{variantId} {quantity}` · `PATCH .../select {selected}` · `DELETE /cart/items/{variantId}` ·
`DELETE /cart` — dòng `{variantId,productId,slug,name,imageUrl,color,size,unitPrice,quantity,maxQuantity,lineTotal,selected,isSellable}` + `subtotal,itemCount`.
`GET /wishlist` (thẻ) · `POST /wishlist/{productId}` · `POST .../toggle` · `DELETE /wishlist/{productId}`. Khách chưa đăng nhập: FE giữ local; đăng nhập → `POST /cart/merge {lines:[{variantId,quantity}]}` — **cộng dồn** vào dòng đã có (FE chỉ gửi phần chênh so với giỏ server để bản sao giỏ cũ không bị cộng đôi).

## order / payment / promotion (PLAN-0006/0007/0008) ✅

- `GET /checkout/summary?voucherCode=` → `CheckoutSummaryResponse{subtotal,shippingFee,discount,total,promotionCode,promotionError,itemCount}`.
- `POST /orders` (header `Idempotency-Key`) body `{addressId? | address{recipientName,phone,provinceName,districtName,wardName,street}, paymentMethodCode: cod|bank_transfer|vnpay, note?, voucherCode?}`
  → `OrderResponse{code,status,paymentMethodCode,paymentStatus,recipientName,recipientPhone,shippingAddress,customerNote,items[...],subtotal,shippingFee,discount,promotion{code,name},total,paymentIntent{bankCode,accountNumber,accountName,transferContent,qrUrl} | null, paymentUrl (VNPay) | null,history[{toStatus,createdAt,note}],createdAt}`.
- `GET /orders?page&size&status` (tóm tắt `OrderSummaryResponse`) · `GET /orders?full=true` → `PageResponse<OrderResponse>` đầy đủ items/history (size ≤ 20, cho màn "Đơn của tôi" hiện món + nút hành động không cần gọi từng đơn), `GET /orders/{code}`, `POST /orders/{code}/cancel {reason}`, `POST /orders/{code}/returns {reason,detail,items,evidence[]}`, `GET /returns`.
- `GET /promotions/offers` → `PromotionOfferResponse[]` (giảm thật cho giỏ hiện tại, `eligible`, `displayMissingAmount`).
- VNPay: `GET /payments/vnpay/return` (FE trang `/checkout/vnpay-return` gọi lại với query VNPay), `GET /payments/vnpay/ipn` (server-to-server), `POST /payments/vnpay/retry/{code}` (lấy URL mới khi còn hạn). `GET /payment-methods` → `{code,name,description,kind,isActive}` (chỉ cái đang bật).

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

Khi BE thêm/đổi route: cập nhật bảng này TRƯỚC, rồi báo FE chạy `api:sync`.
