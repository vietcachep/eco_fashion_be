import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { PageQuery } from '@common/utils/pagination';
import { LoginHistoryResponse } from '../dto/login-history.response';
import { ListLoginHistoryQuery } from '../request/login-history.query';
import { LoginHistoryService } from '../service/login-history.service';

@ApiTags('admin-audit')
@ApiBearerAuth()
@Controller()
export class LoginHistoryController {
  constructor(private readonly history: LoginHistoryService) {}

  @Get('admin/login-histories')
  @RequirePermission('identity.audit.read')
  @ApiOperation({ summary: 'Lịch sử đăng nhập toàn hệ thống (lọc email / user / thành bại)' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: ListLoginHistoryQuery): Promise<ApiResponse<PageResponse<LoginHistoryResponse>>> {
    return ApiResponse.ok(await this.history.list({ page: q.page, size: q.size, email: q.email, userId: q.userId, success: q.success }));
  }

  @Get('users/me/login-histories')
  @ApiOperation({ summary: 'Lịch sử đăng nhập của tôi' })
  @ApiOkResponse({ type: PageResponse })
  async mine(@CurrentActor() actor: AuthenticatedActor, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<LoginHistoryResponse>>> {
    return ApiResponse.ok(await this.history.list({ page: q.page, size: q.size, userId: actor.userId }));
  }
}
