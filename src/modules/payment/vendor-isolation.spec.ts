import 'reflect-metadata';
import { type ExecutionContext, Logger, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, NotFoundException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { PERMISSIONS_KEY, type RequestWithActor } from '@common/security/decorators';
import { PermissionGuard } from '@common/security/permission.guard';
import type { OrderQueryApi } from '@modules/order/queryapi/order.queryapi';
import type { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { SHOP_PERMISSIONS_KEY, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import type { PaymentAuditLogService } from './audit/payment-audit-log.service';
import { PAYOUT_ERR } from './foundation/payment.constants';
import type { PaymentOutboxService } from './outbox/payment-outbox.service';
import type { PayosService } from './payos/payos.service';
import { ShopPayoutController } from './shop-payout/controller/shop-payout.controller';
import { PayoutListQuery } from './shop-payout/dto/shop-payout.dto';
import { ShopPayoutService } from './shop-payout/shop-payout.service';

/*
 * CÁCH LY CHÉO SHOP ở đối soát chi trả (phía vendor; PLAN-0018 đã bỏ ví quỹ COD). Vendor shop A KHÔNG được đọc kỳ đối soát của shop B —
 * `shopId` CHỈ đến từ `@CurrentShop()`; id shop B nằm trong path/query/body đều bị bỏ qua hoặc 404.
 * Controller + service + repository chạy THẬT; Prisma là DB giả trong bộ nhớ có hai shop và HỌ LỌC THEO `where` thật sự ⇒ service/repository mà quên
 * lọc `shopId` thì test đỏ ngay (kiểm chứng bằng cách bỏ bộ lọc).
 */

type Dec = Prisma.Decimal;
const D = (v: string | number): Dec => new Prisma.Decimal(v);

const SHOP_A = '11111111-1111-4111-8111-111111111111';
const SHOP_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const USER_STAFF = 'ffffffff-0000-4000-8000-0000000000ff';

const actorA: AuthenticatedActor = { userId: USER_A, email: 'owner-a@fitly.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-a' };
const shopA: ShopContext = { shopId: SHOP_A, shopCode: 'SA', shopName: 'Shop A', shopStatus: 'approved', memberId: 'm-a', roleId: 'r-owner', roleCode: 'shop_owner', roleName: 'Chủ shop', permissionCodes: ['shop.payout.read'] };

/* ------------------------------------------------------------------ DB giả: HAI shop A và B */

interface PayoutRow {
  id: string;
  code: string;
  shopId: string;
  periodStart: Date;
  periodEnd: Date;
  grossRevenue: Dec;
  commission: Dec;
  refundAmount: Dec;
  carriedDebt: Dec;
  netPayout: Dec;
  status: string;
  providerRef: string | null;
  failReason: string | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  bankSnapshot: unknown;
  lines: Array<{ id: string; orderCode: string; kind: string; gross: Dec; commission: Dec }>;
}

type Where = Record<string, unknown>;
/* Bộ lọc `where` kiểu Prisma: mọi khoá trong where phải bằng đúng giá trị (undefined = bỏ qua). Khoá lạ vẫn so bằng ⇒ lọc sai tên cột sẽ làm test đỏ. */
const matches = (row: object, where: Where): boolean => Object.entries(where).every(([k, v]) => v === undefined || (row as Record<string, unknown>)[k] === v);
const newestFirst = <T extends { createdAt: Date }>(rows: T[]): T[] => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

function buildDb() {
  const t = (n: number): Date => new Date(Date.UTC(2026, 9, 1, 0, 0, n));
  const state = {
    payouts: new Map<string, PayoutRow>(),
  };
  const payout = (id: string, shopId: string, status: string, lines: PayoutRow['lines'], failReason: string | null = null): PayoutRow => ({
    id,
    code: `PAY-${id}`,
    shopId,
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-09-30T00:00:00Z'),
    grossRevenue: D(1_000_000),
    commission: D(100_000),
    refundAmount: D(0),
    carriedDebt: D(0),
    netPayout: D(900_000),
    status,
    providerRef: null,
    failReason,
    paidAt: null,
    createdAt: t(shopId === SHOP_A ? 1 : 2),
    updatedAt: t(shopId === SHOP_A ? 1 : 2),
    bankSnapshot: { bankCode: '970436', accountNumber: shopId === SHOP_A ? '1111222233' : '9999888877', accountName: 'CHU SHOP' },
    lines,
  });
  state.payouts.set('payout-a1', payout('payout-a1', SHOP_A, 'paid', [{ id: 'line-a1', orderCode: 'DH-A-9', kind: 'sale', gross: D(1_000_000), commission: D(100_000) }]));
  state.payouts.set('payout-b1', payout('payout-b1', SHOP_B, 'failed', [{ id: 'line-b1', orderCode: 'DH-B-9', kind: 'sale', gross: D(1_000_000), commission: D(100_000) }, { id: 'line-b2', orderCode: 'DH-B-10', kind: 'sale', gross: D(500_000), commission: D(50_000) }], 'PayOS 231: Số dư tài khoản chi không đủ'));

  const calls: string[] = [];
  const db = {
    shopPayout: {
      findFirst: jest.fn(({ where }: { where: Where }) => {
        calls.push(`payout.findFirst:${JSON.stringify(where)}`);
        return Promise.resolve([...state.payouts.values()].find((p) => matches(p, where)) ?? null);
      }),
      findMany: jest.fn(({ where, skip, take }: { where: Where; skip: number; take: number }) => {
        calls.push(`payout.findMany:${JSON.stringify(where)}`);
        return Promise.resolve(newestFirst([...state.payouts.values()].filter((p) => matches(p, where))).slice(skip, skip + take));
      }),
      count: jest.fn(({ where }: { where: Where }) => Promise.resolve([...state.payouts.values()].filter((p) => matches(p, where)).length)),
    },
  };
  /* Ảnh chụp dữ liệu CỦA SHOP B — để khẳng định thao tác của vendor A không đụng một byte nào. */
  const snapshotB = () =>
    JSON.stringify({
      payouts: [...state.payouts.values()].filter((p) => p.shopId === SHOP_B),
    });
  return { db, state, calls, snapshotB };
}

function buildSystem() {
  const f = buildDb();
  const audit = { write: jest.fn(() => Promise.resolve()) };
  const outbox = { publish: jest.fn(() => Promise.resolve()) };
  const shops = {
    findBrief: jest.fn((id: string) => Promise.resolve({ id })),
    findManyBrief: jest.fn((ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, { id, name: id === SHOP_A ? 'Shop A' : 'Shop B' }])))),
  };
  const payoutService = new ShopPayoutService(f.db as unknown as PrismaService, {} as unknown as OrderQueryApi, shops as unknown as ShopQueryApi, {} as unknown as SystemQueryApi, {} as unknown as PayosService, audit as unknown as PaymentAuditLogService, outbox as unknown as PaymentOutboxService);
  const payoutController = new ShopPayoutController(payoutService);
  return { ...f, payoutService, payoutController, shops, audit, outbox };
}

