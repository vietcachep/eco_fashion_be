import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { NotFoundException } from '@common/exception/business.exception';
import type { MoneyResponse } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CatalogQueryApi } from '../../catalog/queryapi/catalog.queryapi';
import { OrderQueryApi } from '../../order/queryapi/order.queryapi';
import { ProductCardResponse, ProductQueryApi } from '../../product/queryapi/product.queryapi';
import { ReportingQueryApi } from '../../reporting/queryapi/reporting.queryapi';
import { EmbeddingService } from '../embedding/embedding.service';
import { AI_CACHE, AI_ERR, AI_FEATURE } from '../foundation/ai.constants';
import { OpenAiProvider } from '../provider/openai.provider';

export interface ClassifyProductResponse {
  categorySlug: string | null;
  categoryName: string | null;
  gender: 'nam' | 'nu' | 'unisex' | null;
  tags: string[];
  material: string | null;
  confidence: number;
  alternatives: Array<{ categorySlug: string; categoryName: string }>;
  source: string;
}

export interface PrecheckResponse {
  ready: boolean;
  score: number;
  issues: Array<{ severity: 'block' | 'warn' | 'info'; field: string; problem: string; suggestion: string }>;
  missing: string[];
  source: string;
}

export interface InventoryInsightsResponse {
  generatedAt: string;
  windowDays: number;
  items: Array<{ variantId: string; productId: string; productName: string; slug: string; sku: string; label: string; available: number; sold30d: number; dailyRate: number; daysLeft: number | null; level: 'critical' | 'warning' | 'ok' | 'stale' | 'out' }>;
  criticalCount: number;
  warningCount: number;
  staleCount: number;
  outCount: number;
  aiSummary: string | null;
  generatedByAi: boolean;
}

export interface RevenueInsightResponse {
  generatedAt: string;
  current: { from: string; to: string; revenue: MoneyResponse; orders: number; itemsSold: number; refunded: MoneyResponse };
  previous: { from: string; to: string; revenue: MoneyResponse; orders: number; itemsSold: number; refunded: MoneyResponse };
  deltaRevenuePct: number | null;
  deltaOrdersPct: number | null;
  topProducts: Array<{ name: string; slug: string; quantity: number; revenue: MoneyResponse }>;
  aiSummary: string | null;
  generatedByAi: boolean;
}

export interface ComboSuggestionsResponse {
  generatedAt: string;
  windowDays: number;
  combos: Array<{ name: string; reason: string; discountPercent: number; evidence: 'orders' | 'similar'; orders: number; products: ProductCardResponse[] }>;
  generatedByAi: boolean;
}

const CATEGORY_HINTS: Array<{ slug: string; words: string[] }> = [
  { slug: 'ao-thun', words: ['thun', 'tee', 't-shirt', 'polo', 'croptop'] },
  { slug: 'ao-so-mi', words: ['sơ mi', 'so mi', 'shirt'] },
  { slug: 'ao-khoac', words: ['khoác', 'khoac', 'bomber', 'blazer', 'jacket', 'cardigan'] },
  { slug: 'quan-jean', words: ['jean', 'denim'] },
  { slug: 'quan-short', words: ['short', 'quần đùi'] },
  { slug: 'vay', words: ['chân váy', 'chan vay', 'váy', 'skirt'] },
  { slug: 'dam', words: ['đầm', 'dam', 'dress'] },
];

/*
 * Công cụ AI cho NHÂN VIÊN (đồng bộ, không ghi DB; AI lỗi → rule/số liệu thô vẫn đủ dùng):
 * classify (chọn ngành/giới/tag cho sản phẩm mới) · precheck (kiểm listing trước khi đăng: thiếu gì, câu nào dễ gây hiểu lầm)
 * · inventoryInsights (tốc độ bán 30 ngày → ngày còn lại theo biến thể + nhận xét) · revenueInsight (30 ngày vs 30 ngày trước,
 * AI CHỈ VIẾT nhận xét, cache 6h) · comboSuggestions (cặp đồng mua 90 ngày → AI đặt tên combo + % giảm ≤ 30; thiếu dữ liệu → cặp gần vector).
 * Nhân viên bấm "Tạo khuyến mãi" → FE gọi /admin/promotions sẵn có — ai KHÔNG ghi promotions.
 */
