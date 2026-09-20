# PLAN-0008 — Promotion: mã giảm giá

> Status: Done
> Owner: Agent
> Related Phase: Phase 3 — Mua hàng
> Related Roadmap: `docs/04_ROADMAP.md`

---

## 1. Mục tiêu

* Mã `percentage` (có trần), `fixed_amount`, `free_shipping`; điều kiện: đơn tối thiểu, thời gian, tổng lượt, lượt/khách, phạm vi
  (`all` | ngành hàng | sản phẩm), công khai (hiện ở `GET /promotions/offers`) hay riêng.
* `PromotionGateway`: `quote` (giảm thật cho giỏ hiện tại + lý do không áp dụng + `missingAmount`), `consume` (FOR UPDATE, ghi `promotion_usages`
  unique theo mã đơn), `release` (huỷ đơn → nhả lượt, giữ dòng để truy vết).
* Admin CRUD + xem lượt dùng.

## 5. Thiết kế DB — schema `promotion`

`promotions` (`uq_promotions_code_active` upper(code)), `promotion_targets`, `promotion_usages` (unique promotion+order_code, `released_at`), audit.

## 6. API

```text
GET /promotions/offers · GET/POST /admin/promotions · GET/PATCH/DELETE /admin/promotions/{id} · GET /admin/promotions/{id}/usages
```

## 7–8. Triển khai & kiểm thử

* [x] Service/controllers/gateway · seed 5 mã (`promotion.seed.ts`) · smoke: FREESHIP luôn eligible khi giỏ có dòng; GIAM10 trần 50k; DAM100K chỉ ngành đầm; HETHAN báo hết hạn.
