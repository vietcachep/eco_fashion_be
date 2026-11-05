import type { PrismaService } from '@common/prisma/prisma.service';
import type { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import type { ShopRepository } from '../shop/repository/shop.repository';
import { ShopQueryApi } from './shop.queryapi';

/*
 * memberUserIdsWithPermission (PLAN-0022 §7): báo đúng người xử lý được — thành viên ACTIVE có mã quyền, tính quyền hiệu lực ĐÚNG như ShopContextGuard
 * (chủ = đủ quyền của vai; nhân viên = quyền chủ đã giao, chưa giao thì preset của vai). Vai tra theo lô, không N+1 theo thành viên.
 */
describe('ShopQueryApi.memberUserIdsWithPermission', () => {
  const OWNER_ROLE = 'role-owner';
  const STAFF_ROLE = 'role-staff';
  const roles: Record<string, { code: string; permissionCodes: string[] }> = {
    [OWNER_ROLE]: { code: 'shop_owner', permissionCodes: ['shop.return.read', 'shop.return.process', 'shop.order.update'] },
    [STAFF_ROLE]: { code: 'shop_staff', permissionCodes: ['shop.return.read', 'shop.order.update'] },
  };

  function build(members: Array<{ userId: string; roleId: string; customPermissions: unknown }>) {
    const findMany = jest.fn((_args: unknown): Promise<typeof members> => Promise.resolve(members));
    const shopRoleContext = jest.fn((roleId: string) => Promise.resolve(roles[roleId] ?? null));
    const api = new ShopQueryApi({} as unknown as ShopRepository, { shopMember: { findMany } } as unknown as PrismaService, { shopRoleContext } as unknown as IdentityQueryApi);
    return { api, findMany, shopRoleContext };
  }

  it('chỉ thành viên ACTIVE của đúng shop; chủ luôn có quyền của vai; nhân viên theo preset hoặc quyền chủ đã giao', async () => {
    const { api, findMany } = build([
      { userId: 'owner', roleId: OWNER_ROLE, customPermissions: null },
      { userId: 'staff-preset', roleId: STAFF_ROLE, customPermissions: null }, // preset không có process
      { userId: 'staff-granted', roleId: STAFF_ROLE, customPermissions: ['shop.return.process'] },
      { userId: 'staff-other', roleId: STAFF_ROLE, customPermissions: ['shop.order.update'] },
    ]);
    expect(await api.memberUserIdsWithPermission('shop-1', 'shop.return.process')).toEqual(['owner', 'staff-granted']);
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { shopId: 'shop-1', status: 'active' } });
    expect(await api.memberUserIdsWithPermission('shop-1', 'shop.return.read')).toEqual(['owner', 'staff-preset']); // quyền riêng của staff-granted/staff-other không có read
  });

  it('quyền riêng chứa mã ngoài phạm vi giao được (quyền của chủ) bị bỏ qua', async () => {
    const { api } = build([{ userId: 'sneaky', roleId: STAFF_ROLE, customPermissions: ['shop.staff.remove', 'shop.wallet.read'] }]);
    expect(await api.memberUserIdsWithPermission('shop-1', 'shop.staff.remove')).toEqual([]);
  });

  it('vai tra theo lô: mỗi vai khác nhau một lần (không N+1); vai không tồn tại ⇒ thành viên đó bị bỏ; shop không có thành viên ⇒ []', async () => {
    const many = build([
      { userId: 'a', roleId: STAFF_ROLE, customPermissions: null },
      { userId: 'b', roleId: STAFF_ROLE, customPermissions: null },
      { userId: 'c', roleId: OWNER_ROLE, customPermissions: null },
      { userId: 'd', roleId: 'role-gone', customPermissions: null },
    ]);
    expect(await many.api.memberUserIdsWithPermission('shop-1', 'shop.order.update')).toEqual(['a', 'b', 'c']);
    expect(many.shopRoleContext).toHaveBeenCalledTimes(3);
    const none = build([]);
    expect(await none.api.memberUserIdsWithPermission('shop-1', 'shop.return.process')).toEqual([]);
    expect(none.shopRoleContext).not.toHaveBeenCalled();
  });
});

/*
 * bankAccountOf (PLAN-0040 5.2): payout đọc TK + mốc bắt đầu đếm giờ giữ + cờ "chờ xác minh". Mốc = lần đổi gần nhất (nhật ký SHOP_BANK_UPDATED), hoặc mốc XÁC MINH
 * của quản lý sàn nếu có (bankVerifiedAt bị xoá mỗi lần đổi TK nên còn giá trị ⇒ chắc chắn sau lần đổi gần nhất).
 */
describe('ShopQueryApi.bankAccountOf', () => {
  const CHANGED = new Date('2026-10-20T01:00:00.000Z');
  const VERIFIED = new Date('2026-10-22T09:30:00.000Z');
  const row = (over: Record<string, unknown> = {}) => ({ id: 'shop-1', bankCode: '970422', bankAccountNumber: '99887766', bankAccountName: 'NGUYEN VAN A', bankStatus: 'verified', bankVerifiedAt: null, ...over });

  function build(shop: Record<string, unknown> | null, lastChange: Date | null) {
    const findById = jest.fn((_id: string) => Promise.resolve(shop));
    const findFirst = jest.fn((_args: unknown) => Promise.resolve(lastChange ? { createdAt: lastChange } : null));
    return new ShopQueryApi({ findById } as unknown as ShopRepository, { shopAuditLog: { findFirst } } as unknown as PrismaService, {} as unknown as IdentityQueryApi);
  }

  it('TK tên khớp (verified) ⇒ changedAt = lần đổi gần nhất theo nhật ký, không chờ xác minh', async () => {
    const bank = await build(row(), CHANGED).bankAccountOf('shop-1');

    expect(bank).toEqual({ bankCode: '970422', accountNumber: '99887766', accountName: 'NGUYEN VAN A', changedAt: CHANGED, pendingVerification: false });
  });

  it('TK chờ xác minh (tên lệch, chưa xác minh) ⇒ pendingVerification=true, changedAt vẫn là lần đổi', async () => {
    const bank = await build(row({ bankStatus: 'pending_verification' }), CHANGED).bankAccountOf('shop-1');

    expect(bank).toMatchObject({ pendingVerification: true, changedAt: CHANGED });
  });

  it('[STL-11e] quản lý đã xác minh ⇒ pendingVerification=false và changedAt = MỐC XÁC MINH (giờ giữ đếm từ lúc xác minh, không từ lúc đổi TK)', async () => {
    const bank = await build(row({ bankStatus: 'verified', bankVerifiedAt: VERIFIED }), CHANGED).bankAccountOf('shop-1');

    expect(bank).toMatchObject({ pendingVerification: false, changedAt: VERIFIED });
  });

  it('chưa từng đổi sau khi khai (không có nhật ký, chưa xác minh) ⇒ changedAt null', async () => {
    const bank = await build(row(), null).bankAccountOf('shop-1');

    expect(bank).toMatchObject({ changedAt: null, pendingVerification: false });
  });

  it('thiếu thông tin TK hoặc không có shop ⇒ null', async () => {
    expect(await build(row({ bankAccountNumber: null }), null).bankAccountOf('shop-1')).toBeNull();
    expect(await build(null, null).bankAccountOf('shop-x')).toBeNull();
  });
});