@Injectable()
export class StaffInsightService {
  private readonly logger = new Logger(StaffInsightService.name);

  constructor(
    private readonly openai: OpenAiProvider,
    private readonly products: ProductQueryApi,
    private readonly catalog: CatalogQueryApi,
    private readonly orders: OrderQueryApi,
    private readonly reports: ReportingQueryApi,
    private readonly embeddings: EmbeddingService,
    private readonly cache: CacheService,
  ) {}

  // ------------------------------------------------------------ phân loại

  async classify(actor: AuthenticatedActor, input: { name: string; description?: string | null; material?: string | null }): Promise<ClassifyProductResponse> {
    const categories = await this.catalog.listActiveCategories();
    const rule = StaffInsightService.ruleClassify(input, categories);
    if (!this.openai.isConfigured) return rule;
    try {
      const res = await this.openai.chatJson<{ categorySlug?: string; gender?: string; tags?: string[]; material?: string; confidence?: number; alternatives?: string[] }>(
        [
          { role: 'system', content: `Phân loại sản phẩm quần áo cho cửa hàng. Ngành hàng có: ${categories.map((c) => `${c.slug} (${c.name})`).join(', ')}. Giới: nam | nu | unisex. Tag gợi ý: new, sale, basic, office, party, summer, winter, casual. TRẢ JSON {"categorySlug", "gender", "tags": string[] (≤ 4), "material": string|null (chất liệu nếu nêu), "confidence": 0..1, "alternatives": string[] (≤ 2 slug khác có thể)}.` },
          { role: 'user', content: `Tên: ${input.name}\nMô tả: ${(input.description ?? '').slice(0, 1500)}\nChất liệu: ${input.material ?? ''}` },
        ],
        { feature: AI_FEATURE.STAFF_INSIGHT, userId: actor.userId, maxTokens: 200, temperature: 0 },
      );
      const cat = categories.find((c) => c.slug === res.data.categorySlug) ?? null;
      const alts = (res.data.alternatives ?? []).map((s) => categories.find((c) => c.slug === s)).filter((c): c is NonNullable<typeof c> => Boolean(c) && c!.slug !== cat?.slug).slice(0, 2);
      return { categorySlug: cat?.slug ?? rule.categorySlug, categoryName: cat?.name ?? rule.categoryName, gender: ['nam', 'nu', 'unisex'].includes(res.data.gender ?? '') ? (res.data.gender as 'nam') : rule.gender, tags: (res.data.tags ?? []).map((t) => String(t).toLowerCase().slice(0, 20)).slice(0, 4), material: res.data.material ?? rule.material, confidence: Math.min(1, Math.max(0, Number(res.data.confidence ?? 0.7))), alternatives: alts.map((c) => ({ categorySlug: c.slug, categoryName: c.name })), source: 'llm' };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Phân loại AI lỗi — dùng rule');
      return rule;
    }
  }

  static ruleClassify(input: { name: string; description?: string | null; material?: string | null }, categories: Array<{ slug: string; name: string }>): ClassifyProductResponse {
    const t = `${input.name} ${input.description ?? ''}`.toLowerCase();
    const hit = CATEGORY_HINTS.find((h) => h.words.some((w) => t.includes(w)));
    const cat = hit ? categories.find((c) => c.slug === hit.slug) ?? null : null;
    const gender = /\bnữ\b|\bnu\b|women/.test(t) || /váy|đầm/.test(t) ? 'nu' : /\bnam\b|men\b/.test(t) ? 'nam' : 'unisex';
    return { categorySlug: cat?.slug ?? null, categoryName: cat?.name ?? null, gender, tags: [], material: input.material ?? null, confidence: cat ? 0.5 : 0.2, alternatives: [], source: 'rule' };
  }

  // ------------------------------------------------------------ kiểm trước khi đăng

