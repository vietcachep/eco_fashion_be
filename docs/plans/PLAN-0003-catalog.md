# PLAN-0003 — Catalog: ngành hàng, bộ sưu tập, thuộc tính màu/size/chất liệu

> Status: Done
> Owner: Agent
> Related Phase: Phase 2 — Catalog & Product
> Related Roadmap: `docs/04_ROADMAP.md`
> Hợp đồng FE: `docs/06_FE_CONTRACT.md` (mục catalog)

---

## 1. Mục tiêu

* 7 ngành hàng quần áo (phẳng, có `parent_id` để mở rộng), ảnh, `product_count` đếm sẵn (product cập nhật qua gateway).
* Bộ sưu tập = **bộ lọc có sẵn** đúng như FE (`query{category,gender,tag}`), ảnh.
* Thuộc tính hệ thống `color` (hex) / `size` (nhóm áo/quần) / `material` — biến thể sản phẩm tham chiếu theo **mã**.
* Đọc công khai qua cache Redis 10'; ghi ở khu quản trị: transaction + audit; đổi slug/tên ngành hàng → outbox
  `CATEGORY_CHANGED` để product đồng bộ snapshot `category_slug` (worker).
* Seed kèm ảnh public (Pexels → Cloudinary, public_id cố định).

## 3. Phạm vi

### Trong
categories, collections, attributes/attribute_values, audit, outbox, cache, `CatalogQueryApi`, `CategoryStatsGateway`, seed + ảnh.

### Ngoài
Thương hiệu (đề tài một cửa hàng — permission `catalog.brand.manage` đánh dấu deprecated), cây nhiều cấp trên UI.

## 5. Thiết kế DB — schema `catalog`

`docs/database/catalog-product-database-design.md`. Migration `20260915080000_catalog_product_init` (chung với product):
partial unique slug sống cho categories/collections.

## 6. API

```text
GET /categories · GET /collections · GET /collections/{slug} · GET /attributes                       (công khai, cache)
GET/POST /admin/categories · GET/PATCH/DELETE /admin/categories/{id} · PUT /admin/categories/{id}/image
GET/POST /admin/collections · PATCH/DELETE /admin/collections/{id} · PUT /admin/collections/{id}/image
PUT /admin/attributes/{code}/values · DELETE /admin/attributes/{code}/values/{valueCode}
```

## 7. Bước triển khai

* [x] B1: schema Prisma + migration (partial unique slug)
* [x] B2: repository/service/controller category, collection, attribute (+ ảnh Cloudinary)
* [x] B3: CatalogQueryApi + CategoryStatsGatewayImpl + outbox CATEGORY_CHANGED
* [x] B4: seed kèm ảnh (SeedImages: Cloudinary public_id cố định / tĩnh `/static/seed`)
* [x] B5: smoke + docs

## 8. Kiểm thử

* [x] verify xanh · migration:check sạch · seed 2 lần không trùng · smoke: GET categories/collections/attributes; đổi slug ngành
  hàng → sản phẩm cập nhật sau 3s (worker); xoá ngành còn sản phẩm → 400 `CATALOG_CATEGORY_HAS_PRODUCTS`; thêm/xoá màu.

## 9. Rủi ro / Ghi chú

* Quyết định: bộ sưu tập không có bảng nối sản phẩm — nó là bộ lọc (đúng FE); muốn "bộ sưu tập tuyển chọn tay" thì dùng `tag`.
* Quyết định: attribute_values xoá mềm; biến thể giữ snapshot tên/hex nên không vỡ.

## 10. Nhật ký

| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| 2026-09-15 | Toàn bộ B1–B5 | Ảnh: Openverse bị chặn mạng, Wikimedia Commons chất lượng kém → dùng Pexels (chọn tay qua Browser, tải qua CDN), lưu `scripts/seed/assets` + `NGUON-ANH.md` |

## 11. File đã đổi

```text
prisma/schema/catalog.prisma · src/modules/catalog/** · src/common/gateway/category-stats.gateway.ts
scripts/seed/catalog.seed.ts · scripts/seed/lib/seed-images.ts · scripts/seed/assets/catalog/**
```

## 13. Definition of Done

* [x] verify · migration:check · compose up · seed 2 lần · smoke · docs · commit local
