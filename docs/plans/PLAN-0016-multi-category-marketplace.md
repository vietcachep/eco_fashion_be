# PLAN-0016 — Sàn đa ngành hàng (multi-category, kiểu Shopee)

> Status: **BE ✅ đã triển khai** (migration `20260929120000_multi_category_attributes`; hoàn thiện thêm ở PLAN-0017: ngành lá + vendor đọc mẫu thuộc tính + `PUT /shop/products/:id/attributes` + khoá đổi `attributeMode`); FE còn việc (§12). Rà soát tài liệu theo mã nguồn 2026-10-04: điểm làm khác ở §14.
> Owner: Sonnet 5 (điều phối + schema) + Haiku (code theo plan)
> Related Phase: sau PLAN-0014 (marketplace shop/vendor)
> Related Roadmap: `docs/04_ROADMAP.md`

---

## 1. Mục tiêu

FITLY hiện là sàn marketplace (PLAN-0014) nhưng schema sản phẩm vẫn **chỉ cho thời trang**: `Product.gender`
bắt buộc, `ProductVariant` chỉ có đúng 2 trục cố định `colorCode×sizeCode`. Mục tiêu: cho phép gian hàng bán
BẤT KỲ ngành hàng nào (điện tử, gia dụng, mỹ phẩm, sách, thực phẩm...) — mỗi ngành hàng tự định nghĩa bộ
thuộc tính riêng (kiểu Shopee: điện thoại có Màu+Dung lượng, sách không có biến thể, mỹ phẩm có Dung tích),
**mà KHÔNG đụng vào hệ thống thời trang đang chạy ổn** (giỏ/đơn/trả hàng/promotion đã build quanh
color/size suốt PLAN-0006→0015).

## 2. Quyết định kiến trúc đã chốt với người dùng

1. **Giữ nguyên thời trang, thêm hệ thống mới song song** (không hợp nhất ngay). `Product.gender/material/care`
   và `ProductVariant.colorCode/colorName/colorHex/sizeCode` **KHÔNG đổi, KHÔNG migrate dữ liệu**. Toàn bộ
   order/cart/return/promotion module liên quan tới field này giữ nguyên 100%.
2. **Tối đa 2 trục thuộc tính tạo biến thể / sản phẩm** (khớp chuẩn Shopee — vd Màu + Dung lượng).
3. Category nào dùng hệ thời trang cũ, category nào dùng hệ mới: đánh dấu **tường minh** bằng
   `Category.attributeMode` (`legacy_fashion` | `dynamic`), KHÔNG suy luận ngầm — tránh nhầm lẫn khi category
   cha/con khác mode nhau.

## 3. Phạm vi

### Trong phạm vi
* Schema mới: `Attribute`, `AttributeValue` (viết lại, không giới hạn 3 mã cứng), `CategoryAttribute`
  (mẫu thuộc tính theo ngành hàng), `ProductAttributeValue` (thuộc tính cấp sản phẩm, không tạo biến thể),
  `ProductVariantOption` (trục biến thể cho ngành hàng mới, thay thế colorCode/sizeCode).
* BE: API CRUD Attribute/CategoryAttribute (nhân viên sàn); `ProductService.resolveVariants()` rẽ nhánh theo
  `category.attributeMode`; SKU generator tổng quát cho ngành hàng mới; DTO product response/request thêm
  field mới (tuỳ chọn — không phá field cũ).
* FE admin: màn "Thuộc tính" viết lại (tạo được Attribute mới, không chỉ sửa giá trị); màn gán mẫu thuộc
  tính theo category; form sản phẩm rẽ nhánh field theo `category.attributeMode`.
* FE user: filter sản phẩm + trang chi tiết rẽ nhánh hiển thị theo `attributeMode`; **nav chính đổi "Nữ▾/Nam▾"
  thành "Danh mục▾"** (mega menu ngành hàng, không còn giả định giới tính); **đổi menu "Thử đồ AI"**: bỏ
  "Gợi ý phối đồ AI" + "Thử đồ 2D", thay bằng "Trợ lý mua sắm AI" (tổng quát hoá chatbot có sẵn), "Tìm kiếm
  bằng hình ảnh" (tái dùng hạ tầng phân tích ảnh cũ, đổi mục đích sang tìm sản phẩm tương tự toàn sàn),
  "Tóm tắt đánh giá AI" (lộ insight AI có sẵn ra cho khách).
