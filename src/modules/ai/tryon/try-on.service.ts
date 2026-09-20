import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { QUEUE } from '@common/queue/queue.module';
import { StorageService } from '@common/storage/storage.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ProductQueryApi } from '../../product/queryapi/product.queryapi';
import { AI_ERR, AI_FEATURE, AI_JOB, AI_PROVIDER, TRYON_CATEGORY, TRYON_COST_USD, TRYON_MAX_ATTEMPTS, TRYON_MAX_WAIT_MS, TRYON_POLL_MS, TRYON_STATUS } from '../foundation/ai.constants';
import { ReplicateProvider } from '../provider/replicate.provider';
import { AiUsageService } from '../usage/ai-usage.service';

export interface TryOnJobResponse {
  jobId: string;
  status: string;
  productId: string;
  productName: string;
  personImageUrl: string;
  garmentImageUrl: string;
  resultUrl: string | null;
  error: string | null;
  /* Gợi ý FE: poll sau N ms khi chưa xong */
  pollAfterMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

type Who = { actor?: AuthenticatedActor; guestKey?: string | null };

/*
 * Thử đồ 2D (PLAN-0013): API nhận ảnh người + productId → upload Cloudinary → tạo TryOnJob (queued) → BullMQ `ai`.
 * Worker gọi Replicate IDM-VTON (human_img, garm_img, category theo ngành hàng), poll tới khi xong (≤ 4 phút),
 * tải ảnh kết quả về Cloudinary (URL Replicate hết hạn sau ~1h) → status done + resultUrl; FE poll GET /ai/try-on/:jobId.
 */
@Injectable()
export class TryOnService {
  private readonly logger = new Logger(TryOnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly replicate: ReplicateProvider,
    private readonly products: ProductQueryApi,
    private readonly usage: AiUsageService,
    @InjectQueue(QUEUE.AI) private readonly queue: Queue,
  ) {}

  get isAvailable(): boolean {
    return this.replicate.isConfigured && this.storage.isConfigured;
  }

  async create(who: Who, file: { buffer: Buffer; mimetype: string; size: number }, input: { productId: string; colorCode?: string | null }): Promise<TryOnJobResponse> {
    if (!this.replicate.isConfigured) throw new BusinessException(AI_ERR.TRYON_NOT_CONFIGURED, 'Thử đồ 2D chưa được cấu hình (EF_REPLICATE_API_TOKEN)', 503);
    const garment = await this.products.garmentForTryOn(input.productId, input.colorCode);
    if (!garment) throw new NotFoundException(AI_ERR.PRODUCT_NOT_FOUND, 'Sản phẩm không có sẵn để thử');
    // Chặn spam: mỗi người/khách tối đa 3 job đang chạy.
    const running = await this.prisma.tryOnJob.count({ where: { ...TryOnService.ownerWhere(who), status: { in: [TRYON_STATUS.QUEUED, TRYON_STATUS.PROCESSING] } } });
    if (running >= 3) throw new BusinessException('AI_TRYON_TOO_MANY', 'Bạn đang có 3 lượt thử đồ chờ xử lý, đợi xong rồi thử tiếp nhé', 429);
    const person = await this.storage.uploadImage(file, 'ai/try-on');
    const job = await this.prisma.tryOnJob.create({
      data: { userId: who.actor?.userId ?? null, guestKey: who.actor ? null : (who.guestKey ?? null), productId: garment.id, productName: garment.name, garmentImageUrl: garment.imageUrl, personImageUrl: person.url, personPublicId: person.publicId, category: TRYON_CATEGORY[garment.categorySlug] ?? 'upper_body', status: TRYON_STATUS.QUEUED },
    });
    await this.queue.add(AI_JOB.TRY_ON, { jobId: job.id }, { jobId: `try-on-${job.id}`, attempts: TRYON_MAX_ATTEMPTS, backoff: { type: 'fixed', delay: 10_000 } });
    this.logger.log({ jobId: job.id, productId: garment.id, userId: who.actor?.userId ?? null }, 'Đã xếp hàng thử đồ 2D');
    return TryOnService.toResponse(job);
  }

  async get(who: Who, jobId: string): Promise<TryOnJobResponse> {
    const job = await this.prisma.tryOnJob.findFirst({ where: { id: jobId, ...TryOnService.ownerWhere(who) } });
    if (!job) throw new NotFoundException(AI_ERR.JOB_NOT_FOUND, 'Không tìm thấy lượt thử đồ');
    return TryOnService.toResponse(job);
  }

