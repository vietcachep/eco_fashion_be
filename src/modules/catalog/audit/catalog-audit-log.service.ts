import { Injectable } from '@nestjs/common';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CATALOG_MODULE } from '../foundation/catalog.constants';

/* Audit của module catalog → catalog.audit_logs (gọi trong transaction nghiệp vụ). */
@Injectable()
export class CatalogAuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async write(tx: Tx | null, actor: Pick<AuthenticatedActor, 'userId' | 'email'> | null, entry: AuditEntry): Promise<void> {
    await writeAuditLog((tx ?? this.prisma).catalogAuditLog, CATALOG_MODULE, actor, entry);
  }
}
