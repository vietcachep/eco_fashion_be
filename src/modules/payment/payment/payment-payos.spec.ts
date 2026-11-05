import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException, HttpStatus, Logger, RequestMethod } from '@nestjs/common';
import { HEADERS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ModuleRef } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuditLogRow } from '@common/audit/audit';
import { BusinessException, NotFoundException, ServiceUnavailableException } from '@common/exception/business.exception';
import type { NotifyCommand } from '@common/gateway/notification.gateway';
import { ORDER_PAYMENT_GATEWAY } from '@common/gateway/payment.gateway';
import type { PaymentInitiateInput, RefundPayee } from '@common/gateway/payment.gateway';
import type { UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import type { OutboxEventRow } from '@common/outbox/outbox';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from '@common/security/decorators';
import { RATE_LIMIT_KEY } from '@common/security/rate-limit.guard';
import type { Env } from '@config/env';
import type { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { GATEWAY_STATUS, METHOD, PAY_STATUS, PAYEE_SOURCE, PAYMENT_AUDIT, PAYMENT_ERR, PAYMENT_EVENT, REFUND_GATEWAY_STALL_MS, REFUND_KIND, REFUND_STATUS, TX_TYPE } from '../foundation/payment.constants';
import { PayosService } from '../payos/payos.service';
import { AdminPaymentController, PaymentController, PaymentPublicController } from './payment.controllers';
import { PaymentService } from './payment.service';
import type { RefundResponse } from './payment.service';
import type { ShopWalletService } from '../shop-wallet/shop-wallet.service';
import type { ShopWalletTopupSettleService } from '../shop-wallet/shop-wallet-topup-settle.service';

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
  receivedAmount: Dec;
  linkAttempts: number;
  lastLinkError: string | null;
  lastCheckedAt: Date | null;
  lastGatewayStatus: string | null;
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
  payeeBankBin: string | null;
  payeeAccountNumber: string | null;
  payeeAccountName: string | null;
  payeeSource: string | null;
  gatewayStatus: string | null;
  gatewayPayoutId: string | null;
  gatewayAttempt: number;
  gatewaySubmittedAt: Date | null;
  gatewayAlertedAt: Date | null;
  needsManual: boolean;
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
const DECIMAL_FIELDS = new Set(['amount', 'refundedAmount', 'receivedAmount']);
const LIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'processing', 'paid']);
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/* Bộ so khớp `where` kiểu Prisma — chỉ phần service dùng (bằng nhau, `in`, `not`, lọc theo quan hệ); toán tử lạ ⇒ ném để test không "đúng nhầm". */
function matchesRow(row: object, where: Where, relations: Record<string, (r: object) => object | undefined> = {}): boolean {
  const record = row as Record<string, unknown>;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((c) => matchesRow(row, c, relations));
    if (key === 'OR') return (cond as Where[]).some((c) => matchesRow(row, c, relations));
    if (key in relations) {
      const related = relations[key](row);
      return related !== undefined && matchesRow(related, cond as Where);
    }
    const actual = record[key];
    if (isPlainObject(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === 'in') return (arg as unknown[]).includes(actual);
        if (op === 'notIn') return !(arg as unknown[]).includes(actual);
        if (op === 'not') return actual !== arg;
        if (op === 'lte') return (actual as { lte?: (x: unknown) => boolean } | null)?.lte ? (actual as { lte: (x: unknown) => boolean }).lte(arg) : Number(actual) <= Number(arg);
        if (op === 'lt') return actual instanceof Date && arg instanceof Date && actual.getTime() < arg.getTime();
        throw new Error(`Toán tử where chưa hỗ trợ trong DB giả: ${op}`);
      });
    }
    return actual === cond;
  });
}

