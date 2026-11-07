import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { writeAuditLog } from '@common/audit/audit';
import { writeOutboxEvent } from '@common/outbox/outbox';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
export type { Tx } from '@common/prisma/types';
export type { LiveSession, LiveMessage } from '../../generated/prisma/client';

/* Repository duy nhất chạm DB livestream. Khoá advisory toàn demo cho claim room/quota, row lock cho thứ tự chat/ghim. */
@Injectable()
export class LiveRepository {
  constructor(readonly db: PrismaService) {}
  transaction<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.$transaction(fn, { timeout: 15_000 });
  }
  async globalLock(tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(81450216)`;
  }
  async rowLock(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM livestream.sessions WHERE id=${id}::uuid FOR UPDATE`;
  }
  async audit(
    tx: Tx,
    actor: AuthenticatedActor | null,
    action: string,
    id: string,
    after: Record<string, unknown> = {},
  ): Promise<void> {
    await writeAuditLog(tx.liveAuditLog, 'livestream', actor, {
      action,
      entityType: 'live-session',
      entityId: id,
      after,
    });
  }
  async event(tx: Tx, id: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await writeOutboxEvent(tx.liveOutboxEvent, {
      eventType,
      aggregateType: 'live-session',
      aggregateId: id,
      payload: { sessionId: id, ...payload },
    });
  }
  session(id: string, tx?: Tx) {
    return (tx ?? this.db).liveSession.findFirst({ where: { id, isDeleted: false } });
  }
  async page(where: Prisma.LiveSessionWhereInput, page: number, size: number) {
    const [content, total] = await Promise.all([
      this.db.liveSession.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.db.liveSession.count({ where }),
    ]);
    return { content, total };
  }
}
