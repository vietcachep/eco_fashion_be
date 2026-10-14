import { Injectable } from '@nestjs/common';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { SHOP_MODULE } from '../foundation/shop.constants';

export type ShopAuditActor = Pick<AuthenticatedActor, 'userId' | 'email'> | null;

/*
 * Audit log của module shop → bảng shop.audit_logs (AGENTS.md — Database Audit Log Rule).
 * Service nghiệp vụ gọi `write(tx, actor, entry)` TRONG transaction của mình; không tự dựng JSON audit.
 */
@Injectable()
export class ShopAuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async write(tx: Tx | null, actor: ShopAuditActor, entry: AuditEntry): Promise<void> {
    const client = tx ?? this.prisma;
    await writeAuditLog(client.shopAuditLog, SHOP_MODULE, actor, entry);
  }
}
