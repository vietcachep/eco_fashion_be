import { Injectable, Logger } from '@nestjs/common';
import { CacheService, CacheSpec } from '@common/cache/cache.service';
import { NotFoundException, ForbiddenException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { IdentityAuditLogService } from '../../audit/identity-audit-log.service';
import { TokenService } from '../../auth/service/token.service';
import { IDENTITY_AUDIT, IDENTITY_ERR, PERMISSION_CACHE_TTL } from '../../foundation/identity.constants';
import { UserRepository } from '../../user/repository/user.repository';
import { PermissionRepository, PermissionRow, RoleRow, UserPermissionRow } from '../repository/permission.repository';

export const PERMISSION_CACHE: CacheSpec = { module: 'identity', purpose: 'effective-perms', ttlSeconds: PERMISSION_CACHE_TTL };

/*
 * Tính và cache QUYỀN HIỆU LỰC (vai ∪ cấp riêng − chặn riêng, deny thắng) + quản trị preset vai / override.
 * - Cache Redis key `ef:identity:effective-perms:<userId>:<pv>` — pv (permission_version) nằm trong key nên
 *   đổi quyền → bump pv → key mới, không cần xoá thủ công (vẫn xoá cho gọn). pv lấy từ cache user-auth (60s)
 *   của TokenService → một request có quyền đi qua guard mà KHÔNG chạm DB khi cache ấm.
 * - Đổi preset vai: transaction thay toàn bộ role_permissions + bump pv mọi user của vai + audit → xoá cả cụm cache.
 * - Override: transaction upsert/xoá + bump pv user + audit → xoá cache user-auth + effective-perms của user đó.
 *   Admin không tự chặn quyền `identity.permission.assign` của chính mình (tự khoá cửa).
 * Không ghi outbox: quyền là dữ liệu nội bộ module, module khác chỉ hỏi qua gateway.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: PermissionRepository,
    private readonly users: UserRepository,
    private readonly tokens: TokenService,
    private readonly cache: CacheService,
    private readonly audit: IdentityAuditLogService,
  ) {}

  static effective(roleCodes: readonly string[], overrides: readonly { code: string; allowed: boolean }[]): Set<string> {
    const set = new Set(roleCodes);
    for (const o of overrides) if (o.allowed) set.add(o.code);
    for (const o of overrides) if (!o.allowed) set.delete(o.code);
    return set;
  }

  async effectivePermissions(userId: string): Promise<ReadonlySet<string>> {
    const user = await this.tokens.userAuthState(userId);
    if (!user || user.isDeleted || user.status !== 'active') return new Set();
    const codes = await this.cache.getOrSet<string[]>(PERMISSION_CACHE, `${userId}:${user.permissionVersion}`, async () => {
      const [roleCodes, overrides] = await Promise.all([this.repo.roleCodes(user.roleId), this.repo.userOverrides(userId)]);
      return [...PermissionService.effective(roleCodes, overrides)];
    });
    return new Set(codes);
  }

  /* Gọi SAU khi commit bất kỳ thay đổi nào làm pv của user tăng (override, đổi vai, khoá, đổi mật khẩu). */
  async invalidateUser(userId: string): Promise<void> {
    await this.tokens.invalidateUserAuth(userId);
    // pv nằm trong key nên bản cũ tự mồ côi; xoá theo prefix để không đợi TTL.
    await this.cache.delByPrefix({ ...PERMISSION_CACHE, purpose: `effective-perms:${userId}` });
  }

  async listRoles(): Promise<Array<RoleRow & { permissionCodes: string[] }>> {
    const roles = await this.repo.listRoles();
    const withCodes = await Promise.all(roles.map(async (r) => ({ ...r, permissionCodes: await this.repo.roleCodes(r.id) })));
    return withCodes;
  }

  async listPermissions(): Promise<PermissionRow[]> {
    return this.repo.listPermissions();
  }

  async rolePermissions(roleCode: string): Promise<{ role: RoleRow; permissionCodes: string[] }> {
    const role = await this.repo.findRoleByCode(roleCode);
    if (!role) throw new NotFoundException(IDENTITY_ERR.ROLE_NOT_FOUND, `Không có vai '${roleCode}'`);
    return { role, permissionCodes: await this.repo.roleCodes(role.id) };
  }

  async replaceRolePermissions(actor: AuthenticatedActor, roleCode: string, codes: string[]): Promise<string[]> {
    const role = await this.repo.findRoleByCode(roleCode);
    if (!role) throw new NotFoundException(IDENTITY_ERR.ROLE_NOT_FOUND, `Không có vai '${roleCode}'`);
    // Vai scope=shop (chủ/nhân viên gian hàng): sàn KHÔNG sửa preset — quyền nhân viên do từng chủ shop tự đặt (PUT /shop/members/:id/permissions).
    if (role.scope === 'shop') throw new ForbiddenException(IDENTITY_ERR.ROLE_SYSTEM_LOCKED, 'Vai của gian hàng do chủ từng shop tự phân quyền — sàn không sửa preset');
    if (role.code === 'admin') throw new ForbiddenException(IDENTITY_ERR.ROLE_SYSTEM_LOCKED, 'Vai admin luôn có toàn quyền, không sửa preset');
    const unique = [...new Set(codes)];
    const perms = await this.repo.findPermissionsByCodes(unique);
    const missing = unique.filter((c) => !perms.some((p) => p.code === c));
    if (missing.length > 0) throw new NotFoundException(IDENTITY_ERR.PERMISSION_NOT_FOUND, `Mã quyền không tồn tại: ${missing.join(', ')}`);
    const before = await this.repo.roleCodes(role.id);
    if (before.length === unique.length && before.every((c) => unique.includes(c))) return before; // no-op: không audit thừa
    await this.prisma.$transaction(async (tx) => {
      await this.repo.replaceRolePermissions(role.id, perms.map((p) => p.id), actor.userId, tx);
      const affected = await this.repo.bumpPermissionVersionByRole(role.id, tx);
      await this.audit.write(tx, actor, {
        action: IDENTITY_AUDIT.ROLE_PERMISSIONS_UPDATED,
        entityType: 'role',
        entityId: role.id,
        entityCode: role.code,
        before: { permissionCodes: before },
        after: { permissionCodes: unique, affectedUsers: affected },
      });
    });
    await this.tokens.invalidateAllUserAuth();
    await this.cache.delByPrefix(PERMISSION_CACHE);
    this.logger.log({ roleCode, userId: actor.userId }, 'Đã cập nhật preset quyền của vai');
    return unique;
  }

  async userOverrides(userId: string): Promise<UserPermissionRow[]> {
    const user = await this.users.findAuthById(userId);
    if (!user || user.isDeleted) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    return this.repo.userOverrides(userId);
  }

  async saveUserOverrides(
    actor: AuthenticatedActor,
    userId: string,
    overrides: Array<{ code: string; allowed: boolean | null; reason?: string | null }>,
  ): Promise<UserPermissionRow[]> {
    const user = await this.users.findAuthById(userId);
    if (!user || user.isDeleted) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    if (userId === actor.userId && overrides.some((o) => o.code === 'identity.permission.assign' && o.allowed === false)) {
      throw new ForbiddenException(IDENTITY_ERR.CANNOT_MODIFY_SELF, 'Không thể tự chặn quyền phân quyền của chính mình');
    }
    const perms = await this.repo.findPermissionsByCodes(overrides.map((o) => o.code));
    const missing = overrides.filter((o) => !perms.some((p) => p.code === o.code)).map((o) => o.code);
    if (missing.length > 0) throw new NotFoundException(IDENTITY_ERR.PERMISSION_NOT_FOUND, `Mã quyền không tồn tại: ${missing.join(', ')}`);
    const before = await this.repo.userOverrides(userId);
    await this.prisma.$transaction(async (tx) => {
      for (const o of overrides) {
        const perm = perms.find((p) => p.code === o.code)!;
        if (o.allowed === null) await this.repo.deleteUserOverride(userId, perm.id, tx);
        else await this.repo.upsertUserOverride(userId, perm.id, o.allowed, o.reason ?? null, actor.userId, tx);
      }
      await tx.user.update({ where: { id: userId }, data: { permissionVersion: { increment: 1 }, updatedBy: actor.userId } });
      await this.audit.write(tx, actor, {
        action: IDENTITY_AUDIT.USER_PERMISSIONS_UPDATED,
        entityType: 'user',
        entityId: userId,
        entityCode: user.email,
        before: { overrides: before.map((b) => ({ code: b.code, allowed: b.allowed })) },
        after: { overrides },
      });
    });
    await this.invalidateUser(userId);
    return this.repo.userOverrides(userId);
  }
}