  async mine(who: Who, limit = 10): Promise<TryOnJobResponse[]> {
    const rows = await this.prisma.tryOnJob.findMany({ where: TryOnService.ownerWhere(who), orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((r) => TryOnService.toResponse(r));
  }

  // ------------------------------------------------------------ worker

  /* Chạy trong worker (BullMQ). Idempotent: job đã done/failed thì bỏ qua; lần retry dùng lại providerJobId nếu có. */
  async process(jobId: string): Promise<void> {
    const job = await this.prisma.tryOnJob.findUnique({ where: { id: jobId } });
    if (!job || job.status === TRYON_STATUS.DONE) return;
    if (job.status === TRYON_STATUS.FAILED && job.attempts >= TRYON_MAX_ATTEMPTS) return;
    await this.prisma.tryOnJob.update({ where: { id: jobId }, data: { status: TRYON_STATUS.PROCESSING, startedAt: job.startedAt ?? new Date(), attempts: { increment: 1 }, error: null } });
    const t0 = Date.now();
    try {
      let providerId = job.providerJobId;
      if (!providerId) {
        const pred = await this.replicate.createPrediction({
          human_img: job.personImageUrl,
          garm_img: job.garmentImageUrl,
          garment_des: job.productName,
          category: job.category,
          is_checked: true,
          is_checked_crop: true,
          denoise_steps: 30,
          seed: 42,
        });
        providerId = pred.id;
        await this.prisma.tryOnJob.update({ where: { id: jobId }, data: { providerJobId: providerId } });
      }
      const outputUrl = await this.waitForResult(providerId);
      const resultUrl = await this.persistResult(outputUrl);
      await this.prisma.tryOnJob.update({ where: { id: jobId }, data: { status: TRYON_STATUS.DONE, resultUrl: resultUrl.url, resultPublicId: resultUrl.publicId, finishedAt: new Date() } });
      await this.usage.record({ feature: AI_FEATURE.TRY_ON, provider: AI_PROVIDER.REPLICATE, model: this.replicate.model.split(':')[0], costUsd: TRYON_COST_USD, durationMs: Date.now() - t0, success: true, userId: job.userId });
      this.logger.log({ jobId, ms: Date.now() - t0 }, 'Thử đồ 2D xong');
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      /*
       * Còn lượt BullMQ thử lại (lỗi mạng tạm thời "fetch failed"…) thì GIỮ `processing` để FE tiếp tục poll;
       * chỉ ghi `failed` ở lần cuối — ghi sớm là FE dừng poll trong khi lần sau vẫn có thể ra ảnh.
       */
      const conThuLai = job.attempts + 1 < TRYON_MAX_ATTEMPTS;
      await this.prisma.tryOnJob.update({
        where: { id: jobId },
        data: conThuLai ? { error: message } : { status: TRYON_STATUS.FAILED, error: message, finishedAt: new Date() },
      });
      await this.usage.record({ feature: AI_FEATURE.TRY_ON, provider: AI_PROVIDER.REPLICATE, model: this.replicate.model.split(':')[0], durationMs: Date.now() - t0, success: false, userId: job.userId });
      this.logger.warn({ jobId, err: message, conThuLai }, 'Thử đồ 2D thất bại');
      throw err;
    }
  }

  private async waitForResult(providerId: string): Promise<string> {
    const deadline = Date.now() + TRYON_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const p = await this.replicate.getPrediction(providerId);
      if (p.status === 'succeeded') {
        const out: unknown = Array.isArray(p.output) ? (p.output as unknown[])[0] : p.output;
        if (typeof out !== 'string' || !out.startsWith('http')) throw new Error('Replicate không trả URL ảnh');
        return out;
      }
      if (p.status === 'failed' || p.status === 'canceled') throw new Error(`Replicate ${p.status}: ${(p.error ?? 'không rõ lý do').toString().slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, TRYON_POLL_MS));
    }
    await this.replicate.cancel(providerId);
    throw new Error('Replicate quá thời gian chờ (4 phút)');
  }

  /* Tải ảnh kết quả về Cloudinary để giữ lâu; nếu kho ảnh lỗi thì dùng tạm URL Replicate. */
  private async persistResult(url: string): Promise<{ url: string; publicId: string | null }> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const mimetype = res.headers.get('content-type')?.split(';')[0] || 'image/png';
      const up = await this.storage.uploadImage({ buffer, mimetype, size: buffer.length }, 'ai/try-on-result');
      return { url: up.url, publicId: up.publicId };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Lưu ảnh kết quả về Cloudinary lỗi — dùng URL tạm của Replicate');
      return { url, publicId: null };
    }
  }

  /* Dọn: job cũ hơn N ngày → xoá ảnh người trên Cloudinary (giữ dòng để thống kê, xoá URL). */
  async purgeOld(days: number): Promise<number> {
    const before = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.tryOnJob.findMany({ where: { createdAt: { lt: before }, personPublicId: { not: null } }, select: { id: true, personPublicId: true }, take: 200 });
    for (const r of rows) {
      await this.storage.deleteImage(r.personPublicId ?? '');
      await this.prisma.tryOnJob.update({ where: { id: r.id }, data: { personPublicId: null, personImageUrl: '' } });
    }
    return rows.length;
  }

  private static ownerWhere(who: Who) {
    return who.actor ? { userId: who.actor.userId } : { guestKey: who.guestKey ?? '-', userId: null };
  }

  private static toResponse(j: { id: string; status: string; productId: string; productName: string; personImageUrl: string; garmentImageUrl: string; resultUrl: string | null; error: string | null; createdAt: Date; finishedAt: Date | null }): TryOnJobResponse {
    const pending = j.status === TRYON_STATUS.QUEUED || j.status === TRYON_STATUS.PROCESSING;
    return { jobId: j.id, status: j.status, productId: j.productId, productName: j.productName, personImageUrl: j.personImageUrl, garmentImageUrl: j.garmentImageUrl, resultUrl: j.resultUrl, error: j.error, pollAfterMs: pending ? 3000 : null, createdAt: j.createdAt.toISOString(), finishedAt: j.finishedAt?.toISOString() ?? null };
  }
}