/* Query/body "độc" — kẻ tấn công gắn id shop B vào mọi chỗ có thể. */
const hostile = <T extends object>(base: T): T & { shopId: string } => ({ ...base, shopId: SHOP_B });
const pageQuery = (extra: object = {}) => hostile({ page: 1, size: 20, skip: 0, ...extra });

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/* ====================================================================================================== */

describe('đối soát chi trả — vendor A không đọc được kỳ đối soát của shop B', () => {
  it('GET /shop/payouts: chỉ kỳ của A — kể cả khi query mang shopId=B hoặc lọc status=failed (kỳ failed là của B)', async () => {
    const s = buildSystem();

    const mine = await s.payoutController.listMine(pageQuery(), shopA);
    const failedOnly = await s.payoutController.listMine(pageQuery({ status: 'failed' }), shopA);

    expect((mine.data?.content ?? []).map((p) => p.id)).toEqual(['payout-a1']);
    expect(mine.data?.totalElements).toBe(1);
    expect(failedOnly.data?.content).toEqual([]); // kỳ failed duy nhất là của B ⇒ A không thấy
    expect(JSON.stringify([mine, failedOnly])).not.toMatch(/payout-b1|9999888877|8877|PayOS 231|Số dư tài khoản chi/);
    expect(s.calls.filter((c) => c.startsWith('payout.findMany')).every((c) => c.includes(SHOP_A) && !c.includes(SHOP_B))).toBe(true);
  });

  it('GET /shop/payouts/:id — kỳ CỦA B ⇒ 404 PAYOUT_NOT_FOUND (không phải 403: không lộ sự tồn tại); kỳ của A ⇒ đủ dòng', async () => {
    const s = buildSystem();

    const err = await s.payoutController.detailMine('payout-b1', shopA).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).toMatchObject({ errorCode: PAYOUT_ERR.NOT_FOUND, httpStatus: 404 });
    expect(JSON.stringify((err as Error).message)).not.toContain(SHOP_B);

    const mine = await s.payoutController.detailMine('payout-a1', shopA);
    expect(mine.data?.payout).toMatchObject({ id: 'payout-a1', shopId: SHOP_A, shopName: 'Shop A', bankAccountMasked: '****2233' });
    expect((mine.data?.lines ?? []).map((l) => l.orderCode)).toEqual(['DH-A-9']);
    expect(JSON.stringify(mine)).not.toMatch(/DH-B|9999888877/);
  });

  it('id không tồn tại ⇒ cùng một lỗi 404 như id của shop khác (không phân biệt được "có nhưng không phải của bạn")', async () => {
    const s = buildSystem();
    const other = await s.payoutController.detailMine('payout-b1', shopA).catch((e: unknown) => e as NotFoundException);
    const ghost = await s.payoutController.detailMine('payout-khong-co', shopA).catch((e: unknown) => e as NotFoundException);
    expect((other as NotFoundException).message).toBe((ghost as NotFoundException).message);
    expect((other as NotFoundException).errorCode).toBe((ghost as NotFoundException).errorCode);
  });

  it('service: getDetail(id, shopId) lọc theo shop ⇒ kỳ B với shop A = 404; getDetail(id) không shop (sàn) thấy được; list({shopId}) chỉ đúng shop', async () => {
    const s = buildSystem();

    await expect(s.payoutService.getDetail('payout-b1', SHOP_A)).rejects.toBeInstanceOf(NotFoundException);
    expect((await s.payoutService.getDetail('payout-b1')).payout.shopId).toBe(SHOP_B);
    expect((await s.payoutService.getDetail('payout-b1', SHOP_B)).lines).toHaveLength(2);
    expect((await s.payoutService.list({ shopId: SHOP_A }, 0, 50)).items.map((p) => p.id)).toEqual(['payout-a1']);
    expect((await s.payoutService.list({}, 0, 50)).total).toBe(2); // sàn không lọc shop ⇒ thấy cả hai (đối chứng: bộ lọc là thứ chặn vendor)
  });

  it('lớp validate GIỮ shopId của PayoutListQuery (dùng cho sàn) ⇒ cách ly nằm ở controller: vendor luôn dùng shopId của ngữ cảnh', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true });
    const q = (await pipe.transform({ shopId: SHOP_B, status: 'failed' }, { type: 'query', metatype: PayoutListQuery })) as PayoutListQuery;
    expect(q.shopId).toBe(SHOP_B); // đi tới controller…

    const s = buildSystem();
    const res = await s.payoutController.listMine(q, shopA); // …nhưng bị bỏ qua
    expect(res.data?.content).toEqual([]);
    expect(s.calls.filter((c) => c.startsWith('payout.findMany'))).toEqual([`payout.findMany:${JSON.stringify({ status: 'failed', shopId: SHOP_A })}`]);
  });
});

