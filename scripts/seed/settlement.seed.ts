/*
 * SEED tiền của sàn đa gian hàng (PLAN-0017/0018): tài khoản ngân hàng shop → kỳ đối soát lịch sử (ShopPayout + ShopPayoutLine) + audit
 * PAYOUT_CREATED. Sàn thu MỌI khoản tiền (PayOS online + COD do shipper thu hộ) nên đơn COD đã giao/hoàn tất (Payment `paid`) vào đối soát
 * CÙNG đường với PayOS — không còn ví quỹ COD / nạp quỹ. CHỈ ĐỌC đơn/hoàn tiền do activity.seed tạo (mã DHSEED*), không sửa đơn.
 * Chạy SAU activity.seed; chưa có đơn DHSEED nào thì chỉ khai tài khoản ngân hàng rồi thoát êm.
 *
 * Công thức SAO CHÉP từ service thật (shop-payout.service.ts) để số liệu seed khớp đúng thứ kế toán sẽ thấy khi bấm "Chạy kỳ":
 *   gross = total + platformDiscount; hoa hồng = round half up(gross × rate / 100);
 *   dòng hoàn tiền khoá `RF-` + 26 hex đầu của refund.id, chia theo TỈ LỆ LUỸ KẾ trên khách đã trả T: gross hoàn = round(G × cumSau / T)
 *   − round(G × cumTrước / T), hoa hồng hoàn lại tương tự với C (G, C = gross/hoa hồng dòng bán); chỉ trừ hoàn tiền của đơn ĐÃ có
 *   dòng bán; net = gross − hoa hồng ròng − hoàn tiền − nợ mang sang;
 *   net < 0 → carried, = 0 → settled, > 0 → pending/processing/paid/failed. Escrow (OrderQueryApi.settlementOrders): đơn (PayOS HOẶC COD) completed,
 *   paymentStatus paid|partially_refunded, không còn đổi trả requested/approved, deliveredAt (hoặc completedAt khi chưa có deliveredAt) + return.window_days ≤ periodEnd.
 *
 * Idempotent: ngân hàng chỉ ghi khi 3 cột đang NULL; kỳ theo (shopId, periodStart, periodEnd) và các khoá (orderCode, kind) đã có. Chạy lại ở ngày
 * khác vẫn dùng lại đúng hai kỳ đã tạo (neo theo ShopPayout.createdBy IS NULL) nên không sinh kỳ chồng nhau.
 * Tiền là Prisma.Decimal / số nguyên VND — không dùng số thực.
 */
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';

type Dec = Prisma.Decimal;

const D = (v: string | number | Dec): Dec => new Prisma.Decimal(v);
const ZERO = D(0);
const round0 = (d: Dec): Dec => d.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
/* rate là PHẦN TRĂM (Decimal(5,2): 10.00 = 10%) — y hệt shop-payout.service.ts */
const commissionOf = (amount: Dec, ratePercent: Dec): Dec => round0(amount.mul(ratePercent).div(100));
const dateKey = (d: Date): string => d.toISOString().slice(2, 10).replace(/-/g, '');
const refundLineKey = (refundId: string): string => `RF-${refundId.replace(/-/g, '').slice(0, 26)}`;
const vnd = (d: Dec): string => `${Number(d.toFixed(0)).toLocaleString('vi-VN')}đ`;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ORDER_PREFIX = 'DHSEED';
const DEFAULT_RETURN_WINDOW_DAYS = 7;
const PAYOS_LOW_BALANCE = 'Số dư tài khoản chi PayOS không đủ';

/* BIN 6 số THẬT của ngân hàng VN (chuẩn Napas/PayOS — dùng làm `toBin` khi chi tiền) */
const BANKS: ReadonlyArray<{ bin: string; name: string }> = [
  { bin: '970436', name: 'Vietcombank' },
  { bin: '970415', name: 'VietinBank' },
  { bin: '970418', name: 'BIDV' },
  { bin: '970407', name: 'Techcombank' },
  { bin: '970422', name: 'MB Bank' },
  { bin: '970423', name: 'TPBank' },
  { bin: '970432', name: 'VPBank' },
  { bin: '970405', name: 'Agribank' },
  { bin: '970416', name: 'ACB' },
  { bin: '970403', name: 'Sacombank' },
];

/* ---------------------------------------------------------------- kiểu dùng chung */

