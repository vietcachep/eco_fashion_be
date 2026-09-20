import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PermissionResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'order.order.read' }) code: string;
  @ApiProperty({ example: 'order' }) moduleCode: string;
  @ApiProperty() description: string;
  @ApiProperty() isActive: boolean;
}

export class RoleResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'sales' }) code: string;
  @ApiProperty({ example: 'Bán hàng & CSKH' }) name: string;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty({ description: 'Vai hệ thống — không xoá được' }) isSystem: boolean;
  @ApiProperty({ type: [String] }) permissionCodes: string[];
}

export class UserPermissionOverrideResponse {
  @ApiProperty({ example: 'order.order.cancel' }) code: string;
  @ApiProperty({ description: 'true = cấp thêm, false = chặn (deny thắng vai)' }) allowed: boolean;
  @ApiPropertyOptional({ nullable: true }) reason: string | null;
}
