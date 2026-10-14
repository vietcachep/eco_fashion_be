# 03 — Luật cơ sở dữ liệu

## Schema-per-module

```text
identity   users, roles (scope platform|shop), permissions, role_permissions, user_permissions, refresh_tokens, login_histories,
           addresses, audit_logs, outbox_events, processed_events   (OTP đặt lại mật khẩu nằm ở Redis, không có bảng)
shop       shops, shop_members, audit_logs, outbox_events, processed_events   (gian hàng + chủ/nhân viên gian hàng — PLAN-0014/0017; chủ shop thêm nhân viên trực tiếp, bảng lời mời đã bỏ ở 20261013090000;
           gian hàng chính chủ "FITLY Official" id cố định 00000000-0000-0000-0000-000000000001)
catalog    categories (attribute_mode), collections, attributes, attribute_values, dynamic_attributes, dynamic_attribute_values,
           category_attributes, audit_logs, outbox_events   (không brands; danh mục DÙNG CHUNG toàn sàn — gian hàng sở hữu
           sản phẩm qua product.products.shop_id; thuộc tính động cho ngành ngoài thời trang — PLAN-0016)
product    products (shop_id), product_variants (shop_id), product_attribute_values, product_variant_options, product_images,
           stock_receipts (shop_id), stock_receipt_items, stock_movements, audit_logs, outbox_events, processed_events, idempotency_keys
cart       carts, cart_items (shop_id), wishlists   (không audit/outbox — dữ liệu tạm của khách)
order      order_groups, order_group_sequences, orders (shop_id, order_group_id), order_items (shop_id), order_status_histories,
           return_requests, return_request_items, order_sequences, audit_logs, outbox_events, processed_events, idempotency_keys
           (phí ship nằm ở system.provinces; 1 lần checkout = 1 order_groups + N orders, mỗi shop một đơn con)
payment    payment_methods, payments, payment_transactions, refunds (shop_id), bank_transfer_confirmations,
           shop_wallets, shop_wallet_transactions, shop_wallet_deposit_requests (ví quỹ COD), shop_payouts, shop_payout_lines (đối soát),
           audit_logs, outbox_events, processed_events   (PLAN-0017)
promotion  promotions (scope platform|shop, shop_id), promotion_targets, promotion_usages, audit_logs
review     reviews (shop_id; media json), review_replies, audit_logs, outbox_events, processed_events
system     settings, provinces, banners, notifications, contact_messages, faqs, pages, audit_logs
reporting  daily_sales (worker tính; đọc xuyên schema CHỈ SELECT — ngoại lệ có chủ đích duy nhất)
ai         product_embeddings, documents, document_chunks, chat_sessions, chat_messages (meta), support_requests, usage_logs,
           try_on_jobs, style_analyses, review_summaries, moderation_flags, product_faqs, product_view_events (event_type, source),
           audit_logs, processed_events   (đề xuất hành động chatbot sống ở Redis 30', không có bảng)
```

## Luật

1. FK chỉ trong cùng schema. Không FK xuyên module. Tham chiếu chéo: `id` + `code`/`sku`/`order_no` +
   snapshot; hoặc `source_module/source_type/source_id/source_no`.
2. **Prisma 7** là ORM duy nhất. Schema dạng thư mục `prisma/schema/<module>.prisma` (module sở hữu file của
   mình, mọi model `@@schema("<module>")` + `@@map` snake_case); `base.prisma` giữ generator + datasource
   (`schemas = [...]` = danh sách module). Client sinh ra ở `src/generated/prisma` (gitignore, `postinstall`),
   `moduleFormat = "cjs"`, `importFileExtension = ""` (không đuôi — để `ts-node` chạy script từ `.ts` và
   `dist` chạy từ `.js` cùng một mã sinh).
3. Migration SQL là nguồn sự thật (`prisma/migrations/<timestamp>_<slug>/migration.sql`, commit vào repo).
   Tạo bằng `npm run migration:create -- --name <slug>` (`migrate dev --create-only`) rồi **sửa tay** những
   thứ Prisma không biểu diễn: `CREATE EXTENSION`, partial unique index, trigger, view. `npm run migration:check`
   (`migrate deploy` + `migrate diff --exit-code`) gác lệch schema ↔ DB (chạy tay trước khi phát hành; repo hiện chưa có workflow CI). Migration đã chạy trên DB
   chung là bất biến; thay đổi = migration mới. Không dùng `db push`, không `migrate reset` trên DB chung.
4. Khoá chính `uuid` (`gen_random_uuid()`); cột chuẩn: `created_at timestamptz`, `created_by uuid`,
   `updated_at`, `updated_by`, `version int` (optimistic), `is_deleted bool` (soft delete) — chép khuôn Base
   Columns vào từng model (Prisma không có kế thừa model; `src/prisma-boundaries.spec.ts` gác model đúng schema). Bảng nối / sổ cái /
   dữ liệu dẫn xuất được miễn một phần (`role_permissions`, `shop_members`, `order_groups`, `shop_wallet_transactions`… — ghi rõ ở comment model).
