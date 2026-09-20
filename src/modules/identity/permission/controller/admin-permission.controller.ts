import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { PermissionResponse, UserPermissionOverrideResponse } from '../dto/permission.responses';
import { SaveUserPermissionsRequest } from '../request/permission.requests';
import { PermissionService } from '../service/permission.service';

/* Catalog quyền + cấp/chặn quyền riêng cho từng người (deny thắng vai). */
@ApiTags('admin-roles')
@ApiBearerAuth()
@Controller('admin')
export class AdminPermissionController {
  constructor(private readonly permissions: PermissionService) {}

  @Get('permissions')
  @RequirePermission('identity.role.read')
  @ApiOperation({ summary: 'Toàn bộ mã quyền trong hệ thống (theo module)' })
  @ApiOkResponse({ type: [PermissionResponse] })
  async list(): Promise<ApiResponse<PermissionResponse[]>> {
    return ApiResponse.ok(await this.permissions.listPermissions());
  }

  @Get('users/:id/permissions')
  @RequirePermission('identity.permission.assign')
  @ApiOperation({ summary: 'Override quyền riêng của một người' })
  @ApiOkResponse({ type: [UserPermissionOverrideResponse] })
  async userOverrides(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<UserPermissionOverrideResponse[]>> {
    const rows = await this.permissions.userOverrides(id);
    return ApiResponse.ok(rows.map((r) => ({ code: r.code, allowed: r.allowed, reason: r.reason })));
  }

  @Put('users/:id/permissions')
  @RequirePermission('identity.permission.assign')
  @ApiOperation({ summary: 'Cấp / chặn / gỡ override quyền riêng (allowed null = gỡ)' })
  @ApiOkResponse({ type: [UserPermissionOverrideResponse] })
  async save(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaveUserPermissionsRequest): Promise<ApiResponse<UserPermissionOverrideResponse[]>> {
    const rows = await this.permissions.saveUserOverrides(
      actor,
      id,
      body.overrides.map((o) => ({ code: o.code, allowed: o.allowed ?? null, reason: o.reason ?? null })),
    );
    return ApiResponse.ok(rows.map((r) => ({ code: r.code, allowed: r.allowed, reason: r.reason })), 'Đã cập nhật quyền riêng');
  }
}
