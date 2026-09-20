import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CartQueryApi } from '../../cart/queryapi/cart.queryapi';
import { CatalogQueryApi } from '../../catalog/queryapi/catalog.queryapi';
import { OrderQueryApi } from '../../order/queryapi/order.queryapi';
import { ProductCardResponse, ProductQueryApi } from '../../product/queryapi/product.queryapi';
import { EmbeddingService } from '../embedding/embedding.service';
import { AI_CACHE, AI_ERR, AI_FEATURE } from '../foundation/ai.constants';
import { OpenAiProvider } from '../provider/openai.provider';

export interface RecommendationResponse {
  source: string;
  items: ProductCardResponse[];
  generatedAt: string;
}

export interface CollectionResponse {
  title: string;
  subtitle: string;
  query: string;
  items: ProductCardResponse[];
}

export interface CollectionsResponse {
  day: string;
  generatedByAi: boolean;
  collections: CollectionResponse[];
}

export interface CompareResponse {
  products: ProductCardResponse[];
  criteria: Array<{ name: string; values: string[] }>;
  verdicts: Array<{ slug: string; bestFor: string }>;
  summary: string;
  generatedByAi: boolean;
}

/*
 * Gợi ý (PLAN-0012): tương tự (vector) · mua cùng (đồng đơn) · cho giỏ (từ dòng trong giỏ, trừ món đã có) ·
 * bộ sưu tập theo dịp (LLM đặt chủ đề hợp thời điểm VN → vector → thẻ, cache 24h) · so sánh 2–3 sản phẩm (LLM dựng
 * tiêu chí, cache 6h theo chữ ký). Mọi thứ có đường lùi: vector rỗng → cùng ngành/bán chạy; LLM lỗi → chủ đề rule / bảng rỗng.
 */