5. Tiền `numeric(14,0)` VND; tỉ lệ `numeric(5,2)`; số lượng `int`.
6. Unique index là chốt cuối chống trùng (partial index cho bản ghi sống: `WHERE is_deleted = false`).
7. Tồn kho, lượt mã giảm giá, số đơn: đọc-sửa-ghi trong transaction có `SELECT ... FOR UPDATE`.
8. Mỗi module có `audit_logs`, `outbox_events`, `processed_events` riêng (module nào cần); `idempotency_keys`
   riêng cho module có API ghi cần idempotency key thật.
9. Tìm kiếm: `product.products.search_vector tsvector` (unaccent + simple) + `pg_trgm` cho gõ sai;
   `ai.product_embeddings.embedding` / `ai.document_chunks.embedding` `vector(1536)` cosine (`<=>`) quét tuần tự — Prisma
   không quản lý được index HNSW nên chỉ tạo ngoài Prisma khi dữ liệu lớn (`CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`).
10. Data retention: `login_histories`, `product_view_events`, `chat_sessions`, `usage_logs`, `notifications`
    đã đọc — job dọn theo tham số (ngày). Không xoá cứng đơn/thanh toán.
11. Reporting là module DUY NHẤT được `SELECT` thẳng bảng schema khác (raw SQL chỉ đọc, ghi rõ trong service); mọi module khác
    đi qua queryapi/gateway.
12. Gian hàng (PLAN-0014/0017): mọi cột `shop_id` (product, cart_items, orders, order_items, reviews, refunds, stock_receipts,
    promotions, ví/đối soát…) là id TRẦN trỏ `shop.shops.id` — không FK xuyên schema; ghi lúc tạo bản ghi (denormalize/snapshot
    từ product/order) để lọc theo shop không phải JOIN. Thêm `shop_id` vào bảng đã có dữ liệu = migration nhiều bước: thêm cột
    nullable → backfill (JOIN từ bảng gốc, mặc định về FITLY Official `00000000-0000-0000-0000-000000000001`) → `SET NOT NULL`
    → index (xem `product_shop_id`, `cart_item_shop_id`, `order_group_shop_split`). Ngoại lệ có chủ đích: `stock_receipts.shop_id`,
    `refunds.shop_id` nullable (NULL = phiếu của sàn / hoàn tiền cũ chưa gắn được shop). Vai `identity.roles.scope='shop'` không bao giờ
    gán vào `users.role_id`; chỉ qua `shop.shop_members.role_id`.
13. Unique theo phạm vi gian hàng: SKU duy nhất TRONG một shop, chỉ biến thể còn sống — partial unique
    `uq_product_variants_shop_sku_active (shop_id, sku) WHERE is_deleted = false` (hai shop được trùng SKU; SKU xoá mềm dùng lại
    được). Prisma không biểu diễn partial index nên KHÔNG khai `@@unique([shopId, sku])` trong `product.prisma` (khai sẽ tính cả bản
    xoá mềm và làm `migrate diff` lệch); service kiểm trước để báo lỗi rõ. Mã voucher (`uq_promotions_code_active`, `upper(code)`)
    vẫn duy nhất TOÀN SÀN, không theo shop.
13b. Unique MỘT PHẦN của thành viên gian hàng (PLAN-0017 §12, migration `20261004090000_shop_invitations`) — Prisma không biểu diễn nên viết tay trong migration,
    `migrate diff` bỏ qua index có `WHERE`: `uq_shop_members_one_active_per_user (user_id) WHERE status = 'active'` (CHẶN GỐC luật "mỗi người chỉ thuộc MỘT
    gian hàng active"; `ShopMemberService.add` chỉ còn tạo tài khoản MỚI hoặc khôi phục nhân viên cũ của CHÍNH shop, và quy lỗi unique về 409 `SHOP_MEMBER_UNAVAILABLE`
    thay vì để lộ lỗi DB). Migration `20261004090000` dừng với thông báo rõ nếu DB còn user active ở ≥ 2 shop (không tự xoá dữ liệu). Lịch sử: cùng migration đó từng tạo
    thêm `uq_shop_invitations_pending_shop_email` + bảng `shop_invitations` (lời mời có chấp nhận) — chủ dự án chuyển sang luồng "chủ shop thêm nhân viên trực tiếp"
    nên `20261013090000_drop_shop_invitations` chỉ `DROP TABLE` bảng đó (kéo theo index/CHECK/FK của nó); `uq_shop_members_one_active_per_user` được GIỮ NGUYÊN.
