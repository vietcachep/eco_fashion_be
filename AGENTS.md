# AGENTS.md — Luật code EcoFashion Backend

## Project Context

EcoFashion là **MỘT cửa hàng thời trang** (quần áo, phụ kiện) bán online — KHÔNG phải sàn nhiều gian hàng.
Hai giao diện dùng chung backend này:

- **Web bán hàng** (khách): xem/tìm sản phẩm, giỏ hàng, đặt hàng, thanh toán thẻ/chuyển khoản thật,
  theo dõi đơn, đánh giá, trợ lý AI.
- **Web quản trị cửa hàng** (nhân viên): NHIỀU VAI TRÒ nhân viên (chủ shop/admin, quản lý, bán hàng &
  CSKH, kho, kế toán, marketing) — mỗi vai một bộ quyền, quyền cấp/chặn riêng theo từng người.

Ba điểm khác dự án sàn EcoShop (`D:\Fullstack\eco_books`) — cố ý, không "sửa cho giống":

| Khác biệt | Hệ quả trong code |
|---|---|
| Một cửa hàng, không marketplace | KHÔNG có module supplier/ví quỹ/đơn con; một đơn = một cửa hàng; hoa hồng không tồn tại |
| Chỉ tiếng Việt | KHÔNG bảng dịch, không module translation/language, không `lang` param; chữ giao diện nằm ở FE; tiền tệ duy nhất VND |
| Thanh toán thật ở Việt Nam | Cổng thanh toán VNPay (thẻ ATM nội địa / Visa-Master / QR) + chuyển khoản VietQR có đối soát + COD; IPN là nguồn sự thật, chữ ký HMAC bắt buộc |

Phần còn lại giữ như EcoShop: danh mục · sản phẩm nhiều biến thể (size/màu) · tồn kho · giỏ · đơn ·
khuyến mãi · đánh giá · thông báo · báo cáo · **trợ lý AI** (gợi ý, chatbot RAG, tóm tắt đánh giá,
kiểm duyệt, FAQ…) với đường lùi không-AI.

Bám sát format của `D:\project_ago_fruit\ago_erp\ago_backend` (AGENTS + PLANS + docs + explain), chuyển
sang idiom NestJS. Khi luật ở đây và thói quen NestJS mâu thuẫn: luật ở đây thắng.

## Architecture

Modular Monolith, microservice-ready. Một ứng dụng NestJS chạy chung, nhưng mỗi module nghiệp vụ là một
ranh giới cứng:

```text
eco_backend
├── src/common/          nền tảng dùng chung (mỏng, KHÔNG business logic)
├── src/modules/<m>/     một thư mục = một module nghiệp vụ = một schema PostgreSQL
├── src/app.module.ts    lắp ráp runtime (API)
├── src/worker.ts        tiến trình worker BullMQ (queue) — cùng code, khác entrypoint
└── scripts/             migrate, seed, sync quyền, kiểm ranh giới
```

Backend:
- Node 22+ · NestJS 12 · TypeScript strict
- PostgreSQL 16 (+ `pgvector` cho module ai) · Redis 7 (cache + rate limit + BullMQ)
- **Prisma 7** (schema dạng thư mục `prisma/schema/<module>.prisma`, Prisma Migrate với SQL commit vào repo,
  driver adapter pg) — KHÔNG viết SQL thuần cho CRUD; SQL thô chỉ cho lock (`FOR UPDATE`), tìm kiếm
  tsvector/pgvector và job hàng loạt
- BullMQ (hàng đợi: `default`, `mail`, `ai`) · @nestjs/schedule (job định kỳ)
- JWT stateless (access ngắn hạn + refresh token băm trong DB) · argon2
- nestjs-pino (log JSON có `requestId`) · class-validator · Swagger

Frontend (repo riêng, không nằm đây): Next.js + React + TypeScript + Tailwind + shadcn/ui.

## Main Modules

