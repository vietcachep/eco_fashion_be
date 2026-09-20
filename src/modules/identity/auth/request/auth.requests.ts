import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NormalizeEmail } from '@common/utils/transform';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

/* Mật khẩu: 8–64 ký tự, có chữ và số (đủ cho đề tài; không bắt ký tự đặc biệt để khách không bỏ cuộc). */
export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/;
export const PASSWORD_MSG = 'Mật khẩu 8–64 ký tự, gồm cả chữ và số';
export const PHONE_VN = /^(0|\+84)(\d{9,10})$/;

export class RegisterRequest {
  @ApiProperty({ example: 'khach@ecofashion.vn' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @NormalizeEmail()
  email: string;

  @ApiProperty({ example: 'MatKhau123' })
  @IsString()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  password: string;

  @ApiProperty({ example: 'Nguyễn Văn An' })
  @IsString()
  @Length(2, 120, { message: 'Họ tên 2–120 ký tự' })
  fullName: string;

  @ApiPropertyOptional({ example: '0901234567' })
  @IsOptional()
  @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' })
  phone?: string;
}

export class GoogleLoginRequest {
  @ApiProperty({ description: 'id_token từ Google Identity Services (không phải access token)' })
  @IsString()
  @Length(20, 4096)
  idToken: string;
}

export class LoginRequest {
  @ApiProperty({ example: 'admin@ecofashion.vn' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @NormalizeEmail()
  email: string;

  @ApiProperty({ example: 'Admin123456!' })
  @IsString()
  @Length(1, 128)
  password: string;

  @ApiPropertyOptional({ example: 'Chrome trên Windows' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;
}

export class RefreshRequest {
  @ApiProperty()
  @IsString()
  @Length(20, 200)
  refreshToken: string;
}

export class LogoutRequest {
  @ApiPropertyOptional({ description: 'Refresh token đang giữ — thu hồi cả họ token của phiên này' })
  @IsOptional()
  @IsString()
  @Length(20, 200)
  refreshToken?: string;
}

export class ChangePasswordRequest {
  @ApiProperty()
  @IsString()
  @Length(1, 128)
  currentPassword: string;

  @ApiProperty()
  @IsString()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  newPassword: string;
}

export class ForgotPasswordRequest {
  @ApiProperty({ example: 'khach@ecofashion.vn' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @NormalizeEmail()
  email: string;
}

export class ResetPasswordRequest {
  @ApiProperty({ example: 'khach@ecofashion.vn' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @NormalizeEmail()
  email: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Mã xác nhận gồm 6 chữ số' })
  otp: string;

  @ApiProperty()
  @IsString()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  newPassword: string;
}