@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(
    private readonly products: ProductQueryApi,
    private readonly embeddings: EmbeddingService,
    private readonly orders: OrderQueryApi,
    private readonly cart: CartQueryApi,
    private readonly catalog: CatalogQueryApi,
    private readonly openai: OpenAiProvider,
    private readonly cache: CacheService,
  ) {}

  async similar(slug: string, limit = 8): Promise<RecommendationResponse> {
    const p = await this.brief(slug);
    const items = await this.cache.getOrSet(AI_CACHE.similar, `${p.id}:${limit}`, async () => {
      const ids = await this.embeddings.similarProducts(p.id, limit).catch(() => [] as string[]);
      let cards = ids.length ? await this.products.cardsByIds(ids) : [];
      if (cards.length < limit) cards = [...cards, ...(await this.products.recommend({ categorySlugs: [p.categorySlug], gender: p.gender === 'unisex' ? null : p.gender, excludeIds: [p.id, ...cards.map((c) => c.id)], limit: limit - cards.length }))];
      return cards.slice(0, limit);
    });
    return { source: 'similar', items, generatedAt: new Date().toISOString() };
  }

  async boughtTogether(slug: string, limit = 6): Promise<RecommendationResponse> {
    const p = await this.brief(slug);
    const items = await this.cache.getOrSet(AI_CACHE.boughtTogether, `${p.id}:${limit}`, async () => {
      const ids = await this.orders.boughtTogether(p.id, limit);
      let cards = ids.length ? await this.products.cardsByIds(ids) : [];
      if (cards.length < 3) {
        // Chưa đủ dữ liệu đồng mua → bù bằng ngành hàng khác (phối đồ: áo → quần/váy) bán chạy.
        const other = p.categorySlug.startsWith('ao') ? ['quan-jean', 'quan-short', 'vay'] : ['ao-thun', 'ao-so-mi', 'ao-khoac'];
        cards = [...cards, ...(await this.products.recommend({ categorySlugs: other, gender: p.gender === 'unisex' ? null : p.gender, excludeIds: [p.id, ...cards.map((c) => c.id)], limit: limit - cards.length }))];
      }
      return cards.slice(0, limit);
    });
    return { source: 'bought_together', items, generatedAt: new Date().toISOString() };
  }

  /* Gợi ý cho giỏ: từ mỗi dòng lấy mua-cùng + tương tự, trừ món đã trong giỏ, gộp theo số lần xuất hiện. */
  async forCart(actor: AuthenticatedActor, limit = 6): Promise<RecommendationResponse> {
    const basket = await this.cart.basketOf(actor.userId, false);
    const inCart = new Set(basket.lines.map((l) => l.productId));
    const score = new Map<string, number>();
    for (const pid of [...inCart].slice(0, 5)) {
      const [bt, sim] = await Promise.all([this.orders.boughtTogether(pid, 4), this.embeddings.similarProducts(pid, 4).catch(() => [] as string[])]);
      for (const id of bt) if (!inCart.has(id)) score.set(id, (score.get(id) ?? 0) + 2);
      for (const id of sim) if (!inCart.has(id)) score.set(id, (score.get(id) ?? 0) + 1);
    }
    const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, limit);
    let items = ids.length ? await this.products.cardsByIds(ids) : [];
    if (items.length < limit) items = [...items, ...(await this.products.recommend({ excludeIds: [...inCart, ...items.map((c) => c.id)], limit: limit - items.length }))];
    return { source: 'cart', items: items.slice(0, limit), generatedAt: new Date().toISOString() };
  }

  // ------------------------------------------------------------ bộ sưu tập theo dịp

  async collections(): Promise<CollectionsResponse> {
    const day = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    return this.cache.getOrSet(AI_CACHE.collections, day, async () => {
      const categories = await this.catalog.listActiveCategories();
      let themes: Array<{ title: string; subtitle: string; query: string }> = [];
      let byAi = false;
      if (this.openai.isConfigured) {
        try {
          const res = await this.openai.chatJson<{ themes?: Array<{ title?: string; subtitle?: string; query?: string }> }>(
            [
              { role: 'system', content: `Bạn đặt 3 CHỦ ĐỀ bộ sưu tập cho trang chủ cửa hàng quần áo Việt Nam hôm nay (${new Date(day).toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long' })}): hợp mùa/thời tiết, dịp sắp tới ở VN (Tết, 8/3, 20/10, Giáng sinh, tựu trường, hè…), ngày trong tuần. Ngành hàng đang có: ${categories.map((c) => c.name).join(', ')}. Mỗi chủ đề: title (3-7 từ, gợi cảm hứng, viết hoa chữ đầu), subtitle (≤ 90 ký tự, vì sao hợp lúc này), query (mô tả loại sản phẩm để tìm theo nghĩa, tiếng Việt, cụ thể: kiểu dáng, chất liệu, màu, dịp). Không dùng ngoặc kép. TRẢ JSON {"themes":[{title,subtitle,query}]}.` },
              { role: 'user', content: 'Đặt 3 chủ đề.' },
            ],
            { feature: AI_FEATURE.COLLECTIONS, maxTokens: 400, temperature: 0.8 },
          );
          themes = (res.data.themes ?? []).filter((t) => t.title && t.query).map((t) => ({ title: t.title!.slice(0, 80), subtitle: (t.subtitle ?? '').slice(0, 120), query: t.query!.slice(0, 200) })).slice(0, 3);
          byAi = themes.length > 0;
        } catch (err) {
          this.logger.warn({ err: (err as Error).message }, 'Đặt chủ đề bộ sưu tập lỗi — dùng chủ đề rule');
        }
      }
      if (themes.length === 0) themes = RecommendationService.ruleThemes(new Date(day));
      const collections: CollectionResponse[] = [];
      const used = new Set<string>();
      for (const t of themes) {
        const ids = byAi ? await this.embeddings.searchProducts(t.query, 8).catch(() => [] as string[]) : [];
        let cards = (ids.length ? await this.products.cardsByIds(ids) : []).filter((c) => !used.has(c.id));
        if (cards.length < 3) cards = [...cards, ...(await this.products.searchCards(t.query, 6)).filter((c) => !used.has(c.id) && !cards.some((x) => x.id === c.id))];
        if (cards.length < 3) cards = [...cards, ...(await this.products.recommend({ isNew: true, excludeIds: [...used, ...cards.map((c) => c.id)], limit: 6 - cards.length }))];
        cards = cards.slice(0, 6);
        if (cards.length < 3) continue;
        for (const c of cards) used.add(c.id);
        collections.push({ ...t, items: cards });
      }
      return { day, generatedByAi: byAi, collections };
    });
  }

  static ruleThemes(d: Date): Array<{ title: string; subtitle: string; query: string }> {
    const m = d.getMonth() + 1;
    const season = m >= 5 && m <= 8 ? { title: 'Mát mẻ ngày hè', subtitle: 'Cotton, linen và những tông sáng cho ngày nắng', query: 'áo thun cotton linen thoáng mát mùa hè màu sáng' } : m >= 11 || m <= 1 ? { title: 'Ấm áp cuối năm', subtitle: 'Áo khoác và lớp ngoài cho tiết trời se lạnh', query: 'áo khoác bomber blazer ấm cuối năm' } : { title: 'Giao mùa nhẹ nhàng', subtitle: 'Sơ mi, jean và những món phối được cả tuần', query: 'sơ mi jean phối đồ giao mùa' };
    return [season, { title: 'Đi làm chỉn chu', subtitle: 'Sơ mi, quần ống đứng, blazer — gọn gàng cả ngày', query: 'sơ mi công sở quần jean ống đứng blazer đi làm' }, { title: 'Cuối tuần thảnh thơi', subtitle: 'Thun, short, đầm suông — thoải mái mà vẫn đẹp', query: 'áo thun oversize quần short đầm suông cuối tuần' }];
  }

  // ------------------------------------------------------------ so sánh

  async compare(slugs: string[]): Promise<CompareResponse> {
    const uniq = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))];
    if (uniq.length < 2 || uniq.length > 3) throw new BusinessException('AI_COMPARE_COUNT', 'So sánh 2–3 sản phẩm');
    const details = await Promise.all(uniq.map((s) => this.products.detailForAi(s)));
    if (details.some((d) => !d)) throw new NotFoundException(AI_ERR.PRODUCT_NOT_FOUND, 'Có sản phẩm không tồn tại hoặc đã ngừng bán');
    const list = details.filter((d): d is NonNullable<typeof d> => Boolean(d));
    const sig = createHash('sha256').update(list.map((d) => `${d.id}:${d.updatedAt.toISOString()}`).join('|')).digest('hex').slice(0, 24);
    return this.cache.getOrSet(AI_CACHE.compare, sig, async () => {
      const products = await this.products.cardsByIds(list.map((d) => d.id));
      const empty: CompareResponse = { products, criteria: [], verdicts: [], summary: '', generatedByAi: false };
      if (!this.openai.isConfigured) return empty;
      try {
        const res = await this.openai.chatJson<{ criteria?: Array<{ name?: string; values?: string[] }>; verdicts?: Array<{ index?: number; bestFor?: string }>; summary?: string }>(
          [
            { role: 'system', content: `Bạn so sánh ${list.length} sản phẩm quần áo cho khách đang phân vân, tiếng Việt. Chỉ dùng thông tin được cung cấp — thiếu thì ghi "không rõ", KHÔNG bịa. Giá: chỉ nói tương đối (rẻ hơn/đắt hơn/ngang nhau). Gọi sản phẩm bằng TÊN. Không dùng ngoặc kép. TRẢ JSON {"criteria":[{"name": string, "values": string[] (đúng thứ tự sản phẩm)}] (4-7 tiêu chí: chất liệu, form/dáng, dịp mặc, màu/size, bảo quản, giá tương đối…; tiêu chí đầu là khác biệt lớn nhất), "verdicts":[{"index": number (0-based), "bestFor": string ≤ 60 ký tự}] (mỗi sản phẩm đúng một), "summary": string (2-3 câu trung lập)}.` },
            { role: 'user', content: list.map((d, i) => `#${i} ${d.name} | ngành ${d.categorySlug} | ${d.gender} | giá ${d.price}₫${d.listPrice ? ` (gốc ${d.listPrice})` : ''} | chất liệu: ${d.material ?? 'không rõ'} | bảo quản: ${d.care.join('; ') || 'không rõ'} | màu: ${[...new Set(d.variants.map((v) => v.colorName))].join(', ')} | size: ${[...new Set(d.variants.map((v) => v.sizeCode))].join(', ')} | đánh giá ${d.avgRating}/5 (${d.reviewCount}) | mô tả: ${(d.shortDescription ?? '') + ' ' + (d.description ?? '')}`.slice(0, 1200)).join('\n\n') },
          ],
          { feature: AI_FEATURE.COMPARE, maxTokens: 700, temperature: 0.2 },
        );
        const criteria = (res.data.criteria ?? []).filter((c) => c.name && Array.isArray(c.values)).map((c) => ({ name: c.name!.slice(0, 60), values: list.map((_, i) => String(c.values?.[i] ?? 'không rõ').slice(0, 160)) })).slice(0, 7);
        const verdicts = (res.data.verdicts ?? []).filter((v) => typeof v.index === 'number' && list[v.index]).map((v) => ({ slug: list[v.index!].slug, bestFor: (v.bestFor ?? '').slice(0, 80) }));
        return { products, criteria, verdicts, summary: (res.data.summary ?? '').slice(0, 600), generatedByAi: criteria.length > 0 };
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'So sánh AI lỗi — trả thẻ không bảng');
        return empty;
      }
    });
  }

  private async brief(slug: string): Promise<{ id: string; slug: string; categorySlug: string; gender: string }> {
    const p = await this.products.detailForAi(slug);
    if (!p) throw new NotFoundException(AI_ERR.PRODUCT_NOT_FOUND, 'Không tìm thấy sản phẩm');
    return { id: p.id, slug: p.slug, categorySlug: p.categorySlug, gender: p.gender };
  }
}