| # | Module | Schema | Vai trò |
|---|---|---|---|
| 0 | common | — | ApiResponse/ApiError/PageResponse, BusinessException, filter lỗi, requestId, security context, guard quyền, **gateway liên module**, base audit/outbox/idempotency |
| 1 | identity | `identity` | user (khách + nhân viên), role, permission catalog, quyền cấp/chặn riêng, auth (login/refresh/logout/đổi mật khẩu/quên mật khẩu), lịch sử đăng nhập, địa chỉ giao hàng, audit, outbox |
| 2 | catalog | `catalog` | ngành hàng dạng cây, thương hiệu, bộ thuộc tính (size/màu/chất liệu), bộ sưu tập |
| 3 | product | `product` | sản phẩm, biến thể (SKU size/màu), ảnh, thông số, giá, **tồn kho + phiếu nhập/điều chỉnh**, tìm kiếm (tsvector tiếng Việt + trigram), trạng thái |
| 4 | cart | `cart` | giỏ hàng theo biến thể, wishlist |
| 5 | order | `order` | đơn hàng (một cửa hàng), dòng hàng snapshot, vòng đời trạng thái, giữ/trừ/nhả kho qua gateway, phí ship theo tỉnh, mã đơn tuần tự, yêu cầu đổi trả |
| 6 | payment | `payment` | phương thức (COD, VNPay, chuyển khoản), giao dịch, VNPay create-url/return/IPN, đối soát chuyển khoản, hoàn tiền |
| 7 | promotion | `promotion` | mã giảm giá (%, số tiền, freeship), phạm vi sản phẩm/ngành, hạn mức dùng, lượt dùng theo đơn |
| 8 | review | `review` | đánh giá đã mua, ảnh, trả lời của shop, kiểm duyệt, ghi điểm về product qua gateway |
| 9 | system | `system` | tham số vận hành, banner, thông báo, tỉnh/thành + phí ship, hộp thư (mail) |
| 10 | reporting | `reporting` | dashboard, doanh thu, bán chạy, tồn kho — read model, chỉ đọc qua queryapi |
| 11 | ai | `ai` | embedding pgvector, kho tri thức, chatbot RAG tool-calling + SSE, gợi ý, tóm tắt đánh giá, kiểm duyệt đề xuất, FAQ, sổ chi phí & hạn mức (cổng AI), soạn mô tả cho nhân viên |

## Ownership Rule (thay cho Department Ownership của ERP)

Một cửa hàng nên KHÔNG có `owner_department_id`. Thay vào đó mọi bản ghi nghiệp vụ quan trọng có:

- `id` (uuid), `code`/`order_no` khi là chứng từ, `status`
- `created_by`, `created_at`, `updated_by`, `updated_at`, `version`, `is_deleted` (soft delete)
- Dữ liệu CỦA KHÁCH (địa chỉ, giỏ, đơn, đánh giá, phiên chat) luôn lọc theo `user_id` lấy từ JWT —
  KHÔNG BAO GIỜ nhận `user_id` từ body/query để đọc dữ liệu khách khác.
- Phân quyền nhân viên theo **mã quyền** (`module.resource.action`), không theo tên vai; vai chỉ là preset.

## Database Rules

Dùng PostgreSQL **schema-per-module**: `identity.users`, `product.products`, `order.orders`…

Được phép:
- Foreign key BÊN TRONG cùng schema/module.

Không được phép:
- Foreign key xuyên module/schema.
- JOIN SQL xuyên module trong nghiệp vụ chính.
- Gọi repository/entity của module khác.

Tham chiếu chéo module dùng:
- `id` + `code`/`sku` + **snapshot** (tên, giá, ảnh tại thời điểm) + `source_module`/`source_type`/`source_id`/`source_no` khi cần.

Ví dụ: `order.order_items` KHÔNG FK tới `product.product_variants`; lưu `variant_id`, `sku`,
`product_name`, `variant_label`, `unit_price`, `image_url` — vì giá/tên đổi sau này không được làm
lịch sử đơn đổi theo. Payment không FK tới order: lưu `source_type = ORDER`, `source_id`, `source_no`.

Chi tiết: `docs/03_DATABASE_RULES.md`. Sơ đồ nguồn: `docs/database/eco_fashion.dbml`.

## Query Performance / N+1 Rule

