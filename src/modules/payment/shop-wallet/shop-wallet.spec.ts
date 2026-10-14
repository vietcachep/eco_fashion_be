import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { PaymentAuditLogService } from '../audit/payment-audit-log.service';
import { WALLET_AUDIT, WALLET_ERR, WALLET_EVENT, WALLET_TX_TYPE } from '../foundation/payment.constants';
import type { PaymentOutboxService } from '../outbox/payment-outbox.service';
import { ShopWalletRepository } from './repository/shop-wallet.repository';
import { ShopWalletService } from './service/shop-wallet.service';

/*
 * Test logic TIỀN của ví quỹ COD. Service + repository chạy THẬT, chỉ thay Prisma bằng DB giả trong bộ nhớ (có khoá ví tuần tự,
 * UNIQUE(shopId,type,orderCode) của sổ cái, updateMany có điều kiện của yêu cầu nộp quỹ) ⇒ kiểm được cả số dư lẫn sổ cái sau nhiều lần gọi.
 */

type Dec = Prisma.Decimal;
const D = (v: string | number): Dec => new Prisma.Decimal(v);
/* expect.objectContaining trả `any` ⇒ bọc về `unknown` để dùng được trong object literal mà không vướng no-unsafe-assignment. */
const contains = (o: Record<string, unknown>): unknown => expect.objectContaining(o);

const SHOP = '11111111-1111-4111-8111-111111111111';
const SHOP_B = '22222222-2222-4222-8222-222222222222';
const actor: AuthenticatedActor = { userId: 'user-admin-1', email: 'admin@fitly.vn', roleCode: 'admin', permissionVersion: 1, tokenId: 'jti-1' };

interface WalletState {
  id: string;
  shopId: string;
  balance: Dec;
}
interface LedgerRow {
  walletId: string;
  shopId: string;
  type: string;
  orderCode: string | null;
  amount: Dec;
  balanceAfter: Dec;
  note: string | null;
  createdBy: string | null;
}
interface DepositState {
  id: string;
  shopId: string;
  amount: Dec;
  status: string;
  proofUrl: string | null;
  note: string | null;
  createdAt: Date;
  decidedBy: string | null;
  decideNote: string | null;
}
interface State {
  wallets: Map<string, WalletState>;
  ledger: LedgerRow[];
  deposits: Map<string, DepositState>;
  /* trạng thái COD của shop phía module shop (mặc định bật) */
  codEnabled: Map<string, boolean>;
  /* hoàn tiền của đơn (bảng refunds) — chỉ phục vụ refundedTotalOfOrder */
  refunds: Array<{ orderCode: string; amount: Dec; status: string }>;
}

/* Ngữ cảnh một transaction giả: nhật ký hoàn tác (rollback) + các khoá dòng ví đang giữ (FOR UPDATE). */
interface TxCtx {
  undo: Array<() => void>;
  held: Map<string, () => void>;
}

function buildFixture() {
  const state: State = { wallets: new Map(), ledger: [], deposits: new Map(), codEnabled: new Map(), refunds: [] };
  let depositSeq = 0;
  const als = new AsyncLocalStorage<TxCtx>();
  const record = (undo: () => void): void => {
    als.getStore()?.undo.push(undo);
  };

  /*
   * SELECT … FOR UPDATE theo shop: transaction nào lấy khoá trước thì giữ tới hết transaction, transaction khác CÙNG shop phải chờ
   * (khác shop chạy song song). Giữ lại cho tới commit/rollback ⇒ test race có ý nghĩa: bỏ `lockWallet` khỏi service là test race đỏ ngay.
   */
  const tails = new Map<string, Promise<void>>();
  const lockRow = async (shopId: string): Promise<void> => {
    const ctx = als.getStore();
    if (!ctx || ctx.held.has(shopId)) return;
    const prev = tails.get(shopId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(
      shopId,
      prev.then(() => mine),
    );
    await prev;
    ctx.held.set(shopId, release);
  };

  const db = {
    /* INSERT … ON CONFLICT DO NOTHING */
    $executeRaw: jest.fn((_s: TemplateStringsArray, shopId: string) => {
      if (!state.wallets.has(shopId)) {
        state.wallets.set(shopId, { id: `wallet-${shopId.slice(0, 4)}`, shopId, balance: D(0) });
        record(() => state.wallets.delete(shopId));
      }
      return Promise.resolve(1);
    }),
    /* SELECT … FOR UPDATE */
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, shopId: string) => {
      await lockRow(shopId);
      const w = state.wallets.get(shopId);
      return w ? [{ id: w.id, shop_id: w.shopId, balance: w.balance.toString() }] : [];
    }),
    shopWallet: {
      findUnique: jest.fn(({ where }: { where: { shopId: string } }) => Promise.resolve(state.wallets.get(where.shopId) ?? null)),
      update: jest.fn(({ where, data }: { where: { id: string }; data: { balance: Dec } }) => {
        const w = [...state.wallets.values()].find((x) => x.id === where.id);
        if (!w) return Promise.reject(new Error('ví không tồn tại'));
        const prev = w.balance;
        w.balance = data.balance;
        record(() => {
          w.balance = prev;
        });
        return Promise.resolve(w);
      }),
    },
    shopWalletTransaction: {
      count: jest.fn(({ where }: { where: { shopId: string; type: string; orderCode: string } }) =>
        Promise.resolve(state.ledger.filter((r) => r.shopId === where.shopId && r.type === where.type && r.orderCode === where.orderCode).length),
      ),
      findMany: jest.fn(({ where }: { where: { type: string; orderCode: { in: string[] } } }) =>
        Promise.resolve(state.ledger.filter((r) => r.type === where.type && r.orderCode !== null && where.orderCode.in.includes(r.orderCode)).map((r) => ({ orderCode: r.orderCode }))),
      ),
      /* Postgres: NULL order_code không bao giờ "trùng" nhau; skipDuplicates = ON CONFLICT DO NOTHING (không phá transaction). */
      createMany: jest.fn(({ data, skipDuplicates }: { data: LedgerRow[]; skipDuplicates?: boolean }) => {
        const added: LedgerRow[] = [];
        for (const row of data) {
          const dup = row.orderCode !== null && state.ledger.some((r) => r.shopId === row.shopId && r.type === row.type && r.orderCode === row.orderCode);
          if (dup) {
            if (skipDuplicates) continue;
            return Promise.reject(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
          }
          const stored = { ...row };
          state.ledger.push(stored);
          added.push(stored);
        }
        record(() => {
          state.ledger = state.ledger.filter((r) => !added.includes(r));
        });
        return Promise.resolve({ count: added.length });
      }),
    },
    shopWalletDepositRequest: {
      findFirst: jest.fn(({ where }: { where: { shopId: string; status: string } }) => {
        const d = [...state.deposits.values()].find((x) => x.shopId === where.shopId && x.status === where.status);
        return Promise.resolve(d ? { ...d } : null);
      }),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const d = state.deposits.get(where.id);
        return Promise.resolve(d ? { ...d } : null);
      }),
      create: jest.fn(({ data }: { data: { shopId: string; amount: Dec; proofUrl: string | null; note: string | null; createdBy: string } }) => {
        const id = `dep-${++depositSeq}`;
        state.deposits.set(id, { id, shopId: data.shopId, amount: data.amount, status: 'pending', proofUrl: data.proofUrl, note: data.note, createdAt: new Date(), decidedBy: null, decideNote: null });
        record(() => state.deposits.delete(id));
        return Promise.resolve({ id });
      }),
      /* where {id, status:'pending'} — chỉ người đến trước thắng */
      updateMany: jest.fn(({ where, data }: { where: { id: string; status: string }; data: { status: string; decidedBy: string; decideNote: string | null } }) => {
        const d = state.deposits.get(where.id);
        if (!d || d.status !== where.status) return Promise.resolve({ count: 0 });
        const prev = { ...d };
        d.status = data.status;
        d.decidedBy = data.decidedBy;
        d.decideNote = data.decideNote;
        record(() => {
          Object.assign(d, prev);
        });
        return Promise.resolve({ count: 1 });
      }),
    },
    /* Transaction chạy song song được (khác shop); lỗi ⇒ hoàn tác mọi ghi của chính transaction đó; khoá dòng nhả khi kết thúc. */
    refund: {
      aggregate: jest.fn(({ where }: { where: { orderCode: string; status: string } }) => {
        const rows = state.refunds.filter((r) => r.orderCode === where.orderCode && r.status === where.status);
        return Promise.resolve({ _sum: { amount: rows.length ? rows.reduce((a, r) => a.add(r.amount), D(0)) : null } });
      }),
    },
    $transaction: undefined as unknown as jest.Mock,
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const ctx: TxCtx = { undo: [], held: new Map() };
    try {
      return await als.run(ctx, () => fn(db));
    } catch (err) {
      for (const undo of ctx.undo.reverse()) undo();
      throw err;
    } finally {
      for (const release of ctx.held.values()) release();
    }
  });

  const gateway = {
    setCodEnabled: jest.fn((shopId: string, enabled: boolean) => {
      const prev = state.codEnabled.get(shopId) ?? true;
      state.codEnabled.set(shopId, enabled);
      record(() => {
        state.codEnabled.set(shopId, prev);
      });
      return Promise.resolve(prev !== enabled);
    }),
  };
  const audit = { write: jest.fn((_tx: unknown, _actor: unknown, _entry: unknown) => Promise.resolve()) };
  const outbox = { publish: jest.fn((_tx: unknown, _input: { eventType: string }) => Promise.resolve()) };

  const repo = new ShopWalletRepository(db as unknown as PrismaService);
  const service = new ShopWalletService(db as unknown as PrismaService, repo, audit as unknown as PaymentAuditLogService, outbox as unknown as PaymentOutboxService, gateway);

  return {
    db,
    state,
    gateway,
    audit,
    outbox,
    service,
    seedWallet(shopId: string, balance: number) {
      state.wallets.set(shopId, { id: `wallet-${shopId.slice(0, 4)}`, shopId, balance: D(balance) });
    },
    seedDeposit(id: string, shopId: string, amount: number, status = 'pending') {
      state.deposits.set(id, { id, shopId, amount: D(amount), status, proofUrl: null, note: null, createdAt: new Date(), decidedBy: null, decideNote: null });
    },
    seedRefund(orderCode: string, amount: number, status = 'done') {
      state.refunds.push({ orderCode, amount: D(amount), status });
    },
    balance: (shopId: string) => state.wallets.get(shopId)?.balance.toString(),
    ledger: (shopId: string) =>
      state.ledger
        .filter((r) => r.shopId === shopId)
        .map((r) => ({ type: r.type, orderCode: r.orderCode, amount: r.amount.toString(), balanceAfter: r.balanceAfter.toString(), note: r.note, createdBy: r.createdBy })),
    outboxTypes: () => outbox.publish.mock.calls.map((c) => c[1].eventType),
  };
}