/* Giả lập P2002 của Prisma (vi phạm unique) — dùng cho unique index một phần `uq_refunds_provider_ref`. */
const p2002 = (): Error => Object.assign(new Error('Unique constraint failed on the fields: (`provider_ref`)'), { code: 'P2002' });

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

  type OrderBy = Record<string, 'asc' | 'desc'>;
  /* orderBy kiểu Prisma (một khoá hoặc mảng khoá) cho DB giả: so sánh Date / chuỗi theo thứ tự khoá. */
  const sortRows = <T extends object>(rows: T[], orderBy?: OrderBy | OrderBy[]): T[] => {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o));
    const val = (r: T, k: string): number | string => {
      const v = (r as Record<string, unknown>)[k];
      return v instanceof Date ? v.getTime() : String(v);
    };
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = val(a, k);
        const y = val(b, k);
        if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
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
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        calls.push('payment.updateMany');
        await tick();
        const rows = [...state.payments.values()].filter((r) => matchesRow(r, where));
        for (const row of rows) {
          const before = { ...row };
          applyData(row, data);
          st?.undo.push(() => Object.assign(row, before));
        }
        return { count: rows.length };
      },
      findMany: async (args: { where: Where; orderBy?: { createdAt: 'asc' | 'desc' }; take?: number }) => {
        calls.push('payment.findMany');
        await tick();
        return newestFirst([...state.payments.values()].filter((r) => matchesRow(r, args.where)), args.orderBy).slice(0, args.take ?? state.payments.size).map((r) => ({ ...r }));
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
        // Chỉ mục thật uq_payments_order_live: UNIQUE (order_id) WHERE status IN (pending, processing, paid) — đơn chỉ có MỘT payment sống. DB giả ném P2002 như Postgres (jest từng không bắt được lỗi này).
        if (LIVE_STATUSES.has(String(data.status)) && [...state.payments.values()].some((r) => r.orderId === data.orderId && LIVE_STATUSES.has(r.status))) throw p2002();
        const row = {
          id: `pay-${++seq}`,
          transactionCode: null,
          bankCode: null,
          cardBrand: null,
          cardLast4: null,
          transferContent: null,
          refundedAmount: D(0),
          receivedAmount: D(0),
          linkAttempts: 0,
          lastLinkError: null,
          lastCheckedAt: null,
          lastGatewayStatus: null,
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
        // Cùng chỉ mục uq_payments_order_live: đưa payment KHÔNG sống (cancelled…) lên pending/processing/paid khi đơn đã có payment sống khác ⇒ P2002 (payment đã sống mà đổi trạng thái sống khác thì không đụng chỉ mục).
        const nextStatus = typeof data.status === 'string' ? data.status : undefined;
        if (nextStatus && LIVE_STATUSES.has(nextStatus) && !LIVE_STATUSES.has(row.status) && [...state.payments.values()].some((r) => r.id !== row.id && r.orderId === row.orderId && LIVE_STATUSES.has(r.status))) throw p2002();
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
      findMany: async (args: { where: Where; orderBy?: { createdAt: 'asc' | 'desc' }; take?: number }) => {
        calls.push('paymentTransaction.findMany');
        await tick();
        const rows = state.txns.filter((r) => matchesRow(r, args.where, { payment: (t) => state.payments.get((t as TxnRow).paymentId) }));
        return newestFirst(rows, args.orderBy).slice(0, args.take ?? rows.length).map((r) => ({ ...r }));
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push('paymentTransaction.create');
        await tick();
        // Chỉ mục thật uq_payment_transactions_provider_ref: UNIQUE (type, provider_ref) WHERE provider_ref IS NOT NULL — DB giả phải ném P2002 như Postgres (jest từng không bắt được lỗi trùng này).
        if (data.providerRef != null && state.txns.some((t) => t.type === data.type && t.providerRef === data.providerRef)) throw p2002();
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
      findMany: async (args: { where: Where; orderBy?: OrderBy | OrderBy[]; take?: number; skip?: number; include?: { payment?: unknown }; select?: Record<string, boolean> }) => {
        calls.push('refund.findMany');
        await tick();
        // Lọc theo quan hệ `payment` (vd phương thức thanh toán của khoản hoàn) như Prisma — để job tự chi lọc COD ngay trong truy vấn.
        const rows = sortRows([...state.refunds.values()].filter((r) => matchesRow(r, args.where, { payment: (x) => state.payments.get((x as RefundRow).paymentId) })), args.orderBy);
        const page = rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length));
        return page.map((r) => (args.include?.payment ? { ...r, payment: { ...must(state.payments.get(r.paymentId), 'payment của refund') } } : { ...r }));
      },
      count: async (args: { where: Where }) => {
        calls.push('refund.count');
        await tick();
        return [...state.refunds.values()].filter((r) => matchesRow(r, args.where)).length;
      },
      /* So-sánh-rồi-đặt (compare-and-set) NGUYÊN TỬ như UPDATE … WHERE: lọc + ghi không xen await ⇒ hai lệnh đồng thời chỉ một lệnh thắng. */
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        calls.push('refund.updateMany');
        maybeFail('refund.updateMany');
        await tick();
        const rows = [...state.refunds.values()].filter((r) => matchesRow(r, where));
        // unique index một phần trên provider_ref (khác NULL): dòng khác đang giữ mã này ⇒ P2002 (cả lệnh không ghi gì, như UPDATE bị rollback)
        const newRef = data.providerRef;
        if (rows.length > 0 && typeof newRef === 'string' && [...state.refunds.values()].some((o) => o.providerRef === newRef && !rows.includes(o))) throw p2002();
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
        const row = { id: `refund-${++seq}`, providerRef: null, note: null, processedBy: null, processedAt: null, version: 0, returnRequestId: null, shopId: null, kind: 'order', gatewayAttemptedAt: null, payeeBankBin: null, payeeAccountNumber: null, payeeAccountName: null, payeeSource: null, gatewayStatus: null, gatewayPayoutId: null, gatewayAttempt: 0, gatewaySubmittedAt: null, gatewayAlertedAt: null, needsManual: false, updatedAt: new Date(), ...data, amount: D(data.amount as string), createdAt: nextDate() } as unknown as RefundRow;
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
  const createLinkDepth: number[] = []; // số transaction đang mở lúc gọi PayOS (phải là 0 — HTTP ngoài transaction)
  const createLink = jest.spyOn(payos, 'createPaymentLink').mockImplementation(() => {
    createLinkDepth.push(activeTx);
    return Promise.resolve({ checkoutUrl: LINK_URL, qrCode: QR, paymentLinkId: 'plink-1' });
  });
  const getLink = jest.spyOn(payos, 'getPaymentLink').mockResolvedValue({});
  const cancelLink = jest.spyOn(payos, 'cancelPaymentLink').mockResolvedValue(true);
  const payout = jest.spyOn(payos, 'payout').mockResolvedValue({ ok: true, code: '00', message: 'ok', transactionId: 'TX-123', raw: { code: '00', data: { transactionId: 'TX-123' } } });
  /* PayOS "00" chỉ là đã NHẬN lệnh; kết quả cuối lấy bằng getPayout — mặc định giả lập đã SUCCEEDED (test từng ca đổi sang processing/failed/unknown). */
  const getPayout = jest.spyOn(payos, 'getPayout').mockResolvedValue({ state: 'succeeded', detail: 'SUCCEEDED' });

  const orders = {
    simulatedOrderCodes: jest.fn(() => Promise.resolve(new Set<string>())),
    /* AUD-01: khoá ĐƠN trước khi khoá payment — ghi vào `calls` để test thứ tự khoá. */
    lockOrder: jest.fn((_orderCode: string, _tx: unknown): Promise<void> => {
      calls.push('order.lock');
      return Promise.resolve();
    }),
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
    extendPaymentDeadline: jest.fn((_orderCode: string, _until: Date, _tx: unknown): Promise<void> => Promise.resolve()),
    markReturnRefunded: jest.fn((_returnRequestId: string, _tx: unknown): Promise<void> => Promise.resolve()),
  };
  const moduleRef = { get: jest.fn((_token: unknown, _options: unknown) => orders) };
  const wallet = { codAvailability: jest.fn(), applyCodCommission: jest.fn((): Promise<void> => Promise.resolve()), applyCodRefund: jest.fn((): Promise<void> => Promise.resolve()) };
  /* Thông báo (PLAN-0022): kế toán = staffUserIdsWithPermission('payment.refund.process'); shop = thành viên active; cả hai chỉ ghi qua NotificationGateway (mock). */
  const notifications: Array<{ cmd: NotifyCommand; tx: unknown }> = [];
  const notifier = {
    notify: jest.fn((cmd: NotifyCommand, tx?: unknown): Promise<void> => {
      notifications.push({ cmd, tx });
      return Promise.resolve();
    }),
    notifyMany: jest.fn((cmds: NotifyCommand[], tx?: unknown): Promise<void> => {
      for (const cmd of cmds) notifications.push({ cmd, tx });
      return Promise.resolve();
    }),
  };
  const users = { staffUserIdsWithPermission: jest.fn((_code: string): Promise<string[]> => Promise.resolve(['acc-1', 'acc-2'])) };
  const shops = { activeMemberUserIds: jest.fn((_shopId: string): Promise<string[]> => Promise.resolve(['shop-user-1'])), findManyBrief: jest.fn((_ids: string[]): Promise<Map<string, { name: string; code: string }>> => Promise.resolve(new Map())) };
  /* Hạn thanh toán PayOS của đơn (setting order.vnpay_timeout_minutes) — mặc định 30 phút như hệ thống thật. */
  const system = { settingNumber: jest.fn((key: string): Promise<number> => Promise.resolve(key === 'refund.auto_max_amount' ? 2_000_000 : 30)) };
  /* PLAN-0041: webhook không thuộc đơn hàng ⇒ không phải khoản nạp cọc (null) — đường đơn hàng của spec này không đổi. */
  const topups = { settleWebhookIfTopup: jest.fn((_code: string, _data: Record<string, unknown>, _paidOk: boolean): Promise<null> => Promise.resolve(null)) };
  const service = new PaymentService(db as unknown as PrismaService, payos, wallet as unknown as ShopWalletService, env, moduleRef as unknown as ModuleRef, notifier, users as unknown as UserDirectoryGateway, shops as unknown as ShopQueryApi, system as unknown as SystemQueryApi, topups as unknown as ShopWalletTopupSettleService);

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
      receivedAmount: D(0),
      linkAttempts: 0,
      lastLinkError: null,
      lastCheckedAt: null,
      lastGatewayStatus: null,
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
      payeeBankBin: null,
      payeeAccountNumber: null,
      payeeAccountName: null,
      payeeSource: null,
      gatewayStatus: null,
      gatewayPayoutId: null,
      gatewayAttempt: 0,
      gatewaySubmittedAt: null,
      gatewayAlertedAt: null,
      needsManual: false,
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
    getPayout,
    notifications,
    notifier,
    users,
    shops,
    wallet,
    system,
    orders,
    txOptions,
    moduleRef,
    service,
    onPaidDepth,
    createLinkDepth,
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

/*
 * PLAN-0022: PayOS payout "00" chỉ là đã NHẬN lệnh ⇒ processRefund trả refund `processing` (gatewayStatus submitted). Helper mô phỏng PayOS báo xong (getPayout mặc định SUCCEEDED) rồi chạy
 * job đối soát `reconcileGatewayRefunds` (cùng đường mà worker chạy mỗi phút) để refund thành `done`; trả refund cuối cùng.
 */
async function processAndSettle(f: Fixture, refundId: string, input: { providerRef?: string; note?: string } = {}, who: AuthenticatedActor = actor): Promise<RefundResponse> {
  await f.service.processRefund(who, refundId, input);
  await f.service.reconcileGatewayRefunds();
  return f.service.getRefund(refundId);
}

/* Tài khoản nhận hoàn do khách khai (COD bắt buộc). Tên có dấu + chữ thường để kiểm tra chuẩn hoá. */
const PAYEE: RefundPayee = { bankBin: '970415', accountNumber: '1122334455', accountName: 'Trần Thị Bé' };

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

      it('[PAY-07] trả thiếu: cộng dồn received_amount, KHÔNG paid; thông tin tài khoản đối ứng được giữ để hoàn về sau', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        await f.service.handlePayos(signed(webhookData({ amount: 100_000 })));
        expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING });
        expect(f.payment(p.id).receivedAmount.toString()).toBe('100000');
        expect(f.payment(p.id).gatewayResponse).toMatchObject({ counterAccountNumber: '0011223344' });
      });

      it('[PAY-07] trả thiếu hai lần cho đến khi đủ ⇒ paid (cộng dồn các khoản khác mã giao dịch), không hoàn gì', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        await f.service.handlePayos(signed(webhookData({ amount: 100_000, reference: 'TF-A' })));
        const r = await f.service.handlePayos(signed(webhookData({ amount: 250_000, reference: 'TF-B' })));

        expect(r.body.message).toBe('Success');
        expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
        expect(f.payment(p.id).receivedAmount.toString()).toBe('350000');
        expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
        expect(f.state.refunds.size).toBe(0);
      });

      it('PayOS gửi LẠI đúng khoản trả thiếu (cùng mã giao dịch) ⇒ không cộng lần hai', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        await f.service.handlePayos(signed(webhookData({ amount: 100_000, reference: 'TF-A' })));
        await f.service.handlePayos(signed(webhookData({ amount: 100_000, reference: 'TF-A' })));

        expect(f.payment(p.id).receivedAmount.toString()).toBe('100000');
        expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(1);
      });

      it('[PAY-07b] trả thiếu rồi payment bị huỷ (đơn hết hạn) ⇒ tự tạo yêu cầu hoàn `mismatch` đúng số đã nhận + báo kế toán; gọi lại không tạo thêm', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        await f.service.handlePayos(signed(webhookData({ amount: 120_000 })));

        await f.db.$transaction((tx) => f.service.cancel(ORDER_CODE, 'Hết hạn thanh toán', tx as unknown as Tx));
        await f.db.$transaction((tx) => f.service.cancel(ORDER_CODE, 'Hết hạn thanh toán', tx as unknown as Tx));

        expect(f.payment(p.id).status).toBe(PAY_STATUS.CANCELLED);
        const refunds = [...f.state.refunds.values()];
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({ kind: REFUND_KIND.MISMATCH, status: REFUND_STATUS.REQUESTED, paymentId: p.id });
        expect(refunds[0].amount.toString()).toBe('120000');
      });

      it.each([
        ['dư 1 đồng', 350_001, '1'],
        ['nhân nhầm 100', 35_000_000, '34650000'],
      ])('[PAY-08] trả thừa (%s): đơn vẫn paid đúng giá trị + tự tạo yêu cầu hoàn `mismatch` phần thừa, không đảo doanh thu', async (_label, amount, excess) => {
        const f = buildFixture();
        const p = f.seedPayos();

        const r = await f.service.handlePayos(signed(webhookData({ amount })));

        expect(r.body.message).toBe('Success');
        expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
        expect(f.payment(p.id).receivedAmount.toString()).toBe(String(amount));
        expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
        const refunds = [...f.state.refunds.values()];
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({ kind: REFUND_KIND.MISMATCH, paymentId: p.id });
        expect(refunds[0].amount.toString()).toBe(excess);
      });

      it('[PAY-08] hoàn xong phần thừa KHÔNG đổi trạng thái thanh toán (vẫn paid) và KHÔNG báo order', async () => {
        const f = buildFixture({ payoutConfigured: true });
        const p = f.seedPayos();
        await f.service.handlePayos(signed(webhookData({ amount: 380_000 })));
        const refund = [...f.state.refunds.values()][0];

        await processAndSettle(f, refund.id);

        expect(f.refund(refund.id).status).toBe(REFUND_STATUS.DONE);
        expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
        expect(f.payment(p.id).refundedAmount.toString()).toBe('30000');
        expect(f.orders.onRefunded).not.toHaveBeenCalled();
      });

      it('[PAY-09] khách trả HAI LẦN cùng một link (hai mã giao dịch khác nhau) ⇒ khoản thứ hai hoàn `duplicate_payment`, đơn không đổi, chỉ một lần onPaid', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        await f.service.handlePayos(signed(webhookData({ reference: 'TF-A' })));
        const r = await f.service.handlePayos(signed(webhookData({ reference: 'TF-B' })));

        expect(r.body.message).toBe('Success');
        expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
        const refunds = [...f.state.refunds.values()];
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({ kind: REFUND_KIND.DUPLICATE_PAYMENT, paymentId: p.id });
        expect(refunds[0].amount.toString()).toBe('350000');
        // webhook thứ hai bị PayOS gửi lại ⇒ không hoàn lần hai
        await f.service.handlePayos(signed(webhookData({ reference: 'TF-B' })));
        expect(f.state.refunds.size).toBe(1);
      });

      it('[PAY-09] return đã ghi paid rồi webhook ĐẦU TIÊN đến ⇒ cùng khoản tiền đó, KHÔNG bị coi là trả trùng', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: 350_000 });
        await f.service.handlePayosReturn(String(PAYOS_CODE));
        expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);

        await f.service.handlePayos(signed(webhookData({ reference: 'TF-A' })));

        expect(f.state.refunds.size).toBe(0);
      });

      // Phát hiện khi kiểm PLAN-0041: khách chuyển HAI lần cho cùng một link; return/poll thấy luỹ kế đủ TRƯỚC khi hai webhook về ⇒ cả hai webhook đều là phần của đơn.
      it('[PAY-09b] return đã ghi paid (luỹ kế đủ) rồi HAI webhook của hai khoản chuyển (tổng = đơn) ⇒ KHÔNG hoàn, received không đổi', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT });
        await f.service.handlePayosReturn(String(PAYOS_CODE));
        expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
        const a1 = 200_000;

        await f.service.handlePayos(signed(webhookData({ reference: 'TF-A1', amount: a1 })));
        await f.service.handlePayos(signed(webhookData({ reference: 'TF-A2', amount: AMOUNT - a1 })));

        expect(f.state.refunds.size).toBe(0);
        expect(f.payment(p.id).receivedAmount.toString()).toBe(String(AMOUNT));
      });

      it('[PAY-09c] return đã ghi paid rồi webhook khoản đúng đơn + webhook khoản THỨ HAI cùng số tiền (khách trả trùng thật) ⇒ hoàn đúng MỘT khoản trùng', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT });
        await f.service.handlePayosReturn(String(PAYOS_CODE));

        await f.service.handlePayos(signed(webhookData({ reference: 'TF-A', amount: AMOUNT })));
        expect(f.state.refunds.size).toBe(0);
        await f.service.handlePayos(signed(webhookData({ reference: 'TF-B', amount: AMOUNT })));

        const refunds = [...f.state.refunds.values()];
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({ kind: REFUND_KIND.DUPLICATE_PAYMENT, paymentId: p.id });
        expect(refunds[0].amount.toString()).toBe(String(AMOUNT));
        expect(f.payment(p.id).receivedAmount.toString()).toBe(String(AMOUNT * 2));
      });

      it('[PAY-09d] trả thiếu (webhook 150k) rồi poll thấy đủ ⇒ paid; webhook phần còn lại về sau và webhook gửi lại ⇒ KHÔNG hoàn', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        await f.service.handlePayos(signed(webhookData({ reference: 'TF-A', amount: 150_000 })));
        expect(f.payment(p.id).status).not.toBe(PAY_STATUS.PAID);
        f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT });
        await f.service.handlePayosReturn(String(PAYOS_CODE));
        expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);

        await f.service.handlePayos(signed(webhookData({ reference: 'TF-A', amount: 150_000 }))); // gửi lại đúng khoản cũ
        await f.service.handlePayos(signed(webhookData({ reference: 'TF-B', amount: AMOUNT - 150_000 })));

        expect(f.state.refunds.size).toBe(0);
        expect(f.payment(p.id).receivedAmount.toString()).toBe(String(AMOUNT));
      });

      it('[PAY-09e] return đã ghi paid; webhook nhỏ rồi webhook lớn vượt đơn ⇒ hoàn đúng PHẦN VƯỢT, không hoàn cả khoản', async () => {
        const f = buildFixture();
        const p = f.seedPayos();
        f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT });
        await f.service.handlePayosReturn(String(PAYOS_CODE));
        const a1 = 100_000;

        await f.service.handlePayos(signed(webhookData({ reference: 'TF-A', amount: a1 }))); // nằm trong luỹ kế đã tính
        await f.service.handlePayos(signed(webhookData({ reference: 'TF-B', amount: AMOUNT }))); // 100k + 350k = 450k > 350k ⇒ vượt 100k

        const refunds = [...f.state.refunds.values()];
        expect(refunds).toHaveLength(1);
        expect(refunds[0].amount.toString()).toBe(String(a1));
        expect(f.payment(p.id).receivedAmount.toString()).toBe(String(AMOUNT + a1));
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
      const readAt = f.calls.indexOf('payment.findUnique', lockAt); // đọc trạng thái SAU khi khoá (lần findUnique trước đó chỉ lấy orderCode để khoá đơn, không khoá payment)
      expect(tx).toBeGreaterThanOrEqual(0);
      expect(lockAt).toBeGreaterThan(tx);
      expect(readAt).toBeGreaterThan(lockAt);
      expect(f.calls.indexOf('payment.update')).toBeGreaterThan(readAt);
    });

    it('AUD-01: khoá ĐƠN trước, PAYMENT sau (cùng thứ tự với khách huỷ đơn: đơn → payment) — nếu đảo, webhook ∥ huỷ deadlock', async () => {
      const f = buildFixture();
      f.seedPayos();

      await f.service.handlePayos(signed(webhookData()));

      expect(f.orders.lockOrder).toHaveBeenCalledTimes(1);
      expect(f.orders.lockOrder.mock.calls[0][0]).toBe(ORDER_CODE);
      const tx = f.calls.indexOf('$transaction');
      const orderLockAt = f.calls.indexOf('order.lock');
      const paymentLockAt = f.calls.indexOf('$queryRaw');
      expect(orderLockAt).toBeGreaterThan(tx);
      expect(paymentLockAt).toBeGreaterThan(orderLockAt);
      expect(f.calls.indexOf('payment.update')).toBeGreaterThan(paymentLockAt);
    });

    it('AUD-01: dính deadlock (40P01) với đường khác ⇒ thử lại cả transaction và vẫn ghi nhận đúng MỘT lần (không trả 500 cho PayOS)', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.orders.lockOrder.mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }));

      const r = await f.service.handlePayos(signed(webhookData()));

      expect(r).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } });
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(1);
      expect(f.calls.filter((c) => c === '$transaction')).toHaveLength(2); // lần 1 bị huỷ (rollback), lần 2 thành công
    });

    it('AUD-01: lỗi KHÔNG phải deadlock thì không thử lại (vẫn 500 để PayOS gửi lại)', async () => {
      const f = buildFixture();
      f.seedPayos();
      f.orders.lockOrder.mockRejectedValueOnce(new Error('DB down'));

      const r = await f.service.handlePayos(signed(webhookData()));

      expect(r.statusCode).toBe(500);
      expect(f.orders.lockOrder).toHaveBeenCalledTimes(1);
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

  describe('confirmPaymentStatus — hỏi lại PayOS trước khi huỷ đơn quá hạn (PLAN-0025)', () => {
    it('đơn không có giao dịch PayOS (COD / chưa tạo link) ⇒ unpaid, không hỏi PayOS', async () => {
      const f = buildFixture();
      expect(await f.service.confirmPaymentStatus(ORDER_CODE)).toBe('unpaid');
      expect(f.getLink).not.toHaveBeenCalled();
    });

    it('payment đã paid ⇒ paid, không hỏi PayOS', async () => {
      const f = buildFixture();
      f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), version: 1 });
      expect(await f.service.confirmPaymentStatus(ORDER_CODE)).toBe('paid');
      expect(f.getLink).not.toHaveBeenCalled();
    });

    it('[PAY-04] pending + PayOS báo PAID đúng số tiền (mất webhook) ⇒ ghi nhận qua đường webhook (paid, onPaid 1 lần) rồi trả paid — đơn KHÔNG bị huỷ oan', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT, amountRemaining: 0 });
      expect(await f.service.confirmPaymentStatus(ORDER_CODE)).toBe('paid');
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
    });

    it('pending + PayOS báo PENDING/EXPIRED/CANCELLED ⇒ unpaid (được huỷ)', async () => {
      for (const status of ['PENDING', 'EXPIRED', 'CANCELLED']) {
        const f = buildFixture();
        f.seedPayos();
        f.getLink.mockResolvedValue({ status });
        expect(await f.service.confirmPaymentStatus(ORDER_CODE)).toBe('unpaid');
        expect(f.orders.onPaid).not.toHaveBeenCalled();
      }
    });

    it('[PAY-13] PayOS lỗi / không trả trạng thái ⇒ unknown (KHÔNG coi là chưa trả), không ghi gì', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue({});
      expect(await f.service.confirmPaymentStatus(ORDER_CODE)).toBe('unknown');
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PENDING);
    });

    it('PAID nhưng SỐ TIỀN lệch ⇒ không ghi paid (unpaid) — tiền lệch xử lý ở luồng riêng', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: AMOUNT - 1000 });
      expect(await f.service.confirmPaymentStatus(ORDER_CODE)).toBe('unpaid');
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PENDING);
    });
  });

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
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK).map((t) => t.status)).toEqual(['ok', 'seen']); // webhook đến sau chỉ ghi nhận mã khoản (để về sau phân biệt khoản trùng), KHÔNG cộng tiền
      expect(f.payment(p.id).receivedAmount.toString()).toBe(String(AMOUNT));
      // gatewayResponse cuối có đủ counterAccount*
      expect(f.payment(p.id).gatewayResponse).toMatchObject({ counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A', orderCode: PAYOS_CODE });
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, version: versionAfterReturn }); // bổ sung dữ liệu, không đổi trạng thái/version

      // ⇒ processRefund tự động (payout) chạy được thay vì MANUAL_REQUIRED
      const refund = f.seedRefund(f.payment(p.id));
      const res = await processAndSettle(f, refund.id);
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
      ['lệch số tiền (thiếu)', { status: 'PAID', amountPaid: 100_000 }, '100000'],
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

    it('[PAY-08] PayOS báo PAID với số tiền DƯ ⇒ success (đơn paid đúng giá trị) + tự tạo yêu cầu hoàn phần thừa', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: 350_001 });

      const r = await f.service.handlePayosReturn(String(PAYOS_CODE));

      expect(r).toMatchObject({ success: true, status: 'PAID' });
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
      expect([...f.state.refunds.values()].map((x) => [x.kind, x.amount.toString()])).toEqual([[REFUND_KIND.MISMATCH, '1']]);
    });

    it('[PAY-04b] hỏi lại PayOS nhiều lần mà không có tiền mới ⇒ im lặng: không tạo thêm giao dịch / thông báo', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: 100_000 });
      await f.service.handlePayosReturn(String(PAYOS_CODE));
      const notified = f.notifications.length;
      await f.service.handlePayosReturn(String(PAYOS_CODE));
      await f.service.handlePayosReturn(String(PAYOS_CODE));

      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(1);
      expect(f.notifications.length).toBe(notified);
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

    it('[CK-15] initiate PayOS CHỈ tạo payment pending (hạn theo setting) — KHÔNG gọi PayOS / mạng trong transaction đặt hàng, paymentUrl null', async () => {
      const f = buildFixture();

      const r = await f.initiateInTx(initiateInput());

      const expiresAt = new Date(NOW + THIRTY_MIN);
      expect(r).toEqual({ paymentId: expect.any(String) as string, status: 'unpaid', paymentUrl: null, qrCode: null, expiresAt });
      const p = f.payment(r.paymentId);
      expect(p).toMatchObject({ orderId: 'order-1', orderCode: ORDER_CODE, userId: USER, methodCode: METHOD.PAYOS, status: PAY_STATUS.PENDING, expiresAt, transferContent: null, createdBy: USER });
      expect(p.amount.toString()).toBe('350000');
      expect(f.createLink).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(f.txnsOf(p.id)).toHaveLength(0);
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.INITIATED)).toMatchObject({ entityId: p.id, entityCode: ORDER_CODE, afterSummary: { method: METHOD.PAYOS, amount: '350000' } });
    });

    it('hạn link PayOS lấy từ setting order.vnpay_timeout_minutes (không còn hằng 30 phút)', async () => {
      const f = buildFixture();
      f.system.settingNumber.mockResolvedValue(45);

      const r = await f.initiateInTx(initiateInput());

      expect(r.expiresAt).toEqual(new Date(NOW + 45 * 60_000));
    });

    it('createCheckoutLinks (SAU commit) ⇒ gọi PayOS, ghi create_url với rawRequest.checkoutUrl, đếm link_attempts, trả paymentUrl + qrCode', async () => {
      const f = buildFixture();
      const r = await f.initiateInTx(initiateInput());

      const out = await f.service.createCheckoutLinks([ORDER_CODE]);

      const expiresAt = new Date(NOW + THIRTY_MIN);
      expect(out.get(ORDER_CODE)).toEqual({ paymentUrl: LINK_URL, qrCode: QR, expiresAt });
      expect(f.createLink).toHaveBeenCalledTimes(1);
      const arg = f.createLink.mock.calls[0][0];
      expect(Number.isSafeInteger(arg.orderCode)).toBe(true);
      expect(arg.orderCode).toBeGreaterThanOrEqual(NOW * 1000);
      expect(arg.orderCode).toBeLessThanOrEqual(NOW * 1000 + 999);
      expect(arg).toMatchObject({ amount: 350_000n, description: ORDER_CODE, returnUrl: 'https://shop.fitly.test/checkout/payos-return', cancelUrl: 'https://shop.fitly.test/checkout/payos-return', expiresAt });
      const [txn] = f.txnsOf(r.paymentId, TX_TYPE.CREATE_URL);
      expect(f.txnsOf(r.paymentId)).toHaveLength(1);
      expect(txn).toMatchObject({ status: 'ok', amount: '350000', providerRef: String(arg.orderCode), rawRequest: { payosOrderCode: arg.orderCode, checkoutUrl: LINK_URL, paymentLinkId: 'plink-1' } });
      expect(f.payment(r.paymentId)).toMatchObject({ linkAttempts: 1, lastLinkError: null });
    });

    it('createCheckoutLinks IDEMPOTENT: đơn đã có link ⇒ trả link cũ, không gọi PayOS lần hai', async () => {
      const f = buildFixture();
      await f.initiateInTx(initiateInput());
      await f.service.createCheckoutLinks([ORDER_CODE]);

      const again = await f.service.createCheckoutLinks([ORDER_CODE, ORDER_CODE]);

      expect(f.createLink).toHaveBeenCalledTimes(1);
      expect(again.get(ORDER_CODE)).toMatchObject({ paymentUrl: LINK_URL });
    });

    it('link vừa tạo nhận được webhook trả tiền: orderCode PayOS lưu ở create_url dẫn đúng tới payment', async () => {
      const f = buildFixture();
      const r = await f.initiateInTx(initiateInput());
      await f.service.createCheckoutLinks([ORDER_CODE]);
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

      await f.service.createCheckoutLinks([ORDER_CODE]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API_URL}/v2/payment-requests`);
      expect(init.headers).toMatchObject({ 'x-client-id': CLIENT_ID, 'x-api-key': API_KEY });
      const sent = JSON.parse(init.body as string) as { orderCode: number; amount: number; description: string; signature: string };
      expect(sent).toMatchObject({ amount: 350000, description: ORDER_CODE });
      expect(f.txnsOf(r.paymentId, TX_TYPE.CREATE_URL)[0].providerRef).toBe(String(sent.orderCode));
      expect(sent.signature).toBe(hmac(`amount=350000&cancelUrl=https://shop.fitly.test/checkout/payos-return&description=${ORDER_CODE}&orderCode=${sent.orderCode}&returnUrl=https://shop.fitly.test/checkout/payos-return`));
    });

    it('[CK-15] PayOS không tạo được link (checkoutUrl null) ⇒ KHÔNG ném: payment vẫn pending + last_link_error + link_attempts, đơn không rollback; extras báo linkRetryable', async () => {
      const f = buildFixture();
      f.createLink.mockResolvedValue({ checkoutUrl: null, qrCode: null, paymentLinkId: null });
      const r = await f.initiateInTx(initiateInput());

      const out = await f.service.createCheckoutLinks([ORDER_CODE]);

      expect(out.get(ORDER_CODE)).toMatchObject({ error: expect.any(String) as string });
      expect(f.payment(r.paymentId)).toMatchObject({ status: PAY_STATUS.PENDING, linkAttempts: 1 });
      expect(f.payment(r.paymentId).lastLinkError).toEqual(expect.any(String));
      expect(f.txnsOf(r.paymentId, TX_TYPE.CREATE_URL)).toHaveLength(0);
      f.payment(r.paymentId).expiresAt = new Date('2099-01-01T00:00:00.000Z'); // hạn thật tính theo đồng hồ thật
      expect(await f.service.extrasForOrder(ORDER_CODE)).toMatchObject({ paymentUrl: null, linkRetryable: true });
    });

    it.each([
      ['PayOS trả mã lỗi INVALID_REQUEST_BODY', () => Promise.resolve(new Response(JSON.stringify({ code: 'INVALID_REQUEST_BODY', desc: 'bad' }), { status: 200 }))],
      ['PayOS trả mã 00 nhưng thiếu checkoutUrl', () => Promise.resolve(new Response(JSON.stringify({ code: '00', data: {} }), { status: 200 }))],
      ['timeout', () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))],
      ['lỗi mạng', () => Promise.reject(new Error('ECONNREFUSED'))],
    ])('[CK-15] qua HTTP thật: %s ⇒ createCheckoutLinks trả {error}, payment pending (đơn vẫn có), thử lại được', async (_label, makeResponse) => {
      const f = buildFixture();
      f.createLink.mockRestore();
      fetchMock.mockImplementationOnce(() => makeResponse());
      const r = await f.initiateInTx(initiateInput());

      const out = await f.service.createCheckoutLinks([ORDER_CODE]);

      expect(out.get(ORDER_CODE)).toHaveProperty('error');
      expect(f.payment(r.paymentId)).toMatchObject({ status: PAY_STATUS.PENDING, linkAttempts: 1 });
      expect(f.txnsOf(r.paymentId, TX_TYPE.CREATE_URL)).toHaveLength(0);
    });

    it('[CK-16] nhiều đơn con: gọi PayOS SONG SONG nhưng không quá 3 yêu cầu cùng lúc', async () => {
      const f = buildFixture();
      for (let i = 0; i < 7; i += 1) f.seedPayment({ orderCode: `FT-P${i}`, methodCode: METHOD.PAYOS, status: PAY_STATUS.PENDING });
      let running = 0;
      let peak = 0;
      f.createLink.mockImplementation(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { checkoutUrl: LINK_URL, qrCode: QR, paymentLinkId: 'plink-x' };
      });

      const out = await f.service.createCheckoutLinks(Array.from({ length: 7 }, (_v, i) => `FT-P${i}`));

      expect(out.size).toBe(7);
      expect(f.createLink).toHaveBeenCalledTimes(7);
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThan(1);
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

    it('cấu hình bị mất giữa chừng (sau khi tạo payment) ⇒ createCheckoutLinks báo {error} PAYOS_NOT_CONFIGURED, payment giữ pending', async () => {
      const f = buildFixture();
      const r = await f.initiateInTx(initiateInput());
      jest.spyOn(f.payos, 'isConfigured', 'get').mockReturnValue(false);

      const out = await f.service.createCheckoutLinks([ORDER_CODE]);

      expect(out.get(ORDER_CODE)).toHaveProperty('error');
      expect(f.createLink).not.toHaveBeenCalled();
      expect(f.payment(r.paymentId).status).toBe(PAY_STATUS.PENDING);
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

    it('PayOS không tạo được link ⇒ ném ServiceUnavailable; payment mới giữ pending + last_link_error (KHÔNG mồ côi), lần bấm sau DÙNG LẠI payment đó', async () => {
      const f = buildFixture();
      const old = f.seedPayos();
      f.createLink.mockResolvedValueOnce({ checkoutUrl: null, qrCode: null, paymentLinkId: null });

      const err = await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE));

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(f.payment(old.id).status).toBe(PAY_STATUS.CANCELLED);
      expect(f.state.payments.size).toBe(2);
      const fresh = [...f.state.payments.values()].find((x) => x.id !== old.id);
      expect(fresh).toMatchObject({ status: PAY_STATUS.PENDING, linkAttempts: 1 });
      expect(fresh?.lastLinkError).toEqual(expect.any(String));
      expect(f.txnsOf(fresh!.id, TX_TYPE.CREATE_URL)).toHaveLength(0);

      const again = await f.service.retryPayos(actor_of(USER), ORDER_CODE);
      expect(again.paymentUrl).toBe(LINK_URL);
      expect(f.state.payments.size).toBe(2); // dùng lại payment chưa có link, không sinh thêm
      expect(f.txnsOf(fresh!.id, TX_TYPE.CREATE_URL)).toHaveLength(1);
      expect(f.payment(fresh!.id).lastLinkError).toBeNull();
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

    it('[CK-16] retry gọi PayOS NGOÀI transaction (không giữ khoá DB trong lúc chờ HTTP)', async () => {
      const f = buildFixture();
      f.seedPayos();
      await f.service.retryPayos(actor_of(USER), ORDER_CODE);
      expect(f.createLinkDepth).toEqual([0]);
    });

    it('[PAY-10b] retry GIA HẠN hạn thanh toán của đơn (qua cổng order) trong cùng transaction khoá đơn', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      const f = buildFixture();
      f.seedPayos();
      await f.service.retryPayos(actor_of(USER), ORDER_CODE);
      expect(f.orders.extendPaymentDeadline).toHaveBeenCalledWith(ORDER_CODE, new Date(NOW + THIRTY_MIN), expect.anything());
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

      it('tạo link mới thất bại ⇒ KHÔNG huỷ link cũ (khách vẫn trả được bằng link đang có)', async () => {
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

  // ------------------------------------------------------------------ Tầng 1.4–1.6 (PLAN-0040): hỏi PayOS định kỳ · tự chi hoàn nhỏ · hoàn tay khi lệnh chi không rõ

  describe('reconcilePendingPayos — hỏi PayOS khi mất webhook (PAY-04b)', () => {
    const minutes = (m: number): Date => new Date(Date.now() + m * 60_000);

    it('[PAY-04b] link pending sắp hết hạn, PayOS báo PAID ⇒ ghi nhận paid đúng đường webhook (nguồn poll), lưu last_checked_at + last_gateway_status; lần sau chưa hỏi lại', async () => {
      const f = buildFixture();
      const p = f.seedPayos({ expiresAt: minutes(1) });
      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: 350_000 });

      const r = await f.service.reconcilePendingPayos();

      expect(r).toEqual({ checked: 1, paid: 1, mismatch: 0 });
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID, lastGatewayStatus: 'PAID' });
      expect(f.payment(p.id).lastCheckedAt).toBeInstanceOf(Date);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.PAID)).toMatchObject({ afterSummary: expect.objectContaining({ source: 'poll' }) as unknown });
      expect(await f.service.reconcilePendingPayos()).toEqual({ checked: 0, paid: 0, mismatch: 0 });
    });

    it('PayOS báo còn PENDING / EXPIRED ⇒ chỉ ghi last_gateway_status, payment giữ nguyên (job huỷ đơn xử lý hết hạn)', async () => {
      const f = buildFixture();
      const p = f.seedPayos({ expiresAt: minutes(1) });
      f.getLink.mockResolvedValue({ status: 'EXPIRED' });

      const r = await f.service.reconcilePendingPayos();

      expect(r).toMatchObject({ checked: 1, paid: 0 });
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING, lastGatewayStatus: 'EXPIRED' });
      expect(f.orders.onPaid).not.toHaveBeenCalled();
    });

    it('payment còn xa hạn và mới tạo (< 10 phút) ⇒ KHÔNG hỏi PayOS', async () => {
      const f = buildFixture();
      f.seedPayos({ expiresAt: minutes(25), createdAt: new Date() });

      const r = await f.service.reconcilePendingPayos();

      expect(r.checked).toBe(0);
      expect(f.getLink).not.toHaveBeenCalled();
    });

    it('PayOS lỗi mạng ⇒ nuốt lỗi, không làm hỏng job, payment giữ pending', async () => {
      const f = buildFixture();
      const p = f.seedPayos({ expiresAt: minutes(1) });
      f.getLink.mockRejectedValue(new Error('ECONNRESET'));

      await expect(f.service.reconcilePendingPayos()).resolves.toMatchObject({ checked: 1, paid: 0 });
      expect(f.payment(p.id).status).toBe(PAY_STATUS.PENDING);
    });

    it('PayOS chưa cấu hình ⇒ không làm gì', async () => {
      const f = buildFixture({ payosConfigured: false });
      f.seedPayos({ expiresAt: minutes(1) });
      expect(await f.service.reconcilePendingPayos()).toEqual({ checked: 0, paid: 0, mismatch: 0 });
    });
  });

  describe('autoProcessRefunds — tự chi hoàn nhỏ (REF-01, REF-02)', () => {
    const ACCOUNT_BANK = { counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A' };
    function setupAuto(o: { amount?: number; payoutConfigured?: boolean; max?: number; gatewayResponse?: unknown } = {}) {
      const f = buildFixture({ payoutConfigured: o.payoutConfigured ?? true });
      if (o.max !== undefined) f.system.settingNumber.mockImplementation((key: string) => Promise.resolve(key === 'refund.auto_max_amount' ? (o.max as number) : 30));
      const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date('2026-10-03T09:30:00.000Z'), transactionCode: String(PAYOS_CODE), gatewayResponse: o.gatewayResponse === undefined ? webhookData(ACCOUNT_BANK) : o.gatewayResponse, version: 1 });
      const refund = f.seedRefund(payment, { amount: D(o.amount ?? 100_000) });
      return { f, refund };
    }

    it('[REF-01] khoản ≤ mức tự chi, có tài khoản đã trả ⇒ gửi lệnh PayOS bằng tác nhân HỆ THỐNG (refund processing, đã nhận lệnh)', async () => {
      const { f, refund } = setupAuto();

      const r = await f.service.autoProcessRefunds();

      expect(r).toEqual({ submitted: 1, skipped: 0, failed: 0 });
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.payout).toHaveBeenCalledWith(expect.objectContaining({ referenceId: refund.id, amount: 100_000n, toBin: '970436', toAccountNumber: '0011223344' }));
      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, processedBy: '00000000-0000-0000-0000-000000000000' });
    });

    it('[REF-02] khoản VƯỢT mức tự chi ⇒ KHÔNG tự chi (chờ kế toán)', async () => {
      const { f, refund } = setupAuto({ amount: 3_000_000 });

      expect(await f.service.autoProcessRefunds()).toEqual({ submitted: 0, skipped: 0, failed: 0 });
      expect(f.payout).not.toHaveBeenCalled();
      expect(f.refund(refund.id).status).toBe(REFUND_STATUS.REQUESTED);
    });

    it('refund.auto_max_amount = 0 ⇒ tắt tự chi', async () => {
      const { f } = setupAuto({ max: 0 });
      expect(await f.service.autoProcessRefunds()).toEqual({ submitted: 0, skipped: 0, failed: 0 });
      expect(f.payout).not.toHaveBeenCalled();
    });

    it('payout chưa cấu hình ⇒ không tự chi', async () => {
      const { f } = setupAuto({ payoutConfigured: false });
      expect(await f.service.autoProcessRefunds()).toEqual({ submitted: 0, skipped: 0, failed: 0 });
    });

    it('không xác định được tài khoản nhận ⇒ bỏ qua (kế toán chuyển tay)', async () => {
      const { f, refund } = setupAuto({ gatewayResponse: null });
      const r = await f.service.autoProcessRefunds();
      expect(r.submitted).toBe(0);
      expect(f.payout).not.toHaveBeenCalled();
      expect(f.refund(refund.id).status).toBe(REFUND_STATUS.REQUESTED);
    });

    it('PayOS từ chối chắc chắn ⇒ refund failed + báo kế toán, job không ném và KHÔNG tự thử lại ở lần chạy sau', async () => {
      const { f, refund } = setupAuto();
      f.payout.mockResolvedValue({ ok: false, code: '231', message: 'Sai tài khoản', raw: { code: '231' } });

      const r = await f.service.autoProcessRefunds();
      expect(r).toEqual({ submitted: 0, skipped: 0, failed: 1 });
      expect(f.refund(refund.id).status).toBe(REFUND_STATUS.FAILED);

      f.payout.mockClear();
      await f.service.autoProcessRefunds();
      expect(f.payout).not.toHaveBeenCalled();
    });

    it('[REF-02] khoản mới vượt mức tự chi ⇒ báo kế toán MỘT lần ngay lúc tạo yêu cầu', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const p = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), transactionCode: String(PAYOS_CODE), gatewayResponse: webhookData(ACCOUNT_BANK), version: 1, amount: D(5_000_000), receivedAmount: D(5_000_000) });

      await f.db.$transaction((tx) => f.service.requestRefund({ orderCode: p.orderCode, shopId: null, amount: 3_000_000n, reason: 'Huỷ đơn', returnRequestId: null, actorUserId: null }, tx as unknown as Tx));

      const titles = f.notifications.map((n) => n.cmd.title);
      expect(titles.filter((t) => t.startsWith('Khoản hoàn mới cần xử lý'))).toHaveLength(2); // 2 kế toán (acc-1, acc-2) — mỗi người một thông báo
    });
  });

  describe('AUD-14 — hoàn tay khi lệnh chi PayOS KHÔNG RÕ kết quả', () => {
    const ACCOUNT_BANK = { counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A' };
    function setupUnknown() {
      const f = buildFixture({ payoutConfigured: true });
      const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date('2026-10-03T09:30:00.000Z'), transactionCode: String(PAYOS_CODE), gatewayResponse: webhookData(ACCOUNT_BANK), version: 1 });
      const refund = f.seedRefund(payment, { status: REFUND_STATUS.FAILED, gatewayAttemptedAt: new Date(), gatewayAttempt: 1 });
      return { f, refund };
    }

    it('[REF-04b] PayOS ĐÃ nhận lệnh (tra theo referenceId) ⇒ 409 PAYMENT_REFUND_RECONCILE_REQUIRED, refund giữ nguyên failed, không ghi sổ tay', async () => {
      const { f, refund } = setupUnknown();
      const find = jest.spyOn(f.payos, 'findPayoutByReference').mockResolvedValue({ state: 'found', id: 'po-1', result: { state: 'processing', detail: 'x' } });

      const err = await thrown(f.service.processRefund(actor, refund.id, { providerRef: 'FT-TAY-0001' }));

      expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_RECONCILE_REQUIRED, httpStatus: 409 });
      expect(find).toHaveBeenCalledWith(refund.id);
      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, providerRef: null });
    });

    it('[REF-04b2] PayOS KHÔNG có lệnh nào theo referenceId ⇒ cho ghi sổ tay', async () => {
      const { f, refund } = setupUnknown();
      jest.spyOn(f.payos, 'findPayoutByReference').mockResolvedValue({ state: 'not_found' });

      await f.service.processRefund(actor, refund.id, { providerRef: 'FT-TAY-0002' });

      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'FT-TAY-0002' });
      expect(f.payout).not.toHaveBeenCalled();
    });

    it('không tra được PayOS ⇒ 409; kèm confirmGatewayNotExecuted=true thì ghi sổ', async () => {
      const { f, refund } = setupUnknown();
      jest.spyOn(f.payos, 'findPayoutByReference').mockResolvedValue({ state: 'unknown', detail: 'timeout' });

      const blocked = await thrown(f.service.processRefund(actor, refund.id, { providerRef: 'FT-TAY-0003' }));
      expect(blocked).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_RECONCILE_REQUIRED });
      expect(f.refund(refund.id).status).toBe(REFUND_STATUS.FAILED);

      await f.service.processRefund(actor, refund.id, { providerRef: 'FT-TAY-0003', confirmGatewayNotExecuted: true });
      expect(f.refund(refund.id).status).toBe(REFUND_STATUS.DONE);
    });

    it('PayOS đã TỪ CHỐI chắc chắn (gatewayStatus failed) ⇒ không cần tra: ghi sổ tay như cũ', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date(), transactionCode: String(PAYOS_CODE), gatewayResponse: webhookData(ACCOUNT_BANK), version: 1 });
      const refund = f.seedRefund(payment, { status: REFUND_STATUS.FAILED, gatewayStatus: GATEWAY_STATUS.FAILED, gatewayAttempt: 1 });
      const find = jest.spyOn(f.payos, 'findPayoutByReference');

      await f.service.processRefund(actor, refund.id, { providerRef: 'FT-TAY-0004' });

      expect(find).not.toHaveBeenCalled();
      expect(f.refund(refund.id).status).toBe(REFUND_STATUS.DONE);
    });
  });

  describe('extrasForOrder — PayOS', () => {
    it('đơn pending chưa hết hạn ⇒ trả lại checkoutUrl đã lưu để khách mở lại link', async () => {
      const f = buildFixture();
      f.seedPayos();
      expect(await f.service.extrasForOrder(ORDER_CODE)).toEqual({ paymentUrl: LINK_URL, linkRetryable: false, transactionCode: null, cardBrand: null, cardLast4: null });
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
      expect(await f.service.extrasForOrder('FT0000000000')).toEqual({ paymentUrl: null, linkRetryable: false, transactionCode: null, cardBrand: null, cardLast4: null });
    });
  });

  // ------------------------------------------------------------------ yêu cầu hoàn tiền

  describe('requestRefund (dùng cho hoàn đơn đổi trả và hoàn khoản trả trùng)', () => {
    const REQ = { orderCode: ORDER_CODE, shopId: null, reason: 'Khách đổi ý', returnRequestId: null, actorUserId: 'staff-1' };
    const request = (f: Fixture, amount: bigint, o: { paymentId?: string; payee?: RefundPayee | null; shopId?: string | null; returnRequestId?: string | null } = {}) => f.db.$transaction((tx) => f.service.requestRefund({ ...REQ, amount, ...o }, tx as unknown as Tx));
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
      [METHOD.COD, 'gateway'], // PLAN-0022: COD có tài khoản khách khai ⇒ chi qua PayOS payout như PayOS
      ['bank_transfer', 'manual_transfer'], // dữ liệu lịch sử
      ['vnpay', 'manual_transfer'], // dữ liệu lịch sử: không còn cổng ⇒ hoàn tay
      [METHOD.PAYOS, 'gateway'],
    ])('payment %s ⇒ refund method %s', async (methodCode, method) => {
      const f = buildFixture();
      f.seedPayment(paid({ methodCode }));
      const { refundId } = await request(f, 50_000n, { payee: PAYEE });
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

      const res = await processAndSettle(f, refund.id);

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

      // Chỉ mục thật uq_payments_order_live ⇒ đơn chỉ có MỘT payment `paid`: khoản link CŨ lên paid (huỷ payment chờ của link mới trước), khoản link MỚI không lên paid mà bị hoàn trùng (giữ nguyên trạng thái).
      expect([...f.state.payments.values()].map((p) => p.status)).toEqual([PAY_STATUS.PAID, PAY_STATUS.CANCELLED]);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(f.state.outbox.filter((e) => e.eventType === PAYMENT_EVENT.PAID)).toHaveLength(1);
      expect(f.state.refunds.size).toBe(1);
      const [refund] = [...f.state.refunds.values()];
      expect(refund).toMatchObject({ kind: REFUND_KIND.DUPLICATE_PAYMENT, status: REFUND_STATUS.REQUESTED });
      expect(refund.amount.toString()).toBe('350000');
      expect(f.txnsOf(refund.paymentId, TX_TYPE.CREATE_URL)[0].providerRef).toBe(String(newCode)); // hoàn gắn đúng payment của link MỚI
      expect(f.payment(refund.paymentId).receivedAmount.toString()).toBe('350000');
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
        await processAndSettle(f, refund.id);

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
        await f.service.reconcileGatewayRefunds(); // PayOS đã nhận lệnh ⇒ job đối soát chốt xong

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
        await f.service.reconcileGatewayRefunds();
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
      });

      it('HAI refund một phần của CÙNG payment xử lý song song ⇒ refundedAmount cộng dồn đúng 150.000 (không mất cập nhật)', async () => {
        const { f, payment } = setup({ refund: { id: REFUND_ID, amount: D(100_000) } });
        f.seedRefund(payment, { id: REFUND_ID_2, amount: D(50_000) });
        f.payout.mockImplementation((input) => Promise.resolve({ ok: true, code: '00', message: 'ok', transactionId: `TX-${input.referenceId.slice(0, 8)}`, raw: {} })); // mã lệnh chi duy nhất mỗi refund
        await Promise.all([f.service.processRefund(actor, REFUND_ID, {}), f.service.processRefund(actor, REFUND_ID_2, {})]); // cả hai đã được PayOS nhận lệnh
        f.syncTransactions(2); // ép hai transaction ghi sổ cùng tới cửa

        await Promise.all([f.service.processRefund(actor, REFUND_ID, {}), f.service.processRefund(actor, REFUND_ID_2, {})]); // bấm lại ⇒ tra PayOS (succeeded) ⇒ ghi sổ song song

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
        f.payout.mockImplementation((input) => Promise.resolve({ ok: true, code: '00', message: 'ok', transactionId: `TX-${input.referenceId.slice(0, 8)}`, raw: {} }));
        await Promise.all([f.service.processRefund(actor, REFUND_ID, {}), f.service.processRefund(actor, REFUND_ID_2, {})]);
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
        const res = await processAndSettle(f, refund.id, { providerRef: 'FT-IGNORED' });
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(res.providerRef).toBe('payos-refund:TX-123');
      });
    });

    describe('payout thành công', () => {
      it('PayOS NHẬN lệnh (00) ⇒ refund VẪN processing (gatewayStatus submitted), chưa ghi sổ; job đối soát thấy SUCCEEDED ⇒ done, providerRef "payos-refund:<payoutId>", onRefunded + outbox đủ trường', async () => {
        const { f, payment, refund } = setup();

        const submitted = await f.service.processRefund(actor, refund.id, { note: 'Đã kiểm tra' });

        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.payout).toHaveBeenCalledWith({ referenceId: REFUND_ID, amount: 100_000n, toBin: '970436', toAccountNumber: '0011223344', description: `Hoan tien don ${ORDER_CODE}`, idempotencyKey: REFUND_ID });
        // chưa xong: mới NHẬN lệnh
        expect(submitted).toMatchObject({ id: REFUND_ID, status: REFUND_STATUS.PROCESSING, method: 'gateway', providerRef: null, gatewayStatus: GATEWAY_STATUS.SUBMITTED, note: 'Đã kiểm tra', needsManual: false });
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: null, gatewayPayoutId: 'TX-123', gatewayAttempt: 1, payeeSource: PAYEE_SOURCE.PAYER, processedBy: actor.userId, version: 1 });
        expect(f.refund(refund.id).gatewaySubmittedAt).toBeInstanceOf(Date);
        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
        expect(f.orders.onRefunded).not.toHaveBeenCalled();
        expect(f.state.outbox).toHaveLength(0);
        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(0);
        expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_GATEWAY_SUBMITTED)).toMatchObject({ entityId: REFUND_ID, afterSummary: { payoutId: 'TX-123', attempt: 1, reference: REFUND_ID, payeeSource: 'payer' } });

        const job = await f.service.reconcileGatewayRefunds();

        expect(job).toEqual({ checked: 1, finalized: 1, failed: 0, pending: 0 });
        expect(f.getPayout).toHaveBeenCalledWith('TX-123');
        const res = await f.service.getRefund(refund.id);
        expect(res).toMatchObject({ id: REFUND_ID, orderCode: ORDER_CODE, status: REFUND_STATUS.DONE, method: 'gateway', providerRef: 'payos-refund:TX-123', gatewayStatus: GATEWAY_STATUS.SUCCEEDED, note: 'Đã kiểm tra', needsManual: false });
        expect(res.amount.amount).toBe('100000');
        expect(res.processedAt).not.toBeNull();
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-123', processedBy: actor.userId, version: 2 });

        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PARTIALLY_REFUNDED, version: 2 });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');

        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(1);
        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)[0]).toMatchObject({ status: 'ok', providerRef: 'payos-refund:TX-123', rawResponse: { payoutId: 'TX-123', state: 'succeeded', detail: 'SUCCEEDED' } });

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
        expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_PROCESSED)).toMatchObject({ entityId: REFUND_ID, actorUserId: null, afterSummary: { amount: '100000', method: 'gateway', providerRef: 'payos-refund:TX-123', via: 'poll', payoutId: 'TX-123', initiatedBy: actor.userId } });
      });

      it('refund của một shop ⇒ outbox mang shopId (để ví COD đảo hoa hồng)', async () => {
        const { f, refund } = setup({ refund: { shopId: 'shop-1' } });
        await processAndSettle(f, refund.id);
        expect(f.state.outbox[0].payload).toMatchObject({ shopId: 'shop-1', methodCode: METHOD.PAYOS });
      });

      it('PayOS nhận lệnh nhưng KHÔNG trả mã lệnh chi (không tra cứu được) ⇒ KHÔNG đoán là xong: giữ processing, báo kế toán MỘT lần, cần người xem; không chi lại', async () => {
        const { f, payment, refund } = setup();
        f.payout.mockResolvedValue({ ok: true, code: '00', message: 'ok', raw: { code: '00' } });

        const submitted = await f.service.processRefund(actor, refund.id, {});
        await f.service.reconcileGatewayRefunds();
        await f.service.reconcileGatewayRefunds();

        expect(submitted).toMatchObject({ status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.SUBMITTED, providerRef: null });
        expect(f.getPayout).not.toHaveBeenCalled(); // không có mã để tra
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, gatewayPayoutId: null, providerRef: null, needsManual: true });
        expect(f.refund(refund.id).gatewayAlertedAt).toBeInstanceOf(Date);
        expect((await f.service.getRefund(refund.id)).needsManual).toBe(true);
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('0');
        expect(f.orders.onRefunded).not.toHaveBeenCalled();
        expect(f.notifications.filter((n) => n.cmd.title.includes('treo bất thường')).map((n) => n.cmd.userId)).toEqual(['acc-1', 'acc-2']); // đúng MỘT lần dù job chạy hai lần
        expect(f.payout).toHaveBeenCalledTimes(1);
      });

      it('hoàn toàn bộ số tiền ⇒ payment REFUNDED + cờ hoàn đủ = true; hoàn nốt phần còn lại sau lần một phần cũng ⇒ REFUNDED', async () => {
        const full = setup({ refund: { amount: D(350_000) } });
        await processAndSettle(full.f, REFUND_ID);
        expect(full.f.payment(full.payment.id)).toMatchObject({ status: PAY_STATUS.REFUNDED });
        expect(full.f.payment(full.payment.id).refundedAmount.toString()).toBe('350000');
        expect(full.f.orders.onRefunded.mock.calls[0][4]).toBe(true);

        const rest = setup({ payment: { refundedAmount: D(100_000), status: PAY_STATUS.PARTIALLY_REFUNDED }, refund: { amount: D(250_000) } });
        await processAndSettle(rest.f, REFUND_ID);
        expect(rest.f.payment(rest.payment.id)).toMatchObject({ status: PAY_STATUS.REFUNDED });
        expect(rest.f.payment(rest.payment.id).refundedAmount.toString()).toBe('350000');
        expect(rest.f.orders.onRefunded.mock.calls[0][4]).toBe(true);
      });

      it('refund gắn yêu cầu đổi trả ⇒ báo markReturnRefunded đúng 1 lần', async () => {
        const { f, refund } = setup({ refund: { returnRequestId: 'return-1' } });
        await processAndSettle(f, refund.id);
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
        // kế toán (mọi người có quyền hoàn tiền) được báo — trong CÙNG transaction với việc đánh failed
        expect(f.users.staffUserIdsWithPermission).toHaveBeenCalledWith('payment.refund.process');
        expect(f.notifications.map((n) => [n.cmd.userId, n.cmd.title])).toEqual([
          ['acc-1', `Hoàn tiền đơn ${ORDER_CODE} thất bại`],
          ['acc-2', `Hoàn tiền đơn ${ORDER_CODE} thất bại`],
        ]);
        expect(f.notifications[0].cmd).toMatchObject({ type: 'payment', link: '/payment/refunds', payload: { refundId: REFUND_ID, orderCode: ORDER_CODE } });
        expect(f.notifications[0].tx).toBeDefined();
        expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_FAILED)).toMatchObject({ entityId: REFUND_ID });
      });

      it('refund failed xử lý lại được: payout gọi lại với CÙNG idempotencyKey/referenceId (không chi đôi), xong ⇒ done', async () => {
        const { f, refund } = setup();
        f.payout.mockResolvedValueOnce({ ok: false, code: '99', message: 'timeout', raw: null });

        await thrown(f.service.processRefund(actor, refund.id, {}));
        expect(f.refund(refund.id).status).toBe(REFUND_STATUS.FAILED);
        const res = await processAndSettle(f, refund.id);

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

        await processAndSettle(f, refund.id);

        const locks = f.queryRawCalls.filter((c) => /FOR UPDATE/i.test(c.sql));
        expect(locks).toHaveLength(1);
        expect(locks[0].values).toEqual([refund.paymentId]);
        const lockAt = f.calls.indexOf('$queryRaw');
        expect(f.calls.lastIndexOf('order.lock', lockAt)).toBeGreaterThanOrEqual(0); // AUD-01: khoá ĐƠN trước khi khoá payment
        expect(f.calls.lastIndexOf('order.lock', lockAt)).toBeLessThan(lockAt);
        const tx = f.calls.lastIndexOf('$transaction', lockAt); // transaction ghi sổ = transaction gần nhất mở TRƯỚC câu khoá
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

      it('PayOS đã xác nhận SUCCEEDED nhưng ghi sổ lỗi ⇒ transaction ghi sổ hoàn tác (payment/sổ/outbox không đổi), refund GIỮ processing + providerRef để chỉ ghi sổ lại (không chi đôi)', async () => {
        const { f, payment, refund } = setup();
        f.orders.onRefunded.mockRejectedValueOnce(new Error('order down'));
        await f.service.processRefund(actor, refund.id, {});

        const job = await f.service.reconcileGatewayRefunds(); // job nuốt lỗi từng refund (log), không ném

        expect(job).toEqual({ checked: 1, finalized: 0, failed: 0, pending: 0 });
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: 'payos-refund:TX-123', gatewayStatus: GATEWAY_STATUS.SUCCEEDED }); // tiền đã đi: dấu vết còn, KHÔNG về requested
        expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('0');
        expect(f.state.outbox).toHaveLength(0);
        expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(0);
        expect(f.payout).toHaveBeenCalledTimes(1);

        // lượt job sau: chỉ ghi sổ nốt, KHÔNG tra PayOS lần nữa và KHÔNG gửi lệnh mới
        f.getPayout.mockClear();
        expect(await f.service.reconcileGatewayRefunds()).toEqual({ checked: 1, finalized: 1, failed: 0, pending: 0 });
        expect(f.getPayout).not.toHaveBeenCalled();
        expect(f.refund(refund.id).status).toBe(REFUND_STATUS.DONE);
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

      const res = await processAndSettle(f, refund.id);

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
      expect(auditsOf(f, PAYMENT_AUDIT.REFUND_PROCESSED)[0]).toMatchObject({ actorUserId: null, entityId: refund.id, afterSummary: { kind: REFUND_KIND.DUPLICATE_PAYMENT, amount: '350000', providerRef: 'payos-refund:TX-123', via: 'poll', initiatedBy: actor.userId } });
      // khoản trùng không có "đơn" để order báo khách ⇒ payment gửi thông báo cho KHÁCH (không báo shop: không thuộc shop nào)
      expect(f.notifications.map((n) => [n.cmd.userId, n.cmd.title])).toEqual([[USER, `Đã hoàn khoản thanh toán trùng đơn ${ORDER_CODE}`]]);
    });

    it('gọi lại KHÔNG hoàn thêm: process lần hai = INVALID_STATE, webhook trùng lặp không tạo yêu cầu/chi tiền mới, đơn vẫn paid', async () => {
      const { f, order, second, refund } = await payTwice();
      await processAndSettle(f, refund.id);

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

      await processAndSettle(f, must(refundId, 'refundId'));

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

      await f.service.processRefund(actor, refund.id, {});
      await f.service.reconcileGatewayRefunds(); // PayOS báo xong nhưng ghi sổ lỗi (job nuốt + log)
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
    /* PayOS đã xác nhận SUCCEEDED (providerRef đã ghi) nhưng bước ghi sổ lỗi: refund kẹt `processing` có providerRef. Lỗi ghi sổ xảy ra ở job đối soát (nuốt + log). */
    async function stuckAfterGatewayPaid(o: Parameters<typeof setup>[0] = {}) {
      const s = setup(o);
      s.f.failNth('payment.update', 1, new Error('db chết'));
      await s.f.service.processRefund(actor, s.refund.id, {});
      await s.f.service.reconcileGatewayRefunds();
      return { ...s, err: (errorSpy.mock.calls as unknown[][]).map((c) => (c[0] as { err?: unknown }).err)[0] };
    }

    describe('cổng ĐÃ chi + ghi sổ lỗi', () => {
      it('refund GIỮ processing + providerRef (không nhả về requested); payment / sổ / outbox không đổi; cổng chỉ bị gọi 1 lần', async () => {
        const { f, payment, refund, err } = await stuckAfterGatewayPaid();

        expect((err as Error).message).toBe('db chết'); // job log đúng lỗi ghi sổ
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

        await s.f.service.processRefund(actor, s.refund.id, {});
        await s.f.service.reconcileGatewayRefunds();
        const retry = await thrown(s.f.service.retryFinalizeRefund(actor, s.refund.id));

        expect((errorSpy.mock.calls as unknown[][])[0][0]).toMatchObject({ err: expect.objectContaining({ errorCode: PAYMENT_ERR.REFUND_EXCEEDS }) as unknown });
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

    describe('PayOS nhận lệnh nhưng GHI dấu "đã nhận lệnh" lỗi (DB chết đúng lúc đó)', () => {
      it('refund VẪN processing (KHÔNG nhả về requested để ai đó bấm gọi lại ngay); quá hạn mới chiếm lại và gửi lại với CÙNG idempotency-key', async () => {
        const { f, refund } = setup();
        f.failNth('refund.updateMany', 2, new Error('db chết')); // #1 chiếm, #2 ghi dấu đã nhận lệnh

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect((err as Error).message).toBe('db chết');
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: null });
        expect(f.payout).toHaveBeenCalledTimes(1);
        // chưa quá hạn: không cho gọi lại
        expect(await thrown(f.service.processRefund(actor, refund.id, {}))).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE });
        expect(f.payout).toHaveBeenCalledTimes(1);

        f.refund(refund.id).updatedAt = minutesAgo(11);
        const res = await processAndSettle(f, refund.id);

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

        const res = await processAndSettle(f, refund.id);

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
        await f.service.reconcileGatewayRefunds();

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

/* ================================================================ PLAN-0040 Tầng 2b ================================================================ */

describe('PLAN-0040 Tầng 2b — vá sót về tiền (AUD-18 … AUD-22)', () => {
  const realFetch = globalThis.fetch;
  const ACCOUNT_BANK = { counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A' };
  const PAID_AT = new Date('2026-10-03T09:30:00.000Z');

  beforeEach(() => {
    globalThis.fetch = jest.fn((): Promise<Response> => Promise.reject(new Error('fetch chưa được stub — không được gọi mạng thật')));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const cancelOrder = (f: Fixture) => f.db.$transaction((tx) => f.service.cancel(ORDER_CODE, 'Khách huỷ đơn', tx as unknown as Tx));
  /* Webhook một khoản `amount` mang mã khoản `reference` vào link `code` (mặc định link của payment seedPayos). */
  const pay = (f: Fixture, amount: number, reference: string, code: number = PAYOS_CODE) => f.service.handlePayos(signed(webhookData({ amount, reference }, code)));
  const refundsOf = (f: Fixture, paymentId: string): RefundRow[] => [...f.state.refunds.values()].filter((r) => r.paymentId === paymentId);
  /* Bất biến tiền: Σ hoàn không `failed` của payment. */
  const refundSum = (rs: RefundRow[]): number => rs.filter((r) => r.status !== REFUND_STATUS.FAILED).reduce((s, r) => s + Number(r.amount.toString()), 0);

  // ------------------------------------------------------------------ AUD-18 / AUD-19
  describe('AUD-18 / AUD-19 — tiền đến MUỘN trên payment đã huỷ (không kẹt tiền, webhook luôn 200)', () => {
    it('[MNY-02b/02c] trả thiếu 100k → đơn huỷ (hoàn mismatch 100k) → khách chuyển NỐT phần còn lại ⇒ webhook 200 (không PAYMENT_REFUND_EXCEEDS), payment giữ cancelled, hoàn đúng phần mới, Σ hoàn = Σ đã nhận', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      await pay(f, 100_000, 'TF-A');
      await cancelOrder(f);
      expect(refundsOf(f, p.id).map((r) => r.amount.toString())).toEqual(['100000']);

      const late = await pay(f, 250_000, 'TF-B');

      expect(late.statusCode).toBe(200);
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.CANCELLED });
      expect(f.payment(p.id).receivedAmount.toString()).toBe('350000'); // tiền đã về PayOS ĐƯỢC GHI — không bị rollback như trước
      const rs = refundsOf(f, p.id);
      expect(rs.map((r) => [r.kind, r.amount.toString(), r.status])).toEqual([
        [REFUND_KIND.MISMATCH, '100000', REFUND_STATUS.REQUESTED],
        [REFUND_KIND.MISMATCH, '250000', REFUND_STATUS.REQUESTED],
      ]);
      expect(refundSum(rs)).toBe(350_000);
      expect(f.orders.onPaid).not.toHaveBeenCalled(); // KHÔNG đẩy payment sang paid trái thiết kế
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK).map((t) => t.status)).toEqual(['mismatch', 'late']);
    });

    it('hoàn cả hai khoản xong: refundedAmount = received, KHÔNG vướng trần hoàn (REFUND_EXCEEDS) khi ghi sổ', async () => {
      const f = buildFixture();
      let n = 0;
      f.payout.mockImplementation(() => Promise.resolve({ ok: true, code: '00', message: 'ok', transactionId: `TX-${++n}`, raw: { code: '00' } })); // mỗi lệnh chi một mã giao dịch riêng (providerRef là UNIQUE)
      const p = f.seedPayos();
      await pay(f, 100_000, 'TF-A');
      await cancelOrder(f);
      await pay(f, 250_000, 'TF-B');

      for (const r of refundsOf(f, p.id)) expect((await processAndSettle(f, r.id)).status).toBe(REFUND_STATUS.DONE);

      expect(f.payment(p.id).refundedAmount.toString()).toBe('350000');
      expect(f.payment(p.id).status).toBe(PAY_STATUS.CANCELLED);
      expect(f.orders.onRefunded).not.toHaveBeenCalled(); // hoàn mismatch không đụng đơn
    });

    it('[MNY-08] đơn đã huỷ + đã có hoàn 100k, khách chuyển thêm 50k (vẫn chưa đủ) ⇒ webhook 200 và bù hoàn đúng 50k (Σ hoàn = Σ nhận = 150k)', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      await pay(f, 100_000, 'TF-A');
      await cancelOrder(f);

      const late = await pay(f, 50_000, 'TF-B');

      expect(late.statusCode).toBe(200);
      expect(f.payment(p.id).receivedAmount.toString()).toBe('150000');
      expect(refundsOf(f, p.id).map((r) => r.amount.toString())).toEqual(['100000', '50000']);
      expect(refundSum(refundsOf(f, p.id))).toBe(150_000);
    });

    it('[MNY-09] đơn huỷ TRƯỚC khi có tiền (payment cancelled, received 0), khách chuyển 100k vào link cũ ⇒ 200, hoàn 100k về TK người trả; kế toán + khách được báo ĐÚNG sự thật', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      await cancelOrder(f);
      expect(f.state.refunds.size).toBe(0);

      const late = await pay(f, 100_000, 'TF-A');

      expect(late.statusCode).toBe(200);
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.CANCELLED });
      expect(f.payment(p.id).receivedAmount.toString()).toBe('100000');
      const [refund] = refundsOf(f, p.id);
      expect(refund).toMatchObject({ kind: REFUND_KIND.MISMATCH, status: REFUND_STATUS.REQUESTED, method: 'gateway', needsManual: false, shopId: null });
      expect(refund.amount.toString()).toBe('100000');
      // kế toán: nói rõ yêu cầu hoàn ĐÃ được tạo (không còn câu "tiền sẽ được hoàn" khi thực tế không có yêu cầu nào)
      const acct = f.notifications.filter((n) => n.cmd.userId === 'acc-1' && n.cmd.title.startsWith('Tiền về muộn'));
      expect(acct).toHaveLength(1);
      expect(acct[0].cmd.content).toContain('Yêu cầu hoàn');
      expect(acct[0].cmd.payload).toMatchObject({ reason: 'late_payment', refundId: refund.id });
      expect(f.notifications.filter((n) => n.cmd.userId === USER && n.cmd.title.includes('sẽ được hoàn'))).toHaveLength(1);
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.FAILED && (a.afterSummary as { reason?: string } | null)?.reason === 'late_payment')).toBeDefined();
    });

    it('idempotent: PayOS gửi LẠI đúng khoản đến muộn (cùng mã khoản) ⇒ không cộng, không hoàn thêm, không thông báo thêm', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      await cancelOrder(f);
      await pay(f, 100_000, 'TF-A');
      const notified = f.notifications.length;

      const again = await pay(f, 100_000, 'TF-A');

      expect(again.statusCode).toBe(200);
      expect(f.payment(p.id).receivedAmount.toString()).toBe('100000');
      expect(refundsOf(f, p.id)).toHaveLength(1);
      expect(f.notifications).toHaveLength(notified);
    });

    it('trang return / poll hỏi lại mà PayOS vẫn báo cùng số luỹ kế ⇒ im lặng (không tạo giao dịch, không hoàn thêm); số luỹ kế TĂNG ⇒ chỉ bù phần tăng', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      await cancelOrder(f);
      await pay(f, 100_000, 'TF-A');
      const txns = f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK).length;

      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: 100_000 });
      const r = await f.service.handlePayosReturn(String(PAYOS_CODE));
      expect(r).toMatchObject({ success: false, status: 'MISMATCH' }); // payment không lên paid
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(txns);
      expect(refundsOf(f, p.id)).toHaveLength(1);

      f.getLink.mockResolvedValue({ status: 'PAID', amountPaid: 130_000 });
      await f.service.handlePayosReturn(String(PAYOS_CODE));
      expect(f.payment(p.id).receivedAmount.toString()).toBe('130000');
      expect(refundsOf(f, p.id).map((x) => x.amount.toString())).toEqual(['100000', '30000']);
    });

    it('yêu cầu hoàn cũ ở trạng thái `failed` VẪN được tính là đã phủ (kế toán chạy lại được) ⇒ tiền về thêm chỉ bù phần chênh, không chi hai lần cùng một khoản', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      await pay(f, 100_000, 'TF-A');
      await cancelOrder(f);
      const [first] = refundsOf(f, p.id);
      f.refund(first.id).status = REFUND_STATUS.FAILED;

      await pay(f, 50_000, 'TF-B');

      expect(refundsOf(f, p.id).map((r) => [r.amount.toString(), r.status])).toEqual([
        ['100000', REFUND_STATUS.FAILED],
        ['50000', REFUND_STATUS.REQUESTED],
      ]);
    });

    it('cancel() chạy lại sau khi tiền về muộn đã được bù ⇒ không tạo thêm yêu cầu (idempotent theo số dư, không theo "đã có yêu cầu thì thôi")', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      await pay(f, 100_000, 'TF-A');
      await cancelOrder(f);
      await pay(f, 50_000, 'TF-B');
      f.payment(p.id).status = PAY_STATUS.PENDING; // ép cancel() chạy lại trên payment đã được bù đủ

      await cancelOrder(f);

      expect(refundsOf(f, p.id).map((r) => r.amount.toString())).toEqual(['100000', '50000']);
    });

    it('khoản ĐẦU TIÊN đã đủ giá trị đơn sau khi đơn huỷ ⇒ GIỮ hành vi cũ (PAY-06b/CONC-02/CONC-08): payment paid + onPaid một lần, không hoàn mismatch ở tầng payment', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      await cancelOrder(f);

      const late = await pay(f, AMOUNT, 'TF-A');

      expect(late.statusCode).toBe(200);
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID });
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1); // order (đã huỷ) tự tạo yêu cầu hoàn đủ ở onPaid
      expect(f.state.refunds.size).toBe(0);
    });

    it('khoản ĐẦU TIÊN dư so với đơn sau khi huỷ ⇒ paid + onPaid, phần thừa hoàn `mismatch` như cũ', async () => {
      const f = buildFixture();
      const p = f.seedPayos();
      await cancelOrder(f);

      await pay(f, AMOUNT + 20_000, 'TF-A');

      expect(f.payment(p.id).status).toBe(PAY_STATUS.PAID);
      expect(refundsOf(f, p.id).map((r) => [r.kind, r.amount.toString()])).toEqual([[REFUND_KIND.MISMATCH, '20000']]);
    });

    it('đơn đã được trả bằng payment KHÁC (paid): payment cũ (cancelled) nhận tiền ⇒ KHÔNG lên paid (chỉ mục uq_payments_order_live), hoàn kiểu `duplicate_payment` đúng số nhận — kể cả khoản thiếu', async () => {
      const f = buildFixture();
      f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, receivedAmount: D(AMOUNT), transactionCode: '1790000000000001', version: 1 }, 1790000000000001);
      const old = f.seedPayos({ status: PAY_STATUS.CANCELLED });

      const r = await pay(f, 100_000, 'TF-A');

      expect(r.statusCode).toBe(200);
      expect(f.payment(old.id).status).toBe(PAY_STATUS.CANCELLED);
      expect(refundsOf(f, old.id).map((x) => [x.kind, x.amount.toString()])).toEqual([[REFUND_KIND.DUPLICATE_PAYMENT, '100000']]);
      expect(f.orders.onPaid).not.toHaveBeenCalled();
    });

    it('link CŨ trả ĐỦ khi link MỚI đang chờ ⇒ payment chờ bị huỷ TRƯỚC khi payment cũ lên paid (nếu không UPDATE vi phạm chỉ mục "một payment sống/đơn" ⇒ webhook 500 mãi); phần link mới đã nhận được hoàn', async () => {
      const f = buildFixture();
      const old = f.seedPayos({ status: PAY_STATUS.CANCELLED });
      const fresh = f.seedPayos({}, 1790000000000002);
      await pay(f, 30_000, 'TF-N', 1790000000000002); // khách lỡ chuyển 30k vào link mới (thiếu)

      const r = await pay(f, AMOUNT, 'TF-O'); // rồi trả đủ ở link cũ

      expect(r.statusCode).toBe(200);
      expect(f.payment(old.id).status).toBe(PAY_STATUS.PAID);
      expect(f.payment(fresh.id).status).toBe(PAY_STATUS.CANCELLED);
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
      expect(refundsOf(f, fresh.id).map((x) => [x.kind, x.amount.toString()])).toEqual([[REFUND_KIND.MISMATCH, '30000']]);
    });
  });

  // ------------------------------------------------------------------ AUD-20
  describe('AUD-20 — tự chi hoàn KHÔNG áp dụng cho payment COD', () => {
    const COD_PAYEE = { payeeBankBin: '970415', payeeAccountNumber: '1122334455', payeeAccountName: 'TRAN THI BE', payeeSource: 'customer' };
    function seedCod(f: Fixture, refundId: string) {
      const payment = f.seedPayment({ methodCode: METHOD.COD, status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, orderCode: 'FT2610030009' });
      return f.seedRefund(payment, { id: refundId, amount: D(100_000), ...COD_PAYEE });
    }
    function seedPayosRefund(f: Fixture, refundId: string) {
      const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, transactionCode: String(PAYOS_CODE), gatewayResponse: webhookData(ACCOUNT_BANK), version: 1 });
      return f.seedRefund(payment, { id: refundId, amount: D(100_000) });
    }

    it('[AUD-20] refund của payment COD đủ mọi điều kiện khác (gateway, có TK khách khai, ≤ ngưỡng) ⇒ job KHÔNG gửi lệnh PayOS, refund giữ `requested` cho kế toán', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const cod = seedCod(f, REFUND_ID_2);

      expect(await f.service.autoProcessRefunds()).toEqual({ submitted: 0, skipped: 0, failed: 0 });

      expect(f.payout).not.toHaveBeenCalled();
      expect(f.refund(cod.id).status).toBe(REFUND_STATUS.REQUESTED);
    });

    it('refund PayOS vẫn tự chi bình thường (ngoại lệ chỉ cho COD)', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const payos = seedPayosRefund(f, REFUND_ID);

      expect(await f.service.autoProcessRefunds()).toEqual({ submitted: 1, skipped: 0, failed: 0 });

      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.payout).toHaveBeenCalledWith(expect.objectContaining({ referenceId: payos.id, amount: 100_000n }));
    });

    it('khoản COD cũ nhất KHÔNG chiếm hết lô: lọc trong truy vấn nên khoản PayOS phía sau vẫn được tự chi (limit = 1)', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const cod = seedCod(f, REFUND_ID_2); // tạo trước ⇒ cũ hơn
      const payos = seedPayosRefund(f, REFUND_ID);

      expect(await f.service.autoProcessRefunds(1)).toEqual({ submitted: 1, skipped: 0, failed: 0 });

      expect(f.refund(payos.id).status).toBe(REFUND_STATUS.PROCESSING);
      expect(f.refund(cod.id).status).toBe(REFUND_STATUS.REQUESTED);
    });

    it('kế toán vẫn DUYỆT TAY được refund COD (processRefund không bị chặn): lệnh PayOS chỉ đi khi kế toán bấm, không phải do job', async () => {
      const f = buildFixture({ payoutConfigured: true });
      const cod = seedCod(f, REFUND_ID_2);

      const res = await f.service.processRefund(actor, cod.id, {});

      expect(res.status).toBe(REFUND_STATUS.PROCESSING);
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.refund(cod.id).processedBy).toBe(actor.userId);
    });
  });

  // ------------------------------------------------------------------ AUD-21
  describe('AUD-21 — webhook THIẾU mã khoản (reference + transactionDateTime)', () => {
    const bare = (amount: number): Record<string, unknown> => signed(webhookData({ amount, reference: undefined, transactionDateTime: undefined }));

    it('[MNY-03a] gửi lại cùng payload (cùng số tiền, không mã khoản) ⇒ coi là replay: KHÔNG cộng dồn, đơn chưa paid, chỉ một giao dịch', async () => {
      const f = buildFixture();
      const p = f.seedPayos();

      const a = await f.service.handlePayos(bare(175_000));
      const b = await f.service.handlePayos(bare(175_000));

      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PENDING });
      expect(f.payment(p.id).receivedAmount.toString()).toBe('175000');
      expect(f.txnsOf(p.id, TX_TYPE.PAYOS_WEBHOOK)).toHaveLength(1);
      expect(f.orders.onPaid).not.toHaveBeenCalled();
    });

    it('ca hợp lệ "trả thiếu rồi trả phần còn lại" (KHÁC số tiền) không bị chặn dù thiếu mã khoản ⇒ cộng dồn tới đủ thì paid', async () => {
      const f = buildFixture();
      const p = f.seedPayos();

      await f.service.handlePayos(bare(100_000));
      await f.service.handlePayos(bare(250_000));

      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID });
      expect(f.payment(p.id).receivedAmount.toString()).toBe('350000');
      expect(f.orders.onPaid).toHaveBeenCalledTimes(1);
    });

    it('có mã khoản khác nhau + cùng số tiền vẫn là HAI khoản (hành vi cũ không đổi — PayOS thật luôn kèm mã)', async () => {
      const f = buildFixture();
      const p = f.seedPayos();

      await pay(f, 175_000, 'TF-A');
      await pay(f, 175_000, 'TF-B');

      expect(f.payment(p.id)).toMatchObject({ status: PAY_STATUS.PAID });
      expect(f.payment(p.id).receivedAmount.toString()).toBe('350000');
    });
  });

  // ------------------------------------------------------------------ AUD-22
  describe('AUD-22 — bấm "Thanh toán lại" hai lần đồng thời', () => {
    const OTHER_LINK = 'https://pay.payos.vn/web/from-other-click';

    it('lần bấm đồng thời kia đã huỷ payment cũ + tạo payment chờ (đã có link) trước khi ta giữ được khoá đơn ⇒ trả link ĐÓ (200), không tạo payment/link thứ hai', async () => {
      const f = buildFixture();
      const old = f.seedPayos();
      f.orders.extendPaymentDeadline.mockImplementationOnce(() => {
        f.payment(old.id).status = PAY_STATUS.CANCELLED; // mô phỏng lần bấm kia commit trong lúc ta chờ khoá đơn
        f.seedPayos({}, 1790000000000002, OTHER_LINK);
        return Promise.resolve();
      });

      const r = await f.service.retryPayos(actor_of(USER), ORDER_CODE);

      expect(r).toEqual({ paymentUrl: OTHER_LINK });
      expect(f.createLink).not.toHaveBeenCalled();
      expect(f.state.payments.size).toBe(2);
      expect([...f.state.payments.values()].filter((x) => x.status === PAY_STATUS.PENDING)).toHaveLength(1);
    });

    it('payment chờ do lần bấm kia tạo CHƯA có link ⇒ tạo link cho đúng payment đó (vẫn một payment chờ), 200', async () => {
      const f = buildFixture();
      const old = f.seedPayos();
      let waitingId = '';
      f.orders.extendPaymentDeadline.mockImplementationOnce(() => {
        f.payment(old.id).status = PAY_STATUS.CANCELLED;
        waitingId = f.seedPayment({ methodCode: METHOD.PAYOS }).id;
        return Promise.resolve();
      });

      const r = await f.service.retryPayos(actor_of(USER), ORDER_CODE);

      expect(r.paymentUrl).toBe(LINK_URL);
      expect(f.createLink).toHaveBeenCalledTimes(1);
      expect(f.state.payments.size).toBe(2);
      expect(f.txnsOf(waitingId, TX_TYPE.CREATE_URL)).toHaveLength(1);
      expect([...f.state.payments.values()].filter((x) => x.status === PAY_STATUS.PENDING).map((x) => x.id)).toEqual([waitingId]);
    });

    it('lần bấm kia đã trả xong (payment mới paid) trước khi ta khoá được đơn ⇒ ALREADY_PAID, không tạo payment/link', async () => {
      const f = buildFixture();
      const old = f.seedPayos();
      f.orders.extendPaymentDeadline.mockImplementationOnce(() => {
        f.payment(old.id).status = PAY_STATUS.CANCELLED;
        f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT }, 1790000000000002);
        return Promise.resolve();
      });

      expect(await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE))).toMatchObject({ errorCode: PAYMENT_ERR.ALREADY_PAID });
      expect(f.createLink).not.toHaveBeenCalled();
      expect(f.state.payments.size).toBe(2);
    });

    it('chốt cuối: tạo payment đụng chỉ mục "một payment sống/đơn" (P2002) ⇒ KHÔNG 409 COMMON_DUPLICATE — transaction hoàn tác sạch và trả link của payment đang chờ', async () => {
      const f = buildFixture();
      const stray = f.seedPayos({}, 1790000000000002); // payment chờ "lạc" (tạo bởi đường không khoá đơn) — hiện có từ trước
      const last = f.seedPayos({}, 1790000000000003, OTHER_LINK); // payment cuối cùng, đã có link

      const r = await f.service.retryPayos(actor_of(USER), ORDER_CODE);

      expect(r).toEqual({ paymentUrl: OTHER_LINK });
      expect(f.payment(last.id).status).toBe(PAY_STATUS.PENDING); // việc huỷ dở dang đã hoàn tác
      expect(f.payment(stray.id).status).toBe(PAY_STATUS.PENDING);
      expect(f.state.payments.size).toBe(2);
      expect(f.createLink).not.toHaveBeenCalled();
    });

    it('lỗi KHÔNG phải trùng chỉ mục thì giữ nguyên (không nuốt)', async () => {
      const f = buildFixture();
      f.seedPayos();
      f.orders.extendPaymentDeadline.mockRejectedValueOnce(new Error('DB down'));

      expect(await thrown(f.service.retryPayos(actor_of(USER), ORDER_CODE))).toMatchObject({ message: 'DB down' });
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
    listRefunds: jest.fn((_page: number, _size: number, _filters: object): Promise<unknown> => Promise.resolve({ content: [], page: 1, size: 20, totalElements: 0 })),
  };
  const controller = new AdminPaymentController(stub as unknown as PaymentService);
  beforeEach(() => {
    stub.processRefund.mockClear();
    stub.retryFinalizeRefund.mockClear();
    stub.listRefunds.mockClear();
    stub.processRefund.mockResolvedValue(refundResponse);
  });

  it.each([
    ['done', 'Đã hoàn tiền'],
    ['processing', 'Đã gửi lệnh hoàn tiền sang PayOS — đang chờ ngân hàng xác nhận'], // PayOS "00" chỉ là đã nhận lệnh ≠ xong
    ['failed', 'PayOS báo lệnh hoàn tiền thất bại — kiểm tra ghi chú, có thể chạy lại hoặc chuyển khoản tay'],
  ])('POST admin/refunds/:id/process: refund %s ⇒ thông điệp phản ánh ĐÚNG trạng thái (không cứ "Đã hoàn tiền")', async (status, message) => {
    stub.processRefund.mockResolvedValue({ id: REFUND_ID, status });
    const res = await controller.process(actor, REFUND_ID, {});
    expect(res).toMatchObject({ success: true, message, data: { id: REFUND_ID, status } });
  });

  describe('GET admin/refunds + validate query', () => {
    const [ListQuery] = Reflect.getMetadata('design:paramtypes', AdminPaymentController.prototype, 'refunds') as Array<new () => { page: number; size: number }>;
    const errorsFor = (query: Record<string, unknown>) => validate(plainToInstance(ListQuery, query));

    it('chuyển status / shopId / needsManual xuống service; cần quyền payment.payment.read', async () => {
      const shopId = '9b2e5c1a-7d3f-4e8a-b6c4-1a2b3c4d5e6f';
      const query = plainToInstance(ListQuery, { status: 'requested', shopId, needsManual: 'true' });
      await controller.refunds(query as never);
      expect(stub.listRefunds).toHaveBeenCalledWith(1, 20, { status: 'requested', shopId, needsManual: true });
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handlerOf(AdminPaymentController, 'refunds')) as unknown).toEqual(['payment.payment.read']);
    });

    it('needsManual nhận "true"/"false" (query string) và từ chối giá trị lạ; status chỉ 4 trạng thái', async () => {
      expect(await errorsFor({ needsManual: 'true' })).toHaveLength(0);
      expect(await errorsFor({ needsManual: 'false' })).toHaveLength(0);
      expect(await errorsFor({})).toHaveLength(0);
      expect(await errorsFor({ needsManual: 'maybe' })).not.toHaveLength(0);
      expect(await errorsFor({ status: 'processing' })).toHaveLength(0);
      expect(await errorsFor({ status: 'done-ish' })).not.toHaveLength(0);
      expect(plainToInstance(ListQuery, { needsManual: 'true' })).toMatchObject({ needsManual: true });
    });
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

    it('providerRef (PLAN-0022): ≥ 4 ký tự, chỉ chữ-số và . _ : / # -, bắt đầu bằng chữ/số', async () => {
      for (const ok of ['FT26102600001', 'abcd', '2026/10/26-0001', 'MBVCB.1:2_3#4']) expect(await errorsFor({ providerRef: ok })).toHaveLength(0);
      for (const bad of ['abc', 'FT 123', 'FT123?', '-FT123', 'Mã giao dịch']) expect(await errorsFor({ providerRef: bad })).not.toHaveLength(0);
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

/* ================================================================ PLAN-0022 ================================================================ */

describe('PLAN-0022 — hoàn tiền đúng trách nhiệm (BE-Payment)', () => {
  const realFetch = globalThis.fetch;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const ACCOUNT = { counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A' };
  const CUSTOMER_COLUMNS = { payeeBankBin: '970415', payeeAccountNumber: '1122334455', payeeAccountName: 'TRAN THI BE', payeeSource: 'customer' };
  const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);
  const PAID_AT = new Date('2026-10-03T09:30:00.000Z');

  beforeEach(() => {
    const fetchStub = jest.fn((): Promise<Response> => Promise.reject(new Error('fetch chưa được stub — không được gọi mạng thật')));
    globalThis.fetch = fetchStub;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  /* payment PayOS đã trả 350.000 (có tài khoản đối ứng từ webhook) + yêu cầu hoàn 100.000 chờ xử lý. */
  function setup(o: { fixture?: Fixture; payoutConfigured?: boolean; payment?: Partial<PaymentRow>; refund?: Partial<RefundRow> } = {}) {
    const f = o.fixture ?? buildFixture({ payoutConfigured: o.payoutConfigured });
    const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, transactionCode: String(PAYOS_CODE), gatewayResponse: webhookData(ACCOUNT), version: 1, ...o.payment });
    const refund = f.seedRefund(payment, o.refund);
    return { f, payment, refund };
  }
  const titlesTo = (f: Fixture, userId: string): string[] => f.notifications.filter((n) => n.cmd.userId === userId).map((n) => n.cmd.title);

  // ------------------------------------------------------------------ PayOS chốt THẬT
  describe('PayOS "00" chỉ là đã NHẬN lệnh — refund chỉ done khi PayOS báo thành công thật', () => {
    it('getPayout báo đang xử lý ⇒ refund VẪN processing (gatewayStatus processing): không ghi sổ, không báo order, không outbox, không giao dịch — qua nhiều lượt job', async () => {
      const { f, payment, refund } = setup();
      f.getPayout.mockResolvedValue({ state: 'processing', detail: 'PROCESSING' });

      const submitted = await f.service.processRefund(actor, refund.id, {});
      for (let i = 0; i < 3; i += 1) expect(await f.service.reconcileGatewayRefunds()).toEqual({ checked: 1, finalized: 0, failed: 0, pending: 1 });

      expect(submitted).toMatchObject({ status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.SUBMITTED });
      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.PROCESSING, providerRef: null, needsManual: false, gatewayAlertedAt: null, version: 1 });
      expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
      expect(f.payment(payment.id).refundedAmount.toString()).toBe('0');
      expect(f.orders.onRefunded).not.toHaveBeenCalled();
      expect(f.orders.markReturnRefunded).not.toHaveBeenCalled();
      expect(f.state.outbox).toHaveLength(0);
      expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(0);
      expect(f.notifications).toHaveLength(0);
      expect(f.payout).toHaveBeenCalledTimes(1);
    });

    it('getPayout không tra được (unknown) ⇒ giữ nguyên submitted, không ghi sổ, không chi lại', async () => {
      const { f, refund } = setup();
      f.getPayout.mockResolvedValue({ state: 'unknown', detail: 'Không gọi được cổng PayOS' });
      await f.service.processRefund(actor, refund.id, {});

      expect(await f.service.reconcileGatewayRefunds()).toEqual({ checked: 1, finalized: 0, failed: 0, pending: 1 });

      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.SUBMITTED, providerRef: null });
      expect(f.orders.onRefunded).not.toHaveBeenCalled();
      expect(f.payout).toHaveBeenCalledTimes(1);
    });

    it('SUCCEEDED ⇒ done ĐÚNG MỘT LẦN: job chạy hai lượt liên tiếp hoặc hai worker chạy ĐỒNG THỜI đều không ghi sổ / báo order / outbox / thông báo shop hai lần', async () => {
      const { f, payment, refund } = setup({ refund: { shopId: 'shop-1' } });
      await f.service.processRefund(actor, refund.id, {});
      f.syncTransactions(2); // hai worker cùng tới cửa ghi sổ

      await Promise.all([f.service.reconcileGatewayRefunds(), f.service.reconcileGatewayRefunds()]);
      expect(await f.service.reconcileGatewayRefunds()).toEqual({ checked: 0, finalized: 0, failed: 0, pending: 0 });

      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-123', gatewayStatus: GATEWAY_STATUS.SUCCEEDED, version: 2 });
      expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
      expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(1);
      expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
      expect(f.state.outbox.filter((e) => e.eventType === PAYMENT_EVENT.REFUNDED)).toHaveLength(1);
      expect(titlesTo(f, 'shop-user-1')).toHaveLength(1);
      expect(f.payout).toHaveBeenCalledTimes(1);
    });

    it('FAILED ⇒ refund failed (kế toán chạy lại được): giao dịch lỗi, KHÔNG ghi sổ, báo kế toán MỘT lần; job lượt sau không xử lý lại', async () => {
      const { f, payment, refund } = setup();
      f.getPayout.mockResolvedValue({ state: 'failed', detail: 'state=FAILED' });
      await f.service.processRefund(actor, refund.id, {});

      expect(await f.service.reconcileGatewayRefunds()).toEqual({ checked: 1, finalized: 0, failed: 1, pending: 0 });
      expect(await f.service.reconcileGatewayRefunds()).toEqual({ checked: 0, finalized: 0, failed: 0, pending: 0 });

      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, gatewayStatus: GATEWAY_STATUS.FAILED, providerRef: null, note: 'PayOS: state=FAILED', processedBy: actor.userId, version: 2 });
      expect(f.refund(refund.id).processedAt).toBeInstanceOf(Date);
      expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toEqual([expect.objectContaining({ status: 'failed', rawResponse: { payoutId: 'TX-123', state: 'failed', detail: 'state=FAILED' } })]);
      expect(f.payment(payment.id)).toMatchObject({ status: PAY_STATUS.PAID, version: 1 });
      expect(f.orders.onRefunded).not.toHaveBeenCalled();
      expect(f.state.outbox).toHaveLength(0);
      expect(f.notifications.map((n) => [n.cmd.userId, n.cmd.title])).toEqual([
        ['acc-1', `Hoàn tiền đơn ${ORDER_CODE} thất bại`],
        ['acc-2', `Hoàn tiền đơn ${ORDER_CODE} thất bại`],
      ]);
      expect(await f.service.getRefund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, gatewayStatus: GATEWAY_STATUS.FAILED, needsManual: false }); // chạy lại qua PayOS được
    });

    it('job tra ra FAILED của lệnh CŨ nhưng refund đã bị chiếm lại để gửi lệnh MỚI (worker khác đánh failed, kế toán bấm lại) ⇒ KHÔNG đánh failed nhầm lệnh mới', async () => {
      const { f, payment, refund } = setup();
      await f.service.processRefund(actor, refund.id, {});
      f.getPayout.mockImplementationOnce(() => {
        f.refund(refund.id).gatewaySubmittedAt = null; // lúc job đang chờ PayOS: refund được chiếm lại (xoá mốc gửi lệnh cũ)
        return Promise.resolve({ state: 'failed' as const, detail: 'state=FAILED' });
      });

      await f.service.reconcileGatewayRefunds();

      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: null });
      expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(0);
      expect(f.notifications).toHaveLength(0);
    });

    it('FAILED rồi kế toán chạy lại ⇒ lệnh MỚI (referenceId/idempotency-key "<id>-2", gatewayAttempt 2), lệnh cũ không bị gửi lại; xong ⇒ done với mã lệnh mới', async () => {
      const { f, payment, refund } = setup();
      f.payout.mockResolvedValueOnce({ ok: true, code: '00', message: 'ok', transactionId: 'TX-1', raw: {} }).mockResolvedValueOnce({ ok: true, code: '00', message: 'ok', transactionId: 'TX-2', raw: {} });
      f.getPayout.mockResolvedValueOnce({ state: 'failed', detail: 'state=FAILED' }).mockResolvedValue({ state: 'succeeded', detail: 'SUCCEEDED' });
      await f.service.processRefund(actor, refund.id, {});
      await f.service.reconcileGatewayRefunds(); // lệnh 1 thất bại

      const res = await processAndSettle(f, refund.id); // lệnh 2

      expect(f.payout.mock.calls.map(([i]) => [i.referenceId, i.idempotencyKey])).toEqual([
        [REFUND_ID, REFUND_ID],
        [`${REFUND_ID}-2`, `${REFUND_ID}-2`],
      ]);
      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-2' });
      expect(f.refund(refund.id)).toMatchObject({ gatewayAttempt: 2, gatewayPayoutId: 'TX-2' });
      expect(f.getPayout.mock.calls.map((c) => c[0])).toEqual(['TX-1', 'TX-2']);
      expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
      expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
    });

    it('FAILED rồi kế toán đã chuyển TAY và nhập providerRef ⇒ ghi sổ như hoàn thủ công, KHÔNG gửi lệnh PayOS mới', async () => {
      const { f, refund } = setup();
      f.getPayout.mockResolvedValue({ state: 'failed', detail: 'state=FAILED' });
      await f.service.processRefund(actor, refund.id, {});
      await f.service.reconcileGatewayRefunds();

      const res = await f.service.processRefund(actor, refund.id, { providerRef: 'FT26102600001', note: 'Đã chuyển tay' });

      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'FT26102600001', note: 'Đã chuyển tay' });
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
    });

    it('bấm "hoàn tiền" lúc PayOS đã nhận lệnh nhưng chưa xong ⇒ KHÔNG gửi lệnh lần hai (chỉ tra trạng thái); có providerRef mà còn trong hạn ⇒ 400 INVALID_STATE, không ghi gì', async () => {
      const { f, payment, refund } = setup();
      f.getPayout.mockResolvedValue({ state: 'processing', detail: 'PROCESSING' });
      await f.service.processRefund(actor, refund.id, {});

      const again = await f.service.processRefund(actor, refund.id, {});
      const blocked = await thrown(f.service.processRefund(actor, refund.id, { providerRef: 'FT26102600002' }));

      expect(again).toMatchObject({ status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.PROCESSING });
      expect(blocked).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE });
      expect((blocked as BusinessException).message).toContain('PayOS vẫn đang xử lý');
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.getPayout).toHaveBeenCalledTimes(2);
      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: null });
      expect(f.payment(payment.id).refundedAmount.toString()).toBe('0');
    });

    it('kế toán bấm lại khi PayOS đã SUCCEEDED ⇒ chốt ngay (không chờ job): done, audit ghi người bấm (via process), vẫn không gửi lệnh mới', async () => {
      const { f, refund } = setup();
      f.getPayout.mockResolvedValue({ state: 'processing', detail: 'PROCESSING' });
      await f.service.processRefund(actor, refund.id, {});
      f.getPayout.mockResolvedValue({ state: 'succeeded', detail: 'SUCCEEDED' });

      const res = await f.service.processRefund(actor_of('user-acc-2'), refund.id, { note: 'Kiểm tra lại' });

      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-123', note: 'Kiểm tra lại' });
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_PROCESSED)).toMatchObject({ actorUserId: 'user-acc-2', afterSummary: { via: 'process', payoutId: 'TX-123' } });
    });

    describe('treo bất thường (quá REFUND_GATEWAY_STALL_MS = 30 phút)', () => {
      it('treo > 30 phút ⇒ đánh dấu cần người xem (needsManual) + báo kế toán ĐÚNG MỘT LẦN dù job chạy nhiều lượt; vẫn không ghi sổ', async () => {
        const { f, payment, refund } = setup();
        f.getPayout.mockResolvedValue({ state: 'processing', detail: 'PROCESSING' });
        await f.service.processRefund(actor, refund.id, {});
        f.refund(refund.id).gatewaySubmittedAt = minutesAgo(31);

        await f.service.reconcileGatewayRefunds();
        await f.service.reconcileGatewayRefunds();
        await f.service.reconcileGatewayRefunds();

        expect(REFUND_GATEWAY_STALL_MS).toBe(30 * 60_000);
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.PROCESSING, needsManual: true });
        expect(f.refund(refund.id).gatewayAlertedAt).toBeInstanceOf(Date);
        expect(await f.service.getRefund(refund.id)).toMatchObject({ needsManual: true, gatewayStatus: GATEWAY_STATUS.PROCESSING });
        expect(f.notifications.map((n) => [n.cmd.userId, n.cmd.title])).toEqual([
          ['acc-1', `Lệnh hoàn tiền đơn ${ORDER_CODE} treo bất thường`],
          ['acc-2', `Lệnh hoàn tiền đơn ${ORDER_CODE} treo bất thường`],
        ]);
        expect(f.state.audits.filter((a) => a.action === PAYMENT_AUDIT.REFUND_GATEWAY_STALLED)).toHaveLength(1);
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('0');
        expect(f.orders.onRefunded).not.toHaveBeenCalled();
      });

      it('chưa tới 30 phút (29) ⇒ không báo, không đánh dấu', async () => {
        const { f, refund } = setup();
        f.getPayout.mockResolvedValue({ state: 'processing', detail: 'PROCESSING' });
        await f.service.processRefund(actor, refund.id, {});
        f.refund(refund.id).gatewaySubmittedAt = minutesAgo(29);

        await f.service.reconcileGatewayRefunds();

        expect(f.refund(refund.id)).toMatchObject({ needsManual: false, gatewayAlertedAt: null });
        expect(f.notifications).toHaveLength(0);
      });

      it('quá 30 phút nhưng PayOS đã báo SUCCEEDED ⇒ done bình thường, không báo "treo"', async () => {
        const { f, refund } = setup();
        await f.service.processRefund(actor, refund.id, {});
        f.refund(refund.id).gatewaySubmittedAt = minutesAgo(45);

        await f.service.reconcileGatewayRefunds();

        expect(f.refund(refund.id).status).toBe(REFUND_STATUS.DONE);
        expect(f.notifications.filter((n) => n.cmd.title.includes('treo bất thường'))).toHaveLength(0);
      });

      it('kế toán đối chiếu trên PayOS rồi nhập providerRef khi đã treo ⇒ ghi sổ như hoàn tay (ghi chú, người bấm, needsManual tắt); PayOS không được hỏi/gửi lại thành lệnh mới', async () => {
        const { f, payment, refund } = setup();
        f.getPayout.mockResolvedValue({ state: 'processing', detail: 'PROCESSING' });
        await f.service.processRefund(actor, refund.id, {});
        f.refund(refund.id).gatewaySubmittedAt = minutesAgo(40);
        await f.service.reconcileGatewayRefunds();

        const res = await f.service.processRefund(actor, refund.id, { providerRef: 'FT26102600003', note: 'Đối chiếu PayOS: đã chuyển' });

        expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'FT26102600003', note: 'Đối chiếu PayOS: đã chuyển', needsManual: false });
        expect(f.refund(refund.id)).toMatchObject({ processedBy: actor.userId });
        expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
        expect(f.payout).toHaveBeenCalledTimes(1);
        expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_PROCESSED)).toMatchObject({ afterSummary: { via: 'process', manualConfirm: true, providerRef: 'FT26102600003' } });
      });
    });

    describe('job reconcileGatewayRefunds', () => {
      it('chỉ xét refund processing ĐÃ được PayOS nhận lệnh: processing chưa gửi lệnh, requested, failed, done không bị tra', async () => {
        const f = buildFixture();
        const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, gatewayResponse: webhookData(ACCOUNT) });
        const ids = ['33333333-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000002', '33333333-0000-4000-8000-000000000003', '33333333-0000-4000-8000-000000000004'];
        f.seedRefund(payment, { id: ids[0], status: REFUND_STATUS.PROCESSING });
        f.seedRefund(payment, { id: ids[1], status: REFUND_STATUS.REQUESTED });
        f.seedRefund(payment, { id: ids[2], status: REFUND_STATUS.FAILED, gatewayPayoutId: 'TX-F', gatewayStatus: GATEWAY_STATUS.FAILED });
        f.seedRefund(payment, { id: ids[3], status: REFUND_STATUS.DONE, providerRef: 'x', gatewayPayoutId: 'TX-D', gatewaySubmittedAt: minutesAgo(5) });

        expect(await f.service.reconcileGatewayRefunds()).toEqual({ checked: 0, finalized: 0, failed: 0, pending: 0 });
        expect(f.getPayout).not.toHaveBeenCalled();
      });

      it('cũ nhất trước, tối đa `limit`; mỗi refund một try/catch (một refund lỗi không chặn refund sau)', async () => {
        const f = buildFixture();
        const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, gatewayResponse: webhookData(ACCOUNT) });
        const mk = (n: number, id: string, minutes: number) => f.seedRefund(payment, { id, amount: D(10_000 * n), status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.SUBMITTED, gatewayPayoutId: `TX-${n}`, gatewayAttempt: 1, gatewaySubmittedAt: minutesAgo(minutes), updatedAt: minutesAgo(minutes) });
        const c = mk(3, '44444444-0000-4000-8000-00000000000c', 10);
        const a = mk(1, '44444444-0000-4000-8000-00000000000a', 30);
        const b = mk(2, '44444444-0000-4000-8000-00000000000b', 20);
        f.getPayout.mockRejectedValueOnce(new Error('mạng chết')); // a lỗi bất ngờ

        const out = await f.service.reconcileGatewayRefunds(2); // limit 2 ⇒ a (cũ nhất) và b; c để lượt sau

        expect(out).toEqual({ checked: 2, finalized: 1, failed: 0, pending: 0 });
        expect(f.getPayout.mock.calls.map((x) => x[0])).toEqual(['TX-1', 'TX-2']);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect([a, b, c].map((r) => f.refund(r.id).status)).toEqual([REFUND_STATUS.PROCESSING, REFUND_STATUS.DONE, REFUND_STATUS.PROCESSING]);
      });
    });
  });

  // ------------------------------------------------------------------ tài khoản nhận hoàn
  describe('tài khoản nhận hoàn (payee)', () => {
    const REQ = { orderCode: ORDER_CODE, shopId: null as string | null, amount: 100_000n, reason: 'Đổi trả', returnRequestId: null as string | null, actorUserId: 'staff-1' };
    const request = (f: Fixture, o: { payee?: RefundPayee | null; shopId?: string | null; returnRequestId?: string | null } = {}) => f.db.$transaction((tx) => f.service.requestRefund({ ...REQ, ...o }, tx as unknown as Tx));
    const cod = (f: Fixture) => f.seedPayment({ methodCode: METHOD.COD, status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1 });

    describe('requestRefund', () => {
      it('đơn COD KHÔNG có payee ⇒ KHÔNG chặn luồng của order: vẫn tạo refund (payee_source none, needsManual, method manual_transfer) và báo kế toán liên hệ khách xin tài khoản', async () => {
        const f = buildFixture();
        const p = cod(f);

        const { refundId } = await request(f, { shopId: 'shop-1', returnRequestId: 'rr-1' });

        expect(refundId).not.toBeNull();
        expect(f.refund(must(refundId, 'refundId'))).toMatchObject({
          paymentId: p.id,
          method: 'manual_transfer',
          status: REFUND_STATUS.REQUESTED,
          payeeBankBin: null,
          payeeAccountNumber: null,
          payeeAccountName: null,
          payeeSource: PAYEE_SOURCE.NONE,
          needsManual: true,
          returnRequestId: 'rr-1',
        });
        expect(f.notifications.map((n) => [n.cmd.userId, n.cmd.title])).toEqual([
          ['acc-1', `Khoản hoàn đơn ${ORDER_CODE} cần chuyển khoản tay`],
          ['acc-2', `Khoản hoàn đơn ${ORDER_CODE} cần chuyển khoản tay`],
        ]);
        expect(f.notifications[0].cmd.content).toContain('chưa có tài khoản nhận hoàn');
        expect(f.notifications[0].cmd.content).toContain('Liên hệ khách (SĐT trong đơn)');
        expect(f.notifications[0].cmd.content).toContain('chuyển khoản tay');
        expect(f.notifications[0].cmd.payload).toMatchObject({ refundId, reason: 'no_payee' });
        expect(f.notifications[0].tx).toBeDefined(); // cùng transaction với việc tạo refund
        expect(await f.service.getRefund(must(refundId, 'refundId'))).toMatchObject({ method: 'manual_transfer', payee: null, payeeSource: 'none', needsManual: true });
        // payee null tường minh cũng vậy
        expect((await request(f, { payee: null, returnRequestId: 'rr-2' })).refundId).not.toBeNull();
      });

      it('đơn COD không payee: kế toán chuyển tay + nhập mã giao dịch ⇒ done; không nhập mã ⇒ 400 (không có đường tự chi); chưa có tài khoản để xem ⇒ 404', async () => {
        const f = buildFixture();
        const p = cod(f);
        const { refundId } = await request(f, { shopId: 'shop-1' });
        const id = must(refundId, 'refundId');

        expect(await thrown(f.service.processRefund(actor, id, {}))).toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
        expect(f.refund(id).status).toBe(REFUND_STATUS.REQUESTED); // nhả chiếm
        expect(await thrown(f.service.revealPayee(actor, id))).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_PAYEE_NOT_FOUND });
        const res = await f.service.processRefund(actor, id, { providerRef: 'FT26102600030', note: 'Đã liên hệ khách, chuyển tay' });

        expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'FT26102600030', needsManual: false });
        expect(f.payout).not.toHaveBeenCalled();
        expect(f.payment(p.id).refundedAmount.toString()).toBe('100000');
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
      });

      it('đơn COD CÓ payee ⇒ lưu chuẩn hoá (tên bỏ dấu + in hoa), nguồn customer, method gateway, KHÔNG cần chuyển tay; số TK đầy đủ không vào audit', async () => {
        const f = buildFixture();
        const p = cod(f);

        const { refundId } = await request(f, { payee: PAYEE, shopId: 'shop-1', returnRequestId: 'rr-1' });

        expect(f.refund(must(refundId, 'refundId'))).toMatchObject({
          paymentId: p.id,
          method: 'gateway',
          status: REFUND_STATUS.REQUESTED,
          shopId: 'shop-1',
          returnRequestId: 'rr-1',
          payeeBankBin: '970415',
          payeeAccountNumber: '1122334455',
          payeeAccountName: 'TRAN THI BE',
          payeeSource: PAYEE_SOURCE.CUSTOMER,
          needsManual: false,
        });
        const audit = f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_REQUESTED);
        expect(audit).toMatchObject({ afterSummary: { needsManual: false, payee: { source: 'customer', bankBin: '970415', accountNumberMasked: '****4455' } } });
        expect(JSON.stringify(f.state.audits)).not.toContain('1122334455');
        // AUD-20: đơn COD KHÔNG bao giờ tự chi ⇒ kế toán phải được báo ngay lúc tạo yêu cầu (nếu không khoản này nằm im vì ai cũng tưởng job tự chi).
        expect(f.notifications.map((n) => [n.cmd.userId, n.cmd.title])).toEqual([
          ['acc-1', `Khoản hoàn mới cần xử lý — đơn ${ORDER_CODE}`],
          ['acc-2', `Khoản hoàn mới cần xử lý — đơn ${ORDER_CODE}`],
        ]);
        expect(f.notifications[0].cmd.content).toContain('Đơn COD không tự chi hoàn tiền');
      });

      it('số tài khoản có khoảng trắng/gạch được làm sạch trước khi lưu', async () => {
        const f = buildFixture();
        cod(f);
        const { refundId } = await request(f, { payee: { ...PAYEE, accountNumber: '1122 3344-55' } });
        expect(f.refund(must(refundId, 'refundId')).payeeAccountNumber).toBe('1122334455');
      });

      it.each<[string, RefundPayee]>([
        ['BIN 5 chữ số', { ...PAYEE, bankBin: '97041' }],
        ['BIN có chữ', { ...PAYEE, bankBin: '97a415' }],
        ['số tài khoản quá ngắn (5)', { ...PAYEE, accountNumber: '12345' }],
        ['số tài khoản quá dài (20)', { ...PAYEE, accountNumber: '1'.repeat(20) }],
        ['số tài khoản có chữ', { ...PAYEE, accountNumber: '12345abc90' }],
        ['tên chủ tài khoản rỗng', { ...PAYEE, accountName: '   ' }],
        ['tên có ký tự lạ', { ...PAYEE, accountName: 'NGUYEN@VAN' }],
      ])('payee không hợp lệ (%s) ⇒ 400 PAYMENT_REFUND_PAYEE_INVALID, không tạo refund (kể cả đơn PayOS)', async (_label, payee) => {
        const f = buildFixture();
        f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1 });

        const err = await thrown(request(f, { payee }));

        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_PAYEE_INVALID, httpStatus: HttpStatus.BAD_REQUEST });
        expect(f.state.refunds.size).toBe(0);
      });

      it('PayOS thiếu tài khoản đã trả VÀ khách không khai ⇒ needsManual + báo KẾ TOÁN (cùng transaction với việc tạo refund)', async () => {
        const f = buildFixture();
        f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, gatewayResponse: null, version: 1 });

        const { refundId } = await request(f);

        expect(f.refund(must(refundId, 'refundId')).needsManual).toBe(true);
        expect(f.users.staffUserIdsWithPermission).toHaveBeenCalledWith('payment.refund.process');
        expect(f.notifications.map((n) => [n.cmd.userId, n.cmd.title])).toEqual([
          ['acc-1', `Khoản hoàn đơn ${ORDER_CODE} cần chuyển khoản tay`],
          ['acc-2', `Khoản hoàn đơn ${ORDER_CODE} cần chuyển khoản tay`],
        ]);
        expect(f.notifications[0].cmd).toMatchObject({ type: 'payment', link: '/payment/refunds', payload: { refundId, orderCode: ORDER_CODE, reason: 'no_payee' } });
        expect(f.notifications[0].tx).toBeDefined();
      });

      it('PayOS có tài khoản đã trả ⇒ KHÔNG cần chuyển tay, không báo kế toán lúc tạo', async () => {
        const f = buildFixture();
        f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, gatewayResponse: webhookData(ACCOUNT), version: 1 });
        const { refundId } = await request(f);
        expect(f.refund(must(refundId, 'refundId')).needsManual).toBe(false);
        expect(f.notifications).toHaveLength(0);
      });

      it('PayOS có tài khoản nhưng CHƯA cấu hình khoá payout ⇒ báo kế toán (chuyển tay), response needsManual = true dù cột phi chuẩn hoá = false', async () => {
        const f = buildFixture({ payoutConfigured: false });
        f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, gatewayResponse: webhookData(ACCOUNT), version: 1 });

        const { refundId } = await request(f);

        expect(f.refund(must(refundId, 'refundId')).needsManual).toBe(false);
        expect(f.notifications[0].cmd.payload).toMatchObject({ reason: 'payout_not_configured' });
        expect(await f.service.getRefund(must(refundId, 'refundId'))).toMatchObject({ needsManual: true });
      });

      it('payment lịch sử (vnpay) ⇒ method manual_transfer + needsManual dù có payee', async () => {
        const f = buildFixture();
        f.seedPayment({ methodCode: 'vnpay', status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1 });
        const { refundId } = await request(f, { payee: PAYEE });
        expect(f.refund(must(refundId, 'refundId'))).toMatchObject({ method: 'manual_transfer', needsManual: true });
        expect(f.notifications[0].cmd.payload).toMatchObject({ reason: 'no_gateway' });
      });

      it('tra cứu danh sách kế toán lỗi ⇒ vẫn tạo refund (nuốt + cảnh báo log), không thông báo', async () => {
        const f = buildFixture();
        f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, gatewayResponse: null, version: 1 });
        f.users.staffUserIdsWithPermission.mockRejectedValue(new Error('identity down'));

        const { refundId } = await request(f);

        expect(refundId).not.toBeNull();
        expect(f.notifications).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalled();
      });

      it('đơn COD CHƯA thu tiền (payment pending) ⇒ refundId null và KHÔNG đòi payee (chưa có gì để hoàn)', async () => {
        const f = buildFixture();
        f.seedPayment({ methodCode: METHOD.COD, status: PAY_STATUS.PENDING });
        expect(await request(f)).toEqual({ refundId: null });
      });
    });

    describe('thứ tự ưu tiên khi chi: tài khoản ĐÃ TRẢ tiền → tài khoản khách khai → chuyển tay', () => {
      it('có cả hai ⇒ chi về tài khoản đã trả tiền; response payeeSource = payer, số TK che 4 số cuối; cột payee_source ghi nguồn đã dùng', async () => {
        const { f, refund } = setup({ refund: CUSTOMER_COLUMNS });

        const submitted = await f.service.processRefund(actor, refund.id, {});

        expect(f.payout).toHaveBeenCalledWith(expect.objectContaining({ toBin: '970436', toAccountNumber: '0011223344' }));
        expect(submitted.payeeSource).toBe('payer');
        expect(submitted.payee).toEqual({ bankBin: '970436', accountNumberMasked: '****3344', accountName: 'NGUYEN VAN A' });
        expect(f.refund(refund.id).payeeSource).toBe(PAYEE_SOURCE.PAYER);
        expect(f.refund(refund.id).payeeAccountNumber).toBe('1122334455'); // lời khai của khách vẫn giữ làm dự phòng
        expect(JSON.stringify(submitted)).not.toContain('0011223344');
        expect(JSON.stringify(submitted)).not.toContain('1122334455');
      });

      it('payment PayOS không có tài khoản đối ứng (return-query thắng webhook) + khách có khai ⇒ chi về tài khoản KHÁCH KHAI', async () => {
        const { f, refund } = setup({ payment: { gatewayResponse: null }, refund: CUSTOMER_COLUMNS });

        const submitted = await f.service.processRefund(actor, refund.id, {});

        expect(f.payout).toHaveBeenCalledWith(expect.objectContaining({ toBin: '970415', toAccountNumber: '1122334455', amount: 100_000n }));
        expect(submitted).toMatchObject({ payeeSource: 'customer', payee: { bankBin: '970415', accountNumberMasked: '****4455', accountName: 'TRAN THI BE' } });
        expect(f.refund(refund.id).payeeSource).toBe(PAYEE_SOURCE.CUSTOMER);
      });

      it('đơn COD + payee khách khai + đã cấu hình payout ⇒ chi tự động qua PayOS rồi (khi PayOS báo xong) ghi sổ + trừ ví COD của shop', async () => {
        const f = buildFixture();
        const payment = f.seedPayment({ methodCode: METHOD.COD, status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1 });
        const refund = f.seedRefund(payment, { ...CUSTOMER_COLUMNS, shopId: 'shop-1', method: 'gateway', needsManual: false });

        const res = await processAndSettle(f, refund.id);

        expect(f.payout).toHaveBeenCalledWith(expect.objectContaining({ toBin: '970415', toAccountNumber: '1122334455', referenceId: refund.id }));
        expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-123', payeeSource: 'customer' });
        expect(f.wallet.applyCodRefund).toHaveBeenCalledTimes(1);
        expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
      });

      it('không có tài khoản nào ⇒ 400 PAYMENT_REFUND_MANUAL_REQUIRED (nhả chiếm), response needsManual = true; nhập providerRef ⇒ done như hoàn tay', async () => {
        const { f, refund } = setup({ payment: { gatewayResponse: null } });

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_MANUAL_REQUIRED, httpStatus: HttpStatus.BAD_REQUEST });
        expect((err as BusinessException).message).toContain('số tài khoản');
        expect(f.payout).not.toHaveBeenCalled();
        expect(await f.service.getRefund(refund.id)).toMatchObject({ status: REFUND_STATUS.REQUESTED, needsManual: true, payee: null, payeeSource: 'none' });
        expect(await f.service.processRefund(actor, refund.id, { providerRef: 'FT26102600004' })).toMatchObject({ status: REFUND_STATUS.DONE, needsManual: false });
      });

      it('chưa cấu hình payout dù có tài khoản khách khai ⇒ MANUAL_REQUIRED nêu "payout chưa cấu hình"; response needsManual = true', async () => {
        const { f, refund } = setup({ payoutConfigured: false, payment: { gatewayResponse: null }, refund: CUSTOMER_COLUMNS });

        const err = await thrown(f.service.processRefund(actor, refund.id, {}));

        expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_MANUAL_REQUIRED });
        expect((err as BusinessException).message).toContain('payout chưa cấu hình');
        expect(f.payout).not.toHaveBeenCalled();
        expect(await f.service.getRefund(refund.id)).toMatchObject({ needsManual: true, payeeSource: 'customer' });
      });
    });

    it('response + danh sách KHÔNG BAO GIỜ lộ số tài khoản đầy đủ; có returnRequestId, payee, payeeSource, gatewayStatus, needsManual', async () => {
      const { f, refund } = setup({ refund: { ...CUSTOMER_COLUMNS, returnRequestId: 'rr-9', shopId: 'shop-1' } });

      const one = await f.service.getRefund(refund.id);
      const page = await f.service.listRefunds(1, 20, {});

      expect(one).toMatchObject({ id: refund.id, returnRequestId: 'rr-9', status: REFUND_STATUS.REQUESTED, gatewayStatus: null, needsManual: false, payeeSource: 'payer', payee: { bankBin: '970436', accountNumberMasked: '****3344' } });
      for (const body of [JSON.stringify(one), JSON.stringify(page)]) {
        expect(body).not.toContain('0011223344');
        expect(body).not.toContain('1122334455');
      }
      expect(page.content[0].payee?.accountNumberMasked).toBe('****3344');
    });
  });

  // ------------------------------------------------------------------ providerRef duy nhất
  describe('mã giao dịch hoàn tay (providerRef) duy nhất', () => {
    const manualSetup = () => {
      const f = buildFixture();
      const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, gatewayResponse: null, version: 1 });
      f.seedRefund(payment, { id: REFUND_ID, amount: D(100_000) });
      f.seedRefund(payment, { id: REFUND_ID_2, amount: D(50_000) });
      return { f, payment };
    };

    it('mã đã dùng cho khoản hoàn khác ⇒ 409 REFUND_PROVIDER_REF_DUPLICATE, refund nhả về requested, không ghi sổ', async () => {
      const { f, payment } = manualSetup();
      await f.service.processRefund(actor, REFUND_ID, { providerRef: 'FT26102600010' });

      const err = await thrown(f.service.processRefund(actor, REFUND_ID_2, { providerRef: 'FT26102600010' }));

      expect(err).toBeInstanceOf(BusinessException);
      expect(err).toMatchObject({ errorCode: 'REFUND_PROVIDER_REF_DUPLICATE', httpStatus: HttpStatus.CONFLICT });
      expect(f.refund(REFUND_ID_2)).toMatchObject({ status: REFUND_STATUS.REQUESTED, providerRef: null });
      expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000'); // chỉ khoản đầu
      expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
    });

    it('chạy đua: hai người nhập cùng mã, kiểm trước bị lọt ⇒ unique index một phần (P2002) cũng ra 409 REFUND_PROVIDER_REF_DUPLICATE (không phải lỗi 500), nhả chiếm, ghi sổ hoàn tác', async () => {
      const { f, payment } = manualSetup();
      await f.service.processRefund(actor, REFUND_ID, { providerRef: 'FT26102600011' });
      jest.spyOn(f.db.refund, 'findFirst').mockResolvedValueOnce(null); // pre-check không thấy (người kia vừa ghi)

      const err = await thrown(f.service.processRefund(actor, REFUND_ID_2, { providerRef: 'FT26102600011' }));

      expect(err).toMatchObject({ errorCode: 'REFUND_PROVIDER_REF_DUPLICATE', httpStatus: HttpStatus.CONFLICT });
      expect(f.refund(REFUND_ID_2)).toMatchObject({ status: REFUND_STATUS.REQUESTED, providerRef: null });
      expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
      expect(f.txnsOf(payment.id, TX_TYPE.REFUND)).toHaveLength(1);
    });

    it('mã được cắt khoảng trắng đầu/cuối trước khi lưu', async () => {
      const { f } = manualSetup();
      const res = await f.service.processRefund(actor, REFUND_ID, { providerRef: '  FT26102600012  ' });
      expect(res.providerRef).toBe('FT26102600012');
    });

    it.each(['abc', 'FT 2610 0001', 'FT26102600013?', '-FT26102600013', 'payos-refund:TX-1', 'PAYOS-REFUND:TX-1', 'x'.repeat(121)])('providerRef không hợp lệ (%s) ⇒ 400 COMMON_VALIDATION_ERROR, không chiếm refund', async (providerRef) => {
      const { f } = manualSetup();

      const err = await thrown(f.service.processRefund(actor, REFUND_ID, { providerRef }));

      expect(err).toBeInstanceOf(BusinessException);
      expect(err).toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR', httpStatus: HttpStatus.BAD_REQUEST });
      expect(f.calls).not.toContain('refund.updateMany');
      expect(f.refund(REFUND_ID).status).toBe(REFUND_STATUS.REQUESTED);
    });

    it('mã lệnh chi PayOS (payos-refund:<id>) cũng duy nhất: hai refund không thể cùng chốt một lệnh chi', async () => {
      const f = buildFixture();
      const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, gatewayResponse: webhookData(ACCOUNT) });
      f.seedRefund(payment, { id: REFUND_ID, status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-DUP' });
      f.seedRefund(payment, { id: REFUND_ID_2, status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.SUBMITTED, gatewayPayoutId: 'TX-DUP', gatewayAttempt: 1, gatewaySubmittedAt: minutesAgo(2) });
      f.getPayout.mockResolvedValue({ state: 'succeeded', detail: 'SUCCEEDED' });

      await f.service.reconcileGatewayRefunds(); // lỗi unique bị job nuốt + log, refund 2 không bị ghi sổ

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(f.refund(REFUND_ID_2)).toMatchObject({ status: REFUND_STATUS.PROCESSING, providerRef: null });
      expect(f.orders.onRefunded).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ refundSummaries + danh sách
  describe('refundSummaries', () => {
    const seed = () => {
      const f = buildFixture();
      const a = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, orderCode: 'DH-A' }, 1790000000000001);
      const b = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, orderCode: 'DH-B' }, 1790000000000002);
      const c = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, orderCode: 'DH-C' }, 1790000000000003);
      return { f, a, b, c };
    };
    const rid = (n: number): string => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`;

    it('MỘT query cho cả danh sách; mỗi đơn lấy khoản MỚI NHẤT; bỏ khoản trả trùng (không thuộc đơn); trạng thái lạ bị bỏ qua; đơn không có hoàn ⇒ không có trong Map; mã đơn trùng được gộp', async () => {
      const { f, a, b, c } = seed();
      f.seedRefund(a, { id: rid(1), orderCode: 'DH-A', amount: D(50_000), status: REFUND_STATUS.DONE }); // cũ
      f.seedRefund(a, { id: rid(2), orderCode: 'DH-A', amount: D(70_000), status: REFUND_STATUS.REQUESTED }); // mới nhất của DH-A
      f.seedRefund(a, { id: rid(3), orderCode: 'DH-A', amount: D(999_000), status: REFUND_STATUS.REQUESTED, kind: REFUND_KIND.DUPLICATE_PAYMENT }); // mới hơn nhưng là khoản trùng
      f.seedRefund(b, { id: rid(4), orderCode: 'DH-B', amount: D(10_000), status: REFUND_STATUS.FAILED });
      f.seedRefund(c, { id: rid(5), orderCode: 'DH-C', amount: D(5_000), status: 'weird' });
      f.calls.length = 0;

      const map = await f.service.refundSummaries(['DH-A', 'DH-A', 'DH-B', 'DH-C', 'DH-Z', '']);

      expect(f.calls.filter((x) => x.startsWith('refund.'))).toEqual(['refund.findMany']);
      expect(Object.fromEntries(map)).toEqual({
        'DH-A': { status: 'requested', amount: 70_000n },
        'DH-B': { status: 'failed', amount: 10_000n },
      });
      expect(map.size).toBe(2);
      expect(typeof map.get('DH-A')?.amount).toBe('bigint');
    });

    it('danh sách rỗng ⇒ Map rỗng, KHÔNG chạm DB', async () => {
      const { f } = seed();
      f.calls.length = 0;
      expect((await f.service.refundSummaries([])).size).toBe(0);
      expect((await f.service.refundSummaries([''])).size).toBe(0);
      expect(f.calls).toEqual([]);
    });
  });

  describe('listRefunds — lọc needsManual / status', () => {
    const rid = (n: number): string => `66666666-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const seed = (payoutConfigured: boolean) => {
      const f = buildFixture({ payoutConfigured });
      const withPayer = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, gatewayResponse: webhookData(ACCOUNT), orderCode: 'DH-1' }, 1790000000000001);
      const noPayer = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, gatewayResponse: null, orderCode: 'DH-2' }, 1790000000000002);
      f.seedRefund(withPayer, { id: rid(1), orderCode: 'DH-1' }); // requested, tự chi được
      f.seedRefund(noPayer, { id: rid(2), orderCode: 'DH-2', needsManual: true }); // requested, thiếu tài khoản
      f.seedRefund(noPayer, { id: rid(3), orderCode: 'DH-2', status: REFUND_STATUS.DONE, providerRef: 'FT1', needsManual: true }); // đã xong: cờ cũ không còn ý nghĩa
      f.seedRefund(withPayer, { id: rid(4), orderCode: 'DH-1', status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.PROCESSING, gatewayPayoutId: 'TX-4', gatewaySubmittedAt: minutesAgo(40), gatewayAlertedAt: minutesAgo(5), needsManual: true }); // PayOS treo
      f.seedRefund(withPayer, { id: rid(5), orderCode: 'DH-1', status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.SUBMITTED, gatewayPayoutId: 'TX-5', gatewaySubmittedAt: minutesAgo(2) }); // PayOS đang xử lý bình thường
      return f;
    };

    it('needsManual=true (đã cấu hình payout) ⇒ chỉ khoản CHƯA xong và cần tay: thiếu tài khoản / PayOS treo; response needsManual khớp bộ lọc', async () => {
      const f = seed(true);

      const page = await f.service.listRefunds(1, 20, { needsManual: true });

      expect(page.content.map((r) => r.id).sort()).toEqual([rid(2), rid(4)].sort());
      expect(page.content.every((r) => r.needsManual)).toBe(true);
      expect(page.totalElements).toBe(2);
      const all = await f.service.listRefunds(1, 20);
      expect(Object.fromEntries(all.content.map((r) => [r.id, r.needsManual]))).toEqual({ [rid(1)]: false, [rid(2)]: true, [rid(3)]: false, [rid(4)]: true, [rid(5)]: false });
    });

    it('needsManual=true khi CHƯA cấu hình payout ⇒ mọi khoản đang chờ chi (requested/failed) cộng khoản PayOS treo', async () => {
      const f = seed(false);
      const page = await f.service.listRefunds(1, 20, { needsManual: true });
      expect(page.content.map((r) => r.id).sort()).toEqual([rid(1), rid(2), rid(4)].sort());
    });

    it('kết hợp status + phân trang server (skip/take) + sắp mới nhất trước; needsManual=false không lọc', async () => {
      const f = seed(true);
      const first = await f.service.listRefunds(1, 2, { status: REFUND_STATUS.PROCESSING });
      expect(first.content.map((r) => r.id)).toEqual([rid(5), rid(4)]);
      expect(first.totalElements).toBe(2);
      const page2 = await f.service.listRefunds(2, 2, {});
      expect(page2.content).toHaveLength(2);
      expect(page2.totalElements).toBe(5);
      expect((await f.service.listRefunds(1, 20, { needsManual: false })).totalElements).toBe(5);
    });
  });

  // ------------------------------------------------------------------ thông báo
  describe('thông báo hoàn tiền', () => {
    it('hoàn theo đơn xong ⇒ báo THÀNH VIÊN SHOP (một lần, cùng transaction ghi sổ); khách do order.onRefunded lo nên payment KHÔNG báo trùng', async () => {
      const { f, refund } = setup({ refund: { shopId: 'shop-1', returnRequestId: 'rr-1' } });

      await processAndSettle(f, refund.id);

      expect(f.shops.activeMemberUserIds).toHaveBeenCalledWith('shop-1');
      expect(f.notifications.map((n) => [n.cmd.userId, n.cmd.title, n.cmd.link])).toEqual([['shop-user-1', `Đã hoàn tiền cho khách — đơn ${ORDER_CODE}`, `/vendor/orders/${ORDER_CODE}`]]);
      expect(f.notifications[0].cmd.content).toContain('(đổi trả)');
      expect(f.notifications[0].tx).toBeDefined();
      expect(titlesTo(f, USER)).toHaveLength(0);
    });

    it('refund không gắn shop ⇒ không tra thành viên shop, không thông báo', async () => {
      const { f, refund } = setup();
      await processAndSettle(f, refund.id);
      expect(f.shops.activeMemberUserIds).not.toHaveBeenCalled();
      expect(f.notifications).toHaveLength(0);
    });

    it('tra cứu thành viên shop lỗi ⇒ việc ghi sổ KHÔNG bị ảnh hưởng (nuốt + cảnh báo)', async () => {
      const { f, refund } = setup({ refund: { shopId: 'shop-1' } });
      f.shops.activeMemberUserIds.mockRejectedValue(new Error('shop down'));

      const res = await processAndSettle(f, refund.id);

      expect(res.status).toBe(REFUND_STATUS.DONE);
      expect(f.notifications).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('tra cứu kế toán lỗi lúc hoàn thất bại ⇒ vẫn đánh failed đúng, không ném lỗi', async () => {
      const { f, refund } = setup();
      f.getPayout.mockResolvedValue({ state: 'failed', detail: 'state=REJECTED' });
      f.users.staffUserIdsWithPermission.mockRejectedValue(new Error('identity down'));
      await f.service.processRefund(actor, refund.id, {});

      await f.service.reconcileGatewayRefunds();

      expect(f.refund(refund.id).status).toBe(REFUND_STATUS.FAILED);
      expect(f.notifications).toHaveLength(0);
    });
  });
});

