import { Logger } from '@nestjs/common';
import { BusinessException, ConflictException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { IdentityApplicationApi } from '@modules/identity/applicationapi/identity.applicationapi';
import type { IdentityQueryApi, UserBrief } from '@modules/identity/queryapi/identity.queryapi';
import type { ShopAuditLogService } from '../audit/shop-audit-log.service';
import { RATE_LIMIT_KEY } from '@common/security/rate-limit.guard';
import { SHOP_AUDIT, SHOP_ERR, SHOP_EVENT, SHOP_MEMBER_MAX_ACTIVE } from '../foundation/shop.constants';
import { SHOP_PERMISSIONS_KEY } from '../security/shop-permission.decorator';
import { ShopMemberController } from './controller/shop-member.controller';
import type { ShopOutboxService } from '../outbox/shop-outbox.service';
import { toShopMemberResponse } from './mapper/shop-member.mapper';
import type { ShopMemberRepository, ShopMemberRow } from './repository/shop-member.repository';
import { ShopMemberService } from './service/shop-member.service';

/*
 * Nhân viên gian hàng — các sửa lỗi bảo mật M-3: response không lộ userId, chủ cuối cùng được bảo vệ BẰNG KHOÁ (mô phỏng hai chủ hạ nhau
 * đồng thời), tự rời shop, và chủ shop THÊM nhân viên (tạo tài khoản + gắn shop trong một transaction, trần thành viên).
 */

const SHOP = 'shop-1';
const OWNER_ROLE = { id: 'role-owner', code: 'shop_owner', name: 'Chủ gian hàng' };
const STAFF_ROLE = { id: 'role-staff', code: 'shop_staff', name: 'Nhân viên' };
const NOW = new Date('2026-05-01T08:00:00.000Z');

function actorOf(userId: string): AuthenticatedActor {
  return { userId, email: `${userId}@shop.vn`, roleCode: 'customer', permissionVersion: 1, tokenId: `jti-${userId}` };
}

function memberRow(overrides: Partial<ShopMemberRow> = {}): ShopMemberRow {
  return { id: 'm-1', shopId: SHOP, userId: 'USER-ID-BI-MAT', roleId: STAFF_ROLE.id, status: 'active', customPermissions: null, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function userBrief(overrides: Partial<UserBrief> = {}): UserBrief {
  return { id: 'u-invitee', email: 'nhanvien@gmail.com', fullName: 'Lê Nhân Viên', phone: null, roleCode: 'customer', status: 'active', emailVerified: true, ...overrides };
}

async function rejection(p: Promise<unknown>): Promise<BusinessException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessException) return e;
    throw e;
  }
  throw new Error('Kỳ vọng ném BusinessException nhưng thao tác lại thành công');
}

const tx = { marker: 'tx' } as unknown as Tx;

// Service ghi log mốc nghiệp vụ (leave) bằng Nest Logger — im lặng trong test cho gọn.
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => {
  jest.restoreAllMocks();
});

