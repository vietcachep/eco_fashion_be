# EcoFashion Backend

> **EcoFashion = MỘT cửa hàng thời trang bán online**: web bán hàng cho khách + web quản trị cho nhân viên
> nhiều vai. Chỉ tiếng Việt, tiền VND, thanh toán thật tại Việt Nam (VNPay / chuyển khoản / COD).
> Backend NestJS theo Modular Monolith, format tài liệu & luật code bám `ago_backend` (Spring) chuyển sang NestJS.

---

## 1. Bối cảnh

| Giao diện | Người dùng | Việc chính |
|---|---|---|
| Web bán hàng | Khách | Xem/tìm quần áo, lọc size/màu, giỏ, đặt hàng, thanh toán VNPay/QR/COD, theo dõi đơn, đổi trả, đánh giá, trợ lý AI |
| Web quản trị | Nhân viên (admin · quản lý · bán hàng & CSKH · kho · kế toán · marketing) | Ngành hàng, sản phẩm & tồn kho, đơn, thanh toán & hoàn tiền, khuyến mãi, đánh giá, báo cáo, phân quyền |

Chi tiết: `docs/00_PROJECT_CONTEXT.md`. Luật code: `AGENTS.md`. Plan: `docs/plans/`.

## 2. Kiến trúc

```text
Modular Monolith (NestJS) → API-first → PostgreSQL schema-per-module → outbox event nội bộ → tách được microservice sau
```

Một app API + một worker (cùng mã nguồn). Mỗi module nghiệp vụ = một schema Postgres, không FK xuyên
module, đọc chéo qua `queryapi`, ghi chéo qua gateway ở `common/gateway` hoặc outbox. Ranh giới gác bằng
`dependency-cruiser`. Xem `docs/01_ARCHITECTURE.md`.

## 3. Công nghệ

| Lớp | Công nghệ |
|---|---|
| Backend | Node 22 · NestJS 12 · TypeScript strict |
| DB | PostgreSQL 16 + pgvector · Prisma 7 (schema thư mục theo module, migration SQL commit vào repo) |
| Cache / Queue | Redis 7 · BullMQ (`default`, `mail`, `ai`) · @nestjs/schedule |
| Auth | JWT stateless + refresh token băm trong DB · argon2 · phân quyền theo mã quyền |
| Thanh toán | VNPay (thẻ ATM/Visa/QR, sandbox → production) · chuyển khoản VietQR đối soát · COD |
| Ảnh / Mail | Cloudinary · Nodemailer (dev: mailpit) |
| AI | OpenAI (embedding + chat) — có đường lùi không-AI |
| Log / Docs | nestjs-pino (JSON, requestId) · Swagger `/docs` |
| Deploy | Docker Compose (db · redis · mailpit · migrate · seed · api · worker) · GitHub Actions CI |

## 4. Module

