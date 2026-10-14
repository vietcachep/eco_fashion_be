import type { CacheService, CacheSpec } from '@common/cache/cache.service';
import { BusinessException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { REPORTING_INVALID_RANGE } from './reporting-range';
import { ShopReportingService } from './shop-reporting.service';

/*
 * Cô lập dữ liệu giữa các gian hàng ở báo cáo vendor. Service chạy THẬT; PrismaService được thay bằng bản giả ghi lại từng câu
 * SQL + tham số (đã "phẳng hoá" như Prisma gửi xuống Postgres) và trả dữ liệu KHÁC NHAU theo tham số shopId tìm thấy trong câu lệnh.
 * Quy tắc cần giữ:
 *  - không câu SQL nào thiếu tham số shopId của chính shop đang xem (và không câu nào mang shopId khác);
 *  - không đọc reporting.daily_sales (bảng TOÀN SÀN, không có shop_id) — bản giả ném lỗi nếu bị đụng tới;
 *  - số liệu shop A không lẫn số shop B; cache key luôn bắt đầu bằng shopId.
 */

const SHOP_A = '11111111-1111-4111-8111-111111111111';
const SHOP_B = '22222222-2222-4222-8222-222222222222';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* 12:00 giờ VN ngày 15/09/2026 ⇒ hôm nay = 2026-09-15, đầu tháng = 2026-09-01, 7 ngày = 09-09 … 09-15. */
const NOW = new Date('2026-09-15T05:00:00Z');

const D = (v: number): Prisma.Decimal => new Prisma.Decimal(v);

type OrderDayRow = { day: string; order_count: bigint; paid_count: bigint; cancelled_count: bigint; revenue: Prisma.Decimal; discount: Prisma.Decimal; shipping_fee: Prisma.Decimal; items_sold: bigint };
type TopRow = { product_id: string; slug: string; name: string; image_url: string | null; quantity: bigint; revenue: Prisma.Decimal; order_count: bigint };
type LowRow = { id: string; product_id: string; name: string; slug: string; sku: string; color_name: string | null; size_code: string | null; stock: number; reserved: number; variant_label: string | null };

interface ShopFixture {
  orders: OrderDayRow[];
  newCustomers: Array<{ day: string; n: bigint }>;
  refunds: Array<{ day: string; amount: Prisma.Decimal }>;
  pending: Record<string, bigint>;
  status: Array<{ status: string; n: bigint }>;
  top: TopRow[];
  low: LowRow[];
}

/* Mỗi shop một bộ số riêng — nếu service lẫn tham số, số của shop kia sẽ lộ ra ngay. */
const FIXTURES: Record<string, ShopFixture> = {
  [SHOP_A]: {
    orders: [
      { day: '2026-09-15', order_count: 3n, paid_count: 2n, cancelled_count: 1n, revenue: D(1_000_000), discount: D(50_000), shipping_fee: D(30_000), items_sold: 4n },
      { day: '2026-09-10', order_count: 1n, paid_count: 1n, cancelled_count: 0n, revenue: D(500_000), discount: D(0), shipping_fee: D(0), items_sold: 1n },
    ],
    newCustomers: [{ day: '2026-09-15', n: 2n }],
    refunds: [{ day: '2026-09-15', amount: D(100_000) }],
    pending: { awaiting_confirm: 4n, packing: 2n, shipping: 1n, low_stock: 3n },
    status: [
      { status: 'pending', n: 4n },
      { status: 'shipping', n: 1n },
    ],
    top: [{ product_id: 'prod-a', slug: 'ao-a', name: 'Áo A', image_url: null, quantity: 5n, revenue: D(750_000), order_count: 3n }],
    low: [
      { id: 'var-a1', product_id: 'prod-a', name: 'Áo A', slug: 'ao-a', sku: 'SKU-A1', color_name: 'Đỏ', size_code: 'M', stock: 3, reserved: 1, variant_label: 'Đỏ / M' },
      { id: 'var-a2', product_id: 'prod-a2', name: 'Điện thoại A', slug: 'dt-a', sku: 'SKU-A2', color_name: null, size_code: null, stock: 2, reserved: 0, variant_label: '128GB / Đen' },
    ],
  },
  [SHOP_B]: {
    orders: [{ day: '2026-09-15', order_count: 30n, paid_count: 25n, cancelled_count: 5n, revenue: D(9_000_000), discount: D(700_000), shipping_fee: D(300_000), items_sold: 40n }],
    newCustomers: [{ day: '2026-09-15', n: 20n }],
    refunds: [{ day: '2026-09-15', amount: D(7_000_000) }],
    pending: { awaiting_confirm: 99n, packing: 88n, shipping: 77n, low_stock: 66n },
    status: [{ status: 'pending', n: 99n }],
    top: [{ product_id: 'prod-b', slug: 'quan-b', name: 'Quần B', image_url: 'https://img/b.jpg', quantity: 50n, revenue: D(8_000_000), order_count: 30n }],
    low: [{ id: 'var-b1', product_id: 'prod-b', name: 'Quần B', slug: 'quan-b', sku: 'SKU-B1', color_name: 'Xanh', size_code: 'L', stock: 1, reserved: 0, variant_label: 'Xanh / L' }],
  },
};

interface Captured {
  text: string;
  values: unknown[];
}

/* Trả dữ liệu theo shopId tìm thấy trong tham số — không tìm thấy (truy vấn thiếu shop) ⇒ rỗng, và test khác sẽ bắt lỗi thiếu tham số. */
const respond = (q: Captured): unknown[] => {
  const shopId = q.values.find((v): v is string => typeof v === 'string' && UUID_RE.test(v));
  const f = shopId ? FIXTURES[shopId] : undefined;
  if (!f) return [];
  if (q.text.includes('"order"."order_items"')) return f.top; // top sản phẩm cũng có `AS order_count` ⇒ xét trước truy vấn đơn theo ngày
  if (q.text.includes('AS cancelled_count')) return f.orders;
  if (q.text.includes('first_at')) return f.newCustomers;
  if (q.text.includes('"payment"."refunds"')) return f.refunds;
  if (q.text.includes('AS awaiting_confirm')) return [f.pending];
  if (q.text.includes('GROUP BY status')) return f.status;
  if (q.text.includes('ORDER BY (v.stock - v.reserved)')) return f.low;
  throw new Error(`Truy vấn ngoài dự kiến: ${q.text}`);
};

function harness(): { service: ShopReportingService; calls: Captured[]; cacheKeys: Array<{ purpose: string; key: string }>; dailySalesReads: () => number } {
  const calls: Captured[] = [];
  const cacheKeys: Array<{ purpose: string; key: string }> = [];
  let dailySalesReads = 0;
  const prisma = {
    $queryRaw: (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<unknown[]> => {
      // Prisma gộp template + tham số (kể cả Prisma.Sql lồng nhau) thành câu `$1, $2…` — Prisma.sql() làm y hệt.
      const q = strings instanceof Prisma.Sql ? strings : Prisma.sql(strings, ...values);
      const captured: Captured = { text: q.text, values: [...q.values] };
      calls.push(captured);
      return Promise.resolve(respond(captured));
    },
  };
  Object.defineProperty(prisma, 'dailySales', {
    get: () => {
      dailySalesReads++;
      throw new Error('ShopReportingService không được đọc reporting.daily_sales (số liệu TOÀN SÀN, không có shop_id)');
    },
  });
  const cache = {
    getOrSet: <T>(spec: CacheSpec, key: string, loader: () => Promise<T>): Promise<T> => {
      cacheKeys.push({ purpose: spec.purpose, key });
      return loader();
    },
  };
  const service = new ShopReportingService(prisma as unknown as PrismaService, cache as unknown as CacheService);
  return { service, calls, cacheKeys, dailySalesReads: () => dailySalesReads };
}

/* Mọi câu SQL: có điều kiện shop_id gắn với tham số, tham số mang ĐÚNG shopId của mình và không mang uuid nào khác. */
function expectOnlyShop(calls: Captured[], shopId: string): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.text).toMatch(/shop_id\)?\s*=\s*\$\d+/);
    expect(c.values).toContain(shopId);
    const uuids = c.values.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v));
    expect(uuids.length).toBeGreaterThan(0);
    for (const u of uuids) expect(u).toBe(shopId);
  }
}