* Seed: 3-4 category ngoài thời trang kèm mẫu thuộc tính + vài sản phẩm mẫu, để demo/test được ngay.
* Cập nhật `AGENTS.md` (bỏ dòng "MỘT cửa hàng thời trang, KHÔNG phải sàn" đã lỗi thời từ PLAN-0014).

### Ngoài phạm vi (không đụng)
* Không sửa `Product.gender/material/care`, `ProductVariant.colorCode/sizeCode`, SKU/resolveVariants của
  đường thời trang cũ.
* Không đụng order/cart/return/promotion module (chỉ đọc qua field đã có, không cần biết attributeMode).
* Không đụng payment/PayOS (PLAN-0015, vẫn ngoài phạm vi như các vòng trước).
* Không migrate category/sản phẩm thời trang hiện có sang hệ mới.

## 4. Module ảnh hưởng
* catalog (Attribute/AttributeValue/CategoryAttribute mới) · product (ProductAttributeValue/
  ProductVariantOption mới, resolveVariants rẽ nhánh) · **không đụng**: cart · order · payment · promotion ·
  review · shop.

## 5. Thiết kế DB

### `catalog` schema — model mới, KHÔNG đụng `Attribute`/`AttributeValue` cũ (đã xác nhận: bảng `attributes`/
`attribute_values`, model Prisma tên `Attribute`/`AttributeValue` — bị khoá 3 mã cứng color/size/material,
FE admin màn "Thuộc tính" thời trang vẫn dùng nguyên, không xoá/đổi). Model MỚI đặt tên khác hẳn để không
đụng tên class Prisma (Prisma model name là global, không theo file):
```prisma
model Category {
  // ... field hiện có giữ nguyên ...
  attributeMode String @default("dynamic") @map("attribute_mode") @db.VarChar(20) // "legacy_fashion" | "dynamic"
  categoryAttributes CategoryAttribute[]
}

model DynamicAttribute {
  id        String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  code      String @unique @db.VarChar(60)          // "color" | "storage" | "ram" | tự do cho ngành mới
  name      String @db.VarChar(100)                 // "Màu sắc" | "Dung lượng"
  inputType String @default("select") @db.VarChar(20) // select | text | number
  values             DynamicAttributeValue[]
  categoryAttributes CategoryAttribute[]
  @@map("dynamic_attributes") @@schema("catalog")
}

model DynamicAttributeValue {
  id          String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  attributeId String  @map("attribute_id") @db.Uuid
  value       String  @db.VarChar(100)               // "Đỏ" | "128GB"
  extra       Json?                                  // {hex:"#ff0000"} cho color, tự do theo inputType
  sortOrder   Int     @default(0) @map("sort_order")
  attribute DynamicAttribute @relation(fields: [attributeId], references: [id], onDelete: Cascade)
  @@unique([attributeId, value]) @@map("dynamic_attribute_values") @@schema("catalog")
}

/* Mẫu thuộc tính theo ngành hàng — TỐI ĐA 2 dòng isVariantAxis=true / category (validate ở service). */
model CategoryAttribute {
  id            String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  categoryId    String  @map("category_id") @db.Uuid
  attributeId   String  @map("attribute_id") @db.Uuid
  required      Boolean @default(false)
  isVariantAxis Boolean @default(false) @map("is_variant_axis")
  sortOrder     Int     @default(0) @map("sort_order")
  category  Category         @relation(fields: [categoryId], references: [id], onDelete: Cascade)
  attribute DynamicAttribute @relation(fields: [attributeId], references: [id], onDelete: Cascade)
  @@unique([categoryId, attributeId]) @@map("category_attributes") @@schema("catalog")
}
```