| # | Module | Schema | Vai trò | Trạng thái |
|---|---|---|---|---|
| 0 | common | — | envelope, lỗi, requestId, security context + guard, gateway, base audit/outbox/idempotency, cache, queue, mail, storage | ✅ PLAN-0001 |
| 1 | identity | `identity` | user/role/permission/override, auth JWT + refresh rotation, OTP quên mật khẩu, địa chỉ, lịch sử đăng nhập, audit | ✅ PLAN-0002 |
| 2 | catalog | `catalog` | ngành hàng (ảnh, product_count), bộ sưu tập = bộ lọc, thuộc tính màu/size/chất liệu | ✅ PLAN-0003 |
| 3 | product | `product` | sản phẩm, biến thể màu×size, ảnh theo màu (Cloudinary), giá/giá gốc, tìm kiếm không dấu, tồn kho + phiếu nhập + sổ kho | ✅ PLAN-0004 |
| 4 | cart | `cart` | giỏ theo biến thể (tick dòng), wishlist, merge | ✅ PLAN-0005 |
| 5 | order | `order` | checkout idempotent, vòng đời đơn, phí ship theo tỉnh, huỷ/đổi trả, job huỷ quá hạn | ✅ PLAN-0006 |
| 6 | payment | `payment` | COD, VNPay create/return/IPN, chuyển khoản VietQR + đối soát, hoàn tiền | ✅ PLAN-0007 |
| 7 | promotion | `promotion` | mã %, số tiền, freeship + lượt dùng | ✅ PLAN-0008 |
| 8 | review | `review` | đánh giá đã mua (ảnh), trả lời shop, kiểm duyệt, rating đếm sẵn | ✅ PLAN-0009 |
| 9 | system | `system` | health, tham số, tỉnh/thành + phí ship, banner, thông báo, liên hệ/FAQ/trang, upload ảnh | ✅ PLAN-0010 |
| 10 | reporting | `reporting` | dashboard, doanh thu theo ngày/tháng, bán chạy, tồn kho | ✅ PLAN-0011 |
| 11 | ai | `ai` | chatbot **agent** (tool + thẻ Xác nhận thêm giỏ/huỷ đơn), RAG pgvector, gợi ý (for-you/similar/mua cùng/giỏ/bộ sưu tập), so sánh, FAQ tự sinh, tín hiệu + phễu gợi ý, kiểm duyệt/tóm tắt đánh giá, hỏi số liệu, công cụ nhân viên (phân loại/precheck/tồn/doanh thu/combo), cổng chi phí, **thử đồ 2D (Replicate)**, **phân tích ảnh người (OpenAI vision)** | ✅ PLAN-0012/0013 |

Lộ trình: `docs/04_ROADMAP.md`. Bản đồ chi tiết: `docs/02_MODULE_MAP.md`.

## 5. Cấu trúc dự án

```text
eco_backend
├── AGENTS.md · PLANS.md · explain.md      luật code, luật plan, template giải thích luồng
├── docs/                                   00_context · 01_architecture · 02_module_map · 03_db_rules · 04_roadmap · plans/ · database/
├── src/
│   ├── main.ts / worker.ts                 hai entrypoint, cùng code
│   ├── app.module.ts / worker.module.ts
│   ├── config/                             env.ts (zod, EF_*), config.module.ts
│   ├── database/                           data-source.ts (app + CLI), snake naming
│   ├── common/                             response · exception · request · security · gateway · persistence · audit · outbox · idempotency · cache · redis · queue · mail · storage · utils
│   └── modules/<m>/                        <feature>/{controller,dto,request,command,entity,repository,service,service/impl,mapper,enums,event} · foundation · audit · outbox · migration · queryapi · gateway
├── scripts/                                migrate.ts · sync-permissions.ts · seed/
├── test/                                   jest setup + e2e
├── Dockerfile · docker-compose.yml · .env.example · .github/workflows/ci.yml
└── .dependency-cruiser.cjs                 gác ranh giới module
```

## 6. Chạy dự án

### Một lệnh (Docker)

```powershell
Copy-Item .env.example .env
```

Điền `EF_OPENAI_API_KEY` (chatbot/phân tích ảnh/nhúng — thiếu thì chạy đường lùi rule), `EF_REPLICATE_API_TOKEN` (thử đồ 2D — thiếu thì
503 `AI_TRYON_NOT_CONFIGURED`), `EF_CLOUDINARY_*` (ảnh upload; seed vẫn chạy bằng ảnh tĩnh), `EF_VNPAY_*` (sandbox do chủ dự án đăng ký),
`EF_BANK_TRANSFER_*` (tài khoản nhận chuyển khoản) nếu có. Rồi:

```powershell
docker compose up -d --build
```