function build() {
  const repo = {
    listOfShop: jest.fn<Promise<{ items: ShopMemberRow[]; total: number }>, Parameters<ShopMemberRepository['listOfShop']>>(),
    findByIdInShop: jest.fn<Promise<ShopMemberRow | null>, Parameters<ShopMemberRepository['findByIdInShop']>>(),
    update: jest.fn<Promise<ShopMemberRow>, Parameters<ShopMemberRepository['update']>>(),
    countActiveByRole: jest.fn<Promise<number>, Parameters<ShopMemberRepository['countActiveByRole']>>(),
    lockActiveByRole: jest.fn<Promise<string[]>, Parameters<ShopMemberRepository['lockActiveByRole']>>(),
    lockShopMembers: jest.fn<Promise<void>, Parameters<ShopMemberRepository['lockShopMembers']>>(),
    countActive: jest.fn<Promise<number>, Parameters<ShopMemberRepository['countActive']>>(),
    create: jest.fn<Promise<ShopMemberRow>, Parameters<ShopMemberRepository['create']>>(),
    findAnyByShopAndUser: jest.fn<Promise<ShopMemberRow | null>, Parameters<ShopMemberRepository['findAnyByShopAndUser']>>(),
    findActiveByUserId: jest.fn<Promise<ShopMemberRow | null>, Parameters<ShopMemberRepository['findActiveByUserId']>>(),
  };
  const accounts = {
    hashPassword: jest.fn<Promise<string>, [string]>(),
    createCustomerAccount: jest.fn<ReturnType<IdentityApplicationApi['createCustomerAccount']>, Parameters<IdentityApplicationApi['createCustomerAccount']>>(),
  };
  const identity = {
    findShopRoleByCode: jest.fn<Promise<{ id: string; code: string; name: string } | null>, [string]>(),
    findUserBrief: jest.fn<Promise<UserBrief | null>, [string]>(),
    findUserBriefByEmail: jest.fn<Promise<UserBrief | null>, [string]>(),
    findUserBriefs: jest.fn<Promise<Map<string, UserBrief>>, [string[]]>(),
    findRoleBriefs: jest.fn<Promise<Map<string, { code: string; name: string }>>, [string[]]>(),
    shopRoleContext: jest.fn<Promise<{ code: string; name: string; permissionCodes: string[] } | null>, [string]>(() => Promise.resolve({ code: 'shop_staff', name: 'Nhân viên', permissionCodes: ['shop.product.read'] })),
  };
  const auditWrite = jest.fn<Promise<void>, Parameters<ShopAuditLogService['write']>>();
  const publish = jest.fn<Promise<void>, Parameters<ShopOutboxService['publish']>>();

  repo.update.mockImplementation((id, data) => Promise.resolve(memberRow({ id, ...(data as unknown as Partial<ShopMemberRow>) })));
  repo.lockActiveByRole.mockResolvedValue([]);
  repo.lockShopMembers.mockResolvedValue(undefined);
  repo.countActive.mockResolvedValue(1);
  repo.findAnyByShopAndUser.mockResolvedValue(null);
  repo.findActiveByUserId.mockResolvedValue(null);
  identity.findUserBriefByEmail.mockResolvedValue(null);
  repo.create.mockImplementation((data) => Promise.resolve(memberRow({ id: 'm-new', ...(data as unknown as Partial<ShopMemberRow>) })));
  accounts.hashPassword.mockResolvedValue('HASH');
  accounts.createCustomerAccount.mockResolvedValue({ userId: 'u-new', email: 'moi@gmail.com', fullName: 'Nhân Viên Mới' });
  identity.findShopRoleByCode.mockImplementation((code) => Promise.resolve(code === 'shop_owner' ? OWNER_ROLE : code === 'shop_staff' ? STAFF_ROLE : null));
  auditWrite.mockResolvedValue(undefined);
  publish.mockResolvedValue(undefined);

  const prisma = { $transaction: (fn: (t: Tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
  const service = new ShopMemberService(prisma, repo as unknown as ShopMemberRepository, identity as unknown as IdentityQueryApi, accounts as unknown as IdentityApplicationApi, { write: auditWrite } as unknown as ShopAuditLogService, { publish } as unknown as ShopOutboxService);
  return { service, repo, identity, accounts, auditWrite, publish };
}

describe('response không lộ userId (M-3b)', () => {
  it('toShopMemberResponse: bỏ userId, isSelf tính theo người gọi', () => {
    const row = memberRow({ userId: 'USER-ID-BI-MAT' });
    const user = userBrief({ id: 'USER-ID-BI-MAT' });

    const other = toShopMemberResponse(row, user, STAFF_ROLE, 'nguoi-khac');
    const self = toShopMemberResponse(row, user, STAFF_ROLE, 'USER-ID-BI-MAT');

    expect(other).not.toHaveProperty('userId');
    expect(JSON.stringify(other)).not.toContain('USER-ID-BI-MAT');
    expect(other.isSelf).toBe(false);
    expect(self.isSelf).toBe(true);
    expect(Object.keys(other).sort()).toEqual(['createdAt', 'customPermissions', 'email', 'fullName', 'id', 'isSelf', 'permissionCodes', 'roleCode', 'roleId', 'roleName', 'status', 'updatedAt']);
  });

  it('list: không dòng nào có userId; chỉ dòng của chính người gọi có isSelf=true', async () => {
    const h = build();
    h.repo.listOfShop.mockResolvedValue({ items: [memberRow({ id: 'm-1', userId: 'u-me' }), memberRow({ id: 'm-2', userId: 'u-other' })], total: 2 });
    h.identity.findUserBriefs.mockResolvedValue(new Map([['u-me', userBrief({ id: 'u-me' })], ['u-other', userBrief({ id: 'u-other', email: 'b@gmail.com' })]]));
    h.identity.findRoleBriefs.mockResolvedValue(new Map([[STAFF_ROLE.id, { code: STAFF_ROLE.code, name: STAFF_ROLE.name }]]));

    const page = await h.service.list(actorOf('u-me'), SHOP, 1, 10);

    expect(page.content.map((m) => m.isSelf)).toEqual([true, false]);
    const json = JSON.stringify(page);
    expect(json).not.toContain('u-me');
    expect(json).not.toContain('u-other');
    for (const m of page.content) expect(m).not.toHaveProperty('userId');
  });

  it('updateRole: response cũng không có userId', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValue(memberRow({ id: 'm-1', userId: 'u-staff', roleId: STAFF_ROLE.id }));
    h.identity.findUserBrief.mockResolvedValue(userBrief({ id: 'u-staff' }));

    const r = await h.service.updateRole(actorOf('owner-user'), SHOP, 'm-1', 'shop_owner');

    expect(r).not.toHaveProperty('userId');
    expect(r.roleCode).toBe('shop_owner');
  });
});

describe('chủ cuối cùng — khoá FOR UPDATE rồi mới đếm (M-3d)', () => {
  const actor = actorOf('owner-user');

  it('đổi vai chủ DUY NHẤT thành nhân viên → 409 SHOP_LAST_OWNER; khoá chạy TRƯỚC đếm; không ghi', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValue(memberRow({ id: 'm-owner', roleId: OWNER_ROLE.id }));
    h.repo.countActiveByRole.mockResolvedValue(1);

    const e = await rejection(h.service.updateRole(actor, SHOP, 'm-owner', 'shop_staff'));

    expect(e.errorCode).toBe(SHOP_ERR.LAST_OWNER);
    expect(e.httpStatus).toBe(409);
    expect(h.repo.lockActiveByRole).toHaveBeenCalledWith(SHOP, OWNER_ROLE.id, tx);
    expect(h.repo.lockActiveByRole.mock.invocationCallOrder[0]).toBeLessThan(h.repo.countActiveByRole.mock.invocationCallOrder[0]);
    expect(h.repo.lockActiveByRole.mock.invocationCallOrder[0]).toBeLessThan(h.repo.findByIdInShop.mock.invocationCallOrder[0]);
    expect(h.repo.update).not.toHaveBeenCalled();
    expect(h.auditWrite).not.toHaveBeenCalled();
  });

  it('còn chủ khác → đổi vai được; giữ vai chủ hoặc đổi người không phải chủ → không cần đếm', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValue(memberRow({ id: 'm-owner', roleId: OWNER_ROLE.id }));
    h.repo.countActiveByRole.mockResolvedValue(2);
    await h.service.updateRole(actor, SHOP, 'm-owner', 'shop_staff');
    expect(h.repo.update).toHaveBeenCalledTimes(1);

    h.repo.countActiveByRole.mockClear();
    await h.service.updateRole(actor, SHOP, 'm-owner', 'shop_owner');
    h.repo.findByIdInShop.mockResolvedValue(memberRow({ id: 'm-staff', roleId: STAFF_ROLE.id }));
    await h.service.updateRole(actor, SHOP, 'm-staff', 'shop_owner');
    expect(h.repo.countActiveByRole).not.toHaveBeenCalled();
  });

  it('gỡ chủ DUY NHẤT → 409 SHOP_LAST_OWNER; gỡ khi còn chủ khác → removed + audit', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValue(memberRow({ id: 'm-owner', roleId: OWNER_ROLE.id }));
    h.repo.countActiveByRole.mockResolvedValueOnce(1);

    const e = await rejection(h.service.remove(actor, SHOP, 'm-owner'));
    expect(e.errorCode).toBe(SHOP_ERR.LAST_OWNER);
    expect(h.repo.update).not.toHaveBeenCalled();

    h.repo.countActiveByRole.mockResolvedValueOnce(2);
    await h.service.remove(actor, SHOP, 'm-owner');
    expect(h.repo.update).toHaveBeenCalledWith('m-owner', expect.objectContaining({ status: 'removed' }), tx);
    expect(h.auditWrite.mock.calls[0][2]).toMatchObject({ action: SHOP_AUDIT.MEMBER_REMOVED, entityId: 'm-owner' });
  });

  it('thành viên không thuộc shop / đã gỡ → 404, không ghi', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValueOnce(null);
    expect((await rejection(h.service.remove(actor, SHOP, 'm-x'))).errorCode).toBe(SHOP_ERR.MEMBER_NOT_FOUND);

    h.repo.findByIdInShop.mockResolvedValueOnce(memberRow({ status: 'removed' }));
    expect((await rejection(h.service.updateRole(actor, SHOP, 'm-1', 'shop_staff'))).errorCode).toBe(SHOP_ERR.MEMBER_NOT_FOUND);
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  /*
   * Mô phỏng DB với khoá hàng: lockActiveByRole nhường cho transaction giữ khoá trước (hàng đợi), nhả khi transaction kết thúc;
   * đọc/đếm/ghi chạy trên cùng một kho dữ liệu. Hai chủ A và B HẠ NHAU cùng lúc: nếu chỉ "check rồi update" không khoá thì cả hai
   * đều thấy còn 2 chủ → shop về 0 chủ. Có khoá thì người đến sau đếm lại, thấy chỉ còn một → bị chặn.
   */
  describe('hai chủ hạ/gỡ nhau ĐỒNG THỜI', () => {
    interface FakeTx {
      held: boolean;
      release: () => void;
    }

    function buildConcurrent() {
      const members = new Map<string, ShopMemberRow>([
        ['mA', memberRow({ id: 'mA', userId: 'uA', roleId: OWNER_ROLE.id })],
        ['mB', memberRow({ id: 'mB', userId: 'uB', roleId: OWNER_ROLE.id })],
      ]);
      let holder: Promise<void> = Promise.resolve();
      const activeOwners = () => [...members.values()].filter((m) => m.roleId === OWNER_ROLE.id && m.status === 'active').length;

      const repo = {
        lockActiveByRole: async (_shopId: string, _roleId: string, t: FakeTx): Promise<string[]> => {
          if (!t.held) {
            const previous = holder;
            holder = new Promise<void>((resolve) => {
              t.release = resolve;
            });
            t.held = true;
            await previous;
          }
          return [];
        },
        // Mỗi truy vấn sau khoá đều nhường một nhịp để lộ lỗi xen kẽ nếu thiếu khoá.
        findByIdInShop: async (id: string): Promise<ShopMemberRow | null> => {
          await Promise.resolve();
          return members.get(id) ?? null;
        },
        countActiveByRole: async (): Promise<number> => {
          await Promise.resolve();
          return activeOwners();
        },
        update: async (id: string, data: Partial<ShopMemberRow>): Promise<ShopMemberRow> => {
          await Promise.resolve();
          const next = { ...(members.get(id) as ShopMemberRow), ...data };
          members.set(id, next);
          return next;
        },
      };
      const identity = {
        findShopRoleByCode: (code: string) => Promise.resolve(code === 'shop_owner' ? OWNER_ROLE : STAFF_ROLE),
        findUserBrief: () => Promise.resolve(userBrief()),
        shopRoleContext: () => Promise.resolve({ code: 'shop_staff', name: 'Nhân viên', permissionCodes: [] as string[] }),
      };
      const prisma = {
        $transaction: async (fn: (t: FakeTx) => Promise<unknown>) => {
          const t: FakeTx = { held: false, release: () => undefined };
          try {
            return await fn(t);
          } finally {
            t.release();
          }
        },
      } as unknown as PrismaService;
      const service = new ShopMemberService(prisma, repo as unknown as ShopMemberRepository, identity as unknown as IdentityQueryApi, {} as unknown as IdentityApplicationApi, { write: () => Promise.resolve() } as unknown as ShopAuditLogService, { publish: () => Promise.resolve() } as unknown as ShopOutboxService);
      return { service, activeOwners, members };
    }

    it('A hạ B và B hạ A cùng lúc: đúng MỘT thành công, một bị SHOP_LAST_OWNER, shop còn 1 chủ', async () => {
      const { service, activeOwners } = buildConcurrent();

      const results = await Promise.allSettled([service.updateRole(actorOf('uA'), SHOP, 'mB', 'shop_staff'), service.updateRole(actorOf('uB'), SHOP, 'mA', 'shop_staff')]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0].reason as BusinessException).errorCode).toBe(SHOP_ERR.LAST_OWNER);
      expect(activeOwners()).toBe(1);
    });

    it('A gỡ B và B gỡ A cùng lúc: shop không bao giờ về 0 chủ', async () => {
      const { service, activeOwners } = buildConcurrent();

      const results = await Promise.allSettled([service.remove(actorOf('uA'), SHOP, 'mB'), service.remove(actorOf('uB'), SHOP, 'mA')]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(activeOwners()).toBe(1);
    });

    it('A tự rời và B tự rời cùng lúc: chỉ một người rời được', async () => {
      const { service, activeOwners } = buildConcurrent();

      const results = await Promise.allSettled([service.leave(actorOf('uA'), SHOP, 'mA'), service.leave(actorOf('uB'), SHOP, 'mB')]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(activeOwners()).toBe(1);
    });
  });
});