/* ================================================================ hợp đồng schema ↔ migration PLAN-0022 ================================================================ */

describe('hợp đồng schema ↔ migration 20261026100100_return_roles_payment', () => {
  const root = join(__dirname, '../../../../prisma');
  const migration = readFileSync(join(root, 'migrations', '20261026100100_return_roles_payment', 'migration.sql'), 'utf8');
  const schema = readFileSync(join(root, 'schema', 'payment.prisma'), 'utf8');

  it.each([
    ['payee_bank_bin', 'payeeBankBin'],
    ['payee_account_number', 'payeeAccountNumber'],
    ['payee_account_name', 'payeeAccountName'],
    ['payee_source', 'payeeSource'],
    ['gateway_status', 'gatewayStatus'],
    ['gateway_payout_id', 'gatewayPayoutId'],
    ['gateway_attempt', 'gatewayAttempt'],
    ['gateway_submitted_at', 'gatewaySubmittedAt'],
    ['gateway_alerted_at', 'gatewayAlertedAt'],
    ['needs_manual', 'needsManual'],
  ])('cột refunds.%s có trong migration (NULL/DEFAULT — an toàn deploy) và schema Prisma (%s)', (column, field) => {
    expect(migration).toMatch(new RegExp(`ALTER TABLE "payment"\\."refunds" ADD COLUMN "${column}" [A-Z0-9()]+( NOT NULL DEFAULT [a-z0-9]+)?;`));
    expect(schema).toContain(`@map("${column}")`);
    expect(schema).toMatch(new RegExp(`\\b${field}\\s`));
  });

  it('cột mới chỉ NULL hoặc có DEFAULT (không NOT NULL trần)', () => {
    const adds = [...migration.matchAll(/ADD COLUMN "[a-z_]+" ([^;]+);/g)].map((m) => m[1]);
    expect(adds.length).toBe(11);
    for (const a of adds) if (/NOT NULL/.test(a)) expect(a).toMatch(/DEFAULT/);
  });

  it('unique index MỘT PHẦN trên refunds.provider_ref (WHERE provider_ref IS NOT NULL), và dữ liệu trùng cũ được gỡ TRƯỚC khi tạo index', () => {
    const create = migration.indexOf('CREATE UNIQUE INDEX "uq_refunds_provider_ref" ON "payment"."refunds" ("provider_ref") WHERE "provider_ref" IS NOT NULL');
    const dedupe = migration.indexOf('ROW_NUMBER() OVER (PARTITION BY "provider_ref"');
    expect(create).toBeGreaterThan(-1);
    expect(dedupe).toBeGreaterThan(-1);
    expect(dedupe).toBeLessThan(create);
    expect(migration).toContain("LEFT(r.\"provider_ref\", 85) || '#' || REPLACE(r.\"id\"::text, '-', '')"); // ≤ 118 ký tự, vừa VARCHAR(120)
  });

  it('shop_payout_lines.source_order_code (VARCHAR(30), NULL) + backfill đúng công thức khoá dòng hoàn tiền RF-<26 hex> của ShopPayoutService', () => {
    expect(migration).toMatch(/ALTER TABLE "payment"\."shop_payout_lines" ADD COLUMN "source_order_code" VARCHAR\(30\);/);
    expect(schema).toMatch(/sourceOrderCode\s+String\?\s+@map\("source_order_code"\)\s+@db\.VarChar\(30\)/);
    expect(migration).toContain(`'RF-' || SUBSTRING(REPLACE(r."id"::text, '-', '') FROM 1 FOR 26)`);
  });
});