/* Bắt lỗi nghiệp vụ để kiểm cả errorCode lẫn HTTP status. */
async function catchBusiness(p: Promise<unknown>): Promise<BusinessException> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BusinessException);
    return e as BusinessException;
  }
  throw new Error('Mong đợi BusinessException nhưng promise resolve');
}

describe('ShopWalletService — ví quỹ COD', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /* ============================================================ */
  describe('ensureWallet', () => {
    it('shop mới: tạo ví số dư 0 rồi áp luật "ví ≤ 0 ⇒ khoá COD": setCodEnabled(false) + outbox WALLET_COD_DISABLED', async () => {
      const f = buildFixture();

      await f.service.ensureWallet(SHOP);

      expect(f.balance(SHOP)).toBe('0');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.outbox.publish).toHaveBeenCalledTimes(1);
      expect(f.outbox.publish).toHaveBeenCalledWith(expect.anything(), contains({ eventType: WALLET_EVENT.COD_DISABLED, aggregateType: 'ShopWallet', payload: { shopId: SHOP, balance: '0' } }));
    });

    it('COD đã tắt sẵn (gateway báo không đổi) ⇒ vẫn gọi setCodEnabled(false) nhưng KHÔNG phát outbox lần nữa', async () => {
      const f = buildFixture();
      f.state.codEnabled.set(SHOP, false);
      await f.service.ensureWallet(SHOP);
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.outbox.publish).not.toHaveBeenCalled();
    });

    it('gọi lại không ghi đè số dư; ví đã có tiền > 0 ⇒ mở COD (+ COD_ENABLED khi đang tắt)', async () => {
      const f = buildFixture();
      await f.service.ensureWallet(SHOP); // ví 0 ⇒ khoá
      f.state.wallets.get(SHOP)!.balance = D(5000);

      await f.service.ensureWallet(SHOP);

      expect(f.balance(SHOP)).toBe('5000');
      expect(f.gateway.setCodEnabled).toHaveBeenLastCalledWith(SHOP, true, expect.anything());
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.COD_DISABLED, WALLET_EVENT.COD_ENABLED]);
    });

    it('ví đang ÂM ⇒ giữ khoá, số dư không đổi (ensureWallet không "sửa" nợ)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -7_000);
      await f.service.ensureWallet(SHOP);
      expect(f.balance(SHOP)).toBe('-7000');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.state.ledger).toHaveLength(0);
    });

    it('chạy trong MỘT transaction: khoá dòng ví TRƯỚC khi đổi COD, gateway nhận đúng tx', async () => {
      const f = buildFixture();
      await f.service.ensureWallet(SHOP);
      expect(f.db.$transaction).toHaveBeenCalledTimes(1);
      expect(f.db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(f.gateway.setCodEnabled.mock.invocationCallOrder[0]);
    });

    it('gateway lỗi ⇒ rollback: không để lại ví mồ côi, gọi lại được', async () => {
      const f = buildFixture();
      f.gateway.setCodEnabled.mockRejectedValueOnce(new Error('shop service chết'));
      await expect(f.service.ensureWallet(SHOP)).rejects.toThrow('shop service chết');
      expect(f.state.wallets.size).toBe(0);
      await f.service.ensureWallet(SHOP);
      expect(f.balance(SHOP)).toBe('0');
    });

    it('hai lần ensureWallet đồng thời chỉ ra MỘT ví và COD_DISABLED phát một lần', async () => {
      const f = buildFixture();
      await Promise.all([f.service.ensureWallet(SHOP), f.service.ensureWallet(SHOP)]);
      expect(f.state.wallets.size).toBe(1);
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.COD_DISABLED]);
    });
  });

  /* ============================================================ */
  describe('hasCodCommission', () => {
    it('false khi chưa có dòng hoa hồng; true sau khi chargeCodCommission đúng (shop, đơn)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      expect(await f.service.hasCodCommission(SHOP, 'DH-1')).toBe(false);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: 1_000 });
      expect(await f.service.hasCodCommission(SHOP, 'DH-1')).toBe(true);
    });

    it('đúng theo (shop, đơn): đơn khác hoặc shop khác không tính', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: 1_000 });
      expect(await f.service.hasCodCommission(SHOP, 'DH-2')).toBe(false);
      expect(await f.service.hasCodCommission(SHOP_B, 'DH-1')).toBe(false);
    });

    it('khoản ròng bằng 0 (không ghi sổ cái) ⇒ vẫn false', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: 0 });
      expect(await f.service.hasCodCommission(SHOP, 'DH-1')).toBe(false);
    });

    it('chỉ tính loại cod_commission: dòng cod_refund / deposit / adjust (kể cả trùng chuỗi mã) KHÔNG làm kết quả thành true', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      await f.service.recordCodRefund({ shopId: SHOP, orderCode: 'DH-1', refundKey: 'DH-1', amount: 1_000, commissionReversal: 0 });
      expect(await f.service.hasCodCommission(SHOP, 'DH-1')).toBe(false);
    });

    it('truy vấn count đúng điều kiện (shopId, type = cod_commission, orderCode)', async () => {
      const f = buildFixture();
      await f.service.hasCodCommission(SHOP, 'DH-9');
      expect(f.db.shopWalletTransaction.count).toHaveBeenCalledWith({ where: { shopId: SHOP, type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: 'DH-9' } });
    });
  });

  /* ============================================================ */
  describe('chargedOrderCodes', () => {
    it('mảng rỗng ⇒ Set rỗng, KHÔNG truy vấn DB', async () => {
      const f = buildFixture();
      const r = await f.service.chargedOrderCodes([]);
      expect(r.size).toBe(0);
      expect(f.db.shopWalletTransaction.findMany).not.toHaveBeenCalled();
    });

    it('trả đúng những mã đã có dòng hoa hồng (mọi shop); bỏ mã chưa có và mã ngoài danh sách', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      f.seedWallet(SHOP_B, 100_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: 1_000 });
      await f.service.chargeCodCommission({ shopId: SHOP_B, orderCode: 'DH-2', amount: 1_000 });
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-NGOAI', amount: 1_000 });

      const r = await f.service.chargedOrderCodes(['DH-1', 'DH-2', 'DH-3']);

      expect([...r].sort()).toEqual(['DH-1', 'DH-2']);
      expect(f.db.shopWalletTransaction.findMany).toHaveBeenCalledWith(contains({ where: { type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: { in: ['DH-1', 'DH-2', 'DH-3'] } } }));
    });

    it('bỏ qua dòng khác loại dù trùng mã (cod_refund / deposit / adjust)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      await f.service.recordCodRefund({ shopId: SHOP, orderCode: 'DH-1', refundKey: 'DH-1', amount: 1_000, commissionReversal: 0 });
      expect((await f.service.chargedOrderCodes(['DH-1'])).size).toBe(0);
    });
  });

  /* ============================================================ */
  describe('refundedTotalOfOrder', () => {
    it('cộng mọi khoản hoàn `done` của đơn; bỏ qua requested/processing/failed và đơn khác', async () => {
      const f = buildFixture();
      f.seedRefund('DH-1', 100_000);
      f.seedRefund('DH-1', 50_000);
      f.seedRefund('DH-1', 999_999, 'processing');
      f.seedRefund('DH-1', 888_888, 'failed');
      f.seedRefund('DH-2', 7_000);

      const total = await f.service.refundedTotalOfOrder('DH-1');

      expect(total.toString()).toBe('150000');
      expect(f.db.refund.aggregate).toHaveBeenCalledWith({ _sum: { amount: true }, where: { orderCode: 'DH-1', status: 'done' } });
    });

    it('chưa có hoàn tiền ⇒ Decimal 0 (không null/NaN)', async () => {
      const f = buildFixture();
      const total = await f.service.refundedTotalOfOrder('DH-1');
      expect(Prisma.Decimal.isDecimal(total)).toBe(true);
      expect(total.toString()).toBe('0');
    });
  });

  /* ============================================================ */
  describe('recordCodRefund', () => {
    const refund = (over: Partial<{ shopId: string; orderCode: string; refundKey: string; amount: string | number; commissionReversal: string | number }> = {}) => ({
      shopId: SHOP,
      orderCode: 'DH-1',
      refundKey: 'RF-aaaa',
      amount: 250_000,
      commissionReversal: 25_000,
      ...over,
    });

    it('ghi nợ số hoàn trừ hoa hồng hoàn lại: delta = round(reversal) − round(amount); sổ cái cod_refund khoá theo refundKey; audit; trả true', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000_000);

      expect(await f.service.recordCodRefund(refund())).toBe(true);

      expect(f.balance(SHOP)).toBe('775000'); // −250.000 + 25.000
      expect(f.ledger(SHOP)).toEqual([contains({ type: WALLET_TX_TYPE.COD_REFUND, orderCode: 'RF-aaaa', amount: '-225000', balanceAfter: '775000', createdBy: null })]);
      expect(f.state.ledger[0].note).toContain('DH-1');
      expect(f.audit.write).toHaveBeenCalledWith(
        expect.anything(),
        null,
        contains({ action: WALLET_AUDIT.COD_REFUND, entityType: 'ShopWallet', entityCode: 'DH-1', before: { balance: '1000000' }, after: { balance: '775000', refund: '250000', commissionReversal: '25000', shopId: SHOP } }),
      );
      expect(f.db.shopWalletTransaction.createMany).toHaveBeenCalledWith(contains({ skipDuplicates: true }));
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, true, expect.anything()); // ví còn dương ⇒ COD giữ bật
      expect(f.outbox.publish).not.toHaveBeenCalled();
    });

    it.each([
      ['amount lẻ 100.5 ⇒ 101; reversal 10.4 ⇒ 10', '100.5', '10.4', '-91'],
      ['amount 0.5 ⇒ 1; reversal 0 ⇒ 0', '0.5', 0, '-1'],
      ['reversal 25000.5 ⇒ 25001', 250_000, '25000.5', '-224999'],
      ['reversal ÂM (sàn đòi thêm hoa hồng): −3000', 250_000, '-3000', '-253000'],
      ['reversal 0 (hoàn trước khi có hoa hồng)', 40_000, 0, '-40000'],
    ])('làm tròn nửa lên từng vế rồi mới trừ: %s', async (_label, amount, commissionReversal, delta) => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000_000);
      await f.service.recordCodRefund(refund({ amount, commissionReversal }));
      expect(f.ledger(SHOP)[0].amount).toBe(delta);
      expect(f.balance(SHOP)).toBe(D(1_000_000).add(delta).toString());
    });

    it.each([
      ['reversal = amount', 100, 100],
      ['cả hai lẻ cùng làm tròn về 11', '10.5', '11'],
      ['cả hai < 0.5 ⇒ 0', '0.4', '0.4'],
      ['cả hai bằng 0', 0, 0],
    ])('delta = 0 (%s) ⇒ trả false, không mở transaction, không ghi sổ cái', async (_label, amount, commissionReversal) => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      expect(await f.service.recordCodRefund(refund({ amount, commissionReversal }))).toBe(false);
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.state.ledger).toHaveLength(0);
      expect(f.balance(SHOP)).toBe('100000');
    });

    it('delta ÂM làm ví ≤ 0 ⇒ khoá COD ngay + outbox WALLET_COD_DISABLED (số dư âm lưu đúng)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);

      await f.service.recordCodRefund(refund()); // −225.000

      expect(f.balance(SHOP)).toBe('-125000');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.outbox.publish).toHaveBeenCalledWith(expect.anything(), contains({ eventType: WALLET_EVENT.COD_DISABLED, payload: { shopId: SHOP, balance: '-125000' } }));
    });

    it('delta âm về ĐÚNG 0 ⇒ vẫn khoá (chỉ mở khi ví > 0)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 225_000);
      await f.service.recordCodRefund(refund());
      expect(f.balance(SHOP)).toBe('0');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
    });

    it('COD đã khoá sẵn mà ví tiếp tục giảm ⇒ không phát lại COD_DISABLED', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -1_000);
      f.state.codEnabled.set(SHOP, false);
      await f.service.recordCodRefund(refund({ amount: 10_000, commissionReversal: 0 }));
      expect(f.balance(SHOP)).toBe('-11000');
      expect(f.outbox.publish).not.toHaveBeenCalled();
    });

    it('reversal > amount ⇒ delta DƯƠNG cộng ví (sàn hoàn nhiều hoa hồng hơn số hoàn); đưa ví lên > 0 thì MỞ LẠI COD', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -400);
      f.state.codEnabled.set(SHOP, false);

      expect(await f.service.recordCodRefund(refund({ amount: 1_000, commissionReversal: 1_500 }))).toBe(true);

      expect(f.balance(SHOP)).toBe('100');
      expect(f.ledger(SHOP)[0]).toMatchObject({ type: WALLET_TX_TYPE.COD_REFUND, amount: '500', balanceAfter: '100' });
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, true, expect.anything());
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.COD_ENABLED]);
    });

    it('delta dương nhưng ví vẫn ≤ 0 ⇒ COD vẫn khoá', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -5_000);
      f.state.codEnabled.set(SHOP, false);
      await f.service.recordCodRefund(refund({ amount: 1_000, commissionReversal: 1_500 }));
      expect(f.balance(SHOP)).toBe('-4500');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.outbox.publish).not.toHaveBeenCalled();
    });

    it('idempotent theo (shop, cod_refund, refundKey): gọi lại ⇒ false, KHÔNG đổi số dư, không thêm sổ cái/audit/đổi COD', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000_000);
      await f.service.recordCodRefund(refund());
      f.audit.write.mockClear();
      f.gateway.setCodEnabled.mockClear();

      expect(await f.service.recordCodRefund(refund())).toBe(false);

      expect(f.balance(SHOP)).toBe('775000');
      expect(f.ledger(SHOP)).toHaveLength(1);
      expect(f.audit.write).not.toHaveBeenCalled();
      expect(f.gateway.setCodEnabled).not.toHaveBeenCalled();
    });

    it('cùng refundKey nhưng số tiền khác vẫn bị chặn (khoá theo refundKey, không theo số tiền)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000_000);
      await f.service.recordCodRefund(refund({ amount: 1_000, commissionReversal: 0 }));
      expect(await f.service.recordCodRefund(refund({ amount: 999_999, commissionReversal: 0 }))).toBe(false);
      expect(f.balance(SHOP)).toBe('999000');
    });

    it('hai sự kiện PAYMENT_REFUNDED đồng thời cùng refundKey chỉ ghi MỘT lần', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000_000);
      const results = await Promise.all([f.service.recordCodRefund(refund()), f.service.recordCodRefund(refund())]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(f.balance(SHOP)).toBe('775000');
      expect(f.ledger(SHOP)).toHaveLength(1);
    });

    it('nhiều lần hoàn KHÁC refundKey của cùng đơn: mỗi lần một dòng, balanceAfter cộng dồn đúng', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000_000);
      await f.service.recordCodRefund(refund({ refundKey: 'RF-1', amount: 100_000, commissionReversal: 10_000 }));
      await f.service.recordCodRefund(refund({ refundKey: 'RF-2', amount: 200_000, commissionReversal: 20_000 }));
      expect(f.ledger(SHOP).map((r) => [r.orderCode, r.amount, r.balanceAfter])).toEqual([
        ['RF-1', '-90000', '910000'],
        ['RF-2', '-180000', '730000'],
      ]);
    });

    it('cùng refundKey ở HAI shop khác nhau là hai khoản độc lập', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      f.seedWallet(SHOP_B, 100_000);
      expect(await f.service.recordCodRefund(refund({ amount: 1_000, commissionReversal: 0 }))).toBe(true);
      expect(await f.service.recordCodRefund(refund({ shopId: SHOP_B, amount: 2_000, commissionReversal: 0 }))).toBe(true);
      expect(f.balance(SHOP)).toBe('99000');
      expect(f.balance(SHOP_B)).toBe('98000');
    });

    it('không đụng độ với dòng hoa hồng: refundKey trùng chuỗi với mã đơn của cod_commission vẫn ghi được (khác loại)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'RF-x', amount: 1_000 });
      expect(await f.service.recordCodRefund(refund({ refundKey: 'RF-x', amount: 1_000, commissionReversal: 0 }))).toBe(true);
      expect(f.ledger(SHOP).map((r) => r.type)).toEqual([WALLET_TX_TYPE.COD_COMMISSION, WALLET_TX_TYPE.COD_REFUND]);
    });

    it('shop chưa có ví: tự tạo ví 0 rồi ghi nợ ⇒ ví âm và khoá COD', async () => {
      const f = buildFixture();
      expect(await f.service.recordCodRefund(refund({ amount: 5_000, commissionReversal: 500 }))).toBe(true);
      expect(f.balance(SHOP)).toBe('-4500');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
    });

    it('lỗi giữa chừng (audit ném) ⇒ rollback sạch, thử lại sau đó ghi bình thường (không kẹt vì dòng sổ cái ma)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      f.audit.write.mockRejectedValueOnce(new Error('audit chết'));
      await expect(f.service.recordCodRefund(refund())).rejects.toThrow('audit chết');
      expect(f.balance(SHOP)).toBe('100000');
      expect(f.state.ledger).toHaveLength(0);
      expect(await f.service.recordCodRefund(refund())).toBe(true);
      expect(f.balance(SHOP)).toBe('-125000');
    });
  });

  /* ============================================================ */
  describe('chargeCodCommission', () => {
    it('trừ ví đúng số, ghi sổ cái số ÂM + balanceAfter + audit; ví còn dương thì giữ COD bật và KHÔNG phát outbox', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000_000);

      const ok = await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(25_000) });

      expect(ok).toBe(true);
      expect(f.balance(SHOP)).toBe('975000');
      expect(f.ledger(SHOP)).toEqual([{ type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: 'DH-1', amount: '-25000', balanceAfter: '975000', note: 'Hoa hồng COD đơn DH-1', createdBy: null }]);
      expect(f.db.shopWalletTransaction.createMany).toHaveBeenCalledWith(contains({ skipDuplicates: true }));
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, true, expect.anything());
      expect(f.audit.write).toHaveBeenCalledWith(
        expect.anything(),
        null,
        contains({ action: WALLET_AUDIT.COD_COMMISSION, entityCode: 'DH-1', before: { balance: '1000000' }, after: contains({ balance: '975000', commission: '25000', shopId: SHOP }) }),
      );
      expect(f.outbox.publish).not.toHaveBeenCalled(); // COD đã bật sẵn, không đổi trạng thái ⇒ không có sự kiện
    });

    it('gọi LẠI cùng (shopId, orderCode) ⇒ trả false, KHÔNG đổi số dư, không thêm sổ cái/audit/đổi COD', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(25_000) });
      f.audit.write.mockClear();
      f.gateway.setCodEnabled.mockClear();

      const again = await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(25_000) });

      expect(again).toBe(false);
      expect(f.balance(SHOP)).toBe('975000');
      expect(f.ledger(SHOP)).toHaveLength(1);
      expect(f.audit.write).not.toHaveBeenCalled();
      expect(f.gateway.setCodEnabled).not.toHaveBeenCalled();
    });

    it('gọi lại với số tiền KHÁC nhưng cùng đơn vẫn bị chặn (khoá theo mã đơn, không theo số tiền)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(10_000) });
      const again = await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(99_999) });
      expect(again).toBe(false);
      expect(f.balance(SHOP)).toBe('90000');
    });

    it('hai sự kiện "completed" đồng thời cho cùng đơn chỉ trừ MỘT lần', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      const results = await Promise.all([f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(30_000) }), f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(30_000) })]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(f.balance(SHOP)).toBe('70000');
      expect(f.ledger(SHOP)).toHaveLength(1);
    });

    it('cùng mã đơn nhưng KHÁC shop vẫn là hai khoản độc lập', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      f.seedWallet(SHOP_B, 100_000);
      expect(await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(10_000) })).toBe(true);
      expect(await f.service.chargeCodCommission({ shopId: SHOP_B, orderCode: 'DH-1', amount: D(20_000) })).toBe(true);
      expect(f.balance(SHOP)).toBe('90000');
      expect(f.balance(SHOP_B)).toBe('80000');
    });

    it.each([
      ['Decimal 0', D(0)],
      ['chuỗi "0"', '0'],
      ['số 0', 0],
    ])('khoản ròng = 0 (%s) ⇒ trả false, không mở transaction, không đụng ví', async (_label, amount) => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      const ok = await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount });
      expect(ok).toBe(false);
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.balance(SHOP)).toBe('100000');
      expect(f.state.ledger).toHaveLength(0);
      expect(f.gateway.setCodEnabled).not.toHaveBeenCalled();
    });

    /* Sổ cái là VND nguyên: làm tròn NỬA LÊN ngay từ đầu để ledger.amount, balanceAfter và số dư lưu luôn khớp (không còn phần lẻ). */
    it.each([
      ['10.5 ⇒ 11', D('10.5'), '-11', '99989'],
      ['"10.49" ⇒ 10', '10.49', '-10', '99990'],
      ['2.5 ⇒ 3', 2.5, '-3', '99997'],
      ['-10.5 ⇒ cộng 11', D('-10.5'), '11', '100011'],
    ])('khoản lẻ %s: làm tròn nửa lên, số dư và sổ cái đều là số nguyên', async (_label, amount, ledgerAmount, balanceAfter) => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);

      expect(await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount })).toBe(true);

      expect(f.ledger(SHOP)).toEqual([contains({ amount: ledgerAmount, balanceAfter })]);
      expect(f.balance(SHOP)).toBe(balanceAfter);
      expect(f.audit.write).toHaveBeenCalledWith(expect.anything(), null, contains({ after: contains({ balance: balanceAfter }) }));
    });

    it.each([
      ['0.4', D('0.4')],
      ['"0.49"', '0.49'],
      ['-0.4', D('-0.4')],
    ])('khoản lẻ %s làm tròn về 0 ⇒ coi như khoản 0: trả false, không mở transaction, không ghi sổ cái', async (_label, amount) => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      expect(await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount })).toBe(false);
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.balance(SHOP)).toBe('100000');
      expect(f.state.ledger).toHaveLength(0);
    });

    it('khoản 0.5 làm tròn LÊN thành 1 (không bị bỏ qua như 0.4)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100);
      expect(await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: '0.5' })).toBe(true);
      expect(f.balance(SHOP)).toBe('99');
    });

    /* Khoản ròng ÂM = voucher sàn chịu lớn hơn hoa hồng ⇒ sàn hoàn phần chênh vào ví (cộng ví). */
    it('khoản ròng ÂM ⇒ CỘNG ví: sổ cái số DƯƠNG, balanceAfter đúng, vẫn idempotent theo đơn', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);

      expect(await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(-5_000) })).toBe(true);

      expect(f.balance(SHOP)).toBe('105000');
      expect(f.ledger(SHOP)).toEqual([{ type: WALLET_TX_TYPE.COD_COMMISSION, orderCode: 'DH-1', amount: '5000', balanceAfter: '105000', note: 'Hoa hồng COD đơn DH-1', createdBy: null }]);
      expect(f.audit.write).toHaveBeenCalledWith(expect.anything(), null, contains({ after: contains({ balance: '105000', commission: '-5000' }) }));

      expect(await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(-5_000) })).toBe(false); // lặp sự kiện
      expect(f.balance(SHOP)).toBe('105000');
      expect(f.ledger(SHOP)).toHaveLength(1);
    });

    it('khoản ròng ÂM đưa ví từ ≤ 0 lên > 0 ⇒ MỞ LẠI COD (+ outbox COD_ENABLED)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -2_000);
      f.state.codEnabled.set(SHOP, false);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(-5_000) });
      expect(f.balance(SHOP)).toBe('3000');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, true, expect.anything());
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.COD_ENABLED]);
    });

    it('khoản ròng ÂM nhưng ví vẫn ≤ 0 ⇒ COD vẫn khoá', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -10_000);
      f.state.codEnabled.set(SHOP, false);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(-4_000) });
      expect(f.balance(SHOP)).toBe('-6000');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.outbox.publish).not.toHaveBeenCalled();
    });

    it('nhận số tiền dạng chuỗi hoặc number', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: '12345' });
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-2', amount: 55 });
      expect(f.balance(SHOP)).toBe('87600');
    });

    it('nhiều đơn liên tiếp: số dư cộng dồn đúng và balanceAfter của từng dòng khớp', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(30_000) });
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-2', amount: D(30_000) });
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-3', amount: D(10_000) });
      expect(f.ledger(SHOP).map((r) => [r.amount, r.balanceAfter])).toEqual([
        ['-30000', '70000'],
        ['-30000', '40000'],
        ['-10000', '30000'],
      ]);
      expect(f.balance(SHOP)).toBe('30000');
    });

    it('shop chưa có ví: tự tạo ví (0) rồi trừ ⇒ ví ÂM và khoá COD ngay', async () => {
      const f = buildFixture();
      const ok = await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(8_000) });
      expect(ok).toBe(true);
      expect(f.balance(SHOP)).toBe('-8000');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
    });

    it('ví về ĐÚNG 0 ⇒ khoá COD (setCodEnabled false) và phát WALLET_COD_DISABLED khi gateway báo đổi thật', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000_000);

      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(1_000_000) });

      expect(f.balance(SHOP)).toBe('0');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.outbox.publish).toHaveBeenCalledTimes(1);
      expect(f.outbox.publish).toHaveBeenCalledWith(expect.anything(), contains({ eventType: WALLET_EVENT.COD_DISABLED, aggregateType: 'ShopWallet', payload: { shopId: SHOP, balance: '0' } }));
    });

    it('ví về ÂM: lưu số âm đúng (không chặn ở 0), khoá COD', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 10_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(25_000) });
      expect(f.balance(SHOP)).toBe('-15000');
      expect(f.ledger(SHOP)[0].balanceAfter).toBe('-15000');
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.COD_DISABLED]);
    });

    it('COD đã bị khoá từ trước (gateway trả false) ⇒ vẫn gọi setCodEnabled(false) nhưng KHÔNG phát outbox lần nữa', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -1_000);
      f.state.codEnabled.set(SHOP, false);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-9', amount: D(5_000) });
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.outbox.publish).not.toHaveBeenCalled();
      expect(f.balance(SHOP)).toBe('-6000');
    });

    it('ví > 0 ⇒ setCodEnabled(true); nếu COD đang tắt thật thì phát WALLET_COD_ENABLED', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 50_000);
      f.state.codEnabled.set(SHOP, false); // lệch trạng thái: ví dương mà COD đang tắt
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(1_000) });
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, true, expect.anything());
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.COD_ENABLED]);
    });

    it('lỗi giữa chừng (audit ném) ⇒ rollback: số dư và sổ cái không đổi', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      f.audit.write.mockRejectedValueOnce(new Error('audit chết'));
      await expect(f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(10_000) })).rejects.toThrow('audit chết');
      expect(f.balance(SHOP)).toBe('100000');
      expect(f.state.ledger).toHaveLength(0);
      // thử lại sau đó trừ bình thường (không bị "kẹt" idempotency do dòng sổ cái ma)
      expect(await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: D(10_000) })).toBe(true);
      expect(f.balance(SHOP)).toBe('90000');
    });
  });

  /* ============================================================ */
  describe('createDepositRequest', () => {
    it.each([
      ['0', D(0)],
      ['âm', D(-1000)],
      ['không nguyên (1000.5)', D('1000.5')],
      ['chuỗi không nguyên', '99.9'],
      ['số thập phân', 0.5],
    ])('số tiền %s ⇒ INVALID_AMOUNT (400), không tạo yêu cầu', async (_label, amount) => {
      const f = buildFixture();
      const err = await catchBusiness(f.service.createDepositRequest(SHOP, amount, actor));
      expect(err.errorCode).toBe(WALLET_ERR.INVALID_AMOUNT);
      expect(err.httpStatus).toBe(400);
      expect(f.db.shopWalletDepositRequest.create).not.toHaveBeenCalled();
    });

    it('đã có yêu cầu pending ⇒ DEPOSIT_PENDING_EXISTS (409), không tạo thêm', async () => {
      const f = buildFixture();
      f.seedDeposit('dep-old', SHOP, 100_000, 'pending');
      const err = await catchBusiness(f.service.createDepositRequest(SHOP, D(50_000), actor));
      expect(err.errorCode).toBe(WALLET_ERR.DEPOSIT_PENDING_EXISTS);
      expect(err.httpStatus).toBe(409);
      expect(f.db.shopWalletDepositRequest.create).not.toHaveBeenCalled();
      expect(f.state.deposits.size).toBe(1);
      expect(f.audit.write).not.toHaveBeenCalled();
    });

    /*
     * Chống race "một yêu cầu chờ duyệt mỗi lúc": service khoá dòng ví (FOR UPDATE) TRƯỚC khi kiểm pending rồi mới chèn. DB giả giữ khoá
     * tới hết transaction ⇒ hai request song song của cùng shop chạy tuần tự (bỏ lockWallet khỏi service là test này đỏ).
     */
    it('hai yêu cầu nộp quỹ ĐỒNG THỜI của cùng shop: chỉ MỘT yêu cầu pending, request còn lại nhận DEPOSIT_PENDING_EXISTS', async () => {
      const f = buildFixture();

      const results = await Promise.allSettled([f.service.createDepositRequest(SHOP, 50_000, actor), f.service.createDepositRequest(SHOP, 50_000, actor)]);

      expect([...f.state.deposits.values()].filter((d) => d.shopId === SHOP && d.status === 'pending')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as BusinessException).errorCode).toBe(WALLET_ERR.DEPOSIT_PENDING_EXISTS);
      expect(f.audit.write).toHaveBeenCalledTimes(1); // request thua không để lại audit
    });

    it('(kiểm chứng DB giả) nếu KHÔNG khoá ví thì race xảy ra thật — test race ở trên có khả năng phát hiện lỗi', async () => {
      jest.spyOn(ShopWalletRepository.prototype, 'lockWallet').mockResolvedValue({ id: 'wallet-x', shopId: SHOP, balance: D(0) });
      const f = buildFixture();
      await Promise.allSettled([f.service.createDepositRequest(SHOP, 50_000, actor), f.service.createDepositRequest(SHOP, 50_000, actor)]);
      expect([...f.state.deposits.values()].filter((d) => d.status === 'pending')).toHaveLength(2);
    });

    it('ba request đồng thời ⇒ vẫn chỉ một pending', async () => {
      const f = buildFixture();
      await Promise.allSettled([1, 2, 3].map(() => f.service.createDepositRequest(SHOP, 10_000, actor)));
      expect([...f.state.deposits.values()].filter((d) => d.status === 'pending')).toHaveLength(1);
    });

    it('khoá ví theo từng shop: hai shop khác nhau nộp quỹ đồng thời đều thành công', async () => {
      const f = buildFixture();
      const results = await Promise.allSettled([f.service.createDepositRequest(SHOP, 50_000, actor), f.service.createDepositRequest(SHOP_B, 70_000, actor)]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect([...f.state.deposits.values()].map((d) => [d.shopId, d.amount.toString()])).toEqual([
        [SHOP, '50000'],
        [SHOP_B, '70000'],
      ]);
    });

    it('khoá dòng ví được lấy TRƯỚC khi kiểm pending và tạo yêu cầu (đúng thứ tự gọi)', async () => {
      const f = buildFixture();
      await f.service.createDepositRequest(SHOP, 50_000, actor);
      const lockedAt = f.db.$queryRaw.mock.invocationCallOrder[0];
      expect(lockedAt).toBeLessThan(f.db.shopWalletDepositRequest.findFirst.mock.invocationCallOrder[0]);
      expect(lockedAt).toBeLessThan(f.db.shopWalletDepositRequest.create.mock.invocationCallOrder[0]);
    });

    it('lỗi khi ghi audit ⇒ rollback: không để lại yêu cầu pending (shop gửi lại được)', async () => {
      const f = buildFixture();
      f.audit.write.mockRejectedValueOnce(new Error('audit chết'));
      await expect(f.service.createDepositRequest(SHOP, 50_000, actor)).rejects.toThrow('audit chết');
      expect(f.state.deposits.size).toBe(0);
      await expect(f.service.createDepositRequest(SHOP, 50_000, actor)).resolves.toBeDefined();
    });

    it('yêu cầu cũ đã duyệt/từ chối thì được tạo yêu cầu mới; shop khác không bị ảnh hưởng', async () => {
      const f = buildFixture();
      f.seedDeposit('dep-1', SHOP, 100_000, 'approved');
      f.seedDeposit('dep-2', SHOP, 100_000, 'rejected');
      f.seedDeposit('dep-3', SHOP_B, 100_000, 'pending');
      const created = await f.service.createDepositRequest(SHOP, D(50_000), actor, 'https://img/proof.png', 'ck 10h');
      expect(f.state.deposits.get(created.id)).toMatchObject({ shopId: SHOP, status: 'pending', proofUrl: 'https://img/proof.png', note: 'ck 10h' });
      expect(f.state.deposits.get(created.id)!.amount.toString()).toBe('50000');
    });

    it('hợp lệ: ghi createdBy = actor, audit DEPOSIT_REQUESTED, KHÔNG đụng số dư ví', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -20_000);
      const created = await f.service.createDepositRequest(SHOP, 30_000, actor);
      expect(created.id).toBeTruthy();
      expect(f.db.shopWalletDepositRequest.create).toHaveBeenCalledWith(contains({ data: contains({ shopId: SHOP, createdBy: actor.userId }) }));
      // audit nay ghi TRONG transaction (cùng tx với việc tạo yêu cầu), không còn ghi ngoài với tx = null
      expect(f.audit.write.mock.calls[0][0]).toBe(f.db);
      expect(f.audit.write).toHaveBeenCalledWith(f.db, actor, contains({ action: WALLET_AUDIT.DEPOSIT_REQUESTED, entityId: created.id, after: { shopId: SHOP, amount: '30000' } }));
      expect(f.balance(SHOP)).toBe('-20000');
      expect(f.state.ledger).toHaveLength(0);
    });
  });

  /* ============================================================ */
  describe('approveDeposit', () => {
    it('cộng ví, ghi sổ cái `deposit` (số DƯƠNG, createdBy), audit + outbox; ví 0/âm lên > 0 ⇒ MỞ LẠI COD (+ outbox COD_ENABLED)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -10_000);
      f.state.codEnabled.set(SHOP, false);
      f.seedDeposit('dep-1', SHOP, 50_000);

      await f.service.approveDeposit('dep-1', actor, 'Đã nhận CK');

      expect(f.balance(SHOP)).toBe('40000');
      expect(f.ledger(SHOP)).toEqual([{ type: WALLET_TX_TYPE.DEPOSIT, orderCode: null, amount: '50000', balanceAfter: '40000', note: 'Đã nhận CK', createdBy: actor.userId }]);
      expect(f.state.deposits.get('dep-1')).toMatchObject({ status: 'approved', decidedBy: actor.userId, decideNote: 'Đã nhận CK' });
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, true, expect.anything());
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.DEPOSIT_APPROVED, WALLET_EVENT.COD_ENABLED]);
      expect(f.audit.write).toHaveBeenCalledWith(expect.anything(), actor, contains({ action: WALLET_AUDIT.DEPOSIT_APPROVED, entityId: 'dep-1', after: { status: 'approved', amount: '50000', balance: '40000' } }));
    });

    it('không có ghi chú ⇒ dùng ghi chú mặc định trong sổ cái', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 0);
      f.seedDeposit('dep-1', SHOP, 10_000);
      await f.service.approveDeposit('dep-1', actor);
      expect(f.ledger(SHOP)[0].note).toBe('Nộp quỹ được phê duyệt');
    });

    it('nộp quỹ nhưng ví vẫn ≤ 0 sau khi cộng ⇒ COD vẫn KHÓA (setCodEnabled false), không phát COD_ENABLED', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -100_000);
      f.state.codEnabled.set(SHOP, false);
      f.seedDeposit('dep-1', SHOP, 30_000);

      await f.service.approveDeposit('dep-1', actor);

      expect(f.balance(SHOP)).toBe('-70000');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.DEPOSIT_APPROVED]); // chỉ sự kiện duyệt; COD không đổi
    });

    it('nộp vừa đủ về 0 ⇒ vẫn khóa (quy tắc chỉ mở khi ví > 0)', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -30_000);
      f.state.codEnabled.set(SHOP, false);
      f.seedDeposit('dep-1', SHOP, 30_000);
      await f.service.approveDeposit('dep-1', actor);
      expect(f.balance(SHOP)).toBe('0');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
    });

    it.each(['approved', 'rejected'])('yêu cầu đã %s ⇒ DEPOSIT_DECIDED (409), KHÔNG đụng ví/sổ cái/COD', async (status) => {
      const f = buildFixture();
      f.seedWallet(SHOP, 1_000);
      f.seedDeposit('dep-1', SHOP, 50_000, status);

      const err = await catchBusiness(f.service.approveDeposit('dep-1', actor));

      expect(err.errorCode).toBe(WALLET_ERR.DEPOSIT_DECIDED);
      expect(err.httpStatus).toBe(409);
      expect(f.balance(SHOP)).toBe('1000');
      expect(f.state.ledger).toHaveLength(0);
      expect(f.db.shopWallet.update).not.toHaveBeenCalled();
      expect(f.gateway.setCodEnabled).not.toHaveBeenCalled();
      expect(f.outbox.publish).not.toHaveBeenCalled();
      expect(f.audit.write).not.toHaveBeenCalled();
      expect(f.state.deposits.get('dep-1')!.status).toBe(status); // không bị ghi đè
    });

    it('yêu cầu không tồn tại ⇒ NotFoundException DEPOSIT_NOT_FOUND (404), không mở transaction', async () => {
      const f = buildFixture();
      const err = await catchBusiness(f.service.approveDeposit('khong-co', actor));
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.errorCode).toBe(WALLET_ERR.DEPOSIT_NOT_FOUND);
      expect(err.httpStatus).toBe(404);
      expect(f.db.$transaction).not.toHaveBeenCalled();
    });

    it('duyệt hai lần liên tiếp: lần 2 bị từ chối, tiền chỉ cộng MỘT lần', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 0);
      f.seedDeposit('dep-1', SHOP, 50_000);
      await f.service.approveDeposit('dep-1', actor);
      const err = await catchBusiness(f.service.approveDeposit('dep-1', actor));
      expect(err.errorCode).toBe(WALLET_ERR.DEPOSIT_DECIDED);
      expect(f.balance(SHOP)).toBe('50000');
      expect(f.ledger(SHOP)).toHaveLength(1);
    });

    it('hai admin duyệt ĐỒNG THỜI cùng yêu cầu: chỉ một người thắng, ví cộng đúng một lần', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 0);
      f.seedDeposit('dep-1', SHOP, 50_000);
      const results = await Promise.allSettled([f.service.approveDeposit('dep-1', actor), f.service.approveDeposit('dep-1', { ...actor, userId: 'admin-2' })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as BusinessException).errorCode).toBe(WALLET_ERR.DEPOSIT_DECIDED);
      expect(f.balance(SHOP)).toBe('50000');
      expect(f.ledger(SHOP)).toHaveLength(1);
    });

    it('duyệt rồi từ chối cùng một yêu cầu ⇒ từ chối bị chặn', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 0);
      f.seedDeposit('dep-1', SHOP, 50_000);
      await f.service.approveDeposit('dep-1', actor);
      const err = await catchBusiness(f.service.rejectDeposit('dep-1', actor, 'nhầm'));
      expect(err.errorCode).toBe(WALLET_ERR.DEPOSIT_DECIDED);
      expect(f.state.deposits.get('dep-1')!.status).toBe('approved');
    });
  });

  /* ============================================================ */
  describe('rejectDeposit', () => {
    it('từ chối: đổi trạng thái, audit + outbox, KHÔNG đụng ví/sổ cái/COD', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -5_000);
      f.seedDeposit('dep-1', SHOP, 50_000);

      await f.service.rejectDeposit('dep-1', actor, 'Sai nội dung CK');

      expect(f.state.deposits.get('dep-1')).toMatchObject({ status: 'rejected', decidedBy: actor.userId, decideNote: 'Sai nội dung CK' });
      expect(f.balance(SHOP)).toBe('-5000');
      expect(f.state.ledger).toHaveLength(0);
      expect(f.gateway.setCodEnabled).not.toHaveBeenCalled();
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.DEPOSIT_REJECTED]);
    });

    it('không tồn tại ⇒ 404; đã xử lý ⇒ DEPOSIT_DECIDED', async () => {
      const f = buildFixture();
      f.seedDeposit('dep-1', SHOP, 50_000, 'rejected');
      expect((await catchBusiness(f.service.rejectDeposit('khong-co', actor))).errorCode).toBe(WALLET_ERR.DEPOSIT_NOT_FOUND);
      expect((await catchBusiness(f.service.rejectDeposit('dep-1', actor))).errorCode).toBe(WALLET_ERR.DEPOSIT_DECIDED);
    });
  });

  /* ============================================================ */
  describe('adjust', () => {
    it.each([
      ['0', 0],
      ['chuỗi "0"', '0'],
      ['không nguyên 1.5', 1.5],
      ['không nguyên âm -0.25', '-0.25'],
    ])('số tiền %s ⇒ INVALID_AMOUNT (400), không đụng ví', async (_label, amount) => {
      const f = buildFixture();
      f.seedWallet(SHOP, 10_000);
      const err = await catchBusiness(f.service.adjust(SHOP, amount, 'điều chỉnh hợp lệ', actor));
      expect(err.errorCode).toBe(WALLET_ERR.INVALID_AMOUNT);
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.balance(SHOP)).toBe('10000');
    });

    it.each([
      ['rỗng', ''],
      ['ngắn (4 ký tự)', 'abcd'],
      ['toàn khoảng trắng', '          '],
      ['4 ký tự + khoảng trắng bao quanh', '   abcd   '],
    ])('ghi chú %s ⇒ NOTE_REQUIRED (400), không đụng ví', async (_label, note) => {
      const f = buildFixture();
      f.seedWallet(SHOP, 10_000);
      const err = await catchBusiness(f.service.adjust(SHOP, 1_000, note, actor));
      expect(err.errorCode).toBe(WALLET_ERR.NOTE_REQUIRED);
      expect(err.httpStatus).toBe(400);
      expect(f.balance(SHOP)).toBe('10000');
      expect(f.state.ledger).toHaveLength(0);
    });

    it('ghi chú undefined/null (gọi sai kiểu) cũng bị chặn NOTE_REQUIRED', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 10_000);
      const err = await catchBusiness(f.service.adjust(SHOP, 1_000, undefined as unknown as string, actor));
      expect(err.errorCode).toBe(WALLET_ERR.NOTE_REQUIRED);
    });

    it('kiểm số tiền TRƯỚC ghi chú (số 0 + ghi chú rỗng ⇒ INVALID_AMOUNT)', async () => {
      const f = buildFixture();
      const err = await catchBusiness(f.service.adjust(SHOP, 0, '', actor));
      expect(err.errorCode).toBe(WALLET_ERR.INVALID_AMOUNT);
    });

    it('ghi chú đúng 5 ký tự (sau trim) hợp lệ; sổ cái lưu ghi chú đã trim + createdBy', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 10_000);
      await f.service.adjust(SHOP, 2_000, '  abcde  ', actor);
      expect(f.ledger(SHOP)).toEqual([{ type: WALLET_TX_TYPE.ADJUST, orderCode: null, amount: '2000', balanceAfter: '12000', note: 'abcde', createdBy: actor.userId }]);
      expect(f.balance(SHOP)).toBe('12000');
      expect(f.audit.write).toHaveBeenCalledWith(expect.anything(), actor, contains({ action: WALLET_AUDIT.ADJUSTED, entityCode: SHOP, before: { balance: '10000' }, after: { balance: '12000', delta: '2000', note: 'abcde' } }));
    });

    it('điều chỉnh ÂM làm ví ≤ 0 ⇒ khoá COD + outbox COD_DISABLED', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 10_000);
      await f.service.adjust(SHOP, -10_000, 'Phạt vi phạm quy chế', actor);
      expect(f.balance(SHOP)).toBe('0');
      expect(f.ledger(SHOP)[0]).toMatchObject({ amount: '-10000', balanceAfter: '0' });
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.COD_DISABLED]);
    });

    it('điều chỉnh âm sâu hơn (ví đã âm) lưu đúng số âm và không phát lại COD_DISABLED', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -5_000);
      f.state.codEnabled.set(SHOP, false);
      await f.service.adjust(SHOP, -2_500, 'Truy thu phí lần 2', actor);
      expect(f.balance(SHOP)).toBe('-7500');
      expect(f.outbox.publish).not.toHaveBeenCalled();
    });

    it('điều chỉnh DƯƠNG đưa ví > 0 ⇒ mở lại COD + outbox COD_ENABLED', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -1_000);
      f.state.codEnabled.set(SHOP, false);
      await f.service.adjust(SHOP, 5_000, 'Hoàn phí nhầm đơn DH-7', actor);
      expect(f.balance(SHOP)).toBe('4000');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, true, expect.anything());
      expect(f.outboxTypes()).toEqual([WALLET_EVENT.COD_ENABLED]);
    });

    it('điều chỉnh dương nhưng ví vẫn ≤ 0 ⇒ COD vẫn khoá', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, -10_000);
      f.state.codEnabled.set(SHOP, false);
      await f.service.adjust(SHOP, 4_000, 'Bù một phần', actor);
      expect(f.balance(SHOP)).toBe('-6000');
      expect(f.gateway.setCodEnabled).toHaveBeenCalledWith(SHOP, false, expect.anything());
    });

    it('nhiều lần điều chỉnh cùng lúc (không có orderCode) đều được ghi — sổ cái không coi là trùng', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 0);
      await Promise.all([f.service.adjust(SHOP, 1_000, 'lần một ok', actor), f.service.adjust(SHOP, 1_000, 'lần hai ok', actor)]);
      expect(f.balance(SHOP)).toBe('2000');
      expect(f.ledger(SHOP)).toHaveLength(2);
    });
  });

  /* ============================================================ */
  describe('đọc số dư', () => {
    it('ví chưa tạo ⇒ số dư 0, không có yêu cầu chờ', async () => {
      const f = buildFixture();
      const s = await f.service.getWalletSummary(SHOP);
      expect(s.balance.toString()).toBe('0');
      expect(s.pendingDeposit).toBeNull();
    });

    it('có ví + yêu cầu chờ ⇒ trả số dư và yêu cầu đó', async () => {
      const f = buildFixture();
      f.seedWallet(SHOP, 12_345);
      f.seedDeposit('dep-1', SHOP, 99_000);
      const s = await f.service.getWalletSummary(SHOP);
      expect(s.balance.toString()).toBe('12345');
      expect(s.pendingDeposit?.id).toBe('dep-1');
      expect(s.pendingDeposit?.amount.toString()).toBe('99000');
    });
  });

  /* ============================================================ */
  describe('hợp đồng schema ↔ service', () => {
    /* CHECK constraint MỚI NHẤT của một cột: đọc mọi migration theo thứ tự thời gian; migration sau DROP + ADD lại thì lấy bản sau. */
    const latestCheckValues = (constraint: string): string[] => {
      const dir = join(__dirname, '../../../../prisma/migrations');
      const sql = readdirSync(dir)
        .filter((d) => /^\d+_/.test(d))
        .sort()
        .map((d) => readFileSync(join(dir, d, 'migration.sql'), 'utf8'))
        .join('\n');
      const defs = [...sql.matchAll(new RegExp(`ADD CONSTRAINT "${constraint}"\\s+CHECK \\(\\s*"[a-z_]+" IN \\(([^)]*)\\)`, 'g'))];
      expect(defs.length).toBeGreaterThan(0);
      return [...defs[defs.length - 1][1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    };

    it('CHECK chk_shop_wallet_tx_type (bản MỚI NHẤT qua các migration) khớp ĐÚNG WALLET_TX_TYPE: cod_commission | deposit | adjust | cod_refund', () => {
      expect(latestCheckValues('chk_shop_wallet_tx_type')).toContain('cod_refund');
      expect([...latestCheckValues('chk_shop_wallet_tx_type')].sort()).toEqual(Object.values(WALLET_TX_TYPE).sort());
    });

    it('CHECK chk_shop_wallet_deposit_status cho phép mọi trạng thái yêu cầu nộp quỹ service dùng (pending | approved | rejected)', () => {
      const allowed = latestCheckValues('chk_shop_wallet_deposit_status');
      for (const status of ['pending', 'approved', 'rejected']) expect(allowed).toContain(status);
    });

    it('các loại sổ cái mà các thao tác thực sự ghi (hoa hồng COD, nộp quỹ, điều chỉnh, hoàn tiền COD) trùng khít tập CHECK mới nhất — gồm cod_refund', async () => {
      const allowed = latestCheckValues('chk_shop_wallet_tx_type');
      const f = buildFixture();
      f.seedWallet(SHOP, 100_000);
      f.seedDeposit('dep-1', SHOP, 10_000);
      await f.service.chargeCodCommission({ shopId: SHOP, orderCode: 'DH-1', amount: 1_000 });
      await f.service.approveDeposit('dep-1', actor);
      await f.service.adjust(SHOP, 500, 'điều chỉnh thử', actor);
      await f.service.recordCodRefund({ shopId: SHOP, orderCode: 'DH-1', refundKey: 'RF-1', amount: 300, commissionReversal: 30 });
      const used = new Set(f.state.ledger.map((r) => r.type));
      expect([...used].sort()).toEqual([...allowed].sort());
    });
  });
});
