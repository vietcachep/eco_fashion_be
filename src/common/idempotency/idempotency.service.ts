import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { ConflictException } from '../exception/business.exception';

export const IDEMPOTENCY_STATUS = { IN_PROGRESS: 'IN_PROGRESS', DONE: 'DONE' } as const;

export interface IdempotencyRow {
  id: string;
  scope: string;
  actorKey: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  responseStatus: number | null;
  responseBody: unknown;
  resultRef: string | null;
  expiresAt: Date;
}

/* Delegate tối thiểu của Prisma cho bảng `<schema>.idempotency_keys` của module (vd `tx.orderIdempotencyKey`). */
export interface IdempotencyDelegate {
  findUnique(args: {
    where: { scope_actorKey_idempotencyKey: { scope: string; actorKey: string; idempotencyKey: string } };
  }): Promise<IdempotencyRow | null>;
  create(args: {
    data: {
      scope: string;
      actorKey: string;
      idempotencyKey: string;
      requestHash: string;
      status: string;
      expiresAt: Date;
    };
  }): Promise<IdempotencyRow>;
  update(args: {
    where: { id: string };
    data: { status: string; responseStatus: number; responseBody: Prisma.InputJsonValue; resultRef: string | null };
  }): Promise<unknown>;
}

export interface IdempotencyBegin<T> {
  /* Đã có kết quả cũ hợp lệ — trả ngay, KHÔNG chạy nghiệp vụ. */
  replay: T | null;
  /* Gọi khi nghiệp vụ xong (cùng transaction) để lưu response cho lần retry sau. */
  complete: (status: number, body: T, resultRef?: string | null) => Promise<void>;
}

/*
 * Idempotency key thật (AGENTS.md — Idempotency Rule mức 3), khuôn chung nhưng BẢNG THUỘC MODULE
 * (truyền delegate từ `tx` — unique (scope, actor_key, idempotency_key) trong migration của module).
 *
 * Trong transaction nghiệp vụ:
 *   1. Tìm theo (scope, actor, key): có rồi → hash khác → 409 KEY_REUSED · DONE + hash trùng → replay ·
 *      IN_PROGRESS → 409 IN_PROGRESS (instance khác đang xử lý).
 *   2. Chưa có → INSERT IN_PROGRESS (unique index là chốt khi hai request song song — request thua nhận
 *      lỗi trùng → filter trả 409 COMMON_DUPLICATE, client thử lại sẽ nhận replay).
 *   3. Nghiệp vụ chạy; `complete()` ghi DONE + response. Rollback → dòng INSERT cũng mất → retry sạch.
 * Không dùng Redis: đúng/sai của idempotency phải sống cùng transaction DB.
 */
export class IdempotencyService {
  static hashRequest(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? {}))
      .digest('hex');
  }

  static async begin<T>(
    delegate: IdempotencyDelegate,
    params: { scope: string; actorKey: string; key: string; requestHash: string; ttlHours?: number },
  ): Promise<IdempotencyBegin<T>> {
    const where = { scope: params.scope, actorKey: params.actorKey, idempotencyKey: params.key };
    const existing = await delegate.findUnique({ where: { scope_actorKey_idempotencyKey: where } });
    if (existing) {
      if (existing.requestHash !== params.requestHash) {
        throw new ConflictException('COMMON_IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key đã dùng cho một yêu cầu khác');
      }
      if (existing.status === IDEMPOTENCY_STATUS.DONE) {
        return { replay: (existing.responseBody as T) ?? null, complete: () => Promise.resolve() };
      }
      throw new ConflictException('COMMON_IDEMPOTENCY_IN_PROGRESS', 'Yêu cầu này đang được xử lý, vui lòng đợi');
    }
    const row = await delegate.create({
      data: {
        ...where,
        requestHash: params.requestHash,
        status: IDEMPOTENCY_STATUS.IN_PROGRESS,
        expiresAt: new Date(Date.now() + (params.ttlHours ?? 24) * 3600_000),
      },
    });
    return {
      replay: null,
      complete: async (status, body, resultRef = null) => {
        await delegate.update({
          where: { id: row.id },
          data: { status: IDEMPOTENCY_STATUS.DONE, responseStatus: status, responseBody: JSON.parse(JSON.stringify(body ?? null)) as Prisma.InputJsonValue, resultRef },
        });
      },
    };
  }
}
