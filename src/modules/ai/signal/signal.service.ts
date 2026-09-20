import { Injectable } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { OrderQueryApi } from '../../order/queryapi/order.queryapi';
import { ProductQueryApi } from '../../product/queryapi/product.queryapi';
import { AI_CACHE, EVENT_TYPES, REC_SOURCES } from '../foundation/ai.constants';

export interface SignalEvent {
  productId: string;
  eventType: string;
  source?: string | null;
}

export interface RecommendationStatsResponse {
  generatedAt: string;
  days: number;
  totalImpressions: number;
  totalClicks: number;
  sources: Array<{ source: string; impressions: number; clicks: number; ctr: number; addToCart: number; purchases: number; conversion: number }>;
}

type Who = { actor?: AuthenticatedActor; guestKey?: string | null };

/*
 * Tín hiệu hành vi (một bảng, hai vai): view/add_to_cart của khách đăng nhập → gợi ý; impression/click kèm `source`
 * (khách vãng lai cũng ghi — họ chiếm nửa lượt bấm) → đo hiệu quả dải gợi ý: hiển thị → bấm → thêm giỏ → mua (7 ngày).
 * Telemetry: sản phẩm/loại/nguồn lạ thì BỎ, không 400.
 */
@Injectable()
export class SignalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductQueryApi,
    private readonly orders: OrderQueryApi,
    private readonly cache: CacheService,
  ) {}

  async track(who: Who, events: SignalEvent[]): Promise<number> {
    const valid = events.filter((e) => (EVENT_TYPES as readonly string[]).includes(e.eventType)).slice(0, 50);
    if (valid.length === 0) return 0;
    const ids = [...new Set(valid.map((e) => e.productId))];
    const known = new Set((await Promise.all(ids.map((id) => this.products.findProductBrief(id)))).filter(Boolean).map((p) => p!.id));
    const rows = valid
      .filter((e) => known.has(e.productId))
      // view/add_to_cart là sở thích — cần tài khoản để gợi ý cho; khách vãng lai chỉ ghi click/impression.
      .filter((e) => who.actor || e.eventType === 'click' || e.eventType === 'impression')
      .map((e) => ({ userId: who.actor?.userId ?? null, guestKey: who.actor ? null : (who.guestKey ?? null), productId: e.productId, eventType: e.eventType, source: e.source && (REC_SOURCES as readonly string[]).includes(e.source) ? e.source : null }));
    if (rows.length === 0) return 0;
    const r = await this.prisma.productViewEvent.createMany({ data: rows });
    return r.count;
  }

  stats(days = 30): Promise<RecommendationStatsResponse> {
    return this.cache.getOrSet(AI_CACHE.recStats, String(days), async () => {
      const since = new Date(Date.now() - days * 86_400_000);
      const [grouped, clicks, purchases] = await Promise.all([
        this.prisma.productViewEvent.groupBy({ by: ['source', 'eventType'], where: { createdAt: { gte: since }, source: { not: null } }, _count: true }),
        this.prisma.productViewEvent.findMany({ where: { createdAt: { gte: since }, eventType: 'click', source: { not: null }, userId: { not: null } }, select: { userId: true, productId: true, source: true, createdAt: true } }),
        this.orders.recentPurchases(since),
      ]);
      const bySource = new Map<string, { impressions: number; clicks: number; addToCart: number; purchases: number }>();
      const get = (s: string) => bySource.get(s) ?? bySource.set(s, { impressions: 0, clicks: 0, addToCart: 0, purchases: 0 }).get(s)!;
      for (const g of grouped) {
        const b = get(g.source!);
        if (g.eventType === 'impression') b.impressions += g._count;
        else if (g.eventType === 'click') b.clicks += g._count;
        else if (g.eventType === 'add_to_cart') b.addToCart += g._count;
      }
      // Ghi công mua: khách bấm từ dải X rồi mua đúng sản phẩm đó trong 7 ngày.
      const purchaseIndex = new Map<string, Date[]>();
      for (const p of purchases) {
        const k = `${p.userId}:${p.productId}`;
        purchaseIndex.set(k, [...(purchaseIndex.get(k) ?? []), p.createdAt]);
      }
      const credited = new Set<string>();
      for (const c of clicks) {
        const k = `${c.userId}:${c.productId}`;
        const hit = (purchaseIndex.get(k) ?? []).find((d) => d >= c.createdAt && d.getTime() - c.createdAt.getTime() <= 7 * 86_400_000);
        if (hit && !credited.has(`${k}:${c.source}:${hit.toISOString()}`)) {
          credited.add(`${k}:${c.source}:${hit.toISOString()}`);
          get(c.source!).purchases += 1;
        }
      }
      const sources = [...bySource.entries()].map(([source, b]) => ({ source, ...b, ctr: b.impressions ? Math.round((b.clicks / b.impressions) * 1000) / 10 : 0, conversion: b.clicks ? Math.round((b.purchases / b.clicks) * 1000) / 10 : 0 })).sort((a, b) => b.impressions - a.impressions);
      return { generatedAt: new Date().toISOString(), days, totalImpressions: sources.reduce((a, s) => a + s.impressions, 0), totalClicks: sources.reduce((a, s) => a + s.clicks, 0), sources };
    });
  }
}
