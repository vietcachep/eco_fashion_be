import { randomUUID } from 'node:crypto';
import { BusinessException } from '@common/exception/business.exception';
import type { NotificationGateway, NotifyCommand } from '@common/gateway/notification.gateway';
import type { UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { Env } from '@config/env';
import type { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { PaymentAuditLogService } from '../audit/payment-audit-log.service';
import { TOPUP_OPEN_STATUSES, TOPUP_STATUS_VALUES } from '../foundation/payment.constants';
import { PayosService } from '../payos/payos.service';
import { ShopWalletService } from './shop-wallet.service';
import { ShopWalletTopupSettleService } from './shop-wallet-topup-settle.service';
import { ShopWalletTopupService } from './shop-wallet-topup.service';

/*
 * FIXTURE DB GIẢ cho test nạp cọc PayOS (PLAN-0041 §9.1, WP-4). Không phải mock rời rạc: đây là một "Postgres trong bộ nhớ" tối thiểu nhưng có NGỮ NGHĨA GIAO DỊCH:
 *  - Mỗi transaction có lớp ghi chồng (overlay) — chỉ commit mới lộ ra cho giao dịch khác; rollback bỏ overlay (hoàn tác thật, không đếm ngược).
 *  - Đọc theo READ COMMITTED: mỗi câu đọc thấy dữ liệu đã commit tại thời điểm đọc + chính mình ghi.
 *  - Khoá dòng FOR UPDATE (và khoá ngầm khi UPDATE) theo hàng đợi FIFO; vòng chờ khoá ⇒ 40P01 cho nạn nhân (đếm trong `deadlocks`).
 *  - Unique chờ giao dịch khác đang ghi cùng khoá (đúng ngữ nghĩa Postgres): commit ⇒ P2002 (lỗi Prisma thật), rollback ⇒ được ghi.
 *  - Lỗi DB (P2002/23514/23503/40P01/25P02) làm giao dịch hỏng: câu sau trong CÙNG giao dịch ném 25P02 (bài học AGENTS: không bắt P2002 rồi làm tiếp).
 *  - CHECK (`topup_payos` dương + có khoá nguồn, mã PayOS dải 5e15, status), FK, NOT NULL, cột không tồn tại ⇒ ném.
 * Đồng hồ giả: chỉ `Date` bị giả (jest.useFakeTimers với doNotFake = mọi timer) ⇒ không phụ thuộc thời gian thật; setTimeout của retryOnDeadlock vẫn chạy thật (50–100 ms).
 * Mạng: `fetch` toàn cục bị chặn; PayosService THẬT với 3 hàm gọi mạng bị spy (createPaymentLink / getPaymentLink / cancelPaymentLink).
 * Chỉ dùng bề mặt Prisma của PLAN-0041 §6.2 (+ `paymentAuditLog` cho PaymentAuditLogService và `shopCodDeposit` cho approveDeposit).
 */

type Dec = Prisma.Decimal;
export type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;
type OrderBy = Record<string, 'asc' | 'desc'>;

export const NOW = Date.UTC(2026, 10, 3, 10, 0, 0); // 2026-11-03T10:00:00Z
export const SHOP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SHOP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const SHOP_OFFICIAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const OWNER_A: AuthenticatedActor = { userId: '10000000-0000-4000-8000-00000000000a', email: 'chu-a@shop.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-owner-a' };
export const ACCOUNTANT: AuthenticatedActor = { userId: '20000000-0000-4000-8000-0000000000ac', email: 'ketoan@fitly.vn', roleCode: 'accountant', permissionVersion: 1, tokenId: 'jti-acc' };
export const ACCOUNTANT_ID = ACCOUNTANT.userId;
export const OWNER_A_ID = OWNER_A.userId;

/* ---------------------------------------------------------------- lỗi giống Postgres / Prisma ---- */

const DB_ERR = Symbol('db-error');
const isDbError = (e: unknown): boolean => typeof e === 'object' && e !== null && DB_ERR in e;
const tagDb = <E extends object>(e: E): E => Object.assign(e, { [DB_ERR]: true });
const pgError = (code: string, message: string): Error => tagDb(Object.assign(new Error(message), { code }));

/* P2002 là lỗi Prisma THẬT (instanceof PrismaClientKnownRequestError) để isPrismaError() của production nhận ra. */
export function p2002(target: string[]): Error {
  const err = new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (${target.map((t) => `\`${t}\``).join(',')})`, {
    code: 'P2002',
    clientVersion: 'fixture',
    meta: { target },
  });
  return tagDb(err);
}
export const deadlockError = (): Error => pgError('40P01', 'deadlock detected');

/* ---------------------------------------------------------------- kiểu & so khớp where ---- */

const OPS = new Set(['in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'equals', 'mode']);
const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !(v instanceof Date) && !Prisma.Decimal.isDecimal(v) && !Array.isArray(v);
const isOpObject = (v: unknown): v is Record<string, unknown> => isPlain(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => OPS.has(k));
const isNumeric = (v: unknown): boolean => typeof v === 'number' || Prisma.Decimal.isDecimal(v) || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
const toDec = (v: unknown): Dec => (Prisma.Decimal.isDecimal(v) ? v : new Prisma.Decimal(v as string | number));
const dec = (v: unknown): Dec => toDec(v);

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (isNumeric(a) && isNumeric(b)) return toDec(a).equals(toDec(b));
  return false;
}

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() - new Date(b as Date).getTime();
  if (isNumeric(a) && isNumeric(b)) return toDec(a).comparedTo(toDec(b));
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function applyOp(op: string, actual: unknown, arg: unknown): boolean {
  switch (op) {
    case 'in':
      return (arg as unknown[]).some((v) => eq(actual, v));
    case 'notIn':
      return !(arg as unknown[]).some((v) => eq(actual, v));
    case 'not':
      return arg === null ? actual !== null && actual !== undefined : !eq(actual, arg);
    case 'equals':
      return eq(actual, arg);
    case 'mode':
      return true;
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (actual === null || actual === undefined) return false;
      const c = cmp(actual, arg);
      return op === 'lt' ? c < 0 : op === 'lte' ? c <= 0 : op === 'gt' ? c > 0 : c >= 0;
    }
    default:
      throw new Error(`Toán tử where chưa hỗ trợ trong DB giả: ${op}`);
  }
}

/* Bộ so khớp where kiểu Prisma (bằng, null, in, not, lt/lte/gt/gte, AND/OR/NOT). Toán tử lạ ⇒ ném để test không "đúng nhầm". */
export function matchWhere(row: Row, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(cond as Where[]).every((c) => matchWhere(row, c))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(cond as Where[]).some((c) => matchWhere(row, c))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matchWhere(row, cond as Where)) return false;
      continue;
    }
    const actual = row[key];
    if (cond === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (isOpObject(cond)) {
      for (const [op, arg] of Object.entries(cond)) if (!applyOp(op, actual, arg)) return false;
      continue;
    }
    if (!eq(actual, cond)) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- mô hình bảng ---- */

interface Unique {
  target: readonly string[];
  key: (r: Row) => string | null; // null ⇒ không ràng buộc (giống NULL trong Postgres)
}
interface Check {
  name: string;
  ok: (r: Row) => boolean;
}
interface Model {
  table: string;
  loose: boolean;
  fields: readonly string[];
  decimals: readonly string[];
  required: readonly string[];
  defaults: Readonly<Record<string, () => unknown>>;
  autoUpdatedAt: boolean;
  uniques: readonly Unique[];
  checks: readonly Check[];
  fks: Readonly<Record<string, string>>;
}

const now = (): Date => new Date();
const str = (v: unknown): string => String(v);
const OPEN: readonly string[] = TOPUP_OPEN_STATUSES;
const gt0 = (v: unknown): boolean => dec(v).gt(0);
const gte0 = (v: unknown): boolean => dec(v).gte(0);

const TOPUP: Model = {
  table: 'shop_cod_topups',
  loose: false,
  fields: ['id', 'shopId', 'amount', 'payosOrderCode', 'paymentLinkId', 'checkoutUrl', 'qrCode', 'status', 'receivedAmount', 'polledAmount', 'expiresAt', 'paidAt', 'closedAt', 'lastCheckedAt', 'lastGatewayStatus', 'linkError', 'requestedBy', 'cancelledBy', 'version', 'createdAt', 'updatedAt'],
  decimals: ['amount', 'receivedAmount', 'polledAmount'],
  required: ['shopId', 'amount', 'payosOrderCode', 'expiresAt'],
  defaults: { status: () => 'creating', receivedAmount: () => dec(0), polledAmount: () => dec(0), version: () => 0, createdAt: now, updatedAt: now },
  autoUpdatedAt: true,
  uniques: [
    { target: ['payos_order_code'], key: (r) => str(r.payosOrderCode) }, // shop_cod_topups_payos_order_code_key
    { target: ['shop_id'], key: (r) => (OPEN.includes(str(r.status)) ? str(r.shopId) : null) }, // uq_shop_cod_topups_active_per_shop (partial)
  ],
  checks: [
    { name: 'chk_shop_cod_topups_status', ok: (r) => TOPUP_STATUS_VALUES.includes(str(r.status)) },
    { name: 'chk_shop_cod_topups_amounts', ok: (r) => gt0(r.amount) && gte0(r.receivedAmount) && gte0(r.polledAmount) },
    { name: 'chk_shop_cod_topups_code', ok: (r) => /^[5-8][0-9]{15}$/.test(str(r.payosOrderCode)) },
  ],
  fks: {},
};

const RECEIPT: Model = {
  table: 'shop_cod_topup_receipts',
  loose: false,
  fields: ['id', 'topupId', 'reference', 'amount', 'raw', 'createdAt'],
  decimals: ['amount'],
  required: ['topupId', 'reference', 'amount'],
  defaults: { createdAt: now },
  autoUpdatedAt: false,
  uniques: [{ target: ['topup_id', 'reference'], key: (r) => `${str(r.topupId)}|${str(r.reference)}` }],
  checks: [{ name: 'chk_shop_cod_topup_receipts_amount', ok: (r) => gt0(r.amount) }],
  fks: { topupId: 'shop_cod_topups' },
};

const WALLET: Model = {
  table: 'shop_cod_wallets',
  loose: false,
  fields: ['id', 'shopId', 'balance', 'version', 'createdAt', 'updatedAt'],
  decimals: ['balance'],
  required: ['shopId'],
  defaults: { balance: () => dec(0), version: () => 0, createdAt: now, updatedAt: now },
  autoUpdatedAt: true,
  uniques: [{ target: ['shop_id'], key: (r) => str(r.shopId) }],
  checks: [],
  fks: {},
};

const LEDGER: Model = {
  table: 'shop_cod_wallet_transactions',
  loose: false,
  fields: ['id', 'walletId', 'shopId', 'type', 'amount', 'balanceAfter', 'orderCode', 'depositId', 'topupId', 'refKey', 'note', 'meta', 'createdBy', 'createdAt'],
  decimals: ['amount', 'balanceAfter'],
  required: ['walletId', 'shopId', 'type', 'amount', 'balanceAfter'],
  defaults: { createdAt: now },
  autoUpdatedAt: false,
  uniques: [
    { target: ['shop_id', 'type', 'order_code'], key: (r) => (r.orderCode === null || r.orderCode === undefined ? null : `${str(r.shopId)}|${str(r.type)}|${str(r.orderCode)}`) },
    { target: ['ref_key'], key: (r) => (r.refKey === null || r.refKey === undefined ? null : str(r.refKey)) }, // uq_shop_cod_wallet_tx_ref_key (partial)
  ],
  checks: [{ name: 'chk_shop_cod_wallet_tx_topup', ok: (r) => r.type !== 'topup_payos' || (r.topupId !== null && r.topupId !== undefined && r.refKey !== null && r.refKey !== undefined && gt0(r.amount)) }],
  fks: { walletId: 'shop_cod_wallets' },
};

/* Yêu cầu nộp cọc tay (bảng cũ, PLAN-0020): status mặc định 'pending' như DB (`@default("pending")`) — production không ghi status khi tạo. */
const DEPOSIT: Model = { table: 'shop_cod_deposits', loose: true, fields: [], decimals: ['amount'], required: [], defaults: { status: () => 'pending', createdAt: now }, autoUpdatedAt: false, uniques: [], checks: [], fks: {} };
const AUDIT: Model = { table: 'payment_audit_logs', loose: true, fields: [], decimals: [], required: [], defaults: { createdAt: now }, autoUpdatedAt: false, uniques: [], checks: [], fks: {} };

/* Tên delegate Prisma → mô hình. */
const DELEGATES: Record<string, Model> = {
  shopCodTopup: TOPUP,
  shopCodTopupReceipt: RECEIPT,
  shopCodWallet: WALLET,
  shopCodWalletTransaction: LEDGER,
  shopCodDeposit: DEPOSIT,
  paymentAuditLog: AUDIT,
};

/* ---------------------------------------------------------------- engine giao dịch ---- */

interface TxCtx {
  id: number;
  writes: Map<string, Map<string, Row>>;
  held: Set<string>;
  waiting: null | { lock: string } | { tx: TxCtx };
  aborted: boolean;
  finished: boolean;
  done: Promise<void>;
  finish: () => void;
}
interface LockState {
  holder: TxCtx | null;
  queue: Array<{ tx: TxCtx; grant: () => void }>;
}
export interface CallLog {
  tx: number | null;
  label: string;
}

const copy = (r: Row): Row => ({ ...r });

export class TopupEngine {
  readonly committed = new Map<string, Map<string, Row>>();
  readonly active = new Set<TxCtx>();
  readonly calls: CallLog[] = [];
  readonly locks = new Map<string, LockState>();
  /* Số lần phát hiện vòng chờ khoá (40P01). Test đồng thời phải khẳng định = 0 khi thứ tự khoá đúng. */
  deadlocks = 0;
  private txSeq = 0;
  private gate: { size: number; arrived: number; open: Promise<void>; release: () => void } | null = null;
  private readonly injections: Array<{ re: RegExp; err: Error; left: number }> = [];
  private readonly pauses: Array<{ re: RegExp; hit: boolean; reached: () => void; gate: Promise<void> }> = [];

  /* ---- điều khiển thử nghiệm ---- */

  /* Đánh dấu một sự kiện ngoài DB vào nhật ký (vd gọi PayOS) để kiểm THỨ TỰ. */
  mark(label: string): void {
    this.calls.push({ tx: null, label });
  }
  /* n `$transaction` đầu tiên bắt đầu cùng lúc: chúng chờ nhau ở cửa vào ⇒ xen kẽ thật sự. */
  gateTransactions(size: number): void {
    let release!: () => void;
    const open = new Promise<void>((r) => {
      release = r;
    });
    this.gate = { size, arrived: 0, open, release };
  }
  /* Dừng transaction ở lần đầu có nhãn khớp `re` (trước khi thực thi); test gọi `resume` để chạy tiếp. */
  pauseOn(re: RegExp): { reached: Promise<void>; resume: () => void } {
    let markReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => {
      markReached = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.pauses.push({ re, hit: false, reached: markReached, gate });
    return { reached, resume: release };
  }
  /* Câu lệnh đầu tiên có nhãn khớp `re` ném `err` (lỗi DB giả lập: rollback thật). */
  failOn(re: RegExp, err: Error, times = 1): void {
    this.injections.push({ re, err: tagDb(err), left: times });
  }
  openTxCount(): number {
    return this.active.size;
  }
  labelsOf(txId: number): string[] {
    return this.calls.filter((c) => c.tx === txId).map((c) => c.label);
  }

  /* ---- trung tâm: mọi câu lệnh đi qua đây ---- */

  async run<T>(tx: TxCtx | null, label: string, fn: (t: TxCtx) => Promise<T>): Promise<T> {
    if (tx) return this.step(tx, label, fn);
    const t = this.begin();
    try {
      const r = await this.step(t, label, fn);
      this.commit(t);
      return r;
    } catch (e) {
      this.rollback(t);
      throw e;
    }
  }

  private async step<T>(t: TxCtx, label: string, fn: (t: TxCtx) => Promise<T>): Promise<T> {
    this.calls.push({ tx: t.id, label });
    try {
      if (t.aborted) throw pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
      await this.hook(label);
      return await fn(t);
    } catch (e) {
      if (isDbError(e)) t.aborted = true;
      throw e;
    }
  }

  private async hook(label: string): Promise<void> {
    const inj = this.injections.find((i) => i.left > 0 && i.re.test(label));
    if (inj) {
      inj.left -= 1;
      throw inj.err;
    }
    for (const p of this.pauses) {
      if (!p.hit && p.re.test(label)) {
        p.hit = true;
        p.reached();
        await p.gate;
      }
    }
  }

  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    await this.enterGate();
    const t = this.begin();
    this.calls.push({ tx: t.id, label: '$transaction BEGIN' });
    try {
      const r = await fn(this.clientFor(t));
      this.commit(t);
      this.calls.push({ tx: t.id, label: 'COMMIT' });
      return r;
    } catch (e) {
      this.rollback(t);
      this.calls.push({ tx: t.id, label: 'ROLLBACK' });
      throw e;
    }
  }

  private async enterGate(): Promise<void> {
    const g = this.gate;
    if (!g) return;
    g.arrived += 1;
    if (g.arrived >= g.size) {
      this.gate = null;
      g.release();
    }
    await g.open;
  }

  /* ---- vòng đời giao dịch ---- */

  private begin(): TxCtx {
    const t: TxCtx = { id: ++this.txSeq, writes: new Map(), held: new Set(), waiting: null, aborted: false, finished: false, done: Promise.resolve(), finish: () => undefined };
    t.done = new Promise<void>((r) => {
      t.finish = r;
    });
    this.active.add(t);
    return t;
  }

  private commit(t: TxCtx): void {
    if (t.finished) return;
    if (t.aborted) {
      this.end(t);
      throw pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    }
    for (const [table, rows] of t.writes) {
      const m = this.committedMap(table);
      for (const [id, row] of rows) m.set(id, row);
    }
    this.end(t);
  }

  private rollback(t: TxCtx): void {
    if (!t.finished) this.end(t);
  }

  private end(t: TxCtx): void {
    t.finished = true;
    this.active.delete(t);
    for (const key of t.held) {
      const st = this.locks.get(key);
      if (!st) continue;
      st.holder = null;
      const next = st.queue.shift();
      if (next) {
        st.holder = next.tx;
        next.tx.held.add(key);
        next.tx.waiting = null;
        next.grant();
      }
    }
    t.held.clear();
    t.finish();
  }

  /* ---- khoá ---- */

  private blockerOf(t: TxCtx): TxCtx | null {
    const w = t.waiting;
    if (!w) return null;
    if ('tx' in w) return w.tx;
    return this.locks.get(w.lock)?.holder ?? null;
  }

  private wouldDeadlock(me: TxCtx, first: TxCtx | null): boolean {
    const seen = new Set<TxCtx>();
    for (let cur = first; cur && !seen.has(cur); cur = this.blockerOf(cur)) {
      if (cur === me) return true;
      seen.add(cur);
    }
    return false;
  }

  async lockRow(t: TxCtx, table: string, id: string): Promise<void> {
    const key = `${table}:${id}`;
    if (t.held.has(key)) return;
    let st = this.locks.get(key);
    if (!st) {
      st = { holder: null, queue: [] };
      this.locks.set(key, st);
    }
    if (!st.holder) {
      st.holder = t;
      t.held.add(key);
      return;
    }
    if (this.wouldDeadlock(t, st.holder)) {
      this.deadlocks += 1;
      throw tagDb(deadlockError());
    }
    t.waiting = { lock: key };
    await new Promise<void>((grant) => st.queue.push({ tx: t, grant }));
  }

  private async waitTx(t: TxCtx, other: TxCtx): Promise<void> {
    if (this.wouldDeadlock(t, other)) {
      this.deadlocks += 1;
      throw tagDb(deadlockError());
    }
    t.waiting = { tx: other };
    await other.done;
    t.waiting = null;
  }

  /* ---- đọc ---- */

  private committedMap(table: string): Map<string, Row> {
    let m = this.committed.get(table);
    if (!m) {
      m = new Map();
      this.committed.set(table, m);
    }
    return m;
  }

  private visible(t: TxCtx, table: string): Row[] {
    const merged = new Map<string, Row>(this.committed.get(table) ?? []);
    const own = t.writes.get(table);
    if (own) for (const [id, r] of own) merged.set(id, r);
    return [...merged.values()];
  }

  private visibleById(t: TxCtx, table: string, id: string): Row | null {
    return t.writes.get(table)?.get(id) ?? this.committed.get(table)?.get(id) ?? null;
  }

  /* Dòng đã commit (không tính overlay của giao dịch đang chạy) — dùng cho test kiểm sổ sau khi xong. */
  rows(table: string): Row[] {
    return [...(this.committed.get(table)?.values() ?? [])].map(copy);
  }

  findRows(t: TxCtx, m: Model, where: Where, orderBy?: OrderBy | OrderBy[], skip = 0, take?: number): Row[] {
    let rows = this.visible(t, m.table).filter((r) => matchWhere(r, where));
    const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o)) : [];
    if (keys.length > 0) {
      rows = rows.sort((a, b) => {
        for (const [k, dir] of keys) {
          const c = a[k] === null || a[k] === undefined || b[k] === null || b[k] === undefined ? 0 : cmp(a[k], b[k]);
          if (c !== 0) return dir === 'desc' ? -c : c;
        }
        return 0;
      });
    }
    return rows.slice(skip, take === undefined ? undefined : skip + take).map(copy);
  }

  /* ---- ghi ---- */

  private assertField(m: Model, k: string): void {
    if (!m.loose && !m.fields.includes(k)) throw new Error(`Cột "${k}" không có trong model ${m.table} (DB giả)`);
  }

  private norm(m: Model, k: string, v: unknown): unknown {
    if (v === null || v === undefined) return null;
    return m.decimals.includes(k) ? toDec(v) : v;
  }

  private materialize(m: Model, data: Record<string, unknown>): Row {
    const row = { id: typeof data.id === 'string' ? data.id : randomUUID() } as Row;
    for (const [k, mk] of Object.entries(m.defaults)) row[k] = mk();
    for (const f of m.fields) if (!(f in row) && f !== 'id') row[f] = null;
    for (const [k, v] of Object.entries(data)) {
      if (k === 'id') continue;
      this.assertField(m, k);
      row[k] = this.norm(m, k, v);
    }
    for (const f of m.required) if (row[f] === null || row[f] === undefined) throw pgError('23502', `null value in column "${f}" of relation "${m.table}" violates not-null constraint`);
    return row;
  }

  private applyUpdate(m: Model, cur: Row, data: Record<string, unknown>): Row {
    const next = copy(cur);
    for (const [k, v] of Object.entries(data)) {
      this.assertField(m, k);
      if (isPlain(v) && 'increment' in v) {
        const inc = v.increment;
        next[k] = m.decimals.includes(k) ? dec(next[k]).add(dec(inc)) : (next[k] as number) + (inc as number);
        continue;
      }
      next[k] = this.norm(m, k, v);
    }
    if (m.autoUpdatedAt) next.updatedAt = now();
    return next;
  }

  private put(t: TxCtx, table: string, row: Row): void {
    let own = t.writes.get(table);
    if (!own) {
      own = new Map();
      t.writes.set(table, own);
    }
    own.set(row.id, row);
  }

  /*
   * Ràng buộc của MỘT dòng ứng viên (CHECK, FK, unique) RỒI GHI overlay — kiểm và ghi nằm trong CÙNG một đoạn đồng bộ (không await giữa hai bước).
   * Nếu tách kiểm và ghi bằng await, giao dịch khác có thể chen vào giữa, cùng qua kiểm và cùng ghi (lỗi check-then-act). Chỉ chờ khi có giao dịch khác đang giữ cùng khoá unique.
   */
  private async guardAndPut(t: TxCtx, m: Model, row: Row): Promise<void> {
    for (const ck of m.checks) if (!ck.ok(row)) throw tagDb(pgError('23514', `new row for relation "${m.table}" violates check constraint "${ck.name}"`));
    for (const [field, parent] of Object.entries(m.fks)) {
      const pid = row[field];
      if (pid === null || pid === undefined) continue;
      if (!this.visible(t, parent).some((r) => r.id === pid)) throw tagDb(pgError('23503', `insert or update on table "${m.table}" violates foreign key constraint "${field}"`));
    }
    for (;;) {
      const blocker = this.uniqueBlocker(t, m, row);
      if (blocker) {
        await this.waitTx(t, blocker.tx);
        continue;
      }
      const hit = this.uniqueConflict(t, m, row);
      if (hit) throw tagDb(p2002([...hit.target]));
      this.put(t, m.table, row);
      return;
    }
  }

  /* Giao dịch khác đang ghi (chưa commit) cùng khoá unique ⇒ Postgres CHỜ nó kết thúc. */
  private uniqueBlocker(t: TxCtx, m: Model, row: Row): { tx: TxCtx } | null {
    for (const u of m.uniques) {
      const k = u.key(row);
      if (k === null) continue;
      for (const o of this.active) {
        if (o === t) continue;
        const ow = o.writes.get(m.table);
        if (!ow) continue;
        for (const [id, r] of ow) {
          if (id === row.id) continue;
          const committedRow = this.committed.get(m.table)?.get(id);
          if ((u.key(r) === k) || (committedRow && u.key(committedRow) === k)) return { tx: o };
        }
      }
    }
    return null;
  }

  private uniqueConflict(t: TxCtx, m: Model, row: Row): Unique | null {
    for (const u of m.uniques) {
      const k = u.key(row);
      if (k === null) continue;
      if (this.visible(t, m.table).some((x) => x.id !== row.id && u.key(x) === k)) return u;
    }
    return null;
  }

  private async create(t: TxCtx, m: Model, data: Record<string, unknown>): Promise<Row> {
    const row = this.materialize(m, data);
    await this.guardAndPut(t, m, row);
    return copy(row);
  }

  /* Khoá các dòng khớp `where` rồi đọc LẠI (như Postgres sau khi chờ khoá): dòng đổi trong lúc chờ mà không còn khớp ⇒ bỏ qua. */
  private async lockMatching(t: TxCtx, m: Model, where: Where): Promise<Row[]> {
    const candidates = this.visible(t, m.table).filter((r) => matchWhere(r, where));
    const out: Row[] = [];
    for (const c of candidates) {
      await this.lockRow(t, m.table, c.id);
      const latest = this.visibleById(t, m.table, c.id);
      if (latest && matchWhere(latest, where)) out.push(latest);
    }
    return out;
  }

  private async updateRows(t: TxCtx, m: Model, where: Where, data: Record<string, unknown>): Promise<Row[]> {
    const hits = await this.lockMatching(t, m, where);
    const out: Row[] = [];
    for (const cur of hits) {
      const next = this.applyUpdate(m, cur, data);
      await this.guardAndPut(t, m, next);
      out.push(next);
    }
    return out;
  }

  private async upsert(t: TxCtx, m: Model, a: { where: Where; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<Row> {
    for (;;) {
      const existing = this.visible(t, m.table).some((r) => matchWhere(r, a.where));
      if (existing) {
        const [row] = await this.updateRows(t, m, a.where, a.update);
        if (row) return copy(row);
        continue;
      }
      const cand = this.materialize(m, a.create);
      const blocker = this.uniqueBlocker(t, m, cand);
      if (blocker) {
        await this.waitTx(t, blocker.tx);
        continue;
      }
      return this.create(t, m, a.create);
    }
  }

  /* ---- khoá thô: đúng hai câu `SELECT id FROM … FOR UPDATE` mà production dùng; câu khác ⇒ ném để không bỏ sót khoá đơn/payment. */
  async rawLock(tx: TxCtx | null, sql: string, values: unknown[]): Promise<Array<{ id: string }>> {
    if (!/FOR UPDATE/i.test(sql)) throw new Error(`$queryRaw không phải FOR UPDATE trong DB giả: ${sql}`);
    const isTopup = sql.includes('"payment"."shop_cod_topups"');
    const isWallet = sql.includes('"payment"."shop_cod_wallets"');
    if (!isTopup && !isWallet) throw new Error(`$queryRaw khoá bảng ngoài dự kiến trong DB giả: ${sql}`);
    const label = isTopup ? 'LOCK shop_cod_topups' : 'LOCK shop_cod_wallets';
    return this.run(tx, label, async (t) => {
      if (isTopup) {
        const id = str(values[0]);
        if (!this.visibleById(t, 'shop_cod_topups', id)) return [];
        await this.lockRow(t, 'shop_cod_topups', id);
        return [{ id }];
      }
      const shopId = str(values[0]);
      const w = this.visible(t, 'shop_cod_wallets').find((r) => r.shopId === shopId);
      if (!w) return [];
      await this.lockRow(t, 'shop_cod_wallets', w.id);
      return [{ id: w.id }];
    });
  }

  /* ---- bộ đại diện Prisma cho một bảng ---- */

  private delegate(tx: TxCtx | null, m: Model) {
    const run = <T>(op: string, fn: (t: TxCtx) => Promise<T>): Promise<T> => this.run(tx, `${m.table}.${op}`, fn);
    return {
      findUnique: (a: { where: Where }) => run('findUnique', (t) => Promise.resolve(this.findRows(t, m, a.where)[0] ?? null)),
      findUniqueOrThrow: (a: { where: Where }) =>
        run('findUniqueOrThrow', (t) => {
          const r = this.findRows(t, m, a.where)[0];
          if (!r) return Promise.reject(new Error(`Record not found trong DB giả (${m.table})`));
          return Promise.resolve(r);
        }),
      findFirst: (a: { where?: Where; orderBy?: OrderBy | OrderBy[] }) => run('findFirst', (t) => Promise.resolve(this.findRows(t, m, a.where ?? {}, a.orderBy)[0] ?? null)),
      findMany: (a: { where?: Where; orderBy?: OrderBy | OrderBy[]; skip?: number; take?: number }) =>
        run('findMany', (t) => Promise.resolve(this.findRows(t, m, a.where ?? {}, a.orderBy, a.skip ?? 0, a.take))),
      count: (a: { where?: Where }) => run('count', (t) => Promise.resolve(this.findRows(t, m, a.where ?? {}).length)),
      aggregate: (a: { where?: Where; _sum?: { amount?: true } }) =>
        run('aggregate', (t) => {
          const rows = this.findRows(t, m, a.where ?? {});
          const sum = rows.length === 0 ? null : rows.reduce((acc: Dec, r) => acc.add(dec(r.amount)), dec(0));
          return Promise.resolve({ _sum: { amount: sum } });
        }),
      create: (a: { data: Record<string, unknown> }) => run('create', (t) => this.create(t, m, a.data)),
      update: (a: { where: Where; data: Record<string, unknown> }) =>
        run('update', async (t) => {
          const [row] = await this.updateRows(t, m, a.where, a.data);
          if (!row) throw new Error(`Record to update not found trong DB giả (${m.table})`);
          return copy(row);
        }),
      updateMany: (a: { where: Where; data: Record<string, unknown> }) => run('updateMany', async (t) => ({ count: (await this.updateRows(t, m, a.where, a.data)).length })),
      upsert: (a: { where: Where; create: Record<string, unknown>; update: Record<string, unknown> }) => run('upsert', (t) => this.upsert(t, m, a)),
    };
  }

  private clientFor(t: TxCtx | null) {
    const client: Record<string, unknown> = {};
    for (const [name, m] of Object.entries(DELEGATES)) client[name] = this.delegate(t, m);
    client.$queryRaw = (strings: TemplateStringsArray, ...values: unknown[]) => this.rawLock(t, strings.join('?'), values);
    return client;
  }

  /* Client gốc (PrismaService giả): mỗi câu tự commit; `$transaction` mở giao dịch thật. */
  rootClient(): Record<string, unknown> {
    const client = this.clientFor(null);
    client.$transaction = (fn: (tx: unknown) => Promise<unknown>) => this.transaction(fn);
    return client;
  }

  /* Ghi thẳng dòng đã commit (chuẩn bị dữ liệu, không qua kiểm ràng buộc của giao dịch). */
  seed(table: string, row: Row): void {
    this.committedMap(table).set(row.id, row);
  }
}

/* ---------------------------------------------------------------- đồng hồ giả ---- */

const FAKE_NOT_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance'] as const;

/* Chỉ `Date` bị giả: mọi thời gian nghiệp vụ (hết hạn, ân hạn, mồ côi, đuôi 72 giờ) đọc từ đây. */
export function startClock(at: number = NOW): void {
  jest.useFakeTimers({ now: at, doNotFake: [...FAKE_NOT_TIMERS] });
}
export function setClock(at: number): void {
  jest.setSystemTime(at);
}
export function advanceClock(ms: number): void {
  jest.setSystemTime(Date.now() + ms);
}
export function stopFixture(): void {
  jest.useRealTimers();
  jest.restoreAllMocks();
}

/* ---------------------------------------------------------------- fixture ghép ---- */

export interface PayosTransfer {
  orderCode: string;
  amount: number;
  reference: string;
}

let codeSeq = 0;
/* Mã PayOS dải nạp cọc (5e15..): duy nhất trong một test. */
export function nextTopupCode(): string {
  codeSeq += 1;
  return String(5_000_000_000_000_000 + codeSeq);
}
let refSeqGlobal = 0;
export function nextReference(prefix = 'TF'): string {
  refSeqGlobal += 1;
  return `${prefix}${String(refSeqGlobal).padStart(9, '0')}`;
}

/* Body webhook PayOS (phần `data`) — đúng các trường plan dùng: orderCode, amount, reference, transactionDateTime, code. */
export function webhookData(code: string | number, amount: number | string, reference: string | null = nextReference(), extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderCode: Number(code),
    amount: Number(amount),
    description: 'NAPCOC TEST',
    accountNumber: '12345678',
    ...(reference === null ? {} : { reference }),
    transactionDateTime: '2026-11-03 10:05:00',
    currency: 'VND',
    paymentLinkId: 'plink-test',
    code: '00',
    desc: 'success',
    ...extra,
  };
}

const SETTING_DEFAULTS: Record<string, unknown> = {
  [SETTING_KEY.WALLET_MIN_DEPOSIT]: 500_000,
  [SETTING_KEY.WALLET_MIN_BALANCE_FOR_COD]: 200_000,
  [SETTING_KEY.WALLET_MAX_TOPUP_AMOUNT]: 50_000_000,
  [SETTING_KEY.WALLET_PAYOS_TOPUP_EXPIRE_MINUTES]: 60,
  [SETTING_KEY.WALLET_PAYOS_DEPOSIT_ENABLED]: true,
  [SETTING_KEY.WALLET_DEPOSIT_INSTRUCTIONS]: '',
};

export function buildTopupFixture(opts: { production?: boolean; adminUrl?: string; payosConfigured?: boolean } = {}) {
  startClock(NOW);
  const engine = new TopupEngine();
  const prisma = engine.rootClient() as unknown as PrismaService;

  const env = {
    NODE_ENV: opts.production ? 'production' : 'test',
    EF_ADMIN_URL: opts.adminUrl ?? 'https://fitly-admin.test',
    EF_PAYOS_CLIENT_ID: opts.payosConfigured === false ? '' : 'payos-client-test',
    EF_PAYOS_API_KEY: opts.payosConfigured === false ? '' : 'payos-api-test',
    EF_PAYOS_CHECKSUM_KEY: opts.payosConfigured === false ? '' : 'payos-checksum-test',
    EF_PAYOS_API_URL: 'https://api-merchant.payos.test',
  } as unknown as Env;

  /* Mọi lời gọi mạng bị chặn: PayOS chỉ được đi qua 3 hàm spy bên dưới. */
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('fetch bị chặn trong test: không được gọi mạng')));

  /* PayOS GIẢ có nguồn sự thật riêng: số tiền đã chuyển (transfers) — để kiểm bất biến "ví = tổng PayOS nhận". */
  const transfers: PayosTransfer[] = [];
  const statusOverride = new Map<string, { status?: string; amountPaid?: number }>();
  const payos = new PayosService(env);
  const createdLinks: Array<{ orderCode: number; description: string; returnUrl: string; cancelUrl: string; expiresAt: Date; amount: bigint }> = [];
  const createLinkDepth: number[] = [];
  const createLink = jest.spyOn(payos, 'createPaymentLink').mockImplementation((input) => {
    createLinkDepth.push(engine.openTxCount());
    engine.mark(`PAYOS createPaymentLink ${input.orderCode}`);
    createdLinks.push({ orderCode: input.orderCode, description: input.description, returnUrl: input.returnUrl, cancelUrl: input.cancelUrl, expiresAt: input.expiresAt, amount: input.amount });
    return Promise.resolve({ checkoutUrl: `https://pay.payos.test/web/${input.orderCode}`, qrCode: `QR${input.orderCode}`, paymentLinkId: `plink-${input.orderCode}` });
  });
  const payosView = (code: string) => {
    const o = statusOverride.get(code);
    const paid = transfers.filter((t) => t.orderCode === code).reduce((s, t) => s + t.amount, 0);
    const row = engine.rows('shop_cod_topups').find((r) => str(r.payosOrderCode) === code);
    if (o) return { status: o.status, amountPaid: o.amountPaid ?? paid };
    if (!row) return {};
    const amount = Number(dec(row.amount).toFixed(0));
    return { status: paid >= amount ? 'PAID' : paid > 0 ? 'UNDERPAID' : 'PENDING', amountPaid: paid };
  };
  const getLink = jest.spyOn(payos, 'getPaymentLink').mockImplementation((code) => {
    engine.mark(`PAYOS getPaymentLink ${String(code)}`);
    return Promise.resolve(payosView(String(code)));
  });
  const cancelLinkDepth: number[] = [];
  const cancelLink = jest.spyOn(payos, 'cancelPaymentLink').mockImplementation((code) => {
    cancelLinkDepth.push(engine.openTxCount());
    engine.mark(`PAYOS cancelPaymentLink ${String(code)}`);
    return Promise.resolve(true);
  });

  /* Cài đặt hệ thống (SystemQueryApi giả) — mặc định: cờ BẬT, min 500k, trần 50tr, hạn 60 phút, ngưỡng COD 200k. */
  const settings = new Map<string, unknown>(Object.entries(SETTING_DEFAULTS));
  const system = {
    settingNumber: jest.fn((key: string) => Promise.resolve(Number(settings.get(key)))),
    settingBool: jest.fn((key: string) => Promise.resolve(settings.get(key) === true || settings.get(key) === 'true')),
    setting: jest.fn((key: string) => Promise.resolve(settings.get(key) ?? null)),
  };

  /* Gian hàng (ShopQueryApi giả): SHOP_A/SHOP_B được duyệt; SHOP_OFFICIAL là gian hàng chính chủ của sàn. */
  const briefs = new Map<string, { id: string; code: string; name: string; slug: string }>([
    [SHOP_A, { id: SHOP_A, code: 'TECHZONE', name: 'Techzone', slug: 'techzone' }],
    [SHOP_B, { id: SHOP_B, code: 'SPORTPLANET', name: 'Sport Planet', slug: 'sport-planet' }],
  ]);
  const approved = new Set<string>([SHOP_A, SHOP_B, SHOP_OFFICIAL]);
  const members = new Map<string, string[]>([[SHOP_A, [OWNER_A_ID]]]);
  const shops = {
    findOfficialShopId: jest.fn(() => Promise.resolve(SHOP_OFFICIAL)),
    findBrief: jest.fn((id: string) => Promise.resolve(briefs.get(id) ?? null)),
    findManyBrief: jest.fn((ids: string[]) => Promise.resolve(new Map(ids.filter((i) => briefs.has(i)).map((i) => [i, briefs.get(i)!])))),
    existsApproved: jest.fn((id: string) => Promise.resolve(approved.has(id))),
    memberUserIdsWithPermission: jest.fn((shopId: string, _code: string) => Promise.resolve(members.get(shopId) ?? [])),
    activeMemberUserIds: jest.fn((shopId: string) => Promise.resolve(members.get(shopId) ?? [])),
  };
  const staffByPermission = new Map<string, string[]>([['supplier.wallet.approve', [ACCOUNTANT_ID]]]);
  const users = { staffUserIdsWithPermission: jest.fn((code: string) => Promise.resolve(staffByPermission.get(code) ?? [])) };

  /* Thông báo: ghi lại có truyền `tx` hay không và số giao dịch đang mở lúc gọi (phải SAU commit: 0 mở, không tx). */
  const notifications: Array<{ cmd: NotifyCommand; txGiven: boolean; openTx: number }> = [];
  const notifyFn = jest.fn((cmd: NotifyCommand, tx?: unknown) => {
    notifications.push({ cmd, txGiven: tx !== undefined, openTx: engine.openTxCount() });
    return Promise.resolve();
  });
  const notifyManyFn = jest.fn((cmds: NotifyCommand[], tx?: unknown) => {
    for (const cmd of cmds) notifications.push({ cmd, txGiven: tx !== undefined, openTx: engine.openTxCount() });
    return Promise.resolve();
  });
  const notifier: NotificationGateway = { notify: notifyFn, notifyMany: notifyManyFn };

  const audit = new PaymentAuditLogService(prisma);
  const wallet = new ShopWalletService(prisma, shops as unknown as ShopQueryApi, system as unknown as SystemQueryApi, audit);
  const settle = new ShopWalletTopupSettleService(prisma, payos, wallet, audit, shops as unknown as ShopQueryApi, notifier, users as unknown as UserDirectoryGateway);
  const topups = new ShopWalletTopupService(prisma, payos, settle, system as unknown as SystemQueryApi, shops as unknown as ShopQueryApi, env);

  /* Chuyển tiền "giả": PayOS ghi nhận một khoản vào link (không qua webhook — test tự quyết định có gửi webhook hay không). */
  const pay = (code: string | number, amount: number, reference: string = nextReference()): PayosTransfer => {
    const t = { orderCode: String(code), amount, reference };
    transfers.push(t);
    return t;
  };

  const topupRows = (): Row[] => engine.rows('shop_cod_topups');
  const topupOf = (id: string): Row | undefined => topupRows().find((r) => r.id === id);
  const receiptsOf = (topupId: string): Row[] => engine.rows('shop_cod_topup_receipts').filter((r) => r.topupId === topupId);
  const walletOf = (shopId: string): Row | undefined => engine.rows('shop_cod_wallets').find((r) => r.shopId === shopId);
  const ledgerOf = (shopId: string, type?: string): Row[] => engine.rows('shop_cod_wallet_transactions').filter((r) => r.shopId === shopId && (type === undefined || r.type === type));
  const auditOf = (action: string): Row[] => engine.rows('payment_audit_logs').filter((r) => r.action === action);

  /* Tạo sẵn một khoản nạp đã commit (không qua service) — để test từng trạng thái. */
  /* Khoản nạp đã commit, mặc định: pending, 600.000, còn hạn 60 phút, có link. Mọi trường có thể ghi đè (vd checkoutUrl: null cho khoản `creating`). */
  const seedTopup = (o: Partial<Row> = {}): Row => {
    const code = typeof o.payosOrderCode === 'string' ? o.payosOrderCode : nextTopupCode();
    const base: Row = {
      id: randomUUID(),
      shopId: SHOP_A,
      amount: dec(600_000),
      payosOrderCode: code,
      paymentLinkId: `plink-${code}`,
      checkoutUrl: `https://pay.payos.test/web/${code}`,
      qrCode: `QR${code}`,
      status: 'pending',
      receivedAmount: dec(0),
      polledAmount: dec(0),
      expiresAt: new Date(NOW + 60 * 60_000),
      paidAt: null,
      closedAt: null,
      lastCheckedAt: null,
      lastGatewayStatus: null,
      linkError: null,
      requestedBy: OWNER_A_ID,
      cancelledBy: null,
      version: 0,
      createdAt: new Date(NOW - 60_000),
      updatedAt: new Date(NOW - 60_000),
    };
    const row: Row = { ...base, ...o, payosOrderCode: code };
    row.amount = dec(row.amount);
    row.receivedAmount = dec(row.receivedAmount);
    row.polledAmount = dec(row.polledAmount);
    // Không tự sinh biên nhận/sổ cái: test thêm khi cần (trạng thái và số tiền đã đủ cho kịch bản).
    engine.seed('shop_cod_topups', row);
    return row;
  };
  const seedWallet = (shopId: string, balance: number): Row => {
    const row: Row = { id: randomUUID(), shopId, balance: dec(balance), version: 0, createdAt: new Date(NOW - 86_400_000), updatedAt: new Date(NOW - 86_400_000) };
    engine.seed('shop_cod_wallets', row);
    return row;
  };
  /* Biên nhận webhook đã commit (chuẩn bị dữ liệu cho test đọc/tổng hợp). */
  const seedReceipt = (topupId: string, reference: string, amount: number, createdAt: Date = new Date(NOW - 1000)): Row => {
    const row: Row = { id: randomUUID(), topupId, reference, amount: dec(amount), raw: null, createdAt };
    engine.seed('shop_cod_topup_receipts', row);
    return row;
  };
  const seedDeposit = (o: Partial<Row>): Row => {
    const row: Row = { id: randomUUID(), shopId: SHOP_A, amount: dec(600_000), transferRef: nextReference('FT'), note: null, status: 'pending', rejectReason: null, requestedBy: OWNER_A_ID, reviewedBy: null, reviewedAt: null, createdAt: new Date(NOW - 1000), ...o };
    engine.seed('shop_cod_deposits', { ...row, amount: dec(row.amount) });
    return row;
  };

  return {
    engine,
    prisma,
    env,
    settings,
    payos,
    createLink,
    createdLinks,
    createLinkDepth,
    getLink,
    cancelLink,
    cancelLinkDepth,
    fetchSpy,
    system,
    shops,
    users,
    notifier,
    notifyFn,
    notifyManyFn,
    notifications,
    audit,
    wallet,
    settle,
    topups,
    transfers,
    pay,
    statusOverride,
    briefs,
    members,
    approved,
    staffByPermission,
    topupRows,
    topupOf,
    receiptsOf,
    walletOf,
    ledgerOf,
    auditOf,
    seedTopup,
    seedWallet,
    seedReceipt,
    seedDeposit,
    /* Lệnh ghi có "nguồn chính" của test: gọi đúng hàm production, không qua DB giả. */
    setting(key: string, value: unknown): void {
      settings.set(key, value);
    },
  };
}

export type TopupFixture = ReturnType<typeof buildTopupFixture>;

/* Lấy lỗi nghiệp vụ (BusinessException) từ một promise bị từ chối; không ném lỗi ⇒ test thất bại rõ ràng. */
export async function bizError(p: Promise<unknown>): Promise<BusinessException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessException) return e;
    throw e;
  }
  throw new Error('Kỳ vọng ném lỗi nghiệp vụ nhưng không ném');
}
