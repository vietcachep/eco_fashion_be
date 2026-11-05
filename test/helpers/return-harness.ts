/*
 * Bộ dựng test cho đổi trả (PLAN-0022): chạy các service THẬT (ReturnCoreService · ReturnService · ShopReturnService · AdminReturnService · ReturnSlaService) trên một
 * "Prisma trong bộ nhớ" nhỏ (kho yêu cầu + kho đơn, có rollback khi transaction ném lỗi) và các gateway giả (kho, thanh toán, thông báo, danh bạ nhân viên, shop).
 * Nhờ đó test kiểm được CẢ trạng thái sau cùng (máy trạng thái, tiền, kho, thông báo đúng người) chứ không chỉ "đã gọi hàm nào".
 * Chỉ dùng cho test — không import từ src/.
 */
import type { Env } from '@config/env';
import type { InventoryGateway } from '@common/gateway/inventory.gateway';
import type { NotifyCommand } from '@common/gateway/notification.gateway';
import type { PaymentGateway, RefundSummary } from '@common/gateway/payment.gateway';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ShopBrief, ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { SETTING_DEFAULTS } from '@modules/system/foundation/system.constants';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { AdminReturnService } from '@modules/order/return/admin-return.service';
import { ORDER_STATUS, PAYMENT_STATUS, RETURN_OPEN_STATUSES, RETURN_STATUS } from '@modules/order/foundation/order.constants';
import type { OrderRepository, OrderRow } from '@modules/order/order/repository/order.repository';
import type { ReturnRow } from '@modules/order/return/return.mapper';
import { ReturnCoreService } from '@modules/order/return/return-core.service';
import { ReturnSlaService } from '@modules/order/return/return-sla.service';
import { ReturnService } from '@modules/order/return/return.service';
import { ShopReturnService } from '@modules/order/return/shop-return.service';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const CUSTOMER = 'cust-1';
export const SHOP = 'shop-1';
export const OTHER_SHOP = 'shop-2';
export const SHOP_STAFF = 'shop-user-1';
export const CS_STAFF = 'cs-1';

export const D = (n: number | string) => new Prisma.Decimal(n);

export const customer: AuthenticatedActor = { userId: CUSTOMER, email: 'khach@fitly.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-c' };
export const shopUser: AuthenticatedActor = { userId: SHOP_STAFF, email: 'shop@fitly.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-s' };
export const csUser: AuthenticatedActor = { userId: CS_STAFF, email: 'cskh@fitly.vn', roleCode: 'sales', permissionVersion: 1, tokenId: 'jti-a' };

/* Minh chứng hợp lệ (kho upload cục bộ của hệ thống). */
export const OK_EVIDENCE = [{ type: 'image', url: '/static/uploads/user-media/abcd1234/1700000000-aaaa.jpg', name: '1.jpg' }];
export const REFUND_ACCOUNT = { bankBin: '970422', bankName: 'MB Bank', accountNumber: '0123456789', accountName: 'Nguyễn Văn A' };

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ dòng mẫu */

export function mkReturn(over: Partial<ReturnRow> = {}): ReturnRow {
  const now = new Date();
  const id = over.id ?? 'rr-1';
  return {
    id,
    orderId: 'o-1',
    orderCode: 'DH260001',
    userId: CUSTOMER,
    shopId: SHOP,
    status: RETURN_STATUS.REQUESTED,
    reasonCode: 'size_issue',
    requireReturn: true,
    reason: 'Không vừa size',
    detail: null,
    rejectReason: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectEvidence: [],
    refundAmount: D(100_000),
    calculatedRefundAmount: D(100_000),
    adjustReason: null,
    evidence: OK_EVIDENCE,
    refundAccount: null,
    returnAddress: null,
    approvedAt: null,
    approvedBy: null,
    carrier: null,
    trackingCode: null,
    shipBackNote: null,
    shippedBackAt: null,
    receivedAt: null,
    receivedBy: null,
    receivedCondition: null,
    receivedNote: null,
    receivedEvidence: [],
    escalatedAt: null,
    escalateReason: null,
    escalateSource: null,
    resolvedAt: null,
    resolvedBy: null,
    resolveDecision: null,
    resolveNote: null,
    processedBy: null,
    processedAt: null,
    refundedAt: null,
    closedAt: null,
    shopRespondDueAt: new Date(now.getTime() + 72 * HOUR),
    shipBackDueAt: null,
    shopReceiveDueAt: null,
    escalateDueAt: null,
    shopRemindedAt: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
    updatedBy: null,
    items: [{ id: `ri-${id}`, returnId: id, orderItemId: 'oi-1', variantId: 'var-1', name: 'Áo thun', color: 'Đen', size: 'M', quantity: 1, imageUrl: null, unitPrice: D(100_000) }],
    ...over,
  };
}