### `product` schema — model mới
```prisma
model ProductAttributeValue {
  id               String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  productId        String  @map("product_id") @db.Uuid
  attributeId      String  @map("attribute_id") @db.Uuid       // id bên catalog — không FK xuyên schema
  attributeValueId String? @map("attribute_value_id") @db.Uuid // chọn sẵn (inputType=select)
  customValue      String? @map("custom_value") @db.VarChar(255) // nhập tay (inputType=text/number)
  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  @@unique([productId, attributeId]) @@map("product_attribute_values") @@schema("product")
}

model ProductVariantOption {
  id               String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  variantId        String @map("variant_id") @db.Uuid
  attributeId      String @map("attribute_id") @db.Uuid
  attributeValueId String @map("attribute_value_id") @db.Uuid
  displayValue     String @map("display_value") @db.VarChar(100) // snapshot tên lúc tạo — đổi tên value sau không vỡ đơn cũ
  variant ProductVariant @relation(fields: [variantId], references: [id], onDelete: Cascade)
  @@unique([variantId, attributeId]) @@map("product_variant_options") @@schema("product")
}
```
`ProductVariant.colorCode/sizeCode` đổi thành **nullable** (backward-compatible — dữ liệu cũ không đổi, chỉ
variant mới của category `dynamic` để trống 2 field này và dùng `ProductVariantOption` thay thế).
`@@unique([productId, colorCode, sizeCode])` giữ nguyên (Postgres coi nhiều NULL là khác nhau — không xung
đột với variant dùng ProductVariantOption).

### Migration
* Additive-only, KHÔNG sửa/xoá dữ liệu thời trang hiện có. Backfill `Category.attributeMode = 'legacy_fashion'`
  cho category thời trang hiện có (theo `parentId` gốc hoặc set tất cả category hiện có = legacy_fashion vì
  toàn bộ dữ liệu hiện tại là thời trang — đơn giản, đúng thực tế), category MỚI tạo sau này mặc định
  `'dynamic'`.
* Đúng theo bài học PLAN-0014 (SKU dedupe trước khi thêm unique constraint) — kiểm dữ liệu thật trước khi
  chạy `ALTER TABLE ... NOT NULL`/thêm constraint, `prisma migrate deploy` (không dùng `migrate dev` trên DB
  dev đang có dữ liệu — bài học đã rút ra phiên trước).

## 6. API (nhân viên sàn quản lý thuộc tính + category template; vendor dùng khi tạo sản phẩm)

> **Thực tế khác bản thiết kế dưới đây (xác minh theo controller 2026-10-04):** (1) sửa giá trị thuộc tính là `PUT /admin/dynamic-attributes/:id/values/:valueId` (không phải PATCH) và có thêm `GET /admin/dynamic-attributes/:id`;
> (2) KHÔNG có route công khai `GET /categories/:slug/attribute-template` — mẫu thuộc tính cho vendor là `GET /shop/catalog/categories/:slug/attribute-template` + `GET /shop/catalog/categories/leaves` (quyền `shop.product.read`, `ShopContextGuard`), cho sàn là
> `GET|PUT /admin/categories/:categoryId/attributes` (`catalog.category.read|manage`); (3) vendor đặt thuộc tính cấp sản phẩm bằng `PUT /shop/products/:id/attributes` và biến thể bằng `PUT /shop/products/:id/variants` (biến thể dynamic cập nhật TẠI CHỖ, giữ id/tồn kho);
> (4) `GET /categories` công khai trả thêm `parentId` + `attributeMode`; `GET /products/filters` CHƯA lọc theo thuộc tính động.

