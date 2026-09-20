import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BusinessException } from '@common/exception/business.exception';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, Public } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { generateInitialAvatarSvg } from '@common/utils';
import { UserProfileResponse } from '../dto/user.responses';
import { ChangePasswordRequest } from '../../auth/request/auth.requests';
import { accessExpOf, AuthService } from '../../auth/service/auth.service';
import { UpdateProfileRequest } from '../request/user.requests';
import { UserService } from '../service/user.service';

/*
 * /users/me — hồ sơ của CHÍNH người đăng nhập (khách lẫn nhân viên). userId luôn lấy từ token.
 * PUT /users/me và POST /users/me/change-password là alias theo đường FE bán hàng gọi (docs/06_FE_CONTRACT.md).
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users/me')
export class MeController {
  constructor(
    private readonly users: UserService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Hồ sơ của tôi' })
  @ApiOkResponse({ type: UserProfileResponse })
  async me(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<UserProfileResponse>> {
    return ApiResponse.ok(await this.users.myProfile(actor));
  }

  @Patch()
  @Put()
  @ApiOperation({ summary: 'Sửa họ tên / SĐT của tôi (PATCH hoặc PUT)' })
  @ApiOkResponse({ type: UserProfileResponse })
  async update(@CurrentActor() actor: AuthenticatedActor, @Body() body: UpdateProfileRequest): Promise<ApiResponse<UserProfileResponse>> {
    return ApiResponse.ok(await this.users.updateMyProfile(actor, { fullName: body.fullName, phone: body.phone }), 'Đã cập nhật hồ sơ');
  }

  @HttpCode(HttpStatus.OK)
  @Post('change-password')
  @ApiOperation({ summary: 'Đổi mật khẩu (alias của /auth/change-password) — thu hồi mọi phiên khác' })
  async changePassword(@CurrentActor() actor: AuthenticatedActor, @Body() body: ChangePasswordRequest, @Req() req: Request): Promise<ApiResponse<null>> {
    await this.auth.changePassword({ actor, currentPassword: body.currentPassword, newPassword: body.newPassword, accessExp: accessExpOf(req) });
    return ApiResponse.ok(null, 'Đã đổi mật khẩu, vui lòng đăng nhập lại');
  }

  @Put('avatar')
  @RateLimit({ name: 'avatar', limit: 10, windowSeconds: 3600, by: 'user' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Đổi ảnh đại diện (JPG/PNG/WEBP ≤ 5MB)' })
  @ApiOkResponse({ type: UserProfileResponse })
  async avatar(@CurrentActor() actor: AuthenticatedActor, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<UserProfileResponse>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu file ảnh (field `file`)');
    return ApiResponse.ok(await this.users.updateMyAvatar(actor, { buffer: file.buffer, mimetype: file.mimetype, size: file.size }), 'Đã đổi ảnh đại diện');
  }

  @Delete('avatar')
  @RateLimit({ name: 'avatar', limit: 10, windowSeconds: 3600, by: 'user' })
  @ApiOperation({ summary: 'Xoá ảnh đại diện (khôi phục về ảnh chữ cái đầu mặc định)' })
  @ApiOkResponse({ type: UserProfileResponse })
  async deleteAvatar(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<UserProfileResponse>> {
    return ApiResponse.ok(await this.users.deleteMyAvatar(actor), 'Đã khôi phục ảnh đại diện mặc định');
  }

  @Public()
  @Get('avatar/default')
  @ApiOperation({ summary: 'Xem/tải ảnh đại diện SVG mặc định theo chữ cái đầu' })
  defaultAvatar(@Query('name') name: string, @Res() res: Response): void {
    const svg = generateInitialAvatarSvg(name || 'User');
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.status(HttpStatus.OK).send(svg);
  }
}
