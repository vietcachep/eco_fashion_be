import { Injectable } from '@nestjs/common';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { IDENTITY_MODULE } from '../foundation/identity.constants';

export type AuditActor = Pick<AuthenticatedActor, 'userId' | 'email'> | null;

/*
 * Audit log của module identity → bảng identity.audit_logs (AGENTS.md — Database Audit Log Rule).
 * Service nghiệp vụ gọi `write(tx, actor, entry)` TRONG transaction của mình; không tự dựng JSON audit.
 * Factory chung (common/audit) che password/token/secret trong before/after.
 */
@Injectable()
export class IdentityAuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async write(tx: Tx | null, actor: AuditActor, entry: AuditEntry): Promise<void> {
    const client = tx ?? this.prisma;
    await writeAuditLog(client.identityAuditLog, IDENTITY_MODULE, actor, entry);
  }
}
