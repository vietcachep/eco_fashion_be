# 03 — Luật cơ sở dữ liệu

## Schema-per-module

```text
identity   users, roles, permissions, role_permissions, user_permissions, refresh_tokens, login_histories,
           addresses, audit_logs, outbox_events, processed_events   (OTP đặt lại mật khẩu nằm ở Redis, không có bảng)
catalog    categories, collections, attributes, attribute_values, audit_logs, outbox_events   (không brands — một cửa hàng)
product    products, product_variants, product_images, stock_receipts, stock_receipt_items, stock_movements,
           audit_logs, outbox_events, processed_events, idempotency_keys
cart       carts, cart_items, wishlists   (không audit/outbox — dữ liệu tạm của khách)
order      orders, order_items, order_status_histories, return_requests, return_request_items, order_sequences,
           audit_logs, outbox_events, processed_events, idempotency_keys   (phí ship nằm ở system.provinces)
payment    payment_methods, payments, payment_transactions, refunds, bank_transfer_confirmations,
           audit_logs, outbox_events, processed_events
promotion  promotions, promotion_targets, promotion_usages, audit_logs
review     reviews (media json), review_replies, audit_logs, outbox_events, processed_events
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
   (`migrate deploy` + `migrate diff --exit-code`) gác lệch schema ↔ DB trong CI. Migration đã chạy trên DB
   chung là bất biến; thay đổi = migration mới. Không dùng `db push`, không `migrate reset` trên DB chung.
4. Khoá chính `uuid` (`gen_random_uuid()`); cột chuẩn: `created_at timestamptz`, `created_by uuid`,
   `updated_at`, `updated_by`, `version int` (optimistic), `is_deleted bool` (soft delete) — chép khuôn Base
   Columns vào từng model (Prisma không có kế thừa model; `src/prisma-boundaries.spec.ts` gác model đúng schema).
5. Tiền `numeric(14,0)` VND; tỉ lệ `numeric(5,2)`; số lượng `int`.
6. Unique index là chốt cuối chống trùng (partial index cho bản ghi sống: `WHERE is_deleted = false`).
7. Tồn kho, lượt mã giảm giá, số đơn: đọc-sửa-ghi trong transaction có `SELECT ... FOR UPDATE`.
8. Mỗi module có `audit_logs`, `outbox_events`, `processed_events` riêng (module nào cần); `idempotency_keys`
   riêng cho module có API ghi cần idempotency key thật.
9. Tìm kiếm: `product.products.search_vector tsvector` (unaccent + simple) + `pg_trgm` cho gõ sai;
   `ai.product_embeddings.embedding` / `ai.document_chunks.embedding` `vector(1536)` cosine (`<=>`) quét tuần tự — Prisma
   không quản lý được index HNSW nên chỉ tạo ngoài Prisma khi dữ liệu lớn (`CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`).
11. Reporting là module DUY NHẤT được `SELECT` thẳng bảng schema khác (raw SQL chỉ đọc, ghi rõ trong service); mọi module khác
    đi qua queryapi/gateway.
10. Data retention: `login_histories`, `product_view_events`, `chat_sessions`, `usage_logs`, `notifications`
    đã đọc — job dọn theo tham số (ngày). Không xoá cứng đơn/thanh toán.

## Migration đã có

| Migration | Module | Nội dung |
|---|---|---|
| `20260915022842_identity_init` | identity | extension pgcrypto/unaccent/pg_trgm (dùng chung), schema identity đầy đủ, partial unique `uq_users_email_active` (lower(email)), `uq_users_phone_active`, `uq_addresses_one_default_per_user` |
| `20260915070000_identity_google_login` | identity | `users.google_sub` unique; `addresses.province_code` nullable |
| `20260915080000_catalog_product_init` | catalog, product | 2 schema; partial unique slug/SKU/ảnh chính; CHECK tồn kho; `public.f_unaccent` IMMUTABLE; trigger `search_vector` + GIN tsvector + GIN trigram |
| `20260915110000_shop_modules_init` | cart, order, payment, promotion, review, system, reporting, ai | 8 schema; `CREATE EXTENSION vector`; `uq_promotions_code_active` (upper(code)); `uq_payment_transactions_provider_ref` (type, provider_ref); `uq_payments_order_live`; CHECK tiền ≥ 0 / used_count / rating 1..5 |
| `20260915111000_ai_drop_hnsw` | ai | bỏ 2 index HNSW (Prisma không biểu diễn được → `migrate diff` luôn lệch); tạo lại ngoài Prisma khi cần |
| `20260915130000_ai_agent_faq_signals` | ai | `chat_messages.meta` json; `product_view_events.event_type` (CHECK view/add_to_cart/click/impression) + `source`; bảng `product_faqs` |

Đặt tên `<timestamp>_<module>_<slug>` — Prisma sắp theo timestamp, tên có module để đọc lịch sử dễ.
Sau migration mới của module nào, **phải chạy `perms:sync`/seed tương ứng** qua compose (`docs/05`).

Sơ đồ: `docs/database/eco_fashion.dbml` (dán vào dbdiagram.io). Thiết kế từng module: `docs/database/<m>-database-design.md`.
