# Thiết kế DB — cart · order · payment · promotion · review · system · reporting · ai (PLAN-0005 → 0013)

Model: `prisma/schema/{cart,order,payment,promotion,review,system,reporting,ai}.prisma`. Migration `20260915110000_shop_modules_init`
(+ `20260915111000_ai_drop_hnsw`). Sơ đồ: `docs/database/eco_fashion.dbml`. Không FK xuyên schema — tham chiếu bằng id + code + snapshot.

## cart

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `carts` | một giỏ / user | `user_id` unique |
| `cart_items` | dòng theo biến thể | unique (cart_id, variant_id); `selected` tick thanh toán; KHÔNG lưu giá — đọc tươi từ product |
| `wishlists` | yêu thích theo sản phẩm | unique (user_id, product_id) |

## order

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `orders` | đơn hàng | `code` unique `DHyymmddNNNN` (`order_sequences` FOR UPDATE); snapshot địa chỉ (`province_code` nullable + tên), tiền (`subtotal/shipping_fee/discount/total` numeric(14,0), CHECK ≥ 0), khuyến mãi (`promotion_code/name`), `payment_method_code`, `payment_status` unpaid\|processing\|paid\|refunded\|partially_refunded, `status` pending→confirmed→packing→shipping→delivered→completed / cancelled; mốc `*_at` từng bước; `payment_expires_at` cho job huỷ quá hạn |
| `order_items` | dòng đơn | snapshot slug/name/image/color/size/sku/unit_price/line_total; `reviewed` (review đánh dấu) |
| `order_status_histories` | lịch sử trạng thái | actor null = job/hệ thống |
| `return_requests` + `return_request_items` | đổi trả | `evidence` json MediaItem[] ≥ 1; `refund_amount` theo tỉ lệ giảm; status requested\|approved\|rejected\|refunded |
| `order_sequences` | đếm mã theo ngày | `day` yymmdd pk |
| audit/outbox/processed/idempotency | khuôn common | idempotency cho `POST /orders` (scope order.place) |

## payment

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `payment_methods` | cod / bank_transfer / vnpay | `code` pk, bật/tắt |
| `payments` | một thanh toán sống / đơn | `uq_payments_order_live` (order_id WHERE status IN pending/processing/paid); `transfer_content` = mã đơn (VietQR); `card_last4/card_brand` chỉ từ VNPay trả về — KHÔNG lưu số thẻ; `refunded_amount`; `expires_at` |
| `payment_transactions` | nhật ký gọi cổng | `uq_payment_transactions_provider_ref` (type, provider_ref) → IPN/return gửi lại không ghi đôi; `raw_*` json đã che |
| `bank_transfer_confirmations` | đối soát chuyển khoản tay | `confirmed_by` kế toán, `bank_ref` |
| `refunds` | hoàn tiền | status requested→processing→done\|failed; `method` gateway\|manual_transfer; `return_request_id` khi từ đổi trả |

## promotion

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `promotions` | mã giảm giá | `uq_promotions_code_active` upper(code) sống; type percentage\|fixed_amount\|free_shipping; `max_discount`, `min_order_amount`, `usage_limit`/`usage_limit_per_user`/`used_count` (CHECK ≥ 0), `applies_to` all\|category\|product, `starts_at/ends_at`, `is_public` |
| `promotion_targets` | phạm vi | (target_type, target_ref) = category slug / product id |
| `promotion_usages` | lượt dùng | unique (promotion_id, order_code); `released_at` khi huỷ đơn (giữ dòng truy vết) |

## review

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `reviews` | đánh giá | unique (user_id, order_item_id) — chỉ khách đã nhận hàng; snapshot product_slug/name, author_name, variant_label; `media` json MediaItem[]; `status` pending\|approved\|hidden + moderation_note/by/at; CHECK rating 1..5 |
| `review_replies` | shop trả lời | một dòng / đánh giá (gọi lại = sửa) |

## system

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `settings` | tham số vận hành | `key` pk, `value` json, `is_public` → `/settings/public` |
| `provinces` | 63 tỉnh/thành | `code` pk, `region`, `shipping_fee`; order khớp tên không dấu khi FE nhập tay |
| `banners`, `faqs`, `pages` (slug pk), `contact_messages` (status new\|replied) | nội dung | |
| `notifications` | thông báo trong-app | (user_id, read_at, created_at) — dọn theo retention |

## reporting

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `daily_sales` | tổng hợp theo ngày VN | `day` yyyy-mm-dd pk; worker upsert (đơn tạo trong ngày; doanh thu = paid/partially_refunded & không huỷ; khách mới; hoàn đã xử lý) |

## ai

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `product_embeddings` | vector sản phẩm | `product_id` pk, `embedding vector(1536)` (Unsupported), `source_hash` bỏ qua khi text không đổi, status pending\|ready\|failed |
| `documents` + `document_chunks` | kho tri thức RAG | chunk ~700 ký tự, unique (document_id, chunk_index); vector NULL khi không key (tìm ILIKE) |
| `chat_sessions` + `chat_messages` | hội thoại | `user_id` hoặc `guest_key`; message `product_ids` json, `source` llm\|rule, token, `meta` json (tools, misses, suggestions, actions, guard, actionResult) |
| `product_faqs` | FAQ tự sinh | `product_id` pk, `items` json [{question,answer}], `source_hash` (mô tả + đánh giá), status ready\|pending\|failed\|none |
| `support_requests` | cần người thật | status open\|in_progress\|resolved, assigned_to/resolved_by |
| `usage_logs` | chi phí | feature/provider/model/token/cost_estimate — cổng ngân sách ngày |
| `try_on_jobs` | thử đồ 2D | status queued\|processing\|done\|failed; `provider_job_id` (idempotent khi retry); ảnh người `person_public_id` xoá sau 7 ngày |
| `style_analyses` | phân tích ảnh | `result` json {dangNguoi, mauPhuHop, phongCach, tuVan, gender, categories, colorCodes}; `product_ids` |
| `review_summaries`, `moderation_flags` | AI cho đánh giá | pk theo product_id / review_id; nhãn chỉ ĐỀ XUẤT |
| `product_view_events` | tín hiệu gợi ý + đo dải gợi ý | `event_type` view\|add_to_cart\|click\|impression (CHECK), `source` dải; khách vãng lai chỉ click/impression; dọn theo `EF_VIEW_EVENT_RETENTION_DAYS` |

## Sửa tay trong migration

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE UNIQUE INDEX uq_promotions_code_active ON promotion.promotions (upper(code)) WHERE is_deleted = false;
CREATE UNIQUE INDEX uq_payment_transactions_provider_ref ON payment.payment_transactions (type, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX uq_payments_order_live ON payment.payments (order_id) WHERE status IN ('pending','processing','paid');
-- CHECK: orders tiền ≥ 0; promotions used_count ≥ 0; reviews rating BETWEEN 1 AND 5
-- HNSW (ngoài Prisma, khi > vài nghìn dòng):
-- CREATE INDEX ix_product_embeddings_hnsw ON ai.product_embeddings USING hnsw (embedding vector_cosine_ops);
```
