# Visual product search (PLAN-0044)

SigLIP2 mã hoá ảnh thật, 768 chiều đã chuẩn hoá; model và revision cố định trong `server.py`. Không dùng embedding văn bản1536 cho ảnh. Container chỉ nhận base64 ảnh, không nhận URL, không ghi ảnh khách ra đĩa. Model được cache trong volume `/models`. Ảnh tối đa5MB/20MP, batch1–4, một request inference tại một thời điểm; quá tải trả429.

## Deploy theo CD hiện có

Workflow build thêm image `ghcr.io/<repo>:visual-<sha>`; deploy-remote ghi `VISUAL_ENCODER_IMAGE` vào env server. Giữ profile mặc định tắt để bản deploy chưa cấu hình encoder vẫn phục vụ mua hàng.

Thêm vào **deploy/.env.production trên VPS** (không đưa token vào FE/Git):

```dotenv
COMPOSE_PROFILES=visual-search
EF_VISUAL_ENCODER_URL=http://visual-encoder:8080
EF_VISUAL_ENCODER_TOKEN=<chuoi-random-rieng-toi-thieu-32-ky-tu>
EF_VISUAL_MODEL_VERSION=google/siglip2-base-patch16-224@75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2
EF_VISUAL_IMAGE_ORIGINS=https://res.cloudinary.com
EF_VISUAL_CATALOG_BASE_URL=http://api:4000
EF_VISUAL_MIN_SIMILARITY=0.65
EF_VISUAL_RERANK=true
```

Giữ `EF_OPENAI_API_KEY` và `EF_OPENAI_VISION_MODEL` đang dùng nếu muốn nhận diện nhiều món/OCR và so ảnh ứng viên. Không key vẫn truy hồi vector khi chỉ mục sẵn sàng; không encoder nhưng có OpenAI thì so ảnh trên ứng viên từ mô tả và báo chế độ dự phòng. Không dịch vụ nào sẵn sàng thì không bịa kết quả.

Sau migration/CD, tạo lại API/worker và bật encoder:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml --profile visual-search up -d visual-encoder api worker
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T visual-encoder python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8080/health').read().decode())"
```

Lần đầu tải model cần mạng tới Hugging Face và đủ RAM/disk. Compose giới hạn encoder3GB RAM/2CPU; phải kiểm tài nguyên VPS thực tế trước khi bật. Model tải trong nền; `/health` trả503 tới khi sẵn sàng. API mua hàng không phụ thuộc encoder healthy. Không publish cổng8080 ra Internet. Với ảnh upload local, `EF_VISUAL_CATALOG_BASE_URL` cho worker tải qua mạng Docker nhưng ảnh trả khách giữ URL công khai; thêm origin CDN riêng vào allowlist nếu dùng CDN khác.

## Lập chỉ mục

Worker quét mỗi30s, mỗi lô10 sản phẩm × tối đa8 ảnh, lease trên từng ảnh chống ghi chồng; hash nguồn và model-version giúp bỏ qua ảnh không đổi. Sự kiện publish/update/hidden cũng gọi cùng service. Thất bại thử lại sau5phút; không đánh dấu ready khi encoder lỗi. Trước trả kết quả luôn lọc shop approved/product active/ảnh URL hiện tại.

- `GET /api/v1/admin/ai/image-index/status`: quyền `ai.knowledge.manage`, xem counts ready/failed/processing và modelVersion.
- `POST /api/v1/admin/ai/image-index/reindex`: cùng quyền, ghi audit và đẩy job reset sweep sang worker; không chạy model nặng trong request admin.
- Thay model/processor cần phiên bản mới + tái lập chỉ mục; không trộn vector khác model. URL ảnh thay nội dung phải có version URL mới hoặc cập nhật product để source hash đổi.

## Kiểm thử và chất lượng

- `npm test -- --runInBand src/modules/ai/image-search`.
- `python -m unittest discover -s services/visual-encoder -p test_server.py` (môi trường đã cài requirements).
- `scripts/audit/visual-search-smoke.ts`: chỉ chấp nhận DB riêng localhost55445/fitly_visual_audit, key OpenAI trống, encoder thật. Tạo3 fixture từ ảnh public, kiểm vector/self-match/idempotency/hidden/suspended/prune rồi xoá fixture trong finally. Đây là integration smoke, **không phải benchmark độ chính xác**.
- `npx ts-node -T -r tsconfig-paths/register scripts/audit/visual-search-benchmark.ts <manifest.jsonl> --allow-paid`: CLI gọi service trên DB audit localhost55445/fitly_visual_audit, không dùng server thật và không qua HTTP rate-limit; vẫn giữ cổng ngân sách AI. JSONL mỗi dòng gồm `id`, `image` (file tương đối), `mime`, `split` (`tuning` hoặc `held-out`), `expectedProductIds` (rỗng cho negative), optional `target`. Nhãn do con người xác định. Runner báo hit@5/precision@5/recall@12/no-match false positives/latency và search modes; unavailable không được tính là no-match đúng. Chạy với DOTENV_CONFIG_PATH=NUL và cấu hình audit tường minh; không nạp khoá thật bằng cách đọc file env.

Ngưỡng0.65 chỉ là điểm khởi đầu để hiệu chỉnh, không phải xác suất65%. Không có ảnh/nhãn held-out thật thì chưa công bố mức cải thiện %. Catalog ảnh minh hoạ không đúng hàng có thể làm ảnh thật khó khớp; sửa chất lượng catalog trước khi kết luận model không đạt. VLM rerank tối đa12 ứng viên, tổng ảnh12MB, có thể phát sinh thêm chi phí OpenAI và độ trễ so với bản cũ.

## Dọn dữ liệu

Ảnh query chỉ tồn tại trong RAM browser/API/encoder, không thêm bảng upload hay object storage. Revoke preview khi đổi ảnh/rời màn. Volume model là tài nguyên phục vụ lâu dài; không xoá volume DB đang dùng để reindex. Khi dọn audit chỉ xoá đúng container/volume/profile do lần audit tạo, không prune toàn Docker.
