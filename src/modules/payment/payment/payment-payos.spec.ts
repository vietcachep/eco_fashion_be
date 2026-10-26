import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException, HttpStatus, Logger, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ModuleRef } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuditLogRow } from '@common/audit/audit';
import { BusinessException, NotFoundException, ServiceUnavailableException } from '@common/exception/business.exception';
import { ORDER_PAYMENT_GATEWAY } from '@common/gateway/payment.gateway';
import type { PaymentInitiateInput } from '@common/gateway/payment.gateway';
import type { OutboxEventRow } from '@common/outbox/outbox';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from '@common/security/decorators';
import { RATE_LIMIT_KEY } from '@common/security/rate-limit.guard';
import type { Env } from '@config/env';
import { METHOD, PAY_STATUS, PAYMENT_AUDIT, PAYMENT_ERR, PAYMENT_EVENT, REFUND_KIND, REFUND_STATUS, TX_TYPE } from '../foundation/payment.constants';
import { PayosService } from '../payos/payos.service';
import { AdminPaymentController, PaymentController, PaymentPublicController } from './payment.controllers';
import { PaymentService } from './payment.service';
import type { ShopWalletService } from '../shop-wallet/shop-wallet.service';

/*
 * Test luồng PayOS của PaymentService (webhook · return · initiate · retry · hoàn tiền · extras) + controller.
 * Service chạy THẬT; PayosService cũng THẬT (chữ ký webhook được xác minh thật bằng HMAC) nhưng 3 hàm gọi mạng
 * (createPaymentLink / getPaymentLink / payout) bị spy; `fetch` toàn cục luôn bị chặn ⇒ không bao giờ ra mạng.
 * Prisma = DB giả trong bộ nhớ có transaction THẬT SỰ (hoàn tác khi lỗi) và khoá dòng `FOR UPDATE` (hàng đợi FIFO), mọi thao tác
 * nhường luồng ⇒ hai transaction đồng thời xen kẽ nhau: nếu service quên khoá dòng, test đồng thời sẽ cộng tiền hai lần.
 */

type Dec = Prisma.Decimal;
const D = (v: string | number | Dec): Dec => new Prisma.Decimal(v);

const CLIENT_ID = 'test-client-id';
const API_KEY = 'test-api-key';
const CHECKSUM = 'test-checksum-key';
const API_URL = 'https://api-merchant.payos.test';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const ORDER_CODE = 'FT2610030001';
const PAYOS_CODE = 1790000000123456;
const LINK_URL = 'https://pay.payos.vn/web/abc123';
const QR = '00020101021238570010A000000727';
const AMOUNT = 350_000;
const REFUND_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const REFUND_ID_2 = '9b2e5c1a-7d3f-4e8a-b6c4-1a2b3c4d5e6f';
const NOW = Date.UTC(2026, 9, 3, 10, 0, 0); // 2026-10-03T10:00:00Z
const THIRTY_MIN = 30 * 60_000;
const actor: AuthenticatedActor = { userId: 'user-acc-1', email: 'ketoan@fitly.vn', roleCode: 'accountant', permissionVersion: 1, tokenId: 'jti-1' };

/* ---------------------------------------------------------------- webhook PayOS (ký độc lập với code) ---- */

const hmac = (data: string, key = CHECKSUM): string => createHmac('sha256', key).update(data, 'utf8').digest('hex');

function webhookData(overrides: Record<string, unknown> = {}, code: number | string = PAYOS_CODE): Record<string, unknown> {
  return {
    orderCode: code,
    amount: AMOUNT,
    description: ORDER_CODE,
    accountNumber: '12345678',
    reference: 'TF261003212323',
    transactionDateTime: '2026-10-03 16:25:00',
    currency: 'VND',
    paymentLinkId: 'plink-1',
    code: '00',
    desc: 'success',
    counterAccountBankId: '970436',
    counterAccountBankName: 'Vietcombank',
    counterAccountName: 'NGUYEN VAN A',
    counterAccountNumber: '0011223344',
    virtualAccountName: '',
    virtualAccountNumber: '',
    ...overrides,
  };
}

/* Body webhook đã ký: HMAC-SHA256 trên `k=v` của data sắp theo khoá (dữ liệu test toàn chuỗi/số phẳng ⇒ chuỗi chuẩn hoá đơn giản). */
function signed(data: Record<string, unknown>, o: { code?: string; key?: string } = {}): Record<string, unknown> {
  const canonical = Object.keys(data)
    .sort()
    .map((k) => `${k}=${(data[k] ?? '') as string | number}`)
    .join('&');
  const code = o.code ?? '00';
  return { code, desc: 'success', success: code === '00', data, signature: hmac(canonical, o.key ?? CHECKSUM) };
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

/* ---------------------------------------------------------------- DB giả ---- */

interface PaymentRow {
  id: string;
  orderId: string;
  orderCode: string;
  userId: string;
  methodCode: string;
  amount: Dec;
  status: string;
  transactionCode: string | null;
  bankCode: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  transferContent: string | null;
  refundedAmount: Dec;
  gatewayResponse: unknown;
  paidAt: Date | null;
  expiresAt: Date | null;
  version: number;
  createdAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}
interface TxnRow {
  id: string;
  paymentId: string;
  type: string;
  status: string;
  amount: unknown;
  providerRef: string | null;
  rawRequest: unknown;
  rawResponse: unknown;
  createdAt: Date;
}
interface RefundRow {
  id: string;
  paymentId: string;
  orderCode: string;
  returnRequestId: string | null;
  shopId: string | null;
  amount: Dec;
  status: string;
  method: string;
  providerRef: string | null;
  reason: string | null;
  note: string | null;
  requestedBy: string | null;
  processedBy: string | null;
  processedAt: Date | null;
  kind: string;
  gatewayAttemptedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
interface TxState {
  undo: Array<() => void>;
  held: Set<string>;
  releases: Array<() => void>;
}
type Where = Record<string, unknown>;
type PaidInfo = { paymentId: string; methodCode: string; transactionCode: string | null; bankCode: string | null; paidAt: Date };

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !(v instanceof Date) && !Prisma.Decimal.isDecimal(v);
const DECIMAL_FIELDS = new Set(['amount', 'refundedAmount']);
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/* Bộ so khớp `where` kiểu Prisma — chỉ phần service dùng (bằng nhau, `in`, `not`, lọc theo quan hệ); toán tử lạ ⇒ ném để test không "đúng nhầm". */
function matchesRow(row: object, where: Where, relations: Record<string, (r: object) => object | undefined> = {}): boolean {
  const record = row as Record<string, unknown>;
  return Object.entries(where).every(([key, cond]) => {
    if (key in relations) {
      const related = relations[key](row);
      return related !== undefined && matchesRow(related, cond as Where);
    }
    const actual = record[key];
    if (isPlainObject(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === 'in') return (arg as unknown[]).includes(actual);
        if (op === 'not') return actual !== arg;
        if (op === 'lt') return actual instanceof Date && arg instanceof Date && actual.getTime() < arg.getTime();
        throw new Error(`Toán tử where chưa hỗ trợ trong DB giả: ${op}`);
      });
    }
    return actual === cond;
  });
}

function applyData(row: object, data: Record<string, unknown>): void {
  const target = row as Record<string, unknown>;
  for (const [k, v] of Object.entries(data)) {
    if (isPlainObject(v) && 'increment' in v) target[k] = (target[k] as number) + (v.increment as number);
    else if (DECIMAL_FIELDS.has(k)) target[k] = D(v as string);
    else target[k] = v;
  }
}

function must<T>(v: T | undefined | null, label: string): T {
  if (v === undefined || v === null) throw new Error(`Thiếu ${label} trong DB giả`);
  return v;
}

function buildFixture(opts: { payosConfigured?: boolean; payoutConfigured?: boolean } = {}) {
  const payosOn = opts.payosConfigured ?? true;
  const payoutOn = opts.payoutConfigured ?? true;
  const env = {
    EF_PAYOS_CLIENT_ID: payosOn ? CLIENT_ID : '',
    EF_PAYOS_API_KEY: payosOn ? API_KEY : '',
    EF_PAYOS_CHECKSUM_KEY: payosOn ? CHECKSUM : '',
    EF_PAYOS_API_URL: API_URL,
    EF_PAYOS_PAYOUT_CLIENT_ID: payoutOn ? 'payout-client' : '',
    EF_PAYOS_PAYOUT_API_KEY: payoutOn ? 'payout-key' : '',
    EF_PAYOS_PAYOUT_CHECKSUM_KEY: payoutOn ? 'payout-checksum' : '',
    EF_WEB_URL: 'https://shop.fitly.test/',
    EF_BANK_TRANSFER_BANK_CODE: '',
    EF_BANK_TRANSFER_ACCOUNT_NO: '',
    EF_BANK_TRANSFER_ACCOUNT_NAME: '',
  } as unknown as Env;

  const state = {
    payments: new Map<string, PaymentRow>(),
    txns: [] as TxnRow[],
    refunds: new Map<string, RefundRow>(),
    audits: [] as AuditLogRow[],
    outbox: [] as OutboxEventRow[],
    methods: new Map<string, { code: string; name: string; description: string | null; kind: string; isActive: boolean; sortOrder: number }>([
      ['cod', { code: 'cod', name: 'COD', description: null, kind: 'cod', isActive: true, sortOrder: 1 }],
      ['payos', { code: 'payos', name: 'PayOS', description: null, kind: 'gateway', isActive: true, sortOrder: 2 }],
    ]),
  };
  /* Chèn lỗi: lần gọi thứ n (từ lúc đặt) của một hàm DB giả ném `err` — mô phỏng DB chết đúng bước mong muốn (vd ghi sổ sau khi cổng đã chi). */
  const failPlan = new Map<string, { remaining: number; err: Error }>();
  const maybeFail = (name: string): void => {
    const plan = failPlan.get(name);
    if (!plan) return;
    plan.remaining -= 1;
    if (plan.remaining > 0) return;
    failPlan.delete(name);
    throw plan.err;
  };
  /* Nhật ký mọi lời gọi DB (để khẳng định "không chạm DB" và thứ tự khoá → đọc). */
  const calls: string[] = [];
  const queryRawCalls: Array<{ sql: string; values: unknown[] }> = [];
  let seq = 0;
  let clock = Date.UTC(2026, 9, 3, 9, 0, 0);
  const nextDate = (): Date => new Date((clock += 1000));
  let activeTx = 0;
  const onPaidDepth: number[] = [];
  const onRefundedDepth: number[] = [];
  const txOptions: Array<{ timeout?: number } | undefined> = [];

  /* Khoá dòng: hàng đợi FIFO theo id; nhả khi transaction kết thúc (commit hoặc rollback). */
  const tails = new Map<string, Promise<void>>();
  async function lock(id: string, st: TxState): Promise<void> {
    if (st.held.has(id)) return;
    const prev = tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(id, mine);
    st.held.add(id);
    st.releases.push(release);
    await prev;
  }

  /* Rào đồng bộ: n transaction cùng chờ nhau ở cửa vào rồi mới chạy ⇒ ép chúng xen kẽ thật sự (test đồng thời không phụ thuộc độ dài đường đi). */
  let gateSize = 0;
  const gateWaiters: Array<() => void> = [];
  const enterGate = async (): Promise<void> => {
    if (gateSize === 0) return;
    await new Promise<void>((resolve) => {
      gateWaiters.push(resolve);
      if (gateWaiters.length >= gateSize) for (const release of gateWaiters.splice(0)) release();
    });
  };

  const copy = <T extends object>(r: T | undefined): T | null => (r ? { ...r } : null);
  const newestFirst = <T extends { createdAt: Date }>(rows: T[], orderBy?: { createdAt: 'asc' | 'desc' }): T[] =>
    orderBy ? [...rows].sort((a, b) => (orderBy.createdAt === 'desc' ? b.createdAt.getTime() - a.createdAt.getTime() : a.createdAt.getTime() - b.createdAt.getTime())) : rows;

  const client = (st: TxState | null) => ({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<{ id: string }>> => {
      calls.push('$queryRaw');
      queryRawCalls.push({ sql: strings.join('?'), values });
      await tick();
      if (!/FOR UPDATE/i.test(strings.join('?'))) throw new Error('$queryRaw ngoài dự kiến trong DB giả');
      const id = String(values[0]);
      if (!state.payments.has(id)) return [];
      if (st) await lock(id, st);
      return [{ id }];
    },
    paymentMethod: {
      findUnique: async (args: { where: { code: string } }) => {
        calls.push('paymentMethod.findUnique');
        await tick();
        return copy(state.methods.get(args.where.code));
      },
      findMany: async (args: { where: { isActive?: boolean } }) => {
        calls.push('paymentMethod.findMany');
        await tick();
        return [...state.methods.values()].filter((m) => args.where.isActive === undefined || m.isActive === args.where.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
      },
    },
    payment: {
      findFirst: async (args: { where: Where; orderBy?: { createdAt: 'asc' | 'desc' } }) => {
        calls.push('payment.findFirst');
        await tick();
        // `refunds: { none: {...} }` (lọc theo quan hệ 1-n) — chỉ toán tử `none` được hỗ trợ.
        const { refunds, ...where } = args.where as Where & { refunds?: { none?: Where } };
        const hasRelated = (paymentId: string, cond: Where): boolean => [...state.refunds.values()].some((rf) => rf.paymentId === paymentId && matchesRow(rf, cond));
        const rows = [...state.payments.values()].filter((r) => matchesRow(r, where) && (!refunds?.none || !hasRelated(r.id, refunds.none)));
        return copy(newestFirst(rows, args.orderBy)[0]);
      },
      count: async (args: { where: Where }) => {
        calls.push('payment.count');
        await tick();
        return [...state.payments.values()].filter((r) => matchesRow(r, args.where)).length;
      },
      findUnique: async (args: { where: { id: string } }) => {
        calls.push('payment.findUnique');
        await tick();
        return copy(state.payments.get(args.where.id));
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push('payment.create');
        await tick();
        const row = {
          id: `pay-${++seq}`,
          transactionCode: null,
          bankCode: null,
          cardBrand: null,
          cardLast4: null,
          transferContent: null,
          refundedAmount: D(0),
          gatewayResponse: null,
          paidAt: null,
          expiresAt: null,
          version: 0,
          createdBy: null,
          updatedBy: null,
          ...data,
          amount: D(data.amount as string | Dec),
          createdAt: nextDate(),
        } as unknown as PaymentRow;
        state.payments.set(row.id, row);
        st?.undo.push(() => state.payments.delete(row.id));
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push('payment.update');
        maybeFail('payment.update');
        await tick();
        const row = must(state.payments.get(where.id), `payment ${where.id}`);
        const before = { ...row };
        applyData(row, data);
        st?.undo.push(() => Object.assign(row, before));
        return { ...row };
      },
    },
    paymentTransaction: {
      findFirst: async (args: { where: Where; orderBy?: { createdAt: 'asc' | 'desc' } }) => {
        calls.push('paymentTransaction.findFirst');
        await tick();
        const rows = state.txns.filter((r) => matchesRow(r, args.where, { payment: (t) => state.payments.get((t as TxnRow).paymentId) }));
        return copy(newestFirst(rows, args.orderBy)[0]);
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push('paymentTransaction.create');
        await tick();
        const row = { id: `txn-${++seq}`, amount: null, providerRef: null, rawRequest: null, rawResponse: null, ...data, createdAt: nextDate() } as unknown as TxnRow;
        state.txns.push(row);
        st?.undo.push(() => state.txns.splice(state.txns.indexOf(row), 1));
        return { ...row };
      },
    },
    paymentAuditLog: {
      create: async ({ data }: { data: AuditLogRow }) => {
        calls.push('paymentAuditLog.create');
        await tick();
        state.audits.push(data);
        st?.undo.push(() => state.audits.splice(state.audits.indexOf(data), 1));
        return data;
      },
    },
    paymentOutboxEvent: {
      create: async ({ data }: { data: OutboxEventRow }) => {
        calls.push('paymentOutboxEvent.create');
        await tick();
        state.outbox.push(data);
        st?.undo.push(() => state.outbox.splice(state.outbox.indexOf(data), 1));
        return data;
      },
    },
    refund: {
      findUnique: async (args: { where: { id: string }; include?: { payment?: boolean }; select?: Record<string, boolean> }) => {
        calls.push('refund.findUnique');
        await tick();
        const row = state.refunds.get(args.where.id);
        if (!row) return null;
        return args.include?.payment ? { ...row, payment: { ...must(state.payments.get(row.paymentId), 'payment của refund') } } : { ...row };
      },
      findUniqueOrThrow: async (args: { where: { id: string }; include?: { payment?: boolean } }) => {
        calls.push('refund.findUniqueOrThrow');
        await tick();
        const row = must(state.refunds.get(args.where.id), `refund ${args.where.id}`);
        return args.include?.payment ? { ...row, payment: { ...must(state.payments.get(row.paymentId), 'payment của refund') } } : { ...row };
      },
      findFirst: async (args: { where: Where; select?: Record<string, boolean> }) => {
        calls.push('refund.findFirst');
        await tick();
        const row = [...state.refunds.values()].find((r) => matchesRow(r, args.where));
        return row ? { ...row } : null;
      },
      findMany: async (args: { where: Where; orderBy?: { updatedAt: 'asc' | 'desc' }; take?: number; include?: { payment?: boolean } }) => {
        calls.push('refund.findMany');
        await tick();
        const rows = [...state.refunds.values()].filter((r) => matchesRow(r, args.where)).sort((a, b) => (args.orderBy?.updatedAt === 'desc' ? -1 : 1) * (a.updatedAt.getTime() - b.updatedAt.getTime()));
        return rows.slice(0, args.take ?? rows.length).map((r) => (args.include?.payment ? { ...r, payment: { ...must(state.payments.get(r.paymentId), 'payment của refund') } } : { ...r }));
      },
      /* So-sánh-rồi-đặt (compare-and-set) NGUYÊN TỬ như UPDATE … WHERE: lọc + ghi không xen await ⇒ hai lệnh đồng thời chỉ một lệnh thắng. */
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        calls.push('refund.updateMany');
        maybeFail('refund.updateMany');
        await tick();
        const rows = [...state.refunds.values()].filter((r) => matchesRow(r, where));
        for (const row of rows) {
          const before = { ...row };
          applyData(row, data);
          st?.undo.push(() => Object.assign(row, before));
        }
        return { count: rows.length };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push('refund.create');
        await tick();
        const row = { id: `refund-${++seq}`, providerRef: null, note: null, processedBy: null, processedAt: null, version: 0, returnRequestId: null, shopId: null, kind: 'order', gatewayAttemptedAt: null, updatedAt: new Date(), ...data, amount: D(data.amount as string), createdAt: nextDate() } as unknown as RefundRow;
        state.refunds.set(row.id, row);
        st?.undo.push(() => state.refunds.delete(row.id));
        return { ...row };
      },
      aggregate: async (args: { _sum: { amount: true }; where: Where }) => {
        calls.push('refund.aggregate');
        await tick();
        const rows = [...state.refunds.values()].filter((r) => matchesRow(r, args.where));
        return { _sum: { amount: rows.length ? rows.reduce((sum, r) => sum.plus(r.amount), D(0)) : null } };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push('refund.update');
        await tick();
        const row = must(state.refunds.get(where.id), `refund ${where.id}`);
        const before = { ...row };
        applyData(row, data);
        st?.undo.push(() => Object.assign(row, before));
        return { ...row };
      },
    },
  });

  type FakeTx = ReturnType<typeof client>;
  const db = {
    ...client(null),
    $transaction: async <T>(fn: (tx: FakeTx) => Promise<T>, options?: { timeout?: number }): Promise<T> => {
      calls.push('$transaction');
      txOptions.push(options);
      await enterGate();
      const st: TxState = { undo: [], held: new Set(), releases: [] };
      activeTx += 1;
      try {
        return await fn(client(st));
      } catch (err) {
        for (const undo of st.undo.reverse()) undo(); // rollback: hoàn tác theo thứ tự ngược
        throw err;
      } finally {
        activeTx -= 1;
        for (const release of st.releases) release();
      }
    },
  };

  const payos = new PayosService(env);
  const createLink = jest.spyOn(payos, 'createPaymentLink').mockResolvedValue({ checkoutUrl: LINK_URL, qrCode: QR, paymentLinkId: 'plink-1' });
  const getLink = jest.spyOn(payos, 'getPaymentLink').mockResolvedValue({});
  const cancelLink = jest.spyOn(payos, 'cancelPaymentLink').mockResolvedValue(true);
  const payout = jest.spyOn(payos, 'payout').mockResolvedValue({ ok: true, code: '00', message: 'ok', transactionId: 'TX-123', raw: { code: '00', data: { transactionId: 'TX-123' } } });

  const orders = {
    onPaid: jest.fn((_orderCode: string, _info: PaidInfo, _tx: unknown): Promise<void> => {
      onPaidDepth.push(activeTx);
      return Promise.resolve();
    }),
    onPaymentFailed: jest.fn((_orderCode: string, _reason: string, _tx: unknown): Promise<void> => Promise.resolve()),
    onRefunded: jest.fn((_orderCode: string, _amount: bigint, _refundId: string, _tx: unknown, _fullyRefunded?: boolean): Promise<void> => {
      onRefundedDepth.push(activeTx);
      return Promise.resolve();
    }),
    canRetryPayment: jest.fn((_orderCode: string): Promise<boolean> => Promise.resolve(true)),
    markReturnRefunded: jest.fn((_returnRequestId: string, _tx: unknown): Promise<void> => Promise.resolve()),
  };
  const moduleRef = { get: jest.fn((_token: unknown, _options: unknown) => orders) };
  const wallet = { codAvailability: jest.fn(), applyCodCommission: jest.fn((): Promise<void> => Promise.resolve()), applyCodRefund: jest.fn((): Promise<void> => Promise.resolve()) };
  const service = new PaymentService(db as unknown as PrismaService, payos, wallet as unknown as ShopWalletService, env, moduleRef as unknown as ModuleRef);

  /* ---- hạt giống dữ liệu ---- */
  const seedPayment = (o: Partial<PaymentRow> = {}): PaymentRow => {
    const row: PaymentRow = {
      id: `pay-${++seq}`,
      orderId: 'order-1',
      orderCode: ORDER_CODE,
      userId: USER,
      methodCode: METHOD.PAYOS,
      amount: D(AMOUNT),
      status: PAY_STATUS.PENDING,
      transactionCode: null,
      bankCode: null,
      cardBrand: null,
      cardLast4: null,
      transferContent: null,
      refundedAmount: D(0),
      gatewayResponse: null,
      paidAt: null,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      version: 0,
      createdAt: nextDate(),
      createdBy: USER,
      updatedBy: null,
      ...o,
    };
    state.payments.set(row.id, row);
    return row;
  };
  /* Giao dịch PayOS như initiate để lại: payment + create_url (providerRef = orderCode PayOS, rawRequest.checkoutUrl). */
  const seedPayos = (o: Partial<PaymentRow> = {}, code: number = PAYOS_CODE, checkoutUrl: string = LINK_URL): PaymentRow => {
    const p = seedPayment(o);
    state.txns.push({
      id: `txn-${++seq}`,
      paymentId: p.id,
      type: TX_TYPE.CREATE_URL,
      status: 'ok',
      amount: p.amount.toString(),
      providerRef: String(code),
      rawRequest: { payosOrderCode: code, checkoutUrl, paymentLinkId: 'plink-1' },
      rawResponse: null,
      createdAt: nextDate(),
    });
    return p;
  };
  const seedRefund = (payment: PaymentRow, o: Partial<RefundRow> = {}): RefundRow => {
    const row: RefundRow = {
      id: REFUND_ID,
      paymentId: payment.id,
      orderCode: payment.orderCode,
      returnRequestId: null,
      shopId: null,
      amount: D(100_000),
      status: REFUND_STATUS.REQUESTED,
      method: 'gateway',
      providerRef: null,
      reason: 'Đổi trả',
      note: null,
      requestedBy: null,
      processedBy: null,
      processedAt: null,
      kind: 'order',
      gatewayAttemptedAt: null,
      version: 0,
      createdAt: nextDate(),
      updatedAt: new Date(), // "tươi" theo đồng hồ thật — test refund treo đặt `updatedAt` lùi về quá khứ
      ...o,
    };
    state.refunds.set(row.id, row);
    return row;
  };

  return {
    env,
    state,
    calls,
    queryRawCalls,
    db,
    payos,
    createLink,
    getLink,
    cancelLink,
    payout,
    orders,
    txOptions,
    moduleRef,
    service,
    onPaidDepth,
    onRefundedDepth,
    seedPayment,
    seedPayos,
    seedRefund,
    failNth: (name: string, nth: number, err: Error): void => {
      failPlan.set(name, { remaining: nth, err });
    },
    payment: (id: string): PaymentRow => must(state.payments.get(id), `payment ${id}`),
    refund: (id: string): RefundRow => must(state.refunds.get(id), `refund ${id}`),
    txnsOf: (paymentId: string, type?: string): TxnRow[] => state.txns.filter((t) => t.paymentId === paymentId && (type === undefined || t.type === type)),
    /* Chạy initiate trong transaction của DB giả (như OrderService.create): lỗi ⇒ rollback toàn bộ. */
    initiateInTx: (input: PaymentInitiateInput) => db.$transaction((tx) => service.initiate(input, tx as unknown as Tx)),
    /* Việc nền "bắn rồi quên" của service (huỷ link PayOS) cần vài nhịp để chạy xong. */
    flush: async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await tick();
    },
    /* Từ giờ, n transaction phải cùng tới cửa mới được chạy (dùng cho test đồng thời). */
    syncTransactions: (n: number): void => {
      gateSize = n;
    },
  };
}
type Fixture = ReturnType<typeof buildFixture>;