interface ShopRow {
  id: string;
  code: string;
  name: string;
  status: string;
  ownerUserId: string;
  bankCode: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
}

interface BankAccount {
  bankCode: string;
  accountNumber: string;
  accountName: string;
}

interface SeedOrder {
  code: string;
  shopId: string;
  status: string;
  paymentMethodCode: string;
  paymentStatus: string;
  total: Dec;
  platformDiscount: Dec;
  commissionRateSnapshot: Dec;
  createdAt: Date;
  deliveredAt: Date | null;
  completedAt: Date | null;
}

/* ---------------------------------------------------------------- tiện ích tất định */

/* FNV-1a 32 bit — băm mã shop để sinh số tài khoản giả giống nhau ở mọi lần chạy. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Số tài khoản giả 10–13 chữ số, chữ số đầu khác 0. */
function fakeAccountNumber(shopCode: string): string {
  const rand = mulberry32(hash32(`bank:${shopCode}`));
  const len = 10 + Math.floor(rand() * 4);
  let digits = String(1 + Math.floor(rand() * 9));
  while (digits.length < len) digits += String(Math.floor(rand() * 10));
  return digits;
}

/* Tên chủ tài khoản: IN HOA, không dấu (chuẩn tên TK ngân hàng). */
function toAsciiUpper(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const startOfDayUtc = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/* ---------------------------------------------------------------- 1. tài khoản ngân hàng */

/* Khai tài khoản nhận tiền cho mọi shop trừ shop chờ duyệt/bị từ chối. Chỉ ghi khi CẢ BA cột đang NULL (updateMany có điều kiện ⇒
   không đè hồ sơ người dùng đã khai, chạy lại không đổi gì). Trả về bản đồ shopId → tài khoản đầy đủ (mới tạo hoặc đã có). */
async function seedBankAccounts(prisma: PrismaClient, shops: ShopRow[]): Promise<{ bankOf: Map<string, BankAccount>; created: number }> {
  const owners = new Map((await prisma.user.findMany({ where: { id: { in: shops.map((s) => s.ownerUserId) } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
  const eligible = shops.filter((s) => s.status !== 'pending' && s.status !== 'rejected');
  const bankOf = new Map<string, BankAccount>();
  let created = 0;

  for (const [i, s] of eligible.entries()) {
    if (s.bankCode && s.bankAccountNumber && s.bankAccountName) {
      bankOf.set(s.id, { bankCode: s.bankCode, accountNumber: s.bankAccountNumber, accountName: s.bankAccountName });
      continue;
    }
    if (s.bankCode || s.bankAccountNumber || s.bankAccountName) continue; // hồ sơ khai dở — không đụng
    const acct: BankAccount = {
      bankCode: BANKS[i % BANKS.length].bin,
      accountNumber: fakeAccountNumber(s.code),
      accountName: toAsciiUpper(owners.get(s.ownerUserId) ?? s.name),
    };
    const r = await prisma.shop.updateMany({
      where: { id: s.id, bankCode: null, bankAccountNumber: null, bankAccountName: null },
      data: { bankCode: acct.bankCode, bankAccountNumber: acct.accountNumber, bankAccountName: acct.accountName },
    });
    if (r.count === 1) {
      created += 1;
      bankOf.set(s.id, acct);
    }
  }
  return { bankOf, created };
}

/* ---------------------------------------------------------------- 4. kỳ đối soát (payout) */

interface DraftLine {
  key: string;
  kind: 'sale' | 'refund';
  gross: Dec;
  commission: Dec;
}

interface SeedRefund {
  id: string;
  orderCode: string;
  amount: Dec;
  shopId: string;
  processedAt: Date | null;
}

/* Trạng thái sổ đối soát đã ghi (DB + vừa tạo trong lần chạy này) — tương đương `alreadySold` + bảng dòng của service. */
interface PayoutLedgerState {
  saleLine: Map<string, { gross: Dec; commission: Dec }>;
  refundKeys: Set<string>;
}

interface PayoutPlan {
  shop: ShopRow;
  code: string;
  lines: DraftLine[];
  gross: Dec;
  commission: Dec;
  refund: Dec;
  carriedDebt: Dec;
  net: Dec;
  bank: BankAccount | null;
  status: string;
  providerRef: string | null;
  failReason: string | null;
  paidAt: Date | null;
}

interface Period {
  start: Date;
  end: Date;
}

/* Gom dòng CHƯA từng tính tới hết periodEnd — bản sao ShopPayoutService.collect() chạy trên đơn DHSEED đã nạp sẵn. */
function collectDrafts(orders: SeedOrder[], refunds: SeedRefund[], openReturns: ReadonlySet<string>, state: PayoutLedgerState, windowDays: number, periodEnd: Date): Map<string, DraftLine[]> {
  const cutoff = new Date(periodEnd.getTime() - windowDays * DAY);
  const byShop = new Map<string, DraftLine[]>();
  const push = (shopId: string, line: DraftLine): void => {
    const arr = byShop.get(shopId);
    if (arr) arr.push(line);
    else byShop.set(shopId, [line]);
  };
  const saleThisRun = new Map<string, { gross: Dec; commission: Dec }>();

  for (const o of orders) {
    // Escrow (OrderQueryApi.settlementOrders): PayOS hoặc COD (COD chỉ `paid` khi sàn đã thu lúc giao) + completed + qua hạn đổi trả tính từ ngày giao
    // + không còn yêu cầu đổi trả đang xử lý (requested/approved).
    if (o.status !== 'completed' || openReturns.has(o.code)) continue;
    if (o.paymentStatus !== 'paid' && o.paymentStatus !== 'partially_refunded') continue;
    const settled = o.deliveredAt !== null ? o.deliveredAt <= cutoff : o.completedAt !== null && o.completedAt <= cutoff;
    if (!settled || state.saleLine.has(o.code)) continue;
    // Doanh thu shop = khách trả + phần voucher SÀN chịu; hoa hồng tính trên doanh thu đó.
    const gross = round0(D(o.total).add(D(o.platformDiscount)));
    const commission = commissionOf(gross, D(o.commissionRateSnapshot));
    push(o.shopId, { key: o.code, kind: 'sale', gross, commission });
    saleThisRun.set(o.code, { gross, commission });
  }

  // Hoàn tiền đã chi xong tới hết kỳ, theo (processedAt, id); gom theo đơn để tính TỈ LỆ LUỸ KẾ.
  const dueRefunds = refunds
    .filter((r) => r.processedAt !== null && r.processedAt <= periodEnd)
    .sort((a, b) => (a.processedAt as Date).getTime() - (b.processedAt as Date).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const refundsByOrder = new Map<string, SeedRefund[]>();
  for (const r of dueRefunds) refundsByOrder.set(r.orderCode, [...(refundsByOrder.get(r.orderCode) ?? []), r]);
  const customerPaidOf = new Map(orders.map((o) => [o.code, D(o.total)]));

  // Doanh thu bị hoàn = round(G × Σhoàn / T), hoa hồng hoàn lại = round(C × Σhoàn / T) (G = total + voucher sàn, T = khách đã trả);
  // mỗi dòng = chênh luỹ kế sau − trước ⇒ hoàn đủ T thì hoàn đúng G và C, không lệch làm tròn. cumBefore tính cả lần đã nằm trong kỳ trước.
  for (const [code, list] of refundsByOrder) {
    if (!list.some((r) => !state.refundKeys.has(refundLineKey(r.id)))) continue;
    // Chỉ trừ hoàn tiền của đơn ĐÃ có dòng bán (kỳ này hoặc kỳ trước).
    const sale = saleThisRun.get(code) ?? state.saleLine.get(code);
    const customerPaid = customerPaidOf.get(code);
    if (!sale || customerPaid === undefined || customerPaid.lte(0)) continue;
    let cum = ZERO;
    for (const r of list) {
      const before = cum;
      cum = cum.add(D(r.amount));
      const key = refundLineKey(r.id);
      if (state.refundKeys.has(key)) continue;
      const gross = round0(sale.gross.mul(cum).div(customerPaid)).sub(round0(sale.gross.mul(before).div(customerPaid)));
      const commission = round0(sale.commission.mul(cum).div(customerPaid)).sub(round0(sale.commission.mul(before).div(customerPaid)));
      push(r.shopId, { key, kind: 'refund', gross, commission });
    }
  }
  return byShop;
}

async function readWindowDays(prisma: PrismaClient): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: 'return.window_days' }, select: { value: true } });
  const n = typeof row?.value === 'number' || typeof row?.value === 'string' ? Number(row.value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETURN_WINDOW_DAYS;
}

/* Hai kỳ liền kề không chồng: kỳ 1 = [ngày đơn đầu tiên .. hôm nay−45 ngày], kỳ 2 = [kỳ 1 + 1 giây .. hôm nay−20 ngày]. Đã có kỳ seed
   (createdBy NULL) thì dùng lại đúng mốc cũ để chạy ở ngày khác không sinh kỳ trùng/chồng. */
async function resolvePeriods(prisma: PrismaClient, firstOrderAt: Date, nowMs: number): Promise<[Period, Period]> {
  const today0 = startOfDayUtc(new Date(nowMs)).getTime();
  const existing = await prisma.shopPayout.findMany({ where: { createdBy: null, code: { startsWith: 'PAY-' } }, select: { periodStart: true, periodEnd: true }, orderBy: { periodEnd: 'asc' } });
  const seen: Period[] = [];
  for (const p of existing) {
    if (!seen.some((s) => s.start.getTime() === p.periodStart.getTime() && s.end.getTime() === p.periodEnd.getTime())) seen.push({ start: p.periodStart, end: p.periodEnd });
  }
  const end1 = new Date(today0 - 44 * DAY - 1000); // 23:59:59 của ngày (hôm nay − 45)
  const p1: Period = seen[0] ?? { start: new Date(Math.min(startOfDayUtc(firstOrderAt).getTime(), end1.getTime() - DAY)), end: end1 };
  const p2: Period = seen[1] ?? { start: new Date(p1.end.getTime() + 1000), end: new Date(today0 - 19 * DAY - 1000) }; // 23:59:59 của ngày (hôm nay − 20)
  return [p1, p2];
}

/* Gán trạng thái theo net: <0 carried · =0 settled · >0: kỳ 1 'paid'; kỳ 2 xen kẽ pending/processing, và LUÔN có một kỳ 'failed' (demo "Chạy lại"). */
function assignStatuses(plans: PayoutPlan[], kind: 1 | 2, period: Period): void {
  const at = (days: number): Date => new Date(Math.min(period.end.getTime() + days * DAY, Date.now() - HOUR));
  const positives: PayoutPlan[] = [];
  for (const p of plans) {
    if (p.net.lt(0)) p.status = 'carried';
    else if (p.net.isZero()) p.status = 'settled';
    else if (!p.bank) {
      p.status = 'pending';
      p.failReason = 'Shop chưa khai báo tài khoản ngân hàng'; // y hệt service: không có khoá payout ⇒ kế toán chuyển tay
    } else positives.push(p);
  }
  const failedIdx = Math.min(2, positives.length - 1);
  for (const [i, p] of positives.entries()) {
    if (kind === 1) {
      p.status = 'paid';
      p.providerRef = `SEED-${p.code}`;
      p.paidAt = at(2);
    } else if (i === failedIdx) {
      p.status = 'failed';
      p.failReason = PAYOS_LOW_BALANCE;
    } else if (i % 2 === 0) {
      p.status = 'pending';
    } else {
      p.status = 'processing';
      p.providerRef = `SEED-PAYOS-${p.code}`;
    }
  }
}

async function seedPayouts(prisma: PrismaClient, shops: ShopRow[], bankOf: Map<string, BankAccount>, orders: SeedOrder[], nowMs: number): Promise<{ created: number; periods: [Period, Period] }> {
  const windowDays = await readWindowDays(prisma);
  const periods = await resolvePeriods(prisma, orders[0].createdAt, nowMs);

  // Hoàn tiền đã chi xong của đơn seed (service chỉ lấy refund có shopId + processedAt).
  const refunds: SeedRefund[] = (await prisma.refund.findMany({ where: { status: 'done', shopId: { not: null }, orderCode: { startsWith: ORDER_PREFIX } }, select: { id: true, orderCode: true, amount: true, shopId: true, processedAt: true } }))
    .flatMap((r) => (r.shopId ? [{ id: r.id, orderCode: r.orderCode, amount: D(r.amount), shopId: r.shopId, processedAt: r.processedAt }] : []));

  // Đơn đang có yêu cầu đổi trả CHƯA xử lý xong bị giữ lại (escrow) — như settlementOrders.
  const openReturns = new Set((await prisma.returnRequest.findMany({ where: { orderCode: { startsWith: ORDER_PREFIX }, status: { in: ['requested', 'approved'] } }, select: { orderCode: true } })).map((r) => r.orderCode));

  // Dòng đối soát đã có trong DB (kỳ seed lần trước hoặc kỳ chạy tay) — để không tính hai lần.
  const state: PayoutLedgerState = { saleLine: new Map(), refundKeys: new Set() };
  for (const l of await prisma.shopPayoutLine.findMany({ where: { OR: [{ kind: 'sale', orderCode: { startsWith: ORDER_PREFIX } }, { kind: 'refund', orderCode: { startsWith: 'RF-' } }] }, select: { orderCode: true, kind: true, gross: true, commission: true } })) {
    if (l.kind === 'sale') state.saleLine.set(l.orderCode, { gross: D(l.gross), commission: D(l.commission) });
    else state.refundKeys.add(l.orderCode);
  }

  const shopById = new Map(shops.map((s) => [s.id, s]));
  let created = 0;

  for (const [idx, period] of periods.entries()) {
    const kind: 1 | 2 = idx === 0 ? 1 : 2;
    const drafts = collectDrafts(orders, refunds, openReturns, state, windowDays, period.end);
    const plans: PayoutPlan[] = [];

    const shopIds = [...drafts.keys()].sort((a, b) => (shopById.get(a)?.code ?? a).localeCompare(shopById.get(b)?.code ?? b));
    for (const shopId of shopIds) {
      const shop = shopById.get(shopId);
      const lines = drafts.get(shopId);
      if (!shop || !lines || lines.length === 0) continue;
      if (await prisma.shopPayout.findUnique({ where: { shopId_periodStart_periodEnd: { shopId, periodStart: period.start, periodEnd: period.end } }, select: { id: true } })) continue;

      const sum = (k: DraftLine['kind'], pick: (l: DraftLine) => Dec): Dec => lines.filter((l) => l.kind === k).reduce((a, l) => a.add(pick(l)), ZERO);
      const gross = sum('sale', (l) => l.gross);
      const refund = sum('refund', (l) => l.gross);
      // Hoa hồng ròng = hoa hồng các đơn bán − hoa hồng hoàn lại trên phần đã hoàn.
      const commission = sum('sale', (l) => l.commission).sub(sum('refund', (l) => l.commission));
      // Nợ mang sang = phần âm của kỳ GẦN NHẤT trước kỳ này (kỳ đó đã gộp nợ các kỳ trước vào net của nó).
      const last = await prisma.shopPayout.findFirst({ where: { shopId, periodEnd: { lt: period.end } }, orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }], select: { netPayout: true } });
      const carriedDebt = last && D(last.netPayout).lt(0) ? D(last.netPayout).neg() : ZERO;
      const code = `PAY-${dateKey(period.start)}-${dateKey(period.end)}-${shopId.replace(/-/g, '').slice(0, 8)}`.toUpperCase();
      plans.push({ shop, code, lines, gross, commission, refund, carriedDebt, net: gross.sub(commission).sub(refund).sub(carriedDebt), bank: bankOf.get(shopId) ?? null, status: 'pending', providerRef: null, failReason: null, paidAt: null });
    }

    assignStatuses(plans, kind, period);

    for (const p of plans) {
      const createdAt = new Date(Math.min(period.end.getTime() + DAY, nowMs - HOUR)); // kế toán chạy kỳ ngay hôm sau
      const touched = p.status === 'paid' || p.status === 'processing' || p.status === 'failed';
      const updatedAt = p.paidAt ?? (touched ? new Date(Math.min(createdAt.getTime() + HOUR, nowMs)) : createdAt);
      await prisma.$transaction(
        async (tx) => {
          const payout = await tx.shopPayout.create({
            data: {
              code: p.code,
              shopId: p.shop.id,
              periodStart: period.start,
              periodEnd: period.end,
              grossRevenue: p.gross,
              commission: p.commission,
              refundAmount: p.refund,
              carriedDebt: p.carriedDebt,
              netPayout: p.net,
              status: p.status,
              providerRef: p.providerRef,
              failReason: p.failReason,
              bankSnapshot: p.bank ? ({ bankCode: p.bank.bankCode, accountNumber: p.bank.accountNumber, accountName: p.bank.accountName } satisfies Prisma.InputJsonObject) : undefined,
              paidAt: p.paidAt,
              createdBy: null,
              version: touched ? 1 : 0,
              createdAt,
              updatedAt,
            },
            select: { id: true },
          });
          await tx.shopPayoutLine.createMany({ data: p.lines.map((l) => ({ payoutId: payout.id, orderCode: l.key, kind: l.kind, gross: l.gross, commission: l.commission })) });
          await tx.paymentAuditLog.create({
            data: {
              actorUserId: null,
              actorEmail: null,
              action: 'PAYOUT_CREATED',
              moduleCode: 'payment',
              entityType: 'ShopPayout',
              entityId: payout.id,
              entityCode: p.code,
              afterSummary: {
                shopId: p.shop.id,
                periodStart: period.start.toISOString(),
                periodEnd: period.end.toISOString(),
                grossRevenue: p.gross.toFixed(0),
                commission: p.commission.toFixed(0),
                refundAmount: p.refund.toFixed(0),
                carriedDebt: p.carriedDebt.toFixed(0),
                netPayout: p.net.toFixed(0),
                status: p.status,
                lines: p.lines.length,
              } satisfies Prisma.InputJsonObject,
              createdAt,
            },
          });
        },
        { timeout: 30_000 },
      );
      // Ghi nhận vào sổ trạng thái để kỳ sau không tính lại (UNIQUE (orderCode, kind) của dòng đối soát).
      for (const l of p.lines) {
        if (l.kind === 'sale') state.saleLine.set(l.key, { gross: l.gross, commission: l.commission });
        else state.refundKeys.add(l.key);
      }
      created += 1;
    }
    console.log(`   kỳ ${kind} ${dateKey(period.start)}–${dateKey(period.end)}: ${plans.length} phiếu mới (hạn đổi trả ${windowDays} ngày)`);
  }
  return { created, periods };
}

/* ---------------------------------------------------------------- điểm vào */

export async function seed(prisma: PrismaClient): Promise<void> {
  const nowMs = Date.now();
  const shops: ShopRow[] = await prisma.shop.findMany({
    where: { isDeleted: false },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, status: true, ownerUserId: true, bankCode: true, bankAccountNumber: true, bankAccountName: true },
  });
  if (shops.length === 0) {
    console.log('   ! Chưa có gian hàng nào — chạy marketplace.seed trước; bỏ qua seed tiền của sàn');
    return;
  }

  // 1. Tài khoản ngân hàng (không phụ thuộc đơn).
  const { bankOf, created: bankCreated } = await seedBankAccounts(prisma, shops);
  console.log(`   tài khoản ngân hàng: ${bankOf.size}/${shops.length} shop (tạo mới ${bankCreated}; shop chờ duyệt không khai)`);

  const orders: SeedOrder[] = await prisma.order.findMany({
    where: { code: { startsWith: ORDER_PREFIX }, isDeleted: false },
    orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
    select: { code: true, shopId: true, status: true, paymentMethodCode: true, paymentStatus: true, total: true, platformDiscount: true, commissionRateSnapshot: true, createdAt: true, deliveredAt: true, completedAt: true },
  });
  if (orders.length === 0) {
    console.log(`   ! Chưa có đơn ${ORDER_PREFIX}* — bỏ qua kỳ đối soát (chạy activity.seed trước)`);
    return;
  }

  // 2. Kỳ đối soát lịch sử (PayOS + COD).
  const { created: payoutCreated } = await seedPayouts(prisma, shops, bankOf, orders, nowMs);
  const payouts = await prisma.shopPayout.findMany({ where: { code: { startsWith: 'PAY-' } }, select: { status: true, netPayout: true } });
  const byStatus = new Map<string, { n: number; net: Dec }>();
  let netTotal = ZERO;
  for (const p of payouts) {
    const cur = byStatus.get(p.status) ?? { n: 0, net: ZERO };
    byStatus.set(p.status, { n: cur.n + 1, net: cur.net.add(D(p.netPayout)) });
    netTotal = netTotal.add(D(p.netPayout));
  }
  const statusText = ['pending', 'processing', 'paid', 'failed', 'carried', 'settled'].map((s) => `${s} ${byStatus.get(s)?.n ?? 0}`).join(' · ');
  console.log(`   kỳ đối soát: ${payouts.length} kỳ (tạo mới ${payoutCreated}) — ${statusText}; tổng net ${vnd(netTotal)}`);
  if ((byStatus.get('carried')?.n ?? 0) === 0) console.log('   (không có kỳ carried: dữ liệu hoàn tiền hiện tại không làm net âm — bỏ qua theo thiết kế)');
}
