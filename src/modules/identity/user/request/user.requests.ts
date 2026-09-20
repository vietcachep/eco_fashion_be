import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NormalizeEmail, ToBoolean } from '@common/utils/transform';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { PASSWORD_MSG, PASSWORD_RULE, PHONE_VN } from '../../auth/request/auth.requests';
import { STAFF_ROLE_CODES } from '../../permission/catalog';
import { USER_STATUS } from '../enums/user-status';

export class UpdateProfileRequest {
  @ApiPropertyOptional({ example: 'Nguyễn Văn An' })
  @IsOptional()
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional({ example: '0901234567', nullable: true })
  @IsOptional()
  @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' })
  phone?: string | null;
}

export class ListUsersQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Tìm theo email / họ tên / SĐT' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ example: 'sales' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  roleCode?: string;

  @ApiPropertyOptional({ enum: Object.values(USER_STATUS) })
  @IsOptional()
  @IsIn(Object.values(USER_STATUS))
  status?: string;

  @ApiPropertyOptional({ description: 'true = chỉ nhân viên (không phải customer)' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  staffOnly?: boolean;
}

export class CreateStaffRequest {
  @ApiProperty({ example: 'sales2@ecofashion.vn' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @NormalizeEmail()
  email: string;

  @ApiProperty({ example: 'Trần Thị Bán Hàng' })
  @IsString()
  @Length(2, 120)
  fullName: string;

  @ApiProperty({ enum: STAFF_ROLE_CODES, example: 'sales' })
  @IsIn(STAFF_ROLE_CODES as readonly string[], { message: 'Vai không hợp lệ' })
  roleCode: string;

  @ApiProperty({ description: 'Mật khẩu ban đầu — nhân viên nên đổi sau lần đăng nhập đầu' })
  @IsString()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  password: string;

  @ApiPropertyOptional({ example: '0901234567' })
  @IsOptional()
  @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' })
  phone?: string;
}

export class UpdateUserByAdminRequest {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' })
  phone?: string | null;

  @ApiPropertyOptional({ enum: STAFF_ROLE_CODES, description: 'Đổi vai (chỉ vai nhân viên)' })
  @IsOptional()
  @IsIn(STAFF_ROLE_CODES as readonly string[], { message: 'Vai không hợp lệ' })
  roleCode?: string;
}

export class SetUserStatusRequest {
  @ApiProperty({ enum: [USER_STATUS.ACTIVE, USER_STATUS.LOCKED] })
  @IsIn([USER_STATUS.ACTIVE, USER_STATUS.LOCKED])
  status: 'active' | 'locked';

  @ApiPropertyOptional({ example: 'Nghỉ việc' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class AdminResetPasswordRequest {
  @ApiProperty()
  @IsString()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  newPassword: string;
}
