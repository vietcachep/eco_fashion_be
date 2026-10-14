import { Logger } from '@nestjs/common';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import type { BasketForPromotion } from '@common/gateway/promotion.gateway';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { PROMO_ERR, PromotionService, type PromotionInput } from './promotion.service';

/*
 * PLAN-0017 — voucher SÀN vs voucher GIAN HÀNG. PromotionService chạy THẬT; Prisma thay bằng DB giả trong bộ nhớ có bộ lọc `where`
 * (equals/contains insensitive, in, lte/gte, OR/AND, not) nên các ca "mã của shop khác ⇒ 404", "mã trùng không phân biệt hoa thường",
 * "offers chỉ trả mã sàn + mã shop có trong giỏ" được kiểm bằng HÀNH VI (dữ liệu trả về), không chỉ bằng chuỗi where.
 */

const SHOP_A = '11111111-1111-4111-8111-111111111111';
const SHOP_B = '22222222-2222-4222-8222-222222222222';
const SHOP_C = '33333333-3333-4333-8333-333333333333';
const USER = 'user-1';
const DAY = 86_400_000;
const actor: AuthenticatedActor = { userId: 'staff-1', email: 'staff@fitly.vn', roleCode: 'admin', permissionVersion: 1, tokenId: 'jti-1' };

type PromoRow = Prisma.PromotionGetPayload<{ include: { targets: true } }>;
type Json = Record<string, unknown>;

interface UsageRow {
  id: string;
  promotionId: string;
  userId: string;
  orderCode: string;
  discountAmount: Prisma.Decimal;
  createdAt: Date;
  releasedAt: Date | null;
}

interface PromoSeed {
  code: string;
  name?: string;
  type?: string;
  value?: number;
  maxDiscount?: number | null;
  minOrderAmount?: number;
  scope?: 'platform' | 'shop';
  shopId?: string | null;
  isActive?: boolean;
  isPublic?: boolean;
  isDeleted?: boolean;
  startsAt?: Date;
  endsAt?: Date;
  usageLimit?: number | null;
  usageLimitPerUser?: number | null;
  usedCount?: number;
  appliesTo?: string;
  targets?: Array<{ targetType: string; targetRef: string }>;
}

let seq = 0;
function promo(s: PromoSeed): PromoRow {
  seq += 1;
  const id = `promo-${s.code.toLowerCase()}`;
  const shopId = s.shopId ?? null;
  return {
    id,
    code: s.code,
    name: s.name ?? `Mã ${s.code}`,
    description: null,
    type: s.type ?? 'percentage',
    value: new Prisma.Decimal(s.value ?? 10),
    maxDiscount: s.maxDiscount === undefined || s.maxDiscount === null ? null : new Prisma.Decimal(s.maxDiscount),
    minOrderAmount: new Prisma.Decimal(s.minOrderAmount ?? 0),
    usageLimit: s.usageLimit ?? null,
    usageLimitPerUser: s.usageLimitPerUser ?? null,
    usedCount: s.usedCount ?? 0,
    appliesTo: s.appliesTo ?? 'all',
    startsAt: s.startsAt ?? new Date(Date.now() - DAY),
    endsAt: s.endsAt ?? new Date(Date.now() + 30 * DAY),
    isActive: s.isActive ?? true,
    isPublic: s.isPublic ?? true,
    scope: s.scope ?? (shopId ? 'shop' : 'platform'),
    shopId,
    version: 0,
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000),
    createdBy: null,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000),
    updatedBy: null,
    isDeleted: s.isDeleted ?? false,
    targets: (s.targets ?? []).map((t, i) => ({ id: `${id}-t${i}`, promotionId: id, targetType: t.targetType, targetRef: t.targetRef })),
  };
}

/* ------------------------------------------------------------------ bộ lọc `where` giả của Prisma */

function opMatches(val: unknown, c: Json): boolean {
  const insensitive = c.mode === 'insensitive';
  const norm = (x: unknown): string => (insensitive ? (x as string).toLowerCase() : (x as string));
  return Object.entries(c).every(([op, arg]) => {
    switch (op) {
      case 'mode':
        return true;
      case 'equals':
        return val !== null && val !== undefined && norm(val) === norm(arg);
      case 'contains':
        return typeof val === 'string' && norm(val).includes(norm(arg));
      case 'in':
        return (arg as unknown[]).includes(val);
      case 'not':
        return val !== arg;
      case 'lte':
        return (val as Date) <= (arg as Date);
      case 'gte':
        return (val as Date) >= (arg as Date);
      default:
        throw new Error(`DB giả: toán tử where "${op}" chưa hỗ trợ`);
    }
  });
}

function matches(row: Json, where: Json): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Json[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Json[]).every((w) => matches(row, w));
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return row[key] === cond;
    return opMatches(row[key], cond as Json);
  });
}

function sortBy<T extends Json>(rows: T[], orderBy: unknown): T[] {
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, 'asc' | 'desc'>>;
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec)[0];
      const av = a[key] as Date | number;
      const bv = b[key] as Date | number;
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

interface FindArgs {
  where: Json;
  include?: unknown;
  select?: Record<string, boolean>;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}

const toDecimal = (v: unknown): Prisma.Decimal | null => (v === null || v === undefined ? null : new Prisma.Decimal(v as string));
const copy = (p: PromoRow): PromoRow => ({ ...p, targets: p.targets.map((t) => ({ ...t })) });

