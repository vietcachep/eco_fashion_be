# PLAN-0013 — AI đợt 2: thử đồ 2D (Replicate IDM-VTON) + phân tích ảnh người → gợi ý sản phẩm

> Status: Done
> Owner: Agent
> Related Phase: Phase 5 — AI
> Related Roadmap: `docs/04_ROADMAP.md`
> Hợp đồng FE: `docs/06_FE_CONTRACT.md` (mục ai) — màn `virtual-try-on-screen.tsx`, `ai-suggest-screen.tsx`

---

## 1. Mục tiêu

* **Thử đồ 2D**: `POST /ai/try-on` (multipart `image` + `productId` [+ `colorCode`]) → upload ảnh người lên Cloudinary → `try_on_jobs` queued → job BullMQ `ai`
  ở worker gọi Replicate `EF_REPLICATE_TRYON_MODEL` (IDM-VTON: `human_img`, `garm_img` = ảnh sản phẩm theo màu/ảnh chính, `category` theo ngành hàng
  upper_body/lower_body/dresses), poll ≤ 4 phút → tải ảnh kết quả về Cloudinary (URL Replicate hết hạn) → `done` + `resultUrl`; FE poll `GET /ai/try-on/{jobId}`
  (`pollAfterMs`). Tối đa 3 job đang chạy / người; thiếu token → 503 `AI_TRYON_NOT_CONFIGURED`.
* **Phân tích ảnh người**: `POST /ai/style-analysis` (multipart `image`, `gender?`, `occasion?`) → OpenAI vision trả JSON ràng buộc mã màu/ngành hàng của
  catalog → `{dangNguoi, mauPhuHop[], phongCach, tuVan, gender, categories[], colorCodes[]}` + sản phẩm gợi ý (`ProductQueryApi.recommend`: đúng màu+ngành →
  nới màu → nới ngành, ≤ 8). Không key/lỗi → rule theo giới khách chọn. Prompt cấm suy đoán tuổi/sắc tộc/sức khoẻ.
* Dữ liệu cá nhân: ảnh người xoá khỏi Cloudinary sau 7 ngày (job 03:40), dòng giữ để thống kê; khách vãng lai theo `X-Guest-Key`.

## 5. Thiết kế DB — schema `ai`

`try_on_jobs` (status queued|processing|done|failed, `provider_job_id`, `result_url`, `attempts`), `style_analyses` (`result` json, `product_ids`).

## 6. API

```text
POST /ai/try-on (202) · GET /ai/try-on · GET /ai/try-on/{jobId} · POST /ai/style-analysis · GET /ai/style-analysis/{id}
```

## 7–8. Triển khai & kiểm thử

* [x] TryOnService (+ `process` ở worker, idempotent theo `provider_job_id`) · StyleAnalysisService · ReplicateProvider (token chỉ vào header, không log)
* [x] Smoke thật: style-analysis (vision) → dáng/màu/phong cách + 8 sản phẩm nam đi làm; try-on áo thun trắng lên ảnh người mẫu sơ mi linen → `done` sau 30s,
  ảnh kết quả lưu Cloudinary `ecofashion/ai/try-on-result/…` (~0,03 USD/lần ghi vào `usage_logs`).

## 9. Ghi chú
Key thử đồ do chủ dự án cung cấp nằm trong `.env` (gitignore) — chỉ ghi, không in ra/commit.
