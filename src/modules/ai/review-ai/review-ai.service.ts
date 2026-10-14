import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { ReviewQueryApi } from '../../review/queryapi/review.queryapi';
import { AI_CACHE, AI_FEATURE, AI_PROVIDER, MODERATION_LABEL } from '../foundation/ai.constants';
import { OpenAiProvider } from '../provider/openai.provider';

export interface ReviewSummaryResponse {
  productId: string;
  summary: string;
  pros: string[];
  cons: string[];
  reviewCount: number;
  updatedAt: string;
}

export interface ModerationFlagResponse {
  reviewId: string;
  label: string;
  score: number;
  reason: string | null;
  model: string;
  createdAt: string;
  review: { productId: string; rating: number; content: string; status: string } | null;
}

const BAD_WORDS = ['đm', 'dm ', 'vcl', 'vl ', 'đéo', 'cc ', 'lừa đảo', 'scam', 'địt', 'ngu', 'chó'];
const SPAM_HINTS = ['http://', 'https://', 'zalo', 'telegram', 'inbox', 'ib ', 'liên hệ ngay', 'giá rẻ nhất', 'mua ngay tại'];

/*
 * AI cho đánh giá: (1) kiểm duyệt — gắn nhãn ĐỀ XUẤT (ok/spam/toxic/off_topic) vào ai.moderation_flags, KHÔNG tự ẩn;
 * nhân viên quyết ở /admin/reviews. (2) tóm tắt — khi sản phẩm có ≥ 3 đánh giá, tổng hợp ưu/nhược để hiện trang sản phẩm.
 * Không key → rule (từ khoá) cho kiểm duyệt, không tóm tắt.
 */
@Injectable()
export class ReviewAiService {
  private readonly logger = new Logger(ReviewAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiProvider,
    private readonly reviews: ReviewQueryApi,
    private readonly cache: CacheService,
  ) {}

