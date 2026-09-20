# explain.md — Template giải thích luồng code

Dùng khi user yêu cầu **"giải thích luồng code"** (hoặc tương đương) và **trước khi bắt đầu một bước mới
trong plan**. Bước viết test không cần sơ đồ — chỉ liệt kê case.

## 1. Sơ đồ luồng (bắt buộc)

```
[Client] <METHOD> <đường dẫn API>
   │  body: <RequestDto> (field chính)
   ▼
[<XxxController>]                                   ← <module>/<feature>/controller/
   │  1. @CurrentActor() actor  (JWT → AuthenticatedActor)         (common/security)
   │  2. @RequirePermission('<module.resource.action>')            (common/security → PermissionGuard)
   │  3. map Request → <XxxCommand> (+ actor/ip/ua/requestId)      ← command/
   ▼
[<XxxService>.<method>]                             ← service/impl/   ← transaction bắt đầu ở đây
   │  a. <gateway/queryapi cross-module>                           (common/gateway → module khác)
   │  b. <validate ... else 4xx/409>                               ← repository/
   │  c. <snapshot / mutate entity / lock FOR UPDATE / version>    ← entity/
   │  d. <save> + audit "<ACTION>"                                 ← audit/
   │  e. <outbox "<EVENT_TYPE>" cùng transaction nếu có>          ← outbox/
   │  f. mapper → <XxxResponse>                                    ← mapper/ dto/
   ▼
[ApiResponse<XxxResponse>]                          (common/response)
```

## 2. Bảng file đụng tới (khi nhiều file)

| File | Tầng | Vai trò trong luồng |
|---|---|---|

## 3. Checklist phải nêu rõ

- **Ranh giới module**: chỗ gọi cross-module (qua gateway/queryapi), không import module khác.
- **Transaction**: mở/đóng ở đâu (`DataSource.transaction` / `EntityManager` trong service); gọi mạng
  (VNPay, OpenAI, Cloudinary, mail) phải NGOÀI transaction.
- **Audit**: action nào ghi audit DB.
- **Outbox/event**: có ghi không, `event_type` gì, listener nào xử lý.
- **Concurrency/lock**: optimistic (`version`) hay pessimistic (`FOR UPDATE`), unique index nào là chốt cuối.
- **Idempotency**: no-op khi nào, idempotency key nếu có.
- **Snapshot vs reference**: field nào là id sống, field nào là bản chép.
- **Quyết định cần chốt**: nếu còn lựa chọn, nêu bảng so sánh + đề xuất, hỏi user TRƯỚC khi code.

## Ví dụ (checkout)

```
[Client] POST /api/v1/orders   header Idempotency-Key
   │  body: CheckoutRequest (addressId, paymentMethod, promotionCode?, note?)
   ▼
[OrderController]                                   ← order/order/controller/
   │  1. @CurrentActor() (khách đã đăng nhập)
   │  2. map → CheckoutCommand (userId, idempotencyKey, ip, ua, requestId)
   ▼
[CheckoutService.checkout]                          ← order/order/service/impl/   ← transaction
   │  a. idempotency.begin(key, hash)  → trùng key khác hash 409, trùng hash trả kết quả cũ   (common/idempotency)
   │  b. CartQueryApi.selectedLines(userId)         (cart — queryapi, DTO)
   │  c. ProductQueryApi.priceSnapshot(variantIds)  (product — queryapi)
   │  d. AddressQueryApi.get(userId, addressId)     (identity — queryapi) → snapshot địa chỉ
   │  e. ShippingFeeService.quote(provinceCode)     ← order/shipping/
   │  f. PromotionGateway.quote(basket, code)       (common/gateway → promotion, đọc)
   │  g. InventoryGateway.reserve(lines)            (common/gateway → product, FOR UPDATE từng biến thể)
   │  h. OrderNoSequence.next()                     ← order/foundation (FOR UPDATE bảng sequence)
   │  i. OrderEntity + OrderItemEntity (snapshot tên/giá/ảnh)      ← entity/
   │  j. PromotionGateway.consume(code, orderId)    (ghi lượt, cùng transaction)
   │  k. CartGateway.removeLines(userId, variantIds)               (common/gateway → cart)
   │  l. save + audit "ORDER_PLACED"                                ← audit/
   │  m. outbox "ORDER_PLACED v1" (→ notification, ai)              ← outbox/
   │  n. idempotency.complete(key, response)
   ▼
[ApiResponse<OrderResponse>]  (201)
```
