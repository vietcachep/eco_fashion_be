import { Injectable } from '@nestjs/common';
import { OutboxEventInput, writeOutboxEvent } from '@common/outbox/outbox';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';

/* Outbox order → order.outbox_events: ORDER_CREATED/STATUS_CHANGED/CANCELLED/PAID/DELIVERED/RETURN_* (mail, thống kê, AI). */
@Injectable()
export class OrderOutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async publish(tx: Tx | null, input: OutboxEventInput): Promise<void> {
    await writeOutboxEvent((tx ?? this.prisma).orderOutboxEvent, input);
  }

  async markProcessed(tx: Tx, eventId: string, eventType: string, handler: string): Promise<boolean> {
    const existing = await tx.orderProcessedEvent.findUnique({ where: { eventId_handler: { eventId, handler } } });
    if (existing) return false;
    await tx.orderProcessedEvent.create({ data: { eventId, eventType, handler } });
    return true;
  }
}
