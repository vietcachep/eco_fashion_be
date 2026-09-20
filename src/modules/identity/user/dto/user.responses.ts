import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/* Hồ sơ người dùng trả ra API — KHÔNG có password_hash, permission_version. */
export class UserProfileResponse {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiProperty() fullName: string;
  @ApiPropertyOptional({ nullable: true }) avatarUrl: string | null;
  @ApiProperty({ example: 'customer' }) roleCode: string;
  @ApiProperty({ example: 'Khách hàng' }) roleName: string;
  @ApiProperty({ example: 'active' }) status: string;
  @ApiPropertyOptional({ nullable: true }) lockedReason: string | null;
  @ApiPropertyOptional({ nullable: true }) emailVerifiedAt: string | null;
  @ApiPropertyOptional({ nullable: true }) lastLoginAt: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

/* Hồ sơ của CHÍNH người đăng nhập + mã quyền hiệu lực (FE ẩn/hiện menu, nút). */
export class CurrentUserResponse extends UserProfileResponse {
  @ApiProperty({ type: [String], example: ['order.order.read'] })
  permissionCodes: string[];
}

export class AuthUserResponse {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() fullName: string;
  @ApiProperty() roleCode: string;
  @ApiProperty({ example: 'active' }) status: string;
  @ApiPropertyOptional({ nullable: true }) avatarUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiProperty() createdAt: string;
}

export class TokenPairResponse {
  @ApiProperty() accessToken: string;
  @ApiProperty() refreshToken: string;
  @ApiProperty({ example: 900 }) accessExpiresIn: number;
  @ApiProperty({ example: 'bearer' }) tokenType: string;
  @ApiProperty({ type: AuthUserResponse }) user: AuthUserResponse;
}
