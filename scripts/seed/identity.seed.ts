/*
 * SEED DEMO module identity (AGENTS.md — Seed Rule): nhân viên MỖI VAI + 5 khách + sổ địa chỉ.
 * Idempotent: tìm theo email, có rồi thì bỏ qua (không đặt lại mật khẩu, không nhân đôi địa chỉ).
 * Vai/quyền do `perms:sync` lo; admin do `seed:admin` lo — file này KHÔNG đụng vào.
 *
 *   Nhân viên: manager@ecofashion.vn · sales@ · warehouse@ · accountant@ · marketing@   mật khẩu NhanVien123!
 *   Khách:     khach1@ecofashion.vn … khach5@ecofashion.vn                              mật khẩu Khach123456!
 */
import * as argon2 from 'argon2';
import type { PrismaClient } from '../../src/generated/prisma/client';

export const DEMO_STAFF_PASSWORD = 'NhanVien123!';
export const DEMO_CUSTOMER_PASSWORD = 'Khach123456!';

const STAFF = [
  { email: 'manager@ecofashion.vn', fullName: 'Lê Thị Quản Lý', role: 'manager', phone: '0901000001' },
  { email: 'sales@ecofashion.vn', fullName: 'Trần Văn Bán Hàng', role: 'sales', phone: '0901000002' },
  { email: 'warehouse@ecofashion.vn', fullName: 'Phạm Văn Kho', role: 'warehouse', phone: '0901000003' },
  { email: 'accountant@ecofashion.vn', fullName: 'Nguyễn Thị Kế Toán', role: 'accountant', phone: '0901000004' },
  { email: 'marketing@ecofashion.vn', fullName: 'Hoàng Thị Marketing', role: 'marketing', phone: '0901000005' },
];

const CUSTOMERS = [
  { email: 'khach1@ecofashion.vn', fullName: 'Nguyễn Văn An', phone: '0912000001', address: { provinceCode: '79', provinceName: 'TP. Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Phường Bến Nghé', street: '12 Nguyễn Huệ' } },
  { email: 'khach2@ecofashion.vn', fullName: 'Trần Thị Bình', phone: '0912000002', address: { provinceCode: '01', provinceName: 'Hà Nội', districtName: 'Quận Hoàn Kiếm', wardName: 'Phường Hàng Bạc', street: '5 Hàng Bạc' } },
  { email: 'khach3@ecofashion.vn', fullName: 'Lê Văn Cường', phone: '0912000003', address: { provinceCode: '48', provinceName: 'Đà Nẵng', districtName: 'Quận Hải Châu', wardName: 'Phường Thạch Thang', street: '88 Bạch Đằng' } },
  { email: 'khach4@ecofashion.vn', fullName: 'Phạm Thị Dung', phone: '0912000004', address: { provinceCode: '92', provinceName: 'Cần Thơ', districtName: 'Quận Ninh Kiều', wardName: 'Phường Tân An', street: '20 Hai Bà Trưng' } },
  { email: 'khach5@ecofashion.vn', fullName: 'Võ Văn Em', phone: '0912000005', address: { provinceCode: '79', provinceName: 'TP. Hồ Chí Minh', districtName: 'TP. Thủ Đức', wardName: 'Phường Linh Trung', street: '1 Võ Văn Ngân' } },
];

const ARGON2 = { type: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 }; // argon2id

export async function seed(prisma: PrismaClient): Promise<void> {
  const roles = await prisma.role.findMany({ where: { isDeleted: false }, select: { id: true, code: true } });
  const roleId = (code: string): string => {
    const r = roles.find((x) => x.code === code);
    if (!r) throw new Error(`Thiếu vai '${code}' — perms:sync chưa chạy?`);
    return r.id;
  };
  const staffHash = await argon2.hash(DEMO_STAFF_PASSWORD, ARGON2);
  const customerHash = await argon2.hash(DEMO_CUSTOMER_PASSWORD, ARGON2);

  let created = 0;
  for (const s of STAFF) {
    const exists = await prisma.user.findFirst({ where: { email: { equals: s.email, mode: 'insensitive' }, isDeleted: false }, select: { id: true } });
    if (exists) continue;
    await prisma.user.create({ data: { email: s.email, fullName: s.fullName, phone: s.phone, passwordHash: staffHash, roleId: roleId(s.role), status: 'active', emailVerifiedAt: new Date() } });
    created += 1;
  }
  console.log(`   nhân viên: ${STAFF.length} (tạo mới ${created})`);

  created = 0;
  let addresses = 0;
  for (const c of CUSTOMERS) {
    let user = await prisma.user.findFirst({ where: { email: { equals: c.email, mode: 'insensitive' }, isDeleted: false }, select: { id: true } });
    if (!user) {
      user = await prisma.user.create({
        data: { email: c.email, fullName: c.fullName, phone: c.phone, passwordHash: customerHash, roleId: roleId('customer'), status: 'active', emailVerifiedAt: new Date() },
        select: { id: true },
      });
      created += 1;
    }
    const hasAddress = await prisma.address.count({ where: { userId: user.id, isDeleted: false } });
    if (hasAddress === 0) {
      await prisma.address.create({ data: { userId: user.id, recipientName: c.fullName, phone: c.phone, ...c.address, isDefault: true, createdBy: user.id, updatedBy: user.id } });
      addresses += 1;
    }
  }
  console.log(`   khách: ${CUSTOMERS.length} (tạo mới ${created}), địa chỉ tạo mới ${addresses}`);
}