- Không tải danh sách entity rồi truy vấn con từng dòng.
- Màn danh sách/báo cáo dùng projection/QueryBuilder có `leftJoinAndSelect`/`relations` tường minh hoặc
  query riêng gom theo `IN (...)`; ưu tiên DTO thay vì trả nguyên đồ thị entity.
- Đọc chéo module vẫn qua Query API — không "sửa N+1" bằng JOIN xuyên module.
- Phân trang có fetch-join phải kiểm trùng dòng / sai kích thước trang; danh sách luôn phân trang server.
- Trước khi làm API danh sách/báo cáo phải nghĩ về số query, index, phân trang, và khối lượng dữ liệu.

## Migration / Schema Rule (Prisma)

Migration (`prisma/migrations/*/migration.sql`, commit vào repo) là nguồn sự thật của schema; `prisma/schema/*.prisma`
phải khớp — `npm run migration:check` (CI) chạy `prisma migrate deploy` trên DB trống rồi `prisma migrate diff
--exit-code` để gác lệch.

- Schema là THƯ MỤC: `base.prisma` (generator + datasource `schemas = [...]`) + **một file cho mỗi module**
  `prisma/schema/<module>.prisma`; mọi model có `@@schema("<module>")` và `@@map("snake_case")`.
- Không `@relation` xuyên schema. Model của module chỉ được gọi từ `src/modules/<module>/**`
  (`src/prisma-boundaries.spec.ts` gác); module khác đi qua queryapi/gateway/outbox.
- Cột chuẩn (id uuid `gen_random_uuid()`, version, created_at/by, updated_at/by, is_deleted) khai ở TỪNG model
  (Prisma không kế thừa) — copy khuôn từ model có sẵn, đừng bỏ bớt.
- Tạo migration: `npm run migration:create -- --name <module>_<mo_ta>` rồi **sửa tay SQL** cho phần Prisma không tả
  được: extension (`pgcrypto`, `unaccent`, `pg_trgm`, `vector`), partial unique index (`WHERE is_deleted = false`),
  tsvector + trigger, HNSW. Không `prisma db push` ở bất kỳ môi trường nào.
- Migration đã chạy trên DB dùng chung là BẤT BIẾN — chỉ thêm migration mới. Một plan/đợt = một migration có tên
  `<module>_<mo_ta>`.
- Runtime: `prisma migrate deploy` (service `migrate` của compose). `prisma migrate dev` chỉ trên máy dev.
- Trình tự cho mỗi module: (1) thiết kế Command/DTO, (2) duyệt thiết kế DB trong plan + DBML, (3) model
  `.prisma`, (4) migration + sửa tay, (5) repository/service/controller, (6) seed, (7) test.

## Module Communication

Module nói chuyện với nhau qua:
- **Query API** (`<m>/queryapi/*.ts`, đọc, trả DTO, không mở transaction ghi)
- **Application API** (`<m>/applicationapi/*.ts`, use case công khai của module, hiếm)
- **Gateway trong `common/gateway/`** (interface + DTO snapshot; module chủ quản cài đặt, `app.module`
  tiêm — dùng khi module A cần B làm việc GHI thay mình trong cùng transaction: giữ kho, ghi điểm)
- **Outbox event** sau commit (thông báo bất đồng bộ)

Không truyền entity giữa module. Không import `repository/`, `entity/`, `service/impl` của module khác.
`scripts/check-boundaries` (dependency-cruiser) gác bằng máy; vi phạm là CI đỏ.

## Cross-Module Read / Write Rule

Đọc chéo: `A.service` → `B.queryapi` (DTO/`null` khi không có, không entity, không transaction ghi).

Ghi chéo: KHÔNG gọi service ghi của module khác. Hai đường hợp lệ:
1. Gateway ở `common/gateway` do module chủ quản cài (ví dụ `InventoryGateway.reserve/release/deduct`,
   `ProductStatsGateway.applyRating`, `NotificationGateway.notify`) — dùng khi phải nằm trong CÙNG
   transaction với nghiệp vụ gọi. Gateway nhận **giá trị đích**, không nhận delta, khi có thể.