interface OrderLikeItem {
  id: string;
  variantId: string;
  name: string;
  color: string;
  size: string;
  quantity: number;
  imageUrl: string | null;
  unitPrice: Prisma.Decimal;
}
export interface OrderLike {
  id: string;
  code: string;
  userId: string;
  shopId: string;
  status: string;
  paymentStatus: string;
  paymentMethodCode: string;
  subtotal: Prisma.Decimal;
  shippingFee: Prisma.Decimal;
  total: Prisma.Decimal;
  itemCount: number;
  deliveredAt: Date | null;
  shippedAt: Date | null;
  shippingAlertedAt: Date | null;
  isDeleted: boolean;
  items: OrderLikeItem[];
}

/* Đơn đã giao hôm qua: 2 dòng (1 × 100.000 + 1 × 100.000), ship 0, tổng 200.000, đã thu qua PayOS. */
export function mkOrderLike(over: Partial<OrderLike> = {}): OrderLike {
  return {
    id: 'o-1',
    code: 'DH260001',
    userId: CUSTOMER,
    shopId: SHOP,
    status: ORDER_STATUS.DELIVERED,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMethodCode: 'payos',
    subtotal: D(200_000),
    shippingFee: D(0),
    total: D(200_000),
    itemCount: 2,
    deliveredAt: new Date(Date.now() - DAY),
    shippedAt: new Date(Date.now() - 3 * DAY),
    shippingAlertedAt: null,
    isDeleted: false,
    items: [
      { id: 'oi-1', variantId: 'var-1', name: 'Áo thun', color: 'Đen', size: 'M', quantity: 1, imageUrl: null, unitPrice: D(100_000) },
      { id: 'oi-2', variantId: 'var-2', name: 'Quần jean', color: 'Xanh', size: '30', quantity: 1, imageUrl: null, unitPrice: D(100_000) },
    ],
    ...over,
  };
}

/* ------------------------------------------------------------------ "Prisma" trong bộ nhớ */

const isDate = (v: unknown): v is Date => v instanceof Date;
const cmp = (a: unknown, b: unknown): number => {
  const x = isDate(a) ? a.getTime() : Number(a);
  const y = isDate(b) ? b.getTime() : Number(b);
  return x - y;
};

/* Bộ so khớp `where` đủ cho các truy vấn của service đổi trả: bằng · null · {in,notIn,not,lt,lte,gt,gte} · OR. */
export function matches(row: Row, where: Row | undefined): boolean {
  for (const [k, cond] of Object.entries(where ?? {})) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (isDate(cond)) {
      if (!isDate(v) || v.getTime() !== cond.getTime()) return false;
    } else if (typeof cond === 'object') {
      const c = cond as Row;
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      if ('notIn' in c && (c.notIn as unknown[]).includes(v)) return false;
      if ('not' in c && (c.not === null ? v === null || v === undefined : v === c.not)) return false;
      if ('lt' in c && !(v !== null && v !== undefined && cmp(v, c.lt) < 0)) return false;
      if ('lte' in c && !(v !== null && v !== undefined && cmp(v, c.lte) <= 0)) return false;
      if ('gt' in c && !(v !== null && v !== undefined && cmp(v, c.gt) > 0)) return false;
      if ('gte' in c && !(v !== null && v !== undefined && cmp(v, c.gte) >= 0)) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !isDate(v) && 'increment' in (v as Row)) row[k] = Number(row[k] ?? 0) + Number((v as Row).increment);
    else if (v === Prisma.DbNull) row[k] = null;
    else row[k] = v;
  }
}

