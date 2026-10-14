import { Injectable, Logger } from '@nestjs/common';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { CacheService } from '@common/cache/cache.service';
import { NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { OrderQueryApi } from '../../order/queryapi/order.queryapi';
import { ProductCardResponse, ProductQueryApi } from '../../product/queryapi/product.queryapi';
import { EmbeddingService } from '../embedding/embedding.service';
import { AI_CACHE, AI_ERR, AI_FEATURE, AI_MODULE, SUPPORT_STATUS } from '../foundation/ai.constants';
import { OpenAiProvider } from '../provider/openai.provider';

export interface SupportRequestResponse {
  id: string;
  sessionId: string | null;
  userId: string | null;
  email: string | null;
  summary: string;
  status: string;
  assignedTo: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string | null;
  createdAt: string;
}

type Who = { actor?: AuthenticatedActor; guestKey?: string | null };

/*
 * Việc "phụ" của ai: yêu cầu hỗ trợ (nhân viên xử lý), gợi ý cá nhân hoá (xem + mua + vector), lượt xem sản phẩm,
 * soạn mô tả sản phẩm bằng AI cho nhân viên (ai.copy.create), dọn dữ liệu theo retention.
 */
@Injectable()
export class AiInsightService {
  private readonly logger = new Logger(AiInsightService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiProvider,
    private readonly embeddings: EmbeddingService,
    private readonly products: ProductQueryApi,
    private readonly orders: OrderQueryApi,
    private readonly cache: CacheService,
  ) {}

  // ------------------------------------------------------------ hỗ trợ

  async listSupport(page: number, size: number, status?: string): Promise<PageResponse<SupportRequestResponse>> {
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([this.prisma.supportRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.supportRequest.count({ where })]);
    return PageResponse.of(items.map((r) => AiInsightService.toSupport(r)), page, size, total);
  }

  async getSupport(id: string): Promise<SupportRequestResponse> {
    const r = await this.prisma.supportRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException(AI_ERR.SUPPORT_NOT_FOUND, 'Không tìm thấy yêu cầu hỗ trợ');
    return AiInsightService.toSupport(r);
  }

  async updateSupport(actor: AuthenticatedActor, id: string, input: { status: string; note?: string | null; assignToMe?: boolean }): Promise<SupportRequestResponse> {
    const before = await this.prisma.supportRequest.findUnique({ where: { id } });
    if (!before) throw new NotFoundException(AI_ERR.SUPPORT_NOT_FOUND, 'Không tìm thấy yêu cầu hỗ trợ');
    const resolved = input.status === SUPPORT_STATUS.RESOLVED;
    const r = await this.prisma.$transaction(async (tx) => {
      const u = await tx.supportRequest.update({ where: { id }, data: { status: input.status, note: input.note ?? before.note, assignedTo: input.assignToMe ? actor.userId : before.assignedTo, ...(resolved ? { resolvedBy: actor.userId, resolvedAt: new Date() } : {}) } });
      await this.audit(tx, actor, { action: 'AI_SUPPORT_UPDATED', entityType: 'support_request', entityId: id, before: { status: before.status }, after: { status: u.status } });
      return u;
    });
    return AiInsightService.toSupport(r);
  }

  // ------------------------------------------------------------ gợi ý & lượt xem

  async trackView(who: Who, productId: string): Promise<void> {
    const brief = await this.products.findProductBrief(productId);
    if (!brief) return;
    await this.prisma.productViewEvent.create({ data: { userId: who.actor?.userId ?? null, guestKey: who.actor ? null : (who.guestKey ?? null), productId } });
  }

  /* "Có thể bạn thích": xem gần đây + đã mua → sản phẩm tương tự (vector) hoặc cùng ngành; khách mới → bán chạy. */
  async recommendations(who: Who, limit = 8): Promise<ProductCardResponse[]> {
    const key = who.actor ? `u:${who.actor.userId}` : who.guestKey ? `g:${who.guestKey}` : 'anon';
    return this.cache.getOrSet(AI_CACHE.recommend, `${key}:${limit}`, async () => {
      const owner = who.actor ? { userId: who.actor.userId } : who.guestKey ? { guestKey: who.guestKey } : null;
      const viewed = owner ? (await this.prisma.productViewEvent.findMany({ where: owner, orderBy: { createdAt: 'desc' }, take: 10, select: { productId: true } })).map((v) => v.productId) : [];
      const bought = who.actor ? await this.orders.purchasedProductIds(who.actor.userId, 10) : [];
      const seeds = [...new Set([...viewed, ...bought])].slice(0, 5);
      const exclude = new Set(bought);
      const ids: string[] = [];
      for (const s of seeds) {
        for (const id of await this.embeddings.similarProducts(s, 4).catch(() => [] as string[])) if (!exclude.has(id) && !seeds.includes(id) && !ids.includes(id)) ids.push(id);
        if (ids.length >= limit) break;
      }
      let cards = await this.products.cardsByIds(ids.slice(0, limit));
      if (cards.length < limit) {
        const more = await this.products.recommend({ excludeIds: [...exclude, ...ids, ...seeds], limit: limit - cards.length });
        cards = [...cards, ...more];
      }
      return cards.slice(0, limit);
    });
  }

  // ------------------------------------------------------------ soạn nội dung

  async generateCopy(actor: AuthenticatedActor, input: { kind: 'product_description' | 'review_reply' | 'promotion_copy'; context: string; tone?: string | null }): Promise<{ text: string; source: string }> {
    if (!this.openai.isConfigured) {
      return { text: AiInsightService.ruleCopy(input), source: 'rule' };
    }
    const prompts: Record<string, string> = {
      product_description: 'Viết mô tả sản phẩm (80-140 từ) tiếng Việt, giọng tự nhiên, nêu đặc điểm/chất liệu hoặc thông số/công dụng phù hợp với loại sản phẩm, không bịa thông số không có trong ngữ cảnh. TRẢ JSON {"text": string}.',
      review_reply: 'Viết câu trả lời của cửa hàng cho đánh giá của khách (2-4 câu), lịch sự, cảm ơn, xử lý khéo nếu khách chưa hài lòng. TRẢ JSON {"text": string}.',
      promotion_copy: 'Viết nội dung quảng bá ngắn (≤ 60 từ) cho chương trình khuyến mãi, tiếng Việt, có kêu gọi hành động. TRẢ JSON {"text": string}.',
    };
    const res = await this.openai.chatJson<{ text?: string }>([{ role: 'system', content: `${prompts[input.kind]}${input.tone ? ` Giọng điệu: ${input.tone}.` : ''}` }, { role: 'user', content: input.context.slice(0, 3000) }], { feature: AI_FEATURE.COPY, userId: actor.userId, maxTokens: 400, temperature: 0.7 });
    return { text: (res.data.text ?? '').trim() || AiInsightService.ruleCopy(input), source: 'llm' };
  }

  private static ruleCopy(input: { kind: string; context: string }): string {
    if (input.kind === 'review_reply') return 'Cảm ơn bạn đã dành thời gian đánh giá. Cửa hàng rất trân trọng góp ý của bạn và sẽ tiếp tục cải thiện để phục vụ tốt hơn. Hẹn gặp lại bạn ở những đơn hàng sau!';
    if (input.kind === 'promotion_copy') return `Ưu đãi có hạn — ${input.context.slice(0, 80)}. Đặt hàng ngay hôm nay để không bỏ lỡ!`;
    return `${input.context.slice(0, 200)}. Thiết kế tối giản, dễ phối với nhiều trang phục, phù hợp đi làm, đi chơi hay dạo phố. Chất liệu thoáng mát, form chuẩn, có nhiều màu và size để lựa chọn.`;
  }

  // ------------------------------------------------------------ dọn dẹp

  async purge(viewDays: number, chatDays: number): Promise<{ views: number; sessions: number }> {
    const views = await this.prisma.productViewEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - viewDays * 86_400_000) } } });
    const sessions = await this.prisma.chatSession.deleteMany({ where: { OR: [{ lastMessageAt: { lt: new Date(Date.now() - chatDays * 86_400_000) } }, { lastMessageAt: null, createdAt: { lt: new Date(Date.now() - chatDays * 86_400_000) } }] } });
    return { views: views.count, sessions: sessions.count };
  }

  async oldStyleImages(days = 7): Promise<Array<{ id: string; imagePublicId: string }>> {
    const rows = await this.prisma.styleAnalysis.findMany({ where: { createdAt: { lt: new Date(Date.now() - days * 86_400_000) }, imagePublicId: { not: null } }, select: { id: true, imagePublicId: true }, take: 200 });
    return rows.filter((r): r is { id: string; imagePublicId: string } => Boolean(r.imagePublicId));
  }

  async clearStyleImage(id: string): Promise<void> {
    await this.prisma.styleAnalysis.update({ where: { id }, data: { imagePublicId: null, imageUrl: '' } });
  }

  private static toSupport(r: { id: string; sessionId: string | null; userId: string | null; email: string | null; summary: string; status: string; assignedTo: string | null; resolvedBy: string | null; resolvedAt: Date | null; note: string | null; createdAt: Date }): SupportRequestResponse {
    return { id: r.id, sessionId: r.sessionId, userId: r.userId, email: r.email, summary: r.summary, status: r.status, assignedTo: r.assignedTo, resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt?.toISOString() ?? null, note: r.note, createdAt: r.createdAt.toISOString() };
  }

  private audit(tx: Tx, actor: AuthenticatedActor, entry: AuditEntry): Promise<void> {
    return writeAuditLog(tx.aiAuditLog, AI_MODULE, actor, entry);
  }
}
