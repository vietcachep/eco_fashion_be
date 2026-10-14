# Thiết kế DB — cart · order · payment · promotion · review · system · reporting · ai (PLAN-0005 → 0013)

Model: `prisma/schema/{cart,order,payment,promotion,review,system,reporting,ai}.prisma`. Migration `20260915110000_shop_modules_init`
(+ `20260915111000_ai_drop_hnsw`). Sơ đồ: `docs/database/eco_fashion.dbml`. Không FK xuyên schema — tham chiếu bằng id + code + snapshot.

Từ PLAN-0014/0017 sàn là ĐA GIAN HÀNG: các bảng order/cart/payment/promotion/review có thêm `shop_id` (id trần trỏ `shop.shops.id`),
thêm `order_groups`, ví COD và đối soát (payout) — các dòng ghi chú `PLAN-0014/0017` trong bảng dưới và mục "Marketplace" cuối file.
Schema `shop` (gian hàng + thành viên) mô tả ở `docs/database/eco_fashion.dbml` và `docs/03_DATABASE_RULES.md`.

## cart

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `carts` | một giỏ / user | `user_id` unique |
| `cart_items` | dòng theo biến thể | unique (cart_id, variant_id); `selected` tick thanh toán; KHÔNG lưu giá — đọc tươi từ product; `shop_id` (PLAN-0014 bước 6) denormalize từ product lúc thêm giỏ để tách giỏ theo shop khi checkout |
| `wishlists` | yêu thích theo sản phẩm | unique (user_id, product_id) |

## order

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `order_groups` | đơn CHA (PLAN-0014 bước 7) | 1 lần checkout = 1 nhóm + N `orders` con (mỗi shop một đơn); `code` unique `DHNyymmddNNNN` (`order_group_sequences` riêng); chỉ gom địa chỉ giao + tổng tiền hiển thị, KHÔNG có trạng thái/version/is_deleted; đơn single-shop cũ được backfill thành nhóm 1-đơn |
| `orders` | đơn hàng (đơn CON của một shop) | `code` unique `DHyymmddNNNN` (`order_sequences` FOR UPDATE); `shop_id` + `order_group_id` (FK → `order_groups`, bắt buộc) + `commission_rate_snapshot` (% hoa hồng đóng băng lúc đặt); snapshot địa chỉ (`province_code` nullable + tên), tiền (`subtotal/shipping_fee/discount/total` numeric(14,0), CHECK ≥ 0), khuyến mãi tách hai bên chịu phí: `platform_discount` + `promotion_code/name` (voucher SÀN), `shop_discount` + `shop_promotion_code/name` (voucher GIAN HÀNG), `discount` = tổng hai phần; `payment_method_code`, `payment_status` unpaid\|processing\|paid\|refunded\|partially_refunded, `status` pending→confirmed→packing→shipping→delivered→completed / cancelled; mốc `*_at` từng bước; `payment_expires_at` cho job huỷ quá hạn |
| `order_items` | dòng đơn | snapshot slug/name/image/color/size/sku/unit_price/line_total; `reviewed` (review đánh dấu); `shop_id` đồng bộ `orders.shop_id` (báo cáo theo shop khỏi JOIN) |
| `order_status_histories` | lịch sử trạng thái | actor null = job/hệ thống |
| `return_requests` + `return_request_items` | đổi trả | `evidence` json MediaItem[] ≥ 1; `refund_amount` theo tỉ lệ giảm; status requested\|approved\|rejected\|refunded |
| `order_sequences` | đếm mã theo ngày | `day` yymmdd pk |
| `order_group_sequences` | đếm mã nhóm theo ngày | `day` yymmdd pk — tách khỏi `order_sequences` |
| audit/outbox/processed/idempotency | khuôn common | idempotency cho `POST /orders` (scope order.place) |

