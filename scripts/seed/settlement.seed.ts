/*
 * SEED tiền của sàn đa gian hàng (PLAN-0017): tài khoản ngân hàng shop → ví quỹ COD (sổ cái append-only) → yêu cầu nộp quỹ →
 * kỳ đối soát lịch sử (ShopPayout + ShopPayoutLine) + audit PAYOUT_CREATED. CHỈ ĐỌC đơn/hoàn tiền do activity.seed tạo (mã DHSEED*),
 * không sửa đơn. Chạy SAU activity.seed; chưa có đơn DHSEED nào thì chỉ khai tài khoản ngân hàng rồi thoát êm.
 *
 * Công thức SAO CHÉP từ service thật để số liệu seed khớp đúng thứ kế toán sẽ thấy khi bấm "Chạy kỳ":
 *   - hoa hồng COD ghi ví  (payment-worker.module.ts): net = round((total + platformDiscount) × rate% ) − platformDiscount;
 *     dòng sổ cái 'cod_commission' amount = −net, orderCode = mã đơn (net = 0 thì không ghi).
 *   - đối soát (shop-payout.service.ts): gross = total + platformDiscount; hoa hồng = round half up(gross × rate / 100);
 *     dòng hoàn tiền khoá `RF-` + 26 hex đầu của refund.id, chia theo TỈ LỆ LUỸ KẾ trên khách đã trả T: gross hoàn = round(G × cumSau / T)
 *     − round(G × cumTrước / T), hoa hồng hoàn lại tương tự với C (G, C = gross/hoa hồng dòng bán); chỉ trừ hoàn tiền của đơn ĐÃ có
 *     dòng bán; net = gross − hoa hồng ròng − hoàn tiền − nợ mang sang;
 *     net < 0 → carried, = 0 → settled, > 0 → pending/processing/paid/failed. Escrow: đơn online (≠ cod) completed,
 *     paymentStatus paid|partially_refunded, deliveredAt (hoặc completedAt khi chưa có deliveredAt) + return.window_days ≤ periodEnd.
 *
 * Idempotent: ngân hàng chỉ ghi khi 3 cột đang NULL; sổ cái bỏ qua dòng đã có (shop, loại, mã đơn / ghi chú); yêu cầu nộp quỹ theo
 * (shop, trạng thái, ghi chú); kỳ theo (shopId, periodStart, periodEnd) và các khoá (orderCode, kind) đã có. Chạy lại ở ngày khác vẫn
 * dùng lại đúng hai kỳ đã tạo (neo theo ShopPayout.createdBy IS NULL) nên không sinh kỳ chồng nhau.
 * Tiền là Prisma.Decimal / số nguyên VND — không dùng số thực.
 */
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';
import { SHOPS } from './data/shops';
import type { SeedShopDef } from './data/types';

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
const OFFICIAL_SHOP_CODE = 'SHOP-000001';
const ORDER_PREFIX = 'DHSEED';
const ADMIN_EMAIL = 'admin@ecofashion.vn';
const DEFAULT_RETURN_WINDOW_DAYS = 7;
const INITIAL_DEPOSIT_NOTE = 'Nộp quỹ ban đầu (seed)';
const PAYOS_LOW_BALANCE = 'Số dư tài khoản chi PayOS không đủ';
/* URL ảnh minh chứng ví dụ hợp lệ (ảnh mẫu công khai của Cloudinary) */
const DEMO_PROOF_URL = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';

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
  codEnabled: boolean;
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

interface LedgerEvent {
  at: Date;
  type: 'deposit' | 'cod_commission' | 'adjust';
  amount: Dec;
  orderCode: string | null;
  note: string;
  createdBy: string | null;
}

