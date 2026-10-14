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
                  │  Worker (Nest, cùng code): outbox relay,     │──► OpenAI · Cloudinary · SMTP · VNPay · PayOS
                  │  mail, embedding, AI nền, job định kỳ,       │
                  │  listener ví COD/thông báo shop              │
                  └──────────────────────────────────────────────┘
```

Hệ thống là **sàn đa gian hàng, đa ngành hàng** (PLAN-0014/0015/0016/0017): `common` + 12 module nghiệp vụ (identity · catalog · product · cart · order · payment · promotion · review · system · reporting · ai · shop), bản đồ chi tiết ở `docs/02_MODULE_MAP.md`.

## Vì sao không tách microservice

Checkout đụng cart → product (tồn) → promotion (lượt) → order (đơn cha + các đơn con theo shop) → payment trong MỘT transaction. Tách
sớm là gánh saga/2PC vô ích. Modular monolith cho ranh giới rõ (schema riêng, không FK
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
| Đọc dữ liệu module khác | `queryapi` của module đó (DTO) | order đọc `ProductQueryApi.variantSnapshots`, `ShopQueryApi.findBrief` |
| Ghi vào module khác trong cùng transaction | gateway ở `common/gateway`, module chủ cài đặt | order gọi `InventoryGateway.reserve`; payment gọi `ShopCodGateway.setCodEnabled` khi ví COD đổi dấu |
| Ghi vào module khác bằng một use case công khai của module đó (hiếm, trong transaction của người gọi) | `applicationapi` của module đó (`<m>/applicationapi/`, dependency-cruiser cho phép) | shop gọi `IdentityApplicationApi.hashPassword` + `createCustomerAccount(actor, input, tx)` để chủ shop tạo tài khoản nhân viên cùng transaction với dòng `ShopMember` |
| Báo cáo cho module khác sau commit | outbox → worker relay → listener idempotent | `ORDER_CREATED` → system báo thành viên shop; `ORDER_STATUS_CHANGED→completed` → payment ghi hoa hồng COD vào ví (danh sách đầy đủ: `02_MODULE_MAP.md` §13) |
| Guard dùng chung cho route `/shop/**` | `<module>/security/` của module shop (dependency-cruiser cho phép) | product/order/review/… gắn `ShopContextGuard` + `@RequireShopPermission` |
| Module chủ cần hỏi module khác "cái này còn được dùng không?" mà không import ngược | module kia đăng ký provider vào registry của module chủ lúc khởi động | product đăng ký `CatalogUsageRegistry` để catalog chặn đổi `attributeMode`/xoá giá trị thuộc tính đang dùng |

## Bảo mật

- JWT access 15' + refresh 14 ngày băm trong `identity.refresh_tokens`, rotation + phát hiện dùng lại.
- `PermissionGuard` đọc quyền hiệu lực (cache Redis theo `permission_version`), `@RequirePermission`.
- Helmet, CORS theo `EF_CORS_ORIGINS` (mặc định dev gồm 3000/3001/3100 — cổng dev của storefront), throttler Redis, `X-Request-Id` gắn vào log/audit/outbox.
- Thanh toán: chữ ký HMAC-SHA512 VNPay; webhook PayOS kiểm chữ ký HMAC-SHA256 bằng checksum key (khoá trống ⇒ từ chối); IPN/webhook idempotent; không lưu dữ liệu thẻ.
- Phân quyền 2 tầng: nhân viên sàn dùng `PermissionGuard` + mã `module.resource.action` (gồm `supplier.*`); chủ/nhân viên gian hàng dùng `ShopContextGuard` + mã `shop.*` — `shopId`
  suy từ phiên thành viên (`ShopMember` active), KHÔNG BAO GIỜ từ URL/body; guard đọc thẳng `Shop.status` từ DB (shop bị khoá ⇒ mọi route `/shop/**` 403 trừ `GET /shop/session`,
  `POST /shop/members/leave`); dữ liệu shop khác ⇒ 404 để không lộ tồn tại. DTO vendor che dữ liệu khách (userId/email) và thông tin thanh toán của khách.
- Tiền: sổ cái ví COD append-only; đối soát chi trả idempotent (UNIQUE kỳ + dòng đối soát, idempotency-key chi PayOS); gọi mạng ngoài (PayOS/VNPay) NGOÀI transaction.

## Vận hành

- `docker compose up -d --build`: db, redis, mailpit → `migrate` (migration + sync quyền) → `seed`
  (admin + dữ liệu mẫu 15 bước, idempotent — `docs/05_SEED_AND_REPRODUCE.md`) → `api`, `worker`.
- Worker chạy: relay outbox (order · payment · product · catalog · identity · shop · review), mail, embedding/AI nền, job huỷ đơn quá hạn thanh toán, tự hoàn tất đơn, tính `daily_sales`,
  job bù hoa hồng COD; **chạy kỳ đối soát chi trả shop là thao tác tay** (`POST /admin/payouts/run`), chưa có cron.
- Health `/api/v1/health`; Swagger `/docs`; log JSON pino.
- Khoá bên thứ ba để trống vẫn chạy được (tính năng tương ứng tự tắt/lùi): `docs/07_KEYS_CHECKLIST.md`.