2. Outbox event → worker/listener của module khác, idempotent qua `processed_events` của module đó.

Service ghi của module chủ quản phải ghi: dữ liệu + audit log + outbox (nếu cần) trong MỘT transaction.

## Backend Package Rule

Trong mỗi module: **feature trước, tầng kỹ thuật sau**, không sâu hơn 3 tầng:

```text
src/modules/order
├── order.module.ts
├── foundation/            base entity của module (BaseOrderEntity), enum dùng chung
├── audit/                 OrderAuditLogEntity + OrderAuditLogFactory/Service
├── outbox/                OrderOutboxEventEntity, ProcessedEventEntity, repository
├── migration/             V..._order_*.ts
├── queryapi/              OrderQueryApi (public read)
├── gateway/               cài đặt gateway của common mà module này sở hữu
├── order/                 feature: đặt hàng / vòng đời
│   ├── controller/  dto/  request/  command/  repository/  service/  service/impl/  mapper/  enums/  event/
├── returns/               feature: đổi trả
└── shipping/              feature: phí ship
```

- Controller: nhận Request DTO (class-validator), gọi service, trả Response DTO — KHÔNG business logic.
- `service/` chứa interface/abstract token; `service/impl/` chứa cài đặt (`@Injectable`). Controller và
  module khác phụ thuộc vào token/interface.
- `command/` là object nghiệp vụ có actor/ip/ua/requestId; controller map Request → Command.
- `repository/` là lớp DUY NHẤT gọi PrismaService trong module; chỉ đụng model của schema mình; nhận `tx`
  (Prisma.TransactionClient) khi chạy trong transaction của service.
- `mapper/` đổi model Prisma ↔ DTO; không trả model Prisma ra ngoài (không lộ password_hash, cột nội bộ).
- Tên thư mục lowercase, không gạch ngang cho feature (`purchaseorder` kiểu ERP → ở đây `returns`, `shipping`).

## Authentication Rule

JWT stateless. Không session/cookie phiên.

- Access token ngắn (15 phút), claims `sub`, `role`, `pv` (permission_version), `jti`.
- Refresh token: chuỗi ngẫu nhiên 256-bit, **DB lưu HASH** (`identity.refresh_tokens`) kèm device/ip/ua,
  rotation mỗi lần dùng, phát hiện dùng lại → thu hồi cả họ token.
- Redis: blacklist `jti` tới hạn, cache `permission_version`/quyền hiệu lực (TTL ngắn, evict NGAY khi đổi).
  Redis mất dữ liệu thì PostgreSQL vẫn đủ để xác thực refresh token. Redis KHÔNG phải nguồn sự thật.
- Khách và nhân viên dùng CÙNG bảng `users` + `role`; khu quản trị chặn bằng mã quyền, không bằng tên vai.
- Mật khẩu: argon2id. Quên mật khẩu qua OTP email (Redis TTL). Chống dò: khoá tạm theo email+ip.

## Rate Limit Rule

Chưa có gateway riêng → backend tự giới hạn bằng `RateLimitGuard` (common/security, Redis INCR/EXPIRE — KHÔNG dùng
`@nestjs/throttler` vì 6.x chưa hỗ trợ Nest 12): `@RateLimit({name, limit, windowSeconds, by: 'ip'|'user'|'auto'})`
trên route đăng nhập, đăng ký, gửi OTP, refresh, chat AI, upload ảnh, webhook thanh toán → 429 `COMMON_RATE_LIMITED`. Rate limit không thay cho kiểm quyền,
ràng buộc DB, khoá hay idempotency. Mọi request có `requestId` (header `X-Request-Id` hoặc tự sinh).

## Cache Strategy Rule (Redis — bắt buộc cho đường đọc nhiều)

Redis là lớp cache để **hạn chế truy vấn xuống PostgreSQL** và là nơi giữ bộ đếm rate limit. Cache-Aside với TTL,
PostgreSQL là nguồn sự thật. Ghi DB trước, xoá key sau khi commit. Mỗi module có endpoint đọc nhiều (danh
sách công khai, chi tiết sản phẩm, cây ngành hàng, tham số, quyền hiệu lực) PHẢI đi qua `CacheService`
(`common/cache`) và ghi rõ key/TTL/điểm xoá trong plan của module.