interface RequestDef {
  shop: ShopRow;
  status: 'pending' | 'approved' | 'rejected';
  amount: number;
  createdAt: Date;
  decidedAt: Date | null;
  note: string;
  decideNote: string | null;
  proofUrl: string | null;
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

/* ---------------------------------------------------------------- 2–3. kế hoạch ví quỹ COD + yêu cầu nộp quỹ */

/* Hoa hồng COD ròng của đơn (payment-worker.module.ts): dương = trừ ví, âm = cộng ví (sàn hoàn voucher sàn lớn hơn hoa hồng). */
function codNetOf(o: SeedOrder): Dec {
  const revenue = D(o.total).add(D(o.platformDiscount));
  const commission = revenue.mul(o.commissionRateSnapshot).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  return commission.sub(D(o.platformDiscount));
}

interface ShopStat {
  shop: ShopRow;
  orderCount: number;
  initialAt: Date;
  cod: LedgerEvent[];
  totalNet: Dec; // Σ hoa hồng ròng (có dấu)
  posNet: Dec; // Σ phần dương — mức tối đa ví có thể bị trừ
}

/* Quy mô shop → khoản nộp quỹ ban đầu 2–15 triệu; nới lên nếu hoa hồng COD dự kiến vượt (để ví luôn > 0 xuyên suốt, không bị khoá giữa chừng). */
function initialDepositOf(st: ShopStat): Dec {
  const tier = st.orderCount >= 30 ? 15_000_000 : st.orderCount >= 20 ? 10_000_000 : st.orderCount >= 12 ? 6_000_000 : st.orderCount >= 6 ? 4_000_000 : 2_000_000;
  const needed = st.posNet.mul('1.3').add(500_000).div(100_000).ceil().mul(100_000);
  return Prisma.Decimal.max(D(tier), needed);
}

interface MoneyPlan {
  events: Map<string, LedgerEvent[]>;
  requests: RequestDef[];
  locked: ShopRow | null;
}

/* Mã shop approved mà data/shops.ts CHỦ Ý tắt COD (vd Time Lab) — seed không mở lại, cũng không chọn làm shop "bị khoá do ví". */
const INTENTIONAL_COD_OFF: ReadonlySet<string> = new Set((SHOPS as readonly SeedShopDef[]).filter((s) => s.status === 'approved' && !s.codEnabled).map((s) => s.code));

/* Hàm thuần: từ shop + đơn dựng toàn bộ dòng sổ cái và yêu cầu nộp quỹ. ĐÚNG MỘT shop approved (không phải shop chính chủ, COD nặng nhất,
   ưu tiên shop không bị tắt COD chủ ý) bị giảm khoản nộp ban đầu để ví ≤ 0 ⇒ COD bị khoá; mọi shop approved khác ví > 0. */
function planMoney(shops: ShopRow[], orders: SeedOrder[], adminId: string | null, nowMs: number): MoneyPlan {
  const ago = (days: number, hours = 0): Date => new Date(nowMs - days * DAY - hours * HOUR);
  const approved = shops.filter((s) => s.status === 'approved');
  const byShop = new Map<string, SeedOrder[]>();
  for (const o of orders) {
    const arr = byShop.get(o.shopId);
    if (arr) arr.push(o);
    else byShop.set(o.shopId, [o]);
  }
  const globalFirst = orders[0].createdAt;

  const stats = new Map<string, ShopStat>();
  for (const shop of approved) {
    const mine = byShop.get(shop.id) ?? [];
    const cod: LedgerEvent[] = [];
    let totalNet = ZERO;
    let posNet = ZERO;
    for (const o of mine) {
      if (o.paymentMethodCode !== 'cod' || o.status !== 'completed') continue;
      const net = codNetOf(o);
      if (net.isZero()) continue; // service không ghi dòng khi khoản ròng bằng 0
      totalNet = totalNet.add(net);
      if (net.gt(0)) posNet = posNet.add(net);
      cod.push({ at: o.completedAt ?? o.deliveredAt ?? o.createdAt, type: 'cod_commission', amount: net.neg(), orderCode: o.code, note: `Hoa hồng COD đơn ${o.code}`, createdBy: null });
    }
    // Nộp quỹ ban đầu LUÔN trước đơn đầu tiên của shop (2 ngày).
    stats.set(shop.id, { shop, orderCount: mine.length, initialAt: new Date((mine[0]?.createdAt ?? globalFirst).getTime() - 2 * DAY), cod, totalNet, posNet });
  }

  // Shop khoá COD = shop COD nặng nhất (không tính shop chính chủ — hoa hồng 0%); hoà thì theo mã shop. Shop đã chủ ý tắt COD không
  // vào danh sách này (chỉ lấy làm phương án cuối nếu không còn shop nào khác); cũng không nhận luồng nộp quỹ (duyệt nộp quỹ sẽ mở lại COD).
  const ranked = approved
    .filter((s) => s.code !== OFFICIAL_SHOP_CODE)
    .sort((a, b) => {
      const d = (stats.get(b.id) as ShopStat).totalNet.cmp((stats.get(a.id) as ShopStat).totalNet);
      return d !== 0 ? d : a.code.localeCompare(b.code);
    });
  const candidates = ranked.filter((s) => !INTENTIONAL_COD_OFF.has(s.code));
  const locked = candidates[0] ?? ranked[0] ?? null;
  const donors = candidates.filter((s) => s.id !== locked?.id).slice(0, 4);

  const events = new Map<string, LedgerEvent[]>();
  const requests: RequestDef[] = [];
  const initialEvent = (st: ShopStat, amount: Dec): LedgerEvent[] => (amount.gt(0) ? [{ at: st.initialAt, type: 'deposit', amount, orderCode: null, note: INITIAL_DEPOSIT_NOTE, createdBy: null }] : []);

  // --- shop bị khoá COD: khoản ban đầu = 55% tổng hoa hồng (làm tròn xuống chục nghìn) ⇒ cuối cùng ví ÂM.
  if (locked) {
    const st = stats.get(locked.id) as ShopStat;
    const deposit = st.totalNet.gt(0) ? st.totalNet.mul('0.55').div(10_000).floor().mul(10_000) : ZERO;
    const ev = [...initialEvent(st, deposit), ...st.cod];
    let final = ev.reduce((sum, e) => sum.add(e.amount), ZERO);
    if (final.gt(0)) {
      // Dữ liệu không có COD đủ lớn (vd chỉ toàn voucher sàn chịu) → thêm một dòng điều chỉnh để vẫn có đúng một shop bị khoá.
      const adj = final.add(150_000).neg();
      ev.push({ at: ago(1), type: 'adjust', amount: adj, orderCode: null, note: 'Điều chỉnh giảm quỹ: bù trừ hoa hồng COD các kỳ trước (seed)', createdBy: adminId });
      final = final.add(adj);
    }
    events.set(locked.id, ev);

    // Yêu cầu đã bị từ chối (chứng từ mờ) rồi gửi lại — đang chờ duyệt, đủ số tiền để mở lại COD.
    const topUp = Math.max(2_000_000, Math.ceil((Number(final.neg().toFixed(0)) + 1_000_000) / 500_000) * 500_000);
    requests.push({ shop: locked, status: 'rejected', amount: 2_000_000, createdAt: ago(9), decidedAt: ago(8, 3), note: 'Nộp quỹ COD bổ sung lần 1', decideNote: 'Ảnh chứng từ bị mờ, không đọc được số tiền và nội dung chuyển khoản — vui lòng gửi lại ảnh sao kê đầy đủ', proofUrl: DEMO_PROOF_URL });
    requests.push({ shop: locked, status: 'pending', amount: topUp, createdAt: ago(2, 5), decidedAt: null, note: 'Đã chuyển khoản bổ sung quỹ COD, nhờ sàn duyệt sớm để mở lại COD', decideNote: null, proofUrl: DEMO_PROOF_URL });
  }

  // --- shop "nạp thêm": 1 yêu cầu chờ duyệt + 3 yêu cầu đã duyệt (kèm dòng sổ cái 'deposit' tương ứng).
  const donorPlans: Array<{ status: RequestDef['status']; amount: number; daysAgo: number; note: string; decideNote: string | null; proof: boolean }> = [
    { status: 'pending', amount: 5_000_000, daysAgo: 1, note: 'Nộp trước quỹ COD để không gián đoạn trong đợt khuyến mãi cuối tháng', decideNote: null, proof: false },
    { status: 'approved', amount: 5_000_000, daysAgo: 30, note: 'Nộp quỹ COD định kỳ', decideNote: 'Đã đối chiếu sao kê, khớp số tiền', proof: true },
    { status: 'approved', amount: 3_000_000, daysAgo: 21, note: 'Bổ sung quỹ COD do tăng đơn trong tuần', decideNote: 'Đã đối chiếu sao kê, khớp số tiền', proof: true },
    { status: 'approved', amount: 10_000_000, daysAgo: 12, note: 'Nộp quỹ COD đầu kỳ', decideNote: 'Đã xác nhận tiền về tài khoản sàn', proof: false },
  ];
  const donorDeposits = new Map<string, LedgerEvent[]>();
  for (const [i, shop] of donors.entries()) {
    const plan = donorPlans[i];
    const st = stats.get(shop.id) as ShopStat;
    let createdAt = ago(plan.daysAgo);
    let decidedAt: Date | null = null;
    if (plan.status === 'approved') {
      // Không để lệnh duyệt rơi trước khoản nộp ban đầu khi đơn đầu tiên quá gần đây.
      decidedAt = new Date(Math.max(ago(plan.daysAgo).getTime(), st.initialAt.getTime() + DAY));
      createdAt = new Date(decidedAt.getTime() - 20 * HOUR);
      donorDeposits.set(shop.id, [{ at: decidedAt, type: 'deposit', amount: D(plan.amount), orderCode: null, note: plan.decideNote ?? 'Nộp quỹ được phê duyệt', createdBy: adminId }]);
    }
    requests.push({ shop, status: plan.status, amount: plan.amount, createdAt, decidedAt, note: plan.note, decideNote: plan.decideNote, proofUrl: plan.proof ? DEMO_PROOF_URL : null });
  }

  for (const shop of approved) {
    if (locked && shop.id === locked.id) continue;
    const st = stats.get(shop.id) as ShopStat;
    events.set(shop.id, [...initialEvent(st, initialDepositOf(st)), ...(donorDeposits.get(shop.id) ?? []), ...st.cod]);
  }
  return { events, requests, locked };
}

/* ---------------------------------------------------------------- ghi ví + yêu cầu */

const byTime = (a: LedgerEvent, b: LedgerEvent): number => {
  const d = a.at.getTime() - b.at.getTime();
  if (d !== 0) return d;
  if (a.type !== b.type) return a.type === 'deposit' ? -1 : b.type === 'deposit' ? 1 : a.type.localeCompare(b.type);
  return (a.orderCode ?? '').localeCompare(b.orderCode ?? '');
};

/* Ghi các dòng sổ cái CHƯA có (khoá: shop+loại+mã đơn; khoản không gắn đơn thì shop+loại+ghi chú — bỏ qua số tiền để lần chạy sau
   đổi cỡ khoản nộp ban đầu cũng không nhân đôi) theo thứ tự thời gian với balanceAfter lũy kế đúng; rồi đặt ShopWallet.balance = tổng
   sổ cái (đọc lại từ DB) và đồng bộ Shop.codEnabled theo số dư. */
async function writeWallet(prisma: PrismaClient, shop: ShopRow, events: LedgerEvent[]): Promise<Dec> {
  const wallet = await prisma.shopWallet.upsert({ where: { shopId: shop.id }, create: { shopId: shop.id }, update: {}, select: { id: true, createdAt: true } });
  const existing = await prisma.shopWalletTransaction.findMany({ where: { shopId: shop.id }, select: { type: true, orderCode: true, amount: true, note: true } });
  const exists = (e: LedgerEvent): boolean => existing.some((x) => x.type === e.type && (e.orderCode ? x.orderCode === e.orderCode : x.orderCode === null && x.note === e.note));

  let running = existing.reduce((sum, x) => sum.add(D(x.amount)), ZERO);
  const rows = events
    .filter((e) => !exists(e))
    .sort(byTime)
    .map((e) => {
      running = running.add(e.amount);
      return { walletId: wallet.id, shopId: shop.id, type: e.type, orderCode: e.orderCode, amount: e.amount, balanceAfter: running, note: e.note, createdBy: e.createdBy, createdAt: e.at };
    });

  const balance = await prisma.$transaction(
    async (tx) => {
      if (rows.length > 0) await tx.shopWalletTransaction.createMany({ data: rows, skipDuplicates: true });
      const agg = await tx.shopWalletTransaction.aggregate({ where: { shopId: shop.id }, _sum: { amount: true }, _min: { createdAt: true }, _max: { createdAt: true }, _count: true });
      const total = agg._sum.amount ? D(agg._sum.amount) : ZERO;
      await tx.shopWallet.update({
        where: { id: wallet.id },
        data: {
          balance: total,
          version: agg._count,
          createdAt: agg._min.createdAt && agg._min.createdAt < wallet.createdAt ? agg._min.createdAt : undefined,
          updatedAt: agg._max.createdAt ?? undefined,
        },
      });
      return total;
    },
    { timeout: 30_000 },
  );

  // Quy tắc ví quỹ COD: ví ≤ 0 ⇒ khoá COD, > 0 ⇒ mở (xem ShopWalletService.syncCod) — TRỪ shop đã chủ ý tắt COD ở data/shops.ts: giữ false.
  const enable = INTENTIONAL_COD_OFF.has(shop.code) ? false : balance.gt(0);
  if (shop.codEnabled !== enable) await prisma.shop.update({ where: { id: shop.id }, data: { codEnabled: enable } });
  return balance;
}

async function writeDepositRequests(prisma: PrismaClient, requests: RequestDef[], adminId: string | null): Promise<number> {
  let created = 0;
  for (const r of requests) {
    const found = await prisma.shopWalletDepositRequest.findFirst({ where: { shopId: r.shop.id, status: r.status, note: r.note }, select: { id: true } });
    if (found) continue;
    const decided = r.status !== 'pending';
    await prisma.shopWalletDepositRequest.create({
      data: {
        shopId: r.shop.id,
        amount: D(r.amount),
        status: r.status,
        proofUrl: r.proofUrl,
        note: r.note,
        decidedBy: decided ? adminId : null,
        decidedAt: r.decidedAt,
        decideNote: r.decideNote,
        createdBy: r.shop.ownerUserId,
        version: decided ? 1 : 0,
        createdAt: r.createdAt,
        updatedAt: r.decidedAt ?? r.createdAt,
      },
    });
    created += 1;
  }
  return created;
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
function collectDrafts(orders: SeedOrder[], refunds: SeedRefund[], state: PayoutLedgerState, windowDays: number, periodEnd: Date): Map<string, DraftLine[]> {
  const cutoff = new Date(periodEnd.getTime() - windowDays * DAY);
  const byShop = new Map<string, DraftLine[]>();
  const push = (shopId: string, line: DraftLine): void => {
    const arr = byShop.get(shopId);
    if (arr) arr.push(line);
    else byShop.set(shopId, [line]);
  };
  const saleThisRun = new Map<string, { gross: Dec; commission: Dec }>();

  for (const o of orders) {
    // Escrow (OrderQueryApi.settlementOrders): online + completed + đã thanh toán + qua hạn đổi trả tính từ ngày giao.
    if (o.status !== 'completed' || o.paymentMethodCode === 'cod') continue;
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
    const drafts = collectDrafts(orders, refunds, state, windowDays, period.end);
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
    select: { id: true, code: true, name: true, status: true, codEnabled: true, ownerUserId: true, bankCode: true, bankAccountNumber: true, bankAccountName: true },
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
    console.log(`   ! Chưa có đơn ${ORDER_PREFIX}* — bỏ qua ví quỹ COD, yêu cầu nộp quỹ và kỳ đối soát (chạy activity.seed trước)`);
    return;
  }

  const adminId = (await prisma.user.findFirst({ where: { email: { equals: ADMIN_EMAIL, mode: 'insensitive' }, isDeleted: false }, select: { id: true } }))?.id ?? null;

  // 2–3. Ví quỹ COD + yêu cầu nộp quỹ.
  const plan = planMoney(shops, orders, adminId, nowMs);
  const requestsCreated = await writeDepositRequests(prisma, plan.requests, adminId);
  let walletTotal = ZERO;
  const lockedBalances: string[] = [];
  for (const shop of shops) {
    if (shop.status === 'approved') {
      const balance = await writeWallet(prisma, shop, plan.events.get(shop.id) ?? []);
      walletTotal = walletTotal.add(balance);
      if (balance.lte(0)) lockedBalances.push(`${shop.name} (${vnd(balance)})`);
    } else if (shop.status === 'suspended' && shop.codEnabled) {
      await prisma.shop.update({ where: { id: shop.id }, data: { codEnabled: false } }); // shop bị khoá giữ codEnabled=false
    }
  }
  const walletCount = shops.filter((s) => s.status === 'approved').length;
  console.log(`   ví quỹ COD: ${walletCount} ví, tổng số dư ${vnd(walletTotal)}; COD bị khoá (ví ≤ 0): ${lockedBalances.length > 0 ? lockedBalances.join(', ') : 'không có'}`);
  if (lockedBalances.length !== 1) console.log(`   ! Mong đợi đúng 1 shop bị khoá COD, thực tế ${lockedBalances.length} — kiểm tra dữ liệu đơn COD`);

  const allRequests = await prisma.shopWalletDepositRequest.findMany({ select: { status: true } });
  const reqByStatus = (s: string): number => allRequests.filter((r) => r.status === s).length;
  console.log(`   yêu cầu nộp quỹ: pending ${reqByStatus('pending')} · approved ${reqByStatus('approved')} · rejected ${reqByStatus('rejected')} (tạo mới ${requestsCreated})`);

  // 4. Kỳ đối soát lịch sử.
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
