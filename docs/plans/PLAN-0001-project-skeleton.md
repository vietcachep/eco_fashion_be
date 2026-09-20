# PLAN-0001 — Khung dự án NestJS + common platform

> Status: Done
> Owner: Agent
> Related Phase: Phase 0 — Skeleton
> Related Roadmap: `docs/04_ROADMAP.md`

---

## 1. Mục tiêu

* Dựng dự án NestJS 12 theo format `ago_backend` (AGENTS/PLANS/explain/docs), chạy được bằng
  `docker compose up -d --build` trên máy trống.
* `common` mỏng: `ApiResponse/ApiError/PageResponse`, `BusinessException` + filter lỗi toàn cục, requestId
  (AsyncLocalStorage + header), security context (`AuthenticatedActor`, `@CurrentActor`, `JwtAuthGuard`,
  `PermissionGuard`, `@RequirePermission`, `@Public`), gateway interfaces + DTO snapshot, base entity cho
  audit/outbox/processed-event/idempotency, cache spec, config có validate.
* Gác ranh giới module bằng `dependency-cruiser`; lint/format; jest; CI GitHub Actions; Dockerfile đa
  tầng; compose có `migrate` + `seed` chạy một lần.

## 2. Bối cảnh

Xem `docs/00_PROJECT_CONTEXT.md`. Đây là bước 0 — chưa có module nghiệp vụ nào ngoài `system` health.

## 3. Phạm vi

### Trong phạm vi
* `package.json`, `tsconfig`, `nest-cli.json`, eslint flat config, prettier, jest, dependency-cruiser.
* `src/common/**`, `src/config/**`, `src/database/**` (DataSource cho app + CLI migration), `src/main.ts`,
  `src/worker.ts`, `src/app.module.ts`, `src/worker.module.ts`.
* `scripts/migrate.ts`, `scripts/seed/*.ts` (khung), `scripts/check-boundaries`.
* Docker: `Dockerfile`, `docker-compose.yml`, `.env.example`, `.dockerignore`.
* CI: `.github/workflows/ci.yml` (lint + boundaries + build + test với Postgres/Redis service + migration:check).
* Docs: `AGENTS.md`, `PLANS.md`, `explain.md`, `README.md`, `docs/00..04`, DBML khung.

### Ngoài phạm vi
* Nghiệp vụ identity trở đi (PLAN-0002+).

## 4. Module ảnh hưởng

* common, config, database, system (health)

## 5. Thiết kế DB

* Chưa có bảng nghiệp vụ. Migration đầu tiên của identity (PLAN-0002) tạo extension `pgcrypto`, `unaccent`,
  `pg_trgm`; `ai` tạo `vector`.
* Base entity ở `common/persistence`: `BaseAuditLogEntity`, `BaseOutboxEventEntity`,
  `BaseProcessedEventEntity`, `BaseIdempotencyKeyEntity` (abstract, mapped superclass — module tự map bảng).

## 6. API

```text
GET /api/v1/health          → { status, db, redis, version }
GET /docs                   → Swagger UI (chỉ khi EF_SWAGGER_ENABLED=true)
```

## 7. Bước triển khai

* [x] B1: package.json + tsconfig + nest-cli + eslint + prettier + jest + dependency-cruiser
* [x] B2: `common` (response, exception, request trace, security, gateway, persistence base, cache, utils)
* [x] B3: config (zod validate env `EF_*`), database (**Prisma 7** — PrismaService + adapter pg, schema thư mục `prisma/schema`, migration SQL), redis, RateLimitGuard Redis (thay throttler), logger pino
* [x] B4: `system/health`, `main.ts` (helmet, cors, validation pipe, swagger, prefix `/api/v1`), `worker.ts` (BullMQ, schedule)
* [x] B5: Dockerfile, docker-compose (db pgvector + redis + mailpit + migrate + seed + api + worker), `.env.example`
* [x] B6: CI workflow, scripts migrate/seed/check-boundaries, README
* [x] B7: build + lint + boundaries + test xanh; compose dựng được

## 8. Kiểm thử

* [x] `npm run build`, `npm run lint`, `npm run check:boundaries`, `npm test`
* [x] `docker compose up -d --build` → `GET /api/v1/health` 200

## 9. Rủi ro / Ghi chú

* Quyết định (user, 2026-09-15): **Prisma 7** thay TypeORM giữa chừng — audit/outbox/idempotency đổi sang nhận delegate Prisma; generator `prisma-client` cjs, `importFileExtension = ""` để script ts-node và dist cùng chạy được một mã sinh.
* Quyết định: `@nestjs/throttler` 6.5 chưa hỗ trợ Nest 12 (peer conflict) → `RateLimitGuard` tự viết trên Redis INCR/EXPIRE (`@RateLimit({name, limit, windowSeconds, by})`), 429 `COMMON_RATE_LIMITED`.
* Giả định: Postgres image `pgvector/pgvector:pg16` để module ai không cần đổi image sau.
* Quyết định: MỘT ứng dụng Nest + thư mục module (không dùng Nest monorepo `libs/`) — ranh giới gác bằng
  dependency-cruiser thay vì Maven module; đơn giản hơn cho một đội nhỏ mà vẫn giữ luật "không import ruột module khác".

## 10. Nhật ký tiến độ

| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| 2026-09-15 | Tạo plan + dựng khung (TypeORM) | |
| 2026-09-15 | Chuyển toàn bộ nền tảng sang Prisma 7 theo yêu cầu user; build/lint/boundaries/test xanh, compose dựng được, `migration:check` sạch | probe multi-file + multi-schema + `Unsupported("vector")` OK trước khi chuyển |
| 2026-09-15 | Đóng plan | Done cùng PLAN-0002 |

## 11. File đã đổi

```text
package.json tsconfig*.json nest-cli.json eslint.config.mjs .dependency-cruiser.cjs jest.config.cjs prisma.config.ts .env.example
prisma/schema/base.prisma  src/config/*  src/common/**  src/modules/system/**  src/app.module.ts src/main.ts src/worker*.ts
scripts/seed/index.ts scripts/sync-permissions.ts Dockerfile docker-compose.yml .github/workflows/ci.yml
AGENTS.md PLANS.md explain.md README.md docs/00..05 docs/plans/PLANS_TEMPLATE.md
```

## 12. Việc tiếp theo

* [x] PLAN-0002 identity

## 13. Definition of Done

* [x] Build/lint/boundaries/test xanh · compose dựng được · README/docs khớp