- Được cache: ngành hàng, thương hiệu, thuộc tính, tham số vận hành, tỉnh/thành + phí ship, banner,
  quyền hiệu lực của user (evict ngay khi đổi), snapshot AI (gợi ý theo chữ ký dữ liệu).
- KHÔNG cache: tồn kho để quyết định bán, số dư/thanh toán, trạng thái đơn, giỏ hàng, mã giảm giá đang đếm lượt.
- Key: `ef:<module>:<mục đích>:<khoá>` có TTL; TTL thêm jitter cho key số lượng lớn; không cache
  password/token/secret/PII.
- Chống penetration (cache "không có" TTL ngắn), avalanche (jitter), stampede (single-flight bằng
  `SET NX` ngắn hoặc stale-while-revalidate) — nhưng không được đổi lấy sai tồn kho / sai tiền.

## Coding Rules

- Controller không chứa business logic; service/application xử lý use case; entity giữ bất biến.
- Repository chỉ dùng trong module của nó. DTO cho request/response. Mapper cho entity ↔ DTO.
- class-validator trên mọi Request DTO; `whitelist: true, forbidNonWhitelisted: true`.
- Audit log DB cho mọi hành động ghi quan trọng. Soft delete cho master data và chứng từ.
- Tiền: `numeric(14,0)` VND trong DB, `string` trong DTO (không float), tính bằng `bigint`/thư viện số nguyên.
- Không `any` trừ khi bọc thư viện không có kiểu — và cô lập chỗ đó.

## Logging Rule

Dùng pino qua `nestjs-pino` (`this.logger = new Logger(Class.name)` hoặc `PinoLogger`). Không `console.*`.

- `log.info` mốc nghiệp vụ quan trọng; `warn` cho lỗi nghiệp vụ dự kiến (sai mật khẩu, hết hàng, chữ
  ký IPN sai); `error` cho lỗi hệ thống thật kèm exception; `debug` chỉ dev.
- Thông điệp log **tiếng Việt**, định danh kỹ thuật giữ tiếng Anh (`userId`, `orderNo`, `requestId`,
  `INVALID_SIGNATURE`). Mọi log đường request kèm `requestId`.
- Không log mật khẩu, refresh token thô, access token, secret, số thẻ, OTP, PII nhạy cảm.
- Log không thay cho audit DB, outbox hay trạng thái DB.

## Base Columns Rule

Mọi model nghiệp vụ có đủ cột chuẩn `id uuid`, `version`, `created_at/by`, `updated_at/by`, `is_deleted`
(Prisma không kế thừa — khai lặp ở từng model). Bảng kỹ thuật (quan hệ n-n, refresh token, lịch sử, outbox,
processed_events, idempotency) được miễn nhưng phải ghi lý do trong comment `///` của model.
Khuôn `audit_logs` / `outbox_events` / `processed_events` / `idempotency_keys` giống nhau ở mọi module — copy từ
`identity.prisma`, đổi tên model theo module (`OrderAuditLog`…) và `@@schema`.

## Database Audit Log Rule

Mọi API đổi dữ liệu ghi audit vào DB: `actor_user_id`, `actor_email`, `action`, `module_code`,
`entity_type`, `entity_id`, `entity_code`, `request_id`/`idempotency_key`, `before_summary`/`after_summary`
(JSON, qua helper — không nối chuỗi tay), `ip_address`, `user_agent`, `created_at`.

Mỗi module có bảng `<schema>.audit_logs` + `XxxAuditLogFactory` (chặn lộ password/token/secret) +
`XxxAuditLogService`; service gọi audit service, không tự dựng JSON. Khách tự thao tác (đặt hàng, đổi
địa chỉ) cũng ghi audit — actor là chính khách.

## Transactional Outbox Rule

Không publish sự kiện bất đồng bộ bên trong transaction chính. Mỗi module có `<schema>.outbox_events`
và `<schema>.processed_events` riêng — không có bảng outbox trung tâm.

