import { Injectable } from '@nestjs/common';
import { OutboxEventInput, writeOutboxEvent } from '@common/outbox/outbox';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';

/* Outbox payment: shop wallet events (COD_COMMISSION_CHARGED, DEPOSIT_APPROVED, etc). */
@Injectable()
export class PaymentOutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async publish(tx: Tx | null, input: OutboxEventInput): Promise<void> {
    await writeOutboxEvent((tx ?? this.prisma).paymentOutboxEvent, input);
  }

  async markProcessed(tx: Tx, eventId: string, eventType: string, handler: string): Promise<boolean> {
    const existing = await tx.paymentProcessedEvent.findUnique({ where: { eventId_handler: { eventId, handler } } });
    if (existing) return false;
    await tx.paymentProcessedEvent.create({ data: { eventId, eventType, handler } });
    return true;
  }
}
