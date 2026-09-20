# PLAN-0002 — Identity: user, vai, quyền, xác thực JWT, địa chỉ

> Status: Done
> Owner: Agent
> Related Phase: Phase 1 — Identity
> Related Roadmap: `docs/04_ROADMAP.md`

> Luật ownership: dữ liệu của khách lọc theo `user_id` từ JWT; nhân viên phân quyền theo mã quyền, vai chỉ là preset.

---

## 1. Mục tiêu

* Một bảng `users` cho cả khách lẫn nhân viên; vai (`roles`) là preset quyền; quyền hiệu lực =
  vai ∪ cấp riêng − chặn riêng (deny thắng) qua `user_permissions`.
* Auth JWT stateless: access 15' (claims `sub,email,role,pv,jti`), refresh 14 ngày băm SHA-256 trong DB,
  rotation + phát hiện dùng lại (thu hồi cả họ `family_id`), blacklist `jti` Redis khi logout/đổi mật khẩu,
  `permission_version` làm token cũ mất quyền ngay.
* Đăng ký khách, đăng nhập (khoá 15' sau 5 lần sai theo email+ip), refresh, logout, đổi mật khẩu, quên mật
  khẩu bằng OTP email (Redis TTL 10'), hồ sơ, avatar, sổ địa chỉ giao hàng (tỉnh/thành VN).
* Admin: quản lý nhân viên (tạo, đổi vai, khoá/mở, đặt lại mật khẩu), sửa preset vai, cấp/chặn quyền riêng,
  xem lịch sử đăng nhập, xem audit identity.
* Catalog quyền là DỮ LIỆU THAM CHIẾU trong code (`permission/catalog.ts`); `perms:sync` đồng bộ vào DB
  (service `migrate` compose) — máy mới dựng lên là đủ quyền.
* Cài 3 cổng của common: `PermissionAuthorizationGateway`, `TokenValidationGateway`, `UserDirectoryGateway`.

## 3. Phạm vi

### Trong
identity đầy đủ như trên + seed admin (EF_ADMIN_*) + seed demo (5 nhân viên mỗi vai + 5 khách + địa chỉ).

### Ngoài
OAuth/Google login, 2FA, xác minh SĐT — để sau nếu đề tài cần.

## 4. Module ảnh hưởng
* identity (mới), common (không đổi contract), scripts (perms:sync, seed:admin, seed identity).

## 5. Thiết kế DB — schema `identity`

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| roles | code UQ, name, description, is_system, +base | preset hệ thống: admin, manager, sales, warehouse, accountant, marketing, customer |
| permissions | code UQ (`module.resource.action`), module_code, description, is_active, +base | seed từ catalog |
| role_permissions | role_id FK, permission_id FK, PK(role_id, permission_id) | |
| users | email, phone, password_hash, full_name, avatar_url, role_id FK, status, permission_version, email_verified_at, last_login_at, +base | UQ partial `email WHERE is_deleted=false`, `phone` tương tự |
| user_permissions | user_id FK, permission_id FK, allowed bool, reason, PK(user_id, permission_id), +created/updated | override |
| refresh_tokens | user_id FK, token_hash UQ, family_id, device_name, ip, ua, expires_at, revoked_at, replaced_by_id, created_at | hash SHA-256, rotation |
| login_histories | user_id NULL, email, success, reason, ip, ua, created_at | retention 180 ngày |
| addresses | user_id FK, recipient_name, phone, province_code, province_name, district_name, ward_name, street, is_default, +base | UQ partial một default/user |
| audit_logs / outbox_events / processed_events | khuôn common | |

Migration: `prisma/migrations/20260915022842_identity_init/migration.sql` (Prisma `migrate dev --create-only` rồi sửa tay:
`CREATE EXTENSION` pgcrypto/unaccent/pg_trgm — dùng chung toàn DB; 3 partial unique index). Model: `prisma/schema/identity.prisma`.

## 6. API

```text
POST /auth/register · /auth/login · /auth/refresh · /auth/logout · /auth/change-password
POST /auth/forgot-password · /auth/reset-password · GET /auth/me
GET/PATCH /users/me · PUT /users/me/avatar (multipart `file`) · GET /users/me/login-histories
GET/POST /users/me/addresses · GET/PATCH/DELETE /users/me/addresses/{id} · PUT .../{id}/default
GET /admin/users · GET /admin/users/{id} · POST /admin/users · PATCH /admin/users/{id} · PUT /admin/users/{id}/status · POST /admin/users/{id}/reset-password
GET/PUT /admin/users/{id}/permissions
GET /admin/roles · GET/PUT /admin/roles/{code}/permissions · GET /admin/permissions
GET /admin/login-histories · GET /admin/audit-logs/identity
```

## 7. Bước triển khai

* [x] B1: permission catalog + preset vai + enums/errors
* [x] B2: model Prisma (9 bảng + audit/outbox/processed) + migration `20260915022842_identity_init`
* [x] B3: repository + audit service + outbox
* [x] B4: auth service (login/register/refresh/logout/password/OTP) + token service (JWT, blacklist, pv cache)
* [x] B5: user/address/admin services + controllers + DTO + mapper
* [x] B6: gateway impl (permission, token validation, user directory) + IdentityModule + IdentityWorkerModule (outbox relay + listener mail chào mừng/khoá + cron dọn)
* [x] B7: scripts perms:sync, seed:admin, identity.seed; test thuần (catalog, preset, effective permissions, request chuẩn hoá, audit che bí mật)
* [x] B8: migration:check, verify, docker up; docs (02_MODULE_MAP, 03/05, DBML, README)

## 8. Kiểm thử
* [x] verify xanh (15 test) · migration:check xanh · smoke REST trên compose (xem nhật ký): login admin → me 52 quyền → refresh → dùng lại refresh cũ 401 REUSED · sales tạo user 403 · override → token cũ 401 STALE, token mới 200 · khoá → 401 USER_INACTIVE, login 403 · admin tự khoá 403 · đăng ký → mail chào mừng qua outbox→worker→mailpit · địa chỉ (mặc định chuyển khi xoá, khách khác 404) · quên mật khẩu → OTP mail → reset → token cũ 401 · sai 5 lần → 429 TOO_MANY_ATTEMPTS · logout → 401 REVOKED · audit/login-histories liệt kê

## 9. Rủi ro / Ghi chú
* Quyết định: OTP/khoá đăng nhập ở Redis (TTL) — mất Redis chỉ mất OTP đang chờ, không mất dữ liệu.
* Quyết định: khách đăng ký là `active` ngay (email chào mừng); xác minh email là bước tuỳ chọn để không chặn demo.
* Rủi ro: argon2 native trên alpine — đã build trong image ở PLAN-0001.

## 10. Nhật ký

| Ngày | Tiến độ | Ghi chú |
|---|---|---|
| 2026-09-15 | Tạo plan, bắt đầu B1 | |
| 2026-09-15 | B1–B6 xong trên Prisma; build sạch | Lỗi gặp: generated client `importFileExtension="js"` làm ts-node không chạy script → đổi `""`; `dotenv/config` nạp ở `env.ts` cho script CLI; `Express.Multer` cần `types: ["multer"]` trong tsconfig; argon2 0.45 đổi kiểu `HashOptions` |
| 2026-09-15 | B7–B8: perms:sync 52 quyền/7 vai, seed:admin, identity.seed (5 NV + 5 khách + 5 địa chỉ) chạy 2 lần không trùng; compose up sạch; smoke đầy đủ | Bug tìm thấy qua smoke: (1) bump pv mà không xoá cache user-auth 60s → token cũ vẫn qua, token mới STALE → PermissionService.invalidateUser giờ xoá cả user-auth; đổi preset vai → invalidateAllUserAuth. (2) OutboxRelay.mark lỗi `42P08 inconsistent types for $2` → cast tường minh; thêm hồi phục event PROCESSING kẹt >10' (listener idempotent qua processed_events — kiểm không gửi mail trùng). |

## 11. File đã đổi

```text
prisma/schema/identity.prisma · prisma/migrations/20260915022842_identity_init/
src/modules/identity/**  (foundation, permission, auth, user, address, loginhistory, audit, outbox, gateway, queryapi, identity.module.ts, identity-worker.module.ts, identity.spec.ts)
src/common/audit/audit.ts · src/common/outbox/outbox.ts · src/common/outbox/outbox-relay.ts · src/common/utils/transform.ts · src/config/env.ts
scripts/sync-permissions.ts · scripts/seed/create-admin.ts · scripts/seed/identity.seed.ts · scripts/seed/index.ts
src/app.module.ts · src/worker.module.ts · tsconfig.json · prisma/schema/base.prisma
docs/02_MODULE_MAP.md · docs/03_DATABASE_RULES.md · docs/05_SEED_AND_REPRODUCE.md · docs/database/eco_fashion.dbml · docs/database/identity-database-design.md · README.md
```

## 12. Việc tiếp theo

* [ ] PLAN-0003 catalog (ngành hàng, thương hiệu, thuộc tính, bộ sưu tập) + seed + cache Redis cây ngành hàng
* [ ] Sau khi có module system: địa chỉ kiểm `province_code` theo danh mục `system.provinces` (hiện chỉ nhận mã + tên khách gửi)

## 13. Definition of Done

* [x] verify · migration:check · compose up sạch · seed chạy 2 lần · smoke REST · docs cập nhật · commit local