/* ====================================================================================================== */

describe('bản đồ route: vendor chỉ chạm route /shop/** có ShopContextGuard; mọi route đổi tiền của sàn đòi quyền supplier.*', () => {
  interface Route {
    controller: string;
    method: string;
    path: string;
    handler: object;
    fn: string;
    cls: new (...a: never[]) => object;
  }

  function routesOf(cls: new (...a: never[]) => object): Route[] {
    const base = (Reflect.getMetadata(PATH_METADATA, cls) as string | undefined) ?? '';
    return Object.getOwnPropertyNames(cls.prototype)
      .filter((n) => n !== 'constructor')
      .map((fn) => ({ fn, handler: Object.getOwnPropertyDescriptor(cls.prototype, fn)?.value as object }))
      .filter((r) => Reflect.getMetadata(METHOD_METADATA, r.handler) !== undefined)
      .map((r) => {
        const sub = (Reflect.getMetadata(PATH_METADATA, r.handler) as string | undefined) ?? '';
        const methodCode = Reflect.getMetadata(METHOD_METADATA, r.handler) as number;
        return { controller: cls.name, method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'][methodCode] ?? String(methodCode), path: [base, sub].filter((x) => x && x !== '/').join('/'), handler: r.handler, fn: r.fn, cls };
      });
  }
  const guardsOf = (r: Route): unknown[] => [...((Reflect.getMetadata(GUARDS_METADATA, r.cls) as unknown[] | undefined) ?? []), ...((Reflect.getMetadata(GUARDS_METADATA, r.handler) as unknown[] | undefined) ?? [])];
  const required = (key: string, r: Route): string[] => (Reflect.getMetadata(key, r.handler) as string[] | undefined) ?? [];

  const payoutRoutes = routesOf(ShopPayoutController);
  const vendorRoutes = [...payoutRoutes.filter((r) => r.path.startsWith('shop/'))];
  const staffRoutes = [...payoutRoutes.filter((r) => r.path.startsWith('admin/'))];

  it('tìm được đủ route (phòng test rỗng vô nghĩa)', () => {
    expect(payoutRoutes.filter((r) => r.path.startsWith('shop/')).map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET shop/payouts', 'GET shop/payouts/:id']);
    expect(staffRoutes.length).toBeGreaterThanOrEqual(5);
  });

  it('mọi route vendor có ShopContextGuard + chỉ đòi mã quyền shop.* (namespace riêng, không dùng chung supplier.*)', () => {
    for (const r of vendorRoutes) {
      expect(guardsOf(r)).toContain(ShopContextGuard);
      const codes = required(SHOP_PERMISSIONS_KEY, r);
      expect(codes.length).toBeGreaterThan(0);
      expect(codes.every((c) => c.startsWith('shop.'))).toBe(true);
      expect(required(PERMISSIONS_KEY, r)).toEqual([]); // không đòi quyền sàn
    }
  });

  it('route kỳ đối soát vendor chỉ có :id của KỲ (được lọc theo shop ở service), không có chỗ nào để gõ id shop khác', () => {
    expect(payoutRoutes.filter((r) => r.path.startsWith('shop/') && r.path.includes(':')).map((r) => r.path)).toEqual(['shop/payouts/:id']);
  });

  it('mọi route đổi/đọc tiền của SÀN (admin/**) đòi quyền supplier.* và KHÔNG gắn ShopContextGuard (vendor không có đường vào bằng token shop)', () => {
    for (const r of staffRoutes) {
      const codes = required(PERMISSIONS_KEY, r);
      expect(codes.length).toBeGreaterThan(0);
      expect(codes.every((c) => c.startsWith('supplier.'))).toBe(true);
      expect(guardsOf(r)).not.toContain(ShopContextGuard);
      expect(required(SHOP_PERMISSIONS_KEY, r)).toEqual([]);
    }
  });

  describe('PermissionGuard THẬT: token vendor (không có quyền supplier.*) bị 403 ở MỌI route admin/** của đối soát', () => {
    const ctxOf = (r: Route, actor: AuthenticatedActor): ExecutionContext =>
      ({
        getHandler: () => r.handler,
        getClass: () => r.cls,
        switchToHttp: () => ({ getRequest: (): RequestWithActor => ({ actor }) as RequestWithActor }),
      }) as unknown as ExecutionContext;
    const guardFor = (perms: string[]) => new PermissionGuard(new Reflector(), { effectivePermissions: () => Promise.resolve(new Set(perms)) });

    it.each(staffRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))('%s', async (_label, r) => {
      // chủ shop A: vai customer ⇒ quyền hiệu lực toàn cục KHÔNG có shop.* (vai shop không gán vào User.roleId) lẫn supplier.*
      const vendorGuard = guardFor([]);
      await expect(vendorGuard.canActivate(ctxOf(r, actorA))).rejects.toBeInstanceOf(ForbiddenException);

      // đối chứng: nhân viên sàn có đủ mã thì qua (guard không chặn nhầm)
      const staff = guardFor(required(PERMISSIONS_KEY, r));
      await expect(staff.canActivate(ctxOf(r, { ...actorA, userId: USER_STAFF, roleCode: 'accountant' }))).resolves.toBe(true);
    });
  });
});
