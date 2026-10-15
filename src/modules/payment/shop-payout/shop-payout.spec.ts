import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { OrderQueryApi } from '@modules/order/queryapi/order.queryapi';
import type { ShopContext } from '@modules/shop/security/shop-permission.decorator';
import type { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import type { PaymentAuditLogService } from '../audit/payment-audit-log.service';
import { PAYMENT_EVENT, PAYOUT_AUDIT, PAYOUT_ERR, PAYOUT_LINE_KIND, PAYOUT_STATUS } from '../foundation/payment.constants';
import type { PaymentOutboxService } from '../outbox/payment-outbox.service';
import type { PayosService } from '../payos/payos.service';
import { ShopPayoutController } from './controller/shop-payout.controller';
import { MarkPaidRequest, PayoutListQuery, RunPayoutRequest } from './dto/shop-payout.dto';
import { ShopPayoutService } from './shop-payout.service';

/*
 * Test đối soát chi trả shop. Service chạy THẬT; Prisma được thay bằng DB giả trong bộ nhớ hiểu đúng các `where` mà service dùng
 * (so sánh Date/Decimal, gt/lte/not/in, OR, khoá ghép shopId_periodStart_periodEnd, UNIQUE của kỳ và dòng đối soát, updateMany có điều kiện,
 * transaction tuần tự + rollback) ⇒ kiểm được cả chuỗi nhiều kỳ (nợ mang sang) lẫn chạy lại / race mà không cần DB thật.
 */

type Dec = Prisma.Decimal;
const D = (v: string | number): Dec => new Prisma.Decimal(v);
/* expect.objectContaining trả `any` ⇒ bọc về `unknown` để dùng được trong object literal mà không vướng no-unsafe-assignment. */
const contains = (o: Record<string, unknown>): unknown => expect.objectContaining(o);

const SHOP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHOP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CODE_A = 'PAY-250301-250331-AAAAAAAA';
const BANK = { bankCode: '970436', accountNumber: '0011223344', accountName: 'CONG TY A' };
const actor: AuthenticatedActor = { userId: 'user-acc-1', email: 'ketoan@fitly.vn', roleCode: 'accountant', permissionVersion: 1, tokenId: 'jti-1' };

const PERIOD = { periodStart: new Date('2025-03-01T00:00:00.000Z'), periodEnd: new Date('2025-03-31T00:00:00.000Z') };

/* Hoàn tiền: id là uuid, khoá dòng đối soát = "RF-" + 26 ký tự hex đầu. */
const R1 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const R1_KEY = 'RF-f47ac10b58cc4372a5670e02b2';
const R2 = '9b2e5c1a-7d3f-4e8a-b6c4-1a2b3c4d5e6f';
const R3 = '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a';
const rfKey = (id: string) => `RF-${id.replace(/-/g, '').slice(0, 26)}`;

/* ---------------------------------------------------------------- kiểu dữ liệu giả ---- */

type PayoutRow = {
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
  bankSnapshot: unknown;
  paidAt: Date | null;
  createdBy: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
type LineRow = { payoutId: string; orderCode: string; kind: string; gross: Dec; commission: Dec };
type RefundRow = { id: string; orderCode: string; amount: Dec; status: string; shopId: string | null; processedAt: Date | null };
type EligibleOrder = { orderCode: string; shopId: string; total: Dec; platformDiscount: Dec; commissionRateSnapshot: Dec; settleFrom: Date };
type PayoutInput = { referenceId: string; amount: bigint; toBin: string; toAccountNumber: string; description: string; idempotencyKey: string };
type PayoutResult = { ok: boolean; code: string; message: string; transactionId?: string; raw: unknown };
type Where = Record<string, unknown>;
/* BankAccount của ShopQueryApi: thêm changedAt (lần đổi TK gần nhất) — fixture mặc định không có (= chưa từng đổi). */
type BankRec = typeof BANK & { changedAt?: Date | null };

const isDec = (v: unknown): v is Dec => Prisma.Decimal.isDecimal(v);
function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (isDec(a) || isDec(b)) return new Prisma.Decimal(a as Dec).cmp(b as Dec);
  return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
}
const same = (a: unknown, b: unknown): boolean => (a == null || b == null ? (a ?? null) === (b ?? null) : cmp(a, b) === 0);

/* Bộ so khớp `where` kiểu Prisma — chỉ phần service dùng; toán tử lạ ⇒ ném lỗi để test không "đúng nhầm". */
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const value = row[key];
    const isOperator = cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !isDec(cond);
    if (!isOperator) return same(value, cond);
    return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
      switch (op) {
        case 'gt': return value != null && cmp(value, arg) > 0;
        case 'gte': return value != null && cmp(value, arg) >= 0;
        case 'lt': return value != null && cmp(value, arg) < 0;
        case 'lte': return value != null && cmp(value, arg) <= 0;
        case 'not': return !same(value, arg);
        case 'in': return (arg as unknown[]).some((x) => same(value, x));
        default: throw new Error(`Toán tử where chưa hỗ trợ trong DB giả: ${op}`);
      }
    });
  });
}

/* orderBy kiểu Prisma: một object hoặc mảng object `{ cột: 'asc' | 'desc' }`. */
function sortRows<T extends Record<string, unknown>>(rows: T[], orderBy: unknown): T[] {
  const list = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, 'asc' | 'desc'>>;
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0];
      const c = cmp(a[k], b[k]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
const MIN = 60_000;

function buildFixture(opts: { payoutConfigured?: boolean } = {}) {
  const state = { payouts: [] as PayoutRow[], lines: [] as LineRow[], refunds: [] as RefundRow[] };
  let eligible: EligibleOrder[] = [];
  /* "Bảng đơn" cho OrderQueryApi.orderTotalsOf: đơn dựng bằng setEligible/seedSale — tổng khách trả T và voucher sàn của từng đơn. */
  const knownOrders = new Map<string, { total: Dec; platformDiscount: Dec }>();
  const banks = new Map<string, BankRec | null>([
    [SHOP_A, BANK],
    [SHOP_B, { bankCode: '970422', accountNumber: '99887766', accountName: 'CONG TY B' }],
  ]);
  let seq = 0;
  const nextCreatedAt = () => new Date(Date.UTC(2025, 3, 1) + ++seq * 1000);

  /* Prisma trả bản SAO của dòng (không phải tham chiếu vào bảng) ⇒ đọc rồi bị người khác sửa không làm đổi giá trị đã đọc. */
  const copy = (r: PayoutRow | undefined): PayoutRow | null => (r ? { ...r } : null);
  const resolveWhere = (where: Where): Where => {
    const compound = where.shopId_periodStart_periodEnd as Where | undefined;
    return compound ? { shopId: compound.shopId, periodStart: compound.periodStart, periodEnd: compound.periodEnd } : where;
  };

  const db = {
    shopPayout: {
      findFirst: jest.fn((args: { where?: Where; orderBy?: unknown }) => Promise.resolve(copy(sortRows(state.payouts.filter((r) => matches(r, args.where ?? {})), args.orderBy)[0]))),
      findUnique: jest.fn((args: { where: Where }) => Promise.resolve(copy(state.payouts.find((r) => matches(r, resolveWhere(args.where)))))),
      findUniqueOrThrow: jest.fn((args: { where: Where }) => {
        const r = state.payouts.find((x) => matches(x, resolveWhere(args.where)));
        return r ? Promise.resolve({ ...r }) : Promise.reject(new Error('Không tìm thấy bản ghi'));
      }),
      create: jest.fn(({ data }: { data: Omit<Partial<PayoutRow>, 'bankSnapshot'> & { bankSnapshot?: unknown; code: string; shopId: string; periodStart: Date; periodEnd: Date } }) => {
        if (state.payouts.some((r) => r.code === data.code || (r.shopId === data.shopId && same(r.periodStart, data.periodStart) && same(r.periodEnd, data.periodEnd)))) return Promise.reject(p2002());
        const row = { providerRef: null, failReason: null, paidAt: null, createdBy: null, version: 0, ...data, bankSnapshot: data.bankSnapshot ?? null, id: `payout-${++seq}`, createdAt: nextCreatedAt(), updatedAt: new Date() } as PayoutRow;
        state.payouts.push(row);
        return Promise.resolve({ ...row });
      }),
      /* @updatedAt: mọi lần ghi đều đẩy updatedAt lên hiện tại (service dùng nó để nhận ra kỳ `processing` bị treo). */
      updateMany: jest.fn(({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const rows = state.payouts.filter((r) => matches(r, where));
        for (const r of rows) {
          for (const [k, v] of Object.entries(data)) {
            if (k === 'version') r.version += 1;
            else (r as Record<string, unknown>)[k] = v;
          }
          r.updatedAt = new Date();
        }
        return Promise.resolve({ count: rows.length });
      }),
    },
    shopPayoutLine: {
      findMany: jest.fn((args: { where: Where }) => Promise.resolve(state.lines.filter((l) => matches(l, args.where)))),
      createMany: jest.fn(({ data }: { data: LineRow[] }) => {
        for (const l of data) {
          if (state.lines.some((x) => x.orderCode === l.orderCode && x.kind === l.kind)) return Promise.reject(p2002());
          state.lines.push({ ...l });
        }
        return Promise.resolve({ count: data.length });
      }),
    },
    refund: { findMany: jest.fn((args: { where: Where; orderBy?: unknown }) => Promise.resolve(sortRows(state.refunds.filter((r) => matches(r, args.where)), args.orderBy))) },
    $transaction: undefined as unknown as jest.Mock,
  };
  let chain: Promise<unknown> = Promise.resolve();
  db.$transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
    const run = chain.then(async () => {
      const snap = { payouts: state.payouts.map((r) => ({ ...r })), lines: state.lines.map((l) => ({ ...l })) };
      try {
        return await fn(db);
      } catch (err) {
        state.payouts = snap.payouts;
        state.lines = snap.lines;
        throw err;
      }
    });
    chain = run.catch(() => undefined);
    return run;
  });

  const orders = {
    settlementOrders: jest.fn((_days: number, _end: Date) => Promise.resolve([...eligible])),
    orderTotalsOf: jest.fn((codes: string[]) => Promise.resolve(new Map(codes.flatMap((c) => (knownOrders.has(c) ? [[c, knownOrders.get(c)] as const] : []))))),
  };
  const shops = { bankAccountOf: jest.fn((shopId: string) => Promise.resolve(banks.get(shopId) ?? null)) };
  const system = { settingNumber: jest.fn((_key: string) => Promise.resolve(7)) };
  const payos = {
    isPayoutConfigured: opts.payoutConfigured ?? false,
    payout: jest.fn((_input: PayoutInput): Promise<PayoutResult> => Promise.resolve({ ok: true, code: '00', message: 'ok', transactionId: 'TX-1', raw: null })),
    payoutBalance: jest.fn(),
  };
  const audit = { write: jest.fn((_tx: unknown, _actor: unknown, _entry: Record<string, unknown>): Promise<void> => Promise.resolve()) };
  const outbox = { publish: jest.fn((_tx: unknown, _input: Record<string, unknown>): Promise<void> => Promise.resolve()) };

  const service = new ShopPayoutService(
    db as unknown as PrismaService,
    orders as unknown as OrderQueryApi,
    shops as unknown as ShopQueryApi,
    system as unknown as SystemQueryApi,
    payos as unknown as PayosService,
    audit as unknown as PaymentAuditLogService,
    outbox as unknown as PaymentOutboxService,
  );

  const f = {
    db,
    state,
    orders,
    shops,
    system,
    payos,
    audit,
    outbox,
    service,
    banks,
    setEligible(list: EligibleOrder[]) {
      eligible = list;
      for (const o of list) knownOrders.set(o.orderCode, { total: o.total, platformDiscount: o.platformDiscount });
    },
    /* Kỳ đã chạy từ trước (net có thể âm). Ngày dạng 'YYYY-MM-DD'; updatedAt mặc định = bây giờ (processing mới, chưa treo). */
    seedPayout(o: { shopId: string; start: string; end: string; net: number; status: string; id?: string; createdAt?: string; updatedAt?: Date; bankSnapshot?: typeof BANK | null; failReason?: string | null }): PayoutRow {
      const id = o.id ?? `seed-${++seq}`;
      const row: PayoutRow = {
        id,
        code: `SEED-${id}`.slice(0, 30),
        shopId: o.shopId,
        periodStart: new Date(`${o.start}T00:00:00.000Z`),
        periodEnd: new Date(`${o.end}T00:00:00.000Z`),
        grossRevenue: D(Math.abs(o.net)),
        commission: D(0),
        refundAmount: D(0),
        carriedDebt: D(0),
        netPayout: D(o.net),
        status: o.status,
        providerRef: null,
        failReason: o.failReason ?? null,
        bankSnapshot: o.bankSnapshot === undefined ? null : o.bankSnapshot,
        paidAt: null,
        createdBy: null,
        version: 0,
        createdAt: o.createdAt ? new Date(`${o.createdAt}T00:00:00.000Z`) : nextCreatedAt(),
        updatedAt: o.updatedAt ?? new Date(),
      };
      state.payouts.push(row);
      return row;
    },
    /* Dòng bán của kỳ trước + đơn tương ứng trong "bảng đơn": total (khách trả) mặc định = gross − voucher sàn. */
    seedSale(orderCode: string, gross: number, commission: number, o: { platformDiscount?: number; total?: number; payoutId?: string } = {}) {
      const platformDiscount = o.platformDiscount ?? 0;
      knownOrders.set(orderCode, { total: D(o.total ?? gross - platformDiscount), platformDiscount: D(platformDiscount) });
      state.lines.push({ payoutId: o.payoutId ?? 'seed-old', orderCode, kind: PAYOUT_LINE_KIND.SALE, gross: D(gross), commission: D(commission) });
    },
    seedRefundLine(key: string, payoutId = 'seed-old') {
      state.lines.push({ payoutId, orderCode: key, kind: PAYOUT_LINE_KIND.REFUND, gross: D(1), commission: D(0) });
    },
    seedRefund(r: { id: string; orderCode: string; amount: number; shopId?: string | null; status?: string; processedAt?: string | null }) {
      state.refunds.push({
        id: r.id,
        orderCode: r.orderCode,
        amount: D(r.amount),
        status: r.status ?? 'done',
        shopId: r.shopId === undefined ? SHOP_A : r.shopId,
        processedAt: r.processedAt === undefined ? new Date('2025-03-10T00:00:00.000Z') : r.processedAt === null ? null : new Date(`${r.processedAt}T00:00:00.000Z`),
      });
    },
    payoutOf: (shopId: string): PayoutRow => {
      const rows = state.payouts.filter((p) => p.shopId === shopId);
      return rows[rows.length - 1];
    },
    linesOf: (payoutId: string) => state.lines.filter((l) => l.payoutId === payoutId),
    run: (period: { periodStart: Date; periodEnd: Date } = PERIOD) => service.run(period, actor),
    auditActions: () => audit.write.mock.calls.map((c) => c[2].action),
    outboxTypes: () => outbox.publish.mock.calls.map((c) => c[1].eventType),
  };
  return f;
}
type Fixture = ReturnType<typeof buildFixture>;

