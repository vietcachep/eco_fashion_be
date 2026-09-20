/*
 * Tạo tài khoản ADMIN đầu tiên từ EF_ADMIN_EMAIL / EF_ADMIN_PASSWORD (service `seed` của compose gọi trước seed demo;
 * production cũng chạy được — không phải dữ liệu demo). IDEMPOTENT: đã có email → chỉ đảm bảo vai admin + active,
 * KHÔNG đặt lại mật khẩu (tránh ghi đè mật khẩu người dùng đã đổi). Cần vai `admin` (perms:sync chạy trước).
 */
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { loadEnv } from '../../src/config/env';
import { PrismaClient } from '../../src/generated/prisma/client';

export async function createAdmin(prisma: PrismaClient, email: string, password: string): Promise<'created' | 'existed'> {
  const role = await prisma.role.findFirst({ where: { code: 'admin', isDeleted: false }, select: { id: true } });
  if (!role) throw new Error('Chưa có vai admin — chạy `npm run perms:sync` trước.');
  const lower = email.trim().toLowerCase();
  const existing = await prisma.user.findFirst({ where: { email: { equals: lower, mode: 'insensitive' }, isDeleted: false }, select: { id: true, roleId: true, status: true } });
  if (existing) {
    if (existing.roleId !== role.id || existing.status !== 'active') {
      await prisma.user.update({ where: { id: existing.id }, data: { roleId: role.id, status: 'active', lockedReason: null, permissionVersion: { increment: 1 } } });
    }
    return 'existed';
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await prisma.user.create({
    data: { email: lower, fullName: 'Quản trị viên', passwordHash, roleId: role.id, status: 'active', emailVerifiedAt: new Date() },
  });
  return 'created';
}

async function main(): Promise<number> {
  const env = loadEnv();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.EF_DATABASE_URL }) });
  try {
    const r = await createAdmin(prisma, env.EF_ADMIN_EMAIL, env.EF_ADMIN_PASSWORD);
    console.log(r === 'created' ? `seed:admin — đã tạo admin ${env.EF_ADMIN_EMAIL}` : `seed:admin — admin ${env.EF_ADMIN_EMAIL} đã có, giữ nguyên mật khẩu`);
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