function buildFixture(seed: PromoRow[] = []) {
  const state = { promos: seed.map(copy), usages: [] as UsageRow[], audits: [] as Array<{ action: string; entityCode: string | null; afterSummary: Json }> };
  let usageSeq = 0;
  let promoSeq = 0;

  const promotion = {
    findFirst: jest.fn((args: FindArgs): Promise<unknown> => {
      const row = state.promos.find((p) => matches(p as unknown as Json, args.where));
      if (!row) return Promise.resolve(null);
      if (args.select) return Promise.resolve(Object.fromEntries(Object.keys(args.select).map((k) => [k, (row as unknown as Json)[k]])));
      return Promise.resolve(copy(row));
    }),
    findUnique: jest.fn((args: { where: { id: string } }): Promise<PromoRow | null> => {
      const row = state.promos.find((p) => p.id === args.where.id);
      return Promise.resolve(row ? copy(row) : null);
    }),
    findMany: jest.fn((args: FindArgs): Promise<PromoRow[]> => {
      let rows = state.promos.filter((p) => matches(p as unknown as Json, args.where));
      if (args.orderBy) rows = sortBy(rows as unknown as Json[], args.orderBy) as unknown as PromoRow[];
      const skip = args.skip ?? 0;
      return Promise.resolve(rows.slice(skip, args.take === undefined ? undefined : skip + args.take).map(copy));
    }),
    count: jest.fn((args: { where: Json }): Promise<number> => Promise.resolve(state.promos.filter((p) => matches(p as unknown as Json, args.where)).length)),
    create: jest.fn((args: { data: Json }): Promise<PromoRow> => {
      const d = args.data as Json & { targets?: { create: Array<{ targetType: string; targetRef: string }> } };
      promoSeq += 1;
      const row = promo({ code: d.code as string, shopId: (d.shopId as string | null) ?? null, scope: d.scope as 'platform' | 'shop' });
      state.promos.push({
        ...row,
        id: `promo-new-${promoSeq}`,
        name: d.name as string,
        description: (d.description as string | null) ?? null,
        type: d.type as string,
        value: new Prisma.Decimal(d.value as string),
        maxDiscount: toDecimal(d.maxDiscount),
        minOrderAmount: new Prisma.Decimal(d.minOrderAmount as string),
        usageLimit: (d.usageLimit as number | null) ?? null,
        usageLimitPerUser: (d.usageLimitPerUser as number | null) ?? null,
        appliesTo: d.appliesTo as string,
        startsAt: d.startsAt as Date,
        endsAt: d.endsAt as Date,
        isActive: d.isActive as boolean,
        isPublic: d.isPublic as boolean,
        targets: (d.targets?.create ?? []).map((t, i) => ({ id: `t-${promoSeq}-${i}`, promotionId: `promo-new-${promoSeq}`, ...t })),
      });
      return Promise.resolve(copy(state.promos[state.promos.length - 1]));
    }),
    update: jest.fn((args: { where: { id: string }; data: Json }): Promise<PromoRow> => {
      const row = state.promos.find((p) => p.id === args.where.id);
      if (!row) return Promise.reject(new Error('DB giả: không có dòng để update'));
      const target = row as unknown as Json;
      for (const [k, v] of Object.entries(args.data)) {
        if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
          const op = v as { increment?: number; decrement?: number };
          if (op.increment !== undefined) target[k] = (target[k] as number) + op.increment;
          else if (op.decrement !== undefined) target[k] = (target[k] as number) - op.decrement;
          else throw new Error(`DB giả: update "${k}" chưa hỗ trợ`);
        } else if (k === 'value' || k === 'minOrderAmount') {
          target[k] = toDecimal(v);
        } else if (k === 'maxDiscount') {
          target[k] = toDecimal(v);
        } else {
          target[k] = v;
        }
      }
      return Promise.resolve(copy(row));
    }),
  };

  const promotionTarget = {
    deleteMany: jest.fn((args: { where: { promotionId: string } }): Promise<unknown> => {
      const row = state.promos.find((p) => p.id === args.where.promotionId);
      if (row) row.targets = [];
      return Promise.resolve({ count: 0 });
    }),
    createMany: jest.fn((args: { data: Array<{ promotionId: string; targetType: string; targetRef: string }> }): Promise<unknown> => {
      for (const d of args.data) state.promos.find((p) => p.id === d.promotionId)?.targets.push({ id: `t-${d.targetRef}`, promotionId: d.promotionId, targetType: d.targetType, targetRef: d.targetRef });
      return Promise.resolve({ count: args.data.length });
    }),
  };

  const promotionUsage = {
    count: jest.fn((args: { where: Json }): Promise<number> => Promise.resolve(state.usages.filter((u) => matches(u as unknown as Json, args.where)).length)),
    findMany: jest.fn((args: FindArgs): Promise<UsageRow[]> => {
      const filtered = state.usages.filter((u) => matches(u as unknown as Json, args.where));
      const rows = args.orderBy ? (sortBy(filtered as unknown as Json[], args.orderBy) as unknown as UsageRow[]) : filtered;
      const skip = args.skip ?? 0;
      return Promise.resolve(rows.slice(skip, args.take === undefined ? undefined : skip + args.take));
    }),
    create: jest.fn((args: { data: { promotionId: string; userId: string; orderCode: string; discountAmount: Prisma.Decimal } }): Promise<UsageRow> => {
      usageSeq += 1;
      const row: UsageRow = { id: `usage-${usageSeq}`, ...args.data, createdAt: new Date(Date.UTC(2026, 5, 1) + usageSeq * 1000), releasedAt: null };
      state.usages.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn((args: { where: { id: string }; data: { releasedAt: Date } }): Promise<UsageRow> => {
      const row = state.usages.find((u) => u.id === args.where.id);
      if (!row) return Promise.reject(new Error('DB giả: usage không tồn tại'));
      row.releasedAt = args.data.releasedAt;
      return Promise.resolve(row);
    }),
  };

  const promotionAuditLog = {
    create: jest.fn((args: { data: { action: string; entityCode: string | null; afterSummary?: Json } }): Promise<unknown> => {
      state.audits.push({ action: args.data.action, entityCode: args.data.entityCode, afterSummary: args.data.afterSummary ?? {} });
      return Promise.resolve({});
    }),
  };

  /* `$transaction` chạy callback với chính DB giả (không rollback — các ca ở đây không cần). Tham chiếu qua ref để tránh tự trỏ vào initializer. */
  const dbRef: { current: unknown } = { current: null };
  const db = {
    promotion,
    promotionTarget,
    promotionUsage,
    promotionAuditLog,
    /* SELECT id … WHERE upper(code) = upper($1) AND is_deleted = false FOR UPDATE */
    $queryRaw: jest.fn((_s: TemplateStringsArray, code: string): Promise<Array<{ id: string }>> => {
      const row = state.promos.find((p) => p.code.toUpperCase() === code.toUpperCase() && !p.isDeleted);
      return Promise.resolve(row ? [{ id: row.id }] : []);
    }),
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(dbRef.current)),
  };
  dbRef.current = db;

  const shops = {
    findManyBrief: jest.fn((ids: string[]): Promise<Map<string, { name: string }>> => {
      const names: Record<string, string> = { [SHOP_A]: 'Shop A', [SHOP_B]: 'Shop B', [SHOP_C]: 'Shop C' };
      return Promise.resolve(new Map(ids.filter((i) => names[i]).map((i) => [i, { name: names[i] }])));
    }),
  };

  const service = new PromotionService(db as unknown as PrismaService, shops as unknown as ShopQueryApi);
  const tx = db as unknown as Tx;
  return { service, state, db, shops, tx };
}

