import { Injectable } from '@nestjs/common';
import { OutboxEventInput, writeOutboxEvent } from '@common/outbox/outbox';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';

/* Outbox catalog → catalog.outbox_events (CATEGORY_CHANGED: product cập nhật category_slug snapshot, AI nhúng lại). */
@Injectable()
export class CatalogOutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async publish(tx: Tx | null, input: OutboxEventInput): Promise<void> {
    await writeOutboxEvent((tx ?? this.prisma).catalogOutboxEvent, input);
  }
}
