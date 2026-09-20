import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

const PERMISSION_CODE = /^[a-z]+(\.[a-z_]+){2,3}$/;

export class ReplaceRolePermissionsRequest {
  @ApiProperty({ type: [String], example: ['order.order.read', 'order.order.status.update'] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Matches(PERMISSION_CODE, { each: true, message: 'Mã quyền dạng module.resource.action' })
  permissionCodes: string[];
}

export class UserPermissionOverrideItem {
  @ApiProperty({ example: 'order.order.cancel' })
  @IsString()
  @Matches(PERMISSION_CODE, { message: 'Mã quyền dạng module.resource.action' })
  code: string;

  @ApiPropertyOptional({ nullable: true, description: 'true = cấp, false = chặn, null = gỡ override (về theo vai)' })
  @IsOptional()
  @IsBoolean()
  allowed: boolean | null;

  @ApiPropertyOptional({ example: 'Nhân viên mới, chưa cho huỷ đơn' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class SaveUserPermissionsRequest {
  @ApiProperty({ type: [UserPermissionOverrideItem] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => UserPermissionOverrideItem)
  overrides: UserPermissionOverrideItem[];
}