describe('ShopMemberService.leave — tự rời gian hàng (M-3e)', () => {
  const me = actorOf('u-me');

  it('nhân viên tự rời: status=removed + audit SHOP_MEMBER_LEFT + outbox SHOP_MEMBER_LEFT (cùng transaction)', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValue(memberRow({ id: 'm-me', userId: 'u-me', roleId: STAFF_ROLE.id }));

    await h.service.leave(me, SHOP, 'm-me');

    expect(h.repo.update).toHaveBeenCalledWith('m-me', expect.objectContaining({ status: 'removed', updatedBy: 'u-me' }), tx);
    expect(h.auditWrite).toHaveBeenCalledWith(tx, me, expect.objectContaining({ action: SHOP_AUDIT.MEMBER_LEFT, entityType: 'shop_member', entityId: 'm-me' }));
    expect(h.publish.mock.calls[0][0]).toBe(tx);
    expect(h.publish.mock.calls[0][1]).toMatchObject({ eventType: SHOP_EVENT.MEMBER_LEFT, aggregateType: 'shop', aggregateId: SHOP, payload: { shopId: SHOP, memberId: 'm-me', wasOwner: false } });
    expect(h.repo.countActiveByRole).not.toHaveBeenCalled();
  });

  it('chủ cuối cùng KHÔNG rời được → 409 SHOP_LAST_OWNER, không ghi gì', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValue(memberRow({ id: 'm-me', userId: 'u-me', roleId: OWNER_ROLE.id }));
    h.repo.countActiveByRole.mockResolvedValue(1);

    const e = await rejection(h.service.leave(me, SHOP, 'm-me'));

    expect(e.errorCode).toBe(SHOP_ERR.LAST_OWNER);
    expect(e.httpStatus).toBe(409);
    expect(h.repo.lockActiveByRole.mock.invocationCallOrder[0]).toBeLessThan(h.repo.countActiveByRole.mock.invocationCallOrder[0]);
    expect(h.repo.update).not.toHaveBeenCalled();
    expect(h.auditWrite).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('chủ khi còn chủ khác → rời được, outbox đánh dấu wasOwner', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValue(memberRow({ id: 'm-me', userId: 'u-me', roleId: OWNER_ROLE.id }));
    h.repo.countActiveByRole.mockResolvedValue(2);

    await h.service.leave(me, SHOP, 'm-me');

    expect(h.repo.update).toHaveBeenCalledWith('m-me', expect.objectContaining({ status: 'removed' }), tx);
    expect(h.publish.mock.calls[0][1].payload).toMatchObject({ wasOwner: true });
  });

  it('thành viên không phải của người gọi → 404 (không bao giờ rời hộ người khác)', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValue(memberRow({ id: 'm-x', userId: 'u-khac' }));

    const e = await rejection(h.service.leave(me, SHOP, 'm-x'));

    expect(e.errorCode).toBe(SHOP_ERR.MEMBER_NOT_FOUND);
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('đã bị gỡ / không thuộc shop → 404', async () => {
    const h = build();
    h.repo.findByIdInShop.mockResolvedValueOnce(null);
    expect((await rejection(h.service.leave(me, SHOP, 'm-x'))).errorCode).toBe(SHOP_ERR.MEMBER_NOT_FOUND);

    h.repo.findByIdInShop.mockResolvedValueOnce(memberRow({ userId: 'u-me', status: 'removed' }));
    expect((await rejection(h.service.leave(me, SHOP, 'm-1'))).errorCode).toBe(SHOP_ERR.MEMBER_NOT_FOUND);
    expect(h.repo.update).not.toHaveBeenCalled();
  });
});

