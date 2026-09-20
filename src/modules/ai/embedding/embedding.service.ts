import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { ProductQueryApi } from '../../product/queryapi/product.queryapi';
import { AI_FEATURE, INDEX_STATUS } from '../foundation/ai.constants';
import { chunkText } from '../foundation/chunk';
import { OpenAiProvider } from '../provider/openai.provider';

export interface ChunkHit {
  documentId: string;
  title: string;
  kind: string;
  content: string;
  distance: number;
}

const toVector = (v: number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;

/*
 * Nhúng sản phẩm + kho tri thức vào pgvector (schema ai). Worker gọi khi có PRODUCT_PUBLISHED/UPDATED, tài liệu mới,
 * hoặc reindex toàn bộ. `source_hash` để bỏ qua khi nội dung không đổi. Tìm kiếm cosine (`<=>`) quét tuần tự —
 * đủ cho vài trăm sản phẩm; lớn hơn thì tạo HNSW ngoài Prisma (docs/03).
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiProvider,
    private readonly products: ProductQueryApi,
  ) {}

  get enabled(): boolean {
    return this.openai.isConfigured;
  }

  // ------------------------------------------------------------ sản phẩm

  async embedProduct(productId: string): Promise<'updated' | 'skipped' | 'removed'> {
    const src = await this.products.embeddingSource(productId);
    if (!src) {
      await this.prisma.productEmbedding.deleteMany({ where: { productId } });
      return 'removed';
    }
    const hash = createHash('sha256').update(src.text).digest('hex');
    const existing = await this.prisma.productEmbedding.findUnique({ where: { productId }, select: { sourceHash: true, status: true } });
    if (existing?.sourceHash === hash && existing.status === INDEX_STATUS.READY) return 'skipped';
    if (!this.enabled) {
      await this.prisma.productEmbedding.upsert({ where: { productId }, create: { productId, productSlug: src.slug, sourceHash: hash, model: 'none', status: INDEX_STATUS.PENDING }, update: { productSlug: src.slug, sourceHash: hash, status: INDEX_STATUS.PENDING } });
      return 'skipped';
    }
    try {
      const [vec] = await this.openai.embed([src.text], AI_FEATURE.EMBEDDING);
      await this.prisma.$executeRaw`
        INSERT INTO "ai"."product_embeddings" (product_id, product_slug, embedding, source_hash, model, status, error, updated_at)
        VALUES (${productId}::uuid, ${src.slug}, ${toVector(vec)}::vector, ${hash}, ${this.openai.embeddingModel}, ${INDEX_STATUS.READY}, NULL, now())
        ON CONFLICT (product_id) DO UPDATE SET product_slug = EXCLUDED.product_slug, embedding = EXCLUDED.embedding, source_hash = EXCLUDED.source_hash, model = EXCLUDED.model, status = EXCLUDED.status, error = NULL, updated_at = now()`;
      return 'updated';
    } catch (err) {
      await this.prisma.productEmbedding.upsert({ where: { productId }, create: { productId, productSlug: src.slug, sourceHash: hash, model: this.openai.embeddingModel, status: INDEX_STATUS.FAILED, error: (err as Error).message.slice(0, 500) }, update: { status: INDEX_STATUS.FAILED, error: (err as Error).message.slice(0, 500) } });
      throw err;
    }
  }

  /* Nhúng lại mọi sản phẩm đang bán (seed/admin) — bỏ qua cái không đổi. */
  async reindexProducts(): Promise<{ updated: number; skipped: number; failed: number }> {
    const list = await this.products.listForEmbedding(1000);
    const r = { updated: 0, skipped: 0, failed: 0 };
    for (const p of list) {
      try {
        const res = await this.embedProduct(p.id);
        if (res === 'updated') r.updated += 1;
        else r.skipped += 1;
      } catch (err) {
        r.failed += 1;
        this.logger.warn({ productId: p.id, err: (err as Error).message }, 'Nhúng sản phẩm lỗi');
      }
    }
    return r;
  }

  /* Sản phẩm gần nghĩa với câu hỏi — trả id theo khoảng cách cosine tăng dần. */
  async searchProducts(query: string, limit = 6, userId?: string | null): Promise<string[]> {
    if (!this.enabled) return [];
    const ready = await this.prisma.productEmbedding.count({ where: { status: INDEX_STATUS.READY } });
    if (ready === 0) return [];
    const [vec] = await this.openai.embed([query], AI_FEATURE.CHAT, userId);
    const rows = await this.prisma.$queryRaw<Array<{ product_id: string; distance: number }>>`
      SELECT product_id, (embedding <=> ${toVector(vec)}::vector) AS distance FROM "ai"."product_embeddings"
      WHERE status = ${INDEX_STATUS.READY} AND embedding IS NOT NULL ORDER BY distance ASC LIMIT ${limit}`;
    return rows.filter((r) => r.distance < 0.6).map((r) => r.product_id);
  }

  /* Sản phẩm tương tự một sản phẩm (gợi ý "có thể bạn thích") — theo vector đã có, không tốn token. */
  async similarProducts(productId: string, limit = 8): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ product_id: string }>>`
      SELECT b.product_id FROM "ai"."product_embeddings" a JOIN "ai"."product_embeddings" b ON b.product_id <> a.product_id
      WHERE a.product_id = ${productId}::uuid AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL AND b.status = ${INDEX_STATUS.READY}
      ORDER BY a.embedding <=> b.embedding ASC LIMIT ${limit}`;
    return rows.map((r) => r.product_id);
  }

  // ------------------------------------------------------------ tài liệu

  static chunk(content: string, size = 700): string[] {
    return chunkText(content, size);
  }

  async indexDocument(documentId: string): Promise<number> {
    const doc = await this.prisma.aiDocument.findFirst({ where: { id: documentId, isDeleted: false } });
    if (!doc) return 0;
    const chunks = EmbeddingService.chunk(`${doc.title}\n\n${doc.content}`);
    if (!this.enabled) {
      // Không có key: vẫn lưu chunk (không vector) để chatbot rule tìm theo từ khoá.
      await this.prisma.$transaction(async (tx) => {
        await tx.aiDocumentChunk.deleteMany({ where: { documentId } });
        await tx.aiDocumentChunk.createMany({ data: chunks.map((c, i) => ({ documentId, chunkIndex: i, content: c })) });
        await tx.aiDocument.update({ where: { id: documentId }, data: { status: INDEX_STATUS.READY, error: null } });
      });
      return chunks.length;
    }
    try {
      const vecs = await this.openai.embed(chunks, AI_FEATURE.EMBEDDING);
      await this.prisma.$transaction(async (tx) => {
        await tx.aiDocumentChunk.deleteMany({ where: { documentId } });
        for (let i = 0; i < chunks.length; i++) {
          await tx.$executeRaw`INSERT INTO "ai"."document_chunks" (document_id, chunk_index, content, embedding) VALUES (${documentId}::uuid, ${i}, ${chunks[i]}, ${toVector(vecs[i])}::vector)`;
        }
        await tx.aiDocument.update({ where: { id: documentId }, data: { status: INDEX_STATUS.READY, error: null } });
      });
      return chunks.length;
    } catch (err) {
      await this.prisma.aiDocument.update({ where: { id: documentId }, data: { status: INDEX_STATUS.FAILED, error: (err as Error).message.slice(0, 500) } });
      throw err;
    }
  }

  /* Ngữ cảnh RAG: vector nếu có, không thì tìm từ khoá (ILIKE) trên chunk. */
  async searchChunks(query: string, k = 4, userId?: string | null): Promise<ChunkHit[]> {
    const active = Prisma.sql`d.is_active = true AND d.is_deleted = false`;
    if (this.enabled) {
      const hasVec = await this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "ai"."document_chunks" WHERE embedding IS NOT NULL`;
      if (Number(hasVec[0]?.n ?? 0) > 0) {
        const [vec] = await this.openai.embed([query], AI_FEATURE.CHAT, userId);
        const rows = await this.prisma.$queryRaw<Array<{ document_id: string; title: string; kind: string; content: string; distance: number }>>`
          SELECT c.document_id, d.title, d.kind, c.content, (c.embedding <=> ${toVector(vec)}::vector) AS distance
          FROM "ai"."document_chunks" c JOIN "ai"."documents" d ON d.id = c.document_id
          WHERE ${active} AND c.embedding IS NOT NULL ORDER BY distance ASC LIMIT ${k}`;
        return rows.filter((r) => r.distance < 0.7).map((r) => ({ documentId: r.document_id, title: r.title, kind: r.kind, content: r.content, distance: r.distance }));
      }
    }
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3).slice(0, 6);
    if (words.length === 0) return [];
    const rows = await this.prisma.$queryRaw<Array<{ document_id: string; title: string; kind: string; content: string; score: number }>>`
      SELECT c.document_id, d.title, d.kind, c.content,
             (${Prisma.join(words.map((w) => Prisma.sql`(CASE WHEN c.content ILIKE ${'%' + w + '%'} THEN 1 ELSE 0 END)`), ' + ')}) AS score
      FROM "ai"."document_chunks" c JOIN "ai"."documents" d ON d.id = c.document_id
      WHERE ${active} ORDER BY score DESC LIMIT ${k}`;
    return rows.filter((r) => Number(r.score) > 0).map((r) => ({ documentId: r.document_id, title: r.title, kind: r.kind, content: r.content, distance: 1 - Number(r.score) / words.length }));
  }
}
