import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { Prisma } from '../../../../generated/prisma/client';

/* Hồ sơ đầy đủ (không có password_hash) kèm vai — dùng cho DTO. */
export const USER_PROFILE_SELECT = {
  id: true,
  email: true,
  phone: true,
  fullName: true,
  avatarUrl: true,
  status: true,
  permissionVersion: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  lockedReason: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  role: { select: { code: true, name: true } },
} satisfies Prisma.UserSelect;

export type UserProfileRow = Prisma.UserGetPayload<{ select: typeof USER_PROFILE_SELECT }>;

/* Dữ liệu tối thiểu để xác thực/phân quyền — cache được, không chứa hash. */
export interface UserAuthRow {
  id: string;
  email: string;
  roleId: string;
  roleCode: string;
  status: string;
  permissionVersion: number;
  isDeleted: boolean;
}

/*
 * Truy vấn bảng users — chỉ module identity. `findForLogin` là hàm DUY NHẤT trả password_hash và chỉ AuthService gọi.
 * Email so sánh không phân biệt hoa thường (unique partial index cũng theo lower(email)).
 */
@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async findForLogin(email: string, tx?: Tx | null) {
    return this.db(tx).user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, isDeleted: false },
      select: { id: true, email: true, passwordHash: true, status: true, permissionVersion: true, roleId: true, role: { select: { code: true } }, lockedReason: true },
    });
  }

  /* Đăng nhập Google: tìm theo `sub` (unique) — trả hồ sơ + vai để phát token. */
  async findByGoogleSub(googleSub: string, tx?: Tx | null): Promise<UserProfileRow | null> {
    return this.db(tx).user.findFirst({ where: { googleSub, isDeleted: false }, select: USER_PROFILE_SELECT });
  }

  async passwordHashOf(userId: string, tx?: Tx | null): Promise<string | null> {
    const u = await this.db(tx).user.findFirst({ where: { id: userId, isDeleted: false }, select: { passwordHash: true } });
    return u?.passwordHash ?? null;
  }

  async findAuthById(userId: string, tx?: Tx | null): Promise<UserAuthRow | null> {
    const u = await this.db(tx).user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, roleId: true, status: true, permissionVersion: true, isDeleted: true, role: { select: { code: true } } },
    });
    return u ? { ...u, roleCode: u.role.code } : null;
  }

  async findProfile(userId: string, tx?: Tx | null): Promise<UserProfileRow | null> {
    return this.db(tx).user.findFirst({ where: { id: userId, isDeleted: false }, select: USER_PROFILE_SELECT });
  }

  async emailExists(email: string, tx?: Tx | null): Promise<boolean> {
    const n = await this.db(tx).user.count({ where: { email: { equals: email, mode: 'insensitive' }, isDeleted: false } });
    return n > 0;
  }

  /* Tìm user theo email (PLAN-0014 — shop mời nhân viên bằng email, không phải id). */
  async findByEmail(email: string, tx?: Tx | null): Promise<UserProfileRow | null> {
    return this.db(tx).user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, isDeleted: false }, select: USER_PROFILE_SELECT });
  }

  async phoneExists(phone: string, exceptUserId?: string, tx?: Tx | null): Promise<boolean> {
    const n = await this.db(tx).user.count({ where: { phone, isDeleted: false, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) } });
    return n > 0;
  }

  async create(data: Prisma.UserUncheckedCreateInput, tx?: Tx | null): Promise<UserProfileRow> {
    return this.db(tx).user.create({ data, select: USER_PROFILE_SELECT });
  }

  async update(userId: string, data: Prisma.UserUncheckedUpdateInput, tx?: Tx | null): Promise<UserProfileRow> {
    return this.db(tx).user.update({ where: { id: userId }, data, select: USER_PROFILE_SELECT });
  }

  async list(params: { skip: number; take: number; q?: string; roleCode?: string; status?: string; staffOnly?: boolean }) {
    const where: Prisma.UserWhereInput = {
      isDeleted: false,
      ...(params.q
        ? { OR: [{ email: { contains: params.q, mode: 'insensitive' } }, { fullName: { contains: params.q, mode: 'insensitive' } }, { phone: { contains: params.q } }] }
        : {}),
      ...(params.roleCode ? { role: { code: params.roleCode } } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.staffOnly ? { role: { code: { not: 'customer' } } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({ where, skip: params.skip, take: params.take, orderBy: { createdAt: 'desc' }, select: USER_PROFILE_SELECT }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total };
  }

  async findSnapshots(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, fullName: true, phone: true, status: true, emailVerifiedAt: true, role: { select: { code: true } } },
    });
  }

  async activeStaffIdsWithPermission(permissionCode: string): Promise<string[]> {
    // Nhân viên có quyền qua vai HOẶC cấp riêng, trừ người bị chặn riêng — hai query gộp, không N+1.
    const [viaRole, overrides] = await Promise.all([
      this.prisma.user.findMany({
        where: { isDeleted: false, status: 'active', role: { rolePermissions: { some: { permission: { code: permissionCode } } } } },
        select: { id: true },
      }),
      this.prisma.userPermission.findMany({ where: { permission: { code: permissionCode } }, select: { userId: true, allowed: true } }),
    ]);
    const ids = new Set(viaRole.map((u) => u.id));
    for (const o of overrides) if (o.allowed) ids.add(o.userId);
    for (const o of overrides) if (!o.allowed) ids.delete(o.userId);
    return [...ids];
  }
}
