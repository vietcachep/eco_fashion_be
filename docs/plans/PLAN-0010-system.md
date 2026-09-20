# PLAN-0010 — System: tham số vận hành, tỉnh/thành, banner, thông báo, nội dung, upload

> Status: Done
> Owner: Agent
> Related Phase: Phase 1 — Nền tảng
> Related Roadmap: `docs/04_ROADMAP.md`

---

## 1. Mục tiêu

* `settings` (key → json; 12 khoá mặc định `SETTING_DEFAULTS`: tên shop, hotline, ngưỡng freeship, phí mặc định, timeout VNPay/CK, COD tối đa,
  auto-complete, cửa sổ đổi trả, tối đa/dòng giỏ) — `GET /settings/public` cho FE, admin sửa (cache Redis xoá sau commit).
* `provinces` 63 tỉnh/thành + vùng + phí ship; `resolve` khớp tên không dấu (FE nhập tay); `shippingFeeFor(subtotal, tỉnh)` freeship ≥ ngưỡng.
* `banners` trang chủ (ảnh seed Pexels), `notifications` trong-app (cài `NotificationGateway`; `notifyStaff` theo mã quyền), `contact_messages`,
  `faqs`, `pages` (about/shipping/returns-policy/privacy/terms).
* `POST /uploads/media`: upload ảnh dùng chung cho khách đã đăng nhập (đánh giá, minh chứng đổi trả).

## 6. API

```text
GET /health · GET /settings/public · GET /provinces · GET /banners · GET /faqs · GET /pages/{slug} · POST /contact · POST /uploads/media
GET /notifications · POST /notifications/{id}/read · POST /notifications/read-all
GET /admin/settings · PUT /admin/settings/{key} · GET /admin/provinces · PATCH /admin/provinces/{code} · /admin/banners CRUD · POST /admin/notifications/broadcast · GET /admin/contacts · POST /admin/contacts/{id}/reply · /admin/faqs CRUD · GET /admin/pages · PUT /admin/pages/{slug}
```

## 7–8. Triển khai & kiểm thử

* [x] Services/controllers/SystemQueryApi · seed (`system.seed.ts`: tham số, 63 tỉnh, banner, FAQ, trang) · smoke (phí ship theo tỉnh, freeship, upload 201).
