# Thiết kế DB — module catalog + product (PLAN-0003/0004)

Schema `catalog`, `product`. Model: `prisma/schema/{catalog,product}.prisma`. Migration `20260915080000_catalog_product_init`;
phần đa gian hàng / đa ngành hàng bổ sung bởi `20260929084707_product_shop_id`, `20260929093500_product_variant_shop_sku_unique_fix`,
`20260929120000_multi_category_attributes`, `20261003110000_stock_receipt_shop_id`, `20261003140000_product_variant_sku_per_shop`.
Sơ đồ: `docs/database/eco_fashion.dbml`.

Từ PLAN-0014/0016: sàn là ĐA GIAN HÀNG + ĐA NGÀNH HÀNG. Catalog là danh mục DÙNG CHUNG toàn sàn (không có brands, không theo shop);
gian hàng sở hữu sản phẩm qua `products.shop_id` (id trần trỏ `shop.shops.id`, không FK xuyên schema). Thời trang là ngành ĐẦU TIÊN:
`categories.attribute_mode = 'legacy_fashion'` giữ nguyên cách cũ (gender/material/care + màu×size); category mới mặc định `'dynamic'`
dùng thuộc tính động.

## catalog

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `categories` | ngành hàng (7 nhóm quần áo ban đầu + ngành mới) | `slug` unique partial sống; `product_count` đếm sẵn — product cộng/trừ qua `CategoryStatsGateway` cùng transaction đăng/ẩn; `parent_id` để mở rộng cây; `attribute_mode` legacy_fashion\|dynamic (mặc định `dynamic`, category cũ backfill `legacy_fashion`; chỉ category LÁ được gán sản phẩm, mode đọc từ chính category lá, không kế thừa; không có CHECK ở DB) |
| `collections` | bộ sưu tập = bộ lọc có sẵn | `query_category_slug` / `query_gender` / `query_tag` → FE mở `/products?...` |
| `attributes` + `attribute_values` | color (hex) / size (group ao\|quan) / material | thuộc tính CỐ ĐỊNH của thời trang (legacy_fashion); biến thể tham chiếu theo `code`; xoá mềm giá trị, biến thể giữ snapshot |
| `dynamic_attributes` + `dynamic_attribute_values` | thuộc tính động cho ngành NGOÀI thời trang (PLAN-0016) | `code` unique, không giới hạn mã, tạo qua API; `input_type` select\|text\|number (select chọn từ `dynamic_attribute_values`, unique (attribute_id, value); `extra` json, vd `{"hex": ...}`); KHÁC `attributes` ở trên (khoá cứng 3 mã), không cột chuẩn base |
| `category_attributes` | mẫu thuộc tính theo category lá | unique (category_id, attribute_id); `required`; `is_variant_axis` = dùng làm trục biến thể, TỐI ĐA 2 dòng / category (chỉ service kiểm, DB không ràng) |
| `audit_logs`, `outbox_events` | khuôn common | outbox `CATEGORY_CHANGED` (đổi slug/tên/ẩn) |

## product

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `products` | sản phẩm | `shop_id` NOT NULL (gian hàng sở hữu; sản phẩm cũ backfill về FITLY Official `00000000-0000-0000-0000-000000000001`; index); `category_id` + `category_slug` snapshot (không FK xuyên schema; worker đồng bộ khi catalog đổi slug); `base_price`/`list_price` numeric(14,0); `status` draft→active↔hidden; `is_new`, `is_featured`, `tags` (json, `new`/`sale`); thống kê `sold_count`/`review_count`/`avg_rating`/`view_count` đếm sẵn; `search_vector` tsvector (trigger); `gender`/`material`/`care` chỉ có nghĩa với category `legacy_fashion` |
| `product_variants` | màu × size (thời trang) hoặc trục động (ngành mới) | `shop_id` NOT NULL (đồng bộ product); unique (product, color, size) — `color_code`/`color_name`/`size_code` NULLABLE với ngành `dynamic` nên unique này KHÔNG chặn trùng tổ hợp trục động (service kiểm); `sku` unique THEO GIAN HÀNG, chỉ biến thể sống (partial `uq_product_variants_shop_sku_active` (shop_id, sku); hai shop được trùng SKU); `price` NULL = giá sản phẩm; `stock` tồn thô, `reserved` đang giữ cho đơn, CHECK `0 ≤ reserved ≤ stock` |
| `product_attribute_values` | thuộc tính cấp sản phẩm (ngành `dynamic`), KHÔNG tạo biến thể | unique (product_id, attribute_id); `attribute_id`/`attribute_value_id` là id trần sang `catalog.dynamic_attributes`/`dynamic_attribute_values` (không FK xuyên schema); `custom_value` khi nhập tay (text/number). Rỗng với sản phẩm thời trang |
| `product_variant_options` | trục biến thể của một variant (ngành `dynamic`) | unique (variant_id, attribute_id); tối đa 2 dòng / variant (chỉ service kiểm); `display_value` snapshot tên hiển thị lúc tạo (vd `128GB`) |
| `product_images` | ảnh theo màu | `color_code` NULL = ảnh chung; một `is_primary` (partial unique); `public_id` để xoá Cloudinary |
| `stock_receipts` + `stock_receipt_items` | phiếu nhập | draft → posted (cộng tồn, có Idempotency-Key) / cancelled; `code` PNyymm00001; `stock_receipts.shop_id` nullable (vendor tự nhập kho; NULL = phiếu của sàn; mọi dòng phải là biến thể cùng shop — service kiểm; phiếu cũ backfill FITLY Official); index (shop_id, created_at DESC) |
| `stock_movements` | sổ kho append-only | RECEIPT / ADJUST / RESERVE / RELEASE / SALE / RETURN, `stock_after`, `ref_type/ref_id` (đơn, phiếu) |
| `audit_logs`, `outbox_events`, `processed_events`, `idempotency_keys` | khuôn common | outbox PRODUCT_PUBLISHED/UPDATED/HIDDEN (AI nhúng lại), STOCK_LOW |

## Sửa tay trong migration

```sql
CREATE UNIQUE INDEX uq_products_slug_active ON product.products (slug) WHERE is_deleted = false;
CREATE UNIQUE INDEX uq_product_variants_shop_sku_active ON product.product_variants (shop_id, sku) WHERE is_deleted = false;  -- migration 20261003140000 (thay uq_product_variants_sku_active toàn sàn)
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
2. Biến thể thời trang (`legacy_fashion`) chỉ dùng mã màu/size có trong catalog; biến thể ngành `dynamic` dùng `product_variant_options`
   (≤ 2 trục; bộ options phải đúng bộ `is_variant_axis = true` của mẫu category lá, không thiếu không thừa, và trục phải là thuộc tính `input_type = 'select'` — chỉ service kiểm); xoá mềm sản phẩm phải xoá mềm biến thể (SKU dùng lại được).
3. `category_slug` trên products là snapshot — nguồn sự thật là catalog; worker đồng bộ qua outbox.
