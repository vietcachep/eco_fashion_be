# PLAN-0009 — Review: đánh giá đã mua, trả lời shop, kiểm duyệt

> Status: Done
> Owner: Agent
> Related Phase: Phase 4 — Sau bán
> Related Roadmap: `docs/04_ROADMAP.md`
> Hợp đồng FE: `docs/06_FE_CONTRACT.md` (mục review)

---

## 1. Mục tiêu

* Chỉ khách **đã nhận hàng** (đơn delivered/completed, `OrderQueryApi.purchasedItem`) mới đánh giá, mỗi dòng đơn một lần (unique user+order_item);
  ảnh/video upload trước qua `POST /uploads/media` (Cloudinary, dùng chung cho đổi trả) → `media[]`.
* Hiện ngay (`approved`); nhân viên ẩn/hiện có lý do, trả lời thay shop (một trả lời/đánh giá, gọi lại = sửa).
* `avg_rating`/`review_count` ghi sang product qua `ProductStatsGateway.setRating` trong cùng tx (chỉ tính approved).
* Outbox `REVIEW_CREATED` → ai kiểm duyệt (nhãn đề xuất) + tóm tắt.
* Công khai che tên khách ("Nguyễn V. A."); `GET /reviews/me` cho trang tài khoản; `eligibility` để FE ẩn/hiện form.

## 5. Thiết kế DB — schema `review`

`reviews` (unique user_id+order_item_id, `media` json, `status` pending|approved|hidden, moderation_*), `review_replies`, audit/outbox/processed.
CHECK rating 1..5. Migration `20260915110000_shop_modules_init`.

## 6. API

```text
GET /products/{slug}/reviews?page&size&rating · GET /products/{slug}/reviews/eligibility · POST /products/{slug}/reviews
GET /reviews/me · PATCH /reviews/me/{id} · DELETE /reviews/me/{id} · POST /uploads/media (multipart file)
GET /admin/reviews?status&rating&q · PUT /admin/reviews/{id}/moderate · POST /admin/reviews/{id}/reply
```

## 7. Bước triển khai

* [x] B1 schema/migration · [x] B2 ReviewService + controllers + ReviewQueryApi · [x] B3 UploadController (system) · [x] B4 relay outbox review ở AiWorkerModule
* [x] B5 seed đánh giá gắn đơn demo + rating (`review.seed.ts`) · test thuần (maskName) · smoke · docs

## 8. Kiểm thử

* [x] Smoke: eligibility → viết (201) → lần 2 409 REVIEW_ALREADY_REVIEWED → rating sản phẩm cập nhật → admin reply → ẩn (rating về 0/0) → hiện lại;
  worker: REVIEW_CREATED → moderation flag (LLM) ghi `ai.moderation_flags`.
