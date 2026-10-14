import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { QUEUE } from '@common/queue/queue.module';
import { ProductQueryApi } from '../../product/queryapi/product.queryapi';
import { ReviewQueryApi } from '../../review/queryapi/review.queryapi';
import { AI_ERR, AI_FEATURE, AI_JOB } from '../foundation/ai.constants';
import { OpenAiProvider } from '../provider/openai.provider';

export interface ProductFaqResponse {
  /* ready | pending (đang sinh nền, FE thăm dò lại) | none (không đủ dữ liệu / AI tắt) */
  status: string;
  items: Array<{ question: string; answer: string }>;
  isStale: boolean;
  updatedAt: string | null;
}

/*
 * FAQ TỰ SINH cho sản phẩm: đọc LƯỜI — thiếu / hash nguồn lệch → xếp job nền, trả bản cũ (`isStale`) hoặc `pending`;
 * KHÔNG bao giờ chờ AI trong request. Worker: LLM viết 3–6 cặp hỏi-đáp từ mô tả + đánh giá đã duyệt; thiếu thông tin thì
 * câu trả lời phải nói "cửa hàng chưa ghi" chứ không bịa.
 */
@Injectable()
export class ProductFaqService {
  private readonly logger = new Logger(ProductFaqService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductQueryApi,
    private readonly reviews: ReviewQueryApi,
    private readonly openai: OpenAiProvider,
    @InjectQueue(QUEUE.AI) private readonly queue: Queue,
  ) {}

  private async source(productId: string): Promise<{ text: string; hash: string } | null> {
    const p = await this.products.detailForAiById(productId);
    if (!p) return null;
    const reviews = await this.reviews.approvedForProduct(productId, 15);
    const colors = [...new Set(p.variants.map((v) => v.colorName).filter(Boolean))];
    const sizes = [...new Set(p.variants.map((v) => v.sizeCode).filter(Boolean))];
    const optionsText = [...new Set(p.variants.flatMap((v) => (v.optionsText ? [v.optionsText] : [])))];
    const text = [
      `Tên: ${p.name}`,
      `Ngành: ${p.categorySlug}${p.gender ? ` · ${p.gender}` : ''}`,
      `Giá: ${p.price}`,
      p.shortDescription ? `Mô tả ngắn: ${p.shortDescription}` : '',
      p.description ? `Mô tả: ${p.description}` : '',
      p.material ? `Chất liệu: ${p.material}` : '',
      p.care.length ? `Bảo quản: ${p.care.join('; ')}` : '',
      colors.length ? `Màu: ${colors.join(', ')}` : '',
      sizes.length ? `Size: ${sizes.join(', ')}` : '',
      p.attributesText ? `Thông số: ${p.attributesText}` : '',
      optionsText.length ? `Biến thể: ${optionsText.join(' | ')}` : '',
      reviews.length ? `Đánh giá đã duyệt:\n${reviews.map((r) => `- ${r.rating}/5: ${r.content.slice(0, 300)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    return { text, hash: createHash('sha256').update(text).digest('hex') };
  }

  async getForProduct(slug: string): Promise<ProductFaqResponse> {
    const p = await this.products.findProductBriefBySlug(slug);
    if (!p || p.status !== 'active') throw new NotFoundException(AI_ERR.PRODUCT_NOT_FOUND, 'Không tìm thấy sản phẩm');
    if (!this.openai.isConfigured) return { status: 'none', items: [], isStale: false, updatedAt: null };
    const [row, src] = await Promise.all([this.prisma.productFaq.findUnique({ where: { productId: p.id } }), this.source(p.id)]);
    if (!src) return { status: 'none', items: [], isStale: false, updatedAt: null };
    const items = row && Array.isArray(row.items) ? (row.items as Array<{ question: string; answer: string }>) : [];
    const stale = !row || row.sourceHash !== src.hash;
    if (stale && row?.status !== 'pending') {
      await this.prisma.productFaq.upsert({ where: { productId: p.id }, create: { productId: p.id, sourceHash: src.hash, status: 'pending', items: items }, update: { status: 'pending' } });
      await this.queue.add(AI_JOB.PRODUCT_FAQ, { productId: p.id }, { jobId: `faq-${p.id}-${src.hash.slice(0, 8)}` });
    }
    if (items.length === 0) return { status: row?.status === 'failed' ? 'none' : 'pending', items: [], isStale: false, updatedAt: null };
    return { status: 'ready', items, isStale: stale, updatedAt: row?.updatedAt.toISOString() ?? null };
  }

  /* Worker. */
  async generate(productId: string): Promise<number> {
    const src = await this.source(productId);
    if (!src) {
      await this.prisma.productFaq.deleteMany({ where: { productId } });
      return 0;
    }
    if (!this.openai.isConfigured) return 0;
    try {
      const res = await this.openai.chatJson<{ items?: Array<{ question?: string; answer?: string }> }>(
        [
          { role: 'system', content: 'Viết 3-6 cặp HỎI-ĐÁP khách hay hỏi trước khi mua một sản phẩm trên sàn thương mại điện tử, tiếng Việt, ngắn gọn (đáp ≤ 2 câu). CHỈ dùng thông tin trong nguồn (mô tả, thông số/chất liệu, bảo quản, size, đánh giá — nếu có). Thiếu thông tin thì trả lời "Cửa hàng chưa ghi rõ, bạn hỏi trợ lý hoặc nhân viên nhé" — KHÔNG bịa. Không dùng ngoặc kép. TRẢ JSON {"items":[{"question","answer"}]}.' },
          { role: 'user', content: src.text.slice(0, 6000) },
        ],
        { feature: AI_FEATURE.PRODUCT_FAQ, maxTokens: 600, temperature: 0.3 },
      );
      const items = (res.data.items ?? []).filter((i) => i.question && i.answer).map((i) => ({ question: i.question!.trim().slice(0, 200), answer: i.answer!.trim().slice(0, 500) })).slice(0, 6);
      await this.prisma.productFaq.upsert({ where: { productId }, create: { productId, items: items, sourceHash: src.hash, status: items.length ? 'ready' : 'none', model: res.model }, update: { items: items, sourceHash: src.hash, status: items.length ? 'ready' : 'none', model: res.model, error: null } });
      return items.length;
    } catch (err) {
      await this.prisma.productFaq.upsert({ where: { productId }, create: { productId, sourceHash: src.hash, status: 'failed', error: (err as Error).message.slice(0, 500) }, update: { status: 'failed', error: (err as Error).message.slice(0, 500) } });
      this.logger.warn({ productId, err: (err as Error).message }, 'Sinh FAQ sản phẩm lỗi');
      throw err;
    }
  }

  async invalidate(productId: string): Promise<void> {
    await this.prisma.productFaq.updateMany({ where: { productId }, data: { sourceHash: '' } });
  }
}
