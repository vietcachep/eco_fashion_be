import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { RoleResponse } from '../dto/permission.responses';
import { ReplaceRolePermissionsRequest } from '../request/permission.requests';
import { PermissionService } from '../service/permission.service';

/* /admin/roles — vai hệ thống và preset quyền. Không tạo/xoá vai qua API (đề tài: 7 vai cố định trong catalog). */
@ApiTags('admin-roles')
@ApiBearerAuth()
@Controller('admin/roles')
export class AdminRoleController {
  constructor(private readonly permissions: PermissionService) {}

  @Get()
  @RequirePermission('identity.role.read')
  @ApiOperation({ summary: 'Danh sách vai kèm mã quyền hiện có' })
  @ApiOkResponse({ type: [RoleResponse] })
  async list(): Promise<ApiResponse<RoleResponse[]>> {
    return ApiResponse.ok(await this.permissions.listRoles());
  }

  @Get(':code/permissions')
  @RequirePermission('identity.role.read')
  @ApiOperation({ summary: 'Mã quyền của một vai' })
  @ApiOkResponse({ type: RoleResponse })
  async rolePermissions(@Param('code') code: string): Promise<ApiResponse<RoleResponse>> {
    const { role, permissionCodes } = await this.permissions.rolePermissions(code);
    return ApiResponse.ok({ ...role, permissionCodes });
  }

  @Put(':code/permissions')
  @RequirePermission('identity.role.update')
  @ApiOperation({ summary: 'Thay TOÀN BỘ bộ quyền của vai (admin luôn toàn quyền, không sửa được)' })
  @ApiOkResponse({ type: RoleResponse })
  async replace(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: ReplaceRolePermissionsRequest): Promise<ApiResponse<RoleResponse>> {
    const permissionCodes = await this.permissions.replaceRolePermissions(actor, code, body.permissionCodes);
    const { role } = await this.permissions.rolePermissions(code);
    return ApiResponse.ok({ ...role, permissionCodes }, 'Đã cập nhật bộ quyền của vai');
  }
}
