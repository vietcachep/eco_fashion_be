# PLAN-0006 — Order: checkout, vòng đời đơn, đổi trả

> Status: Done
> Owner: Agent
> Related Phase: Phase 3 — Mua hàng
> Related Roadmap: `docs/04_ROADMAP.md`
> Hợp đồng FE: `docs/06_FE_CONTRACT.md` (mục order / payment / promotion)

---

## 1. Mục tiêu

* `GET /checkout/summary` tính đủ: subtotal (dòng đã tick), phí ship theo tỉnh (`SystemQueryApi.shippingFeeFor`, freeship ≥ ngưỡng),
  giảm giá (`PromotionGateway.quote`), cảnh báo dòng hết hàng.
* `POST /orders` (header `Idempotency-Key`) trong MỘT transaction: mã đơn `DHyymmddNNNN` (`order_sequences` FOR UPDATE), snapshot địa chỉ
  (có sẵn hoặc nhập tay) + dòng + tiền, `InventoryGateway.reserve`, `PromotionGateway.consume`, `CartGateway.removeLines`,
  `PaymentGateway.initiate` (COD / VietQR intent / VNPay URL), thông báo + outbox `ORDER_CREATED`.
* Vòng đời: pending → confirmed (commit kho) → packing → shipping → delivered (COD = paid) → completed (auto sau N ngày);
  cancelled (khách khi pending; nhân viên trước shipping; job huỷ quá hạn thanh toán) → nhả/hoàn kho + nhả mã + hoàn tiền nếu đã trả.
* Đổi trả: khách gửi trong cửa sổ N ngày sau giao, ≥1 minh chứng (MediaItem), hoàn theo tỉ lệ giảm; nhân viên duyệt/từ chối; kế toán
  ghi nhận hoàn (`ORDER_PAYMENT_GATEWAY.markReturnRefunded`) → `partially_refunded`.
* `OrderQueryApi`: purchasedItem/markItemsReviewed (review), recentOrders/findByCodeForUser (chatbot), boughtTogether/purchasedProductIds (AI).

## 5. Thiết kế DB — schema `order`

`orders` (code unique, snapshot địa chỉ/tiền/khuyến mãi, mốc thời gian từng trạng thái, `payment_expires_at`) · `order_items` (`reviewed`) ·
`order_status_histories` · `return_requests` (+`return_request_items`, `evidence` json) · `order_sequences` · audit/outbox/processed/idempotency.
CHECK tiền ≥ 0. Migration `20260915110000_shop_modules_init`.

## 6. API

```text
GET /checkout/summary?voucherCode · POST /orders (Idempotency-Key) · GET /orders · GET /orders/{code} · POST /orders/{code}/cancel
POST /orders/{code}/returns · GET /returns
GET /admin/orders · GET /admin/orders/{code} · PUT /admin/orders/{code}/status · POST /admin/orders/{code}/cancel
GET /admin/returns · GET /admin/returns/{id} · POST /admin/returns/{id}/process (approve|reject; kế toán ghi hoàn qua /admin/refunds/{id}/process)
```

## 7. Bước triển khai

* [x] B1 schema/migration · [x] B2 repository (nextCode, FOR UPDATE) + mapper (badge/canCancel/canReturn) · [x] B3 OrderService (summary, placeOrder, cancel, status)
* [x] B4 ReturnService · [x] B5 OrderWorkerModule (relay order+payment, mail theo sự kiện, job huỷ quá hạn / auto-complete) · [x] B6 seed 14 đơn (`order.seed.ts`) · smoke · docs

## 8. Kiểm thử

* [x] Smoke compose: giỏ → summary (phí theo tỉnh, mã KM/hết hạn) → đặt COD (Idempotency-Key 2 lần = 1 đơn, giỏ trống, reserved) →
  confirmed (trừ kho) → packing → shipping → delivered (COD paid) → đổi trả (hoàn theo tỉ lệ giảm) → duyệt → hoàn → partially_refunded;
  huỷ đơn đã trả → refund requested + nhả mã. Outbox DONE, mail vào mailpit.

## 9. Ghi chú
OrderModule là `@Global` (cung cấp `ORDER_PAYMENT_GATEWAY`); PaymentService lấy cổng này LƯỜI qua `ModuleRef` để tránh vòng DI treo lúc khởi động.