describe('add — chủ shop thêm nhân viên (tạo tài khoản + gắn shop)', () => {
  const input = { email: 'moi@gmail.com', fullName: 'Nhân Viên Mới', password: 'MatKhau123', roleCode: 'shop_staff' };

  it('hash mật khẩu → khoá shop → đếm → tạo tài khoản → tạo ShopMember active (cùng tx) → audit + outbox; response không có userId/mật khẩu', async () => {
    const h = build();
    h.identity.findUserBrief.mockResolvedValue(userBrief({ id: 'u-new', email: 'moi@gmail.com', fullName: 'Nhân Viên Mới' }));

    const r = await h.service.add(actorOf('owner-user'), SHOP, input);

    expect(h.accounts.hashPassword).toHaveBeenCalledWith('MatKhau123');
    expect(h.repo.lockShopMembers).toHaveBeenCalledWith(SHOP, tx);
    expect(h.accounts.createCustomerAccount).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-user' }), { email: 'moi@gmail.com', fullName: 'Nhân Viên Mới', passwordHash: 'HASH' }, tx);
    expect(h.repo.create).toHaveBeenCalledWith({ shopId: SHOP, userId: 'u-new', roleId: STAFF_ROLE.id, status: 'active', createdBy: 'owner-user', updatedBy: 'owner-user' }, tx);
    expect(h.auditWrite).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ action: SHOP_AUDIT.MEMBER_ADDED, entityType: 'shop_member', after: { roleCode: 'shop_staff', restored: false } }));
    expect(h.publish).toHaveBeenCalledWith(tx, expect.objectContaining({ eventType: SHOP_EVENT.MEMBER_JOINED, payload: { shopId: SHOP, memberId: 'm-new', roleId: STAFF_ROLE.id } }));
    expect(r).toMatchObject({ email: 'moi@gmail.com', fullName: 'Nhân Viên Mới', roleCode: 'shop_staff', status: 'active', isSelf: false, restored: false });
    expect(r).not.toHaveProperty('userId');
    expect(JSON.stringify(r)).not.toContain('MatKhau123');
    expect(JSON.stringify(h.auditWrite.mock.calls)).not.toContain('moi@gmail.com');
  });

  it('vai không thuộc catalog scope=shop (vd admin) → 400 SHOP_ROLE_INVALID, chưa băm mật khẩu/chưa tạo gì', async () => {
    const h = build();

    const e = await rejection(h.service.add(actorOf('owner-user'), SHOP, { ...input, roleCode: 'admin' }));

    expect(e.errorCode).toBe(SHOP_ERR.ROLE_INVALID);
    expect(h.accounts.hashPassword).not.toHaveBeenCalled();
    expect(h.accounts.createCustomerAccount).not.toHaveBeenCalled();
  });

  it('shop đủ SHOP_MEMBER_MAX_ACTIVE thành viên → 409 SHOP_MEMBER_LIMIT_REACHED, không tạo tài khoản', async () => {
    const h = build();
    h.repo.countActive.mockResolvedValue(SHOP_MEMBER_MAX_ACTIVE);

    const e = await rejection(h.service.add(actorOf('owner-user'), SHOP, input));

    expect(e).toBeInstanceOf(ConflictException);
    expect(e.errorCode).toBe(SHOP_ERR.MEMBER_LIMIT_REACHED);
    expect(h.accounts.createCustomerAccount).not.toHaveBeenCalled();
    expect(h.repo.create).not.toHaveBeenCalled();
  });

  it('email đã có tài khoản (identity ném 409) → lỗi nổi lên nguyên vẹn, KHÔNG tạo ShopMember/audit/outbox', async () => {
    const h = build();
    h.accounts.createCustomerAccount.mockRejectedValue(new ConflictException('IDENTITY_EMAIL_EXISTS', 'Email đã được dùng'));

    const e = await rejection(h.service.add(actorOf('owner-user'), SHOP, input));

    expect(e.errorCode).toBe('IDENTITY_EMAIL_EXISTS');
    expect(h.repo.create).not.toHaveBeenCalled();
    expect(h.auditWrite).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('mật khẩu yếu (identity ném 400) → dừng trước transaction: không khoá, không tạo gì', async () => {
    const h = build();
    h.accounts.hashPassword.mockRejectedValue(new BusinessException('IDENTITY_PASSWORD_WEAK', 'Mật khẩu 8–64 ký tự, gồm cả chữ và số'));

    const e = await rejection(h.service.add(actorOf('owner-user'), SHOP, { ...input, password: 'abcdefgh' }));

    expect(e.errorCode).toBe('IDENTITY_PASSWORD_WEAK');
    expect(h.repo.lockShopMembers).not.toHaveBeenCalled();
    expect(h.accounts.createCustomerAccount).not.toHaveBeenCalled();
  });

  it('thêm chủ (shop_owner) cũng được — vai lấy từ catalog, không nhận roleId trần', async () => {
    const h = build();
    h.identity.findUserBrief.mockResolvedValue(userBrief({ id: 'u-new' }));

    await h.service.add(actorOf('owner-user'), SHOP, { ...input, roleCode: 'shop_owner' });

    expect(h.repo.create).toHaveBeenCalledWith(expect.objectContaining({ roleId: OWNER_ROLE.id }), tx);
  });
});