```text
GET    /admin/dynamic-attributes                       — danh sách DynamicAttribute (mọi inputType)
POST   /admin/dynamic-attributes                       — tạo DynamicAttribute mới (code/name/inputType)
POST   /admin/dynamic-attributes/:id/values            — thêm DynamicAttributeValue
PATCH  /admin/dynamic-attributes/:id/values/:valueId
DELETE /admin/dynamic-attributes/:id/values/:valueId

GET    /admin/categories/:id/attributes        — mẫu thuộc tính của 1 category
PUT    /admin/categories/:id/attributes        — set lại mẫu (mảng {attributeId, required, isVariantAxis, sortOrder})
                                                   — validate tối đa 2 isVariantAxis=true (400 nếu vượt)

# Đọc công khai (vendor/khách xem category cần thuộc tính gì trước khi tạo/lọc sản phẩm)
GET    /categories/:slug/attribute-template    — trả mẫu thuộc tính + attributeMode của category
```
`POST /shop/products` / `POST /admin/products` (đã có từ PLAN-0014): thêm field tuỳ chọn `attributeValues`
(cấp sản phẩm) và đổi `variants[].colorCode/sizeCode` thành tuỳ chọn + `variants[].options` mới (mảng
{attributeId, attributeValueId}, tối đa 2 phần tử) — validate theo `category.attributeMode`.

## 7. Bước triển khai (đánh dấu ai làm để tách song song)

* [x] **Bước 1** (Sonnet, TỰ LÀM — rủi ro cao nhất, schema): thêm model mới vào `catalog.prisma`/
      `product.prisma`, viết migration an toàn, backfill `attributeMode`, `npx prisma migrate deploy`,
      `prisma generate`, verify bằng cách khởi động app thật (bài học PLAN-0014: build xanh không đảm bảo
      DI/migration đúng).
* [x] **Bước 2a** (Haiku, sau khi Bước 1 xong): API Attribute/AttributeValue/CategoryAttribute (module
      catalog) — controller + service + repository + DTO, quyền `catalog.dynamic_attribute.read/manage`.
* [x] **Bước 2b** (Haiku, song song Bước 2a, KHÁC file — product module): `ProductService.resolveVariants()`
      rẽ nhánh theo `category.attributeMode`; SKU generator tổng quát; `ProductAttributeValue`/
      `ProductVariantOption` CRUD trong luồng tạo/sửa sản phẩm. Sonnet sửa lại sau khi `npm run verify` bắt
      được 2 lỗi thật mà cả 2 agent tự báo "0 lỗi" đều bỏ sót (bài học tái xác nhận): `product.service.ts` gọi
      thẳng `prisma.category` (4 chỗ) và `product.repository.ts` gọi thẳng `tx.dynamicAttributeValue` trong
      repository — cả hai vi phạm ranh giới schema, `prisma-boundaries.spec.ts` bắt được. Sửa bằng cách route
      qua `CatalogQueryApi` (thêm `getCategoryAttributeTemplate()`/`findDynamicAttributeValuesByIds()`), đồng
      thời bổ sung validate `isVariantAxis` còn thiếu (comment nói có nhưng code không làm) và đổi mã quyền
      `catalog.dynamicAttribute.*` → `catalog.dynamic_attribute.*` (camelCase vi phạm regex, `identity.spec.ts`
      bắt được).
* [x] **Bước 3** (Haiku, sau 2a xong): FE admin — màn "Thuộc tính động" (`/catalog/dynamic-attributes`), form
      category thêm chọn `attributeMode`, form sản phẩm rẽ nhánh field theo `attributeMode` (ẩn gender/
      material/care khi dynamic; ma trận biến thể còn là placeholder TODO — xem mục 12).
* [x] **Bước 4** (Haiku, song song Bước 3): FE user — nav đổi "Nữ▾/Nam▾" → "Danh mục▾"; menu AI đổi (bỏ AI thử
      đồ/AI phân tích hình ảnh, thêm AI trợ lý mua sắm/tìm bằng hình ảnh/tóm tắt đánh giá). Trang sản phẩm/
      filter rẽ nhánh theo `attributeMode` (ẩn ColorPicker/SizePicker khi dynamic) CHƯA làm — xem mục 12.
