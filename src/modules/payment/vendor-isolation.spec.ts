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
import { AdminWalletController } from './shop-wallet/controller/admin-wallet.controller';
import { ShopWalletController } from './shop-wallet/controller/shop-wallet.controller';
import { ShopWalletRepository } from './shop-wallet/repository/shop-wallet.repository';
import { CreateDepositRequestDto, DepositListQuery } from './shop-wallet/request/shop-wallet.requests';
import { ShopWalletService } from './shop-wallet/service/shop-wallet.service';
import { ShopPayoutController } from './shop-payout/controller/shop-payout.controller';
import { PayoutListQuery } from './shop-payout/dto/shop-payout.dto';
import { ShopPayoutService } from './shop-payout/shop-payout.service';

/*
 * CÁCH LY CHÉO SHOP ở ví quỹ COD + đối soát chi trả (phía vendor). Vendor shop A KHÔNG được đọc/đổi ví, sổ cái, yêu cầu nộp quỹ, kỳ đối soát của shop B —
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
const shopA: ShopContext = { shopId: SHOP_A, shopCode: 'SA', shopName: 'Shop A', shopStatus: 'approved', memberId: 'm-a', roleId: 'r-owner', roleCode: 'shop_owner', roleName: 'Chủ shop', permissionCodes: ['shop.wallet.read', 'shop.wallet.deposit_request', 'shop.payout.read'] };

/* ------------------------------------------------------------------ DB giả: HAI shop A và B */

interface LedgerRow {
  id: string;
  walletId: string;
  shopId: string;
  type: string;
  orderCode: string | null;
  amount: Dec;
  balanceAfter: Dec;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}