function sortBy<T extends Row>(rows: T[], orderBy: Row | undefined): T[] {
  if (!orderBy) return rows;
  const [key, dir] = Object.entries(orderBy)[0] ?? [];
  if (!key) return rows;
  return [...rows].sort((a, b) => (dir === 'desc' ? -1 : 1) * cmp(a[key], b[key]));
}

export interface HarnessOptions {
  returns?: ReturnRow[];
  orders?: OrderLike[];
  settings?: Record<string, number>;
  /* Thành viên shop có shop.return.process (nhận việc). */
  shopMembers?: string[];
  staff?: string[];
}

/* Khoản hoàn trả về từ requestRefund giả: mặc định có khoản (refundId = 'rf-N'); đặt `null` để mô phỏng "không có khoản đã thu để hoàn". */
export function buildHarness(opts: HarnessOptions = {}) {
  const returns = new Map<string, ReturnRow>((opts.returns ?? []).map((r) => [r.id, { ...r }]));
  const orders = new Map<string, OrderLike>((opts.orders ?? [mkOrderLike()]).map((o) => [o.code, { ...o }]));
  const settings: Record<string, number> = { ...Object.fromEntries(Object.entries(SETTING_DEFAULTS).filter(([, d]) => typeof d.value === 'number').map(([k, d]) => [k, d.value as number])), ...(opts.settings ?? {}) };
  let seq = 0;

  const notes: Array<NotifyCommand> = [];
  const audits: Array<{ action: string; entityCode?: string | null; actor: unknown; before?: Row | null; after?: Row | null }> = [];
  const events: Array<{ eventType: string; payload: Row }> = [];
  const histories: Array<{ orderId: string; from: string | null; to: string; note: string | null }> = [];
  const refundCalls: Array<Parameters<PaymentGateway['requestRefund']>[0]> = [];
  /* COD-08b: các lần đảo ghi thu COD (PaymentGateway.reverseCodCollection) — đơn COD "chưa nhận hàng" KHÔNG đi qua refundCalls. */
  const reverseCalls: Array<Parameters<PaymentGateway['reverseCodCollection']>[0]> = [];
  const restocks: Array<{ lines: Array<{ variantId: string; quantity: number }>; ref: { type: string; id: string } }> = [];
  const refundSummaryMap = new Map<string, RefundSummary>();
  const control = { refundId: 'rf-1' as string | null, reversed: true, shopMembers: opts.shopMembers ?? [SHOP_STAFF], staff: opts.staff ?? [CS_STAFF], failNotify: false };

  const snapshot = () => ({ r: new Map([...returns].map(([k, v]) => [k, { ...v }])), o: new Map([...orders].map(([k, v]) => [k, { ...v }])), n: notes.length, a: audits.length, e: events.length, h: histories.length, rf: refundCalls.length, rv: reverseCalls.length, rs: restocks.length });

  const withItems = (r: ReturnRow): ReturnRow => r;

  const returnRequest = {
    findUnique: jest.fn((args: { where: { id: string } }): Promise<ReturnRow | null> => Promise.resolve(returns.get(args.where.id) ? withItems({ ...(returns.get(args.where.id) as ReturnRow) }) : null)),
    findUniqueOrThrow: jest.fn((args: { where: { id: string } }): Promise<ReturnRow> => {
      const r = returns.get(args.where.id);
      return r ? Promise.resolve({ ...r }) : Promise.reject(new Error('không có yêu cầu'));
    }),
    findFirst: jest.fn((args: { where: Row; orderBy?: Row }): Promise<ReturnRow | null> => Promise.resolve(sortBy([...returns.values()].filter((r) => matches(r as unknown as Row, args.where)) as unknown as Row[], args.orderBy)[0] as unknown as ReturnRow | null ?? null)),
    findMany: jest.fn((args: { where?: Row; orderBy?: Row; take?: number; skip?: number }): Promise<ReturnRow[]> => {
      const rows = sortBy([...returns.values()].filter((r) => matches(r as unknown as Row, args.where)) as unknown as Row[], args.orderBy) as unknown as ReturnRow[];
      return Promise.resolve(rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length)).map((r) => ({ ...r })));
    }),
    count: jest.fn((args: { where?: Row }): Promise<number> => Promise.resolve([...returns.values()].filter((r) => matches(r as unknown as Row, args.where)).length)),
    create: jest.fn((args: { data: Row & { items?: { create: Array<Row> } } }): Promise<ReturnRow> => {
      seq += 1;
      const id = `rr-new-${seq}`;
      const { items, ...rest } = args.data;
      const row = mkReturn({ id, shopRespondDueAt: null, calculatedRefundAmount: null, evidence: [], ...(Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === 'string' && ['refundAmount', 'calculatedRefundAmount'].includes(k) ? D(v) : v === Prisma.DbNull ? null : v])) as Partial<ReturnRow>), items: (items?.create ?? []).map((i, n) => ({ id: `ri-${seq}-${n}`, returnId: id, unitPrice: D(i.unitPrice as string), ...(i as object) })) as ReturnRow['items'] });
      returns.set(id, row);
      return Promise.resolve({ ...row });
    }),
    updateMany: jest.fn((args: { where: Row; data: Row }): Promise<{ count: number }> => {
      let count = 0;
      for (const r of returns.values()) {
        if (!matches(r, args.where)) continue;
        applyData(r, args.data);
        count += 1;
      }
      return Promise.resolve({ count });
    }),
    aggregate: jest.fn((args: { where: Row }): Promise<{ _sum: { refundAmount: Prisma.Decimal | null } }> => {
      const rows = [...returns.values()].filter((r) => matches(r as unknown as Row, args.where));
      return Promise.resolve({ _sum: { refundAmount: rows.length ? rows.reduce((s, r) => s.plus(r.refundAmount), D(0)) : null } });
    }),
  };

  const returnRequestItem = {
    aggregate: jest.fn((args: { where: { request: Row } }): Promise<{ _sum: { quantity: number | null } }> => {
      const rows = [...returns.values()].filter((r) => matches(r as unknown as Row, args.where.request));
      const q = rows.flatMap((r) => r.items).reduce((s, i) => s + i.quantity, 0);
      return Promise.resolve({ _sum: { quantity: rows.length ? q : null } });
    }),
  };

  const orderDelegate = {
    findMany: jest.fn((args: { where?: Row; orderBy?: Row; take?: number }): Promise<OrderLike[]> => {
      const rows = sortBy([...orders.values()].filter((o) => matches(o as unknown as Row, args.where)) as unknown as Row[], args.orderBy) as unknown as OrderLike[];
      return Promise.resolve(rows.slice(0, args.take ?? rows.length).map((o) => ({ ...o, id: o.id })));
    }),
    findUniqueOrThrow: jest.fn((args: { where: { id: string } }): Promise<OrderLike> => {
      const o = [...orders.values()].find((x) => x.id === args.where.id);
      return o ? Promise.resolve({ ...o }) : Promise.reject(new Error('không có đơn'));
    }),
    updateMany: jest.fn((args: { where: Row; data: Row }): Promise<{ count: number }> => {
      let count = 0;
      for (const o of orders.values()) {
        if (!matches(o as unknown as Row, args.where)) continue;
        applyData(o as unknown as Row, args.data);
        count += 1;
      }
      return Promise.resolve({ count });
    }),
  };

  const tx = {
    returnRequest,
    returnRequestItem,
    order: orderDelegate,
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<{ id: string }>> => {
      if (strings.join('?').includes('return_requests')) return Promise.resolve(returns.has(values[0] as string) ? [{ id: values[0] as string }] : []);
      return Promise.resolve([]);
    }),
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn: (t: Tx) => Promise<unknown>): Promise<unknown> => {
      const snap = snapshot();
      try {
        return await fn(tx as unknown as Tx);
      } catch (err) {
        returns.clear();
        for (const [k, v] of snap.r) returns.set(k, v);
        orders.clear();
        for (const [k, v] of snap.o) orders.set(k, v);
        notes.length = snap.n;
        audits.length = snap.a;
        events.length = snap.e;
        histories.length = snap.h;
        refundCalls.length = snap.rf;
        reverseCalls.length = snap.rv;
        restocks.length = snap.rs;
        throw err;
      }
    }),
  };

  /* Kho đơn giả — đúng các hàm OrderRepository mà service đổi trả dùng. */
  const ordersRepo = {
    findByCodeForUpdate: jest.fn((code: string, _tx: Tx): Promise<OrderRow | null> => Promise.resolve(orders.get(code) ? ({ ...(orders.get(code) as OrderLike) } as unknown as OrderRow) : null)),
    update: jest.fn((id: string, data: Row, _tx: Tx): Promise<OrderRow> => {
      const o = [...orders.values()].find((x) => x.id === id) as OrderLike;
      applyData(o as unknown as Row, data);
      return Promise.resolve({ ...o } as unknown as OrderRow);
    }),
    addHistory: jest.fn((orderId: string, from: string | null, to: string, note: string | null, _actor: string | null, _tx: Tx): Promise<void> => {
      histories.push({ orderId, from, to, note });
      return Promise.resolve();
    }),
    returnedQtyByItem: jest.fn((orderIds: string[], _tx?: Tx | null): Promise<Map<string, number>> => {
      const out = new Map<string, number>();
      const now = new Date();
      for (const r of returns.values()) {
        if (!orderIds.includes(r.orderId)) continue;
        const counted = [...RETURN_OPEN_STATUSES, RETURN_STATUS.REFUNDED].includes(r.status as never) || (r.status === RETURN_STATUS.REJECTED && r.rejectedBy === 'shop' && !!r.escalateDueAt && r.escalateDueAt > now);
        if (!counted) continue;
        for (const i of r.items) out.set(i.orderItemId, (out.get(i.orderItemId) ?? 0) + i.quantity);
      }
      return Promise.resolve(out);
    }),
  };

  const brief = (id: string): ShopBrief => ({ id, code: id.toUpperCase(), slug: id, name: `Shop ${id}`, logoUrl: null, ratingAvg: null, status: 'approved', commissionRate: '5.00' });
  const shops = {
    findManyBrief: jest.fn((ids: string[]): Promise<Map<string, ShopBrief>> => Promise.resolve(new Map([...new Set(ids)].map((id) => [id, brief(id)])))),
    memberUserIdsWithPermission: jest.fn((_shopId: string, _perm: string): Promise<string[]> => Promise.resolve([...control.shopMembers])),
  };
  const payment = {
    cancel:jest.fn((_code:string,_reason:string,_tx:Tx)=>Promise.resolve()),
    requestRefund: jest.fn((input: Parameters<PaymentGateway['requestRefund']>[0], _tx: Tx): Promise<{ refundId: string | null }> => {
      refundCalls.push(input);
      return Promise.resolve({ refundId: control.refundId });
    }),
    reverseCodCollection: jest.fn((input: Parameters<PaymentGateway['reverseCodCollection']>[0], _tx: Tx): Promise<{ reversed: boolean }> => {
      reverseCalls.push(input);
      return Promise.resolve({ reversed: control.reversed });
    }),
    refundSummaries: jest.fn((codes: string[]): Promise<Map<string, RefundSummary>> => Promise.resolve(new Map(codes.filter((c) => refundSummaryMap.has(c)).map((c) => [c, refundSummaryMap.get(c) as RefundSummary])))),
  };
  const inventory = {
    restock: jest.fn((lines: Array<{ variantId: string; quantity: number }>, ref: { type: string; id: string }, _tx: Tx): Promise<void> => {
      restocks.push({ lines, ref });
      return Promise.resolve();
    }),
  };
  const notify = {
    notify: jest.fn((cmd: NotifyCommand, _tx?: Tx): Promise<void> => {
      if (control.failNotify) return Promise.reject(new Error('notify lỗi'));
      notes.push(cmd);
      return Promise.resolve();
    }),
    notifyMany: jest.fn((cmds: NotifyCommand[], _tx?: Tx): Promise<void> => {
      if (control.failNotify) return Promise.reject(new Error('notify lỗi'));
      notes.push(...cmds);
      return Promise.resolve();
    }),
  };
  const users = { staffUserIdsWithPermission: jest.fn((_perm: string): Promise<string[]> => Promise.resolve([...control.staff])), findSnapshot: jest.fn(), findSnapshots: jest.fn() };
  const audit = {
    write: jest.fn((_tx: Tx | null, actor: unknown, entry: { action: string; entityCode?: string | null; before?: Row | null; after?: Row | null }): Promise<void> => {
      audits.push({ action: entry.action, entityCode: entry.entityCode, actor, before: entry.before, after: entry.after });
      return Promise.resolve();
    }),
  };
  const outbox = {
    publish: jest.fn((_tx: Tx | null, evt: { eventType: string; payload: Row }): Promise<void> => {
      events.push({ eventType: evt.eventType, payload: evt.payload });
      return Promise.resolve();
    }),
  };
  const system = { settingNumber: jest.fn((key: string): Promise<number> => Promise.resolve(settings[key] ?? 0)) };
  const env = { EF_CLOUDINARY_CLOUD_NAME: 'demo', EF_API_PUBLIC_URL: 'https://api.fitly.vn' } as unknown as Env;

  const core = new ReturnCoreService(
    prisma as unknown as PrismaService,
    ordersRepo as unknown as OrderRepository,
    audit as never,
    outbox as never,
    shops as unknown as ShopQueryApi,
    inventory as unknown as InventoryGateway,
    payment as unknown as PaymentGateway,
    notify,
    users,
    env,
  );
  const customerSvc = new ReturnService(prisma as unknown as PrismaService, ordersRepo as unknown as OrderRepository, audit as never, outbox as never, system as unknown as SystemQueryApi, core);
  const shopSvc = new ShopReturnService(prisma as unknown as PrismaService, audit as never, system as unknown as SystemQueryApi, core);
  const adminSvc = new AdminReturnService(prisma as unknown as PrismaService, audit as never, core);
  const sla = new ReturnSlaService(prisma as unknown as PrismaService, system as unknown as SystemQueryApi, audit as never, core);

  return {
    customerSvc,
    shopSvc,
    adminSvc,
    sla,
    core,
    tx: tx as unknown as Tx,
    returns,
    orders,
    notes,
    audits,
    events,
    histories,
    refundCalls,
    reverseCalls,
    restocks,
    refundSummaryMap,
    control,
    settings,
    mocks: { prisma, payment, inventory, notify, shops, users, ordersRepo, returnRequest, audit, outbox },
    /* Tiện đọc */
    ret: (id = 'rr-1'): ReturnRow => returns.get(id) as ReturnRow,
    order: (code = 'DH260001'): OrderLike => orders.get(code) as OrderLike,
    notesTo: (userId: string) => notes.filter((n) => n.userId === userId),
    auditActions: () => audits.map((a) => a.action),
    eventTypes: () => events.map((e) => `${e.eventType}:${typeof e.payload.to === 'string' ? e.payload.to : ''}`),
  };
}

export type Harness = ReturnType<typeof buildHarness>;

export { SETTING_KEY, RETURN_STATUS };