const initiateInput = (o: Partial<PaymentInitiateInput> = {}): PaymentInitiateInput => ({ orderId: 'order-1', orderCode: ORDER_CODE, shopId: 'shop-1', userId: USER, amount: BigInt(AMOUNT), methodCode: METHOD.PAYOS, clientIp: '203.0.113.9', ...o });

/* ================================================================ test ================================================================ */

describe('PaymentService — PayOS', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.fn((_url: string, _init: RequestInit): Promise<Response> => Promise.reject(new Error('fetch chưa được stub — không được gọi mạng thật')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------ phương thức

  describe('listMethods / isMethodActive', () => {
    it('PayOS đã cấu hình ⇒ có trong danh sách khách thấy; chưa cấu hình ⇒ bị ẩn dù bật trong DB', async () => {
      const on = buildFixture();
      expect((await on.service.listMethods(true)).map((m) => m.code)).toEqual(['cod', 'payos']);
      expect(await on.service.isMethodActive('payos')).toBe(true);

      const off = buildFixture({ payosConfigured: false });
      expect((await off.service.listMethods(true)).map((m) => m.code)).toEqual(['cod']);
      expect(await off.service.isMethodActive('payos')).toBe(false);
      // màn admin (onlyActive=false) vẫn thấy để bật/tắt
      expect((await off.service.listMethods(false)).map((m) => m.code)).toContain('payos');
    });

    it('PLAN-0018: chỉ còn cod + payos — vnpay/bank_transfer (dòng lịch sử, kể cả còn isActive) không bao giờ khả dụng cho đơn mới', async () => {
      const f = buildFixture();
      f.state.methods.set('vnpay', { code: 'vnpay', name: 'VNPay', description: null, kind: 'gateway', isActive: true, sortOrder: 3 });
      f.state.methods.set('bank_transfer', { code: 'bank_transfer', name: 'CK', description: null, kind: 'bank_transfer', isActive: true, sortOrder: 4 });
      expect((await f.service.listMethods(true)).map((m) => m.code)).toEqual(['cod', 'payos']);
      expect(await f.service.isMethodActive('vnpay')).toBe(false);
      expect(await f.service.isMethodActive('bank_transfer')).toBe(false);
      expect(await f.service.isMethodActive('cod')).toBe(true);
      expect(Object.values(METHOD)).toEqual(['cod', 'payos']);
      const err = await thrown(f.initiateInTx(initiateInput({ methodCode: 'vnpay' })));
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.METHOD_INACTIVE });
    });

    it('hoàn payment lịch sử qua cổng cũ (refund method gateway, payment vnpay): không gọi cổng, cần providerRef để ghi sổ tay', async () => {
      const f = buildFixture();
      const payment = f.seedPayment({ methodCode: 'vnpay', status: PAY_STATUS.PAID, paidAt: new Date(), version: 1 });
      const refund = f.seedRefund(payment, { method: 'gateway' });
      const err = await thrown(f.service.processRefund(actor, refund.id, {}));
      expect(err).toMatchObject({ errorCode: 'PAYMENT_REFUND_MANUAL_REQUIRED' });
      expect(f.payout).not.toHaveBeenCalled();
      const res = await f.service.processRefund(actor, refund.id, { providerRef: 'HT-LEGACY-1' });
      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'HT-LEGACY-1' });
      expect(f.payout).not.toHaveBeenCalled();
    });

    it('tắt trong DB ⇒ không khả dụng dù đã cấu hình khoá', async () => {
      const f = buildFixture();
      must(f.state.methods.get('payos'), 'method payos').isActive = false;
      expect(await f.service.isMethodActive('payos')).toBe(false);
      expect((await f.service.listMethods(true)).map((m) => m.code)).toEqual(['cod']);
    });
  });

  // ------------------------------------------------------------------ webhook

  describe('handlePayos (webhook)', () => {
    it('chưa cấu hình ⇒ 401, không chạm DB, không ghi nhận gì (kể cả khi chữ ký "khớp" khoá test)', async () => {
      const f = buildFixture({ payosConfigured: false });
      const p = f.seedPayos();
      f.calls.length = 0;

      const r = await f.service.handlePayos(signed(webhookData()));

      expect(r).toEqual({ statusCode: 401, body: { code: '01', message: 'PayOS not configured' } });
      expect(f.calls).toEqual([]);
      expect(f.orders.onPaid).not.toHaveBeenCalled();
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PENDING);
    });

    describe('chữ ký sai ⇒ 401, không ghi nhận', () => {
      const cases: Array<[string, () => Record<string, unknown>]> = [
        ['ký bằng khoá khác', () => signed(webhookData(), { key: 'khoa-gia-mao' })],
        ['sửa số tiền sau khi ký (ký 1.000đ, gửi 350.000đ)', () => ({ ...signed(webhookData({ amount: 1000 })), data: webhookData() })],
        ['sửa orderCode sang đơn khác sau khi ký', () => ({ ...signed(webhookData({}, 1790000000999999)), data: webhookData() })],
        ['thiếu signature', () => ({ code: '00', data: webhookData() })],
        ['signature rác', () => ({ code: '00', data: webhookData(), signature: 'invalid-signature' })],
        ['signature không phải chuỗi', () => ({ code: '00', data: webhookData(), signature: 12345 })],
        ['thiếu data', () => ({ code: '00', signature: hmac('') })],
        ['body rỗng', () => ({})],
      ];
      it.each(cases)('%s', async (_label, build) => {
        const f = buildFixture();
        const p = f.seedPayos();
        f.calls.length = 0;

        const r = await f.service.handlePayos(build());

        expect(r).toEqual({ statusCode: 401, body: { code: '97', message: 'Invalid signature' } });
        expect(f.calls).toEqual([]); // chưa tra DB khi chữ ký chưa hợp lệ
        expect(f.orders.onPaid).not.toHaveBeenCalled();
        expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING, version: 0 });
        expect(f.state.outbox).toHaveLength(0);
      });
    });

    describe('chữ ký đúng nhưng orderCode lạ ⇒ 200 (không ném), không ghi nhận', () => {
      const cases: Array<[string, number | string | undefined]> = [
        ['mẫu kiểm tra URL của PayOS (orderCode=123)', 123],
        ['orderCode chưa từng tạo', 987654321],
        ['orderCode không phải số', 'abc'],
        ['orderCode có 17 chữ số', '12345678901234567'],
        ['thiếu orderCode', undefined],
      ];
      it.each(cases)('%s', async (_label, code) => {
        const f = buildFixture();
        const p = f.seedPayos();

        const r = await f.service.handlePayos(signed(webhookData({ orderCode: code })));

        expect(r).toEqual({ statusCode: 200, body: { code: '00', message: 'Ignored: unknown order' } });
        expect(f.orders.onPaid).not.toHaveBeenCalled();
        expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING, version: 0 });
        expect(f.state.txns).toHaveLength(1); // chỉ còn dòng create_url ban đầu
      });

      it('orderCode không đúng định dạng số ⇒ không truy vấn DB (không để chuỗi lạ chạm câu lệnh)', async () => {
        const f = buildFixture();
        f.seedPayos();
        f.calls.length = 0;
        await f.service.handlePayos(signed(webhookData({ orderCode: "1; DROP TABLE payments" })));
        expect(f.calls).toEqual([]);
      });
    });

    it('orderCode trùng giao dịch thuộc phương thức KHÁC (cod) ⇒ coi như lạ, không đụng tới payment đó', async () => {
      const f = buildFixture();
      const vn = f.seedPayos({ methodCode: METHOD.COD }, 1790000000999999);
      const r = await f.service.handlePayos(signed(webhookData({}, 1790000000999999)));
      expect(r.body.message).toBe('Ignored: unknown order');
      expect(f.payment(vn.id)).toMatchObject({ status: PAY_STATUS.PENDING, version: 0 });
      expect(f.orders.onPaid).not.toHaveBeenCalled();
    });

    describe('không phải sự kiện thành công ⇒ 200, KHÔNG ghi nhận thanh toán', () => {
      const cases: Array<[string, { body: string; data: Record<string, unknown> }]> = [
        ['body.code ≠ 00', { body: '01', data: {} }],
        ['data.code ≠ 00', { body: '00', data: { code: '01' } }],
        ['cả hai ≠ 00', { body: '99', data: { code: '99' } }],
        ['data không có code', { body: '00', data: { code: undefined } }],
      ];
      it.each(cases)('%s', async (_label, c) => {
        const f = buildFixture();
        const p = f.seedPayos();

        const r = await f.service.handlePayos(signed(webhookData(c.data), { code: c.body }));

        expect(r).toEqual({ statusCode: 200, body: { code: '00', message: 'Ignored: not a success event' } });
        expect(f.orders.onPaid).not.toHaveBeenCalled();
        expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING, version: 0, paidAt: null });
        expect(f.state.outbox).toHaveLength(0);
        expect(f.state.txns).toHaveLength(1);
      });
    });

    it('thành công đúng số tiền (VND, KHÔNG nhân 100) ⇒ payment paid + onPaid ĐÚNG 1 lần trong cùng transaction + outbox PAYMENT_PAID', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      const data = webhookData();

      const r = await f.service.handlePayos(signed(data));

      expect(r).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } });
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, transactionCode: String(PAYOS_CODE), gatewayResponse: data, version: 1 });
      expect(f.payment(p.id).paidAt).toBeInstanceOf(Date);

      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.moduleRef.get).toHaveBeenCalledWith(ORDER_PAYMENT_GATEWAY, { strict: false }); // cổng ngược sang order lấy lười qua ModuleRef
      const [orderCode, info] = f.orders.onPaid.mock.calls[0];
      expect(orderCode).toBe(ORDER_CODE);
      expect(info).toEqual({ paymentId: p.id, methodCode: METHOD.PAYOS, transactionCode: String(PAYOS_CODE), bankCode: null, paidAt: f.payment(p.id).paidAt });
      expect(f.onPaidDepth).toEqual([1]); // gọi bên trong transaction

      const webhookTxns = f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK);
      expect(webhookTxns).toHaveLength(1);
      expect(webhookTxns[0]).toMatchObject({ status: 'ok', amount: '350000', providerRef: String(PAYOS_CODE), rawResponse: data });

      expect(f.state.outbox).toHaveLength(1);
      expect(f.state.outbox[0]).toMatchObject({ eventType: PAYMENT_EVENT.PAID, aggregateType: 'payment', aggregateId: p.id, payload: { orderCode: ORDER_CODE, userId: USER, amount: '350000', method: METHOD.PAYOS } });

      const paidAudit = f.state.audits.filter((a) => a.action === PAYMENT_AUDIT.PAID);
      expect(paidAudit).toHaveLength(1);
      expect(paidAudit[0]).toMatchObject({ entityId: p.id, entityCode: ORDER_CODE, afterSummary: { method: METHOD.PAYOS, payosOrderCode: String(PAYOS_CODE), source: 'webhook' } });
    });

    it('amount gửi dạng chuỗi số vẫn khớp; orderCode dạng chuỗi vẫn tìm được', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      const r = await f.service.handlePayos(signed(webhookData({ amount: '350000', orderCode: String(PAYOS_CODE) })));
      expect(r.body.message).toBe('Success');
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
    });

    it('webhook LẦN 2 cùng payload ⇒ 200 Success, onPaid/outbox/giao dịch KHÔNG tăng thêm, payment không đổi', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      const body = signed(webhookData());

      const first = await f.service.handlePayos(body);
      const afterFirst = { ...f.payment(p.id) };
      const second = await f.service.handlePayos(body);
      const third = await f.service.handlePayos(body);

      expect(first.statusCode).toBe(200);
      expect(second).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } });
      expect(third.statusCode).toBe(200);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.outbox).toHaveLength(1);
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(1);
      expect(f.state.audits.filter((a) => a.action === PAYMENT_AUDIT.PAID)).toHaveLength(1);
      expect(f.payment(p.id)).toEqual(afterFirst);
    });

    it('webhook đến khi payment đã paid từ trước (vd kế toán đối soát / return đi trước) ⇒ 200, không gọi onPaid', async () => {
      const f = buildFixture();
      const paidAt = new Date('2026-10-03T09:30:00.000Z');
      const p = f.seedPayos({ status: PAY_STATUS.PAID, paidAt, version: 3 });

      const r = await f.service.handlePayos(signed(webhookData()));

      expect(r.statusCode).toBe(200);
      expect(f.orders.onPaid).not.toHaveBeenCalled();
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, paidAt, version: 3 });
      expect(f.payment(p.id).gatewayResponse).toMatchObject({ counterAccountNumber: '0011223344' }); // bổ sung từ webhook
      expect(f.state.outbox).toHaveLength(0);
    });

    it.each([PAY_STATUS.REFUNDED, PAY_STATUS.PARTIALLY_REFUNDED])('payment đã %s ⇒ 200, không "paid" lại, không onPaid', async (status) => {
      const f = buildFixture();
      const p = f.seedPayos({ status, version: 5 });
      const r = await f.service.handlePayos(signed(webhookData()));
      expect(r.statusCode).toBe(200);
      expect(f.orders.onPaid).not.toHaveBeenCalled();
      expect(f.payment(p.id)).toMatchObject({ status, version: 5 });
    });

    describe('số tiền lệch ⇒ KHÔNG paid, ghi giao dịch mismatch + audit, vẫn trả 200', () => {
      const cases: Array<[string, number | undefined, string]> = [
        ['thiếu 1 đồng', 349_999, '349999'],
        ['dư 1 đồng', 350_001, '350001'],
        ['nhân nhầm 100', 35_000_000, '35000000'],
        ['số tiền 0', 0, '0'],
        ['không có trường amount', undefined, '0'],
      ];
      it.each(cases)('%s', async (_label, amount, received) => {
        const f = buildFixture();
        const p = f.seedPayos();

        const r = await f.service.handlePayos(signed(webhookData({ amount })));

        expect(r).toEqual({ statusCode: 200, body: { code: '00', message: 'Amount mismatch — recorded for review' } });
        expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING, paidAt: null, transactionCode: null, version: 0 });
        expect(f.orders.onPaid).not.toHaveBeenCalled();
        expect(f.state.outbox).toHaveLength(0);

        const mismatch = f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK);
        expect(mismatch).toHaveLength(1);
        expect(mismatch[0]).toMatchObject({ status: 'mismatch', amount: received, providerRef: String(PAYOS_CODE) });

        const audit = f.state.audits.filter((a) => a.action === PAYMENT_AUDIT.FAILED);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ entityId: p.id, afterSummary: { method: METHOD.PAYOS, reason: 'amount_mismatch', expected: '350000', received, source: 'webhook' } });
      });

      it('sau webhook lệch, webhook ĐÚNG số tiền vẫn được ghi nhận paid (payment còn pending)', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        await f.service.handlePayos(signed(webhookData({ amount: 349_999 })));
        const r = await f.service.handlePayos(signed(webhookData()));

        expect(r.body.message).toBe('Success');
        expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
        expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
        expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK).map((t) => t.status)).toEqual(['mismatch', 'ok']);
      });
    });

    it('lỗi trong transaction ⇒ 500 (PayOS sẽ gửi lại), toàn bộ bị hoàn tác; webhook gửi lại thành công và onPaid chỉ "thành công" 1 lần', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.orders.onPaid.mockRejectedValueOnce(new Error('DB down'));
      const body = signed(webhookData());

      const failed = await f.service.handlePayos(body);

      expect(failed).toEqual({ statusCode: 500, body: { code: '99', message: 'Internal error' } });
      expect(errorSpy).toHaveBeenCalled();
      // rollback: không có dấu vết nửa vời
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING, paidAt: null, transactionCode: null, version: 0 });
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(0);
      expect(f.state.outbox).toHaveLength(0);
      expect(f.state.audits).toHaveLength(0);

      const retried = await f.service.handlePayos(body);

      expect(retried).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } });
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(2); // lần 1 ném (đã rollback), lần 2 thành công
      expect(f.state.outbox).toHaveLength(1);
    });

    it('số tiền không đọc được (NaN) trong data đã ký ⇒ 500 chứ không âm thầm ghi nhận', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      const r = await f.service.handlePayos(signed(webhookData({ amount: 'abc' })));
      expect(r.statusCode).toBe(500);
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PENDING);
      expect(f.orders.onPaid).not.toHaveBeenCalled();
    });

    it('khoá dòng payment (SELECT … FOR UPDATE) TRƯỚC khi đọc trạng thái, trong transaction', async () => {
      const f = buildFixture();
      const p = f.seedPayos();

      await f.service.handlePayos(signed(webhookData()));

      expect(f.queryRawCalls).toHaveLength(1);
      expect(f.queryRawCalls[0].sql).toMatch(/FOR UPDATE/i);
      expect(f.queryRawCalls[0].sql).toMatch(/payment"\."payments/);
      expect(f.queryRawCalls[0].values).toEqual([p.id]);
      const tx = f.calls.indexOf('$transaction');
      const lockAt = f.calls.indexOf('$queryRaw');
      const readAt = f.calls.indexOf('payment.findUnique');
      expect(tx).toBeGreaterThanOrEqual(0);
      expect(lockAt).toBeGreaterThan(tx);
      expect(readAt).toBeGreaterThan(lockAt);
      expect(f.calls.indexOf('payment.update')).toBeGreaterThan(readAt);
    });

    it('hai webhook ĐỒNG THỜI cùng payload ⇒ chỉ cộng tiền 1 lần (nhờ khoá dòng)', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      const body = signed(webhookData());
      f.syncTransactions(3);

      const results = await Promise.all([f.service.handlePayos(body), f.service.handlePayos(body), f.service.handlePayos(body)]);

      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
      expect(f.queryRawCalls).toHaveLength(3);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.outbox).toHaveLength(1);
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(1);
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
    });

    it('webhook + trang return ĐỒNG THỜI ⇒ chỉ cộng tiền 1 lần', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT, amountRemaining: 0 });
      f.syncTransactions(2);

      const [hook, ret] = await Promise.all([f.service.handlePayos(signed(webhookData())), f.service.handlePayosReturn(String(PAYOS_CODE))]);

      expect(hook.statusCode).toBe(200);
      expect(ret).toMatchObject({ success: true, status: 'PAID' });
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.outbox).toHaveLength(1);
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(1);
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
    });
  });

  // ------------------------------------------------------------------ return (trang kết quả của FE)

  describe('handlePayosReturn', () => {
    const UNKNOWN = { success: false, orderCode: null, status: 'UNKNOWN', message: 'Không tìm thấy giao dịch' };

    it.each(['', 'abc', '12.5', '-5', '1e15', ' 123', '12345678901234567', '1; DROP TABLE payments'])('orderCode %j không hợp lệ ⇒ success=false, không hỏi PayOS, không chạm DB', async (code) => {
      const f = buildFixture();
      f.seedPayos();
      f.calls.length = 0;

      expect(await f.service.handlePayosReturn(code)).toEqual(UNKNOWN);
      expect(f.getLink).not.toHaveBeenCalled();
      expect(f.calls).toEqual([]);
    });

    it('orderCode là số nhưng không có giao dịch ⇒ success=false, không hỏi PayOS', async () => {
      const f = buildFixture();
      expect(await f.service.handlePayosReturn('987654321')).toEqual(UNKNOWN);
      expect(f.getLink).not.toHaveBeenCalled();
    });

    it('payment đã paid ⇒ success=true và KHÔNG gọi PayOS, không ghi gì thêm', async () => {
      const f = buildFixture();
      const p = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), version: 1 });

      const r = await f.service.handlePayosReturn(String(PAYOS_CODE));

      expect(r).toEqual({ success: true, orderCode: ORDER_CODE, status: 'PAID', message: 'Thanh toán thành công' });
      expect(f.getLink).not.toHaveBeenCalled();
      expect(f.orders.onPaid).not.toHaveBeenCalled();
      expect(f.payment(p.id).version).toBe(1);
    });

    it('pending + PayOS báo PAID đúng amountPaid ⇒ settle (paid, onPaid 1 lần, outbox) và success=true; gọi lại không hỏi PayOS nữa', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT, amountRemaining: 0 });

      const r = await f.service.handlePayosReturn(String(PAYOS_CODE));

      expect(r).toEqual({ success: true, orderCode: ORDER_CODE, status: 'PAID', message: 'Thanh toán thành công' });
      expect(f.getLink).toHaveBeenCalledTimes(1);
      expect(f.getLink).toHaveBeenCalledWith(String(PAYOS_CODE));
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, transactionCode: String(PAYOS_CODE), version: 1 });
      expect(f.payment(p.id).gatewayResponse).toBeNull(); // return-query không mang tài khoản đối ứng ⇒ KHÔNG ghi, để webhook đến sau bổ sung trọn bộ
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.onPaidDepth).toEqual([1]);
      expect(f.state.outbox).toHaveLength(1);
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.PAID)).toMatchObject({ afterSummary: { source: 'return' } });
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)[0]).toMatchObject({ status: 'ok', amount: '350000' });

      const again = await f.service.handlePayosReturn(String(PAYOS_CODE));
      expect(again.success).toBe(true);
      expect(f.getLink).toHaveBeenCalledTimes(1);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
    });

    it('return đi trước rồi webhook đến sau ⇒ không cộng tiền lần hai; webhook BỔ SUNG gatewayResponse (có tài khoản đối ứng) nên hoàn tiền tự động chạy được', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT });
      const data = webhookData();

      await f.service.handlePayosReturn(String(PAYOS_CODE));
      expect(f.payment(p.id).gatewayResponse).toBeNull();
      const versionAfterReturn = f.payment(p.id).version;
      const hook = await f.service.handlePayos(signed(data));

      expect(hook).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } });
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.outbox).toHaveLength(1);
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(1);
      // gatewayResponse cuối có đủ counterAccount*
      expect(f.payment(p.id).gatewayResponse).toMatchObject({ counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A', orderCode: PAYOS_CODE });
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, version: versionAfterReturn }); // bổ sung dữ liệu, không đổi trạng thái/version

      // ⇒ processRefund tự động (payout) chạy được thay vì MANUAL_REQUIRED
      const refund = f.seedRefund(f.payment(p.id));
      const res = await f.service.processRefund(actor, refund.id, {});
      expect(f.payout).toHaveBeenCalledWith(expect.objectContaining({ toBin: '970436', toAccountNumber: '0011223344', amount: 100_000n }));
      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-123' });
    });

    describe('webhook đến SAU khi payment đã paid ⇒ bổ sung gatewayResponse (merge) khi còn thiếu counterAccountNumber', () => {
      it('gatewayResponse đang có trường khác ⇒ merge, giữ trường cũ, thêm trường mới từ webhook', async () => {
        const f = buildFixture();
        const p = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), version: 2, gatewayResponse: { keep: 'cu', orderCode: 'cu' } });

        await f.service.handlePayos(signed(webhookData()));

        expect(f.payment(p.id).gatewayResponse).toMatchObject({ keep: 'cu', counterAccountNumber: '0011223344', counterAccountBankId: '970436', orderCode: PAYOS_CODE });
        expect(f.payment(p.id).version).toBe(2);
        expect(f.orders.onPaid).not.toHaveBeenCalled();
        expect(f.state.outbox).toHaveLength(0);
      });

      it('đã có counterAccountNumber ⇒ KHÔNG ghi đè', async () => {
        const f = buildFixture();
        const stored = webhookData({ counterAccountNumber: '999', counterAccountBankId: '970422' });
        const p = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), gatewayResponse: stored });

        await f.service.handlePayos(signed(webhookData()));

        expect(f.payment(p.id).gatewayResponse).toEqual(stored);
      });

      it('webhook cũng không mang counterAccountNumber ⇒ không đổi gì (không ghi thừa)', async () => {
        const f = buildFixture();
        const p = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), gatewayResponse: null });
        f.calls.length = 0;

        await f.service.handlePayos(signed(webhookData({ counterAccountNumber: '' })));

        expect(f.payment(p.id).gatewayResponse).toBeNull();
        expect(f.calls).not.toContain('payment.update');
      });

      it('payment đã refunded/partially_refunded cũng được bổ sung (đường hoàn tiền vẫn cần tài khoản)', async () => {
        for (const status of [PAY_STATUS.PARTIALLY_REFUNDED, PAY_STATUS.REFUNDED]) {
          const f = buildFixture();
          const p = f.seedPayos({ status, gatewayResponse: null });
          await f.service.handlePayos(signed(webhookData()));
          expect(f.payment(p.id).gatewayResponse).toMatchObject({ counterAccountNumber: '0011223344' });
          expect(f.payment(p.id).status).toBe(status);
        }
      });

      it('chỉ webhook mới bổ sung: trang return (nguồn không đáng tin) không ghi gatewayResponse cho payment đã paid', async () => {
        const f = buildFixture();
        const p = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), gatewayResponse: null });
        f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT });
        await f.service.handlePayosReturn(String(PAYOS_CODE));
        expect(f.payment(p.id).gatewayResponse).toBeNull();
      });

      it('webhook đầu tiên (payment còn pending) ghi gatewayResponse = data như cũ', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        const data = webhookData();
        await f.service.handlePayos(signed(data));
        expect(f.payment(p.id).gatewayResponse).toEqual(data);
      });
    });

    it.each([
      ['lệch số tiền', { status: 'PAID', amountPaid: 100_000 }, '100000'],
      ['dư tiền', { status: 'PAID', amountPaid: 350_001 }, '350001'],
      ['PayOS không trả amountPaid', { status: 'PAID' }, '0'],
    ])('PayOS báo PAID nhưng %s ⇒ success=false (MISMATCH), KHÔNG paid, ghi giao dịch mismatch', async (_label, info, received) => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue(info);

      const r = await f.service.handlePayosReturn(String(PAYOS_CODE));

      expect(r).toEqual({ success: false, orderCode: ORDER_CODE, status: 'MISMATCH', message: 'Số tiền không khớp — vui lòng liên hệ cửa hàng' });
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING, version: 0, paidAt: null });
      expect(f.orders.onPaid).not.toHaveBeenCalled();
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)[0]).toMatchObject({ status: 'mismatch', amount: received });
      expect(f.state.outbox).toHaveLength(0);
    });

    it.each([
      ['CANCELLED', { status: 'CANCELLED' }, 'CANCELLED', 'Bạn đã huỷ thanh toán'],
      ['EXPIRED', { status: 'EXPIRED' }, 'EXPIRED', 'Liên kết thanh toán đã hết hạn'],
      ['PENDING', { status: 'PENDING' }, 'PENDING', 'Chưa nhận được thanh toán'],
      ['PROCESSING', { status: 'PROCESSING' }, 'PROCESSING', 'Chưa nhận được thanh toán'],
      ['PayOS lỗi/không trả trạng thái', {}, 'PENDING', 'Chưa nhận được thanh toán'],
    ])('PayOS báo %s ⇒ success=false kèm thông báo tiếng Việt, payment giữ nguyên', async (_label, info, status, message) => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue(info);

      const r = await f.service.handlePayosReturn(String(PAYOS_CODE));

      expect(r).toEqual({ success: false, orderCode: ORDER_CODE, status, message });
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING, version: 0 });
      expect(f.orders.onPaid).not.toHaveBeenCalled();
      expect(f.state.outbox).toHaveLength(0);
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ initiate

  describe('initiate — method payos', () => {
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    it('tạo link thành công ⇒ trả paymentUrl + qrCode, payment pending 30 phút, ghi create_url với rawRequest.checkoutUrl', async () => {
      const f = buildFixture();

      const r = await f.initiateInTx(initiateInput());

      const expiresAt = new Date(NOW + THIRTY_MIN);
      expect(r).toEqual({ paymentId: expect.any(String) as string, status: 'unpaid', paymentUrl: LINK_URL, qrCode: QR, expiresAt });

      const p = f.payment(r.paymentId);
      expect(p).toMatchObject({ orderId: 'order-1', orderCode: ORDER_CODE, userId: USER, methodCode: METHOD.PAYOS, status: PAY_STATUS.PENDING, expiresAt, transferContent: null, createdBy: USER });
      expect(p.amount.toString()).toBe('350000');

      expect(f.createLink).toHaveBeenCalledTimes(1);
      const arg = f.createLink.mock.calls[0][0];
      expect(Number.isSafeInteger(arg.orderCode)).toBe(true);
      expect(arg.orderCode).toBeGreaterThanOrEqual(NOW * 1000);
      expect(arg.orderCode).toBeLessThanOrEqual(NOW * 1000 + 999);
      expect(arg).toMatchObject({ amount: 350_000n, description: ORDER_CODE, returnUrl: 'https://shop.fitly.test/checkout/payos-return', cancelUrl: 'https://shop.fitly.test/checkout/payos-return', expiresAt });

      const [txn] = f.txnsOf(p.id, TX_TYPE.CREATE_URL);
      expect(f.txnsOf(p.id)).toHaveLength(1);
      expect(txn).toMatchObject({ status: 'ok', amount: '350000', providerRef: String(arg.orderCode), rawRequest: { payosOrderCode: arg.orderCode, checkoutUrl: LINK_URL, paymentLinkId: 'plink-1' } });
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.INITIATED)).toMatchObject({ entityId: p.id, entityCode: ORDER_CODE, afterSummary: { method: METHOD.PAYOS, amount: '350000' } });
    });

    it('link vừa tạo nhận được webhook trả tiền: orderCode PayOS lưu ở create_url dẫn đúng tới payment', async () => {
      const f = buildFixture();
      const r = await f.initiateInTx(initiateInput());
      const code = f.createLink.mock.calls[0][0].orderCode;

      const hook = await f.service.handlePayos(signed(webhookData({}, code)));

      expect(hook).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } });
      expect(f.payment(r.paymentId).status).toBe(PAY_STATUS.PAID);
      expect(f.orders.onPaid).toHaveBeenCalledWith(ORDER_CODE, expect.objectContaining({ paymentId: r.paymentId, methodCode: METHOD.PAYOS }), expect.anything());
    });

    it('qua đường HTTP thật của PayosService (fetch giả): orderCode gửi PayOS == providerRef lưu DB, URL/khoá đúng', async () => {
      const f = buildFixture();
      f.createLink.mockRestore();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '00', data: { checkoutUrl: LINK_URL, qrCode: QR, paymentLinkId: 'plink-9' } }), { status: 200 }));

      const r = await f.initiateInTx(initiateInput());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API_URL}/v2/payment-requests`);
      expect(init.headers).toMatchObject({ 'x-client-id': CLIENT_ID, 'x-api-key': API_KEY });
      const sent = JSON.parse(init.body as string) as { orderCode: number; amount: number; description: string; signature: string };
      expect(sent).toMatchObject({ amount: 350000, description: ORDER_CODE });
      expect(f.txnsOf(r.paymentId, TX_TYPE.CREATE_URL)[0].providerRef).toBe(String(sent.orderCode));
      expect(sent.signature).toBe(hmac(`amount=350000&cancelUrl=https://shop.fitly.test/checkout/payos-return&description=${ORDER_CODE}&orderCode=${sent.orderCode}&returnUrl=https://shop.fitly.test/checkout/payos-return`));
    });

    it('PayOS không tạo được link (checkoutUrl null) ⇒ NÉM ServiceUnavailableException và đơn bị rollback (không còn payment/giao dịch/audit)', async () => {
      const f = buildFixture();
      f.createLink.mockResolvedValue({ checkoutUrl: null, qrCode: null, paymentLinkId: null });

      const err = await thrown(f.initiateInTx(initiateInput()));

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.PAYOS_NOT_CONFIGURED, httpStatus: HttpStatus.SERVICE_UNAVAILABLE });
      expect(f.state.payments.size).toBe(0);
      expect(f.state.txns).toHaveLength(0);
      expect(f.state.audits).toHaveLength(0);
    });

    it.each([
      ['PayOS trả mã lỗi INVALID_REQUEST_BODY', () => Promise.resolve(new Response(JSON.stringify({ code: 'INVALID_REQUEST_BODY', desc: 'bad' }), { status: 200 }))],
      ['PayOS trả mã 00 nhưng thiếu checkoutUrl', () => Promise.resolve(new Response(JSON.stringify({ code: '00', data: {} }), { status: 200 }))],
      ['timeout', () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))],
      ['lỗi mạng', () => Promise.reject(new Error('ECONNREFUSED'))],
    ])('qua HTTP thật: %s ⇒ initiate ném ServiceUnavailable, không để lại payment', async (_label, makeResponse) => {
      const f = buildFixture();
      f.createLink.mockRestore();
      fetchMock.mockImplementationOnce(() => makeResponse());

      const err = await thrown(f.initiateInTx(initiateInput()));

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(f.state.payments.size).toBe(0);
      expect(f.state.txns).toHaveLength(0);
    });

    it('PayOS chưa cấu hình ⇒ method không khả dụng: ném BusinessException, không tạo payment, không gọi PayOS/mạng', async () => {
      const f = buildFixture({ payosConfigured: false });

      const err = await thrown(f.initiateInTx(initiateInput()));

      expect(err).toBeInstanceOf(BusinessException);
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.METHOD_INACTIVE });
      expect(f.createLink).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(f.state.payments.size).toBe(0);
    });

    it('cấu hình bị mất giữa chừng (sau khi kiểm method) ⇒ createPayosLink ném ServiceUnavailable PAYOS_NOT_CONFIGURED, rollback', async () => {
      const f = buildFixture();
      jest.spyOn(f.payos, 'isConfigured', 'get').mockReturnValueOnce(true).mockReturnValue(false);

      const err = await thrown(f.initiateInTx(initiateInput()));

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.PAYOS_NOT_CONFIGURED, httpStatus: 503 });
      expect(f.createLink).not.toHaveBeenCalled();
      expect(f.state.payments.size).toBe(0);
    });

    it('method payos bị tắt trong DB ⇒ ném METHOD_INACTIVE, không gọi PayOS', async () => {
      const f = buildFixture();
      must(f.state.methods.get('payos'), 'method payos').isActive = false;
      const err = await thrown(f.initiateInTx(initiateInput()));
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.METHOD_INACTIVE });
      expect(f.createLink).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ retry

  describe('retryPayos', () => {
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    it('PayOS chưa cấu hình ⇒ ServiceUnavailable (503) trước khi đọc DB', async () => {
      const f = buildFixture({ payosConfigured: false });
      f.seedPayos();
      f.calls.length = 0;

      const err = await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE));

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.PAYOS_NOT_CONFIGURED });
      expect(f.calls).toEqual([]);
    });

    it('không có giao dịch PayOS của đơn ⇒ NOT_FOUND', async () => {
      const f = buildFixture();
      const err = await thrown(f.service.retryPayos(actor_of(USER), 'FT0000000000'));
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.NOT_FOUND, httpStatus: 404 });
      expect(f.createLink).not.toHaveBeenCalled();
    });

    it('không phải chủ đơn ⇒ NOT_FOUND, giao dịch của chủ đơn giữ nguyên', async () => {
      const f = buildFixture();
      const p = f.seedPayos();

      const err = await thrown(f.service.retryPayos(actor_of(OTHER_USER), ORDER_CODE));

      expect(err).toBeInstanceOf(NotFoundException);
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.NOT_FOUND });
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING, version: 0 });
      expect(f.state.payments.size).toBe(1);
      expect(f.createLink).not.toHaveBeenCalled();
    });

    it('đơn thanh toán bằng phương thức khác (cod) ⇒ NOT_FOUND ở nhánh PayOS', async () => {
      const f = buildFixture();
      f.seedPayment({ methodCode: METHOD.COD });
      const err = await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE));
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.NOT_FOUND });
    });

    it('giao dịch cuối đã paid ⇒ ALREADY_PAID, không tạo payment/link mới', async () => {
      const f = buildFixture();
      const p = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), version: 1 });

      const err = await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE));

      expect(err).toBeInstanceOf(BusinessException);
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.ALREADY_PAID });
      expect(f.createLink).not.toHaveBeenCalled();
      expect(f.state.payments.size).toBe(1);
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
    });

    it('giao dịch cuối pending ⇒ bị CANCELLED + tạo payment mới (cùng số tiền) + link mới với orderCode PayOS mới', async () => {
      const f = buildFixture();
      const old = f.seedPayos();
      f.createLink.mockResolvedValue({ checkoutUrl: 'https://pay.payos.vn/web/new-link', qrCode: QR, paymentLinkId: 'plink-2' });

      const r = await f.service.retryPayos(actor_of(USER), ORDER_CODE);

      expect(r).toEqual({ paymentUrl: 'https://pay.payos.vn/web/new-link' });
      expect(f.payment(old.id)).toMatchObject({ status: PAY_STATUS.CANCELLED, version: 1 });
      expect(f.state.payments.size).toBe(2);
      const fresh = [...f.state.payments.values()].find((p) => p.id !== old.id);
      expect(fresh).toMatchObject({ orderId: old.orderId, orderCode: ORDER_CODE, userId: USER, methodCode: METHOD.PAYOS, status: PAY_STATUS.PENDING, createdBy: USER, expiresAt: new Date(NOW + THIRTY_MIN) });
      expect(must(fresh, 'payment mới').amount.toString()).toBe('350000');

      const newCode = f.createLink.mock.calls[0][0].orderCode;
      expect(newCode).not.toBe(PAYOS_CODE);
      expect(f.createLink.mock.calls[0][0]).toMatchObject({ amount: 350_000n, description: ORDER_CODE });
      const [txn] = f.txnsOf(must(fresh, 'payment mới').id, TX_TYPE.CREATE_URL);
      expect(txn).toMatchObject({ providerRef: String(newCode), rawRequest: { checkoutUrl: 'https://pay.payos.vn/web/new-link', payosOrderCode: newCode } });
      // giao dịch create_url của payment cũ không bị đụng
      expect(f.txnsOf(old.id, TX_TYPE.CREATE_URL)[0].providerRef).toBe(String(PAYOS_CODE));
    });

    it.each([PAY_STATUS.CANCELLED, PAY_STATUS.EXPIRED, PAY_STATUS.FAILED])('giao dịch cuối %s ⇒ giữ nguyên (không huỷ lại), vẫn tạo payment + link mới', async (status) => {
      const f = buildFixture();
      const old = f.seedPayos({ status });

      await f.service.retryPayos(actor_of(USER), ORDER_CODE);

      expect(f.payment(old.id)).toMatchObject({ status, version: 0 });
      expect(f.state.payments.size).toBe(2);
    });

    it('nhiều lần thử: chỉ giao dịch MỚI NHẤT bị huỷ, giao dịch cũ hơn giữ nguyên', async () => {
      const f = buildFixture();
      const older = f.seedPayos({ status: PAY_STATUS.CANCELLED }, 1790000000000001);
      const newest = f.seedPayos({}, 1790000000000002);

      await f.service.retryPayos(actor_of(USER), ORDER_CODE);

      expect(f.payment(older.id)).toMatchObject({ status: PAY_STATUS.CANCELLED, version: 0 });
      expect(f.payment(newest.id)).toMatchObject({ status: PAY_STATUS.CANCELLED, version: 1 });
      expect(f.state.payments.size).toBe(3);
    });

    it('PayOS không tạo được link ⇒ ném ServiceUnavailable và hoàn tác (giao dịch cũ vẫn pending, không có payment mới)', async () => {
      const f = buildFixture();
      const old = f.seedPayos();
      f.createLink.mockResolvedValue({ checkoutUrl: null, qrCode: null, paymentLinkId: null });

      const err = await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE));

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(f.payment(old.id)).toMatchObject({ status: PAY_STATUS.PENDING, version: 0 });
      expect(f.state.payments.size).toBe(1);
      expect(f.state.txns).toHaveLength(1);
    });

    describe('chặn retry cho đơn không còn thanh toán được (order.canRetryPayment)', () => {
      it('đơn đã huỷ/đã xử lý (canRetryPayment=false) ⇒ INVALID_STATE, không tạo payment/link mới, không đụng giao dịch cũ', async () => {
        const f = buildFixture();
        const old = f.seedPayos({ status: PAY_STATUS.CANCELLED });
        f.orders.canRetryPayment.mockResolvedValue(false);

        const err = await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE));

        expect(err).toBeInstanceOf(BusinessException);
        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE, httpStatus: HttpStatus.BAD_REQUEST });
        expect(f.orders.canRetryPayment).toHaveBeenCalledTimes(1);
        expect(f.orders.canRetryPayment).toHaveBeenCalledWith(ORDER_CODE);
        expect(f.createLink).not.toHaveBeenCalled();
        expect(f.state.payments.size).toBe(1);
        expect(f.payment(old.id)).toMatchObject({ status: PAY_STATUS.CANCELLED, version: 0 });
      });

      it('payment cuối còn pending nhưng đơn đã huỷ ⇒ INVALID_STATE, payment KHÔNG bị huỷ và link cũ không bị huỷ', async () => {
        const f = buildFixture();
        const pending = f.seedPayos();
        f.orders.canRetryPayment.mockResolvedValue(false);

        await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE));
        await f.flush();

        expect(f.payment(pending.id)).toMatchObject({ status: PAY_STATUS.PENDING, version: 0 });
        expect(f.cancelLink).not.toHaveBeenCalled();
      });

      it('thứ tự kiểm tra: chưa cấu hình / không có giao dịch / đã paid được báo TRƯỚC, không hỏi order', async () => {
        const noConfig = buildFixture({ payosConfigured: false });
        await thrown(noConfig.service.retryPayos(actor_of(USER), ORDER_CODE));
        expect(noConfig.orders.canRetryPayment).not.toHaveBeenCalled();

        const missing = buildFixture();
        await thrown(missing.service.retryPayos(actor_of(USER), ORDER_CODE));
        expect(missing.orders.canRetryPayment).not.toHaveBeenCalled();

        const paid = buildFixture();
        paid.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date() });
        expect(await thrown(paid.service.retryPayos(actor_of(USER), ORDER_CODE))).toMatchObject({ errorCode: PAYMENT_ERR.ALREADY_PAID });
        expect(paid.orders.canRetryPayment).not.toHaveBeenCalled();
      });

      it('đơn còn retry được (canRetryPayment=true) ⇒ chạy bình thường và hỏi order đúng 1 lần', async () => {
        const f = buildFixture();
        f.seedPayos();
        await f.service.retryPayos(actor_of(USER), ORDER_CODE);
        expect(f.orders.canRetryPayment).toHaveBeenCalledTimes(1);
        expect(f.state.payments.size).toBe(2);
      });
    });

    it('transaction retry có timeout 20 giây (gọi PayOS tối đa 8s bên trong, mặc định 5s của Prisma sẽ làm hỏng)', async () => {
      const f = buildFixture();
      f.seedPayos();
      await f.service.retryPayos(actor_of(USER), ORDER_CODE);
      expect(f.txOptions).toEqual([{ timeout: 20_000 }]);
    });

    describe('huỷ link PayOS cũ (best-effort, sau khi transaction commit)', () => {
      it('payment cũ đang pending ⇒ huỷ link CŨ trên PayOS (orderCode PayOS của lần tạo trước), không huỷ link mới', async () => {
        const f = buildFixture();
        f.seedPayos();

        await f.service.retryPayos(actor_of(USER), ORDER_CODE);
        await f.flush();

        const newCode = f.createLink.mock.calls[0][0].orderCode;
        expect(f.cancelLink).toHaveBeenCalledTimes(1);
        expect(f.cancelLink).toHaveBeenCalledWith(String(PAYOS_CODE));
        expect(f.cancelLink).not.toHaveBeenCalledWith(String(newCode));
      });

      it.each([PAY_STATUS.CANCELLED, PAY_STATUS.EXPIRED, PAY_STATUS.FAILED])('payment cũ đã %s (không còn pending) ⇒ không huỷ link', async (status) => {
        const f = buildFixture();
        f.seedPayos({ status });
        await f.service.retryPayos(actor_of(USER), ORDER_CODE);
        await f.flush();
        expect(f.cancelLink).not.toHaveBeenCalled();
      });

      it('tạo link mới thất bại (rollback) ⇒ KHÔNG huỷ link cũ (khách vẫn dùng được link đang có)', async () => {
        const f = buildFixture();
        f.seedPayos();
        f.createLink.mockResolvedValue({ checkoutUrl: null, qrCode: null, paymentLinkId: null });

        await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE));
        await f.flush();

        expect(f.cancelLink).not.toHaveBeenCalled();
      });

      it('cancelPaymentLink lỗi ⇒ retry vẫn trả link mới, lỗi bị nuốt (chỉ log cảnh báo)', async () => {
        const f = buildFixture();
        const warn = jest.spyOn(Logger.prototype, 'warn');
        f.seedPayos();
        f.cancelLink.mockRejectedValue(new Error('PayOS down'));
        f.createLink.mockResolvedValue({ checkoutUrl: 'https://pay.payos.vn/web/after-cancel-error', qrCode: null, paymentLinkId: 'plink-5' });

        await expect(f.service.retryPayos(actor_of(USER), ORDER_CODE)).resolves.toEqual({ paymentUrl: 'https://pay.payos.vn/web/after-cancel-error' });
        await f.flush();

        expect(f.cancelLink).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalled();
      });

      it('tra cứu create_url của payment cũ lỗi (DB) ⇒ retry vẫn thành công, không huỷ link nào', async () => {
        const f = buildFixture();
        f.seedPayos();
        jest.spyOn(f.db.paymentTransaction, 'findFirst').mockRejectedValue(new Error('db down'));

        await expect(f.service.retryPayos(actor_of(USER), ORDER_CODE)).resolves.toMatchObject({ paymentUrl: LINK_URL });
        await f.flush();

        expect(f.cancelLink).not.toHaveBeenCalled();
      });
    });

    it('link mới nhận webhook ⇒ payment mới paid; webhook của link cũ không phá payment mới', async () => {
      const f = buildFixture();
      const old = f.seedPayos();
      await f.service.retryPayos(actor_of(USER), ORDER_CODE);
      const newCode = f.createLink.mock.calls[0][0].orderCode;
      const fresh = must([...f.state.payments.values()].find((p) => p.id !== old.id), 'payment mới');

      const hook = await f.service.handlePayos(signed(webhookData({}, newCode)));

      expect(hook.statusCode).toBe(200);
      expect(f.payment(fresh.id).status).toBe(PAY_STATUS.PAID);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.orders.onPaid.mock.calls[0][1].paymentId).toBe(fresh.id);
    });
  });

  describe('extrasForOrder — PayOS', () => {
    it('đơn pending chưa hết hạn ⇒ trả lại checkoutUrl đã lưu để khách mở lại link', async () => {
      const f = buildFixture();
      f.seedPayos();
      expect(await f.service.extrasForOrder(ORDER_CODE)).toEqual({ paymentUrl: LINK_URL, transactionCode: null, cardBrand: null, cardLast4: null });
    });

    it('lấy link của lần tạo GẦN NHẤT khi payment có nhiều create_url', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.state.txns.push({ id: 'txn-late', paymentId: p.id, type: TX_TYPE.CREATE_URL, status: 'ok', amount: '350000', providerRef: '1790000000000009', rawRequest: { checkoutUrl: 'https://pay.payos.vn/web/newer' }, rawResponse: null, createdAt: new Date('2099-01-01T00:00:00.000Z') });
      expect((await f.service.extrasForOrder(ORDER_CODE)).paymentUrl).toBe('https://pay.payos.vn/web/newer');
    });

    it('sau retry: trả link của payment MỚI (payment cũ đã cancelled)', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      const f = buildFixture();
      f.seedPayos();
      f.createLink.mockResolvedValue({ checkoutUrl: 'https://pay.payos.vn/web/retry-link', qrCode: null, paymentLinkId: 'plink-3' });
      await f.service.retryPayos(actor_of(USER), ORDER_CODE);
      // payment mới có expiresAt = NOW + 30 phút (quá khứ so với đồng hồ thật) ⇒ để khớp "còn hạn" ta dời hạn sang tương lai
      for (const p of f.state.payments.values()) p.expiresAt = new Date('2099-01-01T00:00:00.000Z');

      expect((await f.service.extrasForOrder(ORDER_CODE)).paymentUrl).toBe('https://pay.payos.vn/web/retry-link');
    });

    it.each([
      ['đã hết hạn', { expiresAt: new Date('2020-01-01T00:00:00.000Z') }],
      ['đã paid', { status: PAY_STATUS.PAID, transactionCode: String(PAYOS_CODE) }],
      ['đã cancelled', { status: PAY_STATUS.CANCELLED }],
    ])('đơn %s ⇒ KHÔNG trả paymentUrl', async (_label, o) => {
      const f = buildFixture();
      f.seedPayos(o);
      expect((await f.service.extrasForOrder(ORDER_CODE)).paymentUrl).toBeNull();
    });

    it('payment không có hạn (expiresAt null) vẫn pending ⇒ trả link', async () => {
      const f = buildFixture();
      f.seedPayos({ expiresAt: null });
      expect((await f.service.extrasForOrder(ORDER_CODE)).paymentUrl).toBe(LINK_URL);
    });

    it('create_url không có checkoutUrl (dữ liệu cũ) ⇒ paymentUrl null; paid ⇒ trả transactionCode', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      must(f.state.txns.find((t) => t.paymentId === p.id), 'create_url').rawRequest = null;
      expect((await f.service.extrasForOrder(ORDER_CODE)).paymentUrl).toBeNull();

      f.payment(p.id).status = PAY_STATUS.PAID;
      f.payment(p.id).transactionCode = String(PAYOS_CODE);
      expect(await f.service.extrasForOrder(ORDER_CODE)).toMatchObject({ paymentUrl: null, transactionCode: String(PAYOS_CODE) });
    });

    it('đơn không có payment ⇒ toàn null', async () => {
      const f = buildFixture();
      expect(await f.service.extrasForOrder('FT0000000000')).toEqual({ paymentUrl: null, transactionCode: null, cardBrand: null, cardLast4: null });
    });
  });

  // ------------------------------------------------------------------ yêu cầu hoàn tiền

  describe('requestRefund (dùng cho hoàn đơn đổi trả và hoàn khoản trả trùng)', () => {
    const REQ = { orderCode: ORDER_CODE, shopId: null, reason: 'Khách đổi ý', returnRequestId: null, actorUserId: 'staff-1' };
    const request = (f: Fixture, amount: bigint, o: { paymentId?: string } = {}) => f.db.$transaction((tx) => f.service.requestRefund({ ...REQ, amount, ...o }, tx as unknown as Tx));
    const paid = (o: Partial<PaymentRow> = {}): Partial<PaymentRow> => ({ status: PAY_STATUS.PAID, paidAt: new Date('2026-10-03T09:30:00.000Z'), version: 1, ...o });

    it('chưa thu tiền (payment pending) ⇒ refundId null, không tạo refund', async () => {
      const f = buildFixture();
      f.seedPayos();
      expect(await request(f, 100_000n)).toEqual({ refundId: null });
      expect(f.state.refunds.size).toBe(0);
    });

    it('khoản đã thu ⇒ tạo refund requested (PayOS ⇒ method gateway) + audit REFUND_REQUESTED', async () => {
      const f = buildFixture();
      const p = f.seedPayos(paid());

      const { refundId } = await request(f, 100_000n);

      expect(f.refund(must(refundId, 'refundId'))).toMatchObject({ paymentId: p.id, orderCode: ORDER_CODE, shopId: null, returnRequestId: null, status: REFUND_STATUS.REQUESTED, method: 'gateway', reason: 'Khách đổi ý', requestedBy: 'staff-1' });
      expect(f.refund(must(refundId, 'refundId')).amount.toString()).toBe('100000');
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_REQUESTED)).toMatchObject({ entityId: refundId, afterSummary: { amount: '100000', reason: 'Khách đổi ý' } });
    });

    it.each([
      [METHOD.COD, 'manual_transfer'],
      ['bank_transfer', 'manual_transfer'], // dữ liệu lịch sử
      ['vnpay', 'manual_transfer'], // dữ liệu lịch sử: không còn cổng ⇒ hoàn tay
      [METHOD.PAYOS, 'gateway'],
    ])('payment %s ⇒ refund method %s', async (methodCode, method) => {
      const f = buildFixture();
      f.seedPayment(paid({ methodCode }));
      const { refundId } = await request(f, 50_000n);
      expect(f.refund(must(refundId, 'refundId')).method).toBe(method);
    });

    it('hoàn đúng bằng phần còn lại thì được; vượt 1 đồng ⇒ REFUND_EXCEEDS (thông báo nêu phần còn lại), không tạo refund', async () => {
      const f = buildFixture();
      f.seedPayos(paid());

      const err = await thrown(request(f, 350_001n));

      expect(err).toBeInstanceOf(BusinessException);
      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS });
      expect((err as BusinessException).message).toContain('350.000');
      expect(f.state.refunds.size).toBe(0);
      expect((await request(f, 350_000n)).refundId).not.toBeNull();
    });

    it('hai yêu cầu liên tiếp mà TỔNG vượt ⇒ yêu cầu thứ hai REFUND_EXCEEDS (tính cả yêu cầu đang chờ); phần còn lại vẫn hoàn được', async () => {
      const f = buildFixture();
      f.seedPayos(paid());

      expect((await request(f, 200_000n)).refundId).not.toBeNull();
      const err = await thrown(request(f, 200_000n));

      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS });
      expect((err as BusinessException).message).toContain('150.000');
      expect(f.state.refunds.size).toBe(1);
      expect((await request(f, 150_000n)).refundId).not.toBeNull();
      expect(f.state.refunds.size).toBe(2);
    });

    it.each([
      [REFUND_STATUS.REQUESTED, 300_000, false],
      [REFUND_STATUS.PROCESSING, 300_000, false],
      [REFUND_STATUS.FAILED, 300_000, true], // hoàn thất bại không còn giữ chỗ
    ])('đã có refund %s %i đồng ⇒ yêu cầu thêm 100.000 được phép = %s', async (status, amount, expectOk) => {
      const f = buildFixture();
      const p = f.seedPayos(paid());
      f.seedRefund(p, { id: REFUND_ID_2, amount: D(amount), status });

      const result = await thrown(request(f, 100_000n));

      if (expectOk) expect(result).toBeUndefined();
      else expect(result).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS });
    });

    it('refund đã done được tính qua refundedAmount của payment (không tính hai lần): đã hoàn 300.000 ⇒ chỉ còn 50.000', async () => {
      const f = buildFixture();
      const p = f.seedPayos(paid({ status: PAY_STATUS.PARTIALLY_REFUNDED, refundedAmount: D(300_000) }));
      f.seedRefund(p, { id: REFUND_ID_2, amount: D(300_000), status: REFUND_STATUS.DONE });

      expect(await thrown(request(f, 50_001n))).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS });
      expect((await request(f, 50_000n)).refundId).not.toBeNull();
    });

    it('payment đã hoàn một phần (refundedAmount) ⇒ chỉ còn phần dư: 250.000 được, 250.001 thì không', async () => {
      const f = buildFixture();
      f.seedPayos(paid({ status: PAY_STATUS.PARTIALLY_REFUNDED, refundedAmount: D(100_000) }));
      expect(await thrown(request(f, 250_001n))).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS });
      expect((await request(f, 250_000n)).refundId).not.toBeNull();
    });

    it('có paymentId ⇒ hoàn đúng khoản đó (kể cả khi không phải khoản mới nhất); bỏ trống ⇒ khoản đã thu mới nhất', async () => {
      const f = buildFixture();
      const older = f.seedPayos(paid(), 1790000000000001);
      const newer = f.seedPayos(paid(), 1790000000000002);

      const byDefault = await request(f, 10_000n);
      const explicit = await request(f, 10_000n, { paymentId: older.id });

      expect(f.refund(must(byDefault.refundId, 'refundId')).paymentId).toBe(newer.id);
      expect(f.refund(must(explicit.refundId, 'refundId')).paymentId).toBe(older.id);
    });

    it('paymentId trỏ khoản CHƯA thu (pending) ⇒ refundId null dù đơn có khoản khác đã thu', async () => {
      const f = buildFixture();
      f.seedPayos(paid(), 1790000000000001);
      const pending = f.seedPayos({}, 1790000000000002);
      expect(await request(f, 10_000n, { paymentId: pending.id })).toEqual({ refundId: null });
      expect(f.state.refunds.size).toBe(0);
    });
  });

  // ------------------------------------------------------------------ thanh toán trùng / đến muộn

  describe('thanh toán TRÙNG (đơn đã có khoản khác thu xong — khách trả cả link cũ lẫn link mới)', () => {
    const OLD_CODE = 1790000000000001;
    const NEW_CODE = PAYOS_CODE;

    /* `first` = khoản đã thu từ trước; `second` = khoản pending đang chờ webhook. */
    function setupDuplicate(firstStatus: string = PAY_STATUS.PAID) {
      const f = buildFixture();
      const refunded = firstStatus === PAY_STATUS.REFUNDED ? D(AMOUNT) : firstStatus === PAY_STATUS.PARTIALLY_REFUNDED ? D(50_000) : D(0);
      const first = f.seedPayos({ status: firstStatus, paidAt: new Date('2026-10-03T09:00:00.000Z'), transactionCode: String(OLD_CODE), refundedAmount: refunded, version: 1 }, OLD_CODE);
      const second = f.seedPayos({}, NEW_CODE);
      return { f, first, second };
    }

    it.each([PAY_STATUS.PAID, PAY_STATUS.PARTIALLY_REFUNDED, PAY_STATUS.REFUNDED])('PayOS webhook cho khoản thứ hai khi khoản đầu %s ⇒ ghi nhận paid RỒI tạo yêu cầu hoàn; KHÔNG onPaid, KHÔNG outbox PAID', async (firstStatus) => {
      const { f, first, second } = setupDuplicate(firstStatus);
      const data = webhookData();

      const r = await f.service.handlePayos(signed(data));

      expect(r).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } });
      expect(f.payment(second.id)).toMatchObject({ status: PAY_STATUS.PAID, transactionCode: String(NEW_CODE), gatewayResponse: data, version: 1 });
      expect(f.txnsOf(second.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(1);
      expect(f.state.audits.filter((a) => a.action === PAYMENT_AUDIT.PAID)).toHaveLength(1);

      expect(f.state.refunds.size).toBe(1);
      const [refund] = [...f.state.refunds.values()];
      expect(refund).toMatchObject({ paymentId: second.id, orderCode: ORDER_CODE, shopId: null, returnRequestId: null, status: REFUND_STATUS.REQUESTED, method: 'gateway', requestedBy: null });
      expect(refund.amount.toString()).toBe('350000');
      expect(refund.reason).toContain('Thanh toán trùng');
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_REQUESTED)).toMatchObject({ entityId: refund.id, afterSummary: { amount: '350000' } });

      expect(f.orders.onPaid).not.toHaveBeenCalled();
      expect(f.state.outbox.filter((e) => e.eventType === PAYMENT_EVENT.PAID)).toHaveLength(0);
      expect(f.payment(first.id)).toMatchObject({ status: firstStatus, version: 1 }); // khoản đầu không bị đụng
    });

    it('webhook trùng lặp lần 2 cho khoản thứ hai ⇒ không tạo thêm yêu cầu hoàn', async () => {
      const { f } = setupDuplicate();
      const body = signed(webhookData());
      await f.service.handlePayos(body);
      await f.service.handlePayos(body);
      expect(f.state.refunds.size).toBe(1);
      expect(f.orders.onPaid).not.toHaveBeenCalled();
    });

    it('yêu cầu hoàn trùng xử lý được qua processRefund: payout đúng số tiền khoản thừa, khoản thứ hai ⇒ refunded', async () => {
      const { f, second } = setupDuplicate();
      await f.service.handlePayos(signed(webhookData()));
      const [refund] = [...f.state.refunds.values()];

      const res = await f.service.processRefund(actor, refund.id, {});

      expect(res.status).toBe(REFUND_STATUS.DONE);
      expect(f.payout).toHaveBeenCalledWith(expect.objectContaining({ amount: 350_000n, toBin: '970436', toAccountNumber: '0011223344', idempotencyKey: refund.id }));
      expect(f.payment(second.id)).toMatchObject({ status: PAY_STATUS.REFUNDED });
    });

    it.each([PAY_STATUS.CANCELLED, PAY_STATUS.FAILED, PAY_STATUS.EXPIRED, PAY_STATUS.PENDING])('khoản kia ở trạng thái %s (chưa thu) ⇒ không coi là trùng, vẫn onPaid bình thường', async (status) => {
      const { f, second } = setupDuplicate(status);

      await f.service.handlePayos(signed(webhookData()));

      expect(f.payment(second.id).status).toBe(PAY_STATUS.PAID);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.refunds.size).toBe(0);
      expect(f.state.outbox.filter((e) => e.eventType === PAYMENT_EVENT.PAID)).toHaveLength(1);
    });

    it('khoản đã thu của đơn KHÁC không ảnh hưởng', async () => {
      const f = buildFixture();
      f.seedPayos({ orderCode: 'FT9999999999', status: PAY_STATUS.PAID, paidAt: new Date() }, OLD_CODE);
      f.seedPayos({}, NEW_CODE);
      await f.service.handlePayos(signed(webhookData()));
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.refunds.size).toBe(0);
    });

    it('khoản trả muộn trên link cũ (payment cũ đã cancelled) khi chưa có khoản nào khác thu ⇒ vẫn ghi nhận paid + onPaid (không bỏ mất tiền thật)', async () => {
      const f = buildFixture();
      const cancelled = f.seedPayos({ status: PAY_STATUS.CANCELLED });
      f.seedPayos({}, 1790000000000002); // link mới còn pending

      await f.service.handlePayos(signed(webhookData()));

      expect(f.payment(cancelled.id).status).toBe(PAY_STATUS.PAID);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.refunds.size).toBe(0);
    });

    it('trả cả link cũ lẫn link mới sau retry: khoản đầu ghi nhận bình thường, khoản thứ hai bị hoàn; order chỉ onPaid 1 lần, outbox PAID 1 lần', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      const f = buildFixture();
      f.seedPayos();
      await f.service.retryPayos(actor_of(USER), ORDER_CODE);
      const newCode = f.createLink.mock.calls[0][0].orderCode;

      await f.service.handlePayos(signed(webhookData())); // khách trả ở link CŨ
      await f.service.handlePayos(signed(webhookData({}, newCode))); // rồi trả tiếp ở link MỚI

      expect([...f.state.payments.values()].map((p) => p.status)).toEqual([PAY_STATUS.PAID, PAY_STATUS.PAID]);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.outbox.filter((e) => e.eventType === PAYMENT_EVENT.PAID)).toHaveLength(1);
      expect(f.state.refunds.size).toBe(1);
      const [refund] = [...f.state.refunds.values()];
      expect(f.payment(refund.paymentId).transactionCode).toBe(String(newCode));
    });

    it('trang return cũng đi qua đường này: PayOS báo PAID cho khoản thứ hai ⇒ paid + hoàn, success=true', async () => {
      const { f, second } = setupDuplicate();
      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT });

      const r = await f.service.handlePayosReturn(String(NEW_CODE));

      expect(r).toMatchObject({ success: true, status: 'PAID' });
      expect(f.payment(second.id).status).toBe(PAY_STATUS.PAID);
      expect(f.state.refunds.size).toBe(1);
      expect(f.orders.onPaid).not.toHaveBeenCalled();
    });

    it('số tiền lệch thì KHÔNG paid và cũng KHÔNG tạo yêu cầu hoàn (chỉ ghi mismatch)', async () => {
      const { f, second } = setupDuplicate();
      await f.service.handlePayos(signed(webhookData({ amount: 1000 })));
      expect(f.payment(second.id).status).toBe(PAY_STATUS.PENDING);
      expect(f.state.refunds.size).toBe(0);
    });
  });

  // ------------------------------------------------------------------ huỷ đơn → huỷ link PayOS

  describe('cancel() — huỷ link PayOS của payment bị huỷ', () => {
    const cancelOrder = (f: Fixture) => f.db.$transaction((tx) => f.service.cancel(ORDER_CODE, 'Khách huỷ đơn', tx as unknown as Tx));

    it.each([PAY_STATUS.PENDING, PAY_STATUS.PROCESSING])('payment PayOS %s bị cancelled ⇒ gọi cancelPaymentLink với orderCode PayOS (providerRef của create_url)', async (status) => {
      const f = buildFixture();
      const p = f.seedPayos({ status });

      await cancelOrder(f);
      await f.flush();

      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.CANCELLED, version: 1 });
      expect(f.cancelLink).toHaveBeenCalledTimes(1);
      expect(f.cancelLink).toHaveBeenCalledWith(String(PAYOS_CODE));
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.CANCELLED)).toMatchObject({ entityId: p.id, afterSummary: { reason: 'Khách huỷ đơn' } });
    });

    it('nhiều lần tạo link ⇒ huỷ link của lần tạo GẦN NHẤT', async () => {
      const f = buildFixture();
      const p = f.seedPayos({}, 1790000000000001);
      f.state.txns.push({ id: 'txn-newer', paymentId: p.id, type: TX_TYPE.CREATE_URL, status: 'ok', amount: '350000', providerRef: '1790000000000009', rawRequest: null, rawResponse: null, createdAt: new Date('2099-01-01T00:00:00.000Z') });
      await cancelOrder(f);
      await f.flush();
      expect(f.cancelLink).toHaveBeenCalledWith('1790000000000009');
    });

    it('payment không phải PayOS (cod) ⇒ không gọi cancelPaymentLink', async () => {
      const f = buildFixture();
      f.seedPayment({ methodCode: METHOD.COD });
      await cancelOrder(f);
      await f.flush();
      expect(f.cancelLink).not.toHaveBeenCalled();
    });

    it('payment PayOS đã paid (không còn chờ) ⇒ không đụng, không huỷ link', async () => {
      const f = buildFixture();
      const p = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), version: 1 });
      await cancelOrder(f);
      await f.flush();
      expect(f.cancelLink).not.toHaveBeenCalled();
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
    });

    it('cancelPaymentLink lỗi (reject) ⇒ huỷ đơn vẫn thành công, lỗi bị nuốt (chỉ log cảnh báo)', async () => {
      const f = buildFixture();
      const warn = jest.spyOn(Logger.prototype, 'warn');
      f.cancelLink.mockRejectedValue(new Error('PayOS down'));
      const p = f.seedPayos();

      await expect(cancelOrder(f)).resolves.toBeUndefined();
      await f.flush();

      expect(f.cancelLink).toHaveBeenCalledTimes(1);
      expect(f.payment(p.id).status).toBe(PAY_STATUS.CANCELLED);
      expect(warn).toHaveBeenCalled();
    });

    it('cancelPaymentLink trả false (PayOS từ chối huỷ) ⇒ không ảnh hưởng gì', async () => {
      const f = buildFixture();
      f.cancelLink.mockResolvedValue(false);
      const p = f.seedPayos();
      await cancelOrder(f);
      await f.flush();
      expect(f.payment(p.id).status).toBe(PAY_STATUS.CANCELLED);
    });
  });

  // ------------------------------------------------------------------ hoàn tiền (xử lý)

  describe('processRefund — nhánh PayOS', () => {
    const ACCOUNT = { counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A' };
    const MANUAL_REQUIRED = 'PAYMENT_REFUND_MANUAL_REQUIRED';

    /* payment PayOS đã trả 350.000 (có số TK đối ứng từ webhook) + yêu cầu hoàn 100.000 chờ xử lý. */
    function setup(o: { fixture?: Fixture; payment?: Partial<PaymentRow>; refund?: Partial<RefundRow> } = {}) {
      const f = o.fixture ?? buildFixture();
      const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date('2026-10-03T09:30:00.000Z'), transactionCode: String(PAYOS_CODE), gatewayResponse: webhookData(ACCOUNT), version: 1, ...o.payment });
      const refund = f.seedRefund(payment, o.refund);
      return { f, payment, refund };
    }
    const updateManyCalls = (f: Fixture): number => f.calls.filter((c) => c === 'refund.updateMany').length;

    describe('CHIẾM yêu cầu trước khi chạy (compare-and-set requested|failed → processing)', () => {
      it('chiếm trước khi gọi cổng: lúc payout chạy refund đã ở processing và gắn người xử lý', async () => {
        const { f, refund } = setup();
        const seen: Array<{ status: string; processedBy: string | null }> = [];
        f.payout.mockImplementationOnce(() => {
          seen.push({ status: f.refund(refund.id).status, processedBy: f.refund(refund.id).processedBy });
          return Promise.resolve({ ok: true, code: '00', message: 'ok', transactionId: 'TX-123', raw: {} });
        });

        await f.service.processRefund(actor, refund.id, {});

        expect(seen).toEqual([{ status: REFUND_STATUS.PROCESSING, processedBy: actor.userId }]);
        expect(f.calls.indexOf('refund.updateMany')).toBeLessThan(f.calls.indexOf('refund.findUniqueOrThrow'));
      });

      it('refund không tồn tại ⇒ NOT_FOUND REFUND_NOT_FOUND, không gọi cổng', async () => {
        const f = buildFixture();
        const err = await thrown(f.service.processRefund(actor, REFUND_ID, {}));
        expect(err).toBeInstanceOf(NotFoundException);
        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_NOT_FOUND, httpStatus: HttpStatus.NOT_FOUND });
        expect(f.payout).not.toHaveBeenCalled();
      });

      it('refund đã done ⇒ INVALID_STATE "Đã hoàn xong", KHÔNG gọi payout lần nữa (chống hoàn đôi tuần tự)', async () => {
        const { f, refund } = setup();
        await f.service.processRefund(actor, refund.id, {});

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect(err).toBeInstanceOf(BusinessException);
        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE, message: 'Đã hoàn xong' });
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
        expect(f.payment(refund.paymentId).refundedAmount.toString()).toBe('100000');
      });

      it('refund đang processing (người khác đang xử lý) ⇒ INVALID_STATE, không đụng gì', async () => {
        const { f, refund } = setup({ refund: { status: REFUND_STATUS.PROCESSING, processedBy: 'user-other', version: 1 } });

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE });
        expect((err as BusinessException).message).toContain(REFUND_STATUS.PROCESSING);
        expect(f.payout).not.toHaveBeenCalled();
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, processedBy: 'user-other', version: 1 });
      });

      it('HAI lệnh xử lý ĐỒNG THỜI một refund ⇒ chỉ một lệnh đi tiếp: payout, onRefunded, outbox đúng 1 lần; lệnh kia INVALID_STATE', async () => {
        const { f, refund } = setup();

        const results = await Promise.allSettled([f.service.processRefund(actor, refund.id, {}), f.service.processRefund(actor, refund.id, {})]);

        expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(rejected?.reason).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE });
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
        expect(f.state.outbox).toHaveLength(1);
        expect(f.txnsOf(refund.paymentId, TX_TYPE.REFUND)).toHaveLength(1);
        expect(f.refund(refund.id).status).toBe(REFUND_STATUS.DONE);
        expect(f.payment(refund.paymentId).refundedAmount.toString()).toBe('100000');
      });

      it('NĂM lệnh đồng thời ⇒ vẫn chỉ một lần payout', async () => {
        const { f, refund } = setup();
        const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.service.processRefund(actor, refund.id, {})));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
      });

      it('HAI refund một phần của CÙNG payment xử lý song song ⇒ refundedAmount cộng dồn đúng 150.000 (không mất cập nhật)', async () => {
        const { f, payment } = setup({ refund: { id: REFUND_ID, amount: D(100_000) } });
        f.seedRefund(payment, { id: REFUND_ID_2, amount: D(50_000) });
        f.syncTransactions(2); // ép hai transaction ghi sổ cùng tới cửa

        await Promise.all([f.service.processRefund(actor, REFUND_ID, {}), f.service.processRefund(actor, REFUND_ID_2, {})]);

        expect(f.payment(payment.id).refundedAmount.toString()).toBe('150000');
        expect(f.payment(payment.id).status).toBe(PAY_STATUS.PARTIALLY_REFUNDED);
        expect(f.refund(REFUND_ID).status).toBe(REFUND_STATUS.DONE);
        expect(f.refund(REFUND_ID_2).status).toBe(REFUND_STATUS.DONE);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(2);
        expect(f.orders.onRefunded.mock.calls.map((c) => c[4])).toEqual([false, false]);
      });

      it('hai refund song song cộng lại đúng bằng số đã thu ⇒ khoản hoàn sau cùng báo "đã hoàn đủ" (payment REFUNDED)', async () => {
        const { f, payment } = setup({ refund: { id: REFUND_ID, amount: D(100_000) } });
        f.seedRefund(payment, { id: REFUND_ID_2, amount: D(250_000) });
        f.syncTransactions(2);

        await Promise.all([f.service.processRefund(actor, REFUND_ID, {}), f.service.processRefund(actor, REFUND_ID_2, {})]);

        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.REFUNDED });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('350000');
        expect(f.orders.onRefunded.mock.calls.map((c) => c[4]).sort()).toEqual([false, true]);
      });
    });

    describe('lỗi TRƯỚC khi cổng chạy ⇒ nhả chiếm, refund giữ requested', () => {
      it.each([
        ['thiếu counterAccountNumber', { counterAccountBankId: '970436' }],
        ['thiếu counterAccountBankId', { counterAccountNumber: '0011223344' }],
        ['số tài khoản rỗng', { counterAccountBankId: '970436', counterAccountNumber: '' }],
        ['số tài khoản không phải chuỗi (số)', { counterAccountBankId: '970436', counterAccountNumber: 11223344 }],
        ['BIN không phải chuỗi (số)', { counterAccountBankId: 970436, counterAccountNumber: '0011223344' }],
        ['gatewayResponse rỗng {}', {}],
        ['gatewayResponse null', null],
      ])('%s (không có providerRef) ⇒ MANUAL_REQUIRED, không gọi payout, nhả chiếm', async (_label, gatewayResponse) => {
        const { f, payment, refund } = setup({ payment: { gatewayResponse } });

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect(err).toBeInstanceOf(BusinessException);
        expect(err).toMatchObject({ errorCode: MANUAL_REQUIRED, httpStatus: HttpStatus.BAD_REQUEST });
        expect((err as BusinessException).message).toContain('số tài khoản');
        expect(f.payout).not.toHaveBeenCalled();
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.REQUESTED, providerRef: null, version: 2 }); // +1 chiếm, +1 nhả
        expect(updateManyCalls(f)).toBe(2);
        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
        expect(f.orders.onRefunded).not.toHaveBeenCalled();
        expect(f.state.outbox).toHaveLength(0);
      });

      it('chưa cấu hình payout (có tài khoản, không providerRef) ⇒ MANUAL_REQUIRED nêu "payout chưa cấu hình" — KHÔNG còn ServiceUnavailable; nhả chiếm', async () => {
        const { f, refund } = setup({ fixture: buildFixture({ payoutConfigured: false }) });

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect(err).toBeInstanceOf(BusinessException);
        expect(err).not.toBeInstanceOf(ServiceUnavailableException);
        expect(err).toMatchObject({ errorCode: MANUAL_REQUIRED, httpStatus: HttpStatus.BAD_REQUEST });
        expect((err as BusinessException).message).toContain('payout chưa cấu hình');
        expect(f.payout).not.toHaveBeenCalled();
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.REQUESTED, version: 2 });
      });

      it('sau khi nhả chiếm, kế toán xử lý lại được (nhập providerRef) ⇒ done', async () => {
        const { f, refund } = setup({ payment: { gatewayResponse: {} } });
        await thrown(f.service.processRefund(actor, refund.id, {}));
        expect(f.refund(refund.id).status).toBe(REFUND_STATUS.REQUESTED);

        const res = await f.service.processRefund(actor, refund.id, { providerRef: 'FT26100300999' });

        expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'FT26100300999' });
      });

      it('hai lệnh liên tiếp sau khi nhả: không lệnh nào bị kẹt ở processing', async () => {
        const { f, refund } = setup({ payment: { gatewayResponse: null } });
        await thrown(f.service.processRefund(actor, refund.id, {}));
        const second = await thrown(f.service.processRefund(actor, refund.id, {}));
        expect(second).toMatchObject({ errorCode: MANUAL_REQUIRED }); // không phải INVALID_STATE ⇒ đã nhả
        expect(f.refund(refund.id).status).toBe(REFUND_STATUS.REQUESTED);
      });
    });

    describe('thiếu tài khoản / chưa cấu hình payout NHƯNG có providerRef ⇒ ghi sổ như hoàn THỦ CÔNG', () => {
      const cases: Array<[string, () => Parameters<typeof setup>[0]]> = [
        ['thiếu tài khoản đối ứng', () => ({ payment: { gatewayResponse: {} } })],
        ['gatewayResponse null', () => ({ payment: { gatewayResponse: null } })],
        ['chưa cấu hình payout (có tài khoản)', () => ({ fixture: buildFixture({ payoutConfigured: false }) })],
      ];
      it.each(cases)('%s ⇒ done, KHÔNG gọi payout, providerRef = đầu vào', async (_label, makeOptions) => {
        const { f, payment, refund } = setup(makeOptions());

        const res = await f.service.processRefund(actor, refund.id, { providerRef: 'FT26100300123', note: 'Đã chuyển tay' });

        expect(f.payout).not.toHaveBeenCalled();
        expect(res).toMatchObject({ id: REFUND_ID, status: REFUND_STATUS.DONE, providerRef: 'FT26100300123', note: 'Đã chuyển tay', method: 'gateway' });
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'FT26100300123', processedBy: actor.userId, version: 2 });
        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PARTIALLY_REFUNDED });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toEqual([expect.objectContaining({ status: 'ok', providerRef: 'FT26100300123', rawResponse: { manual: true } })]);
        expect(f.orders.onRefunded.mock.calls[0].slice(0, 3)).toEqual([ORDER_CODE, 100_000n, REFUND_ID]);
        expect(f.state.outbox).toHaveLength(1);
      });

      it('đủ điều kiện hoàn tự động (có tài khoản + cấu hình payout) thì providerRef nhập vào bị bỏ qua: vẫn gọi payout', async () => {
        const { f, refund } = setup();
        const res = await f.service.processRefund(actor, refund.id, { providerRef: 'FT-IGNORED' });
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(res.providerRef).toBe('payos-refund:TX-123');
      });
    });

    describe('payout thành công', () => {
      it('refund done, providerRef "payos-refund:<transactionId>", payment partially_refunded, onRefunded (kèm cờ hoàn đủ = false) + outbox đủ trường', async () => {
        const { f, payment, refund } = setup();

        const res = await f.service.processRefund(actor, refund.id, { note: 'Đã kiểm tra' });

        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.payout).toHaveBeenCalledWith({ referenceId: REFUND_ID, amount: 100_000n, toBin: '970436', toAccountNumber: '0011223344', description: `Hoan tien don ${ORDER_CODE}`, idempotencyKey: REFUND_ID });

        expect(res).toMatchObject({ id: REFUND_ID, orderCode: ORDER_CODE, status: REFUND_STATUS.DONE, method: 'gateway', providerRef: 'payos-refund:TX-123', note: 'Đã kiểm tra' });
        expect(res.amount.amount).toBe('100000');
        expect(res.processedAt).not.toBeNull();
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-123', processedBy: actor.userId, version: 2 });

        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PARTIALLY_REFUNDED, version: 2 });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');

        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(1);
        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)[0]).toMatchObject({ status: 'ok', providerRef: 'payos-refund:TX-123', rawResponse: { code: '00', data: { transactionId: 'TX-123' } } });

        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
        expect(f.orders.onRefunded.mock.calls[0].slice(0, 3)).toEqual([ORDER_CODE, 100_000n, REFUND_ID]);
        expect(f.orders.onRefunded.mock.calls[0][4]).toBe(false); // tham số thứ 5: payment báo CHƯA hoàn đủ
        expect(f.onRefundedDepth).toEqual([1]);
        expect(f.orders.markReturnRefunded).not.toHaveBeenCalled();
        expect(f.state.outbox).toHaveLength(1);
        expect(f.state.outbox[0]).toMatchObject({
          eventType: PAYMENT_EVENT.REFUNDED,
          aggregateType: 'refund',
          aggregateId: REFUND_ID,
          payload: { refundId: REFUND_ID, orderCode: ORDER_CODE, userId: USER, amount: '100000', methodCode: METHOD.PAYOS, shopId: null },
        });
        expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_PROCESSED)).toMatchObject({ entityId: REFUND_ID, afterSummary: { amount: '100000', method: 'gateway', providerRef: 'payos-refund:TX-123' } });
      });

      it('refund của một shop ⇒ outbox mang shopId (để ví COD đảo hoa hồng)', async () => {
        const { f, refund } = setup({ refund: { shopId: 'shop-1' } });
        await f.service.processRefund(actor, refund.id, {});
        expect(f.state.outbox[0].payload).toMatchObject({ shopId: 'shop-1', methodCode: METHOD.PAYOS });
      });

      it('PayOS không trả transactionId ⇒ providerRef dùng id của refund', async () => {
        const { f, refund } = setup();
        f.payout.mockResolvedValue({ ok: true, code: '00', message: 'ok', raw: { code: '00' } });
        const res = await f.service.processRefund(actor, refund.id, {});
        expect(res.providerRef).toBe(`payos-refund:${REFUND_ID}`);
      });

      it('hoàn toàn bộ số tiền ⇒ payment REFUNDED + cờ hoàn đủ = true; hoàn nốt phần còn lại sau lần một phần cũng ⇒ REFUNDED', async () => {
        const full = setup({ refund: { amount: D(350_000) } });
        await full.f.service.processRefund(actor, REFUND_ID, {});
        expect(full.f.payment(full.payment.id)).toMatchObject({ status: PAY_STATUS.REFUNDED });
        expect(full.f.payment(full.payment.id).refundedAmount.toString()).toBe('350000');
        expect(full.f.orders.onRefunded.mock.calls[0][4]).toBe(true);

        const rest = setup({ payment: { refundedAmount: D(100_000), status: PAY_STATUS.PARTIALLY_REFUNDED }, refund: { amount: D(250_000) } });
        await rest.f.service.processRefund(actor, REFUND_ID, {});
        expect(rest.f.payment(rest.payment.id)).toMatchObject({ status: PAY_STATUS.REFUNDED });
        expect(rest.f.payment(rest.payment.id).refundedAmount.toString()).toBe('350000');
        expect(rest.f.orders.onRefunded.mock.calls[0][4]).toBe(true);
      });

      it('refund gắn yêu cầu đổi trả ⇒ báo markReturnRefunded đúng 1 lần', async () => {
        const { f, refund } = setup({ refund: { returnRequestId: 'return-1' } });
        await f.service.processRefund(actor, refund.id, {});
        expect(f.orders.markReturnRefunded).toHaveBeenCalledTimes(1);
        expect(f.orders.markReturnRefunded.mock.calls[0][0]).toBe('return-1');
      });
    });

    describe('payout bị cổng từ chối ⇒ failed (không nhả chiếm), 502', () => {
      it.each([
        ['PayOS từ chối (231)', { ok: false, code: '231', message: 'Số dư không đủ', raw: { code: '231', message: 'Số dư không đủ' } }, 'PayOS 231: Số dư không đủ', { code: '231', message: 'Số dư không đủ' }],
        ['lỗi mạng/timeout (raw null)', { ok: false, code: '99', message: 'Không gọi được cổng PayOS', raw: null }, 'PayOS 99: Không gọi được cổng PayOS', {}],
      ])('%s ⇒ refund failed + ghi giao dịch refund failed + 502, payment không đổi', async (_label, result, note, rawResponse) => {
        const { f, payment, refund } = setup();
        f.payout.mockResolvedValue(result);

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect(err).toBeInstanceOf(BusinessException);
        expect(err).toMatchObject({ errorCode: 'PAYMENT_REFUND_FAILED', httpStatus: HttpStatus.BAD_GATEWAY });
        expect((err as BusinessException).message).toContain('PayOS');
        expect((err as BusinessException).message).toContain(result.code);
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, note, processedBy: actor.userId, version: 2 }); // +1 chiếm, +1 failed (không bị nhả về requested)
        expect(f.refund(refund.id).processedAt).toBeInstanceOf(Date);
        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(1);
        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)[0]).toMatchObject({ status: 'failed', rawResponse });
        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('0');
        expect(f.orders.onRefunded).not.toHaveBeenCalled();
        expect(f.state.outbox).toHaveLength(0);
      });

      it('refund failed xử lý lại được: payout gọi lại với CÙNG idempotencyKey/referenceId (không chi đôi), xong ⇒ done', async () => {
        const { f, refund } = setup();
        f.payout.mockResolvedValueOnce({ ok: false, code: '99', message: 'timeout', raw: null });

        await thrown(f.service.processRefund(actor, refund.id, {}));
        expect(f.refund(refund.id).status).toBe(REFUND_STATUS.FAILED);
        const res = await f.service.processRefund(actor, refund.id, {});

        expect(res.status).toBe(REFUND_STATUS.DONE);
        expect(f.payout).toHaveBeenCalledTimes(2);
        const [first, second] = f.payout.mock.calls.map(([input]) => input);
        expect(first.idempotencyKey).toBe(REFUND_ID);
        expect(second.idempotencyKey).toBe(first.idempotencyKey);
        expect(second.referenceId).toBe(first.referenceId);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
        expect(f.refund(refund.id).version).toBe(4); // chiếm, failed, chiếm lại, done
      });
    });

    describe('ghi sổ cuối (khoá payment, tính từ giá trị mới nhất)', () => {
      it('khoá dòng payment (SELECT … FOR UPDATE) trong transaction TRƯỚC khi đọc payment để cộng dồn', async () => {
        const { f, refund } = setup();

        await f.service.processRefund(actor, refund.id, {});

        const locks = f.queryRawCalls.filter((c) => /FOR UPDATE/i.test(c.sql));
        expect(locks).toHaveLength(1);
        expect(locks[0].values).toEqual([refund.paymentId]);
        const tx = f.calls.indexOf('$transaction');
        const lockAt = f.calls.indexOf('$queryRaw');
        expect(tx).toBeGreaterThan(f.calls.indexOf('refund.findUniqueOrThrow'));
        expect(lockAt).toBeGreaterThan(tx);
        expect(f.calls.indexOf('payment.findUnique', lockAt)).toBeGreaterThan(lockAt);
      });

      it('tổng hoàn vượt số đã thu (có yêu cầu hoàn khác đã xong) ⇒ BusinessException REFUND_EXCEEDS, không ghi sổ, không onRefunded', async () => {
        const { f, payment, refund } = setup({ payment: { gatewayResponse: null, status: PAY_STATUS.PARTIALLY_REFUNDED, refundedAmount: D(300_000) }, refund: { amount: D(100_000) } });

        const err = await thrown(f.service.processRefund(actor, refund.id, { providerRef: 'FT26100300777' }));

        expect(err).toBeInstanceOf(BusinessException);
        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS });
        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PARTIALLY_REFUNDED, version: 1 });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('300000');
        expect(f.refund(refund.id).status).not.toBe(REFUND_STATUS.DONE);
        expect(f.orders.onRefunded).not.toHaveBeenCalled();
        expect(f.payout).not.toHaveBeenCalled();
        expect(f.state.outbox).toHaveLength(0);
        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(0);
      });

      it('lỗi khi ghi sổ sau payout thành công ⇒ transaction ghi sổ hoàn tác (payment/sổ/outbox không đổi) nhưng refund GIỮ processing + providerRef để chỉ ghi sổ lại (không chi đôi)', async () => {
        const { f, payment, refund } = setup();
        f.orders.onRefunded.mockRejectedValueOnce(new Error('order down'));

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect((err as Error).message).toBe('order down');
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: 'payos-refund:TX-123' }); // cổng đã chi: dấu vết còn, KHÔNG về requested
        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('0');
        expect(f.state.outbox).toHaveLength(0);
        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(0);
        expect(f.payout).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ------------------------------------------------------------------ hoàn khoản thanh toán TRÙNG: KHÔNG đổi trạng thái đơn

  describe('hoàn khoản thanh toán TRÙNG — đơn vẫn paid, không đảo hoa hồng / doanh thu', () => {
    const OLD_CODE = 1790000000000001;
    const NEW_CODE = PAYOS_CODE;
    const auditsOf = (f: Fixture, action: string) => f.state.audits.filter((a) => a.action === action);

    /* Phía order giả lập đúng OrderService: onPaid ⇒ paid, onRefunded ⇒ refunded / partially_refunded — để khẳng định TRẠNG THÁI ĐƠN chứ không chỉ lời gọi hàm. */
    function trackOrder(f: Fixture) {
      const order = { paymentStatus: 'unpaid', refundCalls: 0 };
      f.orders.onPaid.mockImplementation(() => {
        order.paymentStatus = 'paid';
        return Promise.resolve();
      });
      f.orders.onRefunded.mockImplementation((_code: string, _amount: bigint, _id: string, _tx: unknown, full?: boolean) => {
        order.refundCalls += 1;
        order.paymentStatus = full ? 'refunded' : 'partially_refunded';
        return Promise.resolve();
      });
      return order;
    }

    /* Khách trả cả link cũ (khoản hợp lệ) lẫn link mới (khoản trùng) — webhook đến đúng thứ tự đó. */
    async function payTwice() {
      const f = buildFixture();
      const order = trackOrder(f);
      const first = f.seedPayos({}, OLD_CODE);
      const second = f.seedPayos({}, NEW_CODE);
      await f.service.handlePayos(signed(webhookData({}, OLD_CODE)));
      await f.service.handlePayos(signed(webhookData({}, NEW_CODE)));
      const refund = must([...f.state.refunds.values()][0], 'refund trùng');
      return { f, order, first, second, refund };
    }

    it('trả đôi (link cũ + link mới) ⇒ đơn VẪN paid; đúng MỘT khoản bị hoàn (khoản trùng); không chạm trạng thái đơn / hoa hồng / doanh thu', async () => {
      const { f, order, first, second, refund } = await payTwice();
      expect(order.paymentStatus).toBe('paid');
      expect(f.state.refunds.size).toBe(1);
      expect(refund).toMatchObject({ paymentId: second.id, kind: REFUND_KIND.DUPLICATE_PAYMENT, status: REFUND_STATUS.REQUESTED, shopId: null, returnRequestId: null });
      expect(auditsOf(f, PAYMENT_AUDIT.REFUND_REQUESTED)[0]).toMatchObject({ afterSummary: { kind: REFUND_KIND.DUPLICATE_PAYMENT, amount: '350000' } });

      const res = await f.service.processRefund(actor, refund.id, {});

      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, kind: REFUND_KIND.DUPLICATE_PAYMENT, needsReconcile: false, providerRef: 'payos-refund:TX-123' });
      // đơn không bị đụng: vẫn paid, order không được báo hoàn (kể cả markReturnRefunded)
      expect(order).toEqual({ paymentStatus: 'paid', refundCalls: 0 });
      expect(f.orders.onRefunded).not.toHaveBeenCalled();
      expect(f.orders.markReturnRefunded).not.toHaveBeenCalled();
      // khoản hợp lệ giữ nguyên
      expect(f.payment(first.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
      expect(f.payment(first.id).refundedAmount.toString()).toBe('0');
      // khoản trùng được trả đủ cho khách
      expect(f.payment(second.id)).toMatchObject({ status: PAY_STATUS.REFUNDED });
      expect(f.payment(second.id).refundedAmount.toString()).toBe('350000');
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.payout).toHaveBeenCalledWith(expect.objectContaining({ amount: 350_000n, idempotencyKey: refund.id, referenceId: refund.id }));
      expect(f.txnsOf(second.id, TX_TYPE.REFUND)).toHaveLength(1);
      expect(f.txnsOf(first.id, TX_TYPE.REFUND)).toHaveLength(0);
      // không phát sự kiện hoàn theo đơn (ví COD đảo hoa hồng) — chỉ còn đúng 1 sự kiện PAID của khoản hợp lệ
      expect(f.state.outbox.map((e) => e.eventType)).toEqual([PAYMENT_EVENT.PAID]);
      // nhưng vẫn ghi sổ + audit đầy đủ
      expect(auditsOf(f, PAYMENT_AUDIT.REFUND_PROCESSED)).toHaveLength(1);
      expect(auditsOf(f, PAYMENT_AUDIT.REFUND_PROCESSED)[0]).toMatchObject({ actorUserId: actor.userId, entityId: refund.id, afterSummary: { kind: REFUND_KIND.DUPLICATE_PAYMENT, amount: '350000', providerRef: 'payos-refund:TX-123', via: 'process' } });
    });

    it('gọi lại KHÔNG hoàn thêm: process lần hai = INVALID_STATE, webhook trùng lặp không tạo yêu cầu/chi tiền mới, đơn vẫn paid', async () => {
      const { f, order, second, refund } = await payTwice();
      await f.service.processRefund(actor, refund.id, {});

      const again = await thrown(f.service.processRefund(actor, refund.id, {}));
      await f.service.handlePayos(signed(webhookData({}, NEW_CODE))); // webhook lặp của khoản trùng
      await f.service.handlePayos(signed(webhookData({}, OLD_CODE))); // và của khoản hợp lệ

      expect(again).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE, message: 'Đã hoàn xong' });
      expect(f.state.refunds.size).toBe(1);
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.payment(second.id).refundedAmount.toString()).toBe('350000');
      expect(f.txnsOf(second.id, TX_TYPE.REFUND)).toHaveLength(1);
      expect(order).toEqual({ paymentStatus: 'paid', refundCalls: 0 });
    });

    it('đối chứng: hoàn THEO ĐƠN (kind order) vẫn báo order + phát PAYMENT_REFUNDED như cũ', async () => {
      const f = buildFixture();
      const order = trackOrder(f);
      const only = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date('2026-10-03T09:30:00.000Z'), gatewayResponse: webhookData(), version: 1 });
      const { refundId } = await f.db.$transaction((tx) => f.service.requestRefund({ orderCode: ORDER_CODE, shopId: 'shop-1', amount: 350_000n, reason: 'Huỷ đơn', returnRequestId: null, actorUserId: 'staff-1' }, tx as unknown as Tx));
      expect(f.refund(must(refundId, 'refundId')).kind).toBe(REFUND_KIND.ORDER);

      await f.service.processRefund(actor, must(refundId, 'refundId'), {});

      expect(order).toEqual({ paymentStatus: 'refunded', refundCalls: 1 });
      expect(f.state.outbox.map((e) => e.eventType)).toEqual([PAYMENT_EVENT.REFUNDED]);
      expect(f.payment(only.id).status).toBe(PAY_STATUS.REFUNDED);
    });

    it('khoản trùng còn CHỜ hoàn mà đơn bị huỷ / đổi trả ⇒ hoàn theo đơn chọn khoản HỢP LỆ, không vướng REFUND_EXCEEDS của khoản trùng', async () => {
      const { f, first, second } = await payTwice(); // khoản trùng đã có yêu cầu hoàn đủ (đang chờ)
      const request = (o: { paymentId?: string } = {}) => f.db.$transaction((tx) => f.service.requestRefund({ orderCode: ORDER_CODE, shopId: null, amount: 350_000n, reason: 'Huỷ đơn', returnRequestId: null, actorUserId: 'staff-1', ...o }, tx as unknown as Tx));

      const { refundId } = await request();

      expect(f.refund(must(refundId, 'refundId'))).toMatchObject({ paymentId: first.id, kind: REFUND_KIND.ORDER });
      expect(f.state.refunds.size).toBe(2);
      // chỉ định rõ khoản trùng thì vẫn làm theo yêu cầu (đường thanh toán đến muộn dùng paymentId) — nhưng đã có yêu cầu hoàn đủ ⇒ chặn tổng hoàn vượt
      expect(await thrown(request({ paymentId: second.id }))).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS });
    });

    it('đơn chỉ còn khoản trùng đang chờ hoàn (khoản hợp lệ đã hoàn hết) ⇒ hoàn theo đơn trả refundId null, không tạo yêu cầu thứ hai trên khoản trùng', async () => {
      const { f, first, second } = await payTwice();
      f.payment(first.id).status = PAY_STATUS.REFUNDED;
      f.payment(first.id).refundedAmount = D(AMOUNT);

      const { refundId } = await f.db.$transaction((tx) => f.service.requestRefund({ orderCode: ORDER_CODE, shopId: null, amount: 1_000n, reason: 'Huỷ đơn', returnRequestId: null, actorUserId: 'staff-1' }, tx as unknown as Tx));

      expect(refundId).toBeNull();
      expect(f.state.refunds.size).toBe(1);
      expect([...f.state.refunds.values()][0].paymentId).toBe(second.id);
    });

    it('idempotent theo KHOẢN THANH TOÁN: ghi nhận khoản trùng chạy lại (vd return + IPN chạy chồng) không tạo yêu cầu hoàn thứ hai và không làm hỏng giao dịch', async () => {
      const { f, second } = await payTwice();
      f.payment(second.id).status = PAY_STATUS.PENDING; // giả lập một lần ghi nhận nữa của cùng khoản (khoản chưa kịp chuyển paid trong góc nhìn của luồng đến sau)

      const r = await f.service.handlePayos(signed(webhookData({}, NEW_CODE)));

      expect(r).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } }); // không REFUND_EXCEEDS ⇒ không rollback ⇒ không 500
      expect(f.state.refunds.size).toBe(1);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
    });

    it('khoản trùng: cổng OK + ghi sổ lỗi ⇒ giữ providerRef, retry ghi sổ KHÔNG gọi cổng lần hai và KHÔNG báo order (đơn vẫn paid)', async () => {
      const { f, order, second, refund } = await payTwice();
      f.failNth('payment.update', 1, new Error('db chết'));

      await thrown(f.service.processRefund(actor, refund.id, {}));
      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: 'payos-refund:TX-123' });
      await f.service.retryFinalizeRefund(actor, refund.id);

      expect(f.refund(refund.id).status).toBe(REFUND_STATUS.DONE);
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.payment(second.id).status).toBe(PAY_STATUS.REFUNDED);
      expect(order).toEqual({ paymentStatus: 'paid', refundCalls: 0 });
      expect(f.state.outbox.map((e) => e.eventType)).toEqual([PAYMENT_EVENT.PAID]);
    });
  });

  // ------------------------------------------------------------------ refund KẸT processing: cổng đã chi nhưng ghi sổ lỗi

  describe('refund kẹt processing — phục hồi AN TOÀN, không chi đôi', () => {
    const ACCOUNT = { counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A' };
    const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);
    const auditsOf = (f: Fixture, action: string) => f.state.audits.filter((a) => a.action === action);
    const refundTxns = (f: Fixture, paymentId: string) => f.txnsOf(paymentId, TX_TYPE.REFUND);
    const refundedEvents = (f: Fixture) => f.state.outbox.filter((e) => e.eventType === PAYMENT_EVENT.REFUNDED);

    /* payment PayOS đã trả 350.000 (có TK đối ứng) + yêu cầu hoàn 100.000 chờ xử lý. */
    function setup(o: { payment?: Partial<PaymentRow>; refund?: Partial<RefundRow> } = {}) {
      const f = buildFixture();
      const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date('2026-10-03T09:30:00.000Z'), transactionCode: String(PAYOS_CODE), gatewayResponse: webhookData(ACCOUNT), version: 1, ...o.payment });
      const refund = f.seedRefund(payment, o.refund);
      return { f, payment, refund };
    }
    /* Cổng đã chi nhưng bước ghi sổ lỗi: refund kẹt `processing` có providerRef. */
    async function stuckAfterGatewayPaid(o: Parameters<typeof setup>[0] = {}) {
      const s = setup(o);
      s.f.failNth('payment.update', 1, new Error('db chết'));
      const err = await thrown(s.f.service.processRefund(actor, s.refund.id, {}));
      return { ...s, err };
    }

    describe('cổng ĐÃ chi + ghi sổ lỗi', () => {
      it('refund GIỮ processing + providerRef (không nhả về requested); payment / sổ / outbox không đổi; cổng chỉ bị gọi 1 lần', async () => {
        const { f, payment, refund, err } = await stuckAfterGatewayPaid();

        expect((err as Error).message).toBe('db chết');
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: 'payos-refund:TX-123' });
        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('0');
        expect(refundTxns(f, payment.id)).toHaveLength(0);
        expect(refundedEvents(f)).toHaveLength(0);
        expect(f.orders.onRefunded).not.toHaveBeenCalled();
      });

      it('retry-finalize ⇒ ghi sổ ĐÚNG 1 lần, KHÔNG gọi cổng lần hai; ghi vết "recovered" + audit via retry-finalize', async () => {
        const { f, payment, refund } = await stuckAfterGatewayPaid();

        const res = await f.service.retryFinalizeRefund(actor, refund.id);

        expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-123', needsReconcile: false });
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PARTIALLY_REFUNDED });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.DONE, processedBy: actor.userId });
        expect(refundTxns(f, payment.id)).toEqual([expect.objectContaining({ status: 'ok', providerRef: 'payos-refund:TX-123', rawResponse: { recovered: true } })]);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
        expect(f.orders.onRefunded.mock.calls[0].slice(0, 3)).toEqual([ORDER_CODE, 100_000n, REFUND_ID]);
        expect(refundedEvents(f)).toHaveLength(1);
        expect(auditsOf(f, PAYMENT_AUDIT.REFUND_PROCESSED)).toEqual([expect.objectContaining({ actorUserId: actor.userId, afterSummary: expect.objectContaining({ via: 'retry-finalize', providerRef: 'payos-refund:TX-123' }) as unknown })]);
      });

      it('retry-finalize lần hai ⇒ INVALID_STATE "Đã hoàn xong"; sổ không đổi', async () => {
        const { f, payment, refund } = await stuckAfterGatewayPaid();
        await f.service.retryFinalizeRefund(actor, refund.id);

        const again = await thrown(f.service.retryFinalizeRefund(actor, refund.id));

        expect(again).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE, message: 'Đã hoàn xong' });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(refundTxns(f, payment.id)).toHaveLength(1);
        expect(f.payout).toHaveBeenCalledTimes(1);
      });

      it('HAI retry-finalize ĐỒNG THỜI ⇒ ghi sổ đúng MỘT lần (cộng 100.000 chứ không 200.000); lệnh đến sau thấy đã done và trả kết quả êm', async () => {
        const { f, payment, refund } = await stuckAfterGatewayPaid();
        f.syncTransactions(2);

        const results = await Promise.all([f.service.retryFinalizeRefund(actor, refund.id), f.service.retryFinalizeRefund(actor, refund.id)]);

        expect(results.map((r) => r.status)).toEqual([REFUND_STATUS.DONE, REFUND_STATUS.DONE]);
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(refundTxns(f, payment.id)).toHaveLength(1);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
        expect(refundedEvents(f)).toHaveLength(1);
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.refund(refund.id).version).toBe(2); // chiếm + ghi sổ (lần ghi sổ thứ hai không tăng)
      });

      it('process NGAY sau khi ghi sổ lỗi (processing còn "tươi") ⇒ INVALID_STATE như bấm đúp; QUÁ 10 phút ⇒ chỉ ghi sổ, KHÔNG gọi cổng', async () => {
        const { f, payment, refund } = await stuckAfterGatewayPaid();

        const fresh = await thrown(f.service.processRefund(actor, refund.id, {}));
        expect(fresh).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE });
        expect(f.refund(refund.id).status).toBe(REFUND_STATUS.PROCESSING);

        f.refund(refund.id).updatedAt = minutesAgo(11);
        const res = await f.service.processRefund(actor, refund.id, {});

        expect(res.status).toBe(REFUND_STATUS.DONE);
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(refundTxns(f, payment.id)).toHaveLength(1);
      });

      it('process (quá hạn, đã có providerRef) chạy ĐỒNG THỜI với retry-finalize ⇒ vẫn chỉ ghi sổ một lần', async () => {
        const { f, payment, refund } = await stuckAfterGatewayPaid();
        f.refund(refund.id).updatedAt = minutesAgo(11);
        f.syncTransactions(2);

        await Promise.all([f.service.processRefund(actor, refund.id, {}), f.service.retryFinalizeRefund(actor, refund.id)]);

        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(refundTxns(f, payment.id)).toHaveLength(1);
        expect(f.payout).toHaveBeenCalledTimes(1);
      });

      it('lỗi ghi sổ VĨNH VIỄN (tổng hoàn vượt số đã thu) ⇒ refund vẫn processing + providerRef; retry-finalize báo lại đúng lỗi đó, KHÔNG gọi cổng, không ghi gì', async () => {
        const s = setup({ payment: { status: PAY_STATUS.PARTIALLY_REFUNDED, refundedAmount: D(300_000) }, refund: { amount: D(100_000) } });

        const first = await thrown(s.f.service.processRefund(actor, s.refund.id, {}));
        const retry = await thrown(s.f.service.retryFinalizeRefund(actor, s.refund.id));

        expect(first).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS });
        expect(retry).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS });
        expect(s.f.payout).toHaveBeenCalledTimes(1);
        expect(s.f.refund(s.refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: 'payos-refund:TX-123' });
        expect(s.f.payment(s.payment.id).refundedAmount.toString()).toBe('300000');
        expect(refundTxns(s.f, s.payment.id)).toHaveLength(0);
        expect(s.f.orders.onRefunded).not.toHaveBeenCalled();
      });
    });

    describe('retry-finalize chỉ dành cho refund processing ĐÃ có providerRef', () => {
      it('không tồn tại ⇒ NOT_FOUND', async () => {
        const f = buildFixture();
        expect(await thrown(f.service.retryFinalizeRefund(actor, REFUND_ID))).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_NOT_FOUND });
      });

      it.each([REFUND_STATUS.REQUESTED, REFUND_STATUS.FAILED])('refund %s ⇒ INVALID_STATE, không gọi cổng, không đổi gì', async (status) => {
        const { f, refund } = setup({ refund: { status } });
        const err = await thrown(f.service.retryFinalizeRefund(actor, refund.id));
        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE });
        expect(f.payout).not.toHaveBeenCalled();
        expect(f.refund(refund.id).status).toBe(status);
      });

      it('processing nhưng CHƯA có providerRef (chưa rõ cổng đã chi chưa) ⇒ INVALID_STATE nêu rõ thiếu providerRef; không ghi sổ', async () => {
        const { f, payment, refund } = setup({ refund: { status: REFUND_STATUS.PROCESSING } });
        const err = await thrown(f.service.retryFinalizeRefund(actor, refund.id));
        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE });
        expect((err as BusinessException).message).toContain('chưa có providerRef');
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('0');
        expect(refundTxns(f, payment.id)).toHaveLength(0);
      });

      it('đã done ⇒ INVALID_STATE "Đã hoàn xong"', async () => {
        const { f, refund } = setup({ refund: { status: REFUND_STATUS.DONE, providerRef: 'x' } });
        expect(await thrown(f.service.retryFinalizeRefund(actor, refund.id))).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE, message: 'Đã hoàn xong' });
      });
    });

    describe('cổng chi nhưng GHI providerRef lỗi (DB chết đúng lúc đó)', () => {
      it('refund VẪN processing (KHÔNG nhả về requested để ai đó bấm gọi lại ngay); quá hạn mới chiếm lại và gọi lại với CÙNG idempotency-key', async () => {
        const { f, refund } = setup();
        f.failNth('refund.updateMany', 2, new Error('db chết')); // #1 chiếm, #2 ghi providerRef

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect((err as Error).message).toBe('db chết');
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: null });
        expect(f.payout).toHaveBeenCalledTimes(1);
        // chưa quá hạn: không cho gọi lại
        expect(await thrown(f.service.processRefund(actor, refund.id, {}))).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE });
        expect(f.payout).toHaveBeenCalledTimes(1);

        f.refund(refund.id).updatedAt = minutesAgo(11);
        const res = await f.service.processRefund(actor, refund.id, {});

        expect(res.status).toBe(REFUND_STATUS.DONE);
        expect(f.payout.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([REFUND_ID, REFUND_ID]); // PayOS trả lại đúng lệnh cũ, không chi đôi
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
      });
    });

    describe('hoàn tay: lỗi ghi sổ ⇒ nhả chiếm (chưa có gì ra ngoài hệ thống) để làm lại', () => {
      it('ghi sổ lỗi ⇒ refund về requested, không providerRef; làm lại với cùng providerRef ⇒ done một lần', async () => {
        const { f, payment, refund } = setup({ payment: { gatewayResponse: null } }); // thiếu TK đối ứng ⇒ kế toán chuyển tay
        f.failNth('payment.update', 1, new Error('db chết'));

        const err = await thrown(f.service.processRefund(actor, refund.id, { providerRef: 'FT26100300999' }));

        expect((err as Error).message).toBe('db chết');
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.REQUESTED, providerRef: null });
        expect(f.payout).not.toHaveBeenCalled();

        const res = await f.service.processRefund(actor, refund.id, { providerRef: 'FT26100300999' });

        expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'FT26100300999' });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(refundTxns(f, payment.id)).toHaveLength(1);
      });
    });

    describe('processing treo, CHƯA có providerRef (tiến trình chết giữa chừng)', () => {
      it('quá 10 phút ⇒ process chiếm lại bằng compare-and-set rồi chạy bình thường (PayOS: cùng idempotency-key)', async () => {
        const { f, payment, refund } = setup({ refund: { status: REFUND_STATUS.PROCESSING, processedBy: 'user-other', version: 1, updatedAt: minutesAgo(11) } });

        const res = await f.service.processRefund(actor, refund.id, {});

        expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-123' });
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.payout).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: REFUND_ID }));
        expect(f.refund(refund.id)).toMatchObject({ processedBy: actor.userId, version: 3 }); // 1 + chiếm lại + ghi sổ
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
      });

      it.each([0, 5, 9])('processing MỚI (%i phút) ⇒ INVALID_STATE, không chiếm lại, không gọi cổng', async (minutes) => {
        const { f, refund } = setup({ refund: { status: REFUND_STATUS.PROCESSING, processedBy: 'user-other', version: 1, updatedAt: minutesAgo(minutes) } });
        const err = await thrown(f.service.processRefund(actor, refund.id, {}));
        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE });
        expect(f.payout).not.toHaveBeenCalled();
        expect(f.refund(refund.id)).toMatchObject({ processedBy: 'user-other', version: 1 });
      });

      it('HAI người cùng chiếm lại refund treo ⇒ chỉ MỘT người thắng: payout đúng 1 lần, người kia INVALID_STATE', async () => {
        const { f, refund } = setup({ refund: { status: REFUND_STATUS.PROCESSING, version: 1, updatedAt: minutesAgo(11) } });

        const results = await Promise.allSettled([f.service.processRefund(actor, refund.id, {}), f.service.processRefund(actor_of('user-acc-2'), refund.id, {})]);

        expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect((results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason as BusinessException).errorCode).toBe(PAYMENT_ERR.INVALID_STATE);
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
        expect(f.state.outbox).toHaveLength(1);
      });
    });

    /* ----------------------------------------------------------------------------------------------- job phục hồi */
    describe('recoverStuckRefunds (job worker)', () => {
      it('processing quá hạn ĐÃ có providerRef ⇒ ghi sổ nốt (hệ thống, không gọi cổng): processedBy giữ nguyên, audit không actor + via job', async () => {
        const { f, payment, refund } = setup({ refund: { status: REFUND_STATUS.PROCESSING, providerRef: 'payos-refund:TX-123', processedBy: 'user-acc-9', version: 1, updatedAt: minutesAgo(11) } });

        const out = await f.service.recoverStuckRefunds();

        expect(out).toEqual({ finalized: 1, released: 0, flagged: 0 });
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.DONE, processedBy: 'user-acc-9', providerRef: 'payos-refund:TX-123' });
        expect(f.payout).not.toHaveBeenCalled();
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
        expect(auditsOf(f, PAYMENT_AUDIT.REFUND_PROCESSED)).toEqual([expect.objectContaining({ actorUserId: null, afterSummary: expect.objectContaining({ via: 'job' }) as unknown })]);
      });

      it('processing quá hạn, CHƯA providerRef, CHƯA từng gọi cổng ⇒ nhả về requested + audit RECOVERED', async () => {
        const { f, refund } = setup({ refund: { status: REFUND_STATUS.PROCESSING, version: 1, updatedAt: minutesAgo(11) } });

        const out = await f.service.recoverStuckRefunds();

        expect(out).toEqual({ finalized: 0, released: 1, flagged: 0 });
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.REQUESTED, version: 2 });
        expect(f.payout).not.toHaveBeenCalled();
        expect(auditsOf(f, PAYMENT_AUDIT.REFUND_RECOVERED)).toEqual([expect.objectContaining({ actorUserId: null, entityId: refund.id, beforeSummary: { status: 'processing' }, afterSummary: { status: 'requested', gatewayAttempted: false } })]);
      });

      it('processing quá hạn, CHƯA providerRef nhưng ĐÃ có dấu gọi cổng (dữ liệu VNPay cũ) ⇒ failed kèm lý do, GIỮ dấu ⇒ needsReconcile (không tự gọi lại, không tự chi)', async () => {
        const f = buildFixture();
        const payment = f.seedPayment({ methodCode: 'vnpay', status: PAY_STATUS.PAID, paidAt: new Date(), version: 1 });
        const refund = f.seedRefund(payment, { status: REFUND_STATUS.PROCESSING, gatewayAttemptedAt: minutesAgo(12), version: 1, updatedAt: minutesAgo(11) });

        const out = await f.service.recoverStuckRefunds();

        expect(out).toEqual({ finalized: 0, released: 0, flagged: 1 });
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, version: 2 });
        expect(f.refund(refund.id).gatewayAttemptedAt).toBeInstanceOf(Date);
        expect(f.refund(refund.id).note).toContain('chưa rõ cổng đã hoàn');
        expect((await f.service.getRefund(refund.id)).needsReconcile).toBe(true);
        expect(auditsOf(f, PAYMENT_AUDIT.REFUND_RECOVERED)[0]).toMatchObject({ afterSummary: { status: 'failed', gatewayAttempted: true } });
      });

      it('chỉ động tới processing QUÁ HẠN: processing mới, requested, failed, done giữ nguyên', async () => {
        const f = buildFixture();
        const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), version: 1, gatewayResponse: webhookData(ACCOUNT) });
        const ids = ['11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000004'];
        f.seedRefund(payment, { id: ids[0], status: REFUND_STATUS.PROCESSING, updatedAt: minutesAgo(9) });
        f.seedRefund(payment, { id: ids[1], status: REFUND_STATUS.REQUESTED, updatedAt: minutesAgo(60) });
        f.seedRefund(payment, { id: ids[2], status: REFUND_STATUS.FAILED, updatedAt: minutesAgo(60) });
        f.seedRefund(payment, { id: ids[3], status: REFUND_STATUS.DONE, updatedAt: minutesAgo(60), providerRef: 'x' });

        const out = await f.service.recoverStuckRefunds();

        expect(out).toEqual({ finalized: 0, released: 0, flagged: 0 });
        expect(ids.map((id) => f.refund(id).status)).toEqual([REFUND_STATUS.PROCESSING, REFUND_STATUS.REQUESTED, REFUND_STATUS.FAILED, REFUND_STATUS.DONE]);
      });

      it('mỗi refund một try/catch: refund đầu lỗi ghi sổ (log) không chặn refund sau; tối đa `limit`, cũ nhất trước', async () => {
        const f = buildFixture();
        const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), version: 1, gatewayResponse: webhookData(ACCOUNT) });
        const a = f.seedRefund(payment, { id: '22222222-0000-4000-8000-00000000000a', amount: D(10_000), status: REFUND_STATUS.PROCESSING, providerRef: 'ref-a', updatedAt: minutesAgo(30) });
        const b = f.seedRefund(payment, { id: '22222222-0000-4000-8000-00000000000b', amount: D(20_000), status: REFUND_STATUS.PROCESSING, providerRef: 'ref-b', updatedAt: minutesAgo(20) });
        const c = f.seedRefund(payment, { id: '22222222-0000-4000-8000-00000000000c', amount: D(30_000), status: REFUND_STATUS.PROCESSING, providerRef: 'ref-c', updatedAt: minutesAgo(15) });
        f.failNth('payment.update', 1, new Error('db chết')); // refund cũ nhất (a) lỗi ghi sổ

        const out = await f.service.recoverStuckRefunds(2); // limit 2 ⇒ a và b; c để lượt sau

        expect(out).toEqual({ finalized: 1, released: 0, flagged: 0 });
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect([a, b, c].map((r) => f.refund(r.id).status)).toEqual([REFUND_STATUS.PROCESSING, REFUND_STATUS.DONE, REFUND_STATUS.PROCESSING]);
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('20000');
      });

      it('job chạy ĐỒNG THỜI với retry-finalize của kế toán ⇒ chỉ ghi sổ một lần', async () => {
        const { f, payment, refund } = setup({ refund: { status: REFUND_STATUS.PROCESSING, providerRef: 'payos-refund:TX-123', updatedAt: minutesAgo(11) } });
        f.syncTransactions(2);

        await Promise.all([f.service.recoverStuckRefunds(), f.service.retryFinalizeRefund(actor, refund.id)]);

        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(refundTxns(f, payment.id)).toHaveLength(1);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
      });

      it('job chạy lần hai ngay sau đó ⇒ không còn gì để làm (idempotent)', async () => {
        const { f, payment } = setup({ refund: { status: REFUND_STATUS.PROCESSING, providerRef: 'payos-refund:TX-123', updatedAt: minutesAgo(11) } });
        await f.service.recoverStuckRefunds();
        expect(await f.service.recoverStuckRefunds()).toEqual({ finalized: 0, released: 0, flagged: 0 });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
      });
    });
  });
});