describe('add — khôi phục nhân viên cũ (đã bị gỡ khỏi CHÍNH shop này)', () => {
  const input = { email: 'cu@gmail.com', fullName: 'Tên Không Dùng', password: 'MatKhauMoi123', roleCode: 'shop_staff' };
  const former = userBrief({ id: 'u-old', email: 'cu@gmail.com', fullName: 'Nhân Viên Cũ' });
  const removedRow = memberRow({ id: 'm-old', userId: 'u-old', roleId: OWNER_ROLE.id, status: 'removed' });

  it('tài khoản tồn tại + dòng ShopMember status=removed của shop này ⇒ kích hoạt lại với vai MỚI, KHÔNG tạo tài khoản/không đổi mật khẩu/hồ sơ, restored=true', async () => {
    const h = build();
    h.identity.findUserBriefByEmail.mockResolvedValue(former);
    h.identity.findUserBrief.mockResolvedValue(former);
    h.repo.findAnyByShopAndUser.mockResolvedValue(removedRow);

    const r = await h.service.add(actorOf('owner-user'), SHOP, input);

    expect(h.accounts.createCustomerAccount).not.toHaveBeenCalled();
    expect(h.repo.create).not.toHaveBeenCalled();
    expect(h.repo.update).toHaveBeenCalledWith('m-old', { status: 'active', roleId: STAFF_ROLE.id, updatedBy: 'owner-user' }, tx);
    expect(h.auditWrite).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ action: SHOP_AUDIT.MEMBER_ADDED, after: { status: 'active', roleCode: 'shop_staff', restored: true } }));
    expect(h.publish).toHaveBeenCalledWith(tx, expect.objectContaining({ eventType: SHOP_EVENT.MEMBER_JOINED }));
    expect(r).toMatchObject({ id: 'm-old', email: 'cu@gmail.com', fullName: 'Nhân Viên Cũ', roleCode: 'shop_staff', restored: true });
    expect(r).not.toHaveProperty('userId');
  });

  it('email có tài khoản nhưng CHƯA từng là thành viên shop này ⇒ rơi xuống tạo tài khoản (identity trả 409 trung tính) — không khôi phục, không dò được', async () => {
    const h = build();
    h.identity.findUserBriefByEmail.mockResolvedValue(former);
    h.repo.findAnyByShopAndUser.mockResolvedValue(null);
    h.accounts.createCustomerAccount.mockRejectedValue(new ConflictException('IDENTITY_EMAIL_EXISTS', 'Email đã được dùng'));

    const e = await rejection(h.service.add(actorOf('owner-user'), SHOP, input));

    expect(e.errorCode).toBe('IDENTITY_EMAIL_EXISTS');
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('dòng thành viên của shop này còn ACTIVE (email đang là nhân viên) ⇒ không khôi phục, cùng 409 IDENTITY_EMAIL_EXISTS', async () => {
    const h = build();
    h.identity.findUserBriefByEmail.mockResolvedValue(former);
    h.repo.findAnyByShopAndUser.mockResolvedValue(memberRow({ id: 'm-old', userId: 'u-old', status: 'active' }));
    h.accounts.createCustomerAccount.mockRejectedValue(new ConflictException('IDENTITY_EMAIL_EXISTS', 'Email đã được dùng'));

    const e = await rejection(h.service.add(actorOf('owner-user'), SHOP, input));

    expect(e.errorCode).toBe('IDENTITY_EMAIL_EXISTS');
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it.each([
    ['tài khoản đang đang là thành viên active của shop KHÁC', userBrief({ id: 'u-old' }), memberRow({ id: 'm-x', shopId: 'shop-khac', userId: 'u-old' })],
    ['tài khoản bị khoá', userBrief({ id: 'u-old', status: 'locked' }), null],
    ['tài khoản là nhân viên sàn', userBrief({ id: 'u-old', roleCode: 'sales' }), null],
  ])('%s ⇒ 409 SHOP_MEMBER_UNAVAILABLE (trung tính), không kích hoạt lại', async (_label, user, activeElsewhere) => {
    const h = build();
    h.identity.findUserBriefByEmail.mockResolvedValue(user);
    h.repo.findAnyByShopAndUser.mockResolvedValue(removedRow);
    h.repo.findActiveByUserId.mockResolvedValue(activeElsewhere);

    const e = await rejection(h.service.add(actorOf('owner-user'), SHOP, input));

    expect(e.errorCode).toBe(SHOP_ERR.MEMBER_UNAVAILABLE);
    expect(e.message).not.toMatch(/shop khác|khoá|nhân viên sàn/i);
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('đua với shop khác ở chốt unique của DB (P2002) ⇒ cùng 409 SHOP_MEMBER_UNAVAILABLE', async () => {
    const h = build();
    h.identity.findUserBriefByEmail.mockResolvedValue(former);
    h.repo.findAnyByShopAndUser.mockResolvedValue(removedRow);
    h.repo.update.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    const e = await rejection(h.service.add(actorOf('owner-user'), SHOP, input));

    expect(e.errorCode).toBe(SHOP_ERR.MEMBER_UNAVAILABLE);
  });
});

describe('POST /shop/members — metadata route', () => {
  const handler = Object.getOwnPropertyDescriptor(ShopMemberController.prototype, 'add')?.value as object;

  it('chỉ người có shop.staff.invite (preset chủ shop) thêm được nhân viên; ghi có rate-limit theo user', () => {
    expect(Reflect.getMetadata(SHOP_PERMISSIONS_KEY, handler)).toEqual(['shop.staff.invite']);
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toMatchObject({ name: 'shop-member-add', by: 'user' });
  });
});
