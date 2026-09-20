# 01 — Kiến trúc

## Modular Monolith trên NestJS

Một tiến trình NestJS (API) + một tiến trình worker (BullMQ, cùng mã nguồn, entrypoint `src/worker.ts`).
Mỗi module nghiệp vụ là một `@Module()` riêng, sở hữu **một schema PostgreSQL** và không import ruột
module khác. Ranh giới được gác bằng `dependency-cruiser` (`npm run check:boundaries`).

```text
                  ┌──────────────────────────────────────────────┐
  Web bán hàng ──►│  API (Nest)  /api/v1/**  ── Swagger /docs     │
  Web quản trị ──►│   common ─ identity ─ catalog ─ product ─ …  │──► PostgreSQL (schema/module, pgvector)
                  │        gateway/queryapi/outbox giữa module   │──► Redis (cache, throttle, BullMQ)
                  └──────────────┬───────────────────────────────┘
                                 │ BullMQ (default · mail · ai)
                  ┌──────────────▼───────────────────────────────┐
                  │  Worker (Nest, cùng code): outbox relay,     │──► OpenAI · Cloudinary · SMTP · VNPay query
                  │  mail, embedding, AI nền, job định kỳ        │
                  └──────────────────────────────────────────────┘
```

## Vì sao không tách microservice

Checkout đụng cart → product (tồn) → promotion (lượt) → order → payment trong MỘT transaction. Tách
sớm là gánh saga/2PC vô ích cho một cửa hàng. Modular monolith cho ranh giới rõ (schema riêng, không FK
chéo, gateway/outbox) nên tách sau vẫn được nếu cần.

## Lớp trong một feature

```text
controller  → nhận Request DTO, kiểm quyền (guard), map → Command, gọi service, trả Response DTO
command     → object nghiệp vụ: dữ liệu + actor + ip/ua + requestId + idempotencyKey
service     → interface/token; service/impl → use case, transaction, audit, outbox, lock
repository  → Prisma delegate của model module (chỉ module này dùng; nhận `tx?: Tx` để chạy trong transaction)
entity      → bảng của schema module; extends Base<Module>Entity
mapper      → entity → Response DTO
dto/request → class-validator; dto → response
enums/event → hằng số, tên sự kiện outbox
```

## Giao tiếp liên module

| Cần | Dùng | Ví dụ |
|---|---|---|
| Đọc dữ liệu module khác | `queryapi` của module đó (DTO) | order đọc `ProductQueryApi.priceSnapshot` |
| Ghi vào module khác trong cùng transaction | gateway ở `common/gateway`, module chủ cài đặt | order gọi `InventoryGateway.reserve` |
| Báo cho module khác sau commit | outbox → worker relay → listener idempotent | `ORDER_PLACED` → notification, ai |

## Bảo mật

- JWT access 15' + refresh 14 ngày băm trong `identity.refresh_tokens`, rotation + phát hiện dùng lại.
- `PermissionGuard` đọc quyền hiệu lực (cache Redis theo `permission_version`), `@RequirePermission`.
- Helmet, CORS theo `EF_CORS_ORIGINS` (mặc định dev gồm 3000/3001/3100 — cổng dev của storefront), throttler Redis, `X-Request-Id` gắn vào log/audit/outbox.
- Thanh toán: chữ ký HMAC-SHA512 VNPay; IPN idempotent; không lưu dữ liệu thẻ.

## Vận hành

- `docker compose up -d --build`: db, redis, mailpit → `migrate` (migration + sync quyền) → `seed`
  (admin + dữ liệu mẫu, idempotent) → `api`, `worker`.
- Health `/api/v1/health`; Swagger `/docs`; log JSON pino.