- Outbox event: `id`, `event_type`, `event_version` (`v1`), `aggregate_type`, `aggregate_id`,
  `payload` jsonb, `status`, `retry_count`, `next_attempt_at`, `error_message`, `request_id`, timestamps.
- Worker claim bằng `SELECT ... FOR UPDATE SKIP LOCKED`, xử lý, đánh dấu; listener idempotent qua
  `processed_events` (ghi cùng transaction với side effect).
- Trình tự cho ghi quan trọng: mở transaction → ghi nghiệp vụ → audit → outbox → commit → worker xử lý sau.

## Seed Rule (bắt buộc — máy khác `docker compose up` là giống máy gốc)

**Mỗi module PHẢI có seed dữ liệu mẫu** `scripts/seed/<module>.seed.ts` (export `seed(prisma)`), đăng ký vào
`STEPS` của `scripts/seed/index.ts` đúng thứ tự phụ thuộc; service `seed` của compose chạy sau `migrate`.

- Idempotent: chạy lần 2 không tạo trùng, không lỗi (upsert theo code/email/slug; kiểm "đã có" theo khoá tự nhiên).
- Deterministic: dữ liệu ngẫu nhiên dùng seed cố định → máy nào cũng ra cùng bộ số.
- Đủ HÌNH DẠNG để mọi màn có gì để vẽ: mỗi trạng thái nghiệp vụ ít nhất một bản ghi (đơn ở đủ trạng thái,
  đánh giá đủ 3 trạng thái, sản phẩm đủ trạng thái…), nhân viên mỗi vai một tài khoản, khách demo.
- Dữ liệu tham chiếu (vai, quyền, tỉnh/thành, phương thức thanh toán, tham số vận hành) là seed BẮT BUỘC
  (không có thì app không dùng được), dữ liệu demo là seed mặc định (tắt bằng `--no-demo` khi cần).
- Cần dịch vụ ngoài (Cloudinary, OpenAI) → có key thì làm, không có thì báo một dòng rồi bỏ qua — seed không
  được chết vì thiếu key.
- Không seed dữ liệu vận hành thật (sổ chi phí AI, phiên chat thật, token) — chỉ dữ liệu mẫu.
- Xong module = plan tick "seed" + README §Tài khoản demo cập nhật + đã kiểm bằng clone mới `docker compose up`
  trên project riêng (xem `docs/05_SEED_AND_REPRODUCE.md`).

## Payment Rule (VNPay / chuyển khoản)

- Không bao giờ lưu/nhận số thẻ, CVV, OTP thẻ — khách nhập trên trang VNPay; backend chỉ nhận mã giao dịch.
- Mọi callback (`return`, `IPN`) phải kiểm chữ ký `HMAC-SHA512` với `vnp_HashSecret` TRƯỚC khi đọc dữ liệu.
- **IPN là nguồn sự thật** đổi trạng thái thanh toán; `return` chỉ để hiện màn kết quả. IPN idempotent
  theo `vnp_TxnRef` + `vnp_TransactionNo`; gọi lại trả đúng mã VNPay yêu cầu (`00`, `02` đã xác nhận, `97` sai chữ ký…).
- Số tiền IPN phải khớp số tiền đơn (VND × 100 theo VNPay) — lệch là `04`, không ghi nhận.
- Đơn chưa thanh toán quá hạn (tham số vận hành) thì job huỷ + nhả kho; chuyển khoản VietQR đối soát
  bằng nội dung chuyển khoản = mã đơn, kế toán xác nhận (audit) hoặc webhook đối soát khi tích hợp.

## ERP Correctness Rule (áp cho shop)

Trước khi làm use case ghi, trả lời rõ:

```text
Cái gì chạy đồng thời? (nhiều instance API + worker + job)
Cái gì phải idempotent? (checkout, IPN, webhook, huỷ đơn, nhập kho)
Bản ghi nào cần optimistic lock (version)? Thao tác nào cần FOR UPDATE? (tồn kho, lượt mã giảm giá, số đơn)
Ranh giới transaction ở đâu? (service; không gọi mạng trong transaction — gọi VNPay/OpenAI NGOÀI)
Audit/outbox gì phải ghi?
```

