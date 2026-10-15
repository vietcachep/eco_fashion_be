import type { PrismaClient } from '../../src/generated/prisma/client';
import { checkPassword, secureAccounts } from './secure-accounts';

/* Sau khi nạp dữ liệu mẫu lên server công khai: admin và nhân viên sàn không được còn mật khẩu mẫu công khai. */

jest.mock('../seed/create-admin', () => ({ createAdmin: jest.fn().mockResolvedValue('existed') }));

function fakePrisma(staffIds: string[]) {
  const userFindFirst = jest.fn().mockResolvedValue({ id: 'admin-1' });
  const userUpdate = jest.fn().mockResolvedValue({});
  const userFindMany = jest.fn().mockResolvedValue(staffIds.map((id) => ({ id })));
  const userUpdateMany = jest.fn().mockResolvedValue({ count: staffIds.length });
  const tokenDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = { user: { findFirst: userFindFirst, update: userUpdate, findMany: userFindMany, updateMany: userUpdateMany }, refreshToken: { deleteMany: tokenDeleteMany } } as unknown as PrismaClient;
  return { prisma, userUpdate, userUpdateMany, tokenDeleteMany, userFindMany };
}

describe('checkPassword', () => {
  it.each([
    [undefined, 'đang trống'],
    ['Admin123456!', 'mật khẩu mẫu'],
    ['NhanVien123!', 'mật khẩu mẫu'],
    ['ngan1', 'từ 12 ký tự'],
  ])('%s bị từ chối (%s)', (value, reason) => {
    expect(checkPassword('X', value)).toContain(reason);
  });

  it('mật khẩu đủ dài và không phải mẫu được chấp nhận', () => {
    expect(checkPassword('X', 'Mat-Khau-Rieng-2026')).toBeNull();
  });
});

describe('secureAccounts', () => {
  it('đặt mật khẩu mới cho admin (băm argon2, không lưu bản rõ), thu hồi phiên, tăng permission_version', async () => {
    const f = fakePrisma([]);

    const r = await secureAccounts(f.prisma, { adminEmail: 'Admin@FITLY.vn', adminPassword: 'Mat-Khau-Rieng-2026' });

    expect(r).toEqual({ adminUpdated: true, staffPasswordSet: 0, staffLocked: 0 });
    const data = (f.userUpdate.mock.calls[0] as [{ data: { passwordHash: string; permissionVersion: unknown } }])[0].data;
    expect(data.passwordHash).toMatch(/^\$argon2id\$/);
    expect(data.passwordHash).not.toContain('Mat-Khau-Rieng-2026');
    expect(data.permissionVersion).toEqual({ increment: 1 });
    expect(f.tokenDeleteMany).toHaveBeenCalledWith({ where: { userId: 'admin-1' } });
  });

  it('có staffPassword ⇒ đặt mật khẩu mới cho mọi nhân viên sàn và thu hồi phiên', async () => {
    const f = fakePrisma(['s1', 's2']);

    const r = await secureAccounts(f.prisma, { adminEmail: 'a@b.vn', adminPassword: 'Mat-Khau-Rieng-2026', staffPassword: 'Nhan-Vien-Rieng-2026' });

    expect(r.staffPasswordSet).toBe(2);
    expect(r.staffLocked).toBe(0);
    const arg = f.userUpdateMany.mock.calls[0] as [{ where: { id: { in: string[] } }; data: { passwordHash?: string; status?: string } }];
    expect(arg[0].where.id.in).toEqual(['s1', 's2']);
    expect(arg[0].data.passwordHash).toMatch(/^\$argon2id\$/);
    expect(arg[0].data.status).toBeUndefined();
    expect(f.tokenDeleteMany).toHaveBeenCalledWith({ where: { userId: { in: ['s1', 's2'] } } });
  });

  it('KHÔNG có staffPassword ⇒ khoá nhân viên sàn (không để mật khẩu mẫu còn dùng được)', async () => {
    const f = fakePrisma(['s1']);

    const r = await secureAccounts(f.prisma, { adminEmail: 'a@b.vn', adminPassword: 'Mat-Khau-Rieng-2026' });

    expect(r).toEqual({ adminUpdated: true, staffPasswordSet: 0, staffLocked: 1 });
    const arg = f.userUpdateMany.mock.calls[0] as [{ data: { status: string; lockedReason: string; passwordHash?: string } }];
    expect(arg[0].data.status).toBe('locked');
    expect(arg[0].data.lockedReason).toContain('khoá');
    expect(arg[0].data.passwordHash).toBeUndefined();
  });

  it('không có nhân viên sàn ⇒ không đụng tới bảng user lần hai', async () => {
    const f = fakePrisma([]);

    await secureAccounts(f.prisma, { adminEmail: 'a@b.vn', adminPassword: 'Mat-Khau-Rieng-2026' });

    expect(f.userUpdateMany).not.toHaveBeenCalled();
  });
});
