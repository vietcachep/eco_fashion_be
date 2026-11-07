# PLAN-0044 — Tìm sản phẩm bằng ảnh thực tế

> Status: Implemented — chờ nghiệm thu trình duyệt và benchmark ảnh thật · Owner: Codex · 2026-11-06
> Related: docs/04_ROADMAP.md, PLAN-0012/0013; FE PLAN-0014-visual-product-search.md.
> Được chủ dự án chốt thiết kế và yêu cầu triển khai. Không commit/push/deploy, không sửa DB/server thật; không đọc key thật.

## 1. Mục tiêu

Ảnh truy vấn được so với ảnh catalog, ảnh người mặc đồ chọn được món/vùng; thêm OCR/type/attributes, rerank nhìn ảnh ứng viên, trả đúng ảnh màu. Không bịa độ chính xác hoặc lấp đầy bằng hàng sai ngành.

## 2. Bối cảnh và phạm vi

Thay pipeline vision→keywords-only; tái dùng NestJS, ai worker, ProductQueryApi và pgvector. Không đổi tiền/đơn/GHN. SigLIP2 chạy dịch vụ nội bộ CPU riêng, model Google base-patch16-224, vector768 chuẩn hoá. OpenAI là bước nhận diện vùng/OCR và rerank có ngân sách; không key vẫn tìm vector khi encoder và chỉ mục sẵn sàng. Không triển khai model giả để thay kết quả thật.

## 3. Luồng và ranh giới

FE crop/đối tượng → AiController (multipart, size/magic/rate) → ImageSearchService → VisualIndexService (schema ai) + ProductQueryApi (đọc ảnh/card được bán) → encoder nội bộ HTTP ngoài transaction → pgvector top50 + text/OCR top20 → gộp/truy hồi card hợp lệ → vision rerank tối đa12 → response kèm matching image/màu/lý do. Không công bố similarity là phần trăm chắc chắn. Trạng thái degraded phải nói rõ khi chỉ tìm theo mô tả hoặc rerank lỗi.

Lập chỉ mục: product outbox + periodic sweep có cursor → đọc ảnh theo lô → download allowlist/size/timeout, encode ngoài tx → upsert có hash/model-version; bỏ ảnh hết tồn tại/không được bán. Khóa job chống chạy chồng; ghi processed chỉ sau thành công hoặc periodic sweep phục hồi. Mỗi search đối chiếu lại quyền bán/shop và image URL hiện tại qua QueryApi; không tin snapshot cũ.

## 4. DB/migration

Thêm ai.product_image_embeddings: uuid chuẩn, product_id/image_id trần (không FK xuyên schema), source_url/color_code snapshot, source_hash, model_version, embedding vector(768), status/error/retry metadata, timestamps/version. Unique(image_id,model_version); index(model_version,status,product_id). Model/processor version cố định, không so vector khác model. Không đụng embeddings văn bản1536 hiện có. Prisma + migration20261106110000_visual_product_search + DBML. Chỉ mục chính xác trước (catalog nhỏ), HNSW khi đo cần thiết.

## 5. API và dữ liệu tạm

- POST /ai/image-search giữ hợp đồng cũ, thêm optional multipart target (món cần tìm); ảnh crop gửi từ FE. Thêm regions/matches/searchMode; matches có productId/imageUrl/colorCode/relevance/reason, không có confidence%.
- POST /ai/image-search/analyze: nhận ảnh, trả đối tượng/vùng chuẩn hoá0..1; không lưu ảnh khách. Kiểm hình học ở cả FE/BE.
- POST /admin/ai/image-index/reindex + GET /admin/ai/image-index/status: ai.manage hoặc quyền catalog ai hiện có; lệnh enqueue/đánh thức sweep, trả trạng thái; không mở API public chạy reindex.
- Encoder /health + POST /v1/embed (auth internal token, body limits, bounded batch/concurrency). Không public port ở production. Ảnh khách trong RAM, không lưu DB/disk; cache model là volume phục vụ, không phải ảnh người dùng. Xoá ảnh tải/encode khỏi RAM sau request.

## 6. Quy tắc tìm/xếp hạng

