import { Injectable, Logger } from '@nestjs/common';
import { CacheService, CacheSpec } from '@common/cache/cache.service';
import { BusinessException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { money, MoneyResponse } from '@common/response/money-response';

export const REPORTING_MODULE = 'reporting';
const VN_TZ = 'Asia/Ho_Chi_Minh';
const CACHE: Record<'dashboard' | 'revenue' | 'top' | 'lowstock', CacheSpec> = {
  dashboard: { module: REPORTING_MODULE, purpose: 'dashboard', ttlSeconds: 60 },
  revenue: { module: REPORTING_MODULE, purpose: 'revenue', ttlSeconds: 120 },
  top: { module: REPORTING_MODULE, purpose: 'top-products', ttlSeconds: 300 },
  lowstock: { module: REPORTING_MODULE, purpose: 'low-stock', ttlSeconds: 60 },
};

/* Đơn tính doanh thu: đã thanh toán (COD thu khi giao) và không huỷ. */
const REVENUE_ORDER_FILTER = Prisma.sql`o.is_deleted = false AND o.status <> 'cancelled' AND o.payment_status IN ('paid', 'partially_refunded')`;

type DailyRow = { orderCount: number; paidCount: number; cancelledCount: number; revenue: Prisma.Decimal; discount: Prisma.Decimal; shippingFee: Prisma.Decimal; itemsSold: number; newCustomers: number; refunded: Prisma.Decimal };

export interface DailyPoint {
  day: string;
  orderCount: number;
  paidCount: number;
  cancelledCount: number;
  revenue: MoneyResponse;
  discount: MoneyResponse;
  shippingFee: MoneyResponse;
  itemsSold: number;
  newCustomers: number;
  refunded: MoneyResponse;
}

export interface DashboardResponse {
  today: DailyPoint;
  month: { revenue: MoneyResponse; orderCount: number; paidCount: number; itemsSold: number; newCustomers: number; refunded: MoneyResponse };
  pending: { awaitingConfirm: number; awaitingPayment: number; packing: number; shipping: number; returnsRequested: number; transfersToConfirm: number; refundsRequested: number; contactsNew: number; supportOpen: number; lowStock: number };
  last7Days: DailyPoint[];
  topProducts: TopProductRow[];
  orderStatus: Array<{ status: string; count: number }>;
  paymentMethods: Array<{ method: string; count: number; revenue: MoneyResponse }>;
  generatedAt: string;
}

export interface TopProductRow {
  productId: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  quantity: number;
  revenue: MoneyResponse;
  orderCount: number;
}

export interface LowStockRow {
  variantId: string;
  productId: string;
  productName: string;
  slug: string;
  sku: string;
  colorName: string;
  sizeCode: string;
  stock: number;
  reserved: number;
  available: number;
}

export interface RevenuePoint {
  period: string;
  revenue: MoneyResponse;
  orderCount: number;
  paidCount: number;
  cancelledCount: number;
  itemsSold: number;
  discount: MoneyResponse;
  refunded: MoneyResponse;
}

export interface RevenueResponse {
  from: string;
  to: string;
  granularity: 'day' | 'month';
  points: RevenuePoint[];
  total: Omit<RevenuePoint, 'period'>;
}

export interface InventorySummary {
  products: number;
  variants: number;
  unitsInStock: number;
  unitsReserved: number;
  stockValue: MoneyResponse;
  lowStock: number;
  outOfStock: number;
}

const dec = (v: Prisma.Decimal | null | undefined): bigint => BigInt((v ?? new Prisma.Decimal(0)).toFixed(0));

/*
 * Báo cáo (PLAN-0011). Số liệu theo ngày lấy từ `reporting.daily_sales` — worker tính lại hôm nay mỗi 5 phút và chốt
 * ngày hôm qua lúc 00:05 (giờ VN). Các bảng "đang chờ" và top sản phẩm là SELECT chỉ đọc xuyên schema (ngoại lệ có
 * chủ đích, docs/03) — không bao giờ ghi vào bảng của module khác. Kết quả cache Redis ngắn (60–300s).
 */
@Injectable()
export class ReportingService {
  private readonly logger = new Logger(ReportingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ------------------------------------------------------------ dashboard

  dashboard(): Promise<DashboardResponse> {
    return this.cache.getOrSet(CACHE.dashboard, 'admin', () => this.buildDashboard());
  }

  private async buildDashboard(): Promise<DashboardResponse> {
    const today = ReportingService.vnDay(new Date());
    const monthStart = `${today.slice(0, 7)}-01`;
    const since7 = ReportingService.vnDay(new Date(Date.now() - 6 * 86_400_000));
    const [rows, pendingRows, statusRows, methodRows, top] = await Promise.all([
      this.prisma.dailySales.findMany({ where: { day: { gte: since7 < monthStart ? since7 : monthStart, lte: today } }, orderBy: { day: 'asc' } }),
      this.prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT
          (SELECT count(*) FROM "order"."orders" WHERE is_deleted = false AND status = 'pending' AND (payment_method_code = 'cod' OR payment_status = 'paid')) AS awaiting_confirm,
          (SELECT count(*) FROM "order"."orders" WHERE is_deleted = false AND status = 'pending' AND payment_method_code <> 'cod' AND payment_status <> 'paid') AS awaiting_payment,
          (SELECT count(*) FROM "order"."orders" WHERE is_deleted = false AND status IN ('confirmed', 'packing')) AS packing,
          (SELECT count(*) FROM "order"."orders" WHERE is_deleted = false AND status = 'shipping') AS shipping,
          (SELECT count(*) FROM "order"."return_requests" WHERE status = 'requested') AS returns_requested,
          (SELECT count(*) FROM "payment"."payments" WHERE method_code = 'bank_transfer' AND status = 'pending' AND (expires_at IS NULL OR expires_at > now())) AS transfers_to_confirm,
          (SELECT count(*) FROM "payment"."refunds" WHERE status = 'requested') AS refunds_requested,
          (SELECT count(*) FROM "system"."contact_messages" WHERE status = 'new') AS contacts_new,
          (SELECT count(*) FROM "ai"."support_requests" WHERE status = 'open') AS support_open,
          (SELECT count(*) FROM "product"."product_variants" v JOIN "product"."products" p ON p.id = v.product_id
             WHERE v.is_deleted = false AND v.is_active = true AND p.is_deleted = false AND p.status = 'active' AND (v.stock - v.reserved) <= 5) AS low_stock`,
      this.prisma.$queryRaw<Array<{ status: string; n: bigint }>>`SELECT status, count(*) AS n FROM "order"."orders" o WHERE o.is_deleted = false GROUP BY status`,
      this.prisma.$queryRaw<Array<{ method: string; n: bigint; revenue: Prisma.Decimal | null }>>`
        SELECT o.payment_method_code AS method, count(*) AS n, coalesce(sum(o.total), 0) AS revenue FROM "order"."orders" o
        WHERE ${REVENUE_ORDER_FILTER} AND o.created_at >= (${monthStart}::date::timestamp AT TIME ZONE ${VN_TZ}) GROUP BY o.payment_method_code`,
      this.topProducts(monthStart, today, 5),
    ]);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const last7: DailyPoint[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = ReportingService.vnDay(new Date(Date.now() - i * 86_400_000));
      last7.push(ReportingService.toPoint(d, byDay.get(d) ?? null));
    }
    const monthRows = rows.filter((r) => r.day >= monthStart);
    const sum = (f: (r: DailyRow) => number) => monthRows.reduce((a, r) => a + f(r), 0);
    const sumMoney = (f: (r: DailyRow) => Prisma.Decimal) => monthRows.reduce((a, r) => a + dec(f(r)), 0n);
    const p = pendingRows[0] ?? {};
    const n = (k: string): number => Number(p[k] ?? 0);
    return {
      today: ReportingService.toPoint(today, byDay.get(today) ?? null),
      month: { revenue: money(sumMoney((r) => r.revenue)), orderCount: sum((r) => r.orderCount), paidCount: sum((r) => r.paidCount), itemsSold: sum((r) => r.itemsSold), newCustomers: sum((r) => r.newCustomers), refunded: money(sumMoney((r) => r.refunded)) },
      pending: { awaitingConfirm: n('awaiting_confirm'), awaitingPayment: n('awaiting_payment'), packing: n('packing'), shipping: n('shipping'), returnsRequested: n('returns_requested'), transfersToConfirm: n('transfers_to_confirm'), refundsRequested: n('refunds_requested'), contactsNew: n('contacts_new'), supportOpen: n('support_open'), lowStock: n('low_stock') },
      last7Days: last7,
      topProducts: top,
      orderStatus: statusRows.map((r) => ({ status: r.status, count: Number(r.n) })),
      paymentMethods: methodRows.map((r) => ({ method: r.method, count: Number(r.n), revenue: money(dec(r.revenue)) })),
      generatedAt: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------ doanh thu theo kỳ

  revenue(from: string, to: string, granularity: 'day' | 'month'): Promise<RevenueResponse> {
    ReportingService.assertRange(from, to);
    return this.cache.getOrSet(CACHE.revenue, `${from}_${to}_${granularity}`, async () => {
      const rows = await this.prisma.dailySales.findMany({ where: { day: { gte: from, lte: to } }, orderBy: { day: 'asc' } });
      type Bucket = { revenue: bigint; orderCount: number; paidCount: number; cancelledCount: number; itemsSold: number; discount: bigint; refunded: bigint };
      const empty = (): Bucket => ({ revenue: 0n, orderCount: 0, paidCount: 0, cancelledCount: 0, itemsSold: 0, discount: 0n, refunded: 0n });
      const add = (b: Bucket, r: DailyRow | Bucket): void => {
        b.revenue += typeof r.revenue === 'bigint' ? r.revenue : dec(r.revenue);
        b.discount += typeof r.discount === 'bigint' ? r.discount : dec(r.discount);
        b.refunded += typeof r.refunded === 'bigint' ? r.refunded : dec(r.refunded);
        b.orderCount += r.orderCount;
        b.paidCount += r.paidCount;
        b.cancelledCount += r.cancelledCount;
        b.itemsSold += r.itemsSold;
      };
      // Kỳ trống vẫn hiện (0) để biểu đồ liền mạch.
      const buckets = new Map<string, Bucket>(ReportingService.periods(from, to, granularity).map((k) => [k, empty()]));
      for (const r of rows) {
        const b = buckets.get(granularity === 'day' ? r.day : r.day.slice(0, 7));
        if (b) add(b, r);
      }
      const total = empty();
      const points = [...buckets.entries()].map(([period, b]) => {
        add(total, b);
        return { period, ...ReportingService.toRevenuePoint(b) };
      });
      return { from, to, granularity, points, total: ReportingService.toRevenuePoint(total) };
    });
  }

  private static toRevenuePoint(b: { revenue: bigint; orderCount: number; paidCount: number; cancelledCount: number; itemsSold: number; discount: bigint; refunded: bigint }): Omit<RevenuePoint, 'period'> {
    return { revenue: money(b.revenue), orderCount: b.orderCount, paidCount: b.paidCount, cancelledCount: b.cancelledCount, itemsSold: b.itemsSold, discount: money(b.discount), refunded: money(b.refunded) };
  }

  // ------------------------------------------------------------ bán chạy / tồn thấp

  topProducts(from: string, to: string, limit = 10): Promise<TopProductRow[]> {
    ReportingService.assertRange(from, to);
    return this.cache.getOrSet(CACHE.top, `${from}_${to}_${limit}`, async () => {
      const rows = await this.prisma.$queryRaw<Array<{ product_id: string; slug: string; name: string; image_url: string | null; quantity: bigint; revenue: Prisma.Decimal; order_count: bigint }>>`
        SELECT oi.product_id, max(oi.slug) AS slug, max(oi.name) AS name, max(oi.image_url) AS image_url,
               sum(oi.quantity) AS quantity, sum(oi.line_total) AS revenue, count(DISTINCT o.id) AS order_count
        FROM "order"."order_items" oi JOIN "order"."orders" o ON o.id = oi.order_id
        WHERE ${REVENUE_ORDER_FILTER}
          AND o.created_at >= (${from}::date::timestamp AT TIME ZONE ${VN_TZ})
          AND o.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${VN_TZ})
        GROUP BY oi.product_id ORDER BY quantity DESC, revenue DESC LIMIT ${limit}`;
      return rows.map((r) => ({ productId: r.product_id, slug: r.slug, name: r.name, imageUrl: r.image_url, quantity: Number(r.quantity), revenue: money(dec(r.revenue)), orderCount: Number(r.order_count) }));
    });
  }

  lowStock(threshold = 5, limit = 100): Promise<LowStockRow[]> {
    return this.cache.getOrSet(CACHE.lowstock, `${threshold}_${limit}`, async () => {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; product_id: string; name: string; slug: string; sku: string; color_name: string; size_code: string; stock: number; reserved: number }>>`
        SELECT v.id, v.product_id, p.name, p.slug, v.sku, v.color_name, v.size_code, v.stock, v.reserved
        FROM "product"."product_variants" v JOIN "product"."products" p ON p.id = v.product_id
        WHERE v.is_deleted = false AND v.is_active = true AND p.is_deleted = false AND p.status = 'active' AND (v.stock - v.reserved) <= ${threshold}
        ORDER BY (v.stock - v.reserved) ASC, p.name ASC LIMIT ${limit}`;
      return rows.map((r) => ({ variantId: r.id, productId: r.product_id, productName: r.name, slug: r.slug, sku: r.sku, colorName: r.color_name, sizeCode: r.size_code, stock: r.stock, reserved: r.reserved, available: r.stock - r.reserved }));
    });
  }

  async inventorySummary(): Promise<InventorySummary> {
    const [r] = await this.prisma.$queryRaw<Array<{ products: bigint; variants: bigint; units: bigint; reserved: bigint; value: Prisma.Decimal | null; low: bigint; out: bigint }>>`
      SELECT count(DISTINCT p.id) AS products, count(v.id) AS variants, coalesce(sum(v.stock), 0) AS units, coalesce(sum(v.reserved), 0) AS reserved,
             coalesce(sum(v.stock * coalesce(v.price, p.base_price)), 0) AS value,
             count(*) FILTER (WHERE (v.stock - v.reserved) BETWEEN 1 AND 5) AS low,
             count(*) FILTER (WHERE (v.stock - v.reserved) <= 0) AS out
      FROM "product"."product_variants" v JOIN "product"."products" p ON p.id = v.product_id
      WHERE v.is_deleted = false AND v.is_active = true AND p.is_deleted = false`;
    return { products: Number(r?.products ?? 0), variants: Number(r?.variants ?? 0), unitsInStock: Number(r?.units ?? 0), unitsReserved: Number(r?.reserved ?? 0), stockValue: money(dec(r?.value)), lowStock: Number(r?.low ?? 0), outOfStock: Number(r?.out ?? 0) };
  }

  // ------------------------------------------------------------ worker: tính daily_sales

  /* Tính lại một ngày (giờ VN) từ order/payment/identity — idempotent (upsert). */
  async recomputeDay(day: string): Promise<DailyPoint> {
    ReportingService.assertDay(day);
    const [o] = await this.prisma.$queryRaw<Array<{ order_count: bigint; paid_count: bigint; cancelled_count: bigint; revenue: Prisma.Decimal | null; discount: Prisma.Decimal | null; shipping_fee: Prisma.Decimal | null; items_sold: bigint | null }>>`
      SELECT count(*) AS order_count,
             count(*) FILTER (WHERE ${REVENUE_ORDER_FILTER}) AS paid_count,
             count(*) FILTER (WHERE o.status = 'cancelled') AS cancelled_count,
             coalesce(sum(o.total) FILTER (WHERE ${REVENUE_ORDER_FILTER}), 0) AS revenue,
             coalesce(sum(o.discount) FILTER (WHERE ${REVENUE_ORDER_FILTER}), 0) AS discount,
             coalesce(sum(o.shipping_fee) FILTER (WHERE ${REVENUE_ORDER_FILTER}), 0) AS shipping_fee,
             coalesce(sum(o.item_count) FILTER (WHERE ${REVENUE_ORDER_FILTER}), 0) AS items_sold
      FROM "order"."orders" o
      WHERE o.created_at >= (${day}::date::timestamp AT TIME ZONE ${VN_TZ}) AND o.created_at < ((${day}::date + 1)::timestamp AT TIME ZONE ${VN_TZ})`;
    const [c] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "identity"."users" u JOIN "identity"."roles" r ON r.id = u.role_id
      WHERE r.code = 'customer' AND u.created_at >= (${day}::date::timestamp AT TIME ZONE ${VN_TZ}) AND u.created_at < ((${day}::date + 1)::timestamp AT TIME ZONE ${VN_TZ})`;
    const [rf] = await this.prisma.$queryRaw<Array<{ amount: Prisma.Decimal | null }>>`
      SELECT coalesce(sum(amount), 0) AS amount FROM "payment"."refunds"
      WHERE status = 'done' AND processed_at >= (${day}::date::timestamp AT TIME ZONE ${VN_TZ}) AND processed_at < ((${day}::date + 1)::timestamp AT TIME ZONE ${VN_TZ})`;
    const data = {
      orderCount: Number(o?.order_count ?? 0),
      paidCount: Number(o?.paid_count ?? 0),
      cancelledCount: Number(o?.cancelled_count ?? 0),
      revenue: o?.revenue ?? new Prisma.Decimal(0),
      discount: o?.discount ?? new Prisma.Decimal(0),
      shippingFee: o?.shipping_fee ?? new Prisma.Decimal(0),
      itemsSold: Number(o?.items_sold ?? 0),
      newCustomers: Number(c?.n ?? 0),
      refunded: rf?.amount ?? new Prisma.Decimal(0),
    };
    const row = await this.prisma.dailySales.upsert({ where: { day }, create: { day, ...data }, update: data });
    await Promise.all([this.cache.delByPrefix(CACHE.dashboard), this.cache.delByPrefix(CACHE.revenue)]);
    return ReportingService.toPoint(day, row);
  }

  /* Tính lại một khoảng ngày (seed, backfill, admin bấm tay) — tối đa 400 ngày một lần. */
  async recomputeRange(from: string, to: string): Promise<number> {
    ReportingService.assertRange(from, to);
    const days = ReportingService.periods(from, to, 'day');
    if (days.length > 400) throw new BusinessException('REPORTING_RANGE_TOO_LARGE', 'Chỉ tính lại tối đa 400 ngày một lần');
    for (const d of days) await this.recomputeDay(d);
    this.logger.log({ from, to, days: days.length }, 'Đã tính lại daily_sales');
    return days.length;
  }

  // ------------------------------------------------------------ helpers

  /* yyyy-mm-dd theo giờ Việt Nam (UTC+7, không DST). */
  static vnDay(d: Date): string {
    return new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  }

  static periods(from: string, to: string, granularity: 'day' | 'month'): string[] {
    const out: string[] = [];
    const cur = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (cur <= end) {
      const key = granularity === 'day' ? cur.toISOString().slice(0, 10) : cur.toISOString().slice(0, 7);
      if (out[out.length - 1] !== key) out.push(key);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  private static toPoint(day: string, r: DailyRow | null): DailyPoint {
    return { day, orderCount: r?.orderCount ?? 0, paidCount: r?.paidCount ?? 0, cancelledCount: r?.cancelledCount ?? 0, revenue: money(dec(r?.revenue)), discount: money(dec(r?.discount)), shippingFee: money(dec(r?.shippingFee)), itemsSold: r?.itemsSold ?? 0, newCustomers: r?.newCustomers ?? 0, refunded: money(dec(r?.refunded)) };
  }

  private static assertDay(day: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new BusinessException('COMMON_VALIDATION_ERROR', `Ngày không hợp lệ: ${day} (yyyy-mm-dd)`);
  }

  private static assertRange(from: string, to: string): void {
    ReportingService.assertDay(from);
    ReportingService.assertDay(to);
    if (from > to) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Ngày bắt đầu phải trước ngày kết thúc');
  }
}
