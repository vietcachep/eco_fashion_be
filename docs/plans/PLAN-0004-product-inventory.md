# PLAN-0004 — Product: sản phẩm, biến thể, ảnh, tồn kho

> Status: Done
> Owner: Agent
> Related Phase: Phase 2 — Catalog & Product
> Related Roadmap: `docs/04_ROADMAP.md`
> Hợp đồng FE: `docs/06_FE_CONTRACT.md` (mục product)

---

## 1. Mục tiêu

* Sản phẩm quần áo với biến thể **màu × size** (mã màu/size từ catalog, chép tên/hex snapshot), ảnh theo màu (Cloudinary),
  giá bán / giá gốc, nhãn thẻ (`-20%` / `Mới` / `Bán chạy`) do server tính, thống kê đếm sẵn (sold/review/view).
* Đường đọc công khai khớp FE: list (lọc q/category/gender/size/color/giá/sale/tag, sort, phân trang), chi tiết, bộ lọc,
  gợi ý gõ, theo ids, liên quan — tất cả qua cache Redis (list 60s, detail 120s, filters 10', related 5').
* Tìm kiếm: tsvector (unaccent, tiền tố từng từ) + `word_similarity` pg_trgm cho gõ sai/dính chữ ("aothun", "quan jen").
* Tồn kho: `stock`/`reserved`, mọi biến động khoá `FOR UPDATE` theo thứ tự id + sổ kho append-only; phiếu nhập
  (nháp → duyệt có `Idempotency-Key`), điều chỉnh kiểm kê; `InventoryGateway` reserve/release/commit/restock cho cart/order.
* Cổng: `ProductQueryApi` (snapshot biến thể cho giỏ/đơn, text nhúng AI), `ProductStatsGateway`, `InventoryGateway`.
* Seed 24 sản phẩm (đúng mock FE) kèm ảnh Pexels chọn tay đúng tên, phiếu nhập `PN-SEED-0001` đã duyệt.

## 3. Phạm vi

### Ngoài
Đánh giá (PLAN-0009), embedding (PLAN-0012), giá theo khách/khuyến mãi (PLAN-0008).

## 5. Thiết kế DB — schema `product`

`docs/database/catalog-product-database-design.md`. Sửa tay trong migration: partial unique slug/SKU sống, một ảnh chính,
CHECK tồn không âm & `reserved ≤ stock`, hàm `public.f_unaccent` IMMUTABLE, trigger `search_vector`, GIN tsvector + trigram.

## 6. API

```text
GET /products · /products/filters · /products/suggest · /products/by-ids · /products/{slug} · /products/{slug}/related   (công khai)
GET/POST /admin/products · GET/PATCH/DELETE /admin/products/{id} · PUT .../variants · POST .../publish · POST .../hide
POST/PATCH/PUT(order)/DELETE /admin/products/{id}/images[/{imageId}]
GET /admin/inventory/stock · GET .../stock/{variantId}/movements · GET/POST /admin/inventory/receipts · GET .../receipts/{id}
POST .../receipts/{id}/post (Idempotency-Key) · POST /admin/inventory/adjust
```

## 7. Bước triển khai

* [x] B1: schema + migration (sửa tay index/trigger)
* [x] B2: repository (list/search/facets), mapper (card/detail/admin), DTO/request
* [x] B3: ProductQueryService (cache) + ProductService (ghi, biến thể, đăng/ẩn/xoá) + ProductImageService
* [x] B4: InventoryRepository/Service (khoá dòng, sổ kho, phiếu nhập idempotent, điều chỉnh) + gateway impls + QueryApi
* [x] B5: ProductWorkerModule (relay outbox catalog+product, listener CATEGORY_CHANGED, dọn idempotency)
* [x] B6: seed 24 sản phẩm + ảnh; test thuần (badge, ảnh theo màu, sortSizes, makeSku, query); smoke; docs

## 8. Kiểm thử

* [x] 22 test xanh · migration:check sạch · seed 2 lần không trùng (24 sp, 220 biến thể, 92 ảnh, tồn 2.824)
* [x] Smoke compose: list/lọc/sort/tìm không dấu/gõ sai/chi tiết/liên quan/by-ids/404; RBAC (warehouse tạo sp 403);
  tạo nháp → mã màu sai 400 → publish thiếu ảnh 400 → upload ảnh gắn màu (Cloudinary) → publish → product_count +1 →
  phiếu nhập lập/duyệt (Idempotency-Key gửi 2 lần chỉ cộng 1 lần; lần 3 không key → 400 NOT_DRAFT) → tồn đúng →
  điều chỉnh −3 + sổ kho → ẩn → 404 công khai → xoá mềm (cả biến thể, SKU dùng lại được) → outbox DONE ở worker.

## 9. Rủi ro / Ghi chú

* Bug tìm qua smoke: (1) `size` query trùng cỡ trang của PageQuery → đổi cỡ trang thành `pageSize`; (2) field multipart
  không có validator bị ValidationPipe(whitelist) lọc mất → thêm decorator; (3) xoá mềm sản phẩm không xoá biến thể →
  SKU kẹt; (4) SKU sinh từ 8 ký tự slug + 2 ký tự tên màu bị trùng → `makeSku` (băm slug + mã màu); (5) worker thiếu
  `ProductService` → ProductModule export riêng cho worker; (6) `unaccent()` không IMMUTABLE → bọc `f_unaccent`.
* Curl trên Git Bash Windows gửi tiếng Việt sai mã — test phải `--data-binary @file.json` (UTF-8).

## 10. Nhật ký

| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| 2026-09-15 | B1–B6 xong, Done | cùng commit với PLAN-0003 |

## 11. File đã đổi

```text
prisma/schema/product.prisma · prisma/migrations/20260915080000_catalog_product_init/
src/modules/product/** · src/common/gateway/{inventory,product-stats}.gateway.ts · src/common/response/money-response.ts
src/common/utils/slug.ts (makeSku) · src/common/idempotency/idempotency.service.ts (kiểu JSON) · src/common/prisma/types.ts (re-export Prisma)
scripts/seed/product.seed.ts · scripts/seed/assets/product/** · src/main.ts (/static/seed) · .dependency-cruiser.cjs (cho import *.module.ts)
```

## 12. Việc tiếp theo

* [ ] PLAN-0005 cart + wishlist (dùng InventoryGateway.availableOf + ProductQueryApi.variantSnapshots)

## 13. Definition of Done

* [x] verify · migration:check · compose up · seed 2 lần · smoke · docs · commit local
