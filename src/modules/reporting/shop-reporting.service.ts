import { Injectable } from '@nestjs/common';
import { CacheService, CacheSpec } from '@common/cache/cache.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { money } from '@common/response/money-response';
import { assertReportRange } from './reporting-range';
import { REPORTING_MODULE } from './reporting.service';
import { ShopDailyPointResponse, ShopDashboardResponse, ShopLowStockResponse, ShopRevenuePointResponse, ShopRevenueResponse, ShopTopProductResponse } from './shop-reporting.responses';

const VN_TZ = 'Asia/Ho_Chi_Minh';

// Cache specs cho shop reports — shopId trong cache key để shop không share cache với nhau
const shopCacheSpec = (purpose: string, ttlSeconds: number): CacheSpec => ({
  module: REPORTING_MODULE,
  purpose: `shop-${purpose}`,
  ttlSeconds,
});

const CACHE = {
  dashboard: shopCacheSpec('dashboard', 60),
  revenue: shopCacheSpec('revenue', 120),
  top: shopCacheSpec('top-products', 300),
  lowstock: shopCacheSpec('low-stock', 60),
};

/* Đơn tính doanh thu của shop: đã thanh toán (COD thu khi giao) và không huỷ — dùng cho top sản phẩm (có lọc shop). */
const shopRevenueOrderFilter = (shopId: string): Prisma.Sql =>
  Prisma.sql`o.shop_id = ${shopId} AND o.is_deleted = false AND o.status <> 'cancelled' AND o.payment_status IN ('paid', 'partially_refunded')`;

/* Điều kiện "đơn tính doanh thu" KHÔNG chứa shop — chỉ dùng trong FILTER (WHERE …) của truy vấn gộp theo ngày, nơi mệnh đề
 * WHERE ngoài đã khoá `o.shop_id = <shopId>` đúng một lần (đỡ lặp tham số). TUYỆT ĐỐI không dùng ở truy vấn thiếu WHERE shop. */
const PAID_ORDER = Prisma.sql`o.status <> 'cancelled' AND o.payment_status IN ('paid', 'partially_refunded')`;

/* Cửa sổ thời gian [from, to] (yyyy-mm-dd, giờ VN) áp lên một cột timestamptz — nửa mở: >= 0h ngày from, < 0h ngày to+1. */
const vnWindow = (column: Prisma.Sql, from: string, to: string): Prisma.Sql =>
  Prisma.sql`${column} >= (${from}::date::timestamp AT TIME ZONE ${VN_TZ}) AND ${column} < ((${to}::date + 1)::timestamp AT TIME ZONE ${VN_TZ})`;

type DailyRow = {
  orderCount: number;
  paidCount: number;
  cancelledCount: number;
  revenue: Prisma.Decimal;
  discount: Prisma.Decimal;
  shippingFee: Prisma.Decimal;
  itemsSold: number;
  newCustomers: number;
  refunded: Prisma.Decimal;
};

type OrderDayRow = { day: string; order_count: bigint; paid_count: bigint; cancelled_count: bigint; revenue: Prisma.Decimal | null; discount: Prisma.Decimal | null; shipping_fee: Prisma.Decimal | null; items_sold: bigint | null };
type NewCustomerDayRow = { day: string; n: bigint };
type RefundDayRow = { day: string; amount: Prisma.Decimal | null };

const emptyDay = (): DailyRow => ({
  orderCount: 0,
  paidCount: 0,
  cancelledCount: 0,
  revenue: new Prisma.Decimal(0),
  discount: new Prisma.Decimal(0),
  shippingFee: new Prisma.Decimal(0),
  itemsSold: 0,
  newCustomers: 0,
  refunded: new Prisma.Decimal(0),
});

const dec = (v: Prisma.Decimal | null | undefined): bigint => BigInt((v ?? new Prisma.Decimal(0)).toFixed(0));