* [x] **Bước 5** (Sonnet — người dùng yêu cầu trực tiếp khi thấy category mới trống sản phẩm): seed 3 category
      gốc ngoài thời trang ("Điện thoại & Phụ kiện", "Nhà cửa & Đời sống", "Sắc đẹp & Sức khoẻ", 6 category
      lá) + `scripts/seed/marketplace-product.seed.ts` mới: 16 sản phẩm thật (3 điện thoại có ma trận biến thể
      màu×dung lượng, 13 sản phẩm 1-biến-thể) qua đúng hệ `ProductAttributeValue`/`ProductVariantOption`, ảnh
      placeholder sinh bằng script (không phụ thuộc host ngoài danh sách `next.config.ts` remotePatterns), tồn
      kho qua `StockReceipt`/`StockMovement` đúng pattern audit sẵn có. Idempotent — xác nhận chạy `npm run
      seed` 2 lần liên tiếp không tạo trùng.
      **Về sau (PLAN-0017 Track D):** hai file seed này đã bị XOÁ và thay bằng `scripts/seed/marketplace.seed.ts` + DSL `scripts/seed/data/` (12 ngành gốc dynamic, 48 ngành lá, 343 sản phẩm, 18 gian hàng) — xem `docs/05_SEED_AND_REPRODUCE.md`.
* [x] **Bước 6**: `AGENTS.md` cả 3 repo đã sửa (bỏ "MỘT cửa hàng, KHÔNG phải sàn"). `eco_fashion.dbml` và `docs/06_FE_CONTRACT.md` đã cập nhật ở đợt rà soát 2026-10-03/04
      (dbml có `dynamic_attributes`, `dynamic_attribute_values`, `category_attributes`, `product_attribute_values`, `product_variant_options`, `categories.attribute_mode`; FE contract có mục "Sản phẩm ngành động" + `/admin/dynamic-attributes` + `/admin/categories/{id}/attributes`).
