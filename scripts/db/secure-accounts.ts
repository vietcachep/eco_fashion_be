/*
 * ĐỔI MẬT KHẨU TÀI KHOẢN QUẢN TRỊ SAU KHI NẠP DỮ LIỆU MẪU  —  `npm run db:secure`
 *
 * Dump/seed mang theo các tài khoản mẫu có mật khẩu CÔNG KHAI trong tài liệu (admin@… / Admin123456!, manager@… / NhanVien123!…). Trên server
 * có thể truy cập từ Internet thì ai đọc repo cũng đăng nhập được quyền quản trị ⇒ sau khi nạp dữ liệu PHẢI đổi:
 *  - admin (EF_ADMIN_EMAIL): đặt mật khẩu = EF_ADMIN_PASSWORD (không được là mật khẩu mẫu, tối thiểu 12 ký tự);
 *  - nhân viên sàn (manager/sales/warehouse/accountant/marketing): nếu có EF_STAFF_PASSWORD thì đặt mật khẩu = giá trị đó (tối thiểu 12 ký tự),
 *    không có thì KHÓA các tài khoản này (status=locked) — muốn dùng thì admin mở khoá + đặt lại mật khẩu trong màn Người dùng.
 * Mọi tài khoản bị đổi đều bị thu hồi phiên đăng nhập (refresh token) và tăng permission_version. Chủ shop/nhân viên shop/khách mẫu GIỮ NGUYÊN
 * (chỉ quản lý dữ liệu của chính shop/đơn của mình) — xoá hoặc khoá bằng tay nếu không muốn công khai.
 * Idempotent: chạy lại an toàn.
 */
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { loadEnv } from '../../src/config/env';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createAdmin } from '../seed/create-admin';

export const PLATFORM_STAFF_ROLES = ['manager', 'sales', 'warehouse', 'accountant', 'marketing'] as const;
const SAMPLE_PASSWORDS = new Set(['Admin123456!', 'NhanVien123!', 'Vendor123456!', 'Khach123456!']);
const MIN_LENGTH = 12;

export function checkPassword(label: string, value: string | undefined): string | null {
  if (!value) return `${label} đang trống`;
  if (SAMPLE_PASSWORDS.has(value)) return `${label} đang là mật khẩu mẫu công khai`;
  if (value.length < MIN_LENGTH) return `${label} phải từ ${MIN_LENGTH} ký tự`;
  return null;
}

export interface SecureOptions {
  adminEmail: string;
  adminPassword: string;
  staffPassword?: string;
}

export interface SecureResult {
  adminUpdated: boolean;
  staffPasswordSet: number;
  staffLocked: number;
}

const hash = (password: string): Promise<string> => argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

export async function secureAccounts(prisma: PrismaClient, opts: SecureOptions): Promise<SecureResult> {
  const result: SecureResult = { adminUpdated: false, staffPasswordSet: 0, staffLocked: 0 };

  // admin: đảm bảo tồn tại rồi ĐẶT mật khẩu mới (createAdmin cố ý không đặt lại mật khẩu của tài khoản đã có)
  await createAdmin(prisma, opts.adminEmail, opts.adminPassword);
  const admin = await prisma.user.findFirst({ where: { email: { equals: opts.adminEmail.trim().toLowerCase(), mode: 'insensitive' }, isDeleted: false }, select: { id: true } });
  if (admin) {
    await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: await hash(opts.adminPassword), lockedReason: null, status: 'active', permissionVersion: { increment: 1 } } });
    await prisma.refreshToken.deleteMany({ where: { userId: admin.id } });
    result.adminUpdated = true;
  }

  // nhân viên sàn: đặt mật khẩu mới hoặc khoá
  const staff = await prisma.user.findMany({ where: { isDeleted: false, role: { code: { in: [...PLATFORM_STAFF_ROLES] } } }, select: { id: true } });
  if (staff.length > 0) {
    const ids = staff.map((u) => u.id);
    if (opts.staffPassword) {
      await prisma.user.updateMany({ where: { id: { in: ids } }, data: { passwordHash: await hash(opts.staffPassword), permissionVersion: { increment: 1 } } });
      result.staffPasswordSet = ids.length;
    } else {
      await prisma.user.updateMany({ where: { id: { in: ids } }, data: { status: 'locked', lockedReason: 'Tài khoản mẫu bị khoá khi triển khai — admin mở khoá và đặt lại mật khẩu nếu cần', permissionVersion: { increment: 1 } } });
      result.staffLocked = ids.length;
    }
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  }
  return result;
}

async function main(): Promise<number> {
  const env = loadEnv();
  const staffPassword = process.env.EF_STAFF_PASSWORD || undefined;
  const problems = [checkPassword('EF_ADMIN_PASSWORD', env.EF_ADMIN_PASSWORD), staffPassword ? checkPassword('EF_STAFF_PASSWORD', staffPassword) : null].filter((x): x is string => x !== null);
  if (problems.length > 0) {
    console.error(`Không đổi được mật khẩu:\n  - ${problems.join('\n  - ')}`);
    return 1;
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.EF_DATABASE_URL }) });
  try {
    const r = await secureAccounts(prisma, { adminEmail: env.EF_ADMIN_EMAIL, adminPassword: env.EF_ADMIN_PASSWORD, staffPassword });
    console.log(`db:secure — admin ${env.EF_ADMIN_EMAIL}: ${r.adminUpdated ? 'đã đặt mật khẩu mới' : 'không tìm thấy'}; nhân viên sàn: ${r.staffPasswordSet > 0 ? `đã đặt mật khẩu mới cho ${r.staffPasswordSet} tài khoản` : r.staffLocked > 0 ? `đã KHOÁ ${r.staffLocked} tài khoản` : 'không có'}.`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
