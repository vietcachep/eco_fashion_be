import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE } from '@common/queue/queue.module';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { AI_JOB } from '../foundation/ai.constants';
import { ProductQueryApi } from '@modules/product/queryapi/product.queryapi';
import { VisualEncoderProvider } from './visual-encoder.provider';
import { CatalogImageProvider } from './catalog-image.provider';
import { VisualIndexRepository } from './visual-index.repository';
import type { VisualHit } from './visual.types';

/* Index ngoài transaction: claim lease→download/encode→finalize có token. Sweep là đường phục hồi outbox/mất worker. */
@Injectable()
export class VisualIndexService {
  private readonly logger = new Logger(VisualIndexService.name);
  private running = false;
  private cursor: string | undefined;
  constructor(
    private readonly products: ProductQueryApi,
    readonly encoder: VisualEncoderProvider,
    readonly images: CatalogImageProvider,
    readonly repo: VisualIndexRepository,
    @InjectQueue(QUEUE.AI) private readonly queue: Queue,
  ) {}
  async requestReindex(actor: AuthenticatedActor): Promise<void> {
    await this.repo.requestReindex(actor);
    await this.queue.add(
      AI_JOB.VISUAL_INDEX,
      {},
      {
        jobId: 'visual-index-sweep',
        removeOnComplete: true,
        removeOnFail: 20,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  }
  async indexProduct(id: string): Promise<void> {
    if (!this.encoder.configured) return;
    const source = (await this.products.visualImageSources({ productIds: [id] }))[0];
    await this.repo.prune(id, source?.images.map((i) => i.id) ?? []);
    if (!source) return;
    for (const image of source.images) {
      const token = randomUUID();
      const sourceHash = createHash('sha256')
        .update(JSON.stringify([image.url, image.colorCode, source.updatedAt.toISOString()]))
        .digest('hex');
      if (
        !(await this.repo.claim(
          {
            productId: id,
            imageId: image.id,
            sourceUrl: image.url,
            colorCode: image.colorCode,
            sourceHash,
            modelVersion: this.encoder.modelVersion,
          },
          token,
        ))
      )
        continue;
      try {
        const file = await this.images.download(image.url);
        const [vector] = await this.encoder.embed([file]);
        await this.repo.finish(image.id, this.encoder.modelVersion, token, vector);
      } catch {
        await this.repo.fail(image.id, this.encoder.modelVersion, token);
        this.logger.warn({ imageId: image.id }, 'Ảnh catalog chưa được lập chỉ mục, sẽ thử lại');
      }
    }
  }
  async sweep(): Promise<void> {
    if (this.running || !this.encoder.configured) return;
    this.running = true;
    try {
      const products = await this.products.visualImageSources({ after: this.cursor, limit: 10 });
      for (const p of products) {
        await this.indexProduct(p.id);
        this.cursor = p.id;
      }
      if (products.length < 10) this.cursor = undefined;
    } finally {
      this.running = false;
    }
  }
  resetCursor(): void {
    this.cursor = undefined;
  }
  async retrieve(file: { buffer: Buffer; mimetype: string }): Promise<VisualHit[]> {
    const [vector] = await this.encoder.embed([file]);
    const hits = await this.repo.nearest(vector, this.encoder.modelVersion, 100);
    const current = await this.products.visualImageSources({
      productIds: [...new Set(hits.map((h) => h.productId))],
      limit: 100,
    });
    const images = new Map(
      current.flatMap((p) => p.images.map((i) => [i.id, { productId: p.id, url: i.url }])),
    );
    const best = new Map<string, VisualHit>();
    for (const h of hits) {
      const image = images.get(h.imageId);
      if (image?.productId === h.productId && image.url === h.sourceUrl && !best.has(h.productId))
        best.set(h.productId, h);
    }
    return [...best.values()].slice(0, 50);
  }
}
