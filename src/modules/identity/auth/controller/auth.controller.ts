import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, Public } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { NotFoundException } from '@common/exception/business.exception';
import { IDENTITY_ERR } from '../../foundation/identity.constants';
import { PermissionService } from '../../permission/service/permission.service';
import { CurrentUserResponse, TokenPairResponse } from '../../user/dto/user.responses';
import { toCurrentUser } from '../../user/mapper/user.mapper';
import { UserRepository } from '../../user/repository/user.repository';
import {
  ChangePasswordRequest,
  ForgotPasswordRequest,
  GoogleLoginRequest,
  LoginRequest,
  LogoutRequest,
  RefreshRequest,
  RegisterRequest,
  ResetPasswordRequest,
} from '../request/auth.requests';
import { accessExpOf, AuthService } from '../service/auth.service';

/*
 * /auth — công khai: register, login, refresh, forgot/reset password (đều có hạn mức Redis chống spam/dò);
 * cần token: logout, change-password, me. Controller chỉ map Request → Command và gọi service.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UserRepository,
    private readonly permissions: PermissionService,
  ) {}

  @Public()
  @RateLimit({ name: 'register', limit: 5, windowSeconds: 3600, by: 'ip' })
  @Post('register')
  @ApiOperation({ summary: 'Khách đăng ký tài khoản (đăng nhập luôn sau khi tạo)' })
  @ApiOkResponse({ type: TokenPairResponse })
  async register(@Body() body: RegisterRequest): Promise<ApiResponse<TokenPairResponse>> {
    const r = await this.auth.register({ email: body.email, password: body.password, fullName: body.fullName, phone: body.phone ?? null });
    return ApiResponse.ok(r, 'Đăng ký thành công');
  }

  @Public()
  @RateLimit({ name: 'login', limit: 20, windowSeconds: 600, by: 'ip' })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Đăng nhập (khách lẫn nhân viên)' })
  @ApiOkResponse({ type: TokenPairResponse })
  async login(@Body() body: LoginRequest): Promise<ApiResponse<TokenPairResponse>> {
    const r = await this.auth.login({ email: body.email, password: body.password, deviceName: body.deviceName ?? null });
    return ApiResponse.ok(r, 'Đăng nhập thành công');
  }

  @Public()
  @RateLimit({ name: 'login', limit: 20, windowSeconds: 600, by: 'ip' })
  @HttpCode(HttpStatus.OK)
  @Post('google')
  @ApiOperation({ summary: 'Đăng nhập / đăng ký bằng Google (gửi id_token)' })
  @ApiOkResponse({ type: TokenPairResponse })
  async google(@Body() body: GoogleLoginRequest): Promise<ApiResponse<TokenPairResponse>> {
    return ApiResponse.ok(await this.auth.loginWithGoogle({ idToken: body.idToken }), 'Đăng nhập thành công');
  }

  @Public()
  @RateLimit({ name: 'refresh', limit: 60, windowSeconds: 600, by: 'ip' })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  @ApiOperation({ summary: 'Xoay vòng refresh token → cặp token mới (token cũ bị thu hồi)' })
  @ApiOkResponse({ type: TokenPairResponse })
  async refresh(@Body() body: RefreshRequest): Promise<ApiResponse<TokenPairResponse>> {
    return ApiResponse.ok(await this.auth.refresh({ refreshToken: body.refreshToken }));
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  @ApiOperation({ summary: 'Đăng xuất: thu hồi refresh token + blacklist access token hiện tại' })
  async logout(@CurrentActor() actor: AuthenticatedActor, @Body() body: LogoutRequest, @Req() req: Request): Promise<ApiResponse<null>> {
    await this.auth.logout({ actor, refreshToken: body.refreshToken ?? null, accessExp: accessExpOf(req) });
    return ApiResponse.ok(null, 'Đã đăng xuất');
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('change-password')
  @ApiOperation({ summary: 'Đổi mật khẩu — thu hồi mọi phiên khác' })
  async changePassword(@CurrentActor() actor: AuthenticatedActor, @Body() body: ChangePasswordRequest, @Req() req: Request): Promise<ApiResponse<null>> {
    await this.auth.changePassword({ actor, currentPassword: body.currentPassword, newPassword: body.newPassword, accessExp: accessExpOf(req) });
    return ApiResponse.ok(null, 'Đã đổi mật khẩu, vui lòng đăng nhập lại');
  }

  @Public()
  @RateLimit({ name: 'forgot-password', limit: 5, windowSeconds: 900, by: 'ip' })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  @ApiOperation({ summary: 'Gửi OTP đặt lại mật khẩu qua email (luôn 200)' })
  async forgotPassword(@Body() body: ForgotPasswordRequest): Promise<ApiResponse<null>> {
    await this.auth.forgotPassword({ email: body.email });
    return ApiResponse.ok(null, 'Nếu email tồn tại, mã xác nhận đã được gửi');
  }

  @Public()
  @RateLimit({ name: 'reset-password', limit: 10, windowSeconds: 900, by: 'ip' })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  @ApiOperation({ summary: 'Đặt lại mật khẩu bằng OTP' })
  async resetPassword(@Body() body: ResetPasswordRequest): Promise<ApiResponse<null>> {
    await this.auth.resetPassword({ email: body.email, otp: body.otp, newPassword: body.newPassword });
    return ApiResponse.ok(null, 'Đã đặt lại mật khẩu, vui lòng đăng nhập');
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Hồ sơ người đang đăng nhập + mã quyền hiệu lực' })
  @ApiOkResponse({ type: CurrentUserResponse })
  async me(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<CurrentUserResponse>> {
    const profile = await this.users.findProfile(actor.userId);
    if (!profile) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    const perms = await this.permissions.effectivePermissions(actor.userId);
    return ApiResponse.ok(toCurrentUser(profile, perms));
  }
}
