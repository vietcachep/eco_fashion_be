import { resolveAvatarUrl } from '@common/utils';
import type { UserProfileRow } from '../repository/user.repository';
import { CurrentUserResponse, UserProfileResponse } from '../dto/user.responses';

/* Model Prisma → DTO. Chỉ đọc cột hồ sơ; không bao giờ chạm password_hash. */
export function toUserProfile(u: UserProfileRow): UserProfileResponse {
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    fullName: u.fullName,
    avatarUrl: resolveAvatarUrl(u.avatarUrl, u.fullName || u.email),
    roleCode: u.role.code,
    roleName: u.role.name,
    status: u.status,
    lockedReason: u.lockedReason,
    emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export function toCurrentUser(u: UserProfileRow, permissionCodes: ReadonlySet<string>): CurrentUserResponse {
  return { ...toUserProfile(u), permissionCodes: [...permissionCodes].sort() };
}
