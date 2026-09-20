import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, Interval } from '@nestjs/schedule';
import { Job } from 'bullmq';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { OutboxEventMessage } from '@common/outbox/outbox';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { PrismaService } from '@common/prisma/prisma.service';
import { QUEUE } from '@common/queue/queue.module';
import { StorageService } from '@common/storage/storage.service';
import { PRODUCT_EVENT, PRODUCT_MODULE } from '../product/enums/product-events';
import { REVIEW_EVENT, REVIEW_MODULE } from '../review/enums/review-events';
import { AiModule } from './ai.module';
import { EmbeddingService } from './embedding/embedding.service';
import { ProductFaqService } from './faq/product-faq.service';
import { AI_JOB } from './foundation/ai.constants';
import { AiInsightService } from './insight/ai-insight.service';
import { ReviewAiService } from './review-ai/review-ai.service';
import { TryOnService } from './tryon/try-on.service';

/* Relay outbox của review (ai là consumer duy nhất hiện tại) — phát `outbox.review.<EVENT>`. */
@Injectable()
export class ReviewOutboxRelayJob implements OnModuleInit {
  private readonly logger = new Logger(ReviewOutboxRelayJob.name);
  private relay!: OutboxRelay;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.relay = new OutboxRelay(this.prisma, REVIEW_MODULE, async (msg) => { await this.emitter.emitAsync(`outbox.${REVIEW_MODULE}.${msg.eventType}`, msg); });
  }

  @Interval(3000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.relay.poll();
    } catch (err) {
      this.logger.error({ err }, 'Relay outbox review lỗi');
    } finally {
      this.running = false;
    }
  }
}

/* Listener sự kiện sản phẩm/đánh giá → việc AI nền (idempotent qua ai.processed_events). */
@Injectable()
export class AiEventListeners {
  private readonly logger = new Logger(AiEventListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
    private readonly reviewAi: ReviewAiService,
    private readonly faq: ProductFaqService,
  ) {}

  private async once(msg: OutboxEventMessage, handler: string): Promise<boolean> {
    const existing = await this.prisma.aiProcessedEvent.findUnique({ where: { eventId_handler: { eventId: msg.id, handler } } });
    if (existing) return false;
    await this.prisma.aiProcessedEvent.create({ data: { eventId: msg.id, eventType: msg.eventType, handler } });
    return true;
  }

  @OnEvent(`outbox.${PRODUCT_MODULE}.${PRODUCT_EVENT.PUBLISHED}`)
  @OnEvent(`outbox.${PRODUCT_MODULE}.${PRODUCT_EVENT.UPDATED}`)
  @OnEvent(`outbox.${PRODUCT_MODULE}.${PRODUCT_EVENT.HIDDEN}`)
  async onProductChanged(msg: OutboxEventMessage): Promise<void> {
    if (!(await this.once(msg, 'ai.embedProduct'))) return;
    const { productId } = msg.payload as { productId: string };
    const r = await this.embeddings.embedProduct(productId).catch((err: Error) => `lỗi: ${err.message}`);
    await this.faq.invalidate(productId).catch(() => undefined); // mô tả đổi → FAQ sinh lại ở lần đọc kế
    this.logger.log({ productId, event: msg.eventType, result: r }, 'Nhúng sản phẩm theo sự kiện');
  }

  @OnEvent(`outbox.${REVIEW_MODULE}.${REVIEW_EVENT.CREATED}`)
  async onReviewCreated(msg: OutboxEventMessage): Promise<void> {
    if (!(await this.once(msg, 'ai.reviewAnalyze'))) return;
    const { reviewId, productId } = msg.payload as { reviewId: string; productId: string };
    const flag = await this.reviewAi.moderate(reviewId).catch((err: Error) => { this.logger.warn({ err: err.message, reviewId }, 'Kiểm duyệt AI lỗi'); return null; });
    const summary = await this.reviewAi.summarize(productId).catch((err: Error) => { this.logger.warn({ err: err.message, productId }, 'Tóm tắt đánh giá lỗi'); return null; });
    await this.faq.invalidate(productId).catch(() => undefined); // đánh giá mới là nguồn của FAQ
    this.logger.log({ reviewId, label: flag?.label ?? null, summarized: Boolean(summary) }, 'AI xử lý đánh giá mới');
  }
}

