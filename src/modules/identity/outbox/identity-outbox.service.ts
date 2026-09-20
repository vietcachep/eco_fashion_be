import { Injectable } from '@nestjs/common';
import { OutboxEventInput, writeOutboxEvent } from '@common/outbox/outbox';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';

/*
 * Outbox của module identity → bảng identity.outbox_events. Ghi TRONG transaction nghiệp vụ; worker
 * (IdentityWorkerModule) relay sau commit tới listener qua EventEmitter `outbox.identity.<EVENT_TYPE>`.
 */
@Injectable()
export class IdentityOutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async publish(tx: Tx | null, input: OutboxEventInput): Promise<void> {
    const client = tx ?? this.prisma;
    await writeOutboxEvent(client.identityOutboxEvent, input);
  }

  /*
   * Listener gọi để đảm bảo idempotent: INSERT processed_events (unique event_id+handler) — trùng → đã xử lý,
   * trả false để listener bỏ qua. Gọi CÙNG transaction với side effect.
   */
  async markProcessed(tx: Tx, eventId: string, eventType: string, handler: string): Promise<boolean> {
    const existing = await tx.identityProcessedEvent.findUnique({ where: { eventId_handler: { eventId, handler } } });
    if (existing) return false;
    await tx.identityProcessedEvent.create({ data: { eventId, eventType, handler } });
    return true;
  }
}
