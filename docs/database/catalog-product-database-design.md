# Thiết kế DB — module catalog + product (PLAN-0003/0004)

Schema `catalog`, `product`. Model: `prisma/schema/{catalog,product}.prisma`. Migration `20260915080000_catalog_product_init`.
Sơ đồ: `docs/database/eco_fashion.dbml`.

## catalog

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `categories` | ngành hàng (7 nhóm quần áo) | `slug` unique partial sống; `product_count` đếm sẵn — product cộng/trừ qua `CategoryStatsGateway` cùng transaction đăng/ẩn; `parent_id` để mở rộng cây |
| `collections` | bộ sưu tập = bộ lọc có sẵn | `query_category_slug` / `query_gender` / `query_tag` → FE mở `/products?...` |
| `attributes` + `attribute_values` | color (hex) / size (group ao\|quan) / material | biến thể tham chiếu theo `code`; xoá mềm giá trị, biến thể giữ snapshot |
| `audit_logs`, `outbox_events` | khuôn common | outbox `CATEGORY_CHANGED` (đổi slug/tên/ẩn) |

## product

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `products` | sản phẩm | `category_id` + `category_slug` snapshot (không FK xuyên schema; worker đồng bộ khi catalog đổi slug); `base_price`/`list_price` numeric(14,0); `status` draft→active↔hidden; `is_new`, `is_featured`, `tags` (json, `new`/`sale`); thống kê `sold_count`/`review_count`/`avg_rating`/`view_count` đếm sẵn; `search_vector` tsvector (trigger) |
| `product_variants` | màu × size | unique (product, color, size); `sku` unique partial sống (`makeSku`); `price` NULL = giá sản phẩm; `stock` tồn thô, `reserved` đang giữ cho đơn, CHECK `0 ≤ reserved ≤ stock` |
| `product_images` | ảnh theo màu | `color_code` NULL = ảnh chung; một `is_primary` (partial unique); `public_id` để xoá Cloudinary |
| `stock_receipts` + `stock_receipt_items` | phiếu nhập | draft → posted (cộng tồn, có Idempotency-Key) / cancelled; `code` PNyymm00001 |
| `stock_movements` | sổ kho append-only | RECEIPT / ADJUST / RESERVE / RELEASE / SALE / RETURN, `stock_after`, `ref_type/ref_id` (đơn, phiếu) |
| `audit_logs`, `outbox_events`, `processed_events`, `idempotency_keys` | khuôn common | outbox PRODUCT_PUBLISHED/UPDATED/HIDDEN (AI nhúng lại), STOCK_LOW |

## Sửa tay trong migration

```sql
CREATE UNIQUE INDEX uq_products_slug_active ON product.products (slug) WHERE is_deleted = false;
CREATE UNIQUE INDEX uq_product_variants_sku_active ON product.product_variants (sku) WHERE is_deleted = false;
CREATE UNIQUE INDEX uq_product_images_primary ON product.product_images (product_id) WHERE is_primary = true;
ALTER TABLE product.product_variants ADD CONSTRAINT ck_product_variants_stock_nonneg CHECK (stock >= 0 AND reserved >= 0 AND reserved <= stock);
CREATE FUNCTION public.f_unaccent(text) ... IMMUTABLE;           -- unaccent() gốc không IMMUTABLE, không dùng trong index được
CREATE TRIGGER trg_products_search_vector ... (name A, category_slug B, short_description C, material D)
CREATE INDEX idx_products_search_vector ON product.products USING GIN (search_vector);
CREATE INDEX idx_products_name_trgm ON product.products USING GIN (public.f_unaccent(lower(name)) gin_trgm_ops);
```

## Tồn kho — vòng đời

```text
Nhập kho (receipt posted)  stock += q                       RECEIPT
Đặt đơn (order.create)     reserved += q  (cần stock-reserved ≥ q)   RESERVE   ← InventoryGateway.reserve (tx của order)
Huỷ / quá hạn thanh toán   reserved -= q                    RELEASE   ← release
Đơn xác nhận/thanh toán    stock -= q, reserved -= q        SALE      ← commit
Đổi trả chấp nhận          stock += q                       RETURN    ← restock
Kiểm kê                    stock += delta (≥ reserved)      ADJUST
```

Mọi hàm khoá `SELECT … FOR UPDATE` các biến thể theo thứ tự id (không deadlock), kiểm điều kiện, UPDATE tuyệt đối, ghi sổ.
Thiếu hàng → `InsufficientStockError{shortages[]}` để order trả 409 kèm danh sách. Sau đổi tồn: xoá cache chi tiết sản phẩm;
`available ≤ 5` → outbox `STOCK_LOW`.

## Cache (Redis)

| Key | TTL | Xoá khi |
|---|---|---|
| `ef:catalog:categories:active` · `collections:active` · `attributes:all` | 600s | ghi ở module catalog; product đăng/ẩn (product_count) |
| `ef:product:list:<hash tham số>` | 60s | mọi ghi sản phẩm/biến thể/ảnh, sold/rating |
| `ef:product:detail:<slug>` | 120s | như trên + mọi biến động tồn kho của sản phẩm đó |
| `ef:product:filters:all` · `related:<slug>:<n>` | 600s · 300s | ghi sản phẩm |

## Bất biến

1. Không sửa `stock`/`reserved` ngoài `InventoryService` (kể cả seed chỉ tạo qua phiếu nhập + sổ kho).
2. Biến thể chỉ dùng mã màu/size có trong catalog; xoá mềm sản phẩm phải xoá mềm biến thể (SKU dùng lại được).
3. `category_slug` trên products là snapshot — nguồn sự thật là catalog; worker đồng bộ qua outbox.
