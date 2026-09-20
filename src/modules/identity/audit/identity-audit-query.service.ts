import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { PageResponse } from '@common/response/api-response';
import { AuditLogResponse } from './dto/audit-log.response';

/* Đọc identity.audit_logs cho màn quản trị — chỉ đọc, phân trang, lọc theo action/entity/actor. */
@Injectable()
export class IdentityAuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { page: number; size: number; action?: string; entityType?: string; entityId?: string; actorUserId?: string }): Promise<PageResponse<AuditLogResponse>> {
    const where = {
      ...(params.action ? { action: params.action } : {}),
      ...(params.entityType ? { entityType: params.entityType } : {}),
      ...(params.entityId ? { entityId: params.entityId } : {}),
      ...(params.actorUserId ? { actorUserId: params.actorUserId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.identityAuditLog.findMany({ where, skip: (params.page - 1) * params.size, take: params.size, orderBy: { createdAt: 'desc' } }),
      this.prisma.identityAuditLog.count({ where }),
    ]);
    return PageResponse.of(
      items.map((a) => ({
        id: a.id,
        actorUserId: a.actorUserId,
        actorEmail: a.actorEmail,
        action: a.action,
        moduleCode: a.moduleCode,
        entityType: a.entityType,
        entityId: a.entityId,
        entityCode: a.entityCode,
        requestId: a.requestId,
        before: a.beforeSummary,
        after: a.afterSummary,
        ipAddress: a.ipAddress,
        createdAt: a.createdAt.toISOString(),
      })),
      params.page,
      params.size,
      total,
    );
  }
}
