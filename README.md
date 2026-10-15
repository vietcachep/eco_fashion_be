# EcoFashion Backend (FITLY)

> **FITLY = sàn thương mại điện tử đa gian hàng, đa ngành hàng** (kiểu Shopee thu nhỏ): nhiều gian hàng (shop) cùng bán trên một sàn,
> mỗi shop tự quản sản phẩm/kho/đơn/khuyến mãi của mình, sàn thu hoa hồng. Thời trang (quần áo) là ngành hàng ĐẦU TIÊN, không phải
> duy nhất — điện tử, gia dụng, mỹ phẩm, sách, thực phẩm… tự định nghĩa bộ thuộc tính riêng theo ngành hàng. Chỉ tiếng Việt, tiền VND,
> thanh toán thật tại Việt Nam (PayOS / COD — sàn thu mọi khoản tiền rồi tự động đối soát, chi trả shop). Backend NestJS theo Modular Monolith, format tài liệu & luật
> code bám `ago_backend` (Spring) chuyển sang NestJS.

---

## 1. Bối cảnh

| Giao diện | Người dùng | Việc chính |
|---|---|---|
| Web bán hàng (`fashion_frontend_user`) | Khách | Xem/tìm sản phẩm theo ngành hàng & gian hàng, lọc, giỏ nhóm theo shop, đặt hàng nhiều shop trong một lần (voucher sàn + voucher từng shop), thanh toán PayOS/COD, theo dõi đơn, đổi trả, đánh giá, trợ lý AI + tìm sản phẩm bằng ảnh |
| Web quản trị — cổng **nhân viên sàn** (`fashion_frontend_admin`, route `(dashboard)`) | Nhân viên sàn (admin · quản lý · bán hàng & CSKH · kho · kế toán · marketing) | Ngành hàng + thuộc tính, duyệt/khoá gian hàng, đơn/thanh toán/hoàn tiền, đối soát chi trả shop (tự động), khuyến mãi sàn, kiểm duyệt đánh giá, báo cáo, phân quyền |
| Web quản trị — cổng **vendor** (cùng repo, route `(vendor)`) | Chủ / nhân viên gian hàng (`shop_owner`, `shop_staff`) | Tự vận hành CHÍNH shop mình qua `/shop/**`: hồ sơ + TK ngân hàng, nhân viên, sản phẩm + ảnh + biến thể, kho, đơn, voucher shop, đánh giá, báo cáo, đối soát |

Mô hình tiền, vai/quyền, phạm vi: `docs/00_PROJECT_CONTEXT.md`. Luật code: `AGENTS.md`. Plan: `docs/plans/`.

## 2. Kiến trúc

```text
Modular Monolith (NestJS) → API-first → PostgreSQL schema-per-module → outbox event nội bộ → tách được microservice sau
```

Một app API + một worker (cùng mã nguồn, hai entrypoint `src/main.ts` / `src/worker.ts`). Mỗi module nghiệp vụ = một schema Postgres,
không FK xuyên module, đọc chéo qua `queryapi`, ghi chéo qua gateway ở `common/gateway` hoặc outbox. Ranh giới gác bằng
`dependency-cruiser` (`npm run check:boundaries`) + `src/prisma-boundaries.spec.ts`. Xem `docs/01_ARCHITECTURE.md`.

## 3. Công nghệ

| Lớp | Công nghệ |
|---|---|
| Backend | Node 22 · NestJS 12 · TypeScript strict |
| DB | PostgreSQL 16 + pgvector · Prisma 7 (schema thư mục theo module, migration SQL commit vào repo) |
| Cache / Queue | Redis 7 · BullMQ (`default`, `mail`, `ai`) · @nestjs/schedule |
| Auth | JWT stateless + refresh token băm trong DB · argon2 · phân quyền theo mã quyền (2 tầng: nhân viên sàn `supplier.*` / vendor `shop.*`) |
| Thanh toán | **PayOS** (QR/chuyển khoản tự động; khoá trống ⇒ tự ẩn) · COD (đơn vị vận chuyển thu hộ, nộp về sàn); sàn thu mọi khoản tiền, tự động trừ hoa hồng và chi trả shop (cron) + hoàn tiền qua PayOS "Lệnh chi" (khoá chi riêng); PLAN-0018 |
| Ảnh / Mail | Cloudinary (trống ⇒ phục vụ ảnh tĩnh `/static/seed`) · Nodemailer (dev: mailpit) |
| AI | OpenAI (embedding + chat + vision) — có đường lùi không-AI; thử đồ 2D qua Replicate (tính năng cũ) |
| Log / Docs | nestjs-pino (JSON, requestId) · Swagger `/docs` (+ `/docs/openapi.json` cho Orval ở hai FE) |
| Deploy | Docker Compose (db · redis · mailpit · migrate · seed · api · worker). CI: `.github/workflows/ci.yml` (GitHub Actions) chạy lint · ranh giới module · build · test + `migration:check` trên DB trống mỗi lần push/PR — **đẩy file workflow lên GitHub cần token có quyền `workflow`** |

