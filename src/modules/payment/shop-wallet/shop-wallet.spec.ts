import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BusinessException } from '@common/exception/business.exception';
import { ACCOUNTANT, bizError, buildTopupFixture, nextTopupCode, OWNER_A, SHOP_A, stopFixture } from './shop-wallet-topup.fixture';
import type { TopupFixture } from './shop-wallet-topup.fixture';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import type { PaymentAuditLogService } from '../audit/payment-audit-log.service';
import { WALLET_ERR } from '../foundation/payment.constants';
import { ShopWalletService } from './shop-wallet.service';

/*
 * Test ví đặt cọc COD (PLAN-0020). Service chạy THẬT; Prisma được thay bằng DB giả trong bộ nhớ (ví, sổ cái, yêu cầu nộp cọc) ⇒ kiểm được cả chuỗi
 * nộp cọc → đơn COD trừ hoa hồng → ví âm → COD khoá → nộp bù mà không cần DB thật.
 */

const D = (v: string | number) => new Prisma.Decimal(v);
const SHOP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OFFICIAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor: AuthenticatedActor = { userId: 'u-acc', email: 'ketoan@fitly.vn', roleCode: 'accountant', permissionVersion: 1, tokenId: 'jti' };

interface Wallet { id: string; shopId: string; balance: Prisma.Decimal; version: number; updatedAt: Date }
interface Entry { id: string; walletId: string; shopId: string; type: string; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal; orderCode: string | null; meta: unknown }
interface Deposit { id: string; shopId: string; amount: Prisma.Decimal; transferRef: string; note: string | null; status: string; rejectReason: string | null; requestedBy: string | null; reviewedBy: string | null; reviewedAt: Date | null; createdAt: Date }

function build() {
  const wallets: Wallet[] = [];
  const entries: Entry[] = [];
  const deposits: Deposit[] = [];
  let seq = 0;
  const self: { db?: unknown } = {};
  const match = (row: object, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const cur = (row as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && 'in' in v) return (v as { in: unknown[] }).in.includes(cur);
      if (v && typeof v === 'object' && 'equals' in v) return String(cur).toLowerCase() === String((v as { equals: string }).equals).toLowerCase();
      if (v && typeof v === 'object' && 'not' in v) return cur !== (v).not;
      return cur === v;
    });
  const db = {
    shopCodWallet: {
      upsert: jest.fn(({ where, create }: { where: { shopId: string }; create: { shopId: string } }) => {
        let w = wallets.find((x) => x.shopId === where.shopId);
        if (!w) wallets.push((w = { id: `w${++seq}`, shopId: create.shopId, balance: D(0), version: 0, updatedAt: new Date() }));
        return Promise.resolve(w);
      }),
      findUniqueOrThrow: jest.fn(({ where }: { where: { shopId: string } }) => Promise.resolve(wallets.find((x) => x.shopId === where.shopId)!)),
      findUnique: jest.fn(({ where }: { where: { shopId: string } }) => Promise.resolve(wallets.find((x) => x.shopId === where.shopId) ?? null)),
      findMany: jest.fn(({ where }: { where: { shopId: { in: string[] } } }) => Promise.resolve(wallets.filter((w) => where.shopId.in.includes(w.shopId)))),
      update: jest.fn(({ where, data }: { where: { id: string }; data: { balance: string } }) => {
        const w = wallets.find((x) => x.id === where.id)!;
        w.balance = D(data.balance);
        w.version += 1;
        return Promise.resolve(w);
      }),
    },
    shopCodWalletTransaction: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => Promise.resolve(entries.find((e) => match(e, where)) ?? null)),
      create: jest.fn(({ data }: { data: Omit<Entry, 'id' | 'amount' | 'balanceAfter'> & { amount: string; balanceAfter: string } }) => {
        const e: Entry = { ...data, id: `t${++seq}`, amount: D(data.amount), balanceAfter: D(data.balanceAfter) };
        entries.push(e);
        return Promise.resolve(e);
      }),
    },
    shopCodDeposit: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => Promise.resolve(deposits.find((d) => match(d, where)) ?? null)),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(deposits.find((d) => d.id === where.id) ?? null)),
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(deposits.find((d) => d.id === where.id)!)),
      create: jest.fn(({ data }: { data: { shopId: string; amount: string; transferRef: string; note: string | null; requestedBy: string } }) => {
        const d: Deposit = { id: `d${++seq}`, shopId: data.shopId, amount: D(data.amount), transferRef: data.transferRef, note: data.note, status: 'pending', rejectReason: null, requestedBy: data.requestedBy, reviewedBy: null, reviewedAt: null, createdAt: new Date() };
        deposits.push(d);
        return Promise.resolve(d);
      }),
      updateMany: jest.fn(({ where, data }: { where: { id: string; status: string }; data: Partial<Deposit> }) => {
        const d = deposits.find((x) => x.id === where.id && x.status === where.status);
        if (d) Object.assign(d, data);
        return Promise.resolve({ count: d ? 1 : 0 });
      }),
    },
    $queryRaw: jest.fn(() => Promise.resolve([])),
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(self.db)),
  };
  self.db = db;
  const shops = { findOfficialShopId: jest.fn(() => Promise.resolve(OFFICIAL)), findBrief: jest.fn(() => Promise.resolve({ id: SHOP, name: 'Shop A' })), findManyBrief: jest.fn(() => Promise.resolve(new Map())) };
  const system = { settingNumber: jest.fn((key: string) => Promise.resolve(key === 'wallet.min_balance_for_cod' ? 200_000 : 500_000)), setting: jest.fn(() => Promise.resolve('hướng dẫn')) };
  const audit = { write: jest.fn(() => Promise.resolve()) };
  const service = new ShopWalletService(db as unknown as PrismaService, shops as unknown as ShopQueryApi, system as unknown as SystemQueryApi, audit as unknown as PaymentAuditLogService);
  const tx = db as unknown as Parameters<ShopWalletService['applyCodCommission']>[0];
  return { service, tx, wallets, entries, deposits };
}

