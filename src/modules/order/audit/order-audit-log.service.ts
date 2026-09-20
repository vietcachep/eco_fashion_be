import { Injectable } from '@nestjs/common';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ORDER_MODULE } from '../foundation/order.constants';

@Injectable()
export class OrderAuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async write(tx: Tx | null, actor: Pick<AuthenticatedActor, 'userId' | 'email'> | null, entry: AuditEntry): Promise<void> {
    await writeAuditLog((tx ?? this.prisma).orderAuditLog, ORDER_MODULE, actor, entry);
  }
}