## payment

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `payment_methods` | cod / bank_transfer / vnpay / payos | `code` pk, bật/tắt; `payos` bật trong DB nhưng khách chỉ thấy khi backend có khoá PayOS (`isMethodActive`) |
| `payments` | một thanh toán sống / đơn | `uq_payments_order_live` (order_id WHERE status IN pending/processing/paid); `transfer_content` = mã đơn (VietQR); `card_last4/card_brand` chỉ từ VNPay trả về — KHÔNG lưu số thẻ; `refunded_amount`; `expires_at`; payment gắn từng đơn CON (không phải `order_groups`); `gateway_response` giữ payload webhook gốc (PayOS: có `counterAccount*` để hoàn tiền tự động) |
| `payment_transactions` | nhật ký gọi cổng | `uq_payment_transactions_provider_ref` (type, provider_ref) → IPN/return/webhook gửi lại không ghi đôi; `type` create_url · ipn · payos_webhook · return · query · refund · manual_confirm · cod_collect; PayOS: `provider_ref` = orderCode PayOS (số, `Date.now()*1000 + random(1000)`); `raw_*` json đã che |
| `bank_transfer_confirmations` | đối soát chuyển khoản tay | `confirmed_by` kế toán, `bank_ref` |
| `refunds` | hoàn tiền | status requested→processing→done\|failed; `method` gateway\|manual_transfer; `return_request_id` khi từ đổi trả; `shop_id` (PLAN-0017) snapshot gian hàng của đơn để đối soát trừ hoàn tiền đúng shop (NULL nếu không gắn được); `kind` order\|duplicate_payment (khoản trùng không đảo doanh thu/hoa hồng); `gateway_attempted_at` dấu gọi cổng VNPay để không gọi lại mù |
| `shop_wallets` + `shop_wallet_transactions` + `shop_wallet_deposit_requests` | ví quỹ COD theo shop (PLAN-0017) | ví 1-1 với shop (`shop_id` unique), `balance` CÓ THỂ ÂM — `balance ≤ 0` thì tắt `shop.shops.cod_enabled`; sổ cái APPEND-ONLY `type` cod_commission\|deposit\|adjust\|cod_refund (CHECK `chk_shop_wallet_tx_type`), unique (shop_id, type, order_code) chống ghi trùng; `deposit_requests` pending→approved\|rejected (CHECK status + `amount > 0`), duyệt thì cộng ví |
| `shop_payouts` + `shop_payout_lines` | đối soát định kỳ theo shop (PLAN-0017) | kỳ unique (shop_id, period_start, period_end), số liệu đóng băng; `net_payout = gross_revenue − commission − refund_amount − carried_debt` (có thể âm); `status` pending\|processing\|paid\|failed\|carried (net < 0, mang nợ)\|settled (net = 0) — CHECK `chk_shop_payouts_status`; `bank_snapshot` chụp tài khoản nhận; dòng `kind` sale\|refund, unique (order_code, kind) toàn bảng ⇒ một đơn/hoàn tiền không vào hai kỳ |

## promotion

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `promotions` | mã giảm giá | `uq_promotions_code_active` upper(code) sống (duy nhất TOÀN SÀN, voucher sàn và voucher mọi shop chung không gian mã); type percentage\|fixed_amount\|free_shipping; `max_discount`, `min_order_amount`, `usage_limit`/`usage_limit_per_user`/`used_count` (CHECK `used_count ≤ usage_limit` khi có giới hạn), `applies_to` all\|category\|product, `starts_at/ends_at`, `is_public`; `scope` platform\|shop + `shop_id` (PLAN-0017; CHECK `chk_promotions_scope`: platform ⇒ shop_id NULL, shop ⇒ shop_id NOT NULL) |
| `promotion_targets` | phạm vi | (target_type, target_ref) = category slug / product id |
| `promotion_usages` | lượt dùng | unique (promotion_id, order_code); `released_at` khi huỷ đơn (giữ dòng truy vết) |

## review

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `reviews` | đánh giá | unique (user_id, order_item_id) — chỉ khách đã nhận hàng; snapshot product_slug/name, author_name, variant_label; `media` json MediaItem[]; `status` pending\|approved\|hidden + moderation_note/by/at; CHECK rating 1..5; `shop_id` (PLAN-0014 bước 9) snapshot từ product để vendor trả lời/lọc review của shop mình |
| `review_replies` | shop/sàn trả lời | một dòng / đánh giá (gọi lại = sửa); `author_kind` shop\|platform quyết định tên hiển thị (không lộ họ tên nhân viên) |

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
-- CHECK: orders tiền ≥ 0 (ck_orders_money_nonneg); promotions used_count ≤ usage_limit (ck_promotions_used_le_limit); reviews rating BETWEEN 1 AND 5
-- HNSW (ngoài Prisma, khi > vài nghìn dòng):
-- CREATE INDEX ix_product_embeddings_hnsw ON ai.product_embeddings USING hnsw (embedding vector_cosine_ops);
```

## Marketplace — đa gian hàng (PLAN-0014 / 0017)

Migration: `20260928014536_shop_init` (schema `shop`), `20260929084708_cart_item_shop_id`, `20260929084709_review_shop_id`,
`20260929100000_order_group_shop_split`, `20261003100000_marketplace_completion`, `20261003120000_order_voucher_split`,
`20261003130000_payout_status_carried_settled`, `20261003160000_wallet_cod_refund_type`, `20261004090000_shop_invitations` (chốt `uq_shop_members_one_active_per_user`; bảng lời mời của nó đã bỏ ở
`20261013090000_drop_shop_invitations`) (module product/catalog/identity xem `catalog-product-database-design.md`). Chi tiết cột ở `eco_fashion.dbml`.

- `shop_id` ở cart_items / orders / order_items / reviews / refunds / promotions / ví / payout là id TRẦN trỏ `shop.shops.id`; dữ liệu
  cũ backfill về gian hàng FITLY Official (`00000000-0000-0000-0000-000000000001`).
- Luồng tiền: đơn online → đối soát (`shop_payouts`: gross − hoa hồng − hoàn tiền − nợ mang); đơn COD → shop giữ tiền mặt nên sàn trừ
  hoa hồng khỏi ví (`shop_wallet_transactions`); hoàn tiền đơn COD ghi `cod_refund`. Hoa hồng tính theo `orders.commission_rate_snapshot`;
  phần giảm do voucher sàn (`platform_discount`) sàn chịu và hoàn cho shop.

```sql
-- migration 20261003100000 (các chốt PLAN-0017; tập giá trị được sửa ở 20261003130000 / 20261003160000)
ALTER TABLE promotion.promotions ADD CONSTRAINT chk_promotions_scope
  CHECK ((scope = 'platform' AND shop_id IS NULL) OR (scope = 'shop' AND shop_id IS NOT NULL));
