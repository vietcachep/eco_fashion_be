import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { UserProfileResponse } from '../dto/user.responses';
import { AdminResetPasswordRequest, CreateStaffRequest, ListUsersQuery, SetUserStatusRequest, UpdateUserByAdminRequest } from '../request/user.requests';
import { UserService } from '../service/user.service';

/*
 * /admin/users — quản trị người dùng & nhân viên. Mỗi route gác bằng MÃ QUYỀN (không kiểm theo vai):
 * identity.user.read / create / update / lock. Đặt lại mật khẩu nhân viên = identity.user.update.
 */
@ApiTags('admin-users')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUserController {
  constructor(private readonly users: UserService) {}

  @Get()
  @RequirePermission('identity.user.read')
  @ApiOperation({ summary: 'Danh sách người dùng (lọc vai, trạng thái, tìm email/tên/SĐT)' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() query: ListUsersQuery): Promise<ApiResponse<PageResponse<UserProfileResponse>>> {
    return ApiResponse.ok(await this.users.list({ page: query.page, size: query.size, q: query.q, roleCode: query.roleCode, status: query.status, staffOnly: query.staffOnly }));
  }

  @Get(':id')
  @RequirePermission('identity.user.read')
  @ApiOperation({ summary: 'Chi tiết người dùng' })
  @ApiOkResponse({ type: UserProfileResponse })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<UserProfileResponse>> {
    return ApiResponse.ok(await this.users.get(id));
  }

  @Post()
  @RequirePermission('identity.user.create')
  @ApiOperation({ summary: 'Tạo tài khoản nhân viên (vai nhân viên, không tạo khách)' })
  @ApiOkResponse({ type: UserProfileResponse })
  async createStaff(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreateStaffRequest): Promise<ApiResponse<UserProfileResponse>> {
    const r = await this.users.createStaff(actor, { email: body.email, fullName: body.fullName, roleCode: body.roleCode, password: body.password, phone: body.phone ?? null });
    return ApiResponse.ok(r, 'Đã tạo tài khoản nhân viên');
  }

  @Patch(':id')
  @RequirePermission('identity.user.update')
  @ApiOperation({ summary: 'Sửa họ tên / SĐT / vai của nhân viên' })
  @ApiOkResponse({ type: UserProfileResponse })
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateUserByAdminRequest): Promise<ApiResponse<UserProfileResponse>> {
    return ApiResponse.ok(await this.users.updateByAdmin(actor, id, { fullName: body.fullName, phone: body.phone, roleCode: body.roleCode }), 'Đã cập nhật');
  }

  @Put(':id/status')
  @RequirePermission('identity.user.lock')
  @ApiOperation({ summary: 'Khoá / mở khoá tài khoản (khoá = thu hồi mọi phiên)' })
  @ApiOkResponse({ type: UserProfileResponse })
  async setStatus(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetUserStatusRequest): Promise<ApiResponse<UserProfileResponse>> {
    const r = await this.users.setStatus(actor, id, body.status, body.reason ?? null);
    return ApiResponse.ok(r, body.status === 'locked' ? 'Đã khoá tài khoản' : 'Đã mở khoá tài khoản');
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('identity.user.update')
  @ApiOperation({ summary: 'Đặt lại mật khẩu cho người dùng (thu hồi mọi phiên của họ)' })
  async resetPassword(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: AdminResetPasswordRequest): Promise<ApiResponse<null>> {
    await this.users.resetPasswordByAdmin(actor, id, body.newPassword);
    return ApiResponse.ok(null, 'Đã đặt lại mật khẩu');
  }
}