/* total = khách trả; platformDiscount = phần voucher SÀN chịu (sàn hoàn cho shop) ⇒ doanh thu của shop = total + platformDiscount. */
const order = (orderCode: string, shopId: string, total: number, rate = '10.00', platformDiscount = 0): EligibleOrder => ({
  orderCode,
  shopId,
  total: D(total),
  platformDiscount: D(platformDiscount),
  commissionRateSnapshot: D(rate),
  settleFrom: new Date('2025-02-01T00:00:00.000Z'),
});

async function catchBusiness(p: Promise<unknown>): Promise<BusinessException> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BusinessException);
    return e as BusinessException;
  }
  throw new Error('Mong đợi BusinessException nhưng promise resolve');
}

/* ================================================================================================ */

describe('ShopPayoutService — đối soát chi trả shop', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /* `run` nuốt lỗi từng shop ⇒ mọi test happy-path phải khẳng định không có lỗi bị nuốt. */
  const expectNoSwallowedError = () => expect(errorSpy).not.toHaveBeenCalled();

  /* ============================================================ */
  describe('run — công thức tiền', () => {
    it.each([
      ['105 × 10.00% = 10.5 ⇒ làm tròn LÊN 11', 105, '10.00', '11'],
      ['15 × 10.00% = 1.5 ⇒ 2', 15, '10.00', '2'],
      ['5 × 10.00% = 0.5 ⇒ 1', 5, '10.00', '1'],
      ['4 × 10.00% = 0.4 ⇒ 0', 4, '10.00', '0'],
      ['1000 × 12.35% = 123.5 ⇒ 124', 1000, '12.35', '124'],
      ['10001 × 7.50% = 750.075 ⇒ 750', 10001, '7.50', '750'],
      ['rate 0% ⇒ 0', 999, '0.00', '0'],
      ['rate 100% ⇒ toàn bộ', 1_000_000, '100.00', '1000000'],
    ])('hoa hồng round_half_up: %s', async (_label, total, rate, expected) => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, total, rate)]);

      const created = await f.run();

      expectNoSwallowedError();
      expect(created).toHaveLength(1);
      const payout = f.payoutOf(SHOP_A);
      expect(payout.commission.toString()).toBe(expected);
      expect(payout.grossRevenue.toString()).toBe(String(total));
      expect(payout.netPayout.toString()).toBe(D(total).sub(expected).toString());
      expect(f.linesOf(payout.id)).toEqual([{ payoutId: payout.id, orderCode: 'DH-1', kind: 'sale', gross: D(total), commission: D(expected) }]);
    });

    it('nhiều đơn / nhiều tỷ lệ snapshot: làm tròn TỪNG ĐƠN rồi cộng; net = gross − commission − refund − nợ', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 105, '10.00'), order('DH-2', SHOP_A, 1000, '12.35'), order('DH-3', SHOP_A, 1_000_000, '10.00'), order('DH-4', SHOP_A, 10_001, '7.50')]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.grossRevenue.toString()).toBe('1011106'); // 105 + 1000 + 1.000.000 + 10.001
      expect(p.commission.toString()).toBe('100885'); // 11 + 124 + 100.000 + 750
      expect(p.refundAmount.toString()).toBe('0');
      expect(p.carriedDebt.toString()).toBe('0');
      expect(p.netPayout.toString()).toBe('910221');
      expect(f.linesOf(p.id).map((l) => [l.orderCode, l.commission.toString()])).toEqual([
        ['DH-1', '11'],
        ['DH-2', '124'],
        ['DH-3', '100000'],
        ['DH-4', '750'],
      ]);
    });

    it('voucher SÀN: doanh thu shop = total + platformDiscount, hoa hồng tính trên doanh thu đó (sàn hoàn phần voucher cho shop)', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-V', SHOP_A, 90_000, '10.00', 10_000)]); // khách trả 90.000, sàn chịu 10.000

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect([p.grossRevenue, p.commission, p.netPayout].map(String)).toEqual(['100000', '10000', '90000']);
      expect(f.linesOf(p.id)).toEqual([{ payoutId: p.id, orderCode: 'DH-V', kind: 'sale', gross: D(100_000), commission: D(10_000) }]);
    });

    it('PLAN-0018: đơn COD (sàn đã thu hộ, Payment=paid) vào đối soát CÙNG đường với đơn PayOS: một dòng SALE, trừ hoa hồng, ra kỳ chung của shop', async () => {
      const f = buildFixture();
      // OrderQueryApi.settlementOrders không còn phân biệt phương thức: đơn COD đã paid và đơn PayOS đều xuất hiện trong danh sách đủ điều kiện
      f.setEligible([order('DH-COD-1', SHOP_A, 200_000, '10.00'), order('DH-PAYOS-1', SHOP_A, 100_000, '10.00')]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect([p.grossRevenue, p.commission, p.netPayout].map(String)).toEqual(['300000', '30000', '270000']);
      expect(f.linesOf(p.id).map((l) => `${l.orderCode}:${l.kind}`).sort()).toEqual(['DH-COD-1:sale', 'DH-PAYOS-1:sale']);
    });

    it('voucher sàn + làm tròn: (100 + 5) × 10% = 10.5 ⇒ 11 (làm tròn trên TỔNG doanh thu, không tách từng phần)', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-V', SHOP_A, 100, '10.00', 5)]);
      await f.run();
      const p = f.payoutOf(SHOP_A);
      expect([p.grossRevenue, p.commission, p.netPayout].map(String)).toEqual(['105', '11', '94']);
    });

    it('đơn không có voucher sàn (platformDiscount = 0) ⇒ không đổi so với công thức cũ', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000, '10.00', 0)]);
      await f.run();
      expect(f.payoutOf(SHOP_A).netPayout.toString()).toBe('90000');
    });

    it('mỗi shop một kỳ riêng, số liệu không lẫn nhau; mã kỳ tất định theo ngày + 8 ký tự đầu của shopId', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000), order('DH-2', SHOP_B, 200_000, '5.00'), order('DH-3', SHOP_A, 50_000)]);

      const created = await f.run();

      expectNoSwallowedError();
      expect(created).toHaveLength(2);
      const a = f.payoutOf(SHOP_A);
      const b = f.payoutOf(SHOP_B);
      expect(a.code).toBe(CODE_A);
      expect(b.code).toBe('PAY-250301-250331-BBBBBBBB');
      expect([a.grossRevenue.toString(), a.commission.toString(), a.netPayout.toString()]).toEqual(['150000', '15000', '135000']);
      expect([b.grossRevenue.toString(), b.commission.toString(), b.netPayout.toString()]).toEqual(['200000', '10000', '190000']);
      expect(f.linesOf(a.id).map((l) => l.orderCode)).toEqual(['DH-1', 'DH-3']);
      expect(f.linesOf(b.id).map((l) => l.orderCode)).toEqual(['DH-2']);
    });

    it('ghi audit CREATED + outbox PAYOUT_CREATED với số liệu của kỳ', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      await f.run();
      expectNoSwallowedError();
      expect(f.auditActions()).toEqual([PAYOUT_AUDIT.CREATED]);
      expect(f.audit.write.mock.calls[0][2]).toMatchObject({ entityCode: CODE_A, after: contains({ grossRevenue: '100000', commission: '10000', refundAmount: '0', carriedDebt: '0', netPayout: '90000', lines: 1 }) });
      expect(f.outbox.publish.mock.calls[0][1]).toMatchObject({ eventType: PAYMENT_EVENT.PAYOUT_CREATED, payload: contains({ payoutCode: CODE_A, shopId: SHOP_A, netPayout: '90000' }) });
    });
  });

  /* ============================================================ */
  describe('run — escrow & chống tính trùng', () => {
    it('lấy hạn đổi trả từ setting RETURN_WINDOW_DAYS và gọi settlementOrders(windowDays, periodEnd); chỉ tính đơn nó trả về', async () => {
      const f = buildFixture();
      f.system.settingNumber.mockResolvedValue(14);
      f.setEligible([order('DH-IN', SHOP_A, 100_000)]);

      await f.run();

      expect(f.system.settingNumber).toHaveBeenCalledWith(SETTING_KEY.RETURN_WINDOW_DAYS);
      expect(f.orders.settlementOrders).toHaveBeenCalledWith(14, PERIOD.periodEnd);
      expect(f.state.lines.map((l) => l.orderCode)).toEqual(['DH-IN']);
    });

    it('settlementOrders trả rỗng ⇒ không tạo kỳ nào, không gọi PayOS', async () => {
      const f = buildFixture({ payoutConfigured: true });
      expect(await f.run()).toEqual([]);
      expect(f.state.payouts).toHaveLength(0);
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it('đơn đã có dòng `sale` trong DB ⇒ KHÔNG tính lại (không cộng lại doanh thu/hoa hồng)', async () => {
      const f = buildFixture();
      f.seedSale('DH-OLD', 100_000, 10_000);
      f.setEligible([order('DH-OLD', SHOP_A, 100_000), order('DH-NEW', SHOP_A, 20_000)]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.grossRevenue.toString()).toBe('20000');
      expect(p.commission.toString()).toBe('2000');
      expect(f.linesOf(p.id).map((l) => l.orderCode)).toEqual(['DH-NEW']);
      expect(f.state.lines.filter((l) => l.orderCode === 'DH-OLD')).toHaveLength(1);
    });

    it('mọi đơn đều đã tính ⇒ không tạo kỳ rỗng', async () => {
      const f = buildFixture();
      f.seedSale('DH-OLD', 100_000, 10_000);
      f.setEligible([order('DH-OLD', SHOP_A, 100_000)]);
      expect(await f.run()).toEqual([]);
      expect(f.state.payouts).toHaveLength(0);
    });

    it('chạy lại ĐÚNG kỳ cũ ⇒ không tạo thêm kỳ, không đổi số liệu, không gọi PayOS lần hai, không ghi audit/outbox thêm', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      const first = await f.run();
      expect(first).toHaveLength(1);
      const snapshot = JSON.stringify(f.state.payouts);

      const second = await f.run();

      expectNoSwallowedError();
      expect(second).toEqual([]);
      expect(f.state.payouts).toHaveLength(1);
      expect(JSON.stringify(f.state.payouts)).toBe(snapshot);
      expect(f.state.lines).toHaveLength(1);
      expect(f.payos.payout).toHaveBeenCalledTimes(1);
      expect(f.auditActions()).toEqual([PAYOUT_AUDIT.CREATED, PAYOUT_AUDIT.SENT]);
    });

    it('chạy lại đúng kỳ khi có đơn MỚI đủ điều kiện: kỳ cũ giữ nguyên (không nhét thêm), đơn mới chờ kỳ sau và không bị mất', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      await f.run();
      f.setEligible([order('DH-1', SHOP_A, 100_000), order('DH-LATE', SHOP_A, 40_000)]);

      const again = await f.run(); // cùng kỳ ⇒ guard UNIQUE(shop, kỳ)

      expectNoSwallowedError();
      expect(again).toEqual([]);
      expect(f.state.payouts).toHaveLength(1);
      expect(f.state.lines.map((l) => l.orderCode)).toEqual(['DH-1']);

      const next = await f.run({ periodStart: PERIOD.periodEnd, periodEnd: new Date('2025-04-30T00:00:00.000Z') });
      expectNoSwallowedError();
      expect(next).toHaveLength(1);
      expect(f.payoutOf(SHOP_A).grossRevenue.toString()).toBe('40000');
      expect(f.state.lines.map((l) => l.orderCode)).toEqual(['DH-1', 'DH-LATE']);
    });

    it('hai lần chạy ĐỒNG THỜI cùng kỳ: chỉ một kỳ + một lệnh chi PayOS (UNIQUE chặn lần hai, không nuốt tiền hai lần)', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      const [r1, r2] = await Promise.all([f.run(), f.run()]);

      expect(r1.length + r2.length).toBe(1);
      expect(f.state.payouts).toHaveLength(1);
      expect(f.state.lines).toHaveLength(1);
      expect(f.payos.payout).toHaveBeenCalledTimes(1);
    });
  });

  /* ============================================================ */
  describe('run — trạng thái & chi PayOS', () => {
    it('net > 0 + PayOS CHƯA cấu hình ⇒ pending, KHÔNG gọi payos.payout, chưa có failReason (kế toán chuyển tay)', async () => {
      const f = buildFixture({ payoutConfigured: false });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.status).toBe(PAYOUT_STATUS.PENDING);
      expect(p.failReason).toBeNull();
      expect(p.bankSnapshot).toEqual(BANK);
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it('cấu hình + có TK ngân hàng ⇒ gọi payos.payout ĐÚNG 1 lần, idempotencyKey = mã kỳ, số tiền = net; ok ⇒ processing + providerRef', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.setEligible([order('DH-1', SHOP_A, 105), order('DH-2', SHOP_A, 1_000_000)]);

      const created = await f.run();

      expectNoSwallowedError();
      expect(f.payos.payout).toHaveBeenCalledTimes(1);
      expect(f.payos.payout).toHaveBeenCalledWith({ referenceId: CODE_A, amount: 900_094n, toBin: BANK.bankCode, toAccountNumber: BANK.accountNumber, description: `FITLY ${CODE_A}`, idempotencyKey: CODE_A });
      const p = f.payoutOf(SHOP_A);
      expect(p.netPayout.toString()).toBe('900094'); // 1.000.105 − (11 + 100.000)
      expect(p.status).toBe(PAYOUT_STATUS.PROCESSING);
      expect(p.providerRef).toBe('TX-1');
      expect(p.failReason).toBeNull();
      expect(created[0].status).toBe(PAYOUT_STATUS.PROCESSING);
      expect(f.auditActions()).toEqual([PAYOUT_AUDIT.CREATED, PAYOUT_AUDIT.SENT]);
      expect(f.outboxTypes()).toEqual([PAYMENT_EVENT.PAYOUT_CREATED, PAYMENT_EVENT.PAYOUT_PROCESSING]);
    });

    it('payos.payout trả KHÔNG ok ⇒ failed + failReason "code: message", không có providerRef; phát PAYOUT_FAILED', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.payos.payout.mockResolvedValueOnce({ ok: false, code: '99', message: 'Không gọi được cổng PayOS', raw: null });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      const created = await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.status).toBe(PAYOUT_STATUS.FAILED);
      expect(p.failReason).toBe('99: Không gọi được cổng PayOS');
      expect(p.providerRef).toBeNull();
      expect(created[0].status).toBe(PAYOUT_STATUS.FAILED);
      expect(f.auditActions()).toEqual([PAYOUT_AUDIT.CREATED, PAYOUT_AUDIT.FAILED]);
      expect(f.outboxTypes()).toEqual([PAYMENT_EVENT.PAYOUT_CREATED, PAYMENT_EVENT.PAYOUT_FAILED]);
    });

    it('failReason dài bị cắt còn 500 ký tự (khớp VarChar(500))', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.payos.payout.mockResolvedValueOnce({ ok: false, code: 'E1', message: 'x'.repeat(900), raw: null });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      await f.run();
      expect(f.payoutOf(SHOP_A).failReason).toHaveLength(500);
    });

    it('net > 0 mà shop THIẾU tài khoản ngân hàng ⇒ pending + failReason, KHÔNG gọi payos (kể cả đã cấu hình)', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, null);
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.status).toBe(PAYOUT_STATUS.PENDING);
      expect(p.failReason).toBe('Shop chưa khai báo tài khoản ngân hàng');
      expect(p.bankSnapshot).toBeNull();
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it('net > 0, thiếu ngân hàng, PayOS chưa cấu hình ⇒ cũng pending + failReason (không gọi payos)', async () => {
      const f = buildFixture({ payoutConfigured: false });
      f.banks.set(SHOP_A, null);
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      await f.run();
      expect(f.payoutOf(SHOP_A)).toMatchObject({ status: PAYOUT_STATUS.PENDING, failReason: 'Shop chưa khai báo tài khoản ngân hàng' });
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it('net < 0 (nợ mang sang lớn hơn doanh thu) ⇒ carried, KHÔNG gọi payos dù đã cấu hình + có ngân hàng', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: -500_000, status: PAYOUT_STATUS.CARRIED });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.status).toBe(PAYOUT_STATUS.CARRIED);
      expect(p.carriedDebt.toString()).toBe('500000');
      expect(p.netPayout.toString()).toBe('-410000'); // 100.000 − 10.000 − 0 − 500.000
      expect(p.failReason).toBeNull();
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it('net = 0 (nợ bù đúng phần còn lại) ⇒ settled, không chi', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: -90_000, status: PAYOUT_STATUS.CARRIED });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.status).toBe(PAYOUT_STATUS.SETTLED);
      expect(p.netPayout.toString()).toBe('0');
      expect(p.carriedDebt.toString()).toBe('90000');
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it('nợ nhỏ hơn doanh thu ròng ⇒ chi phần còn lại (net > 0 trừ nợ), amount gửi PayOS = net sau khi trừ nợ', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: -50_000, status: PAYOUT_STATUS.CARRIED });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.netPayout.toString()).toBe('40000');
      expect(p.carriedDebt.toString()).toBe('50000');
      expect(p.status).toBe(PAYOUT_STATUS.PROCESSING);
      expect(f.payos.payout).toHaveBeenCalledWith(contains({ amount: 40_000n }));
    });
  });

  /* ============================================================ */
  describe('run — nợ mang sang giữa các kỳ', () => {
    it('chuỗi nhiều kỳ: kỳ âm (chỉ có hoàn tiền) ⇒ carried; kỳ SAU trừ đúng nợ; kỳ kế tiếp nữa nợ về 0', async () => {
      const f = buildFixture({ payoutConfigured: true });
      // Kỳ tháng 2 đã chi 90.000; đơn DH-OLD (100.000, hoa hồng 10.000) nằm trong kỳ đó.
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PAID });
      f.seedSale('DH-OLD', 100_000, 10_000);
      f.seedRefund({ id: R1, orderCode: 'DH-OLD', amount: 100_000, processedAt: '2025-03-10' });

      // Kỳ 1 (tháng 3): chỉ có hoàn tiền ⇒ shop nợ 90.000.
      await f.run();
      expectNoSwallowedError();
      const p1 = f.payoutOf(SHOP_A);
      expect(p1.status).toBe(PAYOUT_STATUS.CARRIED);
      expect([p1.grossRevenue, p1.commission, p1.refundAmount, p1.carriedDebt, p1.netPayout].map(String)).toEqual(['0', '-10000', '100000', '0', '-90000']);
      expect(f.linesOf(p1.id)).toEqual([{ payoutId: p1.id, orderCode: R1_KEY, kind: 'refund', gross: D(100_000), commission: D(10_000) }]);
      expect(f.payos.payout).not.toHaveBeenCalled();

      // Kỳ 2 (tháng 4): doanh thu 200.000 ⇒ ròng 180.000 − nợ 90.000 = 90.000 được chi.
      f.setEligible([order('DH-N1', SHOP_A, 200_000)]);
      await f.run({ periodStart: PERIOD.periodEnd, periodEnd: new Date('2025-04-30T00:00:00.000Z') });
      expectNoSwallowedError();
      const p2 = f.payoutOf(SHOP_A);
      expect([p2.carriedDebt, p2.netPayout].map(String)).toEqual(['90000', '90000']);
      expect(p2.status).toBe(PAYOUT_STATUS.PROCESSING);
      expect(f.payos.payout).toHaveBeenCalledTimes(1);
      expect(f.payos.payout).toHaveBeenLastCalledWith(contains({ amount: 90_000n }));

      // Kỳ 3 (tháng 5): kỳ gần nhất dương ⇒ KHÔNG còn nợ.
      f.setEligible([order('DH-N2', SHOP_A, 50_000)]);
      await f.run({ periodStart: new Date('2025-04-30T00:00:00.000Z'), periodEnd: new Date('2025-05-31T00:00:00.000Z') });
      expectNoSwallowedError();
      const p3 = f.payoutOf(SHOP_A);
      expect([p3.carriedDebt, p3.netPayout].map(String)).toEqual(['0', '45000']);
    });

    it('nợ chồng nhiều kỳ không bị cộng dồn hai lần (kỳ âm sau đã gộp nợ cũ vào net của nó)', async () => {
      const f = buildFixture();
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: -90_000, status: PAYOUT_STATUS.CARRIED });
      f.setEligible([order('DH-1', SHOP_A, 50_000)]); // ròng 45.000 − nợ 90.000 = −45.000

      await f.run();
      expectNoSwallowedError();
      expect(f.payoutOf(SHOP_A)).toMatchObject({ status: PAYOUT_STATUS.CARRIED });
      expect(f.payoutOf(SHOP_A).netPayout.toString()).toBe('-45000');

      f.setEligible([order('DH-2', SHOP_A, 10_000)]); // ròng 9.000 − nợ 45.000 (KHÔNG phải 135.000) = −36.000
      await f.run({ periodStart: PERIOD.periodEnd, periodEnd: new Date('2025-04-30T00:00:00.000Z') });
      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.carriedDebt.toString()).toBe('45000');
      expect(p.netPayout.toString()).toBe('-36000');
    });

    it('kỳ gần nhất dương/0 ⇒ carriedDebt = 0; "gần nhất" tính theo periodEnd (không theo createdAt)', async () => {
      const f = buildFixture();
      // Kỳ tháng 1: âm nhưng được TẠO SAU cùng (createdAt mới nhất) — vẫn không phải kỳ gần nhất theo periodEnd.
      f.seedPayout({ shopId: SHOP_A, start: '2025-01-01', end: '2025-01-31', net: -999_999, status: PAYOUT_STATUS.CARRIED, createdAt: '2025-12-01' });
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 70_000, status: PAYOUT_STATUS.PAID, createdAt: '2025-03-01' });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.carriedDebt.toString()).toBe('0');
      expect(p.netPayout.toString()).toBe('90000');
    });

    it('kỳ gần nhất net = 0 (settled) ⇒ carriedDebt = 0', async () => {
      const f = buildFixture();
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 0, status: PAYOUT_STATUS.SETTLED });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      await f.run();
      expect(f.payoutOf(SHOP_A).carriedDebt.toString()).toBe('0');
    });

    it('nợ chỉ áp cho ĐÚNG shop gây ra nó (shop khác trong cùng kỳ không bị trừ)', async () => {
      const f = buildFixture();
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: -30_000, status: PAYOUT_STATUS.CARRIED });
      f.setEligible([order('DH-1', SHOP_A, 100_000), order('DH-2', SHOP_B, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      expect(f.payoutOf(SHOP_A).carriedDebt.toString()).toBe('30000');
      expect(f.payoutOf(SHOP_A).netPayout.toString()).toBe('60000');
      expect(f.payoutOf(SHOP_B).carriedDebt.toString()).toBe('0');
      expect(f.payoutOf(SHOP_B).netPayout.toString()).toBe('90000');
    });
  });

  /* ============================================================ */
  describe('run — hoàn tiền', () => {
    it('hoàn tiền (done, có shopId) của đơn được tính bán Ở KỲ NÀY ⇒ trừ refund và hoàn lại hoa hồng theo tỷ lệ hiệu dụng', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 1_000_000)]); // hoa hồng 100.000
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 250_000 });

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.grossRevenue.toString()).toBe('1000000');
      expect(p.refundAmount.toString()).toBe('250000');
      expect(p.commission.toString()).toBe('75000'); // 100.000 − 25.000 hoa hồng hoàn lại
      expect(p.netPayout.toString()).toBe('675000'); // = (1.000.000 − 250.000) × 90%
      expect(f.linesOf(p.id).map((l) => [l.kind, l.orderCode, l.gross.toString(), l.commission.toString()])).toEqual([
        ['sale', 'DH-1', '1000000', '100000'],
        ['refund', R1_KEY, '250000', '25000'],
      ]);
    });

    it('khoá dòng hoàn tiền = "RF-" + 26 ký tự hex đầu của id (vừa VarChar(30))', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 10_000 });
      await f.run();
      const keys = f.state.lines.filter((l) => l.kind === 'refund').map((l) => l.orderCode);
      expect(keys).toEqual([R1_KEY]);
      expect(keys[0].length).toBeLessThanOrEqual(30);
    });

    it('hoa hồng hoàn lại làm tròn nửa lên: đơn 200 (hoa hồng 20), hoàn 25 ⇒ 2.5 → 3', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 200)]);
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 25 });
      await f.run();
      const p = f.payoutOf(SHOP_A);
      expect(f.linesOf(p.id).find((l) => l.kind === 'refund')!.commission.toString()).toBe('3');
      expect([p.commission, p.refundAmount, p.netPayout].map(String)).toEqual(['17', '25', '158']); // 200 − 17 − 25
    });

    it('hoàn tiền của đơn đã tính bán Ở KỲ TRƯỚC (dòng sale trong DB) ⇒ vẫn trừ, dùng gross/commission của dòng bán cũ', async () => {
      const f = buildFixture();
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PAID });
      f.seedSale('DH-OLD', 100_000, 10_000);
      f.setEligible([order('DH-NEW', SHOP_A, 300_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-OLD', amount: 40_000 });

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.refundAmount.toString()).toBe('40000');
      expect(p.commission.toString()).toBe('26000'); // 30.000 − 4.000 (40.000 × 10.000/100.000)
      expect(p.netPayout.toString()).toBe('234000'); // 300.000 − 26.000 − 40.000
    });

    it('hoàn tiền của đơn CHƯA từng tính bán (chưa qua escrow / hoàn toàn bộ trước escrow) ⇒ bỏ qua, không trừ', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-CHUA-BAN', amount: 80_000 });

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.refundAmount.toString()).toBe('0');
      expect(p.netPayout.toString()).toBe('90000');
      expect(f.state.lines.some((l) => l.kind === 'refund')).toBe(false);
    });

    it('shop chỉ có hoàn tiền của đơn chưa bán ⇒ không tạo kỳ nào (không sinh nợ ảo)', async () => {
      const f = buildFixture();
      f.seedRefund({ id: R1, orderCode: 'DH-CHUA-BAN', amount: 80_000 });
      expect(await f.run()).toEqual([]);
      expect(f.state.payouts).toHaveLength(0);
    });

    it('hoàn tiền đã nằm trong kỳ trước (dòng refund trùng khoá) ⇒ KHÔNG trừ lần hai', async () => {
      const f = buildFixture();
      f.seedSale('DH-OLD', 100_000, 10_000);
      f.seedRefundLine(R1_KEY);
      f.seedRefund({ id: R1, orderCode: 'DH-OLD', amount: 40_000 });
      f.setEligible([order('DH-NEW', SHOP_A, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      expect(f.payoutOf(SHOP_A).refundAmount.toString()).toBe('0');
      expect(f.payoutOf(SHOP_A).netPayout.toString()).toBe('90000');
    });

    it.each([
      ['chưa xong (processing)', { status: 'processing' }],
      ['thất bại (failed)', { status: 'failed' }],
      ['không có shopId (đơn cũ)', { shopId: null }],
      ['xử lý sau hết kỳ', { processedAt: '2025-04-15' }],
      ['chưa có processedAt', { processedAt: null }],
    ])('hoàn tiền %s ⇒ không trừ kỳ này', async (_label, override) => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 30_000, ...override });
      await f.run();
      expectNoSwallowedError();
      expect(f.payoutOf(SHOP_A).refundAmount.toString()).toBe('0');
      expect(f.payoutOf(SHOP_A).netPayout.toString()).toBe('90000');
    });

    it('hoàn tiền xử lý đúng ngày kết thúc kỳ (processedAt = periodEnd) vẫn được tính (≤)', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 30_000, processedAt: '2025-03-31' });
      await f.run();
      expect(f.payoutOf(SHOP_A).refundAmount.toString()).toBe('30000');
    });

    it('hoàn tiền xử lý SAU kỳ này được trừ ở kỳ sau (không bị mất)', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 30_000, processedAt: '2025-04-15' });
      await f.run();
      expect(f.payoutOf(SHOP_A).refundAmount.toString()).toBe('0');

      f.setEligible([]);
      await f.run({ periodStart: PERIOD.periodEnd, periodEnd: new Date('2025-04-30T00:00:00.000Z') });
      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.refundAmount.toString()).toBe('30000');
      expect(p.commission.toString()).toBe('-3000');
      expect(p.status).toBe(PAYOUT_STATUS.CARRIED);
      expect(p.netPayout.toString()).toBe('-27000');
    });

    it('nhiều lần hoàn tiền của cùng một đơn: mỗi lần một dòng riêng, cộng đúng tổng', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 1_000_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 100_000, processedAt: '2025-03-05' });
      f.seedRefund({ id: R2, orderCode: 'DH-1', amount: 200_000, processedAt: '2025-03-10' });
      await f.run();
      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.refundAmount.toString()).toBe('300000');
      expect(p.commission.toString()).toBe('70000'); // 100.000 − 10.000 − 20.000
      expect(p.netPayout.toString()).toBe('630000'); // 1.000.000 − 70.000 − 300.000
      expect(f.linesOf(p.id).filter((l) => l.kind === 'refund').map((l) => [l.orderCode, l.gross.toString(), l.commission.toString()])).toEqual([
        [rfKey(R1), '100000', '10000'],
        [rfKey(R2), '200000', '20000'],
      ]);
    });

    it('hoàn tiền được gán đúng shop theo snapshot trên refund (không lẫn sang shop khác)', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-A', SHOP_A, 100_000), order('DH-B', SHOP_B, 100_000)]);
      f.seedRefund({ id: R3, orderCode: 'DH-B', amount: 50_000, shopId: SHOP_B });
      await f.run();
      expectNoSwallowedError();
      expect(f.payoutOf(SHOP_A).refundAmount.toString()).toBe('0');
      expect(f.payoutOf(SHOP_B).refundAmount.toString()).toBe('50000');
      expect(f.payoutOf(SHOP_B).netPayout.toString()).toBe('45000'); // 100.000 − 5.000 − 50.000
    });

    /*
     * Hoàn tiền chia theo TỈ LỆ LUỸ KẾ trên khách đã trả T (= order.total): với G = doanh thu dòng bán (T + voucher sàn), C = hoa hồng dòng bán,
     * mỗi dòng refund = round(G × cumSau / T) − round(G × cumTrước / T) (gross) và round(C × cumSau / T) − round(C × cumTrước / T) (hoa hồng),
     * cum tính theo thứ tự processedAt và gồm cả các lần hoàn đã nằm trong kỳ trước ⇒ hoàn đủ T thì hoàn đúng G và C, không lệch làm tròn.
     */
    it('hoàn đủ đơn có voucher sàn ⇒ hoàn đúng doanh thu G và hoa hồng C ⇒ net cặp sale + refund = 0 (shop không giữ phần voucher)', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-V', SHOP_A, 90_000, '10.00', 10_000)]); // G = 100.000, C = 10.000, T = 90.000
      f.seedRefund({ id: R1, orderCode: 'DH-V', amount: 90_000 });

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect([p.grossRevenue, p.commission, p.refundAmount, p.netPayout].map(String)).toEqual(['100000', '0', '100000', '0']);
      expect(p.status).toBe(PAYOUT_STATUS.SETTLED);
      expect(f.linesOf(p.id).map((l) => [l.kind, l.gross.toString(), l.commission.toString()])).toEqual([
        ['sale', '100000', '10000'],
        ['refund', '100000', '10000'],
      ]);
    });

    it('hoàn MỘT PHẦN đơn có voucher sàn: doanh thu hoàn theo tỉ lệ khách đã trả (45.000/90.000 ⇒ ½ của G), không theo số tiền hoàn', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-V', SHOP_A, 90_000, '10.00', 10_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-V', amount: 45_000 });

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(f.linesOf(p.id).find((l) => l.kind === 'refund')).toMatchObject({ gross: D(50_000), commission: D(5_000) });
      expect([p.refundAmount, p.commission, p.netPayout].map(String)).toEqual(['50000', '5000', '45000']); // 100.000 − 5.000 − 50.000
    });

    it('[đã sửa — lệch làm tròn] đơn 100đ, rate 5%, hoàn 33 + 33 + 34: tổng hoa hồng hoàn đúng bằng hoa hồng gốc (5), net = 0', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100, '5.00')]); // C = 5
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 33, processedAt: '2025-03-05' });
      f.seedRefund({ id: R2, orderCode: 'DH-1', amount: 33, processedAt: '2025-03-10' });
      f.seedRefund({ id: R3, orderCode: 'DH-1', amount: 34, processedAt: '2025-03-12' });

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      const refunds = f.linesOf(p.id).filter((l) => l.kind === 'refund');
      expect(refunds.map((l) => [l.orderCode, l.gross.toString(), l.commission.toString()])).toEqual([
        [rfKey(R1), '33', '2'],
        [rfKey(R2), '33', '1'], // luỹ kế 66: round(3.3) = 3 ⇒ 3 − 2
        [rfKey(R3), '34', '2'],
      ]);
      expect([p.grossRevenue, p.commission, p.refundAmount, p.netPayout].map(String)).toEqual(['100', '0', '100', '0']);
    });

    it.each([
      ['một lần', [999]],
      ['hai lần lệch', [1, 998]],
      ['hai nửa', [500, 499]],
      ['ba phần gần bằng nhau', [333, 333, 333]],
      ['bốn phần lẻ', [101, 202, 303, 393]],
    ])('đơn lẻ có voucher sàn, hoàn đủ kiểu "%s": luôn hoàn đúng G = 1.036 và C = 76 ⇒ net = 0', async (_label, parts) => {
      // T = 999, voucher sàn 37 ⇒ G = 1.036; rate 7.35% ⇒ C = round(76.146) = 76. Các lần hoàn cộng lại = T ⇒ phải hoàn đúng G và C.
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 999, '7.35', 37)]);
      parts.forEach((amount, i) => {
        f.seedRefund({ id: `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`, orderCode: 'DH-1', amount, processedAt: `2025-03-${String(i + 1).padStart(2, '0')}` });
      });

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect([p.grossRevenue, p.refundAmount, p.commission, p.netPayout].map(String)).toEqual(['1036', '1036', '0', '0']);
    });

    it('thứ tự dòng hoàn theo processedAt (không theo thứ tự lưu hay id): lưu xáo trộn vẫn ra cùng kết quả', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 1000, '5.00')]); // C = 50
      // Lưu xáo trộn; theo ngày: R1 (150) → R2 (150) → R3 (700) ⇒ hoa hồng hoàn 8 / 7 / 35 (luỹ kế 7.5→8, 15, 50). Sắp theo id sẽ ra R1 = 7 (sai).
      f.seedRefund({ id: R3, orderCode: 'DH-1', amount: 700, processedAt: '2025-03-12' });
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 150, processedAt: '2025-03-05' });
      f.seedRefund({ id: R2, orderCode: 'DH-1', amount: 150, processedAt: '2025-03-10' });

      await f.run();

      expectNoSwallowedError();
      const refunds = f.linesOf(f.payoutOf(SHOP_A).id).filter((l) => l.kind === 'refund');
      expect(refunds.map((l) => [l.orderCode, l.gross.toString(), l.commission.toString()])).toEqual([
        [rfKey(R1), '150', '8'],
        [rfKey(R2), '150', '7'],
        [rfKey(R3), '700', '35'],
      ]);
      expect(f.db.refund.findMany).toHaveBeenCalledWith(contains({ orderBy: [{ processedAt: 'asc' }, { id: 'asc' }] }));
    });

    it('lần hoàn mới chia theo luỹ kế GỒM CẢ các lần hoàn đã nằm trong kỳ trước (dòng refund cũ không bị tính lại)', async () => {
      const f = buildFixture();
      f.seedSale('DH-OLD', 105, 11, { platformDiscount: 5, total: 100 }); // G = 105, C = 11, T = 100
      f.seedRefund({ id: R1, orderCode: 'DH-OLD', amount: 33, processedAt: '2025-03-05' }); // đã ở kỳ trước
      f.seedRefundLine(rfKey(R1));
      f.seedRefund({ id: R2, orderCode: 'DH-OLD', amount: 33, processedAt: '2025-03-10' });
      f.seedRefund({ id: R3, orderCode: 'DH-OLD', amount: 34, processedAt: '2025-03-12' });

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      // luỹ kế 33 → gross 35, hoa hồng 4 (kỳ trước); 66 → 69 / 7; 100 → 105 / 11
      expect(f.linesOf(p.id).map((l) => [l.orderCode, l.gross.toString(), l.commission.toString()])).toEqual([
        [rfKey(R2), '34', '3'],
        [rfKey(R3), '36', '4'],
      ]);
      expect([p.grossRevenue, p.refundAmount, p.commission, p.netPayout].map(String)).toEqual(['0', '70', '-7', '-63']);
      expect(p.status).toBe(PAYOUT_STATUS.CARRIED);
    });

    it('chỉ hỏi orderTotalsOf những đơn có hoàn tiền MỚI và đã được tính bán', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-1', amount: 10_000, processedAt: '2025-03-05' }); // mới + đơn tính bán kỳ này
      f.seedSale('DH-OLD', 100_000, 10_000);
      f.seedRefund({ id: R2, orderCode: 'DH-OLD', amount: 10_000, processedAt: '2025-03-06' }); // đã nằm trong kỳ trước
      f.seedRefundLine(rfKey(R2));
      f.seedRefund({ id: R3, orderCode: 'DH-CHUA-BAN', amount: 10_000, processedAt: '2025-03-07' }); // đơn chưa từng tính bán

      await f.run();

      expectNoSwallowedError();
      expect(f.orders.orderTotalsOf).toHaveBeenCalledTimes(1);
      expect(f.orders.orderTotalsOf).toHaveBeenCalledWith(['DH-1']);
    });

    it('không có hoàn tiền nào ⇒ orderTotalsOf được gọi với mảng rỗng (không truy vấn thừa)', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      await f.run();
      expect(f.orders.orderTotalsOf).toHaveBeenCalledWith([]);
    });

    it('orderTotalsOf không trả về đơn (đơn không còn trong bảng đơn) ⇒ bỏ qua dòng hoàn, không lỗi', async () => {
      const f = buildFixture();
      f.seedSale('DH-OLD', 100_000, 10_000);
      f.setEligible([order('DH-NEW', SHOP_A, 20_000)]);
      f.seedRefund({ id: R1, orderCode: 'DH-OLD', amount: 40_000 });
      f.orders.orderTotalsOf.mockResolvedValueOnce(new Map());

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.refundAmount.toString()).toBe('0');
      expect(f.state.lines.some((l) => l.kind === 'refund')).toBe(false);
    });

    it('khách trả T = 0 (đơn miễn phí nhờ voucher sàn) ⇒ bỏ qua hoàn tiền, không chia cho 0', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-Z', SHOP_A, 0, '10.00', 100)]); // G = 100, C = 10
      f.seedRefund({ id: R1, orderCode: 'DH-Z', amount: 10 });

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect([p.grossRevenue, p.commission, p.refundAmount, p.netPayout].map(String)).toEqual(['100', '10', '0', '90']);
      expect(f.state.lines.some((l) => l.kind === 'refund')).toBe(false);
    });
  });

  /* ============================================================ */
  describe('run — validate kỳ', () => {
    it.each([
      ['start = end', new Date('2025-03-01T00:00:00.000Z'), new Date('2025-03-01T00:00:00.000Z')],
      ['start > end', new Date('2025-03-31T00:00:00.000Z'), new Date('2025-03-01T00:00:00.000Z')],
      ['ngày không hợp lệ (NaN)', new Date('khong-phai-ngay'), new Date('2025-03-01T00:00:00.000Z')],
    ])('%s ⇒ INVALID_PERIOD, không đụng DB/đơn hàng', async (_label, start, end) => {
      const f = buildFixture();
      const err = await catchBusiness(f.run({ periodStart: start, periodEnd: end }));
      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_PERIOD);
      expect(f.orders.settlementOrders).not.toHaveBeenCalled();
      expect(f.db.shopPayout.findFirst).not.toHaveBeenCalled();
    });

    it('kỳ kết thúc ở TƯƠNG LAI ⇒ INVALID_PERIOD (escrow chưa chốt)', async () => {
      const f = buildFixture();
      const err = await catchBusiness(f.run({ periodStart: new Date('2025-03-01T00:00:00.000Z'), periodEnd: new Date(Date.now() + 86_400_000) }));
      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_PERIOD);
      expect(f.orders.settlementOrders).not.toHaveBeenCalled();
    });

    it('kỳ chồng lên kỳ đã chạy ⇒ PERIOD_OVERLAP (409), kèm mã kỳ cũ, không gom đơn', async () => {
      const f = buildFixture();
      const old = f.seedPayout({ shopId: SHOP_A, start: '2025-03-01', end: '2025-03-31', net: 10_000, status: PAYOUT_STATUS.PAID });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      const err = await catchBusiness(f.run({ periodStart: new Date('2025-03-15T00:00:00.000Z'), periodEnd: new Date('2025-04-15T00:00:00.000Z') }));

      expect(err.errorCode).toBe(PAYOUT_ERR.PERIOD_OVERLAP);
      expect(err.httpStatus).toBe(409);
      expect(err.message).toContain(old.code);
      expect(f.orders.settlementOrders).not.toHaveBeenCalled();
      expect(f.state.payouts).toHaveLength(1);
    });

    it('kỳ nằm TRƯỚC (chồng) một kỳ đã chạy cũng bị chặn — chuỗi nợ phải đi theo thứ tự thời gian', async () => {
      const f = buildFixture();
      f.seedPayout({ shopId: SHOP_A, start: '2025-03-01', end: '2025-03-31', net: 10_000, status: PAYOUT_STATUS.PAID });
      const err = await catchBusiness(f.run({ periodStart: new Date('2025-02-01T00:00:00.000Z'), periodEnd: new Date('2025-02-28T00:00:00.000Z') }));
      expect(err.errorCode).toBe(PAYOUT_ERR.PERIOD_OVERLAP);
    });

    it('kỳ LIỀN KỀ (start = end của kỳ trước) hợp lệ; chạy lại ĐÚNG kỳ cũ không bị coi là chồng', async () => {
      const f = buildFixture();
      f.seedPayout({ shopId: SHOP_B, start: '2025-02-01', end: '2025-03-01', net: 10_000, status: PAYOUT_STATUS.PAID });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      expect(await f.run()).toHaveLength(1); // start 2025-03-01 = end kỳ cũ
      expect(await f.run()).toEqual([]); // đúng kỳ vừa chạy: không ném PERIOD_OVERLAP
      expectNoSwallowedError();
    });
  });

  /* ============================================================ */
  describe('run — lỗi từng shop không kéo cả kỳ', () => {
    it('shop B ném lỗi (đọc ngân hàng) ⇒ shop A vẫn có kỳ, lỗi được log, run không ném', async () => {
      const f = buildFixture();
      f.shops.bankAccountOf.mockImplementation((shopId: string) => (shopId === SHOP_B ? Promise.reject(new Error('shop service chết')) : Promise.resolve(BANK)));
      f.setEligible([order('DH-B', SHOP_B, 100_000), order('DH-A', SHOP_A, 100_000)]);

      const created = await f.run();

      expect(created.map((p) => p.shopId)).toEqual([SHOP_A]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(f.state.payouts.map((p) => p.shopId)).toEqual([SHOP_A]);
    });

    it('lỗi GIỮA transaction của shop B ⇒ rollback toàn bộ (không kỳ/dòng nửa vời); chạy lại sau đó hoàn tất B và không đụng A', async () => {
      const f = buildFixture();
      f.audit.write.mockImplementation((_tx, _actor, entry) => (String(entry.entityCode).includes('BBBBBBBB') ? Promise.reject(new Error('audit chết')) : Promise.resolve()));
      f.setEligible([order('DH-A', SHOP_A, 100_000), order('DH-B', SHOP_B, 200_000)]);

      const first = await f.run();

      expect(first.map((p) => p.shopId)).toEqual([SHOP_A]);
      expect(f.state.payouts.map((p) => p.shopId)).toEqual([SHOP_A]);
      expect(f.state.lines.map((l) => l.orderCode)).toEqual(['DH-A']); // DH-B chưa bị "đánh dấu đã tính"

      f.audit.write.mockImplementation(() => Promise.resolve());
      errorSpy.mockClear();
      const again = await f.run();

      expectNoSwallowedError();
      expect(again.map((p) => p.shopId)).toEqual([SHOP_B]);
      expect(f.payoutOf(SHOP_B).netPayout.toString()).toBe('180000');
      expect(f.state.payouts).toHaveLength(2);
    });

    it('vi phạm UNIQUE (chạy song song) bị bỏ qua êm: không log lỗi, không tạo kỳ trùng', async () => {
      const f = buildFixture();
      f.setEligible([order('DH-A', SHOP_A, 100_000)]);
      // Giả lập tiến trình khác vừa chèn kỳ SAU khi bước kiểm tra tồn tại: findUnique trả null nhưng create đụng UNIQUE.
      f.seedPayout({ shopId: SHOP_A, start: '2025-03-01', end: '2025-03-31', net: 1, status: PAYOUT_STATUS.PENDING });
      f.db.shopPayout.findUnique.mockResolvedValueOnce(null);

      const created = await f.run();

      expect(created).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(f.state.payouts).toHaveLength(1);
    });
  });

  /* ============================================================ */
  describe('markPaid', () => {
    const input = { providerRef: 'FT25031299999', note: 'CK tay 10h' };

    it.each([PAYOUT_STATUS.PROCESSING, PAYOUT_STATUS.FAILED])('cho phép từ %s ⇒ paid + providerRef + paidAt, xoá failReason, audit + outbox', async (status) => {
      const f = buildFixture({ payoutConfigured: true });
      const seed = f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status, id: 'p-1', failReason: status === 'failed' ? '99: lỗi' : null });

      const res = await f.service.markPaid('p-1', input, actor);

      expect(res.status).toBe(PAYOUT_STATUS.PAID);
      expect(seed.providerRef).toBe(input.providerRef);
      expect(seed.failReason).toBeNull();
      expect(seed.paidAt).toBeInstanceOf(Date);
      expect(seed.version).toBe(1);
      expect(f.auditActions()).toEqual([PAYOUT_AUDIT.MARKED_PAID]);
      expect(f.audit.write.mock.calls[0][2]).toMatchObject({ before: { status }, after: { status: 'paid', providerRef: input.providerRef, note: input.note } });
      expect(f.outbox.publish.mock.calls[0][1]).toMatchObject({ eventType: PAYMENT_EVENT.PAYOUT_PAID, payload: contains({ payoutId: 'p-1', netPayout: '90000', status: 'paid', shopId: SHOP_A }) });
    });

    it('từ PENDING: được khi PayOS CHƯA cấu hình (chuyển tay)', async () => {
      const f = buildFixture({ payoutConfigured: false });
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PENDING, id: 'p-1' });
      const res = await f.service.markPaid('p-1', input, actor);
      expect(res.status).toBe(PAYOUT_STATUS.PAID);
    });

    it('từ PENDING khi PayOS ĐÃ cấu hình ⇒ INVALID_STATE kèm gợi ý dùng "chạy lại", không đổi trạng thái', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const seed = f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PENDING, id: 'p-1' });
      const err = await catchBusiness(f.service.markPaid('p-1', input, actor));
      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
      expect(err.message).toContain('chạy lại');
      expect(seed.status).toBe(PAYOUT_STATUS.PENDING);
      expect(f.outbox.publish).not.toHaveBeenCalled();
    });

    it.each([PAYOUT_STATUS.PAID, PAYOUT_STATUS.CARRIED, PAYOUT_STATUS.SETTLED])('từ %s ⇒ INVALID_STATE, không đổi gì, không audit/outbox', async (status) => {
      for (const configured of [true, false]) {
        const f = buildFixture({ payoutConfigured: configured });
        const seed = f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: status === 'carried' ? -5_000 : 0, status, id: 'p-1' });
        const err = await catchBusiness(f.service.markPaid('p-1', input, actor));
        expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
        expect(seed.status).toBe(status);
        expect(seed.providerRef).toBeNull();
        expect(f.audit.write).not.toHaveBeenCalled();
        expect(f.outbox.publish).not.toHaveBeenCalled();
      }
    });

    it('updateMany count = 0 (race: người khác đổi trạng thái giữa lúc đọc và ghi) ⇒ INVALID_STATE 409, không audit/outbox', async () => {
      const f = buildFixture();
      const seed = f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PROCESSING, id: 'p-1' });
      f.db.shopPayout.updateMany.mockResolvedValueOnce({ count: 0 });

      const err = await catchBusiness(f.service.markPaid('p-1', input, actor));

      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
      expect(err.httpStatus).toBe(409);
      expect(f.audit.write).not.toHaveBeenCalled();
      expect(f.outbox.publish).not.toHaveBeenCalled();
      expect(seed.status).toBe(PAYOUT_STATUS.PROCESSING);
    });

    it('điều kiện ghi dùng đúng trạng thái đã đọc (compare-and-set)', async () => {
      const f = buildFixture();
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.FAILED, id: 'p-1' });
      await f.service.markPaid('p-1', input, actor);
      expect(f.db.shopPayout.updateMany).toHaveBeenCalledWith(contains({ where: { id: 'p-1', status: 'failed' } }));
    });

    it('hai kế toán bấm ĐỒNG THỜI: chỉ một thành công, sự kiện PAYOUT_PAID chỉ phát một lần', async () => {
      const f = buildFixture();
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PROCESSING, id: 'p-1' });
      const results = await Promise.allSettled([f.service.markPaid('p-1', { providerRef: 'A' }, actor), f.service.markPaid('p-1', { providerRef: 'B' }, actor)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as BusinessException).errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
      expect(f.outbox.publish).toHaveBeenCalledTimes(1);
      expect(f.state.payouts[0].providerRef).toBe('A');
    });

    it('đánh dấu lần hai ⇒ INVALID_STATE (paid)', async () => {
      const f = buildFixture();
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PROCESSING, id: 'p-1' });
      await f.service.markPaid('p-1', input, actor);
      const err = await catchBusiness(f.service.markPaid('p-1', input, actor));
      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
    });

    it('không tồn tại ⇒ NotFoundException PAYOUT_NOT_FOUND', async () => {
      const f = buildFixture();
      const err = await catchBusiness(f.service.markPaid('khong-co', input, actor));
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.errorCode).toBe(PAYOUT_ERR.NOT_FOUND);
    });
  });

  /* ============================================================ */
  describe('retry', () => {
    const failed = (f: Fixture, over: Partial<Parameters<Fixture['seedPayout']>[0]> = {}) =>
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.FAILED, id: 'p-1', bankSnapshot: BANK, failReason: '99: lỗi', ...over });

    it('failed + PayOS cấu hình + net > 0 ⇒ chạy lại: gọi payos ĐÚNG 1 lần với idempotencyKey = mã kỳ, ok ⇒ processing + providerRef, xoá failReason', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const seed = failed(f);

      const res = await f.service.retry('p-1', actor);

      expect(f.payos.payout).toHaveBeenCalledTimes(1);
      expect(f.payos.payout).toHaveBeenCalledWith({ referenceId: seed.code, amount: 90_000n, toBin: BANK.bankCode, toAccountNumber: BANK.accountNumber, description: `FITLY ${seed.code}`, idempotencyKey: seed.code });
      expect(res.status).toBe(PAYOUT_STATUS.PROCESSING);
      expect(res.providerRef).toBe('TX-1');
      expect(res.failReason).toBeNull();
      expect(f.auditActions()).toEqual([PAYOUT_AUDIT.RETRIED, PAYOUT_AUDIT.SENT]);
    });

    it('chạy lại mà PayOS lại từ chối ⇒ failed + failReason mới, KHÔNG phát processing', async () => {
      const f = buildFixture({ payoutConfigured: true });
      failed(f);
      f.payos.payout.mockResolvedValueOnce({ ok: false, code: '231', message: 'Số TK không đúng', raw: null });
      const res = await f.service.retry('p-1', actor);
      expect(res.status).toBe(PAYOUT_STATUS.FAILED);
      expect(res.failReason).toBe('231: Số TK không đúng');
      expect(f.outboxTypes()).toEqual([PAYMENT_EVENT.PAYOUT_FAILED]);
    });

    it('dùng snapshot ngân hàng của kỳ (không lấy hồ sơ shop mới) khi snapshot đã có', async () => {
      const f = buildFixture({ payoutConfigured: true });
      failed(f);
      f.banks.set(SHOP_A, { bankCode: '000000', accountNumber: '1', accountName: 'DOI SAU' });
      await f.service.retry('p-1', actor);
      expect(f.payos.payout).toHaveBeenCalledWith(contains({ toBin: BANK.bankCode, toAccountNumber: BANK.accountNumber }));
      // hồ sơ hiện tại chỉ được đọc để kiểm giữ chi trả 24 giờ — tiền vẫn đi theo snapshot của kỳ
      expect(f.shops.bankAccountOf).toHaveBeenCalledTimes(1);
    });

    it('pending (chưa có snapshot, shop vừa bổ sung ngân hàng) ⇒ lấy TK hiện tại, lưu snapshot, gọi payos', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const seed = f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PENDING, id: 'p-1', bankSnapshot: null, failReason: 'Shop chưa khai báo tài khoản ngân hàng' });

      const res = await f.service.retry('p-1', actor);

      expect(f.payos.payout).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(PAYOUT_STATUS.PROCESSING);
      expect(seed.bankSnapshot).toEqual(BANK);
      expect(seed.failReason).toBeNull();
    });

    it('pending mà shop VẪN thiếu ngân hàng ⇒ INVALID_STATE, không gọi payos, không đổi trạng thái', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, null);
      const seed = f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PENDING, id: 'p-1', bankSnapshot: null });
      const err = await catchBusiness(f.service.retry('p-1', actor));
      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
      expect(f.payos.payout).not.toHaveBeenCalled();
      expect(seed.status).toBe(PAYOUT_STATUS.PENDING);
    });

    it('PayOS CHƯA cấu hình ⇒ INVALID_STATE, không gọi payos, không đổi trạng thái', async () => {
      const f = buildFixture({ payoutConfigured: false });
      const seed = failed(f);
      const err = await catchBusiness(f.service.retry('p-1', actor));
      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
      expect(f.payos.payout).not.toHaveBeenCalled();
      expect(seed.status).toBe(PAYOUT_STATUS.FAILED);
      expect(f.audit.write).not.toHaveBeenCalled();
    });

    it.each([PAYOUT_STATUS.PAID, PAYOUT_STATUS.CARRIED, PAYOUT_STATUS.SETTLED])('trạng thái %s không được chạy lại ⇒ INVALID_STATE, không gọi payos', async (status) => {
      const f = buildFixture({ payoutConfigured: true });
      const seed = failed(f, { status });
      const err = await catchBusiness(f.service.retry('p-1', actor));
      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
      expect(f.payos.payout).not.toHaveBeenCalled();
      expect(seed.status).toBe(status);
    });

    it.each([0, -10_000])('net = %i (không có khoản cần chi) ⇒ INVALID_STATE, không gọi payos', async (net) => {
      const f = buildFixture({ payoutConfigured: true });
      failed(f, { net });
      const err = await catchBusiness(f.service.retry('p-1', actor));
      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it('race: updateMany count = 0 ⇒ INVALID_STATE 409, KHÔNG gọi payos (không chi khi không giành được kỳ)', async () => {
      const f = buildFixture({ payoutConfigured: true });
      failed(f);
      f.db.shopPayout.updateMany.mockResolvedValueOnce({ count: 0 });
      const err = await catchBusiness(f.service.retry('p-1', actor));
      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
      expect(err.httpStatus).toBe(409);
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it('hai lần "chạy lại" ĐỒNG THỜI ⇒ chỉ một lệnh chi PayOS', async () => {
      const f = buildFixture({ payoutConfigured: true });
      failed(f);
      const results = await Promise.allSettled([f.service.retry('p-1', actor), f.service.retry('p-1', actor)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(f.payos.payout).toHaveBeenCalledTimes(1);
    });

    it('kế toán đánh dấu đã trả TRONG LÚC chờ PayOS phản hồi ⇒ không bị ghi đè về processing/failed, không audit SENT', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const seed = failed(f);
      f.payos.payout.mockImplementationOnce(() => {
        seed.status = PAYOUT_STATUS.PAID; // mark-paid chen vào giữa
        seed.providerRef = 'TAY-1';
        return Promise.resolve({ ok: false, code: '99', message: 'timeout', raw: null });
      });

      const res = await f.service.retry('p-1', actor);

      expect(res.status).toBe(PAYOUT_STATUS.PAID);
      expect(seed.providerRef).toBe('TAY-1');
      expect(f.auditActions()).toEqual([PAYOUT_AUDIT.RETRIED]);
      expect(f.outbox.publish).not.toHaveBeenCalled();
    });

    /*
     * Kỳ `processing` TREO: service ghi `processing` TRƯỚC rồi mới gọi PayOS; nếu tiến trình chết giữa chừng thì kỳ kẹt ở `processing` mãi.
     * Quá STUCK_PROCESSING_MS (10 phút) kể từ updatedAt thì cho gửi lại (idempotency-key = mã kỳ nên không chi đôi); chưa quá hạn thì chặn
     * vì PayOS có thể vẫn đang xử lý lệnh trước.
     */
    describe('kỳ processing bị TREO', () => {
      const minutesAgo = (m: number) => new Date(Date.now() - m * MIN);

      it('processing quá 10 phút ⇒ được gửi lại: payos gọi đúng 1 lần với idempotencyKey = mã kỳ, ok ⇒ processing + providerRef, audit RETRIED + SENT', async () => {
        const f = buildFixture({ payoutConfigured: true });
        const seed = failed(f, { status: PAYOUT_STATUS.PROCESSING, failReason: null, updatedAt: minutesAgo(11) });

        const res = await f.service.retry('p-1', actor);

        expect(f.payos.payout).toHaveBeenCalledTimes(1);
        expect(f.payos.payout).toHaveBeenCalledWith(contains({ referenceId: seed.code, idempotencyKey: seed.code, amount: 90_000n }));
        expect(res.status).toBe(PAYOUT_STATUS.PROCESSING);
        expect(res.providerRef).toBe('TX-1');
        expect(f.auditActions()).toEqual([PAYOUT_AUDIT.RETRIED, PAYOUT_AUDIT.SENT]);
        expect(f.audit.write.mock.calls[0][2]).toMatchObject({ before: { status: 'processing' }, after: { status: 'processing' } });
      });

      it('gửi lại xong kỳ không còn "treo" (updatedAt mới) ⇒ bấm chạy lại lần nữa bị từ chối, không chi lần hai', async () => {
        const f = buildFixture({ payoutConfigured: true });
        failed(f, { status: PAYOUT_STATUS.PROCESSING, failReason: null, updatedAt: minutesAgo(30) });
        await f.service.retry('p-1', actor);

        const err = await catchBusiness(f.service.retry('p-1', actor));

        expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
        expect(f.payos.payout).toHaveBeenCalledTimes(1);
      });

      it('processing treo mà PayOS từ chối lần gửi lại ⇒ failed + failReason (rồi xử lý như kỳ failed)', async () => {
        const f = buildFixture({ payoutConfigured: true });
        failed(f, { status: PAYOUT_STATUS.PROCESSING, failReason: null, updatedAt: minutesAgo(15) });
        f.payos.payout.mockResolvedValueOnce({ ok: false, code: '99', message: 'timeout', raw: null });

        const res = await f.service.retry('p-1', actor);

        expect(res.status).toBe(PAYOUT_STATUS.FAILED);
        expect(res.failReason).toBe('99: timeout');
      });

      it.each([0, 5, 9])('processing MỚI (%i phút) ⇒ INVALID_STATE, không gọi payos, không đổi gì', async (minutes) => {
        const f = buildFixture({ payoutConfigured: true });
        const seed = failed(f, { status: PAYOUT_STATUS.PROCESSING, failReason: null, updatedAt: minutesAgo(minutes) });

        const err = await catchBusiness(f.service.retry('p-1', actor));

        expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
        expect(f.payos.payout).not.toHaveBeenCalled();
        expect(seed.version).toBe(0);
        expect(f.audit.write).not.toHaveBeenCalled();
      });

      it('processing treo nhưng PayOS CHƯA cấu hình ⇒ vẫn INVALID_STATE (dùng đánh dấu đã trả tay)', async () => {
        const f = buildFixture({ payoutConfigured: false });
        failed(f, { status: PAYOUT_STATUS.PROCESSING, failReason: null, updatedAt: minutesAgo(60) });
        const err = await catchBusiness(f.service.retry('p-1', actor));
        expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
        expect(f.payos.payout).not.toHaveBeenCalled();
      });

      it('processing treo nhưng net ≤ 0 ⇒ INVALID_STATE (không có khoản cần chi)', async () => {
        const f = buildFixture({ payoutConfigured: true });
        failed(f, { status: PAYOUT_STATUS.PROCESSING, failReason: null, updatedAt: minutesAgo(60), net: 0 });
        const err = await catchBusiness(f.service.retry('p-1', actor));
        expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
        expect(f.payos.payout).not.toHaveBeenCalled();
      });

      it('processing treo + đánh dấu đã trả (markPaid) vẫn dùng được như trước', async () => {
        const f = buildFixture({ payoutConfigured: true });
        failed(f, { status: PAYOUT_STATUS.PROCESSING, failReason: null, updatedAt: minutesAgo(60) });
        const res = await f.service.markPaid('p-1', { providerRef: 'CK-TAY' }, actor);
        expect(res.status).toBe(PAYOUT_STATUS.PAID);
      });

      /*
       * Từng là nghi vấn race: updateMany của retry chỉ so `status` (processing → processing) nên không phân biệt được hai lần gửi lại đồng thời (cả hai
       * "giành" được kỳ ⇒ payos.payout gọi 2 lần). Đã sửa: điều kiện where kèm `version` đã đọc ⇒ chỉ một người giành được, kể cả kỳ processing treo.
       */
      it('hai lần "chạy lại" ĐỒNG THỜI trên kỳ processing treo ⇒ chỉ một lệnh chi PayOS (compare-and-set theo version)', async () => {
        const f = buildFixture({ payoutConfigured: true });
        failed(f, { status: PAYOUT_STATUS.PROCESSING, failReason: null, updatedAt: minutesAgo(30) });

        const results = await Promise.allSettled([f.service.retry('p-1', actor), f.service.retry('p-1', actor)]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as BusinessException).httpStatus).toBe(409);
        expect(f.payos.payout).toHaveBeenCalledTimes(1);
        expect(f.db.shopPayout.updateMany).toHaveBeenCalledWith(contains({ where: { id: 'p-1', status: 'processing', version: 0 } }));
      });
    });

    it('không tồn tại ⇒ NotFoundException', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const err = await catchBusiness(f.service.retry('khong-co', actor));
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.errorCode).toBe(PAYOUT_ERR.NOT_FOUND);
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

    /* Từng là bug: CHECK chỉ cho pending|processing|paid|failed trong khi service ghi carried (net < 0) và settled (net = 0) ⇒ INSERT bị Postgres từ chối. */
    it('CHECK chk_shop_payouts_status (bản MỚI NHẤT qua các migration) chứa đủ mọi PAYOUT_STATUS service có thể ghi, gồm carried và settled', () => {
      const allowed = latestCheckValues('chk_shop_payouts_status');
      for (const status of Object.values(PAYOUT_STATUS)) expect(allowed).toContain(status);
      expect(allowed).toEqual(expect.arrayContaining(['carried', 'settled']));
    });

    it('tập trạng thái trong CHECK khớp ĐÚNG PAYOUT_STATUS (không thừa, không thiếu)', () => {
      expect([...latestCheckValues('chk_shop_payouts_status')].sort()).toEqual(Object.values(PAYOUT_STATUS).sort());
    });

    it('CHECK chk_shop_payout_lines_kind khớp PAYOUT_LINE_KIND (sale | refund)', () => {
      expect([...latestCheckValues('chk_shop_payout_lines_kind')].sort()).toEqual(Object.values(PAYOUT_LINE_KIND).sort());
    });

    it('mọi trạng thái net → status mà settleShop ghi (pending/processing/carried/settled) đều nằm trong CHECK', async () => {
      const allowed = latestCheckValues('chk_shop_payouts_status');
      const f = buildFixture({ payoutConfigured: true });
      f.seedPayout({ shopId: SHOP_B, start: '2025-02-01', end: '2025-02-28', net: -50_000, status: PAYOUT_STATUS.CARRIED }); // B sẽ ra carried
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: -90_000, status: PAYOUT_STATUS.CARRIED }); // A sẽ ra settled
      f.setEligible([order('DH-A', SHOP_A, 100_000), order('DH-B', SHOP_B, 10_000)]);
      await f.run();
      expectNoSwallowedError();
      const statuses = [f.payoutOf(SHOP_A).status, f.payoutOf(SHOP_B).status];
      expect(statuses).toEqual([PAYOUT_STATUS.SETTLED, PAYOUT_STATUS.CARRIED]);
      for (const st of statuses) expect(allowed).toContain(st);
    });
  });

  /* ============================================================ */
  /*
   * Sau khi shop ĐỔI tài khoản ngân hàng (BankAccount.changedAt từ nhật ký SHOP_BANK_UPDATED), tạm giữ chi trả 24 giờ để kẻ chiếm phiên không chuyển được
   * tiền kỳ gần nhất sang TK của mình: chạy kỳ không chi tự động (pending + failReason), gửi lại (khi chưa có snapshot) bị chặn.
   */
  describe('tạm giữ chi trả 24 giờ sau khi shop đổi tài khoản ngân hàng', () => {
    const HOLD_MSG = 'Tài khoản ngân hàng vừa được thay đổi — tạm giữ chi trả 24 giờ để bảo vệ gian hàng';
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const changedBank = (hours: number | null): BankRec => ({ ...BANK, changedAt: hours === null ? null : hoursAgo(hours) });

    it('run: PayOS đã cấu hình + TK vừa đổi (1 giờ) + net > 0 ⇒ pending + failReason giữ chi, KHÔNG gọi payos, vẫn lưu snapshot TK mới', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, changedBank(1));
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      const p = f.payoutOf(SHOP_A);
      expect(p.status).toBe(PAYOUT_STATUS.PENDING);
      expect(p.failReason).toBe(HOLD_MSG);
      expect(p.netPayout.toString()).toBe('90000');
      expect(p.bankSnapshot).toEqual(BANK); // snapshot chỉ gồm 3 trường, không kèm changedAt
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it.each([
      ['0 giờ (vừa đổi)', 0, true],
      ['23 giờ', 23, true],
      ['25 giờ (hết hạn giữ)', 25, false],
      ['7 ngày', 168, false],
      ['chưa từng đổi (null)', null, false],
    ])('TK đổi %s ⇒ giữ chi trả = %s', async (_label, hours, held) => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, changedBank(hours));
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      expect(f.payoutOf(SHOP_A).status).toBe(held ? PAYOUT_STATUS.PENDING : PAYOUT_STATUS.PROCESSING);
      expect(f.payos.payout).toHaveBeenCalledTimes(held ? 0 : 1);
    });

    it('giữ chi trả chỉ áp cho shop vừa đổi TK; shop khác cùng kỳ vẫn chi tự động', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, changedBank(2));
      f.setEligible([order('DH-A', SHOP_A, 100_000), order('DH-B', SHOP_B, 100_000)]);

      await f.run();

      expectNoSwallowedError();
      expect(f.payoutOf(SHOP_A).status).toBe(PAYOUT_STATUS.PENDING);
      expect(f.payoutOf(SHOP_B).status).toBe(PAYOUT_STATUS.PROCESSING);
      expect(f.payos.payout).toHaveBeenCalledTimes(1);
      expect(f.payos.payout).toHaveBeenCalledWith(contains({ toAccountNumber: '99887766' }));
    });

    it('PayOS CHƯA cấu hình + TK vừa đổi ⇒ pending kèm failReason giữ chi (kế toán thấy lý do trước khi chuyển tay)', async () => {
      const f = buildFixture({ payoutConfigured: false });
      f.banks.set(SHOP_A, changedBank(1));
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      await f.run();
      expect(f.payoutOf(SHOP_A)).toMatchObject({ status: PAYOUT_STATUS.PENDING, failReason: HOLD_MSG });
      expect(f.payos.payout).not.toHaveBeenCalled();
    });

    it('kỳ net ≤ 0 không bị ảnh hưởng bởi giữ chi trả (carried/settled, không failReason)', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, changedBank(1));
      f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: -90_000, status: PAYOUT_STATUS.CARRIED });
      f.setEligible([order('DH-1', SHOP_A, 100_000)]); // net 0
      await f.run();
      expect(f.payoutOf(SHOP_A)).toMatchObject({ status: PAYOUT_STATUS.SETTLED, failReason: null });
    });

    it('thiếu TK ngân hàng vẫn báo "chưa khai báo" (không nhầm sang lý do giữ chi)', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, null);
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      await f.run();
      expect(f.payoutOf(SHOP_A).failReason).toBe('Shop chưa khai báo tài khoản ngân hàng');
    });

    it('retry (kỳ chưa có snapshot, lấy TK hiện tại) khi TK vừa đổi ⇒ INVALID_STATE, KHÔNG gọi payos, kỳ giữ nguyên', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, changedBank(3));
      const seed = f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PENDING, id: 'p-1', bankSnapshot: null });

      const err = await catchBusiness(f.service.retry('p-1', actor));

      expect(err.errorCode).toBe(PAYOUT_ERR.INVALID_STATE);
      expect(err.message).toContain('24 giờ');
      expect(f.payos.payout).not.toHaveBeenCalled();
      expect(seed.status).toBe(PAYOUT_STATUS.PENDING);
      expect(seed.version).toBe(0);
    });

    it('retry (chưa có snapshot) sau khi hết 24 giờ ⇒ gửi được, snapshot lưu TK hiện tại', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, changedBank(25));
      const seed = f.seedPayout({ shopId: SHOP_A, start: '2025-02-01', end: '2025-02-28', net: 90_000, status: PAYOUT_STATUS.PENDING, id: 'p-1', bankSnapshot: null });

      const res = await f.service.retry('p-1', actor);

      expect(res.status).toBe(PAYOUT_STATUS.PROCESSING);
      expect(f.payos.payout).toHaveBeenCalledTimes(1);
      expect(seed.bankSnapshot).toMatchObject(BANK);
    });

    /*
     * Kỳ bị giữ ở bước chạy kỳ vẫn LƯU snapshot = TK MỚI; retry phải kiểm giữ chi trả theo TK HIỆN TẠI ngay cả khi kỳ đã có snapshot, nếu không bấm
     * "chạy lại" ngay sau khi chạy kỳ sẽ chi tiền tới TK vừa đổi (có thể của kẻ chiếm phiên) và vô hiệu 24 giờ giữ.
     */
    it('kỳ pending đã bị giữ do đổi TK thì retry trong 24 giờ KHÔNG được chi tới TK mới', async () => {
      const f = buildFixture({ payoutConfigured: true });
      f.banks.set(SHOP_A, changedBank(1));
      f.setEligible([order('DH-1', SHOP_A, 100_000)]);
      await f.run(); // bị giữ ⇒ pending, snapshot = TK mới
      expect(f.payoutOf(SHOP_A).status).toBe(PAYOUT_STATUS.PENDING);

      await Promise.allSettled([f.service.retry(f.payoutOf(SHOP_A).id, actor)]);

      expect(f.payos.payout).not.toHaveBeenCalled();
    });
  });

  /* ============================================================ */
  describe('ShopPayoutController — mapper: vendor KHÔNG thấy thông điệp lỗi PayOS, admin giữ nguyên', () => {
    const PAYOS_MSG = '231: Quỹ chi PayOS của sàn không đủ số dư';
    const GENERIC = 'Chi trả chưa thành công — sàn đang xử lý lại, liên hệ hỗ trợ nếu quá 2 ngày làm việc';
    const shopCtx: ShopContext = { shopId: SHOP_A, shopCode: 'SHOPA', shopName: 'Shop A', shopStatus: 'active', memberId: 'm-1', roleId: 'r-1', roleCode: 'owner', roleName: 'Chủ shop', permissionCodes: ['shop.payout.read'] };

    const row = (over: Partial<PayoutRow> = {}): PayoutRow => ({
      id: 'p-1',
      code: CODE_A,
      shopId: SHOP_A,
      periodStart: new Date('2025-03-01T00:00:00.000Z'),
      periodEnd: new Date('2025-03-31T00:00:00.000Z'),
      grossRevenue: D(1_000_000),
      commission: D(100_000),
      refundAmount: D(20_000),
      carriedDebt: D(5_000),
      netPayout: D(875_000),
      status: 'failed',
      providerRef: null,
      failReason: PAYOS_MSG,
      bankSnapshot: BANK,
      paidAt: null,
      createdBy: null,
      version: 3,
      createdAt: new Date('2025-04-01T01:00:00.000Z'),
      updatedAt: new Date('2025-04-01T01:00:00.000Z'),
      ...over,
    });
    const build = () => {
      const svc = { list: jest.fn(), getDetail: jest.fn(), run: jest.fn(), retry: jest.fn(), markPaid: jest.fn(), payosBalance: jest.fn(), shopNames: jest.fn().mockResolvedValue(new Map<string, string>()) };
      return { svc, ctrl: new ShopPayoutController(svc as unknown as ShopPayoutService) };
    };
    const query = (over: Record<string, unknown> = {}) => Object.assign(new PayoutListQuery(), over);

    it('vendor — danh sách: kỳ failed ⇒ failReason được THAY bằng lời nhắn chung, không lộ mã/thông điệp PayOS', async () => {
      const { svc, ctrl } = build();
      svc.list.mockResolvedValue({ items: [row()], total: 1 });

      const res = await ctrl.listMine(query(), shopCtx);

      const dto = res.data!.content[0];
      expect(dto.failReason).toBe(GENERIC);
      expect(JSON.stringify(res)).not.toContain('PayOS');
      expect(JSON.stringify(res)).not.toContain('231');
    });

    it('vendor — chi tiết: failed ⇒ lời nhắn chung; các số liệu khác vẫn đúng', async () => {
      const { svc, ctrl } = build();
      svc.getDetail.mockResolvedValue({ payout: row(), lines: [] });

      const res = await ctrl.detailMine('p-1', shopCtx);

      expect(res.data!.payout.failReason).toBe(GENERIC);
      expect(res.data!.payout.status).toBe('failed');
      expect(JSON.stringify(res)).not.toContain('231');
    });

    it('admin — danh sách / chi tiết / chạy lại / đánh dấu đã trả: giữ NGUYÊN failReason của PayOS', async () => {
      const { svc, ctrl } = build();
      svc.list.mockResolvedValue({ items: [row()], total: 1 });
      svc.getDetail.mockResolvedValue({ payout: row(), lines: [] });
      svc.retry.mockResolvedValue(row());
      svc.markPaid.mockResolvedValue(row({ status: 'paid', failReason: PAYOS_MSG }));

      expect((await ctrl.list(query())).data!.content[0].failReason).toBe(PAYOS_MSG);
      expect((await ctrl.detail('p-1')).data!.payout.failReason).toBe(PAYOS_MSG);
      expect((await ctrl.retry('p-1', actor)).data!.failReason).toBe(PAYOS_MSG);
      expect((await ctrl.markPaid('p-1', Object.assign(new MarkPaidRequest(), { providerRef: 'CK-1' }), actor)).data!.failReason).toBe(PAYOS_MSG);
    });

    it('vendor — failed nhưng failReason rỗng ⇒ vẫn null (không bịa lời nhắn)', async () => {
      const { svc, ctrl } = build();
      svc.list.mockResolvedValue({ items: [row({ failReason: null })], total: 1 });
      expect((await ctrl.listMine(query(), shopCtx)).data!.content[0].failReason).toBeNull();
    });

    it.each([
      ['pending', 'Shop chưa khai báo tài khoản ngân hàng'],
      ['processing', null],
      ['paid', null],
      ['carried', null],
      ['settled', null],
    ])('vendor — kỳ %s không bị thay failReason (chỉ failed mới che)', async (status, failReason) => {
      const { svc, ctrl } = build();
      svc.list.mockResolvedValue({ items: [row({ status, failReason })], total: 1 });
      expect((await ctrl.listMine(query(), shopCtx)).data!.content[0].failReason).toBe(failReason);
    });

    it('vendor CHỈ xem shop của mình: shopId lấy từ ngữ cảnh, bỏ qua `shopId` trong query; chi tiết truyền shopId để kỳ shop khác → 404', async () => {
      const { svc, ctrl } = build();
      svc.list.mockResolvedValue({ items: [], total: 0 });
      svc.getDetail.mockResolvedValue({ payout: row(), lines: [] });

      await ctrl.listMine(query({ status: 'paid', shopId: SHOP_B, page: 3, size: 10 }), shopCtx);
      await ctrl.detailMine('p-1', shopCtx);

      expect(svc.list).toHaveBeenCalledWith({ status: 'paid', shopId: SHOP_A }, 20, 10);
      expect(svc.getDetail).toHaveBeenCalledWith('p-1', SHOP_A);
    });

    it('admin lọc theo shopId/status trong query và không bị giới hạn shop', async () => {
      const { svc, ctrl } = build();
      svc.list.mockResolvedValue({ items: [], total: 0 });
      await ctrl.list(query({ status: 'failed', shopId: SHOP_B }));
      expect(svc.list).toHaveBeenCalledWith({ status: 'failed', shopId: SHOP_B }, 0, 20);
      svc.getDetail.mockResolvedValue({ payout: row(), lines: [] });
      await ctrl.detail('p-1');
      expect(svc.getDetail).toHaveBeenCalledWith('p-1');
    });

    it('tên gian hàng: sàn nhận shopName tra theo lô; vendor nhận tên shop của chính mình (không cần quyền đọc shop)', async () => {
      const { svc, ctrl } = build();
      svc.list.mockResolvedValue({ items: [row({ shopId: SHOP_A })], total: 1 });
      svc.shopNames.mockResolvedValue(new Map([[SHOP_A, 'Shop A Chính Hãng']]));

      const admin = await ctrl.list(query());
      expect(admin.data!.content[0].shopName).toBe('Shop A Chính Hãng');
      expect(svc.shopNames).toHaveBeenCalledWith([SHOP_A]);

      const mine = await ctrl.listMine(query(), shopCtx);
      expect(mine.data!.content[0].shopName).toBe('Shop A');
    });

    it('ánh xạ số liệu: tiền thành chuỗi nguyên, ngày ISO, số TK che còn 4 số cuối (không lộ số đầy đủ)', async () => {
      const { svc, ctrl } = build();
      svc.list.mockResolvedValue({ items: [row({ status: 'paid', providerRef: 'TX-9', failReason: null, paidAt: new Date('2025-04-02T03:00:00.000Z') })], total: 1 });

      const res = await ctrl.listMine(query(), shopCtx);

      expect(res.data!.content[0]).toEqual({
        id: 'p-1',
        code: CODE_A,
        shopId: SHOP_A,
        shopName: 'Shop A',
        periodStart: '2025-03-01T00:00:00.000Z',
        periodEnd: '2025-03-31T00:00:00.000Z',
        grossRevenue: '1000000',
        commission: '100000',
        refundAmount: '20000',
        carriedDebt: '5000',
        netPayout: '875000',
        status: 'paid',
        providerRef: 'TX-9',
        failReason: null,
        paidAt: '2025-04-02T03:00:00.000Z',
        createdAt: '2025-04-01T01:00:00.000Z',
        updatedAt: '2025-04-01T01:00:00.000Z',
        bankAccountMasked: '****3344',
      });
      expect(JSON.stringify(res)).not.toContain(BANK.accountNumber);
    });

    it('kỳ chưa có snapshot ngân hàng ⇒ bankAccountMasked = null; net âm giữ dấu trừ', async () => {
      const { svc, ctrl } = build();
      svc.list.mockResolvedValue({ items: [row({ status: 'carried', failReason: null, bankSnapshot: null, netPayout: D(-41_000) })], total: 1 });
      const dto = (await ctrl.listMine(query(), shopCtx)).data!.content[0];
      expect(dto.bankAccountMasked).toBeNull();
      expect(dto.netPayout).toBe('-41000');
    });

    it('chi tiết: dòng đối soát được ánh xạ (gross/commission thành chuỗi)', async () => {
      const { svc, ctrl } = build();
      svc.getDetail.mockResolvedValue({
        payout: row({ status: 'paid', failReason: null }),
        lines: [
          { id: 'l-1', payoutId: 'p-1', orderCode: 'DH-1', kind: 'sale', gross: D(100_000), commission: D(10_000) },
          { id: 'l-2', payoutId: 'p-1', orderCode: R1_KEY, kind: 'refund', gross: D(25_000), commission: D(2_500) },
        ],
      });
      const res = await ctrl.detail('p-1');
      expect(res.data!.lines).toEqual([
        { id: 'l-1', orderCode: 'DH-1', kind: 'sale', gross: '100000', commission: '10000' },
        { id: 'l-2', orderCode: R1_KEY, kind: 'refund', gross: '25000', commission: '2500' },
      ]);
    });

    it('admin chạy kỳ: truyền Date cho service, trả danh sách kỳ + thông báo số kỳ đã tạo', async () => {
      const { svc, ctrl } = build();
      svc.run.mockResolvedValue([row({ status: 'pending', failReason: null })]);

      const res = await ctrl.run(Object.assign(new RunPayoutRequest(), { periodStart: '2025-03-01T00:00:00Z', periodEnd: '2025-03-31T00:00:00Z' }), actor);

      expect(svc.run).toHaveBeenCalledWith({ periodStart: new Date('2025-03-01T00:00:00Z'), periodEnd: new Date('2025-03-31T00:00:00Z') }, actor);
      expect(res.message).toBe('Đã tạo 1 kỳ đối soát');
      expect(res.data).toHaveLength(1);
    });
  });

  /* ============================================================ */
  describe('OrderQueryApi — điều kiện escrow của settlementOrders và orderTotalsOf (dữ liệu nuôi đối soát)', () => {
    const build = () => {
      const prisma = { order: { findMany: jest.fn((_args: unknown) => Promise.resolve<unknown[]>([])) } };
      const api = new OrderQueryApi(prisma as unknown as PrismaService, {} as unknown as ConstructorParameters<typeof OrderQueryApi>[1]);
      return { prisma, api };
    };
    const argOf = (m: jest.Mock<Promise<unknown[]>, [unknown]>) => m.mock.calls[0][0] as { where: Record<string, unknown>; select: Record<string, unknown> };

    it('where đủ mọi điều kiện: chưa xoá, completed, đã thanh toán (paid/partially_refunded), CẢ COD lẫn online (PLAN-0018), qua hạn đổi trả, KHÔNG có yêu cầu đổi trả đang mở', async () => {
      const { prisma, api } = build();
      prisma.order.findMany.mockResolvedValue([]);
      const periodEnd = new Date('2025-03-31T00:00:00.000Z');
      const cutoff = new Date(periodEnd.getTime() - 7 * 86_400_000);

      await api.settlementOrders(7, periodEnd);

      expect(argOf(prisma.order.findMany).where).toEqual({
        isDeleted: false,
        status: 'completed',
        paymentStatus: { in: ['paid', 'partially_refunded'] },
        OR: [{ deliveredAt: { lte: cutoff } }, { deliveredAt: null, completedAt: { lte: cutoff } }],
        // đơn đang có yêu cầu đổi trả CHƯA xử lý xong (requested/approved) thì giữ lại, không đưa vào kỳ
        returns: { none: { status: { in: ['requested', 'approved'] } } },
      });
    });

    it('select đủ trường để đối soát (total, platformDiscount, tỷ lệ hoa hồng snapshot, ngày giao/hoàn tất, shop)', async () => {
      const { prisma, api } = build();
      prisma.order.findMany.mockResolvedValue([]);
      await api.settlementOrders(7, new Date('2025-03-31T00:00:00.000Z'));
      expect(argOf(prisma.order.findMany).select).toEqual({ code: true, shopId: true, total: true, platformDiscount: true, commissionRateSnapshot: true, deliveredAt: true, completedAt: true });
    });

    it('hạn đổi trả tính theo số ngày truyền vào (0 ngày ⇒ cutoff = periodEnd)', async () => {
      const { prisma, api } = build();
      prisma.order.findMany.mockResolvedValue([]);
      const periodEnd = new Date('2025-03-31T00:00:00.000Z');
      await api.settlementOrders(0, periodEnd);
      expect((argOf(prisma.order.findMany).where.OR as Array<{ deliveredAt?: { lte: Date } }>)[0].deliveredAt?.lte).toEqual(periodEnd);
    });

    it('ánh xạ kết quả: settleFrom = ngày giao, hoặc ngày hoàn tất nếu chưa có ngày giao; giữ total + platformDiscount', async () => {
      const { prisma, api } = build();
      const delivered = new Date('2025-02-01T00:00:00.000Z');
      const completed = new Date('2025-02-03T00:00:00.000Z');
      prisma.order.findMany.mockResolvedValue([
        { code: 'DH-1', shopId: SHOP_A, total: D(90_000), platformDiscount: D(10_000), commissionRateSnapshot: D('10.00'), deliveredAt: delivered, completedAt: completed },
        { code: 'DH-2', shopId: SHOP_B, total: D(50_000), platformDiscount: D(0), commissionRateSnapshot: D('5.00'), deliveredAt: null, completedAt: completed },
      ]);

      const rows = await api.settlementOrders(7, new Date('2025-03-31T00:00:00.000Z'));

      expect(rows.map((r) => [r.orderCode, r.shopId, r.total.toString(), r.platformDiscount.toString(), r.commissionRateSnapshot.toString(), r.settleFrom])).toEqual([
        ['DH-1', SHOP_A, '90000', '10000', '10', delivered],
        ['DH-2', SHOP_B, '50000', '0', '5', completed],
      ]);
    });

    it('orderTotalsOf: mảng rỗng ⇒ Map rỗng, KHÔNG truy vấn', async () => {
      const { prisma, api } = build();
      const r = await api.orderTotalsOf([]);
      expect(r.size).toBe(0);
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });

    it('orderTotalsOf: truy vấn theo danh sách mã, trả Map code → {total, platformDiscount}; mã không tồn tại thì vắng mặt', async () => {
      const { prisma, api } = build();
      prisma.order.findMany.mockResolvedValue([{ code: 'DH-1', total: D(90_000), platformDiscount: D(10_000) }]);

      const r = await api.orderTotalsOf(['DH-1', 'DH-MAT']);

      expect(argOf(prisma.order.findMany)).toEqual({ where: { code: { in: ['DH-1', 'DH-MAT'] } }, select: { code: true, total: true, platformDiscount: true } });
      expect([...r.keys()]).toEqual(['DH-1']);
      expect(r.get('DH-1')!.total.toString()).toBe('90000');
      expect(r.get('DH-1')!.platformDiscount.toString()).toBe('10000');
    });
  });
});
