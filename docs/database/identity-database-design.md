# Thiết kế DB — module identity (PLAN-0002)

Schema `identity`. Model: `prisma/schema/identity.prisma`. Migration: `prisma/migrations/20260915022842_identity_init`.
Sơ đồ: `docs/database/eco_fashion.dbml`.

## Bảng và vai trò

| Bảng | Vai trò | Ghi chú thiết kế |
|---|---|---|
| `roles` | 7 vai hệ thống (preset quyền) | `perms:sync` tạo; `is_system=true`; API không tạo/xoá vai (đề tài cố định 7 vai). Admin luôn = toàn bộ catalog, không sửa preset. |
| `permissions` | catalog mã quyền `module.resource.action` | nguồn sự thật là `permission/catalog.ts`; sync upsert theo `code`; `deprecated` → `is_active=false` (không xoá vì route cũ có thể còn dùng). |
| `role_permissions` | preset của vai | PK (role_id, permission_id). Sync chỉ THÊM mã thiếu, không gỡ mã admin đã thêm tay. |
| `users` | một bảng cho khách lẫn nhân viên | `role_id` phân loại (`customer` = khách). `permission_version` (pv) là khoá vô hiệu token/cache. `password_hash` argon2id (memory 19MB, t=2) — chỉ `UserRepository.findForLogin/passwordHashOf` đọc. |
| `user_permissions` | cấp/chặn riêng | `allowed=false` thắng vai (deny-wins). Không có override = theo vai. |
| `refresh_tokens` | phiên đăng nhập | chỉ giữ SHA-256; `family_id` = chuỗi rotation; token đã `revoked_reason=ROTATED` bị dùng lại → thu hồi cả family (`REUSE_DETECTED`). Dọn sau 30 ngày. |
| `login_histories` | mọi lần đăng nhập thành/bại | append-only; `reason`: REGISTER, INVALID_CREDENTIALS, THROTTLED, USER_LOCKED, hoặc tên thiết bị khi thành công. Dọn sau `EF_LOGIN_HISTORY_RETENTION_DAYS`. |
| `addresses` | sổ địa chỉ giao hàng | tối đa 10/khách; đúng một mặc định (partial unique). Chụp `province_name` để địa chỉ cũ không đổi khi danh mục đổi tên. Đơn hàng sẽ chụp snapshot địa chỉ riêng (module order). |
| `audit_logs` | ai làm gì | khuôn common; `before/after_summary` đã qua `sanitizeSummary` (che password/token/otp/hash). |
| `outbox_events` / `processed_events` | sự kiện USER_REGISTERED, USER_LOCKED | relay ở worker; listener idempotent theo (event_id, handler). |

## Index / ràng buộc quan trọng (sửa tay trong migration)

```sql
CREATE UNIQUE INDEX uq_users_email_active ON identity.users (lower(email)) WHERE is_deleted = false;
CREATE UNIQUE INDEX uq_users_phone_active ON identity.users (phone) WHERE is_deleted = false AND phone IS NOT NULL;
CREATE UNIQUE INDEX uq_addresses_one_default_per_user ON identity.addresses (user_id) WHERE is_default = true AND is_deleted = false;
```

Email so sánh không phân biệt hoa thường ở cả code (`mode: 'insensitive'`) lẫn index. Unique index là chốt cuối
khi hai request đăng ký song song (P2002 → 409 `COMMON_DUPLICATE`).

## Trạng thái và vòng đời

* `users.status`: `active` ⇄ `locked` (admin, có `locked_reason`); `inactive` dành cho tương lai (nghỉ việc).
  Khoá = bump pv + thu hồi mọi refresh token + outbox USER_LOCKED (mail) → token đang dùng 401 ngay.
* `refresh_tokens`: sống → `ROTATED` (có `replaced_by_id`) | `LOGOUT` | `PASSWORD_CHANGED` | `PASSWORD_RESET`
  | `PASSWORD_RESET_BY_ADMIN` | `USER_LOCKED` | `USER_INACTIVE` | `REUSE_DETECTED`.

## Dữ liệu ở Redis (không có bảng)

| Key | TTL | Dùng cho |
|---|---|---|
| `ef:identity:login-fail:<email>:<ip>` | 15' | đếm sai mật khẩu, ≥5 → 429 |
| `ef:identity:otp:reset:<email>` + `otp-attempts` | 10' | OTP quên mật khẩu, tối đa 5 lần thử |
| `ef:identity:bl:<jti>` | = thời gian còn lại của access token | blacklist sau logout/đổi mật khẩu |
| `ef:identity:user-auth:<userId>` | 60s | {status, pv, roleId, roleCode} — guard đọc mỗi request |
| `ef:identity:effective-perms:<userId>:<pv>` | 300s | tập mã quyền hiệu lực |
| `ef:rl:<name>:<ip|user>` | theo route | rate limit (`@RateLimit`) |

Mất Redis: mất OTP đang chờ + tạm mất chống dò; xác thực/phân quyền tự đọc DB. Không mất dữ liệu.

## Bất biến phải giữ khi sửa module

1. Mọi chỗ làm pv tăng phải gọi `TokenService.invalidateUserAuth(userId)` sau commit (đổi preset vai:
   `invalidateAllUserAuth()`), nếu không token mới bị coi là `PERMISSION_VERSION_STALE` tới 60s.
2. Không bao giờ trả `password_hash`, `permission_version` ra API; không log token/mật khẩu/OTP.
3. `userId` của thao tác "của tôi" luôn từ JWT (`@CurrentActor`), không từ body/query.
