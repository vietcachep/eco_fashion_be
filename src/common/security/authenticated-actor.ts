/*
 * Người đang thao tác — dựng từ JWT sau khi guard xác thực. Là thứ DUY NHẤT tầng service dùng để
 * biết "ai": userId lấy từ token, KHÔNG BAO GIỜ từ body/query (Ownership Rule).
 *
 * `permissionVersion` (claim `pv`) để guard so với DB/Redis: admin đổi quyền là token cũ mất hiệu lực
 * quyền ngay dù chưa hết hạn.
 */
export interface AuthenticatedActor {
  userId: string;
  email: string;
  roleCode: string;
  permissionVersion: number;
  tokenId: string;
  /* Mã quyền hiệu lực — PermissionGuard nạp sau khi kiểm (cache Redis). Chỉ có khi route yêu cầu quyền. */
  permissions?: ReadonlySet<string>;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  pv: number;
  jti: string;
  iat?: number;
  exp?: number;
}

export function actorFromPayload(p: JwtPayload): AuthenticatedActor {
  return { userId: p.sub, email: p.email, roleCode: p.role, permissionVersion: p.pv, tokenId: p.jti };
}