/* ------------------------------------------------------------------ giỏ mẫu */

const ln = (productId: string, categorySlug: string, lineTotal: bigint) => ({ productId, categorySlug, lineTotal });
const sum = (lines: Array<{ lineTotal: bigint }>) => lines.reduce((s, l) => s + l.lineTotal, 0n);

/* Shop A: áo 200k + quần 300k = 500k, ship 30k. Shop B: áo 400k, ship 30k. */
const LINES_A = [ln('p-a1', 'ao', 200_000n), ln('p-a2', 'quan', 300_000n)];
const LINES_B = [ln('p-b1', 'ao', 400_000n)];
const shopBasket = (shopId: string, lines: typeof LINES_A, shippingFee = 30_000n): BasketForPromotion => ({ userId: USER, shopId, subtotal: sum(lines), shippingFee, lines });
const BASKET_A = shopBasket(SHOP_A, LINES_A);
const BASKET_B = shopBasket(SHOP_B, LINES_B);
/* Giỏ cả đơn (voucher sàn): không có shopId, phí ship = tổng ship các gói. */
const WHOLE: BasketForPromotion = { userId: USER, subtotal: 900_000n, shippingFee: 60_000n, lines: [...LINES_A, ...LINES_B] };

const CODE_MSG = 'chỉ áp dụng cho sản phẩm của gian hàng phát hành';

async function catchBusiness(p: Promise<unknown>): Promise<BusinessException> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BusinessException);
    return e as BusinessException;
  }
  throw new Error('Mong đợi BusinessException nhưng promise resolve');
}

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const NEW_INPUT = { code: 'NEWCODE', name: 'Mã mới', type: 'percentage', value: '10', startsAt: iso(-1), endsAt: iso(30) };

