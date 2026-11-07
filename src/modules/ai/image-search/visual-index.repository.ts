import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { VisualHit } from './visual.types';
import { visualVectorSql } from './visual.types';

@Injectable()
export class VisualIndexRepository {
  constructor(private readonly prisma: PrismaService) {}
  async claim(
    input: {
      productId: string;
      imageId: string;
      sourceUrl: string;
      colorCode: string | null;
      sourceHash: string;
      modelVersion: string;
    },
    token: string,
  ): Promise<boolean> {
    const key = { imageId_modelVersion: { imageId: input.imageId, modelVersion: input.modelVersion } };
    await this.prisma.productImageEmbedding.upsert({ where: key, create: input, update: {} });
    const result = await this.prisma.productImageEmbedding.updateMany({
      where: {
        ...key.imageId_modelVersion,
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
          { OR: [{ sourceHash: { not: input.sourceHash } }, { status: { not: 'ready' } }] },
          {
            OR: [
              { retryAt: null },
              { retryAt: { lt: new Date() } },
              { sourceHash: { not: input.sourceHash } },
            ],
          },
        ],
      },
      data: {
        ...input,
        status: 'processing',
        leaseToken: token,
        leaseUntil: new Date(Date.now() + 120_000),
        error: null,
        isDeleted: false,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }
  async finish(imageId: string, model: string, token: string, vector: number[]): Promise<void> {
    await this.prisma
      .$executeRaw`UPDATE ai.product_image_embeddings SET embedding=${visualVectorSql(vector)}::vector, status='ready', error=NULL, retry_at=NULL, lease_token=NULL, lease_until=NULL, updated_at=now(), version=version+1 WHERE image_id=${imageId}::uuid AND model_version=${model} AND lease_token=${token}::uuid`;
  }
  async fail(imageId: string, modelVersion: string, token: string): Promise<void> {
    await this.prisma.productImageEmbedding.updateMany({
      where: { imageId, modelVersion, leaseToken: token },
      data: {
        status: 'failed',
        error: 'Không lập được chỉ mục ảnh; worker sẽ thử lại',
        retryAt: new Date(Date.now() + 300_000),
        leaseToken: null,
        leaseUntil: null,
      },
    });
  }
  async prune(productId: string, imageIds: string[]): Promise<void> {
    await this.prisma.productImageEmbedding.deleteMany({
      where: { productId, imageId: { notIn: imageIds } },
    });
  }
  async nearest(vector: number[], model: string, limit = 50): Promise<VisualHit[]> {
    const rows = await this.prisma.$queryRaw<Array<VisualHit & { similarity: number }>>(Prisma.sql`
      SELECT product_id::text AS "productId", image_id::text AS "imageId", source_url AS "sourceUrl", color_code AS "colorCode",
        1 - (embedding <=> ${visualVectorSql(vector)}::vector) AS similarity
      FROM ai.product_image_embeddings WHERE model_version=${model} AND status='ready' AND NOT is_deleted AND embedding IS NOT NULL
      ORDER BY embedding <=> ${visualVectorSql(vector)}::vector LIMIT ${Math.max(1, Math.min(200, limit))}`);
    return rows;
  }
  async status(modelVersion: string) {
    const groups = await this.prisma.productImageEmbedding.groupBy({
      by: ['status'],
      where: { modelVersion },
      _count: { _all: true },
    });
    return Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  }
  async requestReindex(actor: AuthenticatedActor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.productImageEmbedding.updateMany({ data: { retryAt: null } });
      await tx.aiAuditLog.create({
        data: {
          actorUserId: actor.userId,
          actorEmail: actor.email,
          action: 'VISUAL_INDEX_REINDEX_REQUESTED',
          moduleCode: 'ai',
          entityType: 'visual-index',
          afterSummary: { sweep: true },
        },
      });
    });
  }
}
