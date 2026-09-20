import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { QUEUE } from '@common/queue/queue.module';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { AI_ERR, AI_JOB, AI_MODULE, INDEX_STATUS } from '../foundation/ai.constants';

export interface AiDocumentResponse {
  id: string;
  title: string;
  kind: string;
  content: string;
  status: string;
  error: string | null;
  isActive: boolean;
  chunkCount: number;
  updatedAt: string;
}

/* Kho tri thức chatbot (ai.knowledge.manage): CRUD tài liệu; lưu xong đẩy job index (cắt đoạn + nhúng) sang worker. */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE.AI) private readonly queue: Queue,
  ) {}

  async list(page: number, size: number, f: { kind?: string; q?: string }): Promise<PageResponse<AiDocumentResponse>> {
    const where = { isDeleted: false, ...(f.kind ? { kind: f.kind } : {}), ...(f.q ? { OR: [{ title: { contains: f.q, mode: 'insensitive' as const } }, { content: { contains: f.q, mode: 'insensitive' as const } }] } : {}) };
    const [items, total] = await Promise.all([this.prisma.aiDocument.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * size, take: size, include: { _count: { select: { chunks: true } } } }), this.prisma.aiDocument.count({ where })]);
    return PageResponse.of(items.map((d) => KnowledgeService.toResponse(d, d._count.chunks)), page, size, total);
  }

  async get(id: string): Promise<AiDocumentResponse> {
    const d = await this.prisma.aiDocument.findFirst({ where: { id, isDeleted: false }, include: { _count: { select: { chunks: true } } } });
    if (!d) throw new NotFoundException(AI_ERR.DOCUMENT_NOT_FOUND, 'Không tìm thấy tài liệu');
    return KnowledgeService.toResponse(d, d._count.chunks);
  }

  async create(actor: AuthenticatedActor, input: { title: string; kind: string; content: string; isActive?: boolean }): Promise<AiDocumentResponse> {
    const d = await this.prisma.$transaction(async (tx) => {
      const created = await tx.aiDocument.create({ data: { title: input.title.trim(), kind: input.kind, content: input.content.trim(), isActive: input.isActive ?? true, status: INDEX_STATUS.PENDING, createdBy: actor.userId, updatedBy: actor.userId } });
      await this.audit(tx, actor, { action: 'AI_DOCUMENT_CREATED', entityType: 'ai_document', entityId: created.id, after: { title: created.title, kind: created.kind } });
      return created;
    });
    await this.enqueueIndex(d.id);
    return KnowledgeService.toResponse(d, 0);
  }

  async update(actor: AuthenticatedActor, id: string, input: { title?: string; kind?: string; content?: string; isActive?: boolean }): Promise<AiDocumentResponse> {
    const before = await this.prisma.aiDocument.findFirst({ where: { id, isDeleted: false } });
    if (!before) throw new NotFoundException(AI_ERR.DOCUMENT_NOT_FOUND, 'Không tìm thấy tài liệu');
    const contentChanged = (input.content !== undefined && input.content.trim() !== before.content) || (input.title !== undefined && input.title.trim() !== before.title);
    const d = await this.prisma.$transaction(async (tx) => {
      const u = await tx.aiDocument.update({ where: { id }, data: { ...(input.title !== undefined ? { title: input.title.trim() } : {}), ...(input.kind !== undefined ? { kind: input.kind } : {}), ...(input.content !== undefined ? { content: input.content.trim() } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}), ...(contentChanged ? { status: INDEX_STATUS.PENDING } : {}), updatedBy: actor.userId, version: { increment: 1 } }, include: { _count: { select: { chunks: true } } } });
      await this.audit(tx, actor, { action: 'AI_DOCUMENT_UPDATED', entityType: 'ai_document', entityId: id, before: { title: before.title, isActive: before.isActive }, after: { title: u.title, isActive: u.isActive, reindex: contentChanged } });
      return u;
    });
    if (contentChanged) await this.enqueueIndex(id);
    return KnowledgeService.toResponse(d, d._count.chunks);
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    const before = await this.prisma.aiDocument.findFirst({ where: { id, isDeleted: false } });
    if (!before) throw new NotFoundException(AI_ERR.DOCUMENT_NOT_FOUND, 'Không tìm thấy tài liệu');
    await this.prisma.$transaction(async (tx) => {
      await tx.aiDocument.update({ where: { id }, data: { isDeleted: true, isActive: false, updatedBy: actor.userId } });
      await tx.aiDocumentChunk.deleteMany({ where: { documentId: id } });
      await this.audit(tx, actor, { action: 'AI_DOCUMENT_DELETED', entityType: 'ai_document', entityId: id, before: { title: before.title } });
    });
  }

  async reindexAll(): Promise<number> {
    const docs = await this.prisma.aiDocument.findMany({ where: { isDeleted: false }, select: { id: true } });
    await this.prisma.aiDocument.updateMany({ where: { isDeleted: false }, data: { status: INDEX_STATUS.PENDING } });
    for (const d of docs) await this.enqueueIndex(d.id);
    return docs.length;
  }

  /* Nhúng lại MỘT bài (nhân viên bấm trên màn tài liệu). */
  async reindexOne(id: string): Promise<void> {
    const d = await this.prisma.aiDocument.findFirst({ where: { id, isDeleted: false }, select: { id: true } });
    if (!d) throw new NotFoundException(AI_ERR.DOCUMENT_NOT_FOUND, 'Không tìm thấy tài liệu');
    await this.prisma.aiDocument.update({ where: { id }, data: { status: INDEX_STATUS.PENDING } });
    await this.enqueueIndex(id);
  }

  /* Chỉ mục AI đang thế nào — một endpoint cho một màn: tài liệu/đoạn, sản phẩm đã nhúng, FAQ, tóm tắt đánh giá, lần cập nhật cuối. */
  async indexStatus(): Promise<{ documents: { total: number; ready: number; pending: number; failed: number; chunks: number; chunksWithVector: number; lastIndexedAt: string | null }; products: { active: number; ready: number; pending: number; failed: number; lastIndexedAt: string | null }; faqs: { ready: number; pending: number; failed: number }; reviewSummaries: number; embeddingEnabled: boolean }> {
    const [docs, chunks, chunksVec, docLast, prods, prodLast, faqs, summaries, activeProducts] = await Promise.all([
      this.prisma.aiDocument.groupBy({ by: ['status'], where: { isDeleted: false }, _count: true }),
      this.prisma.aiDocumentChunk.count(),
      this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "ai"."document_chunks" WHERE embedding IS NOT NULL`,
      this.prisma.aiDocument.aggregate({ where: { isDeleted: false, status: INDEX_STATUS.READY }, _max: { updatedAt: true } }),
      this.prisma.productEmbedding.groupBy({ by: ['status'], _count: true }),
      this.prisma.productEmbedding.aggregate({ where: { status: INDEX_STATUS.READY }, _max: { updatedAt: true } }),
      this.prisma.productFaq.groupBy({ by: ['status'], _count: true }),
      this.prisma.reviewSummary.count(),
      this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "product"."products" WHERE is_deleted = false AND status = 'active'`,
    ]);
    const pick = (rows: Array<{ status: string; _count: number }>, st: string) => rows.find((r) => r.status === st)?._count ?? 0;
    return {
      documents: { total: docs.reduce((a, r) => a + r._count, 0), ready: pick(docs, 'ready'), pending: pick(docs, 'pending'), failed: pick(docs, 'failed'), chunks, chunksWithVector: Number(chunksVec[0]?.n ?? 0), lastIndexedAt: docLast._max.updatedAt?.toISOString() ?? null },
      products: { active: Number(activeProducts[0]?.n ?? 0), ready: pick(prods, 'ready'), pending: pick(prods, 'pending'), failed: pick(prods, 'failed'), lastIndexedAt: prodLast._max.updatedAt?.toISOString() ?? null },
      faqs: { ready: pick(faqs, 'ready'), pending: pick(faqs, 'pending'), failed: pick(faqs, 'failed') },
      reviewSummaries: summaries,
      embeddingEnabled: Boolean(this.queue),
    };
  }

  enqueueIndex(documentId: string): Promise<unknown> {
    return this.queue.add(AI_JOB.INDEX_DOCUMENT, { documentId }, { jobId: `index-doc-${documentId}-${Date.now()}` });
  }

  private static toResponse(d: { id: string; title: string; kind: string; content: string; status: string; error: string | null; isActive: boolean; updatedAt: Date }, chunkCount: number): AiDocumentResponse {
    return { id: d.id, title: d.title, kind: d.kind, content: d.content, status: d.status, error: d.error, isActive: d.isActive, chunkCount, updatedAt: d.updatedAt.toISOString() };
  }

  private audit(tx: Tx, actor: AuthenticatedActor, entry: AuditEntry): Promise<void> {
    return writeAuditLog(tx.aiAuditLog, AI_MODULE, actor, entry);
  }
}