14. "Enum bằng string" (status/type/kind/scope…) có CHECK viết tay trong migration (vd `ck_shops_status`, `ck_roles_scope`, `ck_shop_members_status`,
    `chk_promotions_scope`, `chk_shop_payouts_status`, `chk_shop_wallet_tx_type`). Thêm giá trị mới = migration `DROP CONSTRAINT` +
    `ADD CONSTRAINT` CÙNG LÚC với code ghi giá trị đó (CHECK quá hẹp làm INSERT bị Postgres từ chối — đã xảy ra ở
    `payout_status_carried_settled`; `wallet_cod_refund_type` cũng là sửa CHECK). Tiền tố tên hiện có hai kiểu: `ck_` (các migration đến
    `shop_init`/`identity_role_scope`) và `chk_` (PLAN-0017, kể cả `chk_promotions_scope` cạnh `ck_promotions_used_le_limit`) —
    khi sửa giữ nguyên tên cũ. Sổ cái ví (`shop_wallet_transactions`)
    APPEND-ONLY, chống ghi trùng bằng unique `(shop_id, type, order_code)`.

## Migration đã có

| Migration | Module | Nội dung |
|---|---|---|
| `20260915022842_identity_init` | identity | extension pgcrypto/unaccent/pg_trgm (dùng chung), schema identity đầy đủ, partial unique `uq_users_email_active` (lower(email)), `uq_users_phone_active`, `uq_addresses_one_default_per_user` |
| `20260915070000_identity_google_login` | identity | `users.google_sub` unique; `addresses.province_code` nullable |
| `20260915080000_catalog_product_init` | catalog, product | 2 schema; partial unique slug/SKU/ảnh chính (`uq_product_variants_sku_active` unique(sku) toàn sàn — đã gỡ ở `20261003140000`); CHECK tồn kho; `public.f_unaccent` IMMUTABLE; trigger `search_vector` + GIN tsvector + GIN trigram |
| `20260915110000_shop_modules_init` | cart, order, payment, promotion, review, system, reporting, ai | 8 schema; `CREATE EXTENSION vector`; `uq_promotions_code_active` (upper(code)); `uq_payment_transactions_provider_ref` (type, provider_ref); `uq_payments_order_live`; CHECK tiền ≥ 0 / used_count / rating 1..5 |
| `20260915111000_ai_drop_hnsw` | ai | bỏ 2 index HNSW (Prisma không biểu diễn được → `migrate diff` luôn lệch); tạo lại ngoài Prisma khi cần |
| `20260915130000_ai_agent_faq_signals` | ai | `chat_messages.meta` json; `product_view_events.event_type` (CHECK view/add_to_cart/click/impression) + `source`; bảng `product_faqs` |
| `20260928014536_shop_init` | shop | schema `shop` mới: `shops`, `shop_members`, `audit_logs`, `outbox_events`, `processed_events`; unique `code`/`slug`, unique (shop_id, user_id); CHECK `ck_shops_status` (pending/approved/suspended/rejected), `ck_shop_members_status` (active/removed), `ck_shops_commission_rate` 0..100, `ck_shops_total_products` ≥ 0 |
| `20260928014603_identity_role_scope_and_shop_permissions` | identity | `roles.scope` (platform\|shop, mặc định platform) + CHECK `ck_roles_scope`; vai `shop_owner`/`shop_staff` và mã quyền `shop.*`/`supplier.shop.*` nạp qua `perms:sync`, không qua migration |
| `20260929084707_product_shop_id` | product | tạo gian hàng mặc định FITLY Official (id cố định `00000000-0000-0000-0000-000000000001`, code `SHOP-000001`, hoa hồng 0%); `products.shop_id` + `product_variants.shop_id` (nullable → backfill → NOT NULL) + index; thêm unique (shop_id, sku) — dừng giữa chừng trên DB có SKU trùng, vá ở `20260929093500` |
| `20260929084708_cart_item_shop_id` | cart | `cart_items.shop_id` (backfill từ `products`, NOT NULL) + index |
| `20260929084709_review_shop_id` | review | `reviews.shop_id` (backfill từ `products`, NOT NULL) + index |
| `20260929093500_product_variant_shop_sku_unique_fix` | product | đổi tên SKU trùng trong cùng shop (hậu tố `-DUPn`, không xoá dữ liệu); tạo lại unique (shop_id, sku) + index `shop_id` có kiểm tồn tại (idempotent) |
| `20260929100000_order_group_shop_split` | order | `order_groups` + `order_group_sequences`; `orders.shop_id`, `orders.order_group_id` (FK RESTRICT), `orders.commission_rate_snapshot`; `order_items.shop_id`; backfill đơn cũ thành nhóm 1-đơn (mã nhóm = `DHN` + phần sau `DH` của mã đơn) |
| `20260929120000_multi_category_attributes` | catalog, product | `categories.attribute_mode` (mặc định `dynamic`; backfill category cũ = `legacy_fashion`); `dynamic_attributes`, `dynamic_attribute_values`, `category_attributes`; `product_variants.color_code/color_name/size_code` thành NULLABLE; `product_attribute_values`, `product_variant_options` |
| `20261003100000_marketplace_completion` | promotion, shop, payment | `promotions.scope/shop_id` + CHECK `chk_promotions_scope`; `shops.bank_code/bank_account_number/bank_account_name`; `refunds.shop_id` (backfill từ `orders`); ví COD (`shop_wallets`, `shop_wallet_transactions`, `shop_wallet_deposit_requests`) + đối soát (`shop_payouts`, `shop_payout_lines`) kèm CHECK status/type/kind (`chk_*`); backfill ví số dư 0 cho shop đã duyệt; đổi tên `idx_*`/`uc_*` cũ về quy ước Prisma |
| `20261003110000_stock_receipt_shop_id` | product | `stock_receipts.shop_id` nullable (NULL = phiếu của sàn) + index (shop_id, created_at DESC); backfill phiếu cũ = FITLY Official |
| `20261003120000_order_voucher_split` | order | `orders.shop_discount`, `platform_discount`, `shop_promotion_code`, `shop_promotion_name` (đơn con mang tối đa 1 voucher sàn + 1 voucher shop); backfill `platform_discount = discount` cho đơn có `promotion_code` |
| `20261003130000_payout_status_carried_settled` | payment | sửa CHECK `chk_shop_payouts_status`: thêm `carried` (net < 0, không chi, mang nợ) và `settled` (net = 0) |
| `20261003140000_product_variant_sku_per_shop` | product | gỡ `uq_product_variants_sku_active` (unique(sku) toàn sàn) và unique (shop_id, sku) tính cả xoá mềm; tạo partial unique `uq_product_variants_shop_sku_active (shop_id, sku) WHERE is_deleted = false` |
| `20261003160000_wallet_cod_refund_type` | payment | sửa CHECK `chk_shop_wallet_tx_type`: thêm loại sổ cái `cod_refund` (hoàn tiền đơn COD đã thu) |
| `20261004090000_shop_invitations` | shop | bảng `shop_invitations` (email chữ thường, status `pending`/`accepted`/`declined`/`cancelled`, hạn 7 ngày, FK CASCADE về `shops`) + CHECK `ck_shop_invitations_status`/`ck_shop_invitations_email_lower`; partial unique `uq_shop_invitations_pending_shop_email` **(bảng `shop_invitations` và các index/CHECK của nó đã bỏ ở `20261013090000_drop_shop_invitations`)**; partial unique `uq_shop_members_one_active_per_user (user_id) WHERE status = 'active'` (kiểm trùng dữ liệu cũ trước, dừng rõ nếu có) — phần này còn hiệu lực |
| `20261004100000_review_reply_author_kind` | review | `review_replies.author_kind` (`shop`\|`platform`, NOT NULL DEFAULT `platform`, CHECK `ck_review_replies_author_kind`); backfill `shop` khi người trả lời từng là thành viên của shop sở hữu đánh giá hoặc `staff_name` trùng tên shop (đọc chéo schema `shop` CHỈ trong câu backfill một lần); `staff_name` cũ giữ nguyên nhưng KHÔNG còn ra API |
| `20261004120000_payment_refund_hardening` | payment | `refunds.kind` (`order`\|`duplicate_payment`, NOT NULL DEFAULT `order`, CHECK `chk_refunds_kind`; backfill theo lý do "Thanh toán trùng%") + `refunds.gateway_attempted_at` (dấu ghi TRƯỚC khi gọi cổng VNPay — còn dấu mà chưa có `provider_ref` = chưa rõ cổng đã hoàn hay chưa) |
| `20261013090000_drop_shop_invitations` | shop | `DROP TABLE IF EXISTS shop.shop_invitations` (kéo theo index/CHECK/FK của bảng) — chủ dự án chọn luồng chủ shop THÊM nhân viên trực tiếp thay cho lời mời có chấp nhận; GIỮ NGUYÊN `uq_shop_members_one_active_per_user`; dữ liệu lời mời cũ mất theo bảng, dòng audit `SHOP_INVITATION_*` trong `shop.audit_logs` vẫn giữ làm lịch sử |

Đặt tên `<timestamp>_<module>_<slug>` — Prisma sắp theo timestamp, tên có module để đọc lịch sử dễ.
Sau migration mới của module nào, **phải chạy `perms:sync`/seed tương ứng** qua compose (`docs/05`).

Sơ đồ: `docs/database/eco_fashion.dbml` (dán vào dbdiagram.io; phản ánh tới migration `20261013090000_drop_shop_invitations`). Thiết kế từng module:
`docs/database/<m>-database-design.md`.