/* ================================================================ xem số tài khoản nhận hoàn (kế toán chuyển tay) ================================================================ */

describe('GET admin/refunds/:id/payee — số tài khoản ĐẦY ĐỦ cho kế toán chuyển tay (PLAN-0022)', () => {
  const realFetch = globalThis.fetch;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const PAYER = { counterAccountBankId: '970436', counterAccountBankName: 'Vietcombank', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A' };
  const CUSTOMER = { payeeBankBin: '970415', payeeAccountNumber: '1122334455', payeeAccountName: 'TRAN THI BE', payeeSource: 'customer' };
  const FULL_NUMBERS = ['0011223344', '1122334455'];

  beforeEach(() => {
    const fetchStub = jest.fn((): Promise<Response> => Promise.reject(new Error('fetch chưa được stub — không được gọi mạng thật')));
    globalThis.fetch = fetchStub;
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function setup(o: { payment?: Partial<PaymentRow>; refund?: Partial<RefundRow> } = {}) {
    const f = buildFixture();
    const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: new Date('2026-10-03T09:30:00.000Z'), transactionCode: String(PAYOS_CODE), gatewayResponse: webhookData(PAYER), version: 1, ...o.payment });
    const refund = f.seedRefund(payment, o.refund);
    return { f, payment, refund };
  }
  const reveals = (f: Fixture) => f.state.audits.filter((a) => a.action === PAYMENT_AUDIT.REFUND_PAYEE_VIEWED);
  const noFullNumber = (value: unknown) => {
    const body = JSON.stringify(value);
    for (const n of FULL_NUMBERS) expect(body).not.toContain(n);
  };

  it('tài khoản ĐÃ TRẢ tiền (payer): trả số đầy đủ + tên ngân hàng + tên chủ TK + source=payer, kể cả khi khách cũng có khai (payer ưu tiên)', async () => {
    const { f, refund } = setup({ refund: CUSTOMER });

    const res = await f.service.revealPayee(actor, refund.id);

    expect(res).toEqual({ bankBin: '970436', bankName: 'Vietcombank', accountNumber: '0011223344', accountName: 'NGUYEN VAN A', source: 'payer' });
  });

  it('tài khoản khách khai (customer): số đầy đủ, bankName null (tra theo BIN), source=customer — cả với payment PayOS thiếu tài khoản đối ứng lẫn đơn COD', async () => {
    const payos = setup({ payment: { gatewayResponse: null }, refund: CUSTOMER });
    expect(await payos.f.service.revealPayee(actor, payos.refund.id)).toEqual({ bankBin: '970415', bankName: null, accountNumber: '1122334455', accountName: 'TRAN THI BE', source: 'customer' });

    const f = buildFixture();
    const cod = f.seedPayment({ methodCode: METHOD.COD, status: PAY_STATUS.PAID, paidAt: new Date(), version: 1, gatewayResponse: { counterAccountNumber: '9999999999', counterAccountBankId: '970436' } }); // COD không có "tài khoản đã trả"
    const refund = f.seedRefund(cod, { ...CUSTOMER, method: 'gateway' });
    expect(await f.service.revealPayee(actor, refund.id)).toMatchObject({ accountNumber: '1122334455', source: 'customer' });
  });

  it.each([REFUND_STATUS.REQUESTED, REFUND_STATUS.PROCESSING, REFUND_STATUS.FAILED])('refund %s (còn mở) ⇒ xem được', async (status) => {
    const { f, refund } = setup({ refund: { status } });
    expect(await f.service.revealPayee(actor, refund.id)).toMatchObject({ accountNumber: '0011223344' });
  });

  it('refund đã done ⇒ 409 PAYMENT_INVALID_STATE, KHÔNG lộ số, KHÔNG ghi audit xem', async () => {
    const { f, refund } = setup({ refund: { status: REFUND_STATUS.DONE, providerRef: 'FT26102600099' } });

    const err = await thrown(f.service.revealPayee(actor, refund.id));

    expect(err).toBeInstanceOf(BusinessException);
    expect(err).toMatchObject({ errorCode: PAYMENT_ERR.INVALID_STATE, httpStatus: HttpStatus.CONFLICT });
    noFullNumber((err as BusinessException).message);
    expect(reveals(f)).toHaveLength(0);
  });

  it('refund chưa có tài khoản nhận nào (PayOS thiếu tài khoản đối ứng + khách không khai) ⇒ 404 PAYMENT_REFUND_PAYEE_NOT_FOUND, không audit', async () => {
    const { f, refund } = setup({ payment: { gatewayResponse: null } });

    const err = await thrown(f.service.revealPayee(actor, refund.id));

    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_PAYEE_NOT_FOUND, httpStatus: HttpStatus.NOT_FOUND });
    expect(reveals(f)).toHaveLength(0);
  });

  it('refund không tồn tại ⇒ 404 PAYMENT_REFUND_NOT_FOUND', async () => {
    const f = buildFixture();
    expect(await thrown(f.service.revealPayee(actor, REFUND_ID))).toMatchObject({ errorCode: PAYMENT_ERR.REFUND_NOT_FOUND, httpStatus: HttpStatus.NOT_FOUND });
  });

  it('MỖI lần xem ghi một audit REFUND_PAYEE_VIEWED (ai · refundId · orderCode · nguồn); audit và log KHÔNG chứa số tài khoản', async () => {
    const { f, refund } = setup({ refund: CUSTOMER });

    await f.service.revealPayee(actor, refund.id);
    await f.service.revealPayee(actor_of('user-acc-2'), refund.id);

    expect(reveals(f)).toHaveLength(2);
    expect(reveals(f)[0]).toMatchObject({ actorUserId: actor.userId, action: PAYMENT_AUDIT.REFUND_PAYEE_VIEWED, entityType: 'refund', entityId: refund.id, entityCode: ORDER_CODE, afterSummary: { source: 'payer', status: 'requested' } });
    expect(reveals(f)[1]).toMatchObject({ actorUserId: 'user-acc-2' });
    noFullNumber(f.state.audits);
    noFullNumber([logSpy.mock.calls, warnSpy.mock.calls, errorSpy.mock.calls]);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ refundId: refund.id, orderCode: ORDER_CODE, actorUserId: actor.userId }), 'Kế toán xem tài khoản nhận hoàn');
  });

  it('ĐÓNG-KHI-LỖI: ghi audit lỗi ⇒ ném lỗi, KHÔNG trả số tài khoản', async () => {
    const { f, refund } = setup();
    jest.spyOn(f.db, '$transaction').mockRejectedValueOnce(new Error('db chết'));

    const err = await thrown(f.service.revealPayee(actor, refund.id));

    expect((err as Error).message).toBe('db chết');
    expect(reveals(f)).toHaveLength(0);
  });

  it('không làm đổi refund (chỉ đọc + audit): status, version, providerRef giữ nguyên', async () => {
    const { f, refund } = setup({ refund: { version: 3 } });
    await f.service.revealPayee(actor, refund.id);
    expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.REQUESTED, version: 3, providerRef: null });
  });

  describe('controller', () => {
    const payee = { bankBin: '970436', bankName: 'Vietcombank', accountNumber: '0011223344', accountName: 'NGUYEN VAN A', source: 'payer' };
    const stub = { revealPayee: jest.fn((_actor: AuthenticatedActor, _id: string): Promise<unknown> => Promise.resolve(payee)) };
    const controller = new AdminPaymentController(stub as unknown as PaymentService);
    const handler = () => handlerOf(AdminPaymentController, 'payee');

    it('chuyển actor + id xuống service, bọc ApiResponse', async () => {
      const res = await controller.payee(actor, REFUND_ID);
      expect(stub.revealPayee).toHaveBeenCalledWith(actor, REFUND_ID);
      expect(res).toMatchObject({ success: true, data: payee, error: null });
    });

    it('GET refunds/:id/payee, đòi quyền payment.refund.process (cùng quyền chi tiền), KHÔNG công khai, Cache-Control: no-store, giới hạn tần suất theo người dùng', () => {
      expect(Reflect.getMetadata(METHOD_METADATA, handler()) as unknown).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(PATH_METADATA, handler()) as unknown).toBe('refunds/:id/payee');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler()) as unknown).toEqual(['payment.refund.process']);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler()) as unknown).toBeUndefined();
      expect(Reflect.getMetadata(HEADERS_METADATA, handler()) as unknown).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler()) as unknown).toMatchObject({ name: 'refund-payee-reveal', by: 'user' });
    });

    it('hai route danh sách/chi tiết hoàn tiền (payment.payment.read) KHÔNG bao giờ trả số đầy đủ — chỉ route payee mới có quyền chi tiền', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handlerOf(AdminPaymentController, 'refunds')) as unknown).toEqual(['payment.payment.read']);
    });
  });
});