/* Lấy hàm xử lý của controller (đích của metadata @Public/@HttpCode) mà không tách method khỏi `this`. */
function handlerOf(controller: { prototype: object }, name: string): object {
  return Object.getOwnPropertyDescriptor(controller.prototype, name)?.value as object;
}

/* actor khách (chủ đơn) cho retryPayos — chỉ userId được dùng. */
function actor_of(userId: string): AuthenticatedActor {
  return { userId, email: 'khach@fitly.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-c' };
}

/* ================================================================ controller ================================================================ */

describe('Controller PayOS (payment.controllers)', () => {
  const stub = {
    handlePayos: jest.fn((_body: Record<string, unknown>): Promise<{ statusCode: number; body: Record<string, unknown> }> => Promise.resolve({ statusCode: 200, body: { code: '00', message: 'Success' } })),
    handlePayosReturn: jest.fn((_code: string): Promise<{ success: boolean; orderCode: string | null; status: string; message: string }> => Promise.resolve({ success: true, orderCode: ORDER_CODE, status: 'PAID', message: 'Thanh toán thành công' })),
    retryPayos: jest.fn((_actor: AuthenticatedActor, _orderCode: string): Promise<{ paymentUrl: string }> => Promise.resolve({ paymentUrl: LINK_URL })),
  };
  const publicController = new PaymentPublicController(stub as unknown as PaymentService);
  const customerController = new PaymentController(stub as unknown as PaymentService);

  beforeEach(() => {
    stub.handlePayos.mockClear();
    stub.handlePayosReturn.mockClear();
    stub.retryPayos.mockClear();
  });

  describe('POST payments/payos/webhook', () => {
    const body = { code: '00', data: { orderCode: 1 }, signature: 'x' };

    it('200 ⇒ trả thẳng body {code, message} để PayOS ngừng gửi lại', async () => {
      expect(await publicController.payosWebhook(body)).toEqual({ code: '00', message: 'Success' });
      expect(stub.handlePayos).toHaveBeenCalledWith(body);
    });

    it.each([
      [401, { code: '97', message: 'Invalid signature' }],
      [401, { code: '01', message: 'PayOS not configured' }],
      [500, { code: '99', message: 'Internal error' }],
    ])('status %i ⇒ ném HttpException mang đúng mã + body', async (statusCode, payload) => {
      stub.handlePayos.mockResolvedValueOnce({ statusCode, body: payload });
      const err = await thrown(publicController.payosWebhook(body));
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(statusCode);
      expect((err as HttpException).getResponse()).toEqual(payload);
    });

    it('là route công khai (không cần JWT), trả 200 khi thành công, giới hạn 1200 request / 10 phút / IP', () => {
      const handler = handlerOf(PaymentPublicController, 'payosWebhook');
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler) as unknown).toEqual({ name: 'payos-webhook', limit: 1200, windowSeconds: 600, by: 'ip' });
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler) as unknown).toBe(true);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler) as unknown).toBe(200);
    });
  });

  describe('GET payments/payos/return', () => {
    it('chuyển orderCode xuống service và bọc ApiResponse (message = message của kết quả)', async () => {
      const res = await publicController.payosReturn(String(PAYOS_CODE));
      expect(stub.handlePayosReturn).toHaveBeenCalledWith(String(PAYOS_CODE));
      expect(res).toMatchObject({ success: true, message: 'Thanh toán thành công', data: { success: true, orderCode: ORDER_CODE, status: 'PAID' }, error: null });
    });

    it('thiếu orderCode ⇒ gọi service với chuỗi rỗng (service trả "không tìm thấy")', async () => {
      stub.handlePayosReturn.mockResolvedValueOnce({ success: false, orderCode: null, status: 'UNKNOWN', message: 'Không tìm thấy giao dịch' });
      const res = await publicController.payosReturn(undefined);
      expect(stub.handlePayosReturn).toHaveBeenCalledWith('');
      expect(res.data).toMatchObject({ success: false, status: 'UNKNOWN' });
    });

    it('là route công khai', () => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handlerOf(PaymentPublicController, 'payosReturn')) as unknown).toBe(true);
    });
  });

  describe('POST payments/payos/retry/:orderCode', () => {
    it('đổi mã đơn sang CHỮ HOA và truyền actor của người đăng nhập', async () => {
      const a = actor_of(USER);
      const res = await customerController.retryPayos(a, 'ft2610030001');
      expect(stub.retryPayos).toHaveBeenCalledWith(a, 'FT2610030001');
      expect(res).toMatchObject({ success: true, data: { paymentUrl: LINK_URL } });
    });

    it('KHÔNG công khai (cần đăng nhập) và trả 200', () => {
      const handler = handlerOf(PaymentController, 'retryPayos');
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler) as unknown).toBeUndefined();
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler) as unknown).toBe(200);
    });
  });

  describe('bộ lọc phương thức ở danh sách thanh toán của admin', () => {
    const [ListQuery] = Reflect.getMetadata('design:paramtypes', AdminPaymentController.prototype, 'list') as Array<new () => object>;
    const errorsFor = (query: Record<string, unknown>) => validate(plainToInstance(ListQuery, query));

    it('(kiểm chứng khung test) chấp nhận vnpay, từ chối giá trị lạ', async () => {
      expect(await errorsFor({ methodCode: 'vnpay' })).toHaveLength(0);
      expect(await errorsFor({ methodCode: 'khong-ton-tai' })).not.toHaveLength(0);
    });

    it('lọc methodCode=payos hợp lệ (admin lọc được giao dịch PayOS); cod / bank_transfer vẫn hợp lệ', async () => {
      expect(await errorsFor({ methodCode: 'payos' })).toHaveLength(0);
      expect(await errorsFor({ methodCode: 'cod' })).toHaveLength(0);
      expect(await errorsFor({ methodCode: 'bank_transfer' })).toHaveLength(0);
    });
  });
});

