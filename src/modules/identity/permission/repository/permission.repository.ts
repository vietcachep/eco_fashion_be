import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';

export interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /* platform | shop (PLAN-0014) — Role.scope. */
  scope: string;
}

export interface PermissionRow {
  id: string;
  code: string;
  moduleCode: string;
  description: string;
  isActive: boolean;
}

export interface UserPermissionRow {
  permissionId: string;
  code: string;
  allowed: boolean;
  reason: string | null;
}

/*
 * Truy vấn vai/quyền/override — chỉ model schema identity. Danh sách mã quyền của vai và override của user đọc
 * bằng 2 query gộp (không N+1); SQL thô chỉ cho bump permission_version hàng loạt theo vai.
 */
@Injectable()
export class PermissionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async findRoleByCode(code: string, tx?: Tx | null): Promise<RoleRow | null> {
    return this.db(tx).role.findFirst({
      where: { code, isDeleted: false },
      select: { id: true, code: true, name: true, description: true, isSystem: true, scope: true },
    });
  }

  async findRoleById(id: string, tx?: Tx | null): Promise<RoleRow | null> {
    return this.db(tx).role.findFirst({
      where: { id, isDeleted: false },
      select: { id: true, code: true, name: true, description: true, isSystem: true, scope: true },
    });
  }

  async findRolesByIds(ids: string[], tx?: Tx | null): Promise<RoleRow[]> {
    if (ids.length === 0) return [];
    return this.db(tx).role.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, code: true, name: true, description: true, isSystem: true, scope: true },
    });
  }

  async listRoles(tx?: Tx | null): Promise<RoleRow[]> {
    return this.db(tx).role.findMany({
      where: { isDeleted: false },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, description: true, isSystem: true, scope: true },
    });
  }

  async listPermissions(tx?: Tx | null): Promise<PermissionRow[]> {
    return this.db(tx).permission.findMany({
      where: { isDeleted: false },
      orderBy: [{ moduleCode: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, moduleCode: true, description: true, isActive: true },
    });
  }

  async findPermissionsByCodes(codes: string[], tx?: Tx | null): Promise<PermissionRow[]> {
    if (codes.length === 0) return [];
    return this.db(tx).permission.findMany({
      where: { code: { in: codes }, isDeleted: false },
      select: { id: true, code: true, moduleCode: true, description: true, isActive: true },
    });
  }

  /* Mã quyền (active) của một vai. */
  async roleCodes(roleId: string, tx?: Tx | null): Promise<string[]> {
    const rows = await this.db(tx).rolePermission.findMany({
      where: { roleId, permission: { isActive: true, isDeleted: false } },
      select: { permission: { select: { code: true } } },
    });
    return rows.map((r) => r.permission.code);
  }

  /* Override của user kèm mã quyền. */
  async userOverrides(userId: string, tx?: Tx | null): Promise<UserPermissionRow[]> {
    const rows = await this.db(tx).userPermission.findMany({
      where: { userId, permission: { isActive: true, isDeleted: false } },
      select: { permissionId: true, allowed: true, reason: true, permission: { select: { code: true } } },
    });
    return rows.map((r) => ({ permissionId: r.permissionId, code: r.permission.code, allowed: r.allowed, reason: r.reason }));
  }

  async replaceRolePermissions(roleId: string, permissionIds: string[], actorId: string | null, tx: Tx): Promise<void> {
    await tx.rolePermission.deleteMany({ where: { roleId } });
    if (permissionIds.length > 0) {
      await tx.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId, permissionId, createdBy: actorId })) });
    }
  }

  async upsertUserOverride(
    userId: string,
    permissionId: string,
    allowed: boolean,
    reason: string | null,
    actorId: string | null,
    tx: Tx,
  ): Promise<void> {
    await tx.userPermission.upsert({
      where: { userId_permissionId: { userId, permissionId } },
      create: { userId, permissionId, allowed, reason, createdBy: actorId, updatedBy: actorId },
      update: { allowed, reason, updatedBy: actorId },
    });
  }

  async deleteUserOverride(userId: string, permissionId: string, tx: Tx): Promise<void> {
    await tx.userPermission.deleteMany({ where: { userId, permissionId } });
  }

  /* Tăng permission_version cho MỌI user của vai — token/cache cũ của họ mất hiệu lực quyền ngay. */
  async bumpPermissionVersionByRole(roleId: string, tx: Tx): Promise<number> {
    const r = await tx.user.updateMany({ where: { roleId, isDeleted: false }, data: { permissionVersion: { increment: 1 } } });
    return r.count;
  }
}