let refSeq = 0;
const deposit = async (s: ReturnType<typeof build>, amount: bigint) => {
  const d = await s.service.requestDeposit(actor, SHOP, { amount, transferRef: `FT${++refSeq}` });
  return s.service.approveDeposit(actor, d.id);
};
const codOpen = async (s: ReturnType<typeof build>) => (await s.service.codAvailability([SHOP])).get(SHOP);

describe('ShopWalletService — ví đặt cọc COD', () => {
  it('chưa nộp cọc ⇒ COD đóng; gian hàng chính chủ của sàn được miễn', async () => {
    const s = build();
    const m = await s.service.codAvailability([SHOP, OFFICIAL]);
    expect(m.get(SHOP)).toBe(false);
    expect(m.get(OFFICIAL)).toBe(true);
  });

  it('nộp cọc được duyệt ⇒ cộng ví, COD mở', async () => {
    const s = build();
    await deposit(s, 1_000_000n);
    expect(s.wallets[0].balance.toString()).toBe('1000000');
    expect(await codOpen(s)).toBe(true);
    expect(s.entries[0]).toMatchObject({ type: 'deposit', balanceAfter: expect.anything() as unknown });
  });

  it('đơn COD thu thành công tự trừ hoa hồng; idempotent theo mã đơn', async () => {
    const s = build();
    await deposit(s, 1_000_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 1_000_000n, commissionBase: 1_000_000n, platformCredit: 0n, commissionRate: '10.00' });
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 1_000_000n, commissionBase: 1_000_000n, platformCredit: 0n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('900000');
    expect(s.entries.filter((e) => e.type === 'cod_commission')).toHaveLength(1);
  });

  it('ví về 0 ⇒ COD đóng; ví âm ⇒ COD đóng, nộp thêm bù số âm trước rồi mới dương mới mở lại', async () => {
    const s = build();
    await deposit(s, 500_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 5_000_000n, commissionBase: 5_000_000n, platformCredit: 0n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('0');
    expect(await codOpen(s)).toBe(false);

    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH2', total: 2_000_000n, commissionBase: 2_000_000n, platformCredit: 0n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('-200000');
    expect(await codOpen(s)).toBe(false);

    await deposit(s, 500_000n); // trừ nợ 200k còn 300k
    expect(s.wallets[0].balance.toString()).toBe('300000');
    expect(await codOpen(s)).toBe(true);
  });

  it('nộp vừa đúng số nợ ⇒ ví về 0 và COD vẫn đóng', async () => {
    const s = build();
    await deposit(s, 500_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 7_000_000n, commissionBase: 7_000_000n, platformCredit: 0n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('-200000');
    await s.service.adjust(actor, SHOP, 200_000n, 'bù nợ');
    expect(s.wallets[0].balance.toString()).toBe('0');
    expect(await codOpen(s)).toBe(false);
  });

  it('hoàn tiền đơn COD: trừ ví số hoàn, cộng lại phần hoa hồng tương ứng; idempotent theo mã hoàn', async () => {
    const s = build();
    await deposit(s, 1_000_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 1_000_000n, commissionBase: 1_000_000n, platformCredit: 0n, commissionRate: '10.00' }); // 900k
    const input = { shopId: SHOP, orderCode: 'DH1', refundId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', amount: 500_000n };
    await s.service.applyCodRefund(s.tx, input);
    await s.service.applyCodRefund(s.tx, input);
    expect(s.wallets[0].balance.toString()).toBe('450000'); // 900k − 500k + 50k hoa hồng hoàn lại
    expect(s.entries.filter((e) => e.type === 'cod_refund')).toHaveLength(1);
  });

  it('[COD-03] voucher SÀN: ví được cộng phần sàn chịu, hoa hồng chỉ tính trên tiền hàng sau voucher shop (không phí ship)', async () => {
    // Đơn: tiền hàng 1.000.000, ship 30.000, voucher sàn 100.000 trên hàng ⇒ khách trả 930.000; hoa hồng 10% × 1.000.000 = 100.000; sàn nợ shop 100.000 ⇒ ví ±0.
    const s = build();
    await deposit(s, 1_000_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 930_000n, commissionBase: 1_000_000n, platformCredit: 100_000n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('1000000');
    expect(s.entries.find((e) => e.type === 'cod_commission')?.amount.toString()).toBe('0');
  });

  it('[COD-04] COD + voucher sàn 50k, hoa hồng 10% trên 500k hàng + 30k ship ⇒ ví = −50.000 + 50.000 = 0', async () => {
    const s = build();
    await deposit(s, 1_000_000n);
    // hàng 500.000, ship 30.000, voucher sàn 50.000 ⇒ khách trả 480.000; gốc hoa hồng 500.000 (không ship) ⇒ 50.000
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 480_000n, commissionBase: 500_000n, platformCredit: 50_000n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('1000000');
  });

  it('freeship của SÀN: sàn chịu phí ship ⇒ ví được cộng đúng phần đó, hoa hồng không tăng', async () => {
    // tiền hàng 500.000, ship 30.000 do sàn chịu (khách trả 500.000): hoa hồng 10% × 500.000 = 50.000; credit 30.000 ⇒ ví −20.000.
    const s = build();
    await deposit(s, 1_000_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 500_000n, commissionBase: 500_000n, platformCredit: 30_000n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('980000');
  });

  it('voucher sàn lớn hơn hoa hồng ⇒ delta DƯƠNG (sàn nợ shop)', async () => {
    const s = build();
    await deposit(s, 1_000_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 100_000n, commissionBase: 100_000n, platformCredit: 90_000n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('1080000'); // −10.000 + 90.000
  });

  it('[WAL-05] hoàn một phần đơn có voucher sàn: đảo hoa hồng VÀ phần sàn bù theo tỉ lệ số hoàn / số khách trả', async () => {
    const s = build();
    await deposit(s, 1_000_000n);
    // khách trả 900.000; hoa hồng 100.000; credit 100.000 ⇒ delta 0, ví 1.000.000
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', total: 900_000n, commissionBase: 1_000_000n, platformCredit: 100_000n, commissionRate: '10.00' });
    // hoàn 450.000 (một nửa số khách trả): −450.000 + hoa hồng hoàn 50.000 − credit hoàn 50.000 = −450.000
    await s.service.applyCodRefund(s.tx, { shopId: SHOP, orderCode: 'DH1', refundId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', amount: 450_000n });
    expect(s.wallets[0].balance.toString()).toBe('550000');
    // hoàn nốt 450.000 ⇒ đảo đủ: tổng đảo hoa hồng 100.000, credit 100.000
    await s.service.applyCodRefund(s.tx, { shopId: SHOP, orderCode: 'DH1', refundId: '9b2e5c1a-7d3f-4e8a-b6c4-1a2b3c4d5e6f', amount: 450_000n });
    expect(s.wallets[0].balance.toString()).toBe('100000');
  });

  it('[WAL-04] [COD-02] COD chỉ mở khi ví ≥ wallet.min_balance_for_cod (200.000): 199.999 ⇒ đóng, 200.000 ⇒ mở', async () => {
    const s = build();
    await deposit(s, 500_000n);
    await s.service.adjust(actor, SHOP, -300_001n, 'thử');
    expect(s.wallets[0].balance.toString()).toBe('199999');
    expect(await codOpen(s)).toBe(false);
    await s.service.adjust(actor, SHOP, 1n, 'thử');
    expect(await codOpen(s)).toBe(true);
  });

  it('[WAL-02] mã giao dịch nộp cọc trùng (không phân biệt hoa thường) với khoản chờ/đã duyệt ⇒ 409 WALLET_TRANSFER_REF_DUPLICATE; khoản bị từ chối không chiếm mã', async () => {
    const s = build();
    const d = await s.service.requestDeposit(actor, SHOP, { amount: 600_000n, transferRef: 'FT-ABC123' });
    await expect(s.service.requestDeposit(actor, 'other-shop', { amount: 600_000n, transferRef: 'ft-abc123' })).rejects.toMatchObject({ errorCode: WALLET_ERR.TRANSFER_REF_DUPLICATE });
    await s.service.rejectDeposit(actor, d.id, 'không thấy tiền');
    await expect(s.service.requestDeposit(actor, 'other-shop', { amount: 600_000n, transferRef: 'ft-abc123' })).resolves.toBeDefined();
  });

  it('chặn nộp dưới mức tối thiểu và chặn hai yêu cầu chờ duyệt cùng lúc', async () => {
    const s = build();
    await expect(s.service.requestDeposit(actor, SHOP, { amount: 100_000n, transferRef: 'FT1' })).rejects.toMatchObject({ errorCode: WALLET_ERR.DEPOSIT_TOO_SMALL });
    await s.service.requestDeposit(actor, SHOP, { amount: 600_000n, transferRef: 'FT1' });
    await expect(s.service.requestDeposit(actor, SHOP, { amount: 600_000n, transferRef: 'FT2' })).rejects.toBeInstanceOf(BusinessException);
  });

  it('duyệt hai lần chỉ cộng một lần; từ chối không cộng ví', async () => {
    const s = build();
    const d = await s.service.requestDeposit(actor, SHOP, { amount: 600_000n, transferRef: 'FT1' });
    await s.service.approveDeposit(actor, d.id);
    await expect(s.service.approveDeposit(actor, d.id)).rejects.toMatchObject({ errorCode: WALLET_ERR.INVALID_STATE });
    expect(s.wallets[0].balance.toString()).toBe('600000');

    const s2 = build();
    const d2 = await s2.service.requestDeposit(actor, SHOP, { amount: 600_000n, transferRef: 'FT1' });
    await s2.service.rejectDeposit(actor, d2.id, 'không thấy tiền');
    expect(s2.wallets[0].balance.toString()).toBe('0');
    expect(await codOpen(s2)).toBe(false);
  });
});

/* ---------------------------------------------------------------- PLAN-0041 WP-4: ghi có PayOS + chặn duyệt nhầm ---- */

describe('ShopWalletService — ghi có nạp cọc PayOS (creditPayosTopup) và chặn duyệt tay khoản PayOS (PLAN-0041)', () => {
  let fx: TopupFixture;
  beforeEach(() => {
    fx = buildTopupFixture();
  });
  afterEach(() => stopFixture());

  type Credit = (tx: unknown, input: { shopId: string; topupId: string; refKey: string; amount: bigint; note: string; meta: Record<string, string> }) => Promise<{ credited: boolean; balanceAfter: bigint }>;
  const wallet = (): { creditPayosTopup: Credit } => fx.wallet as unknown as { creditPayosTopup: Credit };
  const inTx = <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fx.prisma.$transaction((tx) => fn(tx));

  it('[WTW-01] creditPayosTopup cộng đúng, ghi dòng type topup_payos có refKey/topupId, trả balanceAfter', async () => {
    const t = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    const r = await inTx((tx) => wallet().creditPayosTopup(tx, { shopId: SHOP_A, topupId: t.id, refKey: `payos-topup:${t.id}:1000`, amount: 1000n, note: 'nạp', meta: {} }));
    expect(r).toEqual({ credited: true, balanceAfter: 1000n });
    const [entry] = fx.ledgerOf(SHOP_A, 'topup_payos');
    expect(entry).toMatchObject({ topupId: t.id, refKey: `payos-topup:${t.id}:1000` });
    expect(String(entry.balanceAfter)).toBe('1000');
  });

  it('[WTW-02] cùng refKey lần hai ⇒ credited:false, ví không đổi, không thêm dòng sổ', async () => {
    const t = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    const input = { shopId: SHOP_A, topupId: t.id, refKey: `payos-topup:${t.id}:1000`, amount: 1000n, note: 'nạp', meta: {} };
    await inTx((tx) => wallet().creditPayosTopup(tx, input));
    const again = await inTx((tx) => wallet().creditPayosTopup(tx, input));
    expect(again).toEqual({ credited: false, balanceAfter: 1000n });
    expect(fx.ledgerOf(SHOP_A, 'topup_payos')).toHaveLength(1);
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('1000');
  });

  it('[WTW-03] amount ≤ 0 ⇒ ném, không ghi gì', async () => {
    const t = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    for (const amount of [0n, -1n]) {
      await expect(inTx((tx) => wallet().creditPayosTopup(tx, { shopId: SHOP_A, topupId: t.id, refKey: `payos-topup:${t.id}:${String(amount)}`, amount, note: 'x', meta: {} }))).rejects.toThrow('số tiền phải dương');
    }
    expect(fx.ledgerOf(SHOP_A)).toHaveLength(0);
    expect(fx.walletOf(SHOP_A)).toBeUndefined();
  });

  it('[WTW-04] khoá ví trước khi ghi (LOCK shop_cod_wallets trước mọi update/insert sổ); ví chưa có ⇒ được tạo', async () => {
    const t = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    await inTx((tx) => wallet().creditPayosTopup(tx, { shopId: SHOP_A, topupId: t.id, refKey: `payos-topup:${t.id}:500`, amount: 500n, note: 'nạp', meta: {} }));
    const lockCall = fx.engine.calls.find((c) => c.label === 'LOCK shop_cod_wallets');
    expect(typeof lockCall?.tx).toBe('number');
    const labels = fx.engine.labelsOf(lockCall!.tx as number);
    const lock = labels.indexOf('LOCK shop_cod_wallets');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(labels.indexOf('shop_cod_wallet_transactions.create'));
    expect(lock).toBeLessThan(labels.indexOf('shop_cod_wallets.update'));
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('500');
  });

  it('[WTW-05] ví âm −200.000 + nạp 500.000 ⇒ 300.000 (cộng đại số); COD mở (≥ 200.000)', async () => {
    fx.seedWallet(SHOP_A, -200_000);
    expect((await fx.wallet.codAvailability([SHOP_A])).get(SHOP_A)).toBe(false);
    const t = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    await inTx((tx) => wallet().creditPayosTopup(tx, { shopId: SHOP_A, topupId: t.id, refKey: `payos-topup:${t.id}:500000`, amount: 500_000n, note: 'nạp', meta: {} }));
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('300000');
    expect((await fx.wallet.codAvailability([SHOP_A])).get(SHOP_A)).toBe(true);
  });

  it('[WTW-06] ví 0 + nạp 150.000 ⇒ COD vẫn đóng (< 200.000); nạp thêm 50.000 ⇒ đủ ngưỡng và COD mở', async () => {
    fx.seedWallet(SHOP_A, 0);
    const t = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    await inTx((tx) => wallet().creditPayosTopup(tx, { shopId: SHOP_A, topupId: t.id, refKey: `payos-topup:${t.id}:150000`, amount: 150_000n, note: 'nạp', meta: {} }));
    expect((await fx.wallet.codAvailability([SHOP_A])).get(SHOP_A)).toBe(false);
    await inTx((tx) => wallet().creditPayosTopup(tx, { shopId: SHOP_A, topupId: t.id, refKey: `payos-topup:${t.id}:200000`, amount: 50_000n, note: 'nạp', meta: {} }));
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('200000');
    expect((await fx.wallet.codAvailability([SHOP_A])).get(SHOP_A)).toBe(true);
  });

  it('[WTW-07] approveDeposit/rejectDeposit với id của khoản PayOS ⇒ 409 WALLET_DEPOSIT_PAYOS_NOT_MANUAL; id lạ ⇒ 404 như cũ (WTP-24)', async () => {
    const t = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    const approve = await bizError(fx.wallet.approveDeposit(ACCOUNTANT, t.id));
    expect(approve.errorCode).toBe(WALLET_ERR.DEPOSIT_PAYOS_NOT_MANUAL);
    expect(approve.httpStatus).toBe(409);
    const reject = await bizError(fx.wallet.rejectDeposit(ACCOUNTANT, t.id, 'không thấy tiền'));
    expect(reject.errorCode).toBe(WALLET_ERR.DEPOSIT_PAYOS_NOT_MANUAL);
    expect(reject.httpStatus).toBe(409);

    const missing = await bizError(fx.wallet.approveDeposit(ACCOUNTANT, '00000000-0000-4000-8000-0000000000ff'));
    expect(missing.errorCode).toBe(WALLET_ERR.DEPOSIT_NOT_FOUND);
    expect(missing.httpStatus).toBe(404);

    expect(fx.walletOf(SHOP_A)).toBeUndefined();
    expect(String(fx.topupOf(t.id)?.status)).toBe('pending');
  });

  it('[WTW-08] quét mã nguồn src/modules (trừ *.spec.ts): đúng 1 chỗ shopCodWalletTransaction.create( và đúng 1 chỗ shopCodWallet.update( — hàm post', () => {
    const files = sourceFilesUnder(join(__dirname, '../..'));
    const countIn = (f: string, re: RegExp) => (readFileSync(f, 'utf8').match(re) ?? []).length;
    const LEDGER_CREATE = /shopCodWalletTransaction\s*\.\s*create\s*\(/g;
    const WALLET_UPDATE = /shopCodWallet\s*\.\s*update\s*\(/g;
    expect(files.reduce((n, f) => n + countIn(f, LEDGER_CREATE), 0)).toBe(1);
    expect(files.reduce((n, f) => n + countIn(f, WALLET_UPDATE), 0)).toBe(1);
    expect(files.filter((f) => countIn(f, LEDGER_CREATE) > 0).map((f) => basename(f))).toEqual(['shop-wallet.service.ts']);
    expect(files.filter((f) => countIn(f, WALLET_UPDATE) > 0).map((f) => basename(f))).toEqual(['shop-wallet.service.ts']);
  });

  it('[WTW-09] luồng tay giữ nguyên: nộp cọc → duyệt vẫn cộng ví và mở COD ngay cả khi đang có link PayOS mở (WTP-27)', async () => {
    const open = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    const dep = await fx.wallet.requestDeposit(OWNER_A, SHOP_A, { amount: 600_000n, transferRef: 'FT-MANUAL-9' });
    await fx.wallet.approveDeposit(ACCOUNTANT, dep.id);
    expect(String(fx.walletOf(SHOP_A)?.balance)).toBe('600000');
    expect((await fx.wallet.codAvailability([SHOP_A])).get(SHOP_A)).toBe(true);
    expect(fx.ledgerOf(SHOP_A, 'deposit')).toHaveLength(1);
    expect(String(fx.topupOf(open.id)?.status)).toBe('pending');
  });
});

/* Đệ quy liệt kê mã nguồn production (không spec) dưới một thư mục. */
function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFilesUnder(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [p] : [];
  });
}