describe('PromotionService — voucher sàn & voucher gian hàng (PLAN-0017)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // ================================================================ scopeOf
  describe('scopeOf', () => {
    const seed = () => [promo({ code: 'PLAT10' }), promo({ code: 'SHOPA10', shopId: SHOP_A }), promo({ code: 'GONE', isDeleted: true })];

    it('mã sàn → platform, shopId null', async () => {
      const f = buildFixture(seed());
      await expect(f.service.scopeOf('PLAT10')).resolves.toEqual({ scope: 'platform', shopId: null });
    });

    it('mã shop → shop + shopId của shop phát hành', async () => {
      const f = buildFixture(seed());
      await expect(f.service.scopeOf('SHOPA10')).resolves.toEqual({ scope: 'shop', shopId: SHOP_A });
    });

    it('mã không tồn tại → null; mã đã xoá mềm → null', async () => {
      const f = buildFixture(seed());
      await expect(f.service.scopeOf('KHONGCO')).resolves.toBeNull();
      await expect(f.service.scopeOf('GONE')).resolves.toBeNull();
    });

    it('không phân biệt hoa thường và bỏ khoảng trắng đầu/cuối', async () => {
      const f = buildFixture(seed());
      await expect(f.service.scopeOf('shopa10')).resolves.toEqual({ scope: 'shop', shopId: SHOP_A });
      await expect(f.service.scopeOf('  ShopA10 ')).resolves.toEqual({ scope: 'shop', shopId: SHOP_A });
      await expect(f.service.scopeOf('plat10')).resolves.toEqual({ scope: 'platform', shopId: null });
    });
  });

  // ================================================================ quote (evaluate)
  describe('quote — voucher gian hàng', () => {
    it('giỏ của shop khác ⇒ ok=false, lỗi tiếng Việt "chỉ áp dụng cho sản phẩm của gian hàng phát hành", discount 0', async () => {
      const f = buildFixture([promo({ code: 'SA10', shopId: SHOP_A })]);
      const q = await f.service.quote('SA10', BASKET_B);
      expect(q.ok).toBe(false);
      expect(q.error).toContain(CODE_MSG);
      expect(q.discount).toBe(0n);
      expect(q.scope).toBe('shop');
      expect(q.shopId).toBe(SHOP_A);
    });

    it('giỏ cả đơn (không có shopId) hoặc shopId null cũng bị từ chối — mã shop không áp được trên giỏ sàn', async () => {
      const f = buildFixture([promo({ code: 'SA10', shopId: SHOP_A })]);
      const whole = await f.service.quote('SA10', WHOLE);
      const nullShop = await f.service.quote('SA10', { ...BASKET_A, shopId: null });
      expect(whole.ok).toBe(false);
      expect(whole.error).toContain(CODE_MSG);
      expect(nullShop.ok).toBe(false);
    });

    it('đúng shop ⇒ ok, percentage = % trên subtotal CỦA GIỎ SHOP đó, trả đủ scope/shopId/code/name', async () => {
      const f = buildFixture([promo({ code: 'SA10', name: 'Giảm 10% shop A', shopId: SHOP_A })]);
      const q = await f.service.quote('sa10', BASKET_A);
      expect(q).toMatchObject({ ok: true, code: 'SA10', name: 'Giảm 10% shop A', type: 'percentage', scope: 'shop', shopId: SHOP_A, discount: 50_000n, error: null });
    });

    it('percentage có trần maxDiscount', async () => {
      const f = buildFixture([promo({ code: 'SA10', shopId: SHOP_A, value: 10, maxDiscount: 30_000 })]);
      expect((await f.service.quote('SA10', BASKET_A)).discount).toBe(30_000n);
    });

    it('fixed_amount không quá subtotal của giỏ shop', async () => {
      const f = buildFixture([promo({ code: 'SAFIX', shopId: SHOP_A, type: 'fixed_amount', value: 100_000 }), promo({ code: 'SABIG', shopId: SHOP_A, type: 'fixed_amount', value: 900_000 })]);
      expect((await f.service.quote('SAFIX', BASKET_A)).discount).toBe(100_000n);
      expect((await f.service.quote('SABIG', BASKET_A)).discount).toBe(500_000n);
    });

    it('free_shipping = phí ship của gói shop (không phải ship cả đơn)', async () => {
      const f = buildFixture([promo({ code: 'SAFS', shopId: SHOP_A, type: 'free_shipping', value: 0 })]);
      const q = await f.service.quote('SAFS', BASKET_A);
      expect(q.ok).toBe(true);
      expect(q.discount).toBe(30_000n);
    });

    it('phạm vi category chỉ tính trên dòng khớp của giỏ shop', async () => {
      const f = buildFixture([promo({ code: 'SAAO', shopId: SHOP_A, appliesTo: 'category', targets: [{ targetType: 'category', targetRef: 'ao' }] })]);
      expect((await f.service.quote('SAAO', BASKET_A)).discount).toBe(20_000n); // 10% × áo 200k, không tính quần 300k
    });

    it('vẫn kiểm các điều kiện khác: đơn tối thiểu (kèm missingAmount), hết hạn, tắt', async () => {
      const f = buildFixture([
        promo({ code: 'SAMIN', shopId: SHOP_A, minOrderAmount: 800_000 }),
        promo({ code: 'SAOLD', shopId: SHOP_A, startsAt: new Date(Date.now() - 10 * DAY), endsAt: new Date(Date.now() - DAY) }),
        promo({ code: 'SAOFF', shopId: SHOP_A, isActive: false }),
      ]);
      const min = await f.service.quote('SAMIN', BASKET_A);
      expect(min.ok).toBe(false);
      expect(min.error).toContain('Đơn tối thiểu');
      expect(min.missingAmount).toBe(300_000n);
      expect((await f.service.quote('SAOLD', BASKET_A)).error).toBe('Mã đã hết hạn');
      expect((await f.service.quote('SAOFF', BASKET_A)).ok).toBe(false);
    });

    it('hạn mức: hết tổng lượt, và mỗi khách (đếm lượt chưa nhả của đúng userId; nhả lượt xong dùng lại được)', async () => {
      const f = buildFixture([promo({ code: 'SAFULL', shopId: SHOP_A, usageLimit: 5, usedCount: 5 }), promo({ code: 'SAONCE', shopId: SHOP_A, usageLimitPerUser: 1 })]);
      expect((await f.service.quote('SAFULL', BASKET_A)).error).toBe('Mã đã hết lượt sử dụng');
      expect((await f.service.quote('SAONCE', BASKET_A)).ok).toBe(true);
      await f.service.consume('SAONCE', BASKET_A, 'DH260001', f.tx);
      expect((await f.service.quote('SAONCE', BASKET_A)).error).toBe('Bạn đã dùng hết lượt của mã này');
      expect((await f.service.quote('SAONCE', { ...BASKET_A, userId: 'user-khac' })).ok).toBe(true);
      await f.service.release('DH260001', f.tx);
      expect((await f.service.quote('SAONCE', BASKET_A)).ok).toBe(true);
    });

    it('free_shipping khi phí ship của gói hiện = 0 vẫn "ok" với discount 0 (thiết kế: chưa biết tỉnh/đã freeship theo ngưỡng) — mã shop vẫn phải đúng shop', async () => {
      const f = buildFixture([promo({ code: 'SAFS', shopId: SHOP_A, type: 'free_shipping', value: 0 })]);
      expect(await f.service.quote('SAFS', { ...BASKET_A, shippingFee: 0n })).toMatchObject({ ok: true, discount: 0n });
      expect((await f.service.quote('SAFS', { ...BASKET_B, shippingFee: 0n })).ok).toBe(false);
    });
  });

  describe('quote — voucher sàn', () => {
    it('bỏ qua basket.shopId: áp được cho giỏ cả đơn, giỏ gắn shop bất kỳ hoặc shopId null; scope platform, shopId null', async () => {
      const f = buildFixture([promo({ code: 'PLAT10' })]);
      const whole = await f.service.quote('PLAT10', WHOLE);
      const asShopB = await f.service.quote('PLAT10', BASKET_B);
      const nullShop = await f.service.quote('PLAT10', { ...WHOLE, shopId: null });
      expect(whole).toMatchObject({ ok: true, scope: 'platform', shopId: null, discount: 90_000n });
      expect(asShopB).toMatchObject({ ok: true, scope: 'platform', shopId: null, discount: 40_000n });
      expect(nullShop.ok).toBe(true);
    });

    it('mã không tồn tại ⇒ ok=false, scope platform, shopId null, mã in hoa', async () => {
      const f = buildFixture();
      expect(await f.service.quote(' khongco ', WHOLE)).toMatchObject({ ok: false, code: 'KHONGCO', scope: 'platform', shopId: null, error: 'Mã không tồn tại hoặc đã hết hạn', discount: 0n });
    });
  });

  // ================================================================ consume / release
  describe('consume / release — voucher shop', () => {
    it('consume trên giỏ shop khác ⇒ từ chối, KHÔNG tăng usedCount, KHÔNG ghi usage', async () => {
      const f = buildFixture([promo({ code: 'SA10', shopId: SHOP_A })]);
      const q = await f.service.consume('sa10', BASKET_B, 'DH260001', f.tx);
      expect(q.ok).toBe(false);
      expect(q.error).toContain(CODE_MSG);
      expect(f.state.promos[0].usedCount).toBe(0);
      expect(f.state.usages).toHaveLength(0);
    });

    it('consume đúng shop ⇒ usedCount+1, usage gắn mã đơn truyền vào (mã đơn CON) với đúng số giảm', async () => {
      const f = buildFixture([promo({ code: 'SA10', shopId: SHOP_A })]);
      const q = await f.service.consume('SA10', BASKET_A, 'DH260001', f.tx);
      expect(q.ok).toBe(true);
      expect(q.discount).toBe(50_000n);
      expect(f.state.promos[0].usedCount).toBe(1);
      expect(f.state.usages).toHaveLength(1);
      expect(f.state.usages[0]).toMatchObject({ userId: USER, orderCode: 'DH260001', releasedAt: null });
      expect(f.state.usages[0].discountAmount.toString()).toBe('50000');
    });

    it('release theo mã đơn nhả đúng lượt đó (usedCount−1, usage có releasedAt) và gọi lại không nhả lần hai', async () => {
      const f = buildFixture([promo({ code: 'SA10', shopId: SHOP_A }), promo({ code: 'PLAT10' })]);
      await f.service.consume('SA10', BASKET_A, 'DH260001', f.tx);
      await f.service.consume('PLAT10', WHOLE, 'DHN260001', f.tx);
      await f.service.release('DH260001', f.tx);
      expect(f.state.promos.find((p) => p.code === 'SA10')?.usedCount).toBe(0);
      expect(f.state.promos.find((p) => p.code === 'PLAT10')?.usedCount).toBe(1); // lượt của mã đơn cha không bị đụng
      expect(f.state.usages.find((u) => u.orderCode === 'DH260001')?.releasedAt).toBeInstanceOf(Date);
      await f.service.release('DH260001', f.tx);
      expect(f.state.promos.find((p) => p.code === 'SA10')?.usedCount).toBe(0);
    });
  });

  // ================================================================ offers
  describe('offers', () => {
    const seed = () => [
      promo({ code: 'PLAT10' }),
      promo({ code: 'SA10', shopId: SHOP_A }),
      promo({ code: 'SB5', shopId: SHOP_B, value: 5 }),
      promo({ code: 'SC20', shopId: SHOP_C, value: 20 }),
      promo({ code: 'SA-PRIVATE', shopId: SHOP_A, isPublic: false }),
      promo({ code: 'SA-OLD', shopId: SHOP_A, startsAt: new Date(Date.now() - 9 * DAY), endsAt: new Date(Date.now() - DAY) }),
      promo({ code: 'SA-OFF', shopId: SHOP_A, isActive: false }),
      promo({ code: 'SA-DEL', shopId: SHOP_A, isDeleted: true }),
      promo({ code: 'PLAT-PRIVATE', isPublic: false }),
      promo({ code: 'SA-MIN', shopId: SHOP_A, minOrderAmount: 800_000 }),
    ];

    it('chỉ trả mã SÀN + mã của các shop CÓ trong giỏ (không có shop C, mã riêng tư/hết hạn/tắt/xoá)', async () => {
      const f = buildFixture(seed());
      const out = await f.service.offers(WHOLE, [BASKET_A, BASKET_B]);
      expect(out.map((o) => o.code).sort()).toEqual(['PLAT10', 'SA-MIN', 'SA10', 'SB5']);
    });

    it('truy vấn where: OR [scope platform, (scope shop, shopId in các shop trong giỏ)] + điều kiện còn hiệu lực/công khai', async () => {
      const f = buildFixture(seed());
      await f.service.offers(WHOLE, [BASKET_A, BASKET_B]);
      const where = f.db.promotion.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([{ scope: 'platform' }, { scope: 'shop', shopId: { in: [SHOP_A, SHOP_B] } }]);
      expect(where).toMatchObject({ isDeleted: false, isActive: true, isPublic: true });
      expect(where.startsAt).toHaveProperty('lte');
      expect(where.endsAt).toHaveProperty('gte');
    });

    it('không có giỏ shop nào ⇒ chỉ truy vấn mã sàn và không tra tên shop', async () => {
      const f = buildFixture(seed());
      const out = await f.service.offers(WHOLE);
      expect(out.map((o) => o.code).sort()).toEqual(['PLAT10']);
      expect(f.db.promotion.findMany.mock.calls[0][0].where.OR).toEqual([{ scope: 'platform' }]);
      expect(f.shops.findManyBrief).not.toHaveBeenCalled();
    });

    it('offer có scope/shopId/shopName; mã sàn shopId=null, shopName=null', async () => {
      const f = buildFixture(seed());
      const out = await f.service.offers(WHOLE, [BASKET_A, BASKET_B]);
      const by = (c: string) => out.find((o) => o.code === c);
      expect(by('PLAT10')).toMatchObject({ scope: 'platform', shopId: null, shopName: null });
      expect(by('SA10')).toMatchObject({ scope: 'shop', shopId: SHOP_A, shopName: 'Shop A' });
      expect(by('SB5')).toMatchObject({ scope: 'shop', shopId: SHOP_B, shopName: 'Shop B' });
    });

    it('mã shop được tính trên GIỎ RIÊNG của shop, mã sàn tính trên giỏ cả đơn', async () => {
      const f = buildFixture(seed());
      const out = await f.service.offers(WHOLE, [BASKET_A, BASKET_B]);
      const by = (c: string) => out.find((o) => o.code === c);
      expect(by('PLAT10')?.displayDiscount.amount).toBe('90000'); // 10% × 900k
      expect(by('SA10')?.displayDiscount.amount).toBe('50000'); // 10% × 500k của shop A (không phải 900k)
      expect(by('SB5')?.displayDiscount.amount).toBe('20000'); // 5% × 400k của shop B
    });

    it('mã shop chưa đủ điều kiện trên giỏ riêng: eligible=false + lý do + còn thiếu bao nhiêu', async () => {
      const f = buildFixture(seed());
      const out = await f.service.offers(WHOLE, [BASKET_A, BASKET_B]);
      const min = out.find((o) => o.code === 'SA-MIN');
      expect(min?.eligible).toBe(false);
      expect(min?.reason).toContain('Đơn tối thiểu');
      expect(min?.displayMissingAmount?.amount).toBe('300000'); // 800k − 500k (giỏ shop A, không phải 900k của cả đơn)
    });

    it('sắp xếp: mã dùng được trước, giảm nhiều trước', async () => {
      const f = buildFixture(seed());
      const out = await f.service.offers(WHOLE, [BASKET_A, BASKET_B]);
      expect(out.map((o) => o.code)).toEqual(['PLAT10', 'SA10', 'SB5', 'SA-MIN']);
    });
  });

  // ================================================================ vendor CRUD — cô lập theo shop
  describe('quản trị theo shop (vendor)', () => {
    const seed = () => [promo({ code: 'PLATX' }), promo({ code: 'A1', shopId: SHOP_A }), promo({ code: 'A2', shopId: SHOP_A }), promo({ code: 'B1', shopId: SHOP_B }), promo({ code: 'ADEL', shopId: SHOP_A, isDeleted: true })];
    const id = (code: string) => `promo-${code.toLowerCase()}`;

    describe('listAdmin', () => {
      it("vendor ('shop' + shopId): chỉ thấy mã của shop mình, mỗi dòng có scope/shopId", async () => {
        const f = buildFixture(seed());
        const page = await f.service.listAdmin(1, 20, undefined, undefined, 'shop', SHOP_A);
        expect(page.content.map((p) => p.code).sort()).toEqual(['A1', 'A2']);
        expect(page.content.every((p) => p.scope === 'shop' && p.shopId === SHOP_A)).toBe(true);
        expect(page.totalElements).toBe(2);
      });

      it('shop không có mã nào ⇒ trang rỗng (không rò mã sàn / mã shop khác)', async () => {
        const f = buildFixture(seed());
        const page = await f.service.listAdmin(1, 20, undefined, undefined, 'shop', SHOP_C);
        expect(page.content).toEqual([]);
        expect(page.totalElements).toBe(0);
      });

      it('sàn (không lọc) thấy mọi mã chưa xoá; lọc scope/shopId tuỳ chọn', async () => {
        const f = buildFixture(seed());
        expect((await f.service.listAdmin(1, 20)).content.map((p) => p.code).sort()).toEqual(['A1', 'A2', 'B1', 'PLATX']);
        expect((await f.service.listAdmin(1, 20, undefined, undefined, 'platform')).content.map((p) => p.code)).toEqual(['PLATX']);
        expect((await f.service.listAdmin(1, 20, undefined, undefined, undefined, SHOP_B)).content.map((p) => p.code)).toEqual(['B1']);
      });

      it('vendor lọc thêm q/active vẫn không vượt phạm vi shop', async () => {
        const f = buildFixture(seed());
        const page = await f.service.listAdmin(1, 20, 'b1', undefined, 'shop', SHOP_A);
        expect(page.content).toEqual([]); // B1 là của shop B
        const own = await f.service.listAdmin(1, 20, 'a2', true, 'shop', SHOP_A);
        expect(own.content.map((p) => p.code)).toEqual(['A2']);
      });
    });

    describe('getAdmin', () => {
      it('mã của shop mình ⇒ trả về', async () => {
        const f = buildFixture(seed());
        const r = await f.service.getAdmin(id('A1'), SHOP_A);
        expect(r).toMatchObject({ code: 'A1', scope: 'shop', shopId: SHOP_A });
      });

      it('mã của shop khác ⇒ NotFoundException PROMOTION_NOT_FOUND (404, không lộ sự tồn tại)', async () => {
        const f = buildFixture(seed());
        const e = await catchBusiness(f.service.getAdmin(id('B1'), SHOP_A));
        expect(e).toBeInstanceOf(NotFoundException);
        expect(e.errorCode).toBe(PROMO_ERR.NOT_FOUND);
        expect(e.httpStatus).toBe(404);
      });

      it('vendor không đọc được mã SÀN; mã đã xoá ⇒ 404', async () => {
        const f = buildFixture(seed());
        await expect(f.service.getAdmin(id('PLATX'), SHOP_A)).rejects.toBeInstanceOf(NotFoundException);
        await expect(f.service.getAdmin(id('ADEL'), SHOP_A)).rejects.toBeInstanceOf(NotFoundException);
      });

      it('sàn (không ownerShopId) đọc được mã của mọi shop', async () => {
        const f = buildFixture(seed());
        expect((await f.service.getAdmin(id('B1'))).shopId).toBe(SHOP_B);
        expect((await f.service.getAdmin(id('PLATX'))).scope).toBe('platform');
      });
    });

    describe('update', () => {
      it('sửa mã của shop mình ⇒ lưu + tăng version', async () => {
        const f = buildFixture(seed());
        const r = await f.service.update(actor, id('A1'), { name: 'Tên mới', isActive: false }, SHOP_A);
        expect(r.isActive).toBe(false);
        expect(f.state.promos.find((p) => p.code === 'A1')).toMatchObject({ name: 'Tên mới', isActive: false, version: 1 });
      });

      it('mã của shop khác ⇒ NotFound, KHÔNG ghi gì', async () => {
        const f = buildFixture(seed());
        const e = await catchBusiness(f.service.update(actor, id('B1'), { name: 'Hack' }, SHOP_A));
        expect(e).toBeInstanceOf(NotFoundException);
        expect(e.errorCode).toBe(PROMO_ERR.NOT_FOUND);
        expect(f.db.promotion.update).not.toHaveBeenCalled();
        expect(f.state.promos.find((p) => p.code === 'B1')?.name).toBe('Mã B1');
      });

      it('vendor không sửa được mã SÀN', async () => {
        const f = buildFixture(seed());
        await expect(f.service.update(actor, id('PLATX'), { name: 'Hack' }, SHOP_A)).rejects.toBeInstanceOf(NotFoundException);
        expect(f.db.promotion.update).not.toHaveBeenCalled();
      });

      it('scope/shopId lọt vào patch bị bỏ qua — không đổi mã shop thành mã sàn / chuyển sang shop khác', async () => {
        const f = buildFixture(seed());
        const smuggled = { name: 'Đổi tên', scope: 'platform', shopId: SHOP_B } as unknown as PromotionInput;
        await f.service.update(actor, id('A1'), smuggled, SHOP_A);
        const data = f.db.promotion.update.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('scope');
        expect(data).not.toHaveProperty('shopId');
        expect(f.state.promos.find((p) => p.code === 'A1')).toMatchObject({ scope: 'shop', shopId: SHOP_A, name: 'Đổi tên' });
      });

      it('đổi mã sang mã đã có (của shop khác / của sàn) ⇒ Conflict; đổi hoa/thường chính mã mình thì được', async () => {
        const f = buildFixture(seed());
        await expect(f.service.update(actor, id('A1'), { code: 'b1' }, SHOP_A)).rejects.toBeInstanceOf(ConflictException);
        await expect(f.service.update(actor, id('A1'), { code: 'platx' }, SHOP_A)).rejects.toBeInstanceOf(ConflictException);
        await expect(f.service.update(actor, id('A1'), { code: 'a1' }, SHOP_A)).resolves.toMatchObject({ code: 'A1' });
      });
    });

    describe('remove', () => {
      it('xoá mã của shop mình ⇒ xoá mềm + tắt', async () => {
        const f = buildFixture(seed());
        await f.service.remove(actor, id('A1'), SHOP_A);
        expect(f.state.promos.find((p) => p.code === 'A1')).toMatchObject({ isDeleted: true, isActive: false });
        await expect(f.service.scopeOf('A1')).resolves.toBeNull();
      });

      it('mã của shop khác hoặc mã sàn ⇒ NotFound, không xoá', async () => {
        const f = buildFixture(seed());
        await expect(f.service.remove(actor, id('B1'), SHOP_A)).rejects.toBeInstanceOf(NotFoundException);
        await expect(f.service.remove(actor, id('PLATX'), SHOP_A)).rejects.toBeInstanceOf(NotFoundException);
        expect(f.state.promos.find((p) => p.code === 'B1')?.isDeleted).toBe(false);
        expect(f.state.promos.find((p) => p.code === 'PLATX')?.isDeleted).toBe(false);
        expect(f.db.promotion.update).not.toHaveBeenCalled();
      });
    });

    describe('usages', () => {
      const withUsages = () => {
        const f = buildFixture(seed());
        for (const [promoCode, order, userId] of [['A1', 'DH260001', 'user-9'], ['A1', 'DH260002', 'user-8'], ['B1', 'DH260003', 'user-7']] as const) {
          f.state.usages.push({ id: `u-${order}`, promotionId: id(promoCode), userId, orderCode: order, discountAmount: new Prisma.Decimal(10_000), createdAt: new Date(Date.UTC(2026, 5, 1) + Number(order.slice(-1)) * 1000), releasedAt: null });
        }
        return f;
      };

      it('vendor xem lượt dùng mã của mình: userId bị ẩn (null), vẫn có mã đơn & số tiền giảm', async () => {
        const f = withUsages();
        const page = await f.service.usages(id('A1'), 1, 20, SHOP_A);
        expect(page.content).toHaveLength(2);
        expect(page.content.every((u) => u.userId === null)).toBe(true);
        expect(page.content.map((u) => u.orderCode).sort()).toEqual(['DH260001', 'DH260002']);
        expect(page.content[0].discountAmount.amount).toBe('10000');
      });

      it('mã của shop khác hoặc mã sàn ⇒ NotFound (không lộ lượt dùng)', async () => {
        const f = withUsages();
        await expect(f.service.usages(id('B1'), 1, 20, SHOP_A)).rejects.toBeInstanceOf(NotFoundException);
        await expect(f.service.usages(id('PLATX'), 1, 20, SHOP_A)).rejects.toBeInstanceOf(NotFoundException);
        expect(f.db.promotionUsage.findMany).not.toHaveBeenCalled();
      });

      it('sàn xem được userId thật', async () => {
        const f = withUsages();
        const page = await f.service.usages(id('A1'), 1, 20);
        expect(page.content.map((u) => u.userId).sort()).toEqual(['user-8', 'user-9']);
      });
    });

    describe('create', () => {
      it('có ownerShopId ⇒ scope "shop", shopId đúng; ghi audit kèm scope/shopId', async () => {
        const f = buildFixture(seed());
        const r = await f.service.create(actor, NEW_INPUT, SHOP_A);
        expect(r).toMatchObject({ code: 'NEWCODE', scope: 'shop', shopId: SHOP_A });
        expect(f.db.promotion.create.mock.calls[0][0].data).toMatchObject({ scope: 'shop', shopId: SHOP_A, createdBy: actor.userId });
        expect(f.state.audits[0]).toMatchObject({ action: 'PROMOTION_CREATED', entityCode: 'NEWCODE', afterSummary: { scope: 'shop', shopId: SHOP_A } });
      });

      it('KHÔNG nhận scope/shopId từ input: vendor A gửi scope=platform + shopId=B vẫn ra mã shop A', async () => {
        const f = buildFixture(seed());
        const smuggled = { ...NEW_INPUT, scope: 'platform', shopId: SHOP_B } as unknown as typeof NEW_INPUT;
        const r = await f.service.create(actor, smuggled, SHOP_A);
        expect(r).toMatchObject({ scope: 'shop', shopId: SHOP_A });
        expect(f.db.promotion.create.mock.calls[0][0].data).toMatchObject({ scope: 'shop', shopId: SHOP_A });
      });

      it('không ownerShopId (sàn) ⇒ scope "platform", shopId null — kể cả khi input gửi scope=shop + shopId', async () => {
        const f = buildFixture(seed());
        const plain = await f.service.create(actor, NEW_INPUT);
        expect(plain).toMatchObject({ scope: 'platform', shopId: null });
        const smuggled = { ...NEW_INPUT, code: 'NEWCODE2', scope: 'shop', shopId: SHOP_B } as unknown as typeof NEW_INPUT;
        const r = await f.service.create(actor, smuggled);
        expect(r).toMatchObject({ scope: 'platform', shopId: null });
        expect(f.db.promotion.create.mock.calls[1][0].data).toMatchObject({ scope: 'platform', shopId: null });
      });

      it('mã được chuẩn hoá in hoa + bỏ khoảng trắng; shop vừa tạo thấy trong danh sách của mình, shop khác không thấy', async () => {
        const f = buildFixture(seed());
        await f.service.create(actor, { ...NEW_INPUT, code: '  freeshipa  ' }, SHOP_A);
        expect((await f.service.listAdmin(1, 20, 'freeshipa', undefined, 'shop', SHOP_A)).content.map((p) => p.code)).toEqual(['FREESHIPA']);
        expect((await f.service.listAdmin(1, 20, 'freeshipa', undefined, 'shop', SHOP_B)).content).toEqual([]);
      });

      it('mã trùng KHÔNG phân biệt hoa thường ⇒ ConflictException PROMOTION_CODE_EXISTS (409): cùng shop, shop↔shop, shop↔sàn, sàn↔shop', async () => {
        const f = buildFixture(seed());
        const cases: Array<[string, string | undefined]> = [
          ['a1', SHOP_A], // trùng mã của chính shop mình
          ['b1', SHOP_A], // trùng mã của shop khác
          ['platx', SHOP_A], // vendor trùng mã sàn
          ['a2', undefined], // sàn trùng mã của shop
          ['PlatX', undefined], // sàn trùng mã sàn
        ];
        for (const [code, owner] of cases) {
          const e = await catchBusiness(f.service.create(actor, { ...NEW_INPUT, code }, owner));
          expect(e).toBeInstanceOf(ConflictException);
          expect(e.errorCode).toBe(PROMO_ERR.CODE_EXISTS);
          expect(e.httpStatus).toBe(409);
        }
        expect(f.db.promotion.create).not.toHaveBeenCalled();
      });

      it('shopName nhất quán: create (shop) trả tên shop; create (sàn) trả null và KHÔNG tra tên shop', async () => {
        const f = buildFixture(seed());
        const shopCode = await f.service.create(actor, NEW_INPUT, SHOP_A);
        expect(shopCode.shopName).toBe('Shop A');
        expect(f.shops.findManyBrief).toHaveBeenCalledTimes(1);
        const platformCode = await f.service.create(actor, { ...NEW_INPUT, code: 'PLATNEW' });
        expect(platformCode.shopName).toBeNull();
        expect(f.shops.findManyBrief).toHaveBeenCalledTimes(1); // mã sàn không có shopId ⇒ không gọi shop queryapi
      });

      it('shopName nhất quán: update/get/list cùng trả tên shop cho cùng một mã', async () => {
        const f = buildFixture(seed());
        const updated = await f.service.update(actor, id('A1'), { name: 'Tên mới' }, SHOP_A);
        const got = await f.service.getAdmin(id('A1'), SHOP_A);
        const listed = (await f.service.listAdmin(1, 20, undefined, undefined, 'shop', SHOP_A)).content.find((p) => p.code === 'A1');
        expect([updated.shopName, got.shopName, listed?.shopName]).toEqual(['Shop A', 'Shop A', 'Shop A']);
        // sàn sửa mã của shop B (không có ownerShopId): vẫn ra tên shop B chứ không null.
        expect((await f.service.update(actor, id('B1'), { name: 'Sàn sửa' })).shopName).toBe('Shop B');
        expect((await f.service.update(actor, id('PLATX'), { name: 'Sàn sửa mã sàn' })).shopName).toBeNull();
      });

      it('mã đã xoá mềm được tạo lại (khớp unique index một phần WHERE is_deleted=false)', async () => {
        const f = buildFixture(seed());
        await expect(f.service.create(actor, { ...NEW_INPUT, code: 'adel' }, SHOP_A)).resolves.toMatchObject({ code: 'ADEL', shopId: SHOP_A });
      });

      it('validate vẫn chạy với vendor: % ngoài 1–100 ⇒ PROMOTION_INVALID', async () => {
        const f = buildFixture(seed());
        const e = await catchBusiness(f.service.create(actor, { ...NEW_INPUT, value: '150' }, SHOP_A));
        expect(e.errorCode).toBe(PROMO_ERR.INVALID);
        expect(f.db.promotion.create).not.toHaveBeenCalled();
      });
    });
  });
});
