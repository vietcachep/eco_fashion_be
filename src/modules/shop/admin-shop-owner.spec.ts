import { Logger } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { IdentityQueryApi, UserBrief } from '@modules/identity/queryapi/identity.queryapi';
import type { ShopAuditLogService } from './audit/shop-audit-log.service';
import type { ShopOutboxService } from './outbox/shop-outbox.service';
import type { ShopRegistrationService } from './registration/service/shop-registration.service';
import { toShopResponse } from './shop/mapper/shop.mapper';
import type { ShopRepository, ShopRow } from './shop/repository/shop.repository';
import { ShopService } from './shop/service/shop.service';

/*
 * AdminShopResponse thiếu tên/email chủ shop (PLAN-0017 §12): response của NHÂN VIÊN SÀN (list, chi tiết, approve/suspend/reject/commission)
 * phải kèm ownerName/ownerEmail, tra THEO LÔ qua IdentityQueryApi (đúng 1 lần cho cả trang — không N+1); response VENDOR không có hai trường này.
 */

const actor: AuthenticatedActor = { userId: 'staff-1', email: 'staff@fitly.vn', roleCode: 'admin', permissionVersion: 1, tokenId: 'jti-1' };

function shopRow(id: string, ownerUserId: string, overrides: Partial<ShopRow> = {}): ShopRow {
  return {
    id,
    code: `SHOP-${id}`,
    slug: `shop-${id}`,
    name: `Shop ${id}`,
    logoUrl: null,
    bannerUrl: null,
    description: null,
    status: 'pending',
    commissionRate: new Prisma.Decimal('10.00'),
    bankCode: '970436',
    bankAccountNumber: '123456789012',
    bankAccountName: 'NGUYEN VAN A',
    ratingAvg: null,
    totalProducts: 0,
    ownerUserId,
    version: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function userBrief(id: string, fullName: string, email: string): UserBrief {
  return { id, email, fullName, phone: null, roleCode: 'customer', status: 'active', emailVerified: true };
}

function build(opts: { shops: ShopRow[]; users: UserBrief[] }) {
  const shops = new Map(opts.shops.map((s) => [s.id, s]));
  const users = new Map(opts.users.map((u) => [u.id, u]));

  const repo = {
    list: jest.fn((_filter: unknown, _skip: number, _take: number) => Promise.resolve({ items: [...shops.values()], total: shops.size })),
    findById: jest.fn((id: string) => Promise.resolve(shops.get(id) ?? null)),
    findByIdForUpdate: jest.fn((id: string, _tx: unknown) => Promise.resolve(shops.get(id) ?? null)),
    update: jest.fn((id: string, data: Record<string, unknown>, _tx: unknown) => {
      const next = { ...(shops.get(id) as ShopRow), ...(data as Partial<ShopRow>) };
      shops.set(id, next);
      return Promise.resolve(next);
    }),
  };
  const identity = {
    findUserBriefs: jest.fn((ids: string[]) => Promise.resolve(new Map(ids.filter((i) => users.has(i)).map((i) => [i, users.get(i) as UserBrief])))),
  };
  const audit = { write: jest.fn(() => Promise.resolve()) };
  const outbox = { publish: jest.fn(() => Promise.resolve()) };
  const prisma = { $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) };

  // Shop seed/admin tạo không có hồ sơ đăng ký (PLAN-0019): prepareStatusChange trả null ⇒ changeStatus giữ hành vi cũ.
  const registrations = { prepareStatusChange: () => Promise.resolve(null), recordDecision: () => Promise.resolve() };
  const service = new ShopService(prisma as unknown as PrismaService, repo as unknown as ShopRepository, audit as unknown as ShopAuditLogService, outbox as unknown as ShopOutboxService, identity as unknown as IdentityQueryApi, registrations as unknown as ShopRegistrationService);
  return { service, repo, identity };
}

describe('ShopService — tên/email chủ shop cho nhân viên sàn', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const users = [userBrief('u-1', 'Nguyễn Văn A', 'a@fitly.vn'), userBrief('u-2', 'Trần Thị B', 'b@fitly.vn')];

  describe('listAdmin', () => {
    it('nhiều shop ⇒ đúng MỘT lần tra lô cho cả trang, mỗi dòng có ownerName/ownerEmail của chủ mình', async () => {
      const f = build({ shops: [shopRow('s1', 'u-1'), shopRow('s2', 'u-2'), shopRow('s3', 'u-1')], users });

      const page = await f.service.listAdmin({}, 1, 20);

      expect(f.identity.findUserBriefs).toHaveBeenCalledTimes(1);
      expect(new Set(f.identity.findUserBriefs.mock.calls[0][0])).toEqual(new Set(['u-1', 'u-2']));
      expect(page.content.map((s) => [s.code, s.ownerName, s.ownerEmail])).toEqual([
        ['SHOP-s1', 'Nguyễn Văn A', 'a@fitly.vn'],
        ['SHOP-s2', 'Trần Thị B', 'b@fitly.vn'],
        ['SHOP-s3', 'Nguyễn Văn A', 'a@fitly.vn'],
      ]);
      expect(page.totalElements).toBe(3);
    });

    it('shop mồ côi (user chủ đã bị xoá) ⇒ ownerName/ownerEmail null, không lỗi, các shop khác vẫn đủ', async () => {
      const f = build({ shops: [shopRow('s1', 'u-gone'), shopRow('s2', 'u-2')], users });

      const page = await f.service.listAdmin({}, 1, 20);

      const byCode = Object.fromEntries(page.content.map((s) => [s.code, s]));
      expect(byCode['SHOP-s1']).toMatchObject({ ownerUserId: 'u-gone', ownerName: null, ownerEmail: null });
      expect(byCode['SHOP-s2']).toMatchObject({ ownerName: 'Trần Thị B', ownerEmail: 'b@fitly.vn' });
      expect(f.identity.findUserBriefs).toHaveBeenCalledTimes(1);
    });

    it('trang rỗng ⇒ không tra identity', async () => {
      const f = build({ shops: [], users });

      const page = await f.service.listAdmin({}, 1, 20);

      expect(page.content).toEqual([]);
      expect(f.identity.findUserBriefs).not.toHaveBeenCalled();
    });

    it('danh sách KHÔNG lộ số tài khoản đầy đủ (chỉ chi tiết mới có bankAccountNumber)', async () => {
      const f = build({ shops: [shopRow('s1', 'u-1')], users });

      const [item] = (await f.service.listAdmin({}, 1, 20)).content;

      expect(item).not.toHaveProperty('bankAccountNumber');
      expect(item.bankAccountNumberMasked).toBe('••••••••9012');
    });
  });

  describe('getAdminDetail', () => {
    it('có ownerName/ownerEmail + full số tài khoản, một lần tra', async () => {
      const f = build({ shops: [shopRow('s1', 'u-1')], users });

      const r = await f.service.getAdminDetail('s1');

      expect(r).toMatchObject({ ownerName: 'Nguyễn Văn A', ownerEmail: 'a@fitly.vn', bankAccountNumber: '123456789012' });
      expect(f.identity.findUserBriefs).toHaveBeenCalledTimes(1);
    });

    it('shop mồ côi ⇒ trường chủ null, vẫn trả chi tiết', async () => {
      const f = build({ shops: [shopRow('s1', 'u-gone')], users });

      await expect(f.service.getAdminDetail('s1')).resolves.toMatchObject({ code: 'SHOP-s1', ownerName: null, ownerEmail: null });
    });

    it('không có shop ⇒ NotFound, không tra identity', async () => {
      const f = build({ shops: [], users });

      await expect(f.service.getAdminDetail('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(f.identity.findUserBriefs).not.toHaveBeenCalled();
    });
  });

  describe('thao tác của sàn trả cùng DTO có chủ shop', () => {
    it.each([
      ['approved', 'approve'],
      ['rejected', 'reject'],
    ])('changeStatus → %s (%s) kèm ownerName/ownerEmail', async (target) => {
      const f = build({ shops: [shopRow('s1', 'u-1')], users });

      const r = await f.service.changeStatus(actor, 's1', target, target === 'rejected' ? 'Hồ sơ không hợp lệ' : null);

      expect(r).toMatchObject({ status: target, ownerName: 'Nguyễn Văn A', ownerEmail: 'a@fitly.vn' });
      expect(f.identity.findUserBriefs).toHaveBeenCalledTimes(1);
    });

    it('suspend (approved → suspended) kèm chủ shop; chủ mồ côi ⇒ null, thao tác vẫn thành công', async () => {
      const f = build({ shops: [shopRow('s1', 'u-gone', { status: 'approved' })], users });

      const r = await f.service.changeStatus(actor, 's1', 'suspended', 'Bán hàng giả');

      expect(r).toMatchObject({ status: 'suspended', ownerName: null, ownerEmail: null });
      expect(f.repo.update).toHaveBeenCalledTimes(1);
    });

    it('updateCommission kèm ownerName/ownerEmail', async () => {
      const f = build({ shops: [shopRow('s1', 'u-2')], users });

      const r = await f.service.updateCommission(actor, 's1', 8.5);

      expect(r).toMatchObject({ commissionRate: '8.50', ownerName: 'Trần Thị B', ownerEmail: 'b@fitly.vn' });
      expect(f.identity.findUserBriefs).toHaveBeenCalledTimes(1);
    });

    it('chuyển trạng thái KHÔNG hợp lệ ⇒ lỗi trước khi tra chủ shop', async () => {
      const f = build({ shops: [shopRow('s1', 'u-1', { status: 'rejected' })], users });

      await expect(f.service.changeStatus(actor, 's1', 'approved', null)).rejects.toMatchObject({ errorCode: 'SHOP_INVALID_TRANSITION' });
      expect(f.identity.findUserBriefs).not.toHaveBeenCalled();
    });
  });

  describe('vendor', () => {
    it('GET /shop/me (getMe) + toShopResponse KHÔNG có ownerName/ownerEmail (chỉ ownerUserId như cũ)', async () => {
      const f = build({ shops: [shopRow('s1', 'u-1')], users });

      const me = await f.service.getMe('s1');

      for (const r of [me, toShopResponse(shopRow('s1', 'u-1'))]) {
        expect(r).not.toHaveProperty('ownerName');
        expect(r).not.toHaveProperty('ownerEmail');
        expect(r).not.toHaveProperty('bankAccountNumber');
        expect(r.ownerUserId).toBe('u-1');
      }
      expect(f.identity.findUserBriefs).not.toHaveBeenCalled();
    });
  });
});