Ưu tiên: đúng dữ liệu > bảo mật > hiệu năng. Unique index là chốt cuối; pre-check chỉ để báo lỗi đẹp.

## Idempotency / Duplicate Request Rule

1. Unique index DB cho dữ liệu tự nhiên duy nhất.
2. No-op check cho API cấu hình lặp lại (không tăng version, không audit thừa).
3. **Idempotency key thật** (`common/idempotency`, bảng `<schema>.idempotency_keys`) cho checkout, thanh
   toán, hoàn tiền, nhập kho, webhook — cùng key khác hash → 409; cùng key cùng hash → trả kết quả cũ.

## Code Comment Rule

Class/service/controller/config quan trọng có block comment tiếng Việt phía trên:

```ts
/*
 * Giải thích class này chịu trách nhiệm gì.
 * Ghi rõ rule nghiệp vụ, ranh giới module, bảo mật, transaction, concurrency, idempotency, lock, audit nếu có.
 */
```

Hàm quan trọng cũng vậy. Không comment rỗng lặp lại tên hàm.

## Service Note Rule

Mỗi service/application service ghi rõ trong comment: xử lý use case nào; transaction ở đâu; controller
được gọi method nào; có ghi audit không; có ghi outbox không; lock kiểu gì; idempotency/đa instance ra
sao; không log dữ liệu nhạy cảm.

## Explain Code Flow Rule

Khi user yêu cầu "giải thích luồng code" hoặc trước khi bắt đầu một bước mới trong plan: giải thích theo
template `explain.md` (sơ đồ Client → Controller → Command → Service → gateway/repo/entity → audit/outbox
→ Response, ghi rõ file + tầng; đánh dấu ranh giới module, transaction, audit, outbox, lock, idempotency,
snapshot vs reference). Bước viết test không cần sơ đồ.

## Done Definition

- `npm run build` xanh, `npm run lint` xanh, `npm run check:boundaries` xanh.
- Test liên quan xanh (`npm test`); migration chạy sạch trên DB trống (`npm run migration:check`).
- **Seed của module có và idempotent** (Seed Rule); `docker compose up -d --build` trên máy trống dựng được và
  có dữ liệu mẫu của module.
- Không FK xuyên module; không import repository/entity module khác.
- API theo naming convention, có Swagger; Request DTO có validator.
- Audit log cho API ghi; outbox nếu module khác cần biết.
- Plan checklist + nhật ký tiến độ cập nhật; docs (README §Trạng thái, `02_MODULE_MAP`, DBML) khớp code.

## Planning Rule

Việc lớn (module mới, schema mới, đổi auth/phân quyền, luồng nghiệp vụ, thanh toán, tích hợp, báo cáo,
liên module, deploy) PHẢI có plan trong `docs/plans/PLAN-XXXX-<slug>.md` (template
`docs/plans/PLANS_TEMPLATE.md`) TRƯỚC khi sửa code production. Đọc `AGENTS.md`, `README.md`,
`docs/04_ROADMAP.md`, plan liên quan; cập nhật checklist sau mỗi bước.

## Module Completion Before Switching Rule

Bắt đầu module nào thì xong nền tảng module đó (thiết kế DB đã duyệt → migration → entity → repository
→ service → controller → audit → outbox/cache nếu cần → test → plan cập nhật) rồi mới sang module khác.
Ngoại lệ: contract dùng chung ở `common` bắt buộc phải có trước; sửa nhỏ ở nền tảng; hoặc chủ dự án yêu cầu.

Thứ tự phụ thuộc: common → identity → catalog → product → cart → order → payment → promotion → review
→ system → reporting → ai.

## Git Rule

Agent chỉ `git commit` local. `git push`, merge, tạo/xoá/chuyển nhánh cần chủ dự án quyết định — trừ khi
chủ dự án đã yêu cầu rõ trong cùng yêu cầu ("commit và push lên main"). Commit message tiếng Việt, kết thúc
bằng dòng `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
