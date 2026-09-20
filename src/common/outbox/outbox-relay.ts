import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { OUTBOX_STATUS, OutboxEventMessage } from './outbox';

export type OutboxDispatcher = (message: OutboxEventMessage) => Promise<void>;

const MAX_RETRY = 8;
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

interface OutboxRow {
  id: string;
  event_type: string;
  event_version: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  retry_count: number;
  request_id: string | null;
  created_at: Date;
}

/*
 * Relay outbox dùng chung khuôn cho mọi module (worker gọi `poll()` định kỳ, mỗi module một instance với
 * schema của mình). Bảng `<schema>.outbox_events` cùng cột ở mọi module nên SQL thô dùng chung được.
 * - Claim tối đa `batchSize` event PENDING/FAILED tới hạn bằng `SELECT ... FOR UPDATE SKIP LOCKED` trong
 *   MỘT transaction ngắn (đánh dấu PROCESSING luôn) → nhiều worker chạy song song không giẫm nhau.
 * - Dispatch NGOÀI transaction claim (listener có thể gọi mạng, BullMQ…).
 * - Thành công → DONE; lỗi → FAILED + retry_count + backoff mũ (tối đa MAX_RETRY rồi nằm lại FAILED để vận hành xem).
 * - PROCESSING quá 10' (worker chết giữa chừng) được claim lại → listener PHẢI idempotent (processed_events của module nhận).
 * Tên schema được kiểm regex trước khi nội suy vào SQL — không nhận từ bên ngoài.
 */
export class OutboxRelay {
  private readonly logger: Logger;
  private readonly table: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleCode: string,
    private readonly dispatcher: OutboxDispatcher,
    private readonly batchSize = 50,
  ) {
    if (!SAFE_IDENT.test(moduleCode)) throw new Error(`Tên schema outbox không hợp lệ: ${moduleCode}`);
    this.table = `"${moduleCode}"."outbox_events"`;
    this.logger = new Logger(`OutboxRelay:${moduleCode}`);
  }

  async poll(): Promise<number> {
    const claimed = await this.claim();
    for (const ev of claimed) {
      const msg: OutboxEventMessage = {
        id: ev.id,
        module: this.moduleCode,
        eventType: ev.event_type,
        eventVersion: ev.event_version,
        aggregateType: ev.aggregate_type,
        aggregateId: ev.aggregate_id,
        payload: ev.payload,
        requestId: ev.request_id,
        createdAt: ev.created_at.toISOString(),
      };
      try {
        await this.dispatcher(msg);
        await this.mark(ev.id, OUTBOX_STATUS.DONE, null, ev.retry_count);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          { eventId: ev.id, eventType: ev.event_type, err: e, retry: ev.retry_count + 1 },
          'Xử lý outbox event lỗi',
        );
        await this.mark(ev.id, OUTBOX_STATUS.FAILED, e.message.slice(0, 1000), ev.retry_count + 1);
      }
    }
    return claimed.length;
  }

  private async claim(): Promise<OutboxRow[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
        `SELECT id, event_type, event_version, aggregate_type, aggregate_id, payload, retry_count, request_id, created_at
         FROM ${this.table}
         WHERE retry_count < $1::int
           AND ((status IN ('PENDING','FAILED') AND next_attempt_at <= now())
                OR (status = 'PROCESSING' AND updated_at < now() - interval '10 minutes'))
         ORDER BY created_at
         LIMIT $2::int
         FOR UPDATE SKIP LOCKED`,
        MAX_RETRY,
        this.batchSize,
      );
      if (rows.length === 0) return [];
      await tx.$executeRawUnsafe(
        `UPDATE ${this.table} SET status = 'PROCESSING', updated_at = now() WHERE id = ANY($1::uuid[])`,
        rows.map((r) => r.id),
      );
      return rows;
    });
  }

  private async mark(id: string, status: string, error: string | null, retryCount: number): Promise<void> {
    const backoffSec = status === OUTBOX_STATUS.FAILED ? Math.min(2 ** retryCount * 5, 3600) : 0;
    await this.prisma.$executeRawUnsafe(
      `UPDATE ${this.table}
       SET status = $2::varchar, error_message = $3::text, retry_count = $4::int, updated_at = now(),
           processed_at = CASE WHEN $2::varchar = 'DONE' THEN now() ELSE processed_at END,
           next_attempt_at = now() + make_interval(secs => $5::float8)
       WHERE id = $1::uuid`,
      id,
      status,
      error,
      retryCount,
      backoffSec,
    );
  }
}