/* ================================================================ PLAN-0022 — sửa theo review độc lập ================================================================ */

describe('PLAN-0022 (review) — PayOS từ chối ngay, reason dài, xoay vòng job, chỉ mục', () => {
  const realFetch = globalThis.fetch;
  let errorSpy: jest.SpyInstance;
  const ACCOUNT = { counterAccountBankId: '970436', counterAccountNumber: '0011223344', counterAccountName: 'NGUYEN VAN A' };
  const CUSTOMER = { payeeBankBin: '970415', payeeAccountNumber: '1122334455', payeeAccountName: 'TRAN THI BE', payeeSource: 'customer' };
  const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);
  const PAID_AT = new Date('2026-10-03T09:30:00.000Z');
  type PayoutResult = { ok: boolean; code: string; message: string; transactionId?: string; raw: unknown };
  const REJECT_231: PayoutResult = { ok: false, code: '231', message: 'Tài khoản nhận không hợp lệ', raw: { code: '231', desc: 'Tài khoản nhận không hợp lệ' } };

  beforeEach(() => {
    const fetchStub = jest.fn((): Promise<Response> => Promise.reject(new Error('fetch chưa được stub — không được gọi mạng thật')));
    globalThis.fetch = fetchStub;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function setup(o: { payment?: Partial<PaymentRow>; refund?: Partial<RefundRow> } = {}) {
    const f = buildFixture();
    const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, transactionCode: String(PAYOS_CODE), gatewayResponse: webhookData(ACCOUNT), version: 1, ...o.payment });
    const refund = f.seedRefund(payment, o.refund);
    return { f, payment, refund };
  }
  const refs = (f: Fixture) => f.payout.mock.calls.map(([i]) => [i.referenceId, i.idempotencyKey]);

  // ------------------------------------------------------------------ #1 PayOS từ chối ngay
  describe('PayOS từ chối NGAY lúc gửi lệnh chi', () => {
    it('từ chối CHẮC CHẮN (mã nghiệp vụ) ⇒ failed + gatewayStatus failed + ghi lần đã dùng/tài khoản bị từ chối; kế toán nhập providerRef ⇒ ghi sổ TAY, KHÔNG gọi PayOS lại, không chi trùng', async () => {
      const { f, payment, refund } = setup();
      f.payout.mockResolvedValueOnce(REJECT_231);

      const err = await thrown(f.service.processRefund(actor, refund.id, {}));

      expect(err).toMatchObject({ errorCode: 'PAYMENT_REFUND_FAILED', httpStatus: HttpStatus.BAD_GATEWAY });
      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, gatewayStatus: GATEWAY_STATUS.FAILED, gatewayAttempt: 1, payeeSource: PAYEE_SOURCE.PAYER, gatewayAttemptedAt: null, gatewayPayoutId: null, gatewaySubmittedAt: null });
      expect(await f.service.getRefund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, gatewayStatus: 'failed', needsReconcile: false, needsManual: false });

      const res = await f.service.processRefund(actor, refund.id, { providerRef: 'FT26102600020', note: 'Chuyển tay sau khi PayOS từ chối' });

      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'FT26102600020', note: 'Chuyển tay sau khi PayOS từ chối' });
      expect(f.payout).toHaveBeenCalledTimes(1); // KHÔNG gửi PayOS lại
      expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
      expect(f.txnsOf(payment.id, TX_TYPE.REFUND).map((t) => t.status)).toEqual(['failed', 'ok']);
      expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_PROCESSED)).toMatchObject({ afterSummary: { providerRef: 'FT26102600020', via: 'process' } });
    });

    it.each<[string, PayoutResult]>([
      ['HTTP 401 chữ ký sai (body không phải JSON)', { ok: false, code: '401', message: 'HTTP 401', raw: {} }],
      ['HTTP 429', { ok: false, code: '429', message: 'HTTP 429', raw: {} }],
      ['thiếu số dư (mã nghiệp vụ)', { ok: false, code: '231', message: 'Số dư không đủ', raw: { code: '231', desc: 'Số dư không đủ' } }],
    ])('%s ⇒ từ chối chắc chắn: failed + gatewayStatus failed, KHÔNG needsReconcile', async (_label, result) => {
      const { f, refund } = setup();
      f.payout.mockResolvedValueOnce(result);

      await thrown(f.service.processRefund(actor, refund.id, {}));

      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, gatewayStatus: GATEWAY_STATUS.FAILED, gatewayAttemptedAt: null });
      expect((await f.service.getRefund(refund.id)).needsReconcile).toBe(false);
    });

    it('từ chối chắc chắn rồi chạy lại KHÔNG providerRef ⇒ lệnh MỚI (referenceId/idempotency-key "<id>-2"); xong ⇒ done', async () => {
      const { f, refund } = setup();
      f.payout.mockResolvedValueOnce(REJECT_231).mockResolvedValueOnce({ ok: true, code: '00', message: 'ok', transactionId: 'TX-2', raw: {} });
      await thrown(f.service.processRefund(actor, refund.id, {}));

      const res = await processAndSettle(f, refund.id);

      expect(refs(f)).toEqual([
        [REFUND_ID, REFUND_ID],
        [`${REFUND_ID}-2`, `${REFUND_ID}-2`],
      ]);
      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'payos-refund:TX-2' });
      expect(f.refund(refund.id)).toMatchObject({ gatewayAttempt: 2 });
    });

    it.each<[string, PayoutResult]>([
      ['mất kết nối / timeout (raw null, mã 99)', { ok: false, code: '99', message: 'Không gọi được cổng PayOS', raw: null }],
      ['HTTP 500', { ok: false, code: '500', message: 'HTTP 500', raw: {} }],
      ['HTTP 503', { ok: false, code: '503', message: 'HTTP 503', raw: {} }],
      ['mã 20 (lỗi nội bộ phía PayOS)', { ok: false, code: '20', message: 'Internal error', raw: { code: '20', desc: 'Internal error' } }],
    ])('KHÔNG RÕ kết quả — %s ⇒ failed + needsReconcile (đã gọi cổng), KHÔNG gatewayStatus failed; báo kế toán đối chiếu', async (_label, result) => {
      const { f, refund } = setup();
      f.payout.mockResolvedValueOnce(result);

      await thrown(f.service.processRefund(actor, refund.id, {}));

      expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, gatewayStatus: null, gatewayAttempt: 0 });
      expect(f.refund(refund.id).gatewayAttemptedAt).toBeInstanceOf(Date);
      expect(await f.service.getRefund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, needsReconcile: true, gatewayStatus: null });
      expect(f.notifications[0].cmd.content).toContain('Chưa rõ PayOS đã nhận lệnh hay chưa');
      expect(f.notifications[0].cmd.payload).toMatchObject({ needsReconcile: true });
    });

    it('không rõ kết quả: chạy lại không providerRef ⇒ CÙNG khoá (PayOS trả đúng lệnh cũ, không chi đôi); PayOS nhận ⇒ xoá dấu "cần đối chiếu"', async () => {
      const { f, refund } = setup();
      f.payout.mockResolvedValueOnce({ ok: false, code: '99', message: 'timeout', raw: null });
      await thrown(f.service.processRefund(actor, refund.id, {}));

      const res = await processAndSettle(f, refund.id);

      expect(refs(f)).toEqual([
        [REFUND_ID, REFUND_ID],
        [REFUND_ID, REFUND_ID],
      ]);
      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, needsReconcile: false });
      expect(f.refund(refund.id).gatewayAttemptedAt).toBeNull();
      expect(f.orders.onRefunded).toHaveBeenCalledTimes(1);
    });

    it('không rõ kết quả mà kế toán đã ĐỐI CHIẾU và nhập providerRef ⇒ ghi sổ tay, KHÔNG gửi PayOS lại (tránh chi trùng tay + PayOS)', async () => {
      const { f, payment, refund } = setup();
      f.payout.mockResolvedValueOnce({ ok: false, code: '99', message: 'timeout', raw: null });
      await thrown(f.service.processRefund(actor, refund.id, {}));

      // AUD-14: hệ thống không tra được PayOS (fetch bị chặn trong test) ⇒ kế toán phải xác nhận rõ lệnh CHƯA chạy.
      const res = await f.service.processRefund(actor, refund.id, { providerRef: 'FT26102600021', note: 'Đối chiếu PayOS: đã chuyển', confirmGatewayNotExecuted: true });

      expect(res).toMatchObject({ status: REFUND_STATUS.DONE, providerRef: 'FT26102600021' });
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.payment(payment.id).refundedAmount.toString()).toBe('100000');
    });

    it('hoàn lần đầu (chưa từng gọi cổng) mà có providerRef và đủ điều kiện tự chi ⇒ vẫn gọi PayOS, providerRef bị bỏ qua (hành vi cũ giữ nguyên)', async () => {
      const { f, refund } = setup();
      await f.service.processRefund(actor, refund.id, { providerRef: 'FT26102600022' });
      expect(f.payout).toHaveBeenCalledTimes(1);
      expect(f.refund(refund.id).providerRef).toBeNull();
    });

    describe('đổi tài khoản khi bị từ chối (tài khoản đã trả ⇄ tài khoản khách khai)', () => {
      it('PayOS từ chối tài khoản ĐÃ TRẢ tiền mà khách có khai ⇒ lần chạy lại thử tài khoản KHÁCH KHAI (lệnh mới); response + tài khoản kế toán xem cũng chuyển sang tài khoản đó', async () => {
        const { f, refund } = setup({ refund: CUSTOMER });
        f.payout.mockResolvedValueOnce(REJECT_231);
        await thrown(f.service.processRefund(actor, refund.id, {}));

        expect(f.payout).toHaveBeenLastCalledWith(expect.objectContaining({ toBin: '970436', toAccountNumber: '0011223344' }));
        expect(await f.service.getRefund(refund.id)).toMatchObject({ payeeSource: 'customer', payee: { bankBin: '970415', accountNumberMasked: '****4455' } });
        expect(await f.service.revealPayee(actor, refund.id)).toMatchObject({ source: 'customer', accountNumber: '1122334455' }); // kế toán chuyển tay đúng tài khoản dự phòng

        const res = await processAndSettle(f, refund.id);

        expect(f.payout).toHaveBeenLastCalledWith(expect.objectContaining({ toBin: '970415', toAccountNumber: '1122334455', referenceId: `${REFUND_ID}-2`, idempotencyKey: `${REFUND_ID}-2` }));
        expect(res).toMatchObject({ status: REFUND_STATUS.DONE, payeeSource: 'customer' });
        expect(f.refund(refund.id).payeeSource).toBe(PAYEE_SOURCE.CUSTOMER);
      });

      it('tài khoản khách khai cũng bị từ chối ⇒ lần sau quay lại tài khoản đã trả tiền', async () => {
        const { f, refund } = setup({ refund: CUSTOMER });
        f.payout.mockResolvedValue(REJECT_231);
        await thrown(f.service.processRefund(actor, refund.id, {})); // payer
        await thrown(f.service.processRefund(actor, refund.id, {})); // customer
        await thrown(f.service.processRefund(actor, refund.id, {})); // lại payer

        expect(f.payout.mock.calls.map(([i]) => [i.toAccountNumber, i.referenceId])).toEqual([
          ['0011223344', REFUND_ID],
          ['1122334455', `${REFUND_ID}-2`],
          ['0011223344', `${REFUND_ID}-3`],
        ]);
      });

      it('khách KHÔNG khai tài khoản ⇒ chạy lại vẫn dùng tài khoản đã trả tiền (lỗi có thể do nguyên nhân khác, vd thiếu số dư)', async () => {
        const { f, refund } = setup();
        f.payout.mockResolvedValue(REJECT_231);
        await thrown(f.service.processRefund(actor, refund.id, {}));
        await thrown(f.service.processRefund(actor, refund.id, {}));
        expect(f.payout.mock.calls.map(([i]) => i.toAccountNumber)).toEqual(['0011223344', '0011223344']);
        expect(refs(f)).toEqual([
          [REFUND_ID, REFUND_ID],
          [`${REFUND_ID}-2`, `${REFUND_ID}-2`],
        ]);
      });

      it('PayOS đã NHẬN lệnh rồi báo FAILED khi tra lại ⇒ lần chạy lại cũng thử tài khoản còn lại', async () => {
        const { f, refund } = setup({ refund: CUSTOMER });
        f.getPayout.mockResolvedValueOnce({ state: 'failed', detail: 'state=FAILED' }).mockResolvedValue({ state: 'succeeded', detail: 'SUCCEEDED' });
        await f.service.processRefund(actor, refund.id, {});
        await f.service.reconcileGatewayRefunds();
        expect(f.refund(refund.id)).toMatchObject({ status: REFUND_STATUS.FAILED, payeeSource: PAYEE_SOURCE.PAYER });

        await processAndSettle(f, refund.id);

        expect(f.payout.mock.calls.map(([i]) => i.toAccountNumber)).toEqual(['0011223344', '1122334455']);
      });
    });
  });

  // ------------------------------------------------------------------ #3 reason ≤ 255
  describe('refunds.reason VARCHAR(255)', () => {
    const request = (f: Fixture, reason: string) => f.db.$transaction((tx) => f.service.requestRefund({ orderCode: ORDER_CODE, shopId: null, amount: 100_000n, reason, returnRequestId: null, actorUserId: 'staff-1' }, tx as unknown as Tx));
    const seed = () => {
      const f = buildFixture();
      f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, gatewayResponse: webhookData(ACCOUNT), version: 1 });
      return f;
    };
    const chars = (v: string | null): number => Array.from(v ?? '').length;

    it('reason (tiền tố ghép) dài ⇒ cắt còn đúng 255 ký tự, kết thúc bằng "…"; audit cũng ghi bản đã cắt', async () => {
      const f = seed();
      const { refundId } = await request(f, `Đổi trả: ${'rất dài '.repeat(100)}`);
      const stored = f.refund(must(refundId, 'refundId')).reason;
      expect(chars(stored)).toBe(255);
      expect(stored?.endsWith('…')).toBe(true);
      expect(stored?.startsWith('Đổi trả: rất dài')).toBe(true);
      expect(f.state.audits.find((a) => a.action === PAYMENT_AUDIT.REFUND_REQUESTED)).toMatchObject({ afterSummary: { reason: stored } });
    });

    it.each([0, 1, 100, 254, 255])('reason %i ký tự ⇒ giữ nguyên (không thêm "…")', async (n) => {
      const f = seed();
      const reason = 'ạ'.repeat(n);
      const { refundId } = await request(f, reason);
      expect(f.refund(must(refundId, 'refundId')).reason).toBe(reason);
    });

    it('256 ký tự ⇒ cắt còn 255 (254 ký tự + "…")', async () => {
      const f = seed();
      const { refundId } = await request(f, 'b'.repeat(256));
      expect(f.refund(must(refundId, 'refundId')).reason).toBe(`${'b'.repeat(254)}…`);
    });

    it('cắt theo ký tự (code point), không cắt đôi cặp surrogate của emoji ở ranh giới', async () => {
      const f = seed();
      const { refundId } = await request(f, `${'a'.repeat(253)}😀😀😀`); // 256 ký tự (code point)
      const stored = must(f.refund(must(refundId, 'refundId')).reason, 'reason');
      expect(chars(stored)).toBe(255);
      expect(stored).toBe(`${'a'.repeat(253)}😀…`); // 253 + 1 emoji + "…" = 255
      expect(Buffer.from(stored, 'utf8').toString('utf8')).toBe(stored); // không có surrogate lẻ
    });
  });

  // ------------------------------------------------------------------ #5 job đối soát xoay vòng
  describe('reconcileGatewayRefunds — xoay vòng công bằng (không bỏ đói lệnh mới)', () => {
    const rid = (n: number): string => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const stuckRows = (f: Fixture, n: number) => {
      const payment = f.seedPayos({ status: PAY_STATUS.PAID, paidAt: PAID_AT, version: 1, gatewayResponse: webhookData(ACCOUNT) });
      return Array.from({ length: n }, (_, i) =>
        f.seedRefund(payment, { id: rid(i + 1), amount: D(1_000), status: REFUND_STATUS.PROCESSING, gatewayStatus: GATEWAY_STATUS.SUBMITTED, gatewayPayoutId: `TX-${i + 1}`, gatewayAttempt: 1, gatewaySubmittedAt: minutesAgo(100 - i), updatedAt: minutesAgo(100 - i) }),
      );
    };
    const polled = (f: Fixture): string[] => f.getPayout.mock.calls.map((c) => c[0]);
    /* updated_at là mili-giây: nghỉ vài ms giữa các lượt để thứ tự "cũ nhất trước" không phụ thuộc may rủi hai lần ghi cùng một mili-giây. */
    const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

    it('lệnh chưa chốt được đánh dấu "vừa tra" (updated_at) ⇒ lượt sau tra lệnh CHƯA được tra trước; version không đổi', async () => {
      const f = buildFixture();
      stuckRows(f, 3);
      f.getPayout.mockResolvedValue({ state: 'processing', detail: 'PROCESSING' });

      await f.service.reconcileGatewayRefunds(2); // TX-1, TX-2
      await pause();
      await f.service.reconcileGatewayRefunds(2); // TX-3 (chưa được tra) rồi TX-1 (tra sớm nhất)
      await pause();
      await f.service.reconcileGatewayRefunds(2); // TX-2, rồi TX-3 hoặc TX-1

      expect(polled(f)).toHaveLength(6);
      expect(polled(f).slice(0, 4)).toEqual(['TX-1', 'TX-2', 'TX-3', 'TX-1']); // chưa tra thì tra trước; rồi mới vòng lại lệnh tra sớm nhất
      expect(new Set(polled(f).slice(2, 5)).size).toBe(3); // không lệnh nào được tra lần hai trước khi tất cả được tra
      expect(f.refund(rid(1)).version).toBe(0);
    });

    it('nhiều lệnh treo hơn `limit` + lệnh MỚI gửi sau ⇒ mọi lệnh được tra trong ceil(N/limit) lượt (không ai đói)', async () => {
      const f = buildFixture();
      stuckRows(f, 4);
      f.getPayout.mockResolvedValue({ state: 'processing', detail: 'PROCESSING' });
      const payment = [...f.state.payments.values()][0];
      // lệnh mới đi qua đường thật: chiếm → PayOS nhận (updated_at = bây giờ, mới nhất)
      const fresh = f.seedRefund(payment, { id: rid(9), amount: D(1_000) });
      await f.service.processRefund(actor, fresh.id, {});

      for (let i = 0; i < 3; i += 1) {
        await pause();
        await f.service.reconcileGatewayRefunds(2); // 5 lệnh, 2 lệnh/lượt ⇒ ≤ 3 lượt
      }

      expect(new Set(polled(f))).toEqual(new Set(['TX-1', 'TX-2', 'TX-3', 'TX-4', 'TX-123']));
    });

    it('lệnh được chốt thành công / thất bại không bị tra lại ở các lượt sau', async () => {
      const f = buildFixture();
      stuckRows(f, 2);
      f.getPayout.mockResolvedValueOnce({ state: 'succeeded', detail: 'SUCCEEDED' }).mockResolvedValue({ state: 'processing', detail: 'PROCESSING' });

      await f.service.reconcileGatewayRefunds(2);
      f.getPayout.mockClear();
      await f.service.reconcileGatewayRefunds(2);

      expect(polled(f)).toEqual(['TX-2']);
      expect(f.refund(rid(1)).status).toBe(REFUND_STATUS.DONE);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ #4 chỉ mục
  describe('migration 20261026100300_refund_indexes', () => {
    const root = join(__dirname, '../../../../prisma');
    const migration = readFileSync(join(root, 'migrations', '20261026100300_refund_indexes', 'migration.sql'), 'utf8');
    const schema = readFileSync(join(root, 'schema', 'payment.prisma'), 'utf8');
    const refundModel = schema.slice(schema.indexOf('model Refund {'), schema.indexOf('model ShopPayout {'));

    it.each([
      ['refunds_order_code_idx', 'order_code', 'orderCode'],
      ['refunds_payment_id_idx', 'payment_id', 'paymentId'],
      ['refunds_return_request_id_idx', 'return_request_id', 'returnRequestId'],
    ])('index %s trên payment.refunds(%s): IF NOT EXISTS, tên theo quy ước Prisma, có @@index([%s]) tương ứng', (name, column, field) => {
      expect(migration).toContain(`CREATE INDEX IF NOT EXISTS "${name}" ON "payment"."refunds" ("${column}");`);
      expect(refundModel).toContain(`@@index([${field}])`);
      expect(refundModel).toContain(`${field} `);
      expect(refundModel).toContain(`@map("${column}")`);
    });

    it('migration payment ĐÃ ÁP (100100) không bị sửa chỉ mục; migration mới đứng SAU nó và chỉ gồm CREATE INDEX', () => {
      expect('20261026100300_refund_indexes' > '20261026100100_return_roles_payment').toBe(true);
      const statements = migration
        .split('\n')
        .filter((l) => !l.startsWith('--') && l.trim() !== '')
        .map((l) => l.trim());
      expect(statements).toHaveLength(3);
      for (const st of statements) expect(st).toMatch(/^CREATE INDEX IF NOT EXISTS "refunds_[a-z_]+_idx" ON "payment"\."refunds" \("[a-z_]+"\);$/);
    });
  });
});

describe('PLAN-0043 — refund hãng giả không đi tiền thật', () => {
  it('refund mới bị chặn trước chi tiền và nhả claim về requested', async () => {
    const f = buildFixture({ payoutConfigured: true });
    const payment = f.seedPayos({ status: PAY_STATUS.PAID, receivedAmount: D(AMOUNT) });
    const refund = f.seedRefund(payment);
    f.orders.simulatedOrderCodes.mockResolvedValue(new Set([payment.orderCode]));
    await expect(f.service.processRefund(actor, refund.id, {})).rejects.toMatchObject({ errorCode: 'PAYMENT_SIMULATED_REAL_TRANSFER_BLOCKED' });
    expect(f.payout).not.toHaveBeenCalled();
    expect(f.refund(refund.id).status).toBe(REFUND_STATUS.REQUESTED);
  });
  it('job/đối soát lệnh refund fake đã submitted không tra endpoint thật', async () => {
    const f = buildFixture({ payoutConfigured: true });
    const payment = f.seedPayos({ status: PAY_STATUS.PAID, receivedAmount: D(AMOUNT) });
    const refund = f.seedRefund(payment, { status: REFUND_STATUS.PROCESSING, gatewaySubmittedAt: new Date(), gatewayPayoutId: 'MOCK-OLD' });
    f.orders.simulatedOrderCodes.mockResolvedValue(new Set([payment.orderCode]));
    await expect(f.service.processRefund(actor, refund.id, {})).rejects.toMatchObject({ errorCode: 'PAYMENT_SIMULATED_REAL_TRANSFER_BLOCKED' });
    expect(f.getPayout).not.toHaveBeenCalled();
    expect(f.payout).not.toHaveBeenCalled();
  });
  it('ghi sổ nốt không biến chứng từ fake thành refund thật sau đổi môi trường', async () => {
    const f = buildFixture({ payoutConfigured: true });
    const payment = f.seedPayos({ status: PAY_STATUS.PAID, receivedAmount: D(AMOUNT) });
    const refund = f.seedRefund(payment, { status: REFUND_STATUS.PROCESSING, providerRef: 'MOCK-REF' });
    f.orders.simulatedOrderCodes.mockResolvedValue(new Set([payment.orderCode]));
    await expect(f.service.retryFinalizeRefund(actor, refund.id)).rejects.toMatchObject({ errorCode: 'PAYMENT_SIMULATED_REAL_TRANSFER_BLOCKED' });
    expect(f.orders.onRefunded).not.toHaveBeenCalled();
  });
});
describe('PLAN-0043 — đơn fake không nhận link thu tiền thật', () => {
  it('checkout sau commit giữ payment pending và lỗi rõ ràng, không gọi PayOS', async () => {
    const f = buildFixture();
    const payment = f.seedPayos();
    f.orders.simulatedOrderCodes.mockResolvedValue(new Set([payment.orderCode]));
    const result = await f.service.createCheckoutLinks([payment.orderCode]);
    const response = result.get(payment.orderCode);
    expect(response && 'error' in response ? response.error : '').toContain('giả lập');
    expect(f.createLink).not.toHaveBeenCalled();
    expect(f.payment(payment.id).status).toBe(PAY_STATUS.PENDING);
  });
  it('retry fake bị chặn trước kéo dài hạn hoặc tạo link, không trả link cũ', async () => {
    const f = buildFixture();
    const payment = f.seedPayos();
    f.orders.simulatedOrderCodes.mockResolvedValue(new Set([payment.orderCode]));
    await expect(f.service.retryPayos({ ...actor, userId: payment.userId }, payment.orderCode)).rejects.toMatchObject({ errorCode: 'PAYMENT_SIMULATED_REAL_TRANSFER_BLOCKED' });
    expect(f.createLink).not.toHaveBeenCalled();
    expect(f.orders.extendPaymentDeadline).not.toHaveBeenCalled();
  });
  it('PayOS mock loopback vẫn tạo được link cho đơn fake', async () => {
    const f = buildFixture();
    const payment = f.seedPayment();
    f.env.EF_PAYOS_API_URL = 'http://127.0.0.1:4035';
    f.orders.simulatedOrderCodes.mockResolvedValue(new Set([payment.orderCode]));
    const result = await f.service.createCheckoutLinks([payment.orderCode]);
    expect(result.get(payment.orderCode)).toMatchObject({ paymentUrl: LINK_URL });
    expect(f.createLink).toHaveBeenCalledTimes(1);
  });
});
describe('PLAN-0043 — ẩn link thật cũ của nguồn giả lập', () => {
  it('chi tiết đơn không phát lại checkoutUrl đã lưu khi chuyển khỏi mock', async () => {
    const f = buildFixture(); const payment = f.seedPayos();
    f.orders.simulatedOrderCodes.mockResolvedValue(new Set([payment.orderCode]));
    await expect(f.service.extrasForOrder(payment.orderCode)).resolves.toMatchObject({ paymentUrl: null, linkRetryable: false });
  });
});