  async precheck(actor: AuthenticatedActor, productId: string): Promise<PrecheckResponse> {
    const detail = await this.products.detailForAiById(productId, true);
    if (!detail) throw new NotFoundException(AI_ERR.PRODUCT_NOT_FOUND, 'Không tìm thấy sản phẩm');
    const rule = StaffInsightService.rulePrecheck({ name: detail.name, hasImage: detail.imageCount > 0, shortDescription: detail.shortDescription, description: detail.description, material: detail.material, care: detail.care, variants: detail.variants.length });
    if (!this.openai.isConfigured) return rule;
    const text = [
      `Tên: ${detail.name}`,
      `Ngành: ${detail.categorySlug} · ${detail.gender} · trạng thái ${detail.status}`,
      `Giá: ${detail.price}${detail.listPrice ? ` (gốc ${detail.listPrice})` : ''}`,
      `Mô tả ngắn: ${detail.shortDescription ?? '(trống)'}`,
      `Mô tả: ${detail.description ?? '(trống)'}`,
      `Chất liệu: ${detail.material ?? '(trống)'}`,
      `Bảo quản: ${detail.care.join('; ') || '(trống)'}`,
      `Biến thể: ${detail.variants.length} (màu: ${[...new Set(detail.variants.map((v) => v.colorName))].join(', ') || '-'}; size: ${[...new Set(detail.variants.map((v) => v.sizeCode))].join(', ') || '-'})`,
      `Ảnh: ${detail.imageCount}`,
    ].join('\n');
    try {
      const res = await this.openai.chatJson<{ ready?: boolean; score?: number; issues?: Array<{ severity?: string; field?: string; problem?: string; suggestion?: string }>; missing?: string[] }>(
        [
          { role: 'system', content: 'Bạn là quản lý cửa hàng quần áo kiểm tra LISTING TRƯỚC KHI ĐĂNG. Tiêu chí: tên/mô tả rõ, đúng ngành; có chất liệu, form/dáng, hướng dẫn size, bảo quản; không hứa hẹn quá đà (chống nước tuyệt đối, không bao giờ phai…), không so sánh hạ thấp thương hiệu khác, không lỗi chính tả. TRẢ JSON {"ready": boolean, "score": 0-100, "issues": [{"severity": "block|warn|info", "field": "name|shortDescription|description|material|care|variants|images|other", "problem": string ≤ 140, "suggestion": string ≤ 160}] (≤ 8, block trước), "missing": string[] (thông tin khách hay cần mà chưa có)}.' },
          { role: 'user', content: text.slice(0, 6000) },
        ],
        { feature: AI_FEATURE.STAFF_INSIGHT, userId: actor.userId, maxTokens: 700, temperature: 0.1 },
      );
      const issues = (res.data.issues ?? []).filter((i) => i.problem).map((i) => ({ severity: (['block', 'warn', 'info'].includes(i.severity ?? '') ? i.severity : 'info') as 'block', field: (i.field ?? 'other').slice(0, 30), problem: i.problem!.slice(0, 140), suggestion: (i.suggestion ?? '').slice(0, 160) })).slice(0, 8);
      const merged = [...rule.issues.filter((r) => r.severity === 'block'), ...issues.filter((i) => !rule.issues.some((r) => r.field === i.field && r.severity === 'block'))].slice(0, 8);
      return { ready: Boolean(res.data.ready) && !merged.some((i) => i.severity === 'block'), score: Math.min(100, Math.max(0, Number(res.data.score ?? rule.score))), issues: merged, missing: (res.data.missing ?? []).map((m) => String(m).slice(0, 80)).slice(0, 8), source: 'llm' };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, productId }, 'Precheck AI lỗi — dùng rule');
      return rule;
    }
  }

  static rulePrecheck(p: { name: string; hasImage: boolean; shortDescription: string | null; description: string | null; material: string | null; care: string[]; variants: number }): PrecheckResponse {
    const issues: PrecheckResponse['issues'] = [];
    const missing: string[] = [];
    if (!p.hasImage) issues.push({ severity: 'block', field: 'images', problem: 'Chưa có ảnh sản phẩm', suggestion: 'Thêm ít nhất 1 ảnh chính, tốt nhất theo từng màu' });
    if (p.variants === 0) issues.push({ severity: 'block', field: 'variants', problem: 'Chưa có biến thể màu/size', suggestion: 'Thêm biến thể và nhập tồn qua phiếu nhập' });
    if (p.name.trim().length < 8) issues.push({ severity: 'warn', field: 'name', problem: 'Tên quá ngắn', suggestion: 'Nêu loại + đặc điểm nổi bật, ví dụ "Áo thun cotton nam basic"' });
    if (!p.description || p.description.length < 80) issues.push({ severity: 'warn', field: 'description', problem: 'Mô tả quá ngắn (< 80 ký tự)', suggestion: 'Thêm form/dáng, dịp mặc, cách phối, cảm giác vải' });
    if (!p.shortDescription) missing.push('Mô tả ngắn cho thẻ sản phẩm');
    if (!p.material) missing.push('Chất liệu');
    if (p.care.length === 0) missing.push('Hướng dẫn bảo quản/giặt');
    const score = Math.max(0, 100 - issues.filter((i) => i.severity === 'block').length * 40 - issues.filter((i) => i.severity === 'warn').length * 15 - missing.length * 5);
    return { ready: !issues.some((i) => i.severity === 'block'), score, issues, missing, source: 'rule' };
  }

  // ------------------------------------------------------------ tồn kho

  async inventoryInsights(actor: AuthenticatedActor): Promise<InventoryInsightsResponse> {
    return this.cache.getOrSet(AI_CACHE.staffInsight, 'inventory', async () => {
      const windowDays = 30;
      const [snapshot, sold] = await Promise.all([this.products.variantStockSnapshot(), this.orders.soldByVariant(windowDays)]);
      const items = snapshot
        .map((v) => {
          const sold30d = sold.get(v.variantId) ?? 0;
          const dailyRate = Math.round((sold30d / windowDays) * 100) / 100;
          const daysLeft = dailyRate > 0 ? Math.round((v.available / dailyRate) * 10) / 10 : null;
          const level: InventoryInsightsResponse['items'][number]['level'] = v.available <= 0 ? 'out' : daysLeft === null ? 'stale' : daysLeft < 7 ? 'critical' : daysLeft < 14 ? 'warning' : 'ok';
          return { ...v, sold30d, dailyRate, daysLeft, level };
        })
        .filter((i) => i.level !== 'ok')
        .sort((a, b) => {
          const rank = { out: 0, critical: 1, warning: 2, stale: 3, ok: 4 };
          return rank[a.level] - rank[b.level] || (a.daysLeft ?? 999) - (b.daysLeft ?? 999);
        })
        .slice(0, 60);
      const counts = { criticalCount: items.filter((i) => i.level === 'critical').length, warningCount: items.filter((i) => i.level === 'warning').length, staleCount: items.filter((i) => i.level === 'stale').length, outCount: items.filter((i) => i.level === 'out').length };
      const base: InventoryInsightsResponse = { generatedAt: new Date().toISOString(), windowDays, items, ...counts, aiSummary: null, generatedByAi: false };
      if (!this.openai.isConfigured || items.length === 0) return base;
      try {
        const res = await this.openai.chatJson<{ summary?: string }>(
          [
            { role: 'system', content: 'Bạn là quản lý kho cửa hàng quần áo. Từ bảng tốc độ bán 30 ngày, viết 2-5 gạch đầu dòng nhận xét NGẮN tiếng Việt cho nhân viên: cần nhập gì gấp (critical < 7 ngày), món nào bán chậm (stale) nên giảm giá/ghép combo, món hết hàng đang mất doanh thu. Chỉ dùng số trong bảng. Không dùng ngoặc kép. TRẢ JSON {"summary": string (các dòng bắt đầu bằng "- ")}.' },
            { role: 'user', content: items.slice(0, 40).map((i) => `${i.productName} ${i.label} (${i.sku}): còn ${i.available}, bán 30 ngày ${i.sold30d}, còn ~${i.daysLeft ?? '∞'} ngày, mức ${i.level}`).join('\n') },
          ],
          { feature: AI_FEATURE.STAFF_INSIGHT, userId: actor.userId, maxTokens: 350, temperature: 0.3 },
        );
        return { ...base, aiSummary: (res.data.summary ?? '').slice(0, 1200) || null, generatedByAi: Boolean(res.data.summary) };
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'Nhận xét tồn kho AI lỗi — trả bảng số');
        return base;
      }
    });
  }

  // ------------------------------------------------------------ doanh thu

  async revenueInsight(actor: AuthenticatedActor): Promise<RevenueInsightResponse> {
    return this.cache.getOrSet(AI_CACHE.staffInsight, 'revenue', async () => {
      const day = (d: number) => this.reports.vnDay(new Date(Date.now() - d * 86_400_000));
      const cur = { from: day(29), to: day(0) };
      const prev = { from: day(59), to: day(30) };
      const [c, p, top] = await Promise.all([this.reports.revenue(cur.from, cur.to, 'day'), this.reports.revenue(prev.from, prev.to, 'day'), this.reports.topProducts(cur.from, cur.to, 5)]);
      const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
      const cRev = Number(c.total.revenue.amount);
      const pRev = Number(p.total.revenue.amount);
      const base: RevenueInsightResponse = {
        generatedAt: new Date().toISOString(),
        current: { ...cur, revenue: c.total.revenue, orders: c.total.paidCount, itemsSold: c.total.itemsSold, refunded: c.total.refunded },
        previous: { ...prev, revenue: p.total.revenue, orders: p.total.paidCount, itemsSold: p.total.itemsSold, refunded: p.total.refunded },
        deltaRevenuePct: pct(cRev, pRev),
        deltaOrdersPct: pct(c.total.paidCount, p.total.paidCount),
        topProducts: top.map((t) => ({ name: t.name, slug: t.slug, quantity: t.quantity, revenue: t.revenue })),
        aiSummary: null,
        generatedByAi: false,
      };
      if (!this.openai.isConfigured) return base;
      try {
        const res = await this.openai.chatJson<{ summary?: string }>(
          [
            { role: 'system', content: 'Bạn là quản lý cửa hàng quần áo. Viết 3-5 gạch đầu dòng nhận xét NGẮN tiếng Việt về doanh thu 30 ngày qua so với 30 ngày trước và top sản phẩm: xu hướng, ngày cao/thấp, gợi ý hành động (nhập thêm, khuyến mãi, đẩy sản phẩm). CHỈ dùng số được cung cấp; tiền viết dạng đã cho. Không dùng ngoặc kép. TRẢ JSON {"summary": string}.' },
            { role: 'user', content: `30 NGÀY QUA (${cur.from}→${cur.to}): doanh thu ${c.total.revenue.display}, đơn đã thanh toán ${c.total.paidCount}, huỷ ${c.total.cancelledCount}, sản phẩm bán ${c.total.itemsSold}, hoàn ${c.total.refunded.display}.\n30 NGÀY TRƯỚC (${prev.from}→${prev.to}): doanh thu ${p.total.revenue.display}, đơn ${p.total.paidCount}, huỷ ${p.total.cancelledCount}, bán ${p.total.itemsSold}, hoàn ${p.total.refunded.display}.\nTheo ngày (30 ngày qua): ${c.points.filter((x) => x.paidCount > 0).map((x) => `${x.period}: ${x.revenue.display} (${x.paidCount} đơn)`).join('; ') || 'không có đơn'}.\nTop: ${top.map((t) => `${t.name} ${t.quantity} cái ${t.revenue.display}`).join('; ') || 'chưa có'}.` },
          ],
          { feature: AI_FEATURE.STAFF_INSIGHT, userId: actor.userId, maxTokens: 350, temperature: 0.3 },
        );
        return { ...base, aiSummary: (res.data.summary ?? '').slice(0, 1200) || null, generatedByAi: Boolean(res.data.summary) };
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'Nhận xét doanh thu AI lỗi — trả số');
        return base;
      }
    });
  }

  // ------------------------------------------------------------ combo

  async comboSuggestions(actor: AuthenticatedActor): Promise<ComboSuggestionsResponse> {
    return this.cache.getOrSet(AI_CACHE.staffInsight, 'combo', async () => {
      const windowDays = 90;
      let pairs: Array<{ productA: string; productB: string; orders: number; evidence: 'orders' | 'similar' }> = (await this.orders.coPurchasePairs(windowDays, 12)).filter((p) => p.orders >= 2).map((p) => ({ ...p, evidence: 'orders' as const }));
      if (pairs.length < 3) {
        // Shop mới / ít đơn: cặp gần vector nhất từ vài sản phẩm bán chạy → gợi ý "mềm".
        const seeds = await this.products.recommend({ limit: 6 });
        for (const s of seeds) {
          const sim = await this.embeddings.similarProducts(s.id, 2).catch(() => [] as string[]);
          for (const id of sim) if (!pairs.some((p) => (p.productA === s.id && p.productB === id) || (p.productA === id && p.productB === s.id))) pairs.push({ productA: s.id, productB: id, orders: 0, evidence: 'similar' as const });
          if (pairs.length >= 6) break;
        }
      }
      pairs = pairs.slice(0, 8);
      const ids = [...new Set(pairs.flatMap((p) => [p.productA, p.productB]))];
      const cards = new Map((await this.products.cardsByIds(ids)).map((c) => [c.id, c]));
      const valid = pairs.filter((p) => cards.has(p.productA) && cards.has(p.productB));
      let combos = valid.map((p) => {
        const a = cards.get(p.productA)!;
        const b = cards.get(p.productB)!;
        return { name: `${a.name} + ${b.name}`, reason: p.evidence === 'orders' ? `Cùng nằm trong ${p.orders} đơn 90 ngày qua` : 'Phong cách tương đồng, dễ phối cùng nhau', discountPercent: 10, evidence: p.evidence, orders: p.orders, products: [a, b] };
      });
      let byAi = false;
      if (this.openai.isConfigured && combos.length > 0) {
        try {
          const res = await this.openai.chatJson<{ combos?: Array<{ index?: number; name?: string; reason?: string; discountPercent?: number }> }>(
            [
              { role: 'system', content: 'Bạn là marketing cửa hàng quần áo. Cho các CẶP sản phẩm hay được mua cùng, với mỗi cặp: đặt TÊN combo (3-6 từ, hấp dẫn, tiếng Việt), một câu LÝ DO (≤ 90 ký tự, vì sao hợp nhau/dịp nào) và mức giảm % hợp lý (5-30, cặp bán chạy thì giảm ít). Không dùng ngoặc kép. TRẢ JSON {"combos":[{"index","name","reason","discountPercent"}]}.' },
              { role: 'user', content: combos.map((c, i) => `#${i}: ${c.products[0].name} (${c.products[0].price.display}) + ${c.products[1].name} (${c.products[1].price.display}) — ${c.evidence === 'orders' ? `${c.orders} đơn chung` : 'tương đồng'}`).join('\n') },
            ],
            { feature: AI_FEATURE.STAFF_INSIGHT, userId: actor.userId, maxTokens: 500, temperature: 0.6 },
          );
          for (const c of res.data.combos ?? []) {
            if (typeof c.index !== 'number' || !combos[c.index]) continue;
            combos[c.index] = { ...combos[c.index], name: (c.name ?? combos[c.index].name).slice(0, 80), reason: (c.reason ?? combos[c.index].reason).slice(0, 120), discountPercent: Math.min(30, Math.max(5, Math.round(Number(c.discountPercent ?? 10)))) };
          }
          byAi = true;
        } catch (err) {
          this.logger.warn({ err: (err as Error).message }, 'Đặt tên combo AI lỗi — dùng tên ghép');
        }
      }
      combos = combos.map((c) => ({ ...c, discountPercent: Math.min(30, c.discountPercent) }));
      return { generatedAt: new Date().toISOString(), windowDays, combos, generatedByAi: byAi };
    });
  }
}
