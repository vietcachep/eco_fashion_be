/*
 * Đồng bộ CATALOG QUYỀN (src/modules/identity/permission/catalog.ts) vào DB — service `migrate` của compose chạy
 * ngay sau `prisma migrate deploy`, nên máy mới dựng lên là đủ vai + quyền, không có bước tay.
 * IDEMPOTENT:
 * - permissions: upsert theo code (mô tả/module cập nhật theo catalog; `deprecated` → is_active=false, KHÔNG xoá).
 * - roles: tạo 7 vai hệ thống nếu chưa có (is_system=true); tên/mô tả KHÔNG ghi đè (admin có thể đã sửa).
 * - role_permissions: chỉ THÊM mã còn thiếu theo preset; không gỡ mã admin đã thêm tay. Vai admin luôn = toàn bộ catalog.
 * - Có thêm mã cho vai nào → bump permission_version của user vai đó để cache/token cũ mất hiệu lực.
 * Không dùng Nest DI (script độc lập) — chỉ PrismaClient.
 */
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnv } from '../src/config/env';
import { PrismaClient } from '../src/generated/prisma/client';
import { ALL_PERMISSION_CODES, PERMISSION_CATALOG, ROLE_CODES, ROLE_PRESETS, RoleCode } from '../src/modules/identity/permission/catalog';

export async function syncPermissions(prisma: PrismaClient): Promise<{ permissions: number; roles: number; grants: number }> {
  let grants = 0;
  // 1. permissions
  for (const def of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { code: def.code },
      create: { code: def.code, moduleCode: def.module, description: def.description, isActive: !def.deprecated },
      update: { moduleCode: def.module, description: def.description, isActive: !def.deprecated, isDeleted: false },
    });
  }
  const perms = await prisma.permission.findMany({ where: { code: { in: [...ALL_PERMISSION_CODES] } }, select: { id: true, code: true } });
  const idByCode = new Map(perms.map((p) => [p.code, p.id]));

  // 2. roles + 3. preset (chỉ thêm)
  let roles = 0;
  for (const code of Object.values(ROLE_CODES) as RoleCode[]) {
    const preset = ROLE_PRESETS[code];
    const role = await prisma.role.upsert({
      where: { code },
      create: { code, name: preset.name, description: preset.description, isSystem: true, scope: preset.scope },
      update: { isSystem: true, isDeleted: false, scope: preset.scope },
      select: { id: true },
    });
    roles += 1;
    const existing = new Set((await prisma.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionId: true } })).map((r) => r.permissionId));
    const wanted = (code === ROLE_CODES.ADMIN ? ALL_PERMISSION_CODES : preset.codes).map((c) => idByCode.get(c)).filter((id): id is string => !!id);
    const missing = wanted.filter((id) => !existing.has(id));
    if (missing.length > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.rolePermission.createMany({ data: missing.map((permissionId) => ({ roleId: role.id, permissionId })), skipDuplicates: true });
        await tx.user.updateMany({ where: { roleId: role.id, isDeleted: false }, data: { permissionVersion: { increment: 1 } } });
      });
      grants += missing.length;
    }
  }
  return { permissions: PERMISSION_CATALOG.length, roles, grants };
}

async function main(): Promise<number> {
  const env = loadEnv();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.EF_DATABASE_URL }) });
  try {
    const r = await syncPermissions(prisma);
    console.log(`perms:sync — ${r.permissions} mã quyền, ${r.roles} vai, thêm ${r.grants} gán mới.`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