* [x] **Bước bổ sung** (Sonnet — người dùng yêu cầu trực tiếp: "AI chatbot và các AI khác nắm được đó là sàn
      thương mại điện tử như Shopee"): sửa toàn bộ prompt AI hard-code "cửa hàng thời trang"/"chỉ bán quần áo"
      (chat.service.ts, staff-insight.service.ts, review-ai.service.ts, product-faq.service.ts, ai-insight.
      service.ts, chat-insights.service.ts) sang khung sàn đa ngành hàng; sửa trang "Về FITLY" (nguồn tri thức
      chatbot đọc qua `search_knowledge` — trước đó khẳng định "chỉ bán quần áo", sai lệch nghiêm trọng nhất).
      Sửa gốc: `ProductQueryApi.detailForAi()` trước đó CHỈ trả field thời trang (gender/material/care/màu/
      size) — sản phẩm dynamic sẽ có ngữ cảnh AI rỗng; mở rộng trả thêm `attributesText`/`optionsText`/
      `attributeMode` (qua `CatalogQueryApi`, thêm `findDynamicAttributeNamesByIds()`), cập nhật
      `staff-insight.service.ts precheck()` bỏ yêu cầu chất liệu/bảo quản khi sản phẩm không phải thời trang.

## 8. Kiểm thử
> Test của PLAN-0016 tồn tại ở `catalog/dynamic-attribute/service/dynamic-attribute.service.spec.ts`, `catalog/category-attribute/service/category-attribute.service.spec.ts`, `catalog/category/service/category.service.spec.ts`,
> `catalog/shop-catalog/service/shop-catalog.service.spec.ts`, `product/product/service/product.service.spec.ts`, `product/queryapi/product-queryapi.spec.ts` (đọc 2026-10-04, chưa chạy lại). Các dòng `[x]` dưới là kết quả LÚC LÀM (2026-09-29).
* [x] `npm run verify` (lint + boundaries + build + test) xanh — eco_backend. fashion_frontend_admin/user CHƯA
      re-verify trong lượt này (xem mục 12).
* [x] Khởi động app thật (`node dist/src/main.js`) — không lỗi DI, kể cả sau khi thêm
      `CategoryAttributeRepository`/`DynamicAttributeRepository` vào `CatalogQueryApi` và `CatalogQueryApi` vào
      `ProductQueryApi` (cạnh DI graph mới).
* [x] Tạo thử sản phẩm category `dynamic` — xác nhận qua API thật (`GET /api/v1/products/dien-thoai-thong-minh-galaxy-x10`):
      SKU sinh đúng, 4 biến thể đúng tối đa 2 trục (màu × dung lượng), `displayValue` snapshot đúng.
* [ ] Tạo thử 1 sản phẩm category `legacy_fashion` qua API thật (chỉ xác nhận gián tiếp qua `npm run seed`
      seed lại 24 sản phẩm thời trang không lỗi — chưa test tay qua form).
* [ ] Live browser: FE admin tạo sản phẩm ngành hàng mới; FE user xem/lọc/mua sản phẩm ngành hàng mới đến
      hết giỏ hàng — CHƯA làm, chỉ mới test qua API/curl (xem mục 12).

## 9. Rủi ro / Ghi chú
* Rủi ro: nhầm `attributeMode` khi category cha/con khác mode — chốt luật "chỉ category LÁ (không có con)
  mới được gán sản phẩm, mode đọc từ chính category lá đó, không kế thừa cha".
* ~~Giả định: tên bảng `attributes_v2`/`attribute_values_v2` chưa trùng~~ — đã giải quyết: bảng mới đặt tên `dynamic_attributes`/`dynamic_attribute_values` (model `DynamicAttribute`/`DynamicAttributeValue`), bảng thời trang cũ `attributes`/`attribute_values` giữ nguyên.
* ~~Câu hỏi mở: bộ category ngoài thời trang cụ thể nào~~ — đã chốt ở PLAN-0017 §5: 12 ngành gốc dynamic (Điện thoại · Máy tính · Nhà cửa · Sắc đẹp · Giày dép & Túi xách · Đồng hồ · Thể thao · Mẹ & Bé · Sách & VPP · Thực phẩm · Thú cưng · Ô tô & Xe máy) với 48 ngành lá.
* Không chặn — toàn bộ quyết định kiến trúc đã chốt với người dùng (mục 2).

## 10. Nhật ký tiến độ
| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| 2026-09-29 | Tạo plan sau khảo sát 3 agent (BE/FE admin/FE user) | Khảo sát xác nhận Category đã là cây đa cấp sẵn sàng; Attribute cũ bị khoá 3 mã cứng |
| 2026-09-29 | Schema + migration (Bước 1), BE-1/BE-2 (Bước 2a/2b) qua Haiku song song, FE admin/user (Bước 3/4) qua Haiku song song | Sonnet tự sửa 2 lỗi kiến trúc thật mà cả 2 Haiku agent tự báo "0 lỗi" bỏ sót — bài học: LUÔN `npm run verify` lại trên state GỘP sau khi nhiều agent song song xong, không tin báo cáo riêng lẻ |
| 2026-09-29 | Seed 16 sản phẩm ngoài thời trang (Bước 5) + sửa toàn bộ prompt AI + trang "Về FITLY" theo yêu cầu người dùng | Phát hiện thêm 1 lỗi thật: `ProductQueryApi.detailForAi()` chỉ trả field thời trang → AI thấy ngữ cảnh rỗng cho 16 sản phẩm mới; mở rộng trả `attributesText`/`optionsText`/`attributeMode` |
| 2026-10-03 | Hoàn thiện ở PLAN-0017 | Vendor đọc mẫu thuộc tính (`/shop/catalog/**`), `PUT /shop/products/:id/attributes`, chỉ gán ngành LÁ, khoá đổi `attributeMode` qua `CatalogUsageRegistry`, biến thể dynamic cập nhật tại chỗ, seed 12 ngành gốc/48 ngành lá/343 sản phẩm bằng DSL |
| 2026-10-04 | Rà soát tài liệu theo mã nguồn (không chạy lệnh) | Tick bước 6 (dbml + FE contract), ghi điểm làm khác ở §6/§14, đánh dấu seed cũ đã bị thay |

## 11. File đã đổi
```text
eco_backend/
  prisma/schema/catalog.prisma, product.prisma
  prisma/migrations/20260929120000_multi_category_attributes/
  src/modules/catalog/dynamic-attribute/**  (mới)
  src/modules/catalog/category-attribute/** (mới)
  src/modules/catalog/queryapi/catalog.queryapi.ts       (+attributeMode, +3 method mới)
  src/modules/catalog/category/repository/category.repository.ts (+attributeMode vào SELECT)
  src/modules/identity/permission/catalog.ts             (mã quyền dynamic_attribute.*)
  src/modules/product/product/service/product.service.ts (rẽ nhánh attributeMode, bỏ prisma.category trực tiếp)
  src/modules/product/product/repository/product.repository.ts (upsertVariantDynamic không tự đọc catalog schema)
  src/modules/product/queryapi/product.queryapi.ts       (detailForAi() +attributesText/+optionsText/+attributeMode)
  src/modules/ai/chat/chat.service.ts                    (prompt: sàn đa ngành hàng thay "cửa hàng thời trang")
  src/modules/ai/insight/staff-insight.service.ts         (prompt + precheck rẽ nhánh isFashion)
  src/modules/ai/insight/chat-insights.service.ts         (prompt)
  src/modules/ai/insight/ai-insight.service.ts            (prompt product_description)
  src/modules/ai/review-ai/review-ai.service.ts           (prompt moderation/summary)
  src/modules/ai/faq/product-faq.service.ts               (prompt + source() dùng attributesText/optionsText)
  src/main.ts                                              (Swagger description)
  scripts/seed/dynamic-attribute.seed.ts                  (BE-1: 5 thuộc tính + 6 category lá) — ĐÃ XOÁ ở PLAN-0017 (thay bằng marketplace.seed.ts + data/)
  scripts/seed/marketplace-product.seed.ts                (mới — 16 sản phẩm) — ĐÃ XOÁ ở PLAN-0017 (như trên)
  scripts/seed/system.seed.ts                             (trang "Về FITLY" — sàn đa ngành hàng)
  scripts/seed/index.ts                                    (+bước marketplace-product → nay là bước `marketplace`, 15 bước)
  scripts/seed/assets/product/<16 slug mới>/main.jpg       (ảnh placeholder tự sinh; nay ảnh sinh ở assets/product/<slug>/{a,b}.jpg)

fashion_frontend_admin/
  src/app/(dashboard)/catalog/dynamic-attributes/         (mới)
  src/features/catalog/components/dynamic-attributes/     (mới)
  src/features/catalog/{types,schemas,hooks}/dynamic-attribute*  (mới)
  src/features/catalog/components/categories/category-form-dialog.tsx (+attributeMode)
  src/features/catalog/schemas/category-schema.ts          (+attributeMode)
  src/features/product/components/products/product-form.tsx (rẽ nhánh attributeMode, ma trận biến thể = TODO)
  src/lib/constants.ts                                      (+route +menu)

fashion_frontend_user/
  src/components/layout/nav.tsx, mobile-menu.tsx, site-footer.tsx (menu AI đổi, "Danh mục▾" thay "Nữ/Nam")
  src/features/catalog/components/home/hero.tsx             (2 slide đổi nội dung)
  src/features/catalog/components/ai/**                     (mới — 3 màn AI)
  src/app/(shop)/ai-assistant/, ai-image-search/, ai-review-summary/ (mới)
  src/lib/constants.ts                                       (route AI mới, APP_TAGLINE)
```

## 12. Việc tiếp theo
* [ ] FE user: trang sản phẩm/danh sách/filter rẽ nhánh theo `attributeMode` (hiện đang luôn giả định
      ColorPicker/SizePicker/size-guide kiểu thời trang — sản phẩm ngành động sẽ hiển thị sai/thiếu chọn biến thể
      cho tới khi làm bước này). Kiểm 2026-10-04: mã FE user mới chỉ có `attributeMode` trong `catalog-adapter.ts` + kiểu sinh — việc theo dõi ở `fashion_frontend_user/docs/plans/PLAN-0008-*.md` (F-U1 của PLAN-0017).
* [~] FE admin: ma trận biến thể (chọn tối đa 2 trục × giá trị) — repo FE admin nay có `product-variants-editor.tsx` + `product-attribute-fields.tsx` (kiểm 2026-10-04, chưa kiểm hoạt động; việc theo dõi ở
      `fashion_frontend_admin/docs/plans/PLAN-0002-vendor-portal.md`, F-A2 của PLAN-0017).
* [x] `eco_fashion.dbml` + `docs/06_FE_CONTRACT.md` — đã cập nhật model/endpoint mới (đợt rà soát 2026-10-03/04).
* [ ] `npm run verify` lại ở `fashion_frontend_admin` và `fashion_frontend_user` (chỉ mới verify eco_backend
      trong lượt làm việc gần nhất — 2 FE repo có thay đổi từ trước, chưa re-check sau các thay đổi backend)
* [ ] Live browser click-through thật (test phase của plan→code→test→review) — hiện mới xác nhận qua
      API/curl trực tiếp, chưa qua UI
* [ ] Các giới hạn BE ở mục 14.

## 13. Definition of Done
* [x] Build/lint/boundaries/test xanh — eco_backend
* [ ] Build/lint/boundaries/test xanh — fashion_frontend_admin, fashion_frontend_user (chưa re-verify lượt này)
* [x] Migration additive-only, dữ liệu thời trang không đổi 1 dòng nào (24 sản phẩm cũ seed lại không lỗi)
* [x] Khởi động app thật không lỗi DI
* [x] AGENTS.md cập nhật (cả 3 repo); dbml/06_FE_CONTRACT đã cập nhật (2026-10-03/04)
* [x] Plan checklist + nhật ký cập nhật

---

## 14. Làm khác thiết kế & giới hạn đã biết (rà soát mã nguồn 2026-10-04)

* **Chỉ ngành LÁ nhận sản phẩm** (`ProductService`: `catalog.categoryHasChildren` ⇒ `PRODUCT_CATEGORY_INVALID`); `attributeMode` đọc từ chính ngành lá, không kế thừa cha (đúng §9). **Đổi `attributeMode` bị khoá khi ngành đã có sản phẩm**
  (`CATALOG_CATEGORY_MODE_LOCKED`) và xoá giá trị thuộc tính động đang dùng bị chặn (`CATALOG_ATTRIBUTE_VALUE_IN_USE`) — catalog hỏi `CatalogUsageRegistry` (product đăng ký provider lúc khởi động) để không đọc bảng product/không import ngược.
* **Kiểm kiểu thuộc tính (number/text/select) ở product chỉ chạy "nếu có `inputType`"**: `CatalogQueryApi.getCategoryAttributeTemplate()` trả `CategoryAttributeTemplateItem {attributeId, required, isVariantAxis}` — CHƯA có `inputType`
  nên nhánh kiểm kiểu trong `ProductService` (`TemplateAttr.inputType?`) hiện chưa được kích hoạt; `GET /shop/catalog/categories/:slug/attribute-template` thì có `inputType` (đọc trực tiếp ở catalog).
* **Ràng buộc chỉ do service giữ** (DB không chặn): tối đa 2 dòng `is_variant_axis = true`/ngành, tối đa 2 `product_variant_options`/biến thể, bộ options đúng bộ trục của mẫu ngành lá; trục phải là thuộc tính `select` (catalog kiểm lúc `PUT /admin/categories/:categoryId/attributes` — `CATALOG_VARIANT_AXIS_NOT_SELECT`);
  `unique (product_id, color_code, size_code)` không chặn trùng tổ hợp trục dynamic vì cột NULL (service kiểm).
* **Chưa có** route công khai `GET /categories/:slug` / attribute-template cho khách và bộ lọc `GET /products/filters` theo thuộc tính động (chỉ màu/size/khoảng giá của thời trang).
* **Thử đồ 2D / phân tích ảnh người** là tính năng thời trang cũ: route BE còn, FE đã ẩn khỏi menu; `TRYON_CATEGORY` ánh xạ ngành → upper/lower/dresses chỉ có nghĩa với ngành thời trang.