/* ================================================================ controller hoàn tiền ================================================================ */

describe('AdminPaymentController — hoàn tiền: process + retry-finalize', () => {
  const refundResponse = { id: REFUND_ID, status: 'done' };
  const stub = {
    processRefund: jest.fn((_actor: AuthenticatedActor, _id: string, _body: object): Promise<unknown> => Promise.resolve(refundResponse)),
    retryFinalizeRefund: jest.fn((_actor: AuthenticatedActor, _id: string): Promise<unknown> => Promise.resolve(refundResponse)),
  };
  const controller = new AdminPaymentController(stub as unknown as PaymentService);
  beforeEach(() => {
    stub.processRefund.mockClear();
    stub.retryFinalizeRefund.mockClear();
  });

  it('POST admin/refunds/:id/retry-finalize: chuyển actor + id xuống service, trả refund, 200', async () => {
    const res = await controller.retryFinalize(actor, REFUND_ID);

    expect(stub.retryFinalizeRefund).toHaveBeenCalledWith(actor, REFUND_ID);
    expect(res).toMatchObject({ success: true, message: 'Đã hoàn tất ghi sổ hoàn tiền', data: refundResponse });
    const handler = handlerOf(AdminPaymentController, 'retryFinalize');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler) as unknown).toBe(200);
    expect(Reflect.getMetadata(PATH_METADATA, handler) as unknown).toBe('refunds/:id/retry-finalize');
    expect(Reflect.getMetadata(METHOD_METADATA, handler) as unknown).toBe(RequestMethod.POST);
  });

  it.each(['process', 'retryFinalize'])('%s đòi quyền payment.refund.process (cùng quyền với hoàn tiền) và KHÔNG công khai', (method) => {
    const handler = handlerOf(AdminPaymentController, method);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler) as unknown).toEqual(['payment.refund.process']);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler) as unknown).toBeUndefined();
  });

  it('POST admin/refunds/:id/process: body (providerRef, note) chuyển NGUYÊN xuống service', async () => {
    const body = { providerRef: 'VNP-RF-777', note: 'đối chiếu' };
    await controller.process(actor, REFUND_ID, body);
    expect(stub.processRefund).toHaveBeenCalledWith(actor, REFUND_ID, body);
  });

  describe('validate body process', () => {
    const [, , ProcessBody] = Reflect.getMetadata('design:paramtypes', AdminPaymentController.prototype, 'process') as Array<new () => object>;
    const errorsFor = (body: Record<string, unknown>) => validate(plainToInstance(ProcessBody, body));

    it('body rỗng hợp lệ (PLAN-0018: đã bỏ cờ confirmGatewayNotRefunded của VNPay)', async () => {
      expect(await errorsFor({})).toHaveLength(0);
    });

    it('providerRef ≤ 120 ký tự (vừa cột VarChar(120)), note ≤ 500', async () => {
      expect(await errorsFor({ providerRef: 'x'.repeat(120) })).toHaveLength(0);
      expect(await errorsFor({ providerRef: 'x'.repeat(121) })).not.toHaveLength(0);
      expect(await errorsFor({ note: 'x'.repeat(501) })).not.toHaveLength(0);
    });
  });
});