/*
 * Báo cáo shop (PLAN-0017 B4). Chủ/nhân viên gian hàng xem số liệu của CHÍNH gian hàng mình.
 *
 * ★ KHÔNG đọc `reporting.daily_sales` ở đây: bảng đó là số liệu TOÀN SÀN (không có cột shop_id) — dùng nó cho shop là rò doanh thu
 * chéo gian hàng. Mọi con số tính trực tiếp bằng SELECT chỉ đọc xuyên schema (ngoại lệ có chủ đích, docs/03) và MỌI truy vấn đều
 * khoá `shop_id = <shopId từ ngữ cảnh shop>`; cache key luôn chứa shopId. Ngày = ngày giờ Việt Nam (Asia/Ho_Chi_Minh), gán theo
 * `orders.created_at` như báo cáo sàn (ReportingService.recomputeDay).
 *
 * Định nghĩa số liệu (ngày d, đơn con của shop):
 *  - orderCount      : số đơn tạo trong ngày (chưa xoá mềm), kể cả đơn huỷ.
 *  - paidCount       : số đơn tính doanh thu = status <> 'cancelled' VÀ payment_status IN ('paid','partially_refunded').
 *  - cancelledCount  : số đơn status = 'cancelled'.
 *  - revenue         : Σ(total + platform_discount) trên đơn tính doanh thu — voucher SÀN do sàn chịu và hoàn cho shop nên cộng lại.
 *  - discount        : Σ shop_discount trên đơn tính doanh thu (phần giảm giá shop tự chịu — khớp với revenue chỉ trừ giảm giá của shop).
 *  - shippingFee     : Σ shipping_fee, itemsSold: Σ item_count — cùng tập đơn tính doanh thu.
 *  - newCustomers    : số khách có đơn đầu tiên (không huỷ) TẠI SHOP NÀY rơi vào ngày d.
 *  - refunded        : Σ payment.refunds status 'done' của shop (shop_id; hoàn cũ NULL thì suy từ đơn qua order_code), tính theo processed_at.
 */
