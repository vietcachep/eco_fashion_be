import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { AI_CACHE, AI_FEATURE } from '../foundation/ai.constants';
import { OpenAiProvider } from '../provider/openai.provider';
import type { MessageMeta } from '../chat/chat.types';

export interface ChatInsightsResponse {
  generatedAt: string;
  days: number;
  sessions: number;
  questions: number;
  misses: number;
  handoffs: number;
  ruleFallbacks: number;
  clusters: Array<{ label: string; suggestedTitle: string; count: number; examples: string[] }>;
  generatedByAi: boolean;
}

const MAX_QUESTIONS = 300;
const MAX_CLUSTERS = 8;
const CLUSTER_THRESHOLD = 0.8;

/*
 * "KHÁCH HỎI GÌ MÀ BOT BÍ?" — chỉ đọc, cho nhân viên: câu hỏi đứng trước câu trả lời có `meta.misses`, chuyển người thật,
 * hoặc trả lời bằng rule không có sản phẩm → gom cụm theo embedding (cosine ≥ 0.8, tham lam) rồi MỘT lượt LLM đặt tên cụm +
 * tiêu đề bài kho tri thức nên viết. Không key → gom theo từ khoá đầu câu. Cache 1h.
 */
@Injectable()
export class ChatInsightsService {
  private readonly logger = new Logger(ChatInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiProvider,
    private readonly embeddings: EmbeddingService,
    private readonly cache: CacheService,
  ) {}

  insights(days = 14): Promise<ChatInsightsResponse> {
    return this.cache.getOrSet(AI_CACHE.chatInsights, String(days), () => this.build(days));
  }

  private async build(days: number): Promise<ChatInsightsResponse> {
    const since = new Date(Date.now() - days * 86_400_000);
    const [sessions, messages] = await Promise.all([
      this.prisma.chatSession.count({ where: { createdAt: { gte: since } } }),
      this.prisma.chatMessage.findMany({ where: { createdAt: { gte: since }, role: { in: ['user', 'assistant'] } }, orderBy: [{ sessionId: 'asc' }, { createdAt: 'asc' }], select: { sessionId: true, role: true, content: true, source: true, productIds: true, meta: true } }),
    ]);
    let questions = 0;
    let misses = 0;
    let handoffs = 0;
    let ruleFallbacks = 0;
    const gaps: string[] = [];
    let prevUser: string | null = null;
    for (const m of messages) {
      if (m.role === 'user') {
        questions += 1;
        prevUser = m.content;
        continue;
      }
      const meta = (m.meta ?? {}) as MessageMeta;
      const missed = (meta.misses?.length ?? 0) > 0;
      const handoff = Boolean(meta.supportRequestId);
      const rule = m.source === 'rule' && !(Array.isArray(m.productIds) && m.productIds.length > 0);
      if (missed) misses += 1;
      if (handoff) handoffs += 1;
      if (rule) ruleFallbacks += 1;
      if ((missed || handoff || rule) && prevUser && prevUser.length >= 8) gaps.push(prevUser.slice(0, 200));
      prevUser = null;
    }
    const sample = [...new Set(gaps)].slice(-MAX_QUESTIONS);
    const base = { generatedAt: new Date().toISOString(), days, sessions, questions, misses, handoffs, ruleFallbacks };
    if (sample.length === 0) return { ...base, clusters: [], generatedByAi: false };

    let clusters: string[][] = [];
    let byAi = false;
    if (this.openai.isConfigured) {
      try {
        const vecs = await this.openai.embed(sample, AI_FEATURE.CHAT_INSIGHTS);
        clusters = ChatInsightsService.greedyClusters(sample, vecs);
        byAi = true;
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'Nhúng câu hỏi bot bí lỗi — gom theo từ khoá');
      }
    }
    if (clusters.length === 0) clusters = ChatInsightsService.keywordClusters(sample);
    clusters = clusters.sort((a, b) => b.length - a.length).slice(0, MAX_CLUSTERS);

    const labels: Array<{ label: string; suggestedTitle: string }> = clusters.map((c) => ({ label: c[0].slice(0, 60), suggestedTitle: `Giải đáp: ${c[0].slice(0, 70)}` }));
    if (byAi) {
      try {
        const res = await this.openai.chatJson<{ clusters?: Array<{ index?: number; label?: string; suggestedTitle?: string }> }>(
          [
            { role: 'system', content: 'Cho các CỤM câu hỏi khách hỏi chatbot cửa hàng quần áo mà bot không trả lời được. Với mỗi cụm: label (tên cụm 3-8 từ, tiếng Việt) và suggestedTitle (tiêu đề bài kho tri thức nên viết, ≤ 80 ký tự). Không dùng ngoặc kép. TRẢ JSON {"clusters":[{"index","label","suggestedTitle"}]}.' },
            { role: 'user', content: clusters.map((c, i) => `#${i} (${c.length} câu):\n${c.slice(0, 5).map((q) => `- ${q}`).join('\n')}`).join('\n\n') },
          ],
          { feature: AI_FEATURE.CHAT_INSIGHTS, maxTokens: 500, temperature: 0.2 },
        );
        for (const c of res.data.clusters ?? []) if (typeof c.index === 'number' && labels[c.index]) labels[c.index] = { label: (c.label ?? labels[c.index].label).slice(0, 80), suggestedTitle: (c.suggestedTitle ?? labels[c.index].suggestedTitle).slice(0, 100) };
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'Đặt tên cụm lỗi — dùng câu đầu cụm');
      }
    }
    return { ...base, clusters: clusters.map((c, i) => ({ ...labels[i], count: c.length, examples: c.slice(0, 3) })), generatedByAi: byAi };
  }

  static greedyClusters(texts: string[], vecs: number[][]): string[][] {
    const cos = (a: number[], b: number[]) => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return na && nb ? dot / Math.sqrt(na * nb) : 0;
    };
    const centers: number[][] = [];
    const clusters: string[][] = [];
    texts.forEach((t, i) => {
      let best = -1;
      let bestSim = 0;
      centers.forEach((c, j) => {
        const s = cos(vecs[i], c);
        if (s > bestSim) {
          bestSim = s;
          best = j;
        }
      });
      if (best >= 0 && bestSim >= CLUSTER_THRESHOLD) clusters[best].push(t);
      else {
        centers.push(vecs[i]);
        clusters.push([t]);
      }
    });
    return clusters;
  }

  static keywordClusters(texts: string[]): string[][] {
    const key = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter((w) => w.length > 2).slice(0, 2).join(' ');
    const map = new Map<string, string[]>();
    for (const t of texts) map.set(key(t), [...(map.get(key(t)) ?? []), t]);
    return [...map.values()];
  }
}