## 4. Module

12 module nghiệp vụ + `common`. Bản đồ chi tiết (cấu trúc thư mục, queryapi, gateway, sự kiện outbox, ma trận phụ thuộc): `docs/02_MODULE_MAP.md`.

| # | Module | Schema | Vai trò | Trạng thái |
|---|---|---|---|---|
| 0 | common | — | envelope, lỗi, requestId, security context + guard, gateway liên module, base audit/outbox/idempotency, cache, queue, mail, storage | ✅ PLAN-0001 |
| 1 | identity | `identity` | user/role/permission/override, auth JWT + refresh rotation, OTP quên mật khẩu, địa chỉ, lịch sử đăng nhập, audit; 9 vai (7 nền tảng + `shop_owner`/`shop_staff`) | ✅ PLAN-0002 · 0014 |
| 2 | catalog | `catalog` | ngành hàng dạng cây (chỉ ngành LÁ nhận sản phẩm), `attributeMode` legacy_fashion \| dynamic, thuộc tính màu/size (thời trang) + thuộc tính động + mẫu thuộc tính theo ngành (≤ 2 trục biến thể), bộ sưu tập | ✅ PLAN-0003 · 0016 · 0017 |
| 3 | product | `product` | sản phẩm thuộc một gian hàng, biến thể (màu×size hoặc trục động), ảnh, tồn kho + phiếu nhập + sổ kho, tìm kiếm không dấu, trang gian hàng công khai `GET /shops`; route vendor `/shop/products`, `/shop/inventory` | ✅ PLAN-0004 · 0014 · 0016 · 0017 |
| 4 | cart | `cart` | giỏ theo biến thể (tick dòng, nhóm theo shop), wishlist, merge | ✅ PLAN-0005 · 0014 |
| 5 | order | `order` | checkout idempotent = 1 đơn cha `OrderGroup` + N đơn con theo shop, vòng đời đơn con, phí ship theo tỉnh, huỷ/đổi trả, voucher sàn + shop, job huỷ quá hạn; `/shop/orders` cho vendor | ✅ PLAN-0006 · 0014 · 0017 |
| 6 | payment | `payment` | COD + **PayOS** (sàn thu mọi khoản), hoàn tiền; **đối soát chi trả shop** gom cả PayOS lẫn COD (escrow theo hạn đổi trả, hoa hồng, nợ mang sang, cron tự chi PayOS hoặc kế toán đánh dấu đã chi) | ✅ PLAN-0007 · 0015 · 0017 · 0018 |
| 7 | promotion | `promotion` | mã %, số tiền, freeship; phạm vi `platform` (sàn chịu) hoặc `shop` (shop chịu, vendor tự quản `/shop/promotions`) + lượt dùng | ✅ PLAN-0008 · 0014 · 0017 |
| 8 | review | `review` | đánh giá đã mua (ảnh), trả lời của shop, kiểm duyệt, rating đếm sẵn; `/shop/reviews` cho vendor | ✅ PLAN-0009 · 0014 |
| 9 | system | `system` | health, tham số, tỉnh/thành + phí ship, banner, thông báo (cả cho thành viên shop), liên hệ/FAQ/trang, upload ảnh | ✅ PLAN-0010 · 0017 |
| 10 | reporting | `reporting` | dashboard toàn sàn, doanh thu ngày/tháng, bán chạy, tồn kho; `/shop/reports` tính riêng từng shop | ✅ PLAN-0011 · 0017 |
| 11 | ai | `ai` | chatbot **agent** (tool + thẻ Xác nhận), RAG pgvector, gợi ý, so sánh, FAQ tự sinh, kiểm duyệt/tóm tắt đánh giá, hỏi số liệu, công cụ nhân viên, cổng chi phí, **tìm sản phẩm bằng ảnh**, thử đồ 2D + phân tích ảnh người (tính năng thời trang cũ, FE đã ẩn) | ✅ PLAN-0012 · 0013 · 0017 |
| 12 | shop | `shop` | gian hàng + thành viên (chủ shop thêm nhân viên trực tiếp: tạo tài khoản cho nhân viên, có hiệu lực ngay — không mời/không chờ chấp nhận), `ShopContextGuard` + `@RequireShopPermission` cho mọi route `/shop/**`, hồ sơ + TK ngân hàng nhận tiền, phiên vendor `GET /shop/session`, duyệt/khoá/hoa hồng do sàn (`/admin/shops`) | ✅ PLAN-0014 · 0017 |

