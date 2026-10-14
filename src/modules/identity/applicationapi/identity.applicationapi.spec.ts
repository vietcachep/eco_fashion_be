import { Logger } from '@nestjs/common';
import { BusinessException } from '@common/exception/business.exception';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { IdentityAuditLogService } from '../audit/identity-audit-log.service';
import { IDENTITY_AUDIT, IDENTITY_ERR } from '../foundation/identity.constants';
import type { PermissionRepository } from '../permission/repository/permission.repository';
import type { UserRepository } from '../user/repository/user.repository';
import { IdentityApplicationApi } from './identity.applicationapi';

/*
 * Cổng ghi của identity cho module shop (chủ shop tạo tài khoản nhân viên): luật mật khẩu một nguồn, tài khoản luôn là KHÁCH THƯỜNG
 * (không bao giờ nhân viên sàn), email trùng ⇒ 409 (kể cả race ở chốt unique DB), audit trong cùng transaction, không lộ mật khẩu.
 */

const tx = { marker: 'tx' } as unknown as Tx;
const OWNER: AuthenticatedActor = { userId: 'owner-1', email: 'chu@shop.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-1' };
const INPUT = { email: 'NhanVien@Gmail.com', fullName: '  Nguyễn Văn Kho  ', passwordHash: 'HASH' };

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => {
  jest.restoreAllMocks();
});

async function rejection(p: Promise<unknown>): Promise<BusinessException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessException) return e;
    throw e;
  }
  throw new Error('Kỳ vọng ném BusinessException nhưng thao tác lại thành công');
}

function build() {
  const users = {
    emailExists: jest.fn<Promise<boolean>, Parameters<UserRepository['emailExists']>>(),
    create: jest.fn<Promise<{ id: string; email: string; fullName: string }>, [Record<string, unknown>, Tx]>(),
  };
  const roles = { findRoleByCode: jest.fn<Promise<{ id: string; code: string } | null>, [string]>() };
  const auditWrite = jest.fn<Promise<void>, Parameters<IdentityAuditLogService['write']>>();

  users.emailExists.mockResolvedValue(false);
  users.create.mockImplementation((data) => Promise.resolve({ id: 'u-new', email: data.email as string, fullName: data.fullName as string }));
  roles.findRoleByCode.mockResolvedValue({ id: 'role-customer', code: 'customer' });
  auditWrite.mockResolvedValue(undefined);

  const api = new IdentityApplicationApi(users as unknown as UserRepository, roles as unknown as PermissionRepository, { write: auditWrite } as unknown as IdentityAuditLogService);
  return { api, users, roles, auditWrite };
}

describe('hashPassword', () => {
  it.each(['abcdefgh', '12345678', 'ab1', 'a'.repeat(65) + '1'])('mật khẩu %s không đạt luật (8–64 ký tự, có chữ và số) → 400 IDENTITY_PASSWORD_WEAK', async (pw) => {
    const { api } = build();

    const e = await rejection(api.hashPassword(pw));

    expect(e.errorCode).toBe(IDENTITY_ERR.PASSWORD_WEAK);
    expect(e.httpStatus).toBe(400);
  });

  it('mật khẩu hợp lệ → trả hash (không phải chính mật khẩu)', async () => {
    const { api } = build();

    const hash = await api.hashPassword('MatKhau123');

    expect(hash).toEqual(expect.any(String));
    expect(hash).not.toContain('MatKhau123');
  });
});

describe('createCustomerAccount', () => {
  it('tạo user VAI CUSTOMER, email chữ thường, tên đã trim, active, createdBy = chủ shop, KHÔNG đánh dấu email đã xác minh; audit USER_CREATED trong cùng tx', async () => {
    const h = build();

    const r = await h.api.createCustomerAccount(OWNER, INPUT, tx);

    expect(h.roles.findRoleByCode).toHaveBeenCalledWith('customer');
    expect(h.users.emailExists).toHaveBeenCalledWith('nhanvien@gmail.com', tx);
    const [data, usedTx] = h.users.create.mock.calls[0];
    expect(usedTx).toBe(tx);
    expect(data).toMatchObject({ email: 'nhanvien@gmail.com', fullName: 'Nguyễn Văn Kho', passwordHash: 'HASH', roleId: 'role-customer', status: 'active', createdBy: 'owner-1', updatedBy: 'owner-1' });
    expect(data).not.toHaveProperty('emailVerifiedAt');
    expect(h.auditWrite).toHaveBeenCalledWith(tx, OWNER, expect.objectContaining({ action: IDENTITY_AUDIT.USER_CREATED, entityType: 'user', entityId: 'u-new', after: { email: 'nhanvien@gmail.com', role: 'customer', fullName: 'Nguyễn Văn Kho', via: 'shop_staff' } }));
    expect(JSON.stringify(h.auditWrite.mock.calls)).not.toContain('HASH');
    expect(r).toEqual({ userId: 'u-new', email: 'nhanvien@gmail.com', fullName: 'Nguyễn Văn Kho' });
  });

  it('email đã có tài khoản → 409 IDENTITY_EMAIL_EXISTS, không tạo/không audit', async () => {
    const h = build();
    h.users.emailExists.mockResolvedValue(true);

    const e = await rejection(h.api.createCustomerAccount(OWNER, INPUT, tx));

    expect(e.errorCode).toBe(IDENTITY_ERR.EMAIL_EXISTS);
    expect(e.httpStatus).toBe(409);
    expect(h.users.create).not.toHaveBeenCalled();
    expect(h.auditWrite).not.toHaveBeenCalled();
  });

  it('hai request cùng email lọt qua kiểm tra: chốt unique DB (P2002) cũng quy về 409 IDENTITY_EMAIL_EXISTS', async () => {
    const h = build();
    h.users.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    const e = await rejection(h.api.createCustomerAccount(OWNER, INPUT, tx));

    expect(e.errorCode).toBe(IDENTITY_ERR.EMAIL_EXISTS);
    expect(h.auditWrite).not.toHaveBeenCalled();
  });

  it('lỗi DB khác không bị che thành 409', async () => {
    const h = build();
    h.users.create.mockRejectedValue(new Error('db down'));

    await expect(h.api.createCustomerAccount(OWNER, INPUT, tx)).rejects.toThrow('db down');
  });

  it('chưa seed vai customer → 404 IDENTITY_ROLE_NOT_FOUND (không tạo user không vai)', async () => {
    const h = build();
    h.roles.findRoleByCode.mockResolvedValue(null);

    const e = await rejection(h.api.createCustomerAccount(OWNER, INPUT, tx));

    expect(e.errorCode).toBe(IDENTITY_ERR.ROLE_NOT_FOUND);
    expect(h.users.create).not.toHaveBeenCalled();
  });
});
