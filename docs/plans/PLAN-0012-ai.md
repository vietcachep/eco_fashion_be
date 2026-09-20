# PLAN-0012 — AI: chatbot RAG, embedding & gợi ý, kiểm duyệt/tóm tắt đánh giá, soạn nội dung, cổng chi phí

> Status: Done
> Owner: Agent
> Related Phase: Phase 5 — AI
> Related Roadmap: `docs/04_ROADMAP.md`
> Hợp đồng FE: `docs/06_FE_CONTRACT.md` (mục ai)

---

## 1. Mục tiêu

* **Mọi tính năng có đường lùi không-AI**: không `EF_OPENAI_API_KEY` / hết hạn mức / provider lỗi → rule theo từ khoá (như FE `traLoiChatMock`),
  mua bán không gián đoạn. `GET /ai/status` cho FE biết cái gì đang bật.
* Chatbot **agent tool-calling** (`OpenAiProvider.runAgent`, ≤ 4 vòng): model chỉ nói điều tool trả — `search_products` (vector + từ khoá),
  `get_product_details`, `get_product_reviews`, `search_knowledge` (RAG pgvector), `get_my_orders`, `list_active_promotions`, `find_best_promotion`,
  `get_shipping_info`, `list_payment_methods`, `get_recommendations`, `request_human_support`, và hai tool CHỈ ĐỀ XUẤT `add_to_cart` / `cancel_order` →
  khách bấm Xác nhận (`ChatActionService`, Redis 30') mới ghi qua `CartGateway.addItem` / `OrderActionsGateway.cancelByCustomer`. Ngữ cảnh sản phẩm
  đang xem (`contextProductSlug`), bảng "tên → slug" của thẻ đã gửi, gợi ý 2–3 câu hỏi tiếp, `meta` (tools/misses/actions/guard) lưu trên tin.
  Guard: chặn số thẻ (Luhn) trước khi lưu, đánh dấu prompt injection. Phiên theo user hoặc `X-Guest-Key`; rule "gặp nhân viên" đi trước LLM.
* Gợi ý: tương tự (vector) · mua cùng (đồng đơn, lùi = ngành phối đồ) · cho giỏ · **bộ sưu tập theo dịp** (LLM đặt 3 chủ đề hợp thời điểm VN → vector,
  cache 24h; lùi = chủ đề rule) · **so sánh 2–3 sản phẩm** (LLM dựng tiêu chí/kết luận, cache 6h) · **FAQ tự sinh** cho sản phẩm (đọc lười, job nền,
  hash nguồn → sinh lại khi mô tả/đánh giá đổi).
* Tín hiệu: `product_view_events` (view/add_to_cart/click/impression + `source` dải) → gợi ý + **phễu hiệu quả dải gợi ý** (hiển thị → click → giỏ →
  mua trong 7 ngày). **Chat insights**: câu hỏi bot bí (tool rỗng / chuyển người / rule không thẻ) gom cụm embedding + LLM đặt tên và gợi bài nên viết.
* Nhân viên: `POST /admin/ai/ask` agent hỏi số liệu bằng tiếng Việt (chỉ gọi báo cáo có sẵn qua `ReportingQueryApi`, KHÔNG sinh SQL); soạn nháp trả lời
  yêu cầu hỗ trợ; phân loại sản phẩm mới; precheck listing trước khi đăng; nhận xét tồn kho (tốc độ bán 30 ngày); nhận xét doanh thu 30 vs 30 ngày;
  gợi ý combo từ cặp đồng mua; chỉ mục AI (status/rebuild/reindex từng bài).
* Embedding: `product_embeddings` (text-embedding-3-small, `source_hash` bỏ qua khi không đổi) nhúng lại theo outbox `PRODUCT_*`, bù mỗi giờ và
  lúc worker khởi động; `documents` → `document_chunks` (cắt ~700 ký tự) qua job BullMQ `ai`; không key vẫn lưu chunk để tìm từ khoá.
* Gợi ý "có thể bạn thích": lượt xem (`product_view_events`) + đã mua → sản phẩm tương tự theo vector → bù bán chạy.
* Đánh giá: nhãn kiểm duyệt **đề xuất** (ok/spam/toxic/off_topic — nhân viên quyết ở /admin/reviews), tóm tắt ưu/nhược khi ≥ 3 đánh giá.
* Nhân viên: kho tri thức CRUD + reindex, yêu cầu hỗ trợ, hội thoại (che email/SĐT), nhãn kiểm duyệt, soạn mô tả/trả lời/KM (`ai.copy.create`),
  chi phí (`usage_logs`, `EF_AI_DAILY_TOKEN_BUDGET`).

## 5. Thiết kế DB — schema `ai`

`product_embeddings`, `documents`, `document_chunks`, `chat_sessions`, `chat_messages`, `support_requests`, `usage_logs`, `review_summaries`,
`moderation_flags`, `product_view_events`, audit, processed_events (+ `try_on_jobs`, `style_analyses` — PLAN-0013). HNSW tạo ngoài Prisma khi lớn.

## 6. API

```text
GET /ai/status · POST /ai/chat · GET /ai/chat/sessions[/{id}] · POST /ai/chat/sessions/{id}/actions/{actionId}/confirm|reject · POST /ai/support
GET /ai/recommendations · GET /ai/products/{slug}/similar|bought-together|faq · GET /ai/cart-suggestions · GET /ai/collections · POST /ai/compare
POST /ai/events · POST /ai/events/batch · POST /ai/events/view · GET /ai/review-summary/{productId}
/admin/ai/documents CRUD · POST /admin/ai/documents/{id}/reindex · GET /admin/ai/index/status · POST /admin/ai/index/rebuild (= /reindex)
/admin/ai/support[/{id}] · POST /admin/ai/support/{id}/draft-reply · /admin/ai/chat/sessions · GET /admin/ai/chat-insights · /admin/ai/moderation-flags
POST /admin/ai/reviews/{id}/moderate · POST /admin/ai/review-summaries/{productId} · POST /admin/ai/copy · POST /admin/ai/classify-product
POST /admin/ai/precheck-product/{productId} · GET /admin/ai/inventory-insights · GET /admin/ai/revenue-insight · GET /admin/ai/combo-suggestions
POST /admin/ai/ask · GET /admin/ai/usage · GET /admin/ai/recommendation-stats
```

## 7. Bước triển khai

* [x] B1 providers (OpenAiProvider — chỗ duy nhất gọi OpenAI; ReplicateProvider) + AiUsageService (ngân sách) · [x] B2 EmbeddingService (pgvector raw SQL)
* [x] B3 ChatService (rule → LLM → rule) · KnowledgeService · AiInsightService · ReviewAiService · [x] B4 AiWorkerModule (relay review, listener product/review, processor `ai`, dọn retention)
* [x] B5 seed kho tri thức + phiên chat mẫu + hỗ trợ + lượt xem (`ai.seed.ts`) · test thuần · smoke · docs
* [x] B6 (đợt 3 — port đủ eco_books trừ dịch) agent tool-calling + hành động xác nhận + guard · RecommendationService (similar/bought-together/cart/collections/compare)
  · ProductFaqService (job `product-faq`) · SignalService (events/batch + stats) · ChatInsightsService · MetricsAgentService (ask) · StaffInsightService
  (classify/precheck/inventory/revenue/combo) · draft-reply · index status/rebuild · migration `20260915130000_ai_agent_faq_signals` · 37 test xanh

## 8. Kiểm thử

* [x] Smoke với key thật (đợt 2): chat LLM gợi ý 2 áo thun trắng < 200k; hỏi phí ship Hà Nội → RAG trả 40.000₫/freeship 500k; "gặp nhân viên" →
  support request + thông báo; recommendations; admin: support resolve, documents ready, sessions che PII, copy, usage; khách xem usage → 403.
* [x] Smoke đợt 3: số thẻ → 400 AI_CHAT_CARD_DATA; "sơ mi nam đi làm 350k, ship Đà Nẵng" → tools search_products + get_shipping_info trong một lượt, 3 gợi ý câu hỏi;
  contextProductSlug → get_product_details + get_product_reviews; "thêm áo thun trắng M ×2" → đề xuất add_to_cart → confirm → giỏ có 2 cái, confirm lần 2 → 404;
  "huỷ DHDEMO0013" → đề xuất cancel_order → reject → đơn vẫn pending; find_best_promotion → CHAOBAN; similar/bought-together/cart-suggestions;
  collections 3 chủ đề AI (Gió Thu Mặc Nhẹ…); compare 3 áo thun → 3+ tiêu chí + verdict; FAQ pending → ready 5 câu sau 4s; events batch → stats CTR 50%;
  admin ask → get_revenue + get_top_products + get_dashboard; chat-insights 4 cụm; draft-reply; index status; classify "Chân váy chữ A" → vay/nu;
  precheck score 92; inventory/revenue/combo insights có nhận xét AI; khách gọi admin → 403.

## 9. Ghi chú
Không log key/prompt có PII; `usage_logs` chỉ token/chi phí ước tính. Chat không stream (FE mock nhận nguyên câu; agent ≤ 4 vòng tool trả trong vài giây).
Bỏ có chủ đích so với eco_books: dịch máy + điểm chất lượng bản dịch (chỉ tiếng Việt); "supplier" → công cụ nhân viên (quyền `ai.copy.create`/`ai.insight.read`).