/* Processor hàng đợi `ai`: thử đồ 2D (Replicate), nhúng tài liệu/sản phẩm. Job dài → concurrency thấp. */
@Processor(QUEUE.AI, { concurrency: 2 })
export class AiQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(AiQueueProcessor.name);

  constructor(
    private readonly tryOn: TryOnService,
    private readonly embeddings: EmbeddingService,
    private readonly faq: ProductFaqService,
  ) {
    super();
  }

  async process(job: Job<{ jobId?: string; documentId?: string; productId?: string }>): Promise<unknown> {
    switch (job.name) {
      case AI_JOB.TRY_ON:
        await this.tryOn.process(job.data.jobId ?? '');
        return null;
      case AI_JOB.PRODUCT_FAQ:
        return this.faq.generate(job.data.productId ?? '');
      case AI_JOB.INDEX_DOCUMENT:
        return this.embeddings.indexDocument(job.data.documentId ?? '');
      case AI_JOB.EMBED_PRODUCT:
        return this.embeddings.embedProduct(job.data.productId ?? '');
      default:
        this.logger.warn({ name: job.name }, 'Job ai không biết — bỏ qua');
        return null;
    }
  }
}

/* Dọn theo retention + nhúng bù (tài liệu/sản phẩm pending) — lúc khởi động và mỗi giờ; ảnh người thử đồ/phân tích xoá sau 7 ngày. */
@Injectable()
export class AiHousekeepingJob implements OnModuleInit {
  private readonly logger = new Logger(AiHousekeepingJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly insight: AiInsightService,
    private readonly tryOn: TryOnService,
    private readonly embeddings: EmbeddingService,
    private readonly storage: StorageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /* Seed tạo tài liệu `pending` (chưa vector) → worker nhúng ngay khi lên; sản phẩm cũng nhúng bù (bỏ qua cái không đổi). */
  async onModuleInit(): Promise<void> {
    if (!this.embeddings.enabled) return;
    try {
      const pending = await this.prisma.aiDocument.findMany({ where: { status: 'pending', isDeleted: false }, select: { id: true } });
      for (const d of pending) await this.embeddings.indexDocument(d.id).catch((err: Error) => this.logger.warn({ documentId: d.id, err: err.message }, 'Nhúng tài liệu lỗi'));
      const r = await this.embeddings.reindexProducts();
      this.logger.log({ documents: pending.length, ...r }, 'Nhúng bù lúc khởi động');
    } catch (err) {
      this.logger.error({ err }, 'Nhúng bù lúc khởi động lỗi');
    }
  }

  @Cron('0 40 3 * * *')
  async purge(): Promise<void> {
    const r = await this.insight.purge(this.env.EF_VIEW_EVENT_RETENTION_DAYS, this.env.EF_CHAT_SESSION_RETENTION_DAYS);
    const tryOns = await this.tryOn.purgeOld(7);
    const styles = await this.insight.oldStyleImages(7);
    for (const s of styles) {
      await this.storage.deleteImage(s.imagePublicId);
      await this.insight.clearStyleImage(s.id);
    }
    this.logger.log({ ...r, tryOns, styles: styles.length }, 'Đã dọn dữ liệu AI theo retention');
  }

  @Cron('0 15 * * * *')
  async embedPending(): Promise<void> {
    if (!this.embeddings.enabled) return;
    const r = await this.embeddings.reindexProducts();
    if (r.updated || r.failed) this.logger.log(r, 'Nhúng bù sản phẩm');
  }
}

@Module({
  imports: [AiModule],
  providers: [ReviewOutboxRelayJob, AiEventListeners, AiQueueProcessor, AiHousekeepingJob],
})
export class AiWorkerModule {}