interface DepositRow {
  id: string;
  shopId: string;
  amount: Dec;
  status: string;
  proofUrl: string | null;
  note: string | null;
  createdAt: Date;
}
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
    wallets: new Map<string, { id: string; shopId: string; balance: Dec; updatedAt: Date }>([
      [SHOP_A, { id: 'wallet-a', shopId: SHOP_A, balance: D(120_000), updatedAt: t(1) }],
      [SHOP_B, { id: 'wallet-b', shopId: SHOP_B, balance: D(-50_000), updatedAt: t(2) }],
    ]),
    ledger: [
      { id: 'led-a1', walletId: 'wallet-a', shopId: SHOP_A, type: 'deposit', orderCode: null, amount: D(200_000), balanceAfter: D(200_000), note: 'Nộp quỹ A', createdBy: null, createdAt: t(1) },
      { id: 'led-a2', walletId: 'wallet-a', shopId: SHOP_A, type: 'cod_commission', orderCode: 'DH-A-1', amount: D(-80_000), balanceAfter: D(120_000), note: 'Hoa hồng COD đơn DH-A-1', createdBy: null, createdAt: t(2) },
      { id: 'led-b1', walletId: 'wallet-b', shopId: SHOP_B, type: 'deposit', orderCode: null, amount: D(100_000), balanceAfter: D(100_000), note: 'Nộp quỹ B', createdBy: null, createdAt: t(1) },
      { id: 'led-b2', walletId: 'wallet-b', shopId: SHOP_B, type: 'cod_commission', orderCode: 'DH-B-1', amount: D(-150_000), balanceAfter: D(-50_000), note: 'Hoa hồng COD đơn DH-B-1', createdBy: null, createdAt: t(2) },
    ] as LedgerRow[],
    deposits: new Map<string, DepositRow>([
      ['dep-a1', { id: 'dep-a1', shopId: SHOP_A, amount: D(200_000), status: 'approved', proofUrl: null, note: 'A đã duyệt', createdAt: t(1) }],
      ['dep-b1', { id: 'dep-b1', shopId: SHOP_B, amount: D(300_000), status: 'pending', proofUrl: 'https://cdn.fitly.vn/b-proof.png', note: 'B chờ duyệt', createdAt: t(2) }],
    ]),
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

  let seq = 0;
  const calls: string[] = [];
  const db = {
    $executeRaw: jest.fn((_s: TemplateStringsArray, shopId: string) => {
      if (!state.wallets.has(shopId)) state.wallets.set(shopId, { id: `wallet-${shopId.slice(0, 4)}`, shopId, balance: D(0), updatedAt: t(9) });
      return Promise.resolve(1);
    }),
    $queryRaw: jest.fn((_s: TemplateStringsArray, shopId: string) => {
      const w = state.wallets.get(shopId);
      return Promise.resolve(w ? [{ id: w.id, shop_id: w.shopId, balance: w.balance.toString() }] : []);
    }),
    $transaction: undefined as unknown as jest.Mock,
    shopWallet: {
      findUnique: jest.fn(({ where }: { where: { shopId: string } }) => {
        calls.push(`wallet.findUnique:${where.shopId}`);
        return Promise.resolve(state.wallets.get(where.shopId) ?? null);
      }),
    },
    shopWalletTransaction: {
      findMany: jest.fn(({ where, skip, take }: { where: Where; skip: number; take: number }) => {
        calls.push(`ledger.findMany:${String(where.shopId)}`);
        return Promise.resolve(newestFirst(state.ledger.filter((r) => matches(r, where))).slice(skip, skip + take));
      }),
      count: jest.fn(({ where }: { where: Where }) => Promise.resolve(state.ledger.filter((r) => matches(r, where)).length)),
      createMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    shopWalletDepositRequest: {
      findFirst: jest.fn(({ where }: { where: Where }) => Promise.resolve([...state.deposits.values()].find((d) => matches(d, where)) ?? null)),
      findMany: jest.fn(({ where, skip, take }: { where: Where; skip: number; take: number }) => {
        calls.push(`deposit.findMany:${JSON.stringify(where)}`);
        return Promise.resolve(newestFirst([...state.deposits.values()].filter((d) => matches(d, where))).slice(skip, skip + take));
      }),
      count: jest.fn(({ where }: { where: Where }) => Promise.resolve([...state.deposits.values()].filter((d) => matches(d, where)).length)),
      create: jest.fn(({ data }: { data: { shopId: string; amount: Dec; proofUrl: string | null; note: string | null } }) => {
        const id = `dep-new-${(seq += 1)}`;
        state.deposits.set(id, { id, shopId: data.shopId, amount: data.amount, status: 'pending', proofUrl: data.proofUrl, note: data.note, createdAt: t(30 + seq) });
        return Promise.resolve({ id });
      }),
    },
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
  db.$transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  /* Ảnh chụp dữ liệu CỦA SHOP B — để khẳng định thao tác của vendor A không đụng một byte nào. */
  const snapshotB = () =>
    JSON.stringify({
      wallet: state.wallets.get(SHOP_B),
      ledger: state.ledger.filter((r) => r.shopId === SHOP_B),
      deposits: [...state.deposits.values()].filter((d) => d.shopId === SHOP_B),
      payouts: [...state.payouts.values()].filter((p) => p.shopId === SHOP_B),
    });
  return { db, state, calls, snapshotB };
}

function buildSystem() {
  const f = buildDb();
  const audit = { write: jest.fn(() => Promise.resolve()) };
  const outbox = { publish: jest.fn(() => Promise.resolve()) };
  const codGateway = { setCodEnabled: jest.fn(() => Promise.resolve(false)) };
  const shops = {
    findBrief: jest.fn((id: string) => Promise.resolve({ id, codEnabled: id === SHOP_A })),
    findManyBrief: jest.fn((ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, { id, name: id === SHOP_A ? 'Shop A' : 'Shop B', codEnabled: true }])))),
  };
  const repo = new ShopWalletRepository(f.db as unknown as PrismaService);
  const wallet = new ShopWalletService(f.db as unknown as PrismaService, repo, audit as unknown as PaymentAuditLogService, outbox as unknown as PaymentOutboxService, codGateway);
  const payoutService = new ShopPayoutService(f.db as unknown as PrismaService, {} as unknown as OrderQueryApi, shops as unknown as ShopQueryApi, {} as unknown as SystemQueryApi, {} as unknown as PayosService, audit as unknown as PaymentAuditLogService, outbox as unknown as PaymentOutboxService);
  const walletController = new ShopWalletController(wallet, shops as unknown as ShopQueryApi);
  const payoutController = new ShopPayoutController(payoutService);
  return { ...f, wallet, payoutService, walletController, payoutController, shops, audit, outbox };
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

