import type { AuthenticatedActor } from './authenticated-actor';

export const PERMISSION_AUTHORIZATION_GATEWAY = Symbol('PERMISSION_AUTHORIZATION_GATEWAY');
export const TOKEN_VALIDATION_GATEWAY = Symbol('TOKEN_VALIDATION_GATEWAY');

/*
 * Cổng phân quyền mà common/security cần nhưng dữ liệu nằm ở module identity.
 * identity cài đặt (đọc DB + cache Redis theo permission_version); app.module tiêm.
 * common không import identity — đây là cách duy nhất giữ common mỏng mà guard vẫn kiểm được quyền thật.
 */
export interface PermissionAuthorizationGateway {
  /* Tập mã quyền hiệu lực của user (vai ∪ cấp riêng − chặn riêng). Rỗng nếu user không tồn tại/khoá. */
  effectivePermissions(userId: string): Promise<ReadonlySet<string>>;
}

/*
 * Cổng kiểm token còn hiệu lực ngoài chữ ký/exp: jti có bị thu hồi (logout/đổi mật khẩu) không,
 * permission_version trong token có còn khớp DB không, user có bị khoá không.
 */
export interface TokenValidationGateway {
  validate(actor: AuthenticatedActor): Promise<TokenValidationResult>;
}

export type TokenValidationResult =
  | { ok: true }
  | { ok: false; reason: 'REVOKED' | 'USER_INACTIVE' | 'PERMISSION_VERSION_STALE' | 'USER_NOT_FOUND' };