ALTER TABLE payment.shop_payouts ADD CONSTRAINT chk_shop_payouts_status
  CHECK (status IN ('pending','processing','paid','failed','carried','settled'));            -- carried/settled: 20261003130000
ALTER TABLE payment.shop_wallet_transactions ADD CONSTRAINT chk_shop_wallet_tx_type
  CHECK (type IN ('cod_commission','deposit','adjust','cod_refund'));                          -- cod_refund: 20261003160000
ALTER TABLE payment.shop_wallet_deposit_requests ADD CONSTRAINT chk_shop_wallet_deposit_status
  CHECK (status IN ('pending','approved','rejected') AND amount > 0);
ALTER TABLE payment.shop_payout_lines ADD CONSTRAINT chk_shop_payout_lines_kind CHECK (kind IN ('sale','refund'));
-- migration 20260928014536 / 20260928014603
ALTER TABLE shop.shops ADD CONSTRAINT ck_shops_status CHECK (status IN ('pending','approved','suspended','rejected'));
ALTER TABLE shop.shop_members ADD CONSTRAINT ck_shop_members_status CHECK (status IN ('active','removed'));
ALTER TABLE shop.shops ADD CONSTRAINT ck_shops_commission_rate CHECK (commission_rate >= 0 AND commission_rate <= 100);
ALTER TABLE shop.shops ADD CONSTRAINT ck_shops_total_products CHECK (total_products >= 0);
ALTER TABLE identity.roles ADD CONSTRAINT ck_roles_scope CHECK (scope IN ('platform','shop'));
-- migration 20261004090000_shop_invitations (PLAN-0017 §12) — phần CÒN HIỆU LỰC: chốt DB cho luật "mỗi người một gian hàng"
CREATE UNIQUE INDEX uq_shop_members_one_active_per_user ON shop.shop_members (user_id) WHERE status = 'active';                 -- mỗi người chỉ thuộc MỘT gian hàng active
-- (index trên là partial nên KHÔNG khai trong shop.prisma; `prisma migrate diff` bỏ qua index có WHERE)
-- migration 20261013090000_drop_shop_invitations: DROP TABLE shop.shop_invitations (bảng lời mời + CHECK ck_shop_invitations_* + unique uq_shop_invitations_pending_shop_email
--   do 20261004090000 tạo đã bỏ cùng bảng); GIỮ NGUYÊN uq_shop_members_one_active_per_user ở trên
```

**Thêm nhân viên (thay cho lời mời có chấp nhận, từ 2026-10-13)** — không còn bảng riêng cho việc "vào shop": chủ shop gọi `POST /shop/members`, service tạo tài khoản khách mới
(`identity.users`, qua `IdentityApplicationApi`) + một dòng `shop.shop_members` (`status='active'`) trong CÙNG một transaction (khoá advisory theo shop, đếm thành viên active ≤ 50, audit
`SHOP_MEMBER_ADDED`, outbox `SHOP_MEMBER_JOINED`). Nhân viên đã bị gỡ khỏi chính shop này (dòng `status='removed'`) được thêm lại bằng cách kích hoạt lại CHÍNH dòng đó (`UNIQUE (shop_id, user_id)` giữ
một dòng cho mỗi cặp). Luật "mỗi người một shop active" vẫn do `uq_shop_members_one_active_per_user` chốt; vi phạm (đua với shop khác) quy về 409 `SHOP_MEMBER_UNAVAILABLE`.