describe('ShopReportingService — cô lập dữ liệu giữa các shop', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('dashboard()', () => {
    it('shop A: mọi truy vấn chỉ mang shopId A, không đọc daily_sales, cache key theo shopId', async () => {
      const h = harness();
      await h.service.dashboard(SHOP_A);

      expectOnlyShop(h.calls, SHOP_A);
      expect(h.calls.length).toBeGreaterThanOrEqual(6); // 3 truy vấn ngày + việc chờ + trạng thái + top
      expect(h.dailySalesReads()).toBe(0);
      expect(h.cacheKeys.length).toBeGreaterThan(0);
      for (const k of h.cacheKeys) expect(k.key.startsWith(SHOP_A)).toBe(true);
      expect(h.cacheKeys[0]).toEqual({ purpose: 'shop-dashboard', key: SHOP_A });
    });

    it('khoảng ngày truyền xuống SQL là đầu tháng → hôm nay (giờ VN)', async () => {
      const h = harness();
      await h.service.dashboard(SHOP_A);
      const ordersQuery = h.calls.find((c) => c.text.includes('AS cancelled_count'));
      expect(ordersQuery?.values).toEqual(expect.arrayContaining(['2026-09-01', '2026-09-15']));
      expect(ordersQuery?.values).toContain('Asia/Ho_Chi_Minh');
    });

    it('số liệu shop A đúng và KHÔNG lẫn số của shop B', async () => {
      const h = harness();
      const r = await h.service.dashboard(SHOP_A);

      expect(r.today).toMatchObject({ day: '2026-09-15', orderCount: 3, paidCount: 2, cancelledCount: 1, itemsSold: 4, newCustomers: 2 });
      expect(r.today.revenue.amount).toBe('1000000');
      expect(r.today.discount.amount).toBe('50000');
      expect(r.today.shippingFee.amount).toBe('30000');
      expect(r.today.refunded.amount).toBe('100000');
      expect(r.month.revenue.amount).toBe('1500000');
      expect(r.month).toMatchObject({ orderCount: 4, paidCount: 3, itemsSold: 5, newCustomers: 2 });
      expect(r.month.refunded.amount).toBe('100000');
      expect(r.pending).toEqual({ awaitingConfirm: 4, packing: 2, shipping: 1, lowStock: 3 });
      expect(r.orderStatus).toEqual([
        { status: 'pending', count: 4 },
        { status: 'shipping', count: 1 },
      ]);
      expect(r.topProducts.map((t) => t.productId)).toEqual(['prod-a']);
      expect(r.last7Days.map((p) => p.day)).toEqual(['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15']);
      expect(r.last7Days.find((p) => p.day === '2026-09-10')?.revenue.amount).toBe('500000');

      const json = JSON.stringify(r);
      for (const leak of ['9000000', '8000000', '7000000', 'prod-b', 'Quần B']) expect(json).not.toContain(leak);
    });

    it('shop B nhận số của B, không lẫn A (cùng một service, tham số khác)', async () => {
      const hb = harness();
      const rb = await hb.service.dashboard(SHOP_B);

      expectOnlyShop(hb.calls, SHOP_B);
      expect(rb.today.revenue.amount).toBe('9000000');
      expect(rb.month.revenue.amount).toBe('9000000');
      expect(rb.pending.awaitingConfirm).toBe(99);
      expect(rb.topProducts.map((t) => t.productId)).toEqual(['prod-b']);
      const json = JSON.stringify(rb);
      for (const leak of ['1000000', '1500000', 'prod-a', 'Áo A']) expect(json).not.toContain(leak);
    });
  });

  describe('revenue()', () => {
    it('shop A theo ngày: mọi truy vấn chỉ có shopId A, không đọc daily_sales, key cache có shopId', async () => {
      const h = harness();
      const r = await h.service.revenue(SHOP_A, '2026-09-01', '2026-09-15', 'day');

      expectOnlyShop(h.calls, SHOP_A);
      expect(h.calls).toHaveLength(3);
      expect(h.dailySalesReads()).toBe(0);
      expect(h.cacheKeys).toEqual([{ purpose: 'shop-revenue', key: `${SHOP_A}_2026-09-01_2026-09-15_day` }]);

      expect(r.points).toHaveLength(15);
      expect(r.points.find((p) => p.period === '2026-09-15')?.revenue.amount).toBe('1000000');
      expect(r.points.find((p) => p.period === '2026-09-10')?.revenue.amount).toBe('500000');
      expect(r.points.find((p) => p.period === '2026-09-12')?.revenue.amount).toBe('0');
      expect(r.total.revenue.amount).toBe('1500000');
      expect(r.total).toMatchObject({ orderCount: 4, paidCount: 3, cancelledCount: 1, itemsSold: 5 });
      expect(r.total.refunded.amount).toBe('100000');
      expect(JSON.stringify(r)).not.toContain('9000000');
    });

    it('theo tháng: gộp đúng kỳ và vẫn chỉ của shop mình', async () => {
      const h = harness();
      const r = await h.service.revenue(SHOP_A, '2026-08-15', '2026-09-15', 'month');

      expectOnlyShop(h.calls, SHOP_A);
      expect(r.points.map((p) => p.period)).toEqual(['2026-08', '2026-09']);
      expect(r.points[0]?.revenue.amount).toBe('0');
      expect(r.points[1]?.revenue.amount).toBe('1500000');
    });

    it('shop B không thấy số A', async () => {
      const h = harness();
      const r = await h.service.revenue(SHOP_B, '2026-09-01', '2026-09-15', 'day');

      expectOnlyShop(h.calls, SHOP_B);
      expect(r.total.revenue.amount).toBe('9000000');
      expect(JSON.stringify(r)).not.toContain('1500000');
    });

    it('định nghĩa doanh thu: Σ(total + platform_discount) đơn đã thu tiền, không huỷ; khách mới theo shop; hoàn theo shop', async () => {
      const h = harness();
      await h.service.revenue(SHOP_A, '2026-09-01', '2026-09-15', 'day');
      const orders = h.calls.find((c) => c.text.includes('AS cancelled_count'));
      expect(orders?.text).toContain('o.total + o.platform_discount');
      expect(orders?.text).toContain("o.payment_status IN ('paid', 'partially_refunded')");
      expect(orders?.text).toContain("o.status <> 'cancelled'");
      expect(orders?.text).toContain('o.is_deleted = false');
      const firstTime = h.calls.find((c) => c.text.includes('first_at'));
      expect(firstTime?.text).toContain('GROUP BY o.user_id');
      expect(firstTime?.text).toMatch(/o\.shop_id = \$\d+/);
      const refunds = h.calls.find((c) => c.text.includes('"payment"."refunds"'));
      expect(refunds?.text).toContain("r.status = 'done'");
      // Hoàn thanh toán TRÙNG không đảo doanh thu của shop ⇒ chỉ tính hoàn theo đơn.
      expect(refunds?.text).toContain("r.kind = 'order'");
      expect(refunds?.text).toMatch(/coalesce\(r\.shop_id, ro\.shop_id\) = \$\d+/);
    });
  });

  describe('topProducts()', () => {
    it('shop A: mọi tham số lọc là shopId A; kết quả không lẫn B', async () => {
      const h = harness();
      const rows = await h.service.topProducts(SHOP_A, '2026-09-01', '2026-09-15', 5);

      expectOnlyShop(h.calls, SHOP_A);
      expect(h.dailySalesReads()).toBe(0);
      expect(h.cacheKeys).toEqual([{ purpose: 'shop-top-products', key: `${SHOP_A}_2026-09-01_2026-09-15_5` }]);
      expect(rows).toEqual([{ productId: 'prod-a', slug: 'ao-a', name: 'Áo A', imageUrl: null, quantity: 5, revenue: { amount: '750000', display: expect.any(String) as string, currency: 'VND', symbol: '₫' }, orderCount: 3 }]);
      // truy vấn gộp cả đơn lẫn dòng hàng — cả hai bảng đều bị khoá shop
      const q = h.calls[0];
      expect(q?.text).toMatch(/o\.shop_id = \$\d+/);
      expect(q?.text).toMatch(/oi\.shop_id = \$\d+/);
      expect(q?.text).toMatch(/ro\.shop_id = \$\d+/);
    });

    it('shop B nhận top của B', async () => {
      const h = harness();
      const rows = await h.service.topProducts(SHOP_B, '2026-09-01', '2026-09-15');

      expectOnlyShop(h.calls, SHOP_B);
      expect(rows.map((r) => r.productId)).toEqual(['prod-b']);
    });
  });

  describe('lowStock()', () => {
    it('shop A: chỉ tham số shopId A (ngưỡng/limit là số), không lẫn B', async () => {
      const h = harness();
      const rows = await h.service.lowStock(SHOP_A, 5, 100);

      expectOnlyShop(h.calls, SHOP_A);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.values).toEqual([SHOP_A, 5, 100]);
      expect(h.cacheKeys).toEqual([{ purpose: 'shop-low-stock', key: `${SHOP_A}_5_100` }]);
      expect(rows.map((r) => r.variantId)).toEqual(['var-a1', 'var-a2']);
      expect(JSON.stringify(rows)).not.toContain('var-b1');
    });

    it('variantLabel: dynamic lấy từ option, thời trang "màu / size"; colorName/sizeCode null → chuỗi rỗng', async () => {
      const h = harness();
      const rows = await h.service.lowStock(SHOP_A);
      expect(rows[0]).toMatchObject({ colorName: 'Đỏ', sizeCode: 'M', variantLabel: 'Đỏ / M', available: 2 });
      expect(rows[1]).toMatchObject({ colorName: '', sizeCode: '', variantLabel: '128GB / Đen', available: 2 });
    });

    it('shop B nhận tồn thấp của B', async () => {
      const h = harness();
      const rows = await h.service.lowStock(SHOP_B);

      expectOnlyShop(h.calls, SHOP_B);
      expect(rows.map((r) => r.variantId)).toEqual(['var-b1']);
    });
  });

  describe('khoảng ngày không hợp lệ bị chặn TRƯỚC khi chạm DB (400, không phải 500)', () => {
    const rejects = async (fn: () => Promise<unknown>): Promise<BusinessException> => {
      try {
        await fn();
      } catch (e) {
        expect(e).toBeInstanceOf(BusinessException);
        return e as BusinessException;
      }
      throw new Error('Phải ném BusinessException');
    };

    it.each([
      ['ngày không có thật (13/45)', '2026-13-45', '2026-09-15', 'day'],
      ['30/02', '2026-02-30', '2026-03-01', 'day'],
      ['from > to', '2026-09-15', '2026-09-01', 'day'],
      ['quá 400 ngày', '2025-01-01', '2026-09-15', 'day'],
      ['0001-01-01 → 9999-12-31 (DoS)', '0001-01-01', '9999-12-31', 'day'],
      ['theo tháng quá 60 tháng', '2021-12-01', '2026-12-31', 'month'],
    ] as const)('revenue: %s', async (_name, from, to, granularity) => {
      const h = harness();
      const e = await rejects(() => h.service.revenue(SHOP_A, from, to, granularity));
      expect(e.errorCode).toBe(REPORTING_INVALID_RANGE);
      expect(e.httpStatus).toBe(400);
      expect(h.calls).toHaveLength(0);
    });

    it('topProducts cũng bị chặn', async () => {
      const h = harness();
      const e = await rejects(() => h.service.topProducts(SHOP_A, '0001-01-01', '9999-12-31'));
      expect(e.errorCode).toBe(REPORTING_INVALID_RANGE);
      expect(h.calls).toHaveLength(0);
    });

    it('biên hợp lệ: đúng 400 ngày / đúng 60 tháng vẫn chạy', async () => {
      const h = harness();
      const days = await h.service.revenue(SHOP_A, '2026-01-01', '2027-02-04', 'day');
      expect(days.points).toHaveLength(400);
      const months = await h.service.revenue(SHOP_A, '2022-01-01', '2026-12-31', 'month');
      expect(months.points).toHaveLength(60);
    });
  });
});
