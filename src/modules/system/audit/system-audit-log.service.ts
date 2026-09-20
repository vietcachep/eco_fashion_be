import { Injectable } from '@nestjs/common';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { SYSTEM_MODULE } from '../foundation/system.constants';

@Injectable()
export class SystemAuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async write(tx: Tx | null, actor: Pick<AuthenticatedActor, 'userId' | 'email'> | null, entry: AuditEntry): Promise<void> {
    await writeAuditLog((tx ?? this.prisma).systemAuditLog, SYSTEM_MODULE, actor, entry);
  }
}