describe('ví quỹ COD — vendor A không đọc/đổi được ví của shop B', () => {
  it('GET /shop/wallet: chỉ ví A (số dư, COD, yêu cầu chờ) — không có dấu vết của B', async () => {
    const s = buildSystem();

    const res = await s.walletController.summary(shopA);

    expect(res.data).toEqual({ shopId: SHOP_A, balance: '120000', codEnabled: true, pendingDeposit: null }); // B có yêu cầu pending nhưng A KHÔNG thấy
    expect(JSON.stringify(res)).not.toContain(SHOP_B);
    expect(JSON.stringify(res)).not.toContain('dep-b1');
    expect(s.shops.findBrief.mock.calls.map((c) => c[0])).toEqual([SHOP_A]);
    expect(s.calls.filter((c) => c.startsWith('wallet.findUnique'))).toEqual([`wallet.findUnique:${SHOP_A}`]);
  });

  it('GET /shop/wallet/transactions: chỉ sổ cái A (kể cả khi query mang shopId=B); tổng đếm cũng chỉ của A', async () => {
    const s = buildSystem();

    const res = await s.walletController.transactions(shopA, pageQuery());

    const rows = res.data?.content ?? [];
    expect(rows.map((r) => r.id)).toEqual(['led-a2', 'led-a1']);
    expect(res.data?.totalElements).toBe(2);
    expect(JSON.stringify(res)).not.toMatch(/DH-B|Nộp quỹ B|led-b/);
    expect(s.calls.filter((c) => c.startsWith('ledger.findMany'))).toEqual([`ledger.findMany:${SHOP_A}`]);
  });

  it('GET /shop/wallet/deposit-requests: chỉ yêu cầu của A; lọc status=pending (của B) cũng KHÔNG lộ yêu cầu của B; query mang shopId=B bị bỏ qua', async () => {
    const s = buildSystem();

    const all = await s.walletController.deposits(shopA, pageQuery());
    const pendingOnly = await s.walletController.deposits(shopA, pageQuery({ status: 'pending' }));

    expect((all.data?.content ?? []).map((d) => d.id)).toEqual(['dep-a1']);
    expect((all.data?.content ?? []).every((d) => d.shopId === SHOP_A && d.shopName === 'Shop A')).toBe(true);
    expect(pendingOnly.data?.content).toEqual([]); // A không có yêu cầu pending dù B có
    expect(JSON.stringify([all, pendingOnly])).not.toMatch(/dep-b1|b-proof|B chờ duyệt/);
    expect(s.calls.filter((c) => c.startsWith('deposit.findMany')).every((c) => c.includes(SHOP_A) && !c.includes(SHOP_B))).toBe(true);
  });

  it('POST /shop/wallet/deposit-requests: tạo yêu cầu cho CHÍNH A dù body mang shopId=B; yêu cầu pending của B KHÔNG chặn A; dữ liệu B không đổi một byte', async () => {
    const s = buildSystem();
    const before = s.snapshotB();

    const res = await s.walletController.createDeposit(actorA, shopA, hostile({ amount: 500_000, note: 'Nộp quỹ' }));

    expect(res.data).toMatchObject({ shopId: SHOP_A, shopName: 'Shop A', amount: '500000', status: 'pending' });
    const created = s.state.deposits.get(res.data?.id ?? '');
    expect(created).toMatchObject({ shopId: SHOP_A, status: 'pending' });
    expect([...s.state.deposits.values()].filter((d) => d.shopId === SHOP_B)).toHaveLength(1); // B vẫn đúng 1 yêu cầu, không phát sinh thêm
    expect(s.snapshotB()).toBe(before);
    expect(s.state.wallets.get(SHOP_A)?.balance.toString()).toBe('120000'); // chưa duyệt ⇒ ví A cũng chưa đổi
    expect(s.state.ledger).toHaveLength(4); // không thêm dòng sổ cái nào
  });

  it('A tạo yêu cầu lần hai ⇒ bị chặn vì CHÍNH A đã có yêu cầu chờ (đúng shop), không liên quan yêu cầu chờ của B', async () => {
    const s = buildSystem();
    await s.walletController.createDeposit(actorA, shopA, { amount: 20_000 });

    await expect(s.walletController.createDeposit(actorA, shopA, hostile({ amount: 30_000 }) as never)).rejects.toMatchObject({ errorCode: 'PAYMENT_WALLET_DEPOSIT_PENDING_EXISTS' });
    expect([...s.state.deposits.values()].filter((d) => d.shopId === SHOP_A && d.status === 'pending')).toHaveLength(1);
  });

  it('toàn bộ thao tác vendor A cùng nhau ⇒ ví / sổ cái / yêu cầu / kỳ đối soát của B giữ nguyên', async () => {
    const s = buildSystem();
    const before = s.snapshotB();

    await s.walletController.summary(shopA);
    await s.walletController.transactions(shopA, pageQuery());
    await s.walletController.deposits(shopA, pageQuery());
    await s.walletController.createDeposit(actorA, shopA, hostile({ amount: 40_000 }));
    await s.payoutController.listMine(pageQuery(), shopA);
    await s.payoutController.detailMine('payout-a1', shopA);

    expect(s.snapshotB()).toBe(before);
    expect(s.audit.write).toHaveBeenCalledTimes(1); // chỉ audit của việc tạo yêu cầu nộp quỹ
    expect(s.outbox.publish).not.toHaveBeenCalled();
  });

  describe('service: shopId là tham số bắt buộc của mọi thao tác vendor', () => {
    it('getWalletSummary / listTransactions / listDepositRequests({shopId}) chỉ trả dữ liệu đúng shop', async () => {
      const s = buildSystem();

      expect((await s.wallet.getWalletSummary(SHOP_A)).balance.toString()).toBe('120000');
      expect((await s.wallet.getWalletSummary(SHOP_B)).pendingDeposit?.id).toBe('dep-b1');
      expect((await s.wallet.listTransactions(SHOP_A, 0, 50)).data.map((r) => r.id).sort()).toEqual(['led-a1', 'led-a2']);
      expect((await s.wallet.listDepositRequests({ shopId: SHOP_A }, 0, 50)).data.map((d) => d.id)).toEqual(['dep-a1']);
      expect((await s.wallet.listDepositRequests({ shopId: SHOP_A, status: 'pending' }, 0, 50)).data).toEqual([]);
    });

    it('createDepositRequest(A) chỉ khoá/ghi ví và yêu cầu của A', async () => {
      const s = buildSystem();
      const before = s.snapshotB();

      const { id } = await s.wallet.createDepositRequest(SHOP_A, 50_000, actorA);

      expect(s.state.deposits.get(id)?.shopId).toBe(SHOP_A);
      expect(s.db.$queryRaw.mock.calls.map((c) => c[1])).toEqual([SHOP_A]); // chỉ khoá dòng ví A
      expect(s.snapshotB()).toBe(before);
    });
  });

  describe('tham số "độc" bị loại ngay ở lớp validate (ValidationPipe của app)', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true, transformOptions: { enableImplicitConversion: false } });

    it('query vendor (DepositListQuery) mang shopId=B ⇒ shopId bị gỡ trước khi tới controller', async () => {
      const q = (await pipe.transform({ page: '1', size: '20', status: 'pending', shopId: SHOP_B }, { type: 'query', metatype: DepositListQuery })) as DepositListQuery & { shopId?: string };
      expect(q.shopId).toBeUndefined();
      expect(q.status).toBe('pending');
    });

    it('body nộp quỹ mang shopId=B ⇒ shopId bị gỡ', async () => {
      const body = (await pipe.transform({ amount: 50_000, shopId: SHOP_B, shop_id: SHOP_B, walletId: 'wallet-b' }, { type: 'body', metatype: CreateDepositRequestDto })) as CreateDepositRequestDto & Record<string, unknown>;
      expect(body.amount).toBe(50_000);
      expect(body).not.toHaveProperty('shopId');
      expect(body).not.toHaveProperty('shop_id');
      expect(body).not.toHaveProperty('walletId');
    });
  });
});

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

  const walletRoutes = routesOf(ShopWalletController);
  const adminWalletRoutes = routesOf(AdminWalletController);
  const payoutRoutes = routesOf(ShopPayoutController);
  const vendorRoutes = [...walletRoutes, ...payoutRoutes.filter((r) => r.path.startsWith('shop/'))];
  const staffRoutes = [...adminWalletRoutes, ...payoutRoutes.filter((r) => r.path.startsWith('admin/'))];

  it('tìm được đủ route (phòng test rỗng vô nghĩa)', () => {
    expect(walletRoutes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET shop/wallet', 'GET shop/wallet/deposit-requests', 'GET shop/wallet/transactions', 'POST shop/wallet/deposit-requests']);
    expect(payoutRoutes.filter((r) => r.path.startsWith('shop/')).map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET shop/payouts', 'GET shop/payouts/:id']);
    expect(staffRoutes.length).toBeGreaterThanOrEqual(12);
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

  it('route ví vendor KHÔNG có tham số đường dẫn (không có chỗ nào để gõ id shop/ví khác); route kỳ đối soát chỉ có :id của KỲ (được lọc theo shop ở service)', () => {
    for (const r of walletRoutes) expect(r.path).not.toContain(':');
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

  describe('PermissionGuard THẬT: token vendor (không có quyền supplier.*) bị 403 ở MỌI route admin/** của ví & đối soát', () => {
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
