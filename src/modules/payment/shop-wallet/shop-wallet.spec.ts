import { BusinessException } from '@common/exception/business.exception';
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
  const system = { settingNumber: jest.fn(() => Promise.resolve(500_000)), setting: jest.fn(() => Promise.resolve('hướng dẫn')) };
  const audit = { write: jest.fn(() => Promise.resolve()) };
  const service = new ShopWalletService(db as unknown as PrismaService, shops as unknown as ShopQueryApi, system as unknown as SystemQueryApi, audit as unknown as PaymentAuditLogService);
  const tx = db as unknown as Parameters<ShopWalletService['applyCodCommission']>[0];
  return { service, tx, wallets, entries, deposits };
}

const deposit = async (s: ReturnType<typeof build>, amount: bigint) => {
  const d = await s.service.requestDeposit(actor, SHOP, { amount, transferRef: 'FT123' });
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
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', gross: 1_000_000n, commissionRate: '10.00' });
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', gross: 1_000_000n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('900000');
    expect(s.entries.filter((e) => e.type === 'cod_commission')).toHaveLength(1);
  });

  it('ví về 0 ⇒ COD đóng; ví âm ⇒ COD đóng, nộp thêm bù số âm trước rồi mới dương mới mở lại', async () => {
    const s = build();
    await deposit(s, 500_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', gross: 5_000_000n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('0');
    expect(await codOpen(s)).toBe(false);

    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH2', gross: 2_000_000n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('-200000');
    expect(await codOpen(s)).toBe(false);

    await deposit(s, 500_000n); // trừ nợ 200k còn 300k
    expect(s.wallets[0].balance.toString()).toBe('300000');
    expect(await codOpen(s)).toBe(true);
  });

  it('nộp vừa đúng số nợ ⇒ ví về 0 và COD vẫn đóng', async () => {
    const s = build();
    await deposit(s, 500_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', gross: 7_000_000n, commissionRate: '10.00' });
    expect(s.wallets[0].balance.toString()).toBe('-200000');
    await s.service.adjust(actor, SHOP, 200_000n, 'bù nợ');
    expect(s.wallets[0].balance.toString()).toBe('0');
    expect(await codOpen(s)).toBe(false);
  });

  it('hoàn tiền đơn COD: trừ ví số hoàn, cộng lại phần hoa hồng tương ứng; idempotent theo mã hoàn', async () => {
    const s = build();
    await deposit(s, 1_000_000n);
    await s.service.applyCodCommission(s.tx, { shopId: SHOP, orderCode: 'DH1', gross: 1_000_000n, commissionRate: '10.00' }); // 900k
    const input = { shopId: SHOP, orderCode: 'DH1', refundId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', amount: 500_000n };
    await s.service.applyCodRefund(s.tx, input);
    await s.service.applyCodRefund(s.tx, input);
    expect(s.wallets[0].balance.toString()).toBe('450000'); // 900k − 500k + 50k hoa hồng hoàn lại
    expect(s.entries.filter((e) => e.type === 'cod_refund')).toHaveLength(1);
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