  async moderate(reviewId: string): Promise<ModerationFlagResponse | null> {
    const r = await this.reviews.findById(reviewId);
    if (!r) return null;
    let label: string = MODERATION_LABEL.OK;
    let score = 0.1;
    let reason: string | null = null;
    let model = 'rule';
    if (this.openai.isConfigured) {
      try {
        const res = await this.openai.chatJson<{ label?: string; score?: number; reason?: string }>(
          [
            { role: 'system', content: 'Bạn kiểm duyệt đánh giá sản phẩm trên sàn thương mại điện tử, tiếng Việt (sản phẩm có thể thuộc bất kỳ ngành hàng nào). Phân loại: ok (bình thường), spam (quảng cáo/link/liên hệ ngoài), toxic (xúc phạm, tục tĩu, đe doạ), off_topic (không liên quan sản phẩm). TRẢ JSON {"label": "ok|spam|toxic|off_topic", "score": 0..1 (độ tin cậy), "reason": string ngắn tiếng Việt}.' },
            { role: 'user', content: `Điểm: ${r.rating}/5\nNội dung: ${r.content.slice(0, 1500)}` },
          ],
          { feature: AI_FEATURE.MODERATION, maxTokens: 150, temperature: 0 },
        );
        if (res.data.label && Object.values(MODERATION_LABEL).includes(res.data.label as never)) {
          label = res.data.label;
          score = Math.min(1, Math.max(0, Number(res.data.score ?? 0.5)));
          reason = res.data.reason?.slice(0, 500) ?? null;
          model = res.model;
        }
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, reviewId }, 'Kiểm duyệt LLM lỗi — dùng rule');
        ({ label, score, reason } = ReviewAiService.ruleModeration(r.content));
      }
    } else ({ label, score, reason } = ReviewAiService.ruleModeration(r.content));
    const saved = await this.prisma.moderationFlag.upsert({ where: { reviewId }, create: { reviewId, label, score: new Prisma.Decimal(score.toFixed(3)), reason, model }, update: { label, score: new Prisma.Decimal(score.toFixed(3)), reason, model } });
    return { reviewId, label: saved.label, score: Number(saved.score), reason: saved.reason, model: saved.model, createdAt: saved.createdAt.toISOString(), review: r };
  }

  static ruleModeration(content: string): { label: string; score: number; reason: string | null } {
    const t = ` ${content.toLowerCase()} `;
    if (SPAM_HINTS.some((w) => t.includes(w))) return { label: MODERATION_LABEL.SPAM, score: 0.7, reason: 'Có link/lời mời liên hệ ngoài' };
    if (BAD_WORDS.some((w) => t.includes(w))) return { label: MODERATION_LABEL.TOXIC, score: 0.7, reason: 'Có từ ngữ thô tục/xúc phạm' };
    return { label: MODERATION_LABEL.OK, score: 0.2, reason: null };
  }

  /* Tóm tắt khi ≥ 3 đánh giá đã duyệt; ít hơn thì xoá tóm tắt cũ (nếu có). */
  async summarize(productId: string): Promise<ReviewSummaryResponse | null> {
    const list = await this.reviews.approvedForProduct(productId, 40);
    if (list.length < 3) {
      await this.prisma.reviewSummary.deleteMany({ where: { productId } });
      await this.cache.del(AI_CACHE.reviewSummary, productId);
      return null;
    }
    if (!this.openai.isConfigured) return null;
    const res = await this.openai.chatJson<{ summary?: string; pros?: string[]; cons?: string[] }>(
      [
        { role: 'system', content: 'Tóm tắt đánh giá của khách về một sản phẩm trên sàn thương mại điện tử, tiếng Việt, khách quan, không bịa. TRẢ JSON {"summary": string (2-3 câu), "pros": string[] (≤ 4, ngắn), "cons": string[] (≤ 3, ngắn; rỗng nếu không có)}.' },
        { role: 'user', content: list.map((r) => `- ${r.rating}/5: ${r.content.slice(0, 400)}`).join('\n') },
      ],
      { feature: AI_FEATURE.REVIEW_SUMMARY, maxTokens: 400, temperature: 0.2 },
    );
    const summary = (res.data.summary ?? '').trim().slice(0, 2000);
    if (!summary) return null;
    const saved = await this.prisma.reviewSummary.upsert({
      where: { productId },
      create: { productId, summary, pros: (res.data.pros ?? []).slice(0, 4), cons: (res.data.cons ?? []).slice(0, 3), reviewCount: list.length, model: res.model },
      update: { summary, pros: (res.data.pros ?? []).slice(0, 4), cons: (res.data.cons ?? []).slice(0, 3), reviewCount: list.length, model: res.model },
    });
    await this.cache.del(AI_CACHE.reviewSummary, productId);
    return ReviewAiService.toSummary(saved);
  }

  summary(productId: string): Promise<ReviewSummaryResponse | null> {
    return this.cache.getOrSet(AI_CACHE.reviewSummary, productId, async () => {
      const s = await this.prisma.reviewSummary.findUnique({ where: { productId } });
      return s ? ReviewAiService.toSummary(s) : null;
    });
  }

  async listFlags(page: number, size: number, label?: string): Promise<{ items: ModerationFlagResponse[]; total: number; page: number; size: number }> {
    const where = label ? { label } : { label: { not: MODERATION_LABEL.OK } };
    const [rows, total] = await Promise.all([this.prisma.moderationFlag.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.moderationFlag.count({ where })]);
    const items = await Promise.all(rows.map(async (f) => ({ reviewId: f.reviewId, label: f.label, score: Number(f.score), reason: f.reason, model: f.model, createdAt: f.createdAt.toISOString(), review: await this.reviews.findById(f.reviewId) })));
    return { items, total, page, size };
  }

  private static toSummary(s: { productId: string; summary: string; pros: unknown; cons: unknown; reviewCount: number; updatedAt: Date }): ReviewSummaryResponse {
    return { productId: s.productId, summary: s.summary, pros: Array.isArray(s.pros) ? (s.pros as string[]) : [], cons: Array.isArray(s.cons) ? (s.cons as string[]) : [], reviewCount: s.reviewCount, updatedAt: s.updatedAt.toISOString() };
  }

  get provider(): string {
    return this.openai.isConfigured ? AI_PROVIDER.OPENAI : AI_PROVIDER.RULE;
  }
}