Lộ trình: `docs/04_ROADMAP.md`.

## 5. Cấu trúc dự án

```text
eco_backend
├── AGENTS.md · PLANS.md · explain.md      luật code, luật plan, template giải thích luồng
├── docs/                                   00_context · 01_architecture · 02_module_map · 03_database_rules · 04_roadmap · 05_seed_and_reproduce ·
│                                           06_fe_contract · 07_keys_checklist · plans/ · database/ (DBML + thiết kế DB) · design/ (PlantUML/draw.io — có phần cũ, xem docs/design/README.md)
├── prisma/
│   ├── schema/                             base.prisma + một file .prisma cho mỗi module (12 schema Postgres)
│   └── migrations/                         SQL commit vào repo (nguồn sự thật của schema)
├── src/
│   ├── main.ts / worker.ts                 hai entrypoint, cùng code
│   ├── app.module.ts / worker.module.ts
│   ├── config/                             env.ts (zod, EF_*), config.module.ts
│   ├── common/                             response · exception · request · security · gateway · prisma · audit · outbox · idempotency · cache · redis · queue · mail · storage · logger · utils
│   ├── generated/                          Prisma client sinh ra (gitignore, `postinstall`)
│   └── modules/<m>/                        <feature>/{controller,dto,request,repository,service,mapper,…} · foundation · audit · outbox · queryapi · enums · gateway · security (shop)
├── scripts/
│   ├── sync-permissions.ts                 catalog quyền → DB (perms:sync)
│   └── seed/                               index.ts (15 bước) · *.seed.ts · data/ (DSL ngành hàng/gian hàng) · assets/ (~930 ảnh minh hoạ) · tools/
├── test/                                   jest setup (+ cấu hình e2e; hiện chưa có bộ test e2e)
├── Dockerfile · docker-compose.yml · .env.example
└── .dependency-cruiser.cjs                 gác ranh giới module
```

## 6. Chạy dự án

### Một lệnh (Docker)

```powershell
Copy-Item .env.example .env
```

Mọi khoá bên thứ ba trong `.env` đang **để TRỐNG** và hệ thống tự lùi về đường không-khoá, nên chạy được ngay. Điền khoá nào thì tính năng đó bật lên —
danh sách đầy đủ, lấy khoá ở đâu, khi trống thì sao: **`docs/07_KEYS_CHECKLIST.md`** (PayOS thu/chi — chủ dự án cung cấp sau —, OpenAI, Replicate, Cloudinary, Google, SMTP, Pexels…). Rồi:

```powershell
docker compose up -d --build
```