Compose tự chạy: `db`/`redis`/`mailpit` → `migrate` (migration + sync catalog quyền, chạy 1 lần) →
`seed` (admin + dữ liệu demo, idempotent, chạy 1 lần) → `api` (http://localhost:4000, Swagger `/docs`)
+ `worker`. Mailpit UI http://localhost:8026. Cổng không đụng dự án `eco_books` cùng máy.

Tài khoản sẵn sau `docker compose up` (chi tiết `docs/05_SEED_AND_REPRODUCE.md`):

| Vai | Email | Mật khẩu |
|---|---|---|
| Admin | `EF_ADMIN_EMAIL` (mặc định `admin@ecofashion.vn`) | `EF_ADMIN_PASSWORD` (mặc định `Admin123456!`) |
| Nhân viên | `manager@` · `sales@` · `warehouse@` · `accountant@` · `marketing@ecofashion.vn` | `NhanVien123!` |
| Khách | `khach1@` … `khach5@ecofashion.vn` | `Khach123456!` |

Thử nhanh: `POST /api/v1/auth/login` → `GET /api/v1/auth/me` (Bearer) trả hồ sơ + mã quyền hiệu lực.

### Chạy tay (dev)

```powershell
docker compose up -d db redis mailpit
npm ci
npm run migration:deploy
npm run perms:sync
npm run seed:admin
npm run seed
npm run start:dev          # API, watch
npm run start:worker:dev   # worker, cửa sổ khác
```

### Kiểm tra

```powershell
npm run verify             # lint + ranh giới module + build + test
npm run migration:check    # migrate deploy + prisma migrate diff: schema ↔ DB phải khớp (CI dùng)
npm run test:e2e
```

## 7. Quy ước

- API `/api/v1/<resource>` số nhiều kebab-case; mọi response là `ApiResponse{success,message,data,error,requestId,timestamp}`;
  lỗi có `error.code` ổn định `<MODULE>_<LY_DO>`; danh sách trả `PageResponse`.
- Header `X-Request-Id` (nhận + trả); `Idempotency-Key` cho checkout/thanh toán/nhập kho.
- Tiền VND: chuỗi số nguyên trong JSON, kèm `display` khi hiện cho khách.
- Comment code + log + commit message tiếng Việt; định danh kỹ thuật tiếng Anh.

## 8. Trạng thái

| Plan | Nội dung | Trạng thái |
|---|---|---|
| PLAN-0001 | Khung dự án + common + Docker + CI | ✅ 2026-09-15 |
| PLAN-0002 | identity (auth, user, vai/quyền, địa chỉ, audit) | ✅ 2026-09-15 |
| PLAN-0002b | identity đợt 2: Google login, alias route FE, hợp đồng FE | ✅ 2026-09-15 |
| PLAN-0003 | catalog (ngành hàng, bộ sưu tập, thuộc tính) + seed ảnh | ✅ 2026-09-15 |
| PLAN-0004 | product (sản phẩm, biến thể, ảnh, tồn kho) + seed 24 sản phẩm | ✅ 2026-09-15 |
| PLAN-0005 | cart + wishlist | ✅ 2026-09-15 |
| PLAN-0006 | order (checkout idempotent, vòng đời, huỷ, đổi trả, job) | ✅ 2026-09-15 |
| PLAN-0007 | payment (COD, chuyển khoản VietQR + đối soát, VNPay, hoàn tiền) | ✅ 2026-09-15 |
| PLAN-0008 | promotion (mã %, số tiền, freeship) | ✅ 2026-09-15 |
| PLAN-0009 | review (đánh giá đã mua, trả lời, kiểm duyệt) + seed | ✅ 2026-09-15 |
| PLAN-0010 | system (tham số, tỉnh/thành, banner, thông báo, nội dung, upload) | ✅ 2026-09-15 |
| PLAN-0011 | reporting (dashboard, doanh thu, bán chạy, tồn kho) | ✅ 2026-09-15 |
| PLAN-0012 | ai (chatbot RAG, embedding, gợi ý, kiểm duyệt/tóm tắt, chi phí) + seed kho tri thức | ✅ 2026-09-15 |
| PLAN-0013 | ai đợt 2: thử đồ 2D (Replicate IDM-VTON) + phân tích ảnh người (OpenAI vision) | ✅ 2026-09-15 (smoke thật) |
