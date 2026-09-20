import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import { RequirePermission } from '@common/security/decorators';
import { AuditLogResponse } from '../dto/audit-log.response';
import { IdentityAuditQueryService } from '../identity-audit-query.service';
import { ListAuditLogQuery } from '../request/audit-log.query';

@ApiTags('admin-audit')
@ApiBearerAuth()
@Controller('admin/audit-logs')
export class AdminAuditController {
  constructor(private readonly audit: IdentityAuditQueryService) {}

  @Get('identity')
  @RequirePermission('identity.audit.read')
  @ApiOperation({ summary: 'Audit log module identity (ai làm gì với user/vai/quyền/địa chỉ)' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: ListAuditLogQuery): Promise<ApiResponse<PageResponse<AuditLogResponse>>> {
    return ApiResponse.ok(await this.audit.list({ page: q.page, size: q.size, action: q.action, entityType: q.entityType, entityId: q.entityId, actorUserId: q.actorUserId }));
  }
}