@Injectable()
export class ShopReportingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ------------------------------------------------------------ dashboard

  dashboard(shopId: string): Promise<ShopDashboardResponse> {
    return this.cache.getOrSet(CACHE.dashboard, `${shopId}`, () => this.buildDashboard(shopId));
  }

  private async buildDashboard(shopId: string): Promise<ShopDashboardResponse> {
    const today = ShopReportingService.vnDay(new Date());
    const monthStart = `${today.slice(0, 7)}-01`;
    const since7 = ShopReportingService.vnDay(new Date(Date.now() - 6 * 86_400_000));
    const [series, pendingRows, statusRows, top] = await Promise.all([
      this.dailySeries(shopId, since7 < monthStart ? since7 : monthStart, today),
      this.prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT
          (SELECT count(*) FROM "order"."orders" WHERE shop_id = ${shopId} AND is_deleted = false AND status = 'pending' AND (payment_method_code = 'cod' OR payment_status = 'paid')) AS awaiting_confirm,
          (SELECT count(*) FROM "order"."orders" WHERE shop_id = ${shopId} AND is_deleted = false AND status IN ('confirmed', 'packing')) AS packing,
          (SELECT count(*) FROM "order"."orders" WHERE shop_id = ${shopId} AND is_deleted = false AND status = 'shipping') AS shipping,
          (SELECT count(*) FROM "product"."product_variants" v JOIN "product"."products" p ON p.id = v.product_id
             WHERE v.is_deleted = false AND v.is_active = true AND p.is_deleted = false AND p.status = 'active' AND p.shop_id = ${shopId} AND (v.stock - v.reserved) <= 5) AS low_stock`,
      this.prisma.$queryRaw<Array<{ status: string; n: bigint }>>`
        SELECT status, count(*) AS n FROM "order"."orders" o WHERE o.shop_id = ${shopId} AND o.is_deleted = false GROUP BY status`,
      this.topProducts(shopId, monthStart, today, 5),
    ]);

    const last7: ShopDailyPointResponse[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = ShopReportingService.vnDay(new Date(Date.now() - i * 86_400_000));
      last7.push(ShopReportingService.toPoint(d, series.get(d) ?? null));
    }

    const monthRows = [...series.entries()].filter(([day]) => day >= monthStart).map(([, r]) => r);
    const sum = (f: (r: DailyRow) => number) => monthRows.reduce((a, r) => a + f(r), 0);
    const sumMoney = (f: (r: DailyRow) => Prisma.Decimal) => monthRows.reduce((a, r) => a + dec(f(r)), 0n);
    const p = pendingRows[0] ?? {};
    const n = (k: string): number => Number(p[k] ?? 0);

    return {
      today: ShopReportingService.toPoint(today, series.get(today) ?? null),
      month: {
        revenue: money(sumMoney((r) => r.revenue)),
        orderCount: sum((r) => r.orderCount),
        paidCount: sum((r) => r.paidCount),
        itemsSold: sum((r) => r.itemsSold),
        newCustomers: sum((r) => r.newCustomers),
        refunded: money(sumMoney((r) => r.refunded)),
      },
      pending: { awaitingConfirm: n('awaiting_confirm'), packing: n('packing'), shipping: n('shipping'), lowStock: n('low_stock') },
      last7Days: last7,
      topProducts: top,
      orderStatus: statusRows.map((r) => ({ status: r.status, count: Number(r.n) })),
      generatedAt: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------ doanh thu theo kỳ

  revenue(shopId: string, from: string, to: string, granularity: 'day' | 'month'): Promise<ShopRevenueResponse> {
    assertReportRange(from, to, granularity);
    return this.cache.getOrSet(CACHE.revenue, `${shopId}_${from}_${to}_${granularity}`, async () => {
      const series = await this.dailySeries(shopId, from, to);

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

      // Kỳ trống vẫn hiện (0) để biểu đồ liền mạch
      const buckets = new Map<string, Bucket>(ShopReportingService.periods(from, to, granularity).map((k) => [k, empty()]));
      for (const [day, r] of series) {
        const b = buckets.get(granularity === 'day' ? day : day.slice(0, 7));
        if (b) add(b, r);
      }

      const total = empty();
      const points: ShopRevenuePointResponse[] = [...buckets.entries()].map(([period, b]) => {
        add(total, b);
        return { period, ...ShopReportingService.toRevenuePoint(b) };
      });

      return { from, to, granularity, points, total: ShopReportingService.toRevenuePoint(total) };
    });
  }

  private static toRevenuePoint(b: { revenue: bigint; orderCount: number; paidCount: number; cancelledCount: number; itemsSold: number; discount: bigint; refunded: bigint }): Omit<ShopRevenuePointResponse, 'period'> {
    return { revenue: money(b.revenue), orderCount: b.orderCount, paidCount: b.paidCount, cancelledCount: b.cancelledCount, itemsSold: b.itemsSold, discount: money(b.discount), refunded: money(b.refunded) };
  }

  // ------------------------------------------------------------ chuỗi theo ngày của MỘT shop (thay cho reporting.daily_sales toàn sàn)

  /*
   * Ba truy vấn gộp theo ngày VN trong [from, to], tất cả khoá theo `shopId`; ngày không có dữ liệu thì vắng mặt trong Map
   * (toPoint/buckets điền 0). Không đụng reporting.daily_sales.
   */
  private async dailySeries(shopId: string, from: string, to: string): Promise<Map<string, DailyRow>> {
    const [orderRows, newCustomerRows, refundRows] = await Promise.all([
      this.prisma.$queryRaw<OrderDayRow[]>`
        SELECT to_char(o.created_at AT TIME ZONE ${VN_TZ}, 'YYYY-MM-DD') AS day,
               count(*) AS order_count,
               count(*) FILTER (WHERE ${PAID_ORDER}) AS paid_count,
               count(*) FILTER (WHERE o.status = 'cancelled') AS cancelled_count,
               coalesce(sum(o.total + o.platform_discount) FILTER (WHERE ${PAID_ORDER}), 0) AS revenue,
               coalesce(sum(o.shop_discount) FILTER (WHERE ${PAID_ORDER}), 0) AS discount,
               coalesce(sum(o.shipping_fee) FILTER (WHERE ${PAID_ORDER}), 0) AS shipping_fee,
               coalesce(sum(o.item_count) FILTER (WHERE ${PAID_ORDER}), 0) AS items_sold
        FROM "order"."orders" o
        WHERE o.shop_id = ${shopId} AND o.is_deleted = false AND ${vnWindow(Prisma.sql`o.created_at`, from, to)}
        GROUP BY 1 ORDER BY 1`,
      // Khách mới = khách có đơn ĐẦU TIÊN (không huỷ) tại shop này rơi vào ngày đó. Phải quét lịch sử của riêng shop để biết "đầu tiên".
      this.prisma.$queryRaw<NewCustomerDayRow[]>`
        SELECT to_char(f.first_at AT TIME ZONE ${VN_TZ}, 'YYYY-MM-DD') AS day, count(*) AS n
        FROM (
          SELECT o.user_id, min(o.created_at) AS first_at
          FROM "order"."orders" o
          WHERE o.shop_id = ${shopId} AND o.is_deleted = false AND o.status <> 'cancelled'
          GROUP BY o.user_id
        ) f
        WHERE ${vnWindow(Prisma.sql`f.first_at`, from, to)}
        GROUP BY 1 ORDER BY 1`,
      // Hoàn tiền ĐƠN đã xử lý (done) của shop — khoản hoàn thanh toán TRÙNG (kind='duplicate_payment') không phải đảo doanh thu nên không tính. refunds.shop_id NULL với hoàn cũ ⇒ suy shop từ đơn qua order_code (mã đơn duy nhất).
      this.prisma.$queryRaw<RefundDayRow[]>`
        SELECT to_char(r.processed_at AT TIME ZONE ${VN_TZ}, 'YYYY-MM-DD') AS day, coalesce(sum(r.amount), 0) AS amount
        FROM "payment"."refunds" r LEFT JOIN "order"."orders" ro ON ro.code = r.order_code
        WHERE r.status = 'done' AND r.kind = 'order' AND coalesce(r.shop_id, ro.shop_id) = ${shopId} AND ${vnWindow(Prisma.sql`r.processed_at`, from, to)}
        GROUP BY 1 ORDER BY 1`,
    ]);

    const series = new Map<string, DailyRow>();
    const at = (day: string): DailyRow => {
      const hit = series.get(day);
      if (hit) return hit;
      const fresh = emptyDay();
      series.set(day, fresh);
      return fresh;
    };
    for (const r of orderRows) {
      const d = at(r.day);
      d.orderCount = Number(r.order_count);
      d.paidCount = Number(r.paid_count);
      d.cancelledCount = Number(r.cancelled_count);
      d.revenue = new Prisma.Decimal(r.revenue ?? 0);
      d.discount = new Prisma.Decimal(r.discount ?? 0);
      d.shippingFee = new Prisma.Decimal(r.shipping_fee ?? 0);
      d.itemsSold = Number(r.items_sold ?? 0);
    }
    for (const r of newCustomerRows) at(r.day).newCustomers = Number(r.n);
    for (const r of refundRows) at(r.day).refunded = new Prisma.Decimal(r.amount ?? 0);
    return series;
  }

  // ------------------------------------------------------------ bán chạy

  /*
   * Bán chạy của shop. Số liệu RÒNG: chỉ đơn tính doanh thu (không huỷ, đã thu tiền); trừ số lượng đã trả hàng và hoàn tiền xong
   * (return_requests.status = 'refunded'); doanh thu dòng = line_total phân bổ theo tỷ lệ giảm giá của shop
   * ((subtotal − shop_discount) / subtotal) và theo số lượng còn lại. Khớp tinh thần `revenue` của báo cáo ngày (voucher sàn không trừ).
   */
  topProducts(shopId: string, from: string, to: string, limit = 10): Promise<ShopTopProductResponse[]> {
    assertReportRange(from, to, 'day');
    return this.cache.getOrSet(CACHE.top, `${shopId}_${from}_${to}_${limit}`, async () => {
      const filter = shopRevenueOrderFilter(shopId);
      const rows = await this.prisma.$queryRaw<Array<{ product_id: string; slug: string; name: string; image_url: string | null; quantity: bigint; revenue: Prisma.Decimal | null; order_count: bigint }>>`
        SELECT oi.product_id, max(oi.slug) AS slug, max(oi.name) AS name, max(oi.image_url) AS image_url,
               sum(oi.quantity - coalesce(ret.qty, 0)) AS quantity,
               coalesce(sum(oi.line_total * (oi.quantity - coalesce(ret.qty, 0)) / oi.quantity * (o.subtotal - o.shop_discount) / nullif(o.subtotal, 0)), 0) AS revenue,
               count(DISTINCT o.id) AS order_count
        FROM "order"."order_items" oi JOIN "order"."orders" o ON o.id = oi.order_id
        LEFT JOIN (
          SELECT ri.order_item_id, sum(ri.quantity)::int AS qty
          FROM "order"."return_request_items" ri
          JOIN "order"."return_requests" rr ON rr.id = ri.return_id
          JOIN "order"."orders" ro ON ro.id = rr.order_id
          WHERE rr.status = 'refunded' AND ro.shop_id = ${shopId}
          GROUP BY ri.order_item_id
        ) ret ON ret.order_item_id = oi.id
        WHERE ${filter} AND oi.shop_id = ${shopId} AND ${vnWindow(Prisma.sql`o.created_at`, from, to)}
        GROUP BY oi.product_id
        HAVING sum(oi.quantity - coalesce(ret.qty, 0)) > 0
        ORDER BY quantity DESC, revenue DESC LIMIT ${limit}`;
      return rows.map((r) => ({ productId: r.product_id, slug: r.slug, name: r.name, imageUrl: r.image_url, quantity: Number(r.quantity), revenue: money(dec(r.revenue)), orderCount: Number(r.order_count) }));
    });
  }

  // ------------------------------------------------------------ tồn thấp

  lowStock(shopId: string, threshold = 5, limit = 100): Promise<ShopLowStockResponse[]> {
    return this.cache.getOrSet(CACHE.lowstock, `${shopId}_${threshold}_${limit}`, async () => {
      // variant_label: sản phẩm dynamic ghép display_value các option bằng ' / ' (thứ tự theo attribute_id cho ổn định);
      // sản phẩm thời trang (không có option) rơi về "màu / size". color_name/size_code là NULL với dynamic.
      const rows = await this.prisma.$queryRaw<Array<{ id: string; product_id: string; name: string; slug: string; sku: string; color_name: string | null; size_code: string | null; stock: number; reserved: number; variant_label: string | null }>>`
        SELECT v.id, v.product_id, p.name, p.slug, v.sku, v.color_name, v.size_code, v.stock, v.reserved,
               coalesce(
                 nullif((SELECT string_agg(vo.display_value, ' / ' ORDER BY vo.attribute_id) FROM "product"."product_variant_options" vo WHERE vo.variant_id = v.id), ''),
                 nullif(concat_ws(' / ', v.color_name, v.size_code), '')
               ) AS variant_label
        FROM "product"."product_variants" v JOIN "product"."products" p ON p.id = v.product_id
        WHERE v.is_deleted = false AND v.is_active = true AND p.is_deleted = false AND p.status = 'active' AND p.shop_id = ${shopId} AND (v.stock - v.reserved) <= ${threshold}
        ORDER BY (v.stock - v.reserved) ASC, p.name ASC LIMIT ${limit}`;
      return rows.map((r) => ({
        variantId: r.id,
        productId: r.product_id,
        productName: r.name,
        slug: r.slug,
        sku: r.sku,
        colorName: r.color_name ?? '',
        sizeCode: r.size_code ?? '',
        stock: r.stock,
        reserved: r.reserved,
        available: r.stock - r.reserved,
        ...(r.variant_label ? { variantLabel: r.variant_label } : {}),
      }));
    });
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

  private static toPoint(day: string, r: DailyRow | null): ShopDailyPointResponse {
    return {
      day,
      orderCount: r?.orderCount ?? 0,
      paidCount: r?.paidCount ?? 0,
      cancelledCount: r?.cancelledCount ?? 0,
      revenue: money(dec(r?.revenue)),
      discount: money(dec(r?.discount)),
      shippingFee: money(dec(r?.shippingFee)),
      itemsSold: r?.itemsSold ?? 0,
      newCustomers: r?.newCustomers ?? 0,
      refunded: money(dec(r?.refunded)),
    };
  }
}