Tương đồng ảnh chính; text/OCR lấy thêm ứng viên, không bắt buộc tên chứa từ khoá. Không hard filter category nếu nhận diện không chắc. Rerank nhìn query và ảnh ứng viên, loại rõ khác loại, đối chiếu màu/model; chỉ chọn ID được cung cấp, thiếu ID/JSON sai không bịa. Rerank lỗi dùng ngưỡng vector cấu hình và gắn degraded. Không dùng soldCount để lấn độ giống. Kết quả có nhóm similar/related; chỉ gọi khớp model khi OCR/model có bằng chứng, không bảo đảm exact từ ảnh giống hình. Ngưỡng khởi tạo phải hiệu chỉnh bằng bộ benchmark, không tuyên bố80/90% khi chưa đo.

## 7. Bước triển khai

- [x] WP1: schema/migration, QueryApi đọc ảnh/card hiện tại, config và contract typed.
- [x] WP2: encoder thật + download an toàn + repository/index worker/retry/sweep.
- [x] WP3: analyze→hybrid retrieval→image rerank/fallback, regression điện thoại/người mặc đồ/no-match.
- [x] WP4: FE chọn món/crop pointer + keyboard, matches đúng ảnh, generated API sync; responsive đã code, chưa kiểm trình duyệt.
- [x] WP5: compose/CD, index idempotent, docs/runbook/benchmark runner.
- [x] WP6a: migration drift DB cô lập, unit/integration, real encoder smoke, FE lint/type/build; dừng runtime, xoá container/volume/image audit.
- [ ] Dọn .visual-browser-audit và ba log TEMP: automatic review chặn lệnh xoá (`blocked by policy`); không còn listener audit hoặc DB fixture.
- [ ] WP6b: kiểm trình duyệt desktop/390px (khởi chạy FE local bị automatic review chặn: `blocked by policy`).
- [ ] Nghiệm thu chất lượng: bộ ảnh tuning/held-out do người gán nhãn và lượt OpenAI thật; chưa dùng khoá thật hay công bố % cải thiện.
- [ ] Deploy và kiểm tài nguyên VPS theo services/visual-encoder/README.md; chưa push/deploy trong đợt này.

## 8. Kiểm thử và cổng nghiệm thu

Kiểm phân biệt vector/text, vector dimension/norm/version/NaN, crop/ảnh người, iPhone vs điện thoại, matched color, unknown IDs từ LLM, failed rerank, no-match, hidden shop, ảnh đã đổi/xoá, retry sau lỗi, source fetch SSRF/redirect/size/timeout. Index SQL+Prisma drift không lệch. Benchmark JSONL có expected product IDs/negative queries, chia tuning/held-out; báo hit@5/precision@5/recall@k/no-match false-positive/latency, không tự bịa expected. Nếu chưa có bộ ảnh thật, ghi rõ chưa thể chứng minh cải thiện định lượng.

## 9. Triển khai và rủi ro

Model download/cache lần đầu và RAM CPU cần kiểm trên VPS; encoder nội bộ tách app, bounded requests, không lưu token vào log. Không bắt UI mua hàng chờ AI. Không cấu hình threshold thành xác suất; đồ cùng kiểu không đủ nhận đúng model điện thoại. Ảnh seed minh hoạ có thể không thể hiện chính xác món bán, cần báo chất lượng dữ liệu. Cloudinary/API origin allowlist, không fetch URL từ AI hoặc người dùng tự cung cấp. Không dùng khoá thật để tự chạy paid benchmark.

## 10. Nhật ký

2026-11-06: đọc nguồn FE/BE, chốt contract và plan trước code. Skill frontend-design dùng cho UI crop với tokens/font Vineta hiện có; điểm nhận diện là khung chọn món ngay trên ảnh, bố cục ảnh trái/kết quả phải, mobile một cột. Không thêm theme/dependency UI mới.

2026-11-06: đã triển khai. Backend verify: 99 suite/2509 test đạt; 49 migration trên DB mới, drift không lệch. Encoder Google SigLIP2 thật + PostgreSQL: smoke7/7; Python4/4. HTTP search trả200, đúng sản phẩm/ảnh fixture; analyze không OpenAI trả hướng dẫn crop; admin không auth401. FE lint/typecheck/build34 trang đạt, hai cảnh báo img có sẵn. Xem docs/13_E2E_TEST_REPORT.md §16 cho bằng chứng, giới hạn và dọn dẹp. Đây là xác minh tích hợp, không phải benchmark accuracy.