/* ================================================================ hợp đồng schema ↔ service ================================================================ */

describe('hợp đồng schema ↔ service — refunds.kind / gateway_attempted_at', () => {
  const root = join(__dirname, '../../../../prisma');
  const migrationSql = (): string => {
    const dir = join(root, 'migrations');
    return readdirSync(dir)
      .filter((d) => /^\d+_/.test(d))
      .sort()
      .map((d) => readFileSync(join(dir, d, 'migration.sql'), 'utf8'))
      .join('\n');
  };

  it('CHECK chk_refunds_kind (bản mới nhất qua các migration) khớp ĐÚNG REFUND_KIND', () => {
    const defs = [...migrationSql().matchAll(/ADD CONSTRAINT "chk_refunds_kind"\s+CHECK \(\s*"kind" IN \(([^)]*)\)/g)];
    expect(defs.length).toBeGreaterThan(0);
    const allowed = [...defs[defs.length - 1][1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...allowed].sort()).toEqual(Object.values(REFUND_KIND).sort());
  });

  it('schema Prisma: kind mặc định "order" (mọi chỗ tạo refund không khai kind vẫn là hoàn theo đơn), gatewayAttemptedAt nullable → gateway_attempted_at', () => {
    const schema = readFileSync(join(root, 'schema', 'payment.prisma'), 'utf8');
    expect(schema).toMatch(/kind\s+String\s+@default\("order"\)\s+@db\.VarChar\(20\)/);
    expect(schema).toMatch(/gatewayAttemptedAt\s+DateTime\?\s+@map\("gateway_attempted_at"\)/);
    expect(migrationSql()).toMatch(/ADD COLUMN "kind" VARCHAR\(20\) NOT NULL DEFAULT 'order'/);
    expect(migrationSql()).toMatch(/ADD COLUMN "gateway_attempted_at" TIMESTAMPTZ/);
  });

  it('migration backfill nhận diện hoàn khoản trùng cũ theo tiền tố lý do — đúng tiền tố mà refundDuplicate ghi', async () => {
    expect(migrationSql()).toContain(`"reason" LIKE 'Thanh toán trùng%'`);
    const f = buildFixture();
    f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date('2026-10-03T09:00:00.000Z'), version: 1 }, 1790000000000001);
    f.seedPayos({}, PAYOS_CODE);
    await f.service.handlePayos(signed(webhookData({}, PAYOS_CODE)));
    const [refund] = [...f.state.refunds.values()];
    expect(refund.reason?.startsWith('Thanh toán trùng')).toBe(true);
    expect(refund.kind).toBe(REFUND_KIND.DUPLICATE_PAYMENT);
  });
});
