# PLAN-0007 — Payment: COD, chuyển khoản VietQR, VNPay, hoàn tiền

> Status: Done
> Owner: Agent
> Related Phase: Phase 3 — Mua hàng
> Related Roadmap: `docs/04_ROADMAP.md`

---

## 1. Mục tiêu

* Ba phương thức bật/tắt được (`payment_methods`): **COD** (thu khi giao, giới hạn `order.cod_max_amount`), **chuyển khoản** (intent VietQR
  `img.vietqr.io` với nội dung = mã đơn, kế toán đối soát tay), **VNPay v2.1.0** (thẻ ATM/Visa/Master/QR — thay cho form thẻ mô phỏng của FE;
  BE KHÔNG bao giờ nhận số thẻ/CVV/OTP).
* VNPay: `buildPayUrl` HMAC-SHA512, `return` (FE) + `IPN` (server) đều xác minh chữ ký và ghi nhận idempotent theo unique (type, provider_ref);
  refund qua API merchant; mã phản hồi → thông điệp tiếng Việt.
* Hoàn tiền: yêu cầu (huỷ đơn đã trả / đổi trả duyệt) → kế toán xử lý (gateway hoặc chuyển khoản tay, ghi provider_ref) → order nhận `onRefunded`.
* `PaymentGateway` (order gọi): initiate/cancel/markCodCollected/requestRefund/isMethodActive.

## 5. Thiết kế DB — schema `payment`

`payment_methods` (code pk) · `payments` (một payment sống / đơn — `uq_payments_order_live`) · `payment_transactions` (unique (type, provider_ref)) ·
`bank_transfer_confirmations` · `refunds` · audit/outbox/processed. Migration `20260915110000_shop_modules_init`.

## 6. API

```text
GET /payment-methods · GET /payments/vnpay/return · GET /payments/vnpay/ipn · POST /payments/vnpay/retry/{orderCode}
GET /admin/payment-methods · PUT /admin/payment-methods/{code} · GET /admin/payments[/{id}] · POST /admin/payments/{id}/confirm-transfer
GET /admin/refunds · POST /admin/refunds/{id}/process
```

## 7. Bước triển khai

* [x] B1 schema/migration · [x] B2 VnpayService (sign/verify/refund) · [x] B3 PaymentService (initiate, IPN/return, đối soát, hoàn) + controllers
* [x] B4 outbox → mail (worker của order) · [x] B5 seed phương thức (`payment.seed.ts`) + giao dịch demo trong `order.seed.ts` · smoke · docs

## 8. Kiểm thử

* [x] Test thuần chữ ký VNPay; smoke: VietQR intent, đối soát (lần 2 → ALREADY_PAID), COD collect khi giao, hoàn tay sau đổi trả.
* [ ] VNPay sandbox thật cần `EF_VNPAY_TMN_CODE/HASH_SECRET` do chủ dự án đăng ký (IPN không tới localhost → return handler cũng ghi nhận).

## 9. Ghi chú
Không log token/secret/số thẻ; `gateway_response` chỉ giữ mã phản hồi + mã giao dịch.