Compose tự chạy: `db`/`redis`/`mailpit` → `migrate` (migration + sync catalog quyền, chạy 1 lần) →
`seed` (admin + dữ liệu demo 15 bước, idempotent, chạy 1 lần) → `api` (http://localhost:4000, Swagger `/docs`)
+ `worker`. Mailpit UI http://localhost:8026. Cổng không đụng dự án `eco_books` cùng máy.

**Triển khai lên máy chủ (Docker + HTTPS) và 2 web trên Vercel:** xem `docs/08_DEPLOY.md` (bộ file ở `deploy/`). **Dữ liệu giống hệt máy gốc:** `npm run db:restore -- --yes` (xem `docs/05_SEED_AND_REPRODUCE.md`).

Tài khoản sẵn sau seed (chi tiết `docs/05_SEED_AND_REPRODUCE.md`):

| Vai | Email | Mật khẩu |
|---|---|---|
| Admin (đồng thời là chủ gian hàng chính chủ FITLY Official) | `EF_ADMIN_EMAIL` (mặc định `admin@ecofashion.vn`) | `EF_ADMIN_PASSWORD` (mặc định `Admin123456!`) |
| Nhân viên sàn | `manager@` · `sales@` · `warehouse@` · `accountant@` · `marketing@ecofashion.vn` | `NhanVien123!` |
| Chủ gian hàng | mỗi shop một email, vd `techzone@ecofashion.vn` (TechZone Việt Nam), `sneaker@ecofashion.vn`, `beautybox@ecofashion.vn`… (18 shop — danh sách ở `scripts/seed/data/shops.ts`) | `Vendor123456!` |
| Nhân viên gian hàng | `nv.techzone@` · `nv.giadung@` · `nv.beautybox@ecofashion.vn` (vai `shop_staff`) | `Vendor123456!` |
| Khách | `khach1@` … `khach45@ecofashion.vn` | `Khach123456!` |

Đăng nhập chủ/nhân viên shop vào web quản trị: sau login FE gọi `GET /api/v1/shop/session` để biết shop + quyền `shop.*`. Hai shop mẫu để thử luồng sàn:
`cuahangmoi@ecofashion.vn` (shop chờ duyệt) và `hangnhai@ecofashion.vn` (shop bị khoá). Đổi mật khẩu mặc định trước khi đưa lên môi trường thật.

Thử nhanh: `POST /api/v1/auth/login` → `GET /api/v1/auth/me` (Bearer) trả hồ sơ + mã quyền hiệu lực.

### Chạy tay (dev)

```powershell
docker compose up -d db redis mailpit
npm ci
npm run migration:deploy
npm run perms:sync
npm run seed:admin
npm run seed               # dữ liệu demo, idempotent (từ chối chạy khi NODE_ENV=production, trừ --force)
npm run start:dev          # API, watch
npm run start:worker:dev   # worker, cửa sổ khác (relay outbox, mail, AI nền, job định kỳ, cron chi trả shop tự động, listener thông báo shop)
```

Lưu ý: seed ghi thẳng DB nên cache Redis (danh mục/sản phẩm) có thể cũ vài phút — muốn thấy ngay thì xoá khoá `ef:*` trong Redis (cổng 6381).
Chạy **kỳ đối soát chi trả shop** là thao tác tay (`POST /admin/payouts/run`, quyền `supplier.payout.process` của kế toán/admin) — chưa có cron.

### Kiểm tra

```powershell
npm run verify             # lint + ranh giới module + build + test
npm run migration:check    # migrate deploy + prisma migrate diff: schema ↔ DB phải khớp
npm run seed:validate      # kiểm dữ liệu mẫu (scripts/seed/data) KHÔNG cần DB
```

Sau khi đổi API chạy `npm run api:sync` ở hai repo FE (Orval sinh lại từ `/docs/openapi.json`); đổi catalog quyền thì chạy `perms:sync` ở BE (nạp DB) rồi `perms:sync` ở FE admin (sinh lại kiểu `PermissionCode`).

## 7. Quy ước

- API `/api/v1/<resource>` số nhiều kebab-case; mọi response là `ApiResponse{success,message,data,error,requestId,timestamp}`;
  lỗi có `error.code` ổn định `<MODULE>_<LY_DO>`; danh sách trả `PageResponse`.
- Route theo vai: công khai (`/products`, `/shops`…), khách (`/orders`, `/cart`…), nhân viên sàn (`/admin/**`, quyền `supplier.*` + `module.resource.action`),
  vendor (`/shop/**`, quyền `shop.*`, `shopId` CHỈ lấy từ phiên thành viên — không bao giờ từ URL/body). Bảng route đầy đủ: `docs/06_FE_CONTRACT.md`.
- Header `X-Request-Id` (nhận + trả); `Idempotency-Key` cho checkout/nhập kho.
- Tiền VND: chuỗi số nguyên trong JSON, kèm `display` khi hiện cho khách.
- Comment code + log + commit message tiếng Việt; định danh kỹ thuật tiếng Anh.

## 8. Trạng thái

| Plan | Nội dung | Trạng thái |
|---|---|---|
| PLAN-0001 | Khung dự án + common + Docker | ✅ 2026-09-15 |
| PLAN-0002 | identity (auth, user, vai/quyền, địa chỉ, audit) | ✅ 2026-09-15 |
| PLAN-0002b | identity đợt 2: Google login, alias route FE, hợp đồng FE | ✅ 2026-09-15 |
| PLAN-0003 | catalog (ngành hàng, bộ sưu tập, thuộc tính) + seed ảnh | ✅ 2026-09-15 |
| PLAN-0004 | product (sản phẩm, biến thể, ảnh, tồn kho) + seed 24 sản phẩm | ✅ 2026-09-15 |
| PLAN-0005 | cart + wishlist | ✅ 2026-09-15 |
| PLAN-0006 | order (checkout idempotent, vòng đời, huỷ, đổi trả, job) | ✅ 2026-09-15 |
| PLAN-0007 | payment (COD, chuyển khoản VietQR, VNPay, hoàn tiền — VNPay/VietQR đã bị PLAN-0018 gỡ) | ✅ 2026-09-15 |
| PLAN-0008 | promotion (mã %, số tiền, freeship) | ✅ 2026-09-15 |
| PLAN-0009 | review (đánh giá đã mua, trả lời, kiểm duyệt) + seed | ✅ 2026-09-15 |
| PLAN-0010 | system (tham số, tỉnh/thành, banner, thông báo, nội dung, upload) | ✅ 2026-09-15 |
| PLAN-0011 | reporting (dashboard, doanh thu, bán chạy, tồn kho) | ✅ 2026-09-15 |
| PLAN-0012 | ai (chatbot RAG, embedding, gợi ý, kiểm duyệt/tóm tắt, chi phí) + seed kho tri thức | ✅ 2026-09-15 |
| PLAN-0013 | ai đợt 2: thử đồ 2D (Replicate IDM-VTON) + phân tích ảnh người (OpenAI vision) | ✅ 2026-09-15 (smoke thật) |
| PLAN-0014 | Pivot sàn đa gian hàng: module `shop`, RBAC 2 tầng, đơn cha/đơn con, voucher sàn+shop, báo cáo/thông báo theo shop | BE ✅ (còn giới hạn đã biết — xem plan §14) |
| PLAN-0015 | PayOS thu/chi, ví quỹ COD (đã bỏ ở PLAN-0018), đối soát chi trả shop (bản thiết kế; triển khai thực tế ở PLAN-0017) | BE ✅ (làm khác thiết kế ở vài điểm — xem plan) |
| PLAN-0016 | Sàn đa ngành hàng: `attributeMode`, thuộc tính động, mẫu thuộc tính theo ngành, biến thể ≤ 2 trục | BE ✅; FE còn việc (xem plan) |
| PLAN-0017 | Hoàn thiện sàn: vendor tự vận hành, PayOS/đối soát, trang gian hàng, AI tìm bằng ảnh, hardening, seed dày (18 shop · ~48 ngành lá · ~930 ảnh minh hoạ) | In progress — BE xong; FE/QA/review + "Việc còn lại / giới hạn đã biết" ở plan §12 |
| PLAN-0018 | Sàn thu MỌI khoản tiền (PayOS + COD), tự động trừ hoa hồng + chi trả shop (cron); bỏ VNPay, chuyển khoản tay, ví quỹ COD, `Shop.codEnabled`; 79 mã quyền | In progress |

Việc còn dang dở và giới hạn đã biết của đợt marketplace nằm ở `docs/plans/PLAN-0017-marketplace-completion.md` §12 (vd: chữ ký `x-signature` của PayOS "Lệnh chi" chưa xác nhận với tài liệu —
thử sandbox/khoá thật một kỳ nhỏ trước khi bật chi tự động hàng loạt).
