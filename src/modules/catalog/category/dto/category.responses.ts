import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/* Ngành hàng cho web bán hàng (FE `CategoryResponse`). */
export class CategoryResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'ao-thun' }) slug: string;
  @ApiProperty({ example: 'Áo thun' }) name: string;
  @ApiPropertyOptional({ nullable: true }) imageUrl: string | null;
  @ApiProperty({ example: 6 }) productCount: number;
}

/* Ngành hàng cho khu quản trị — thêm trạng thái, thứ tự, cha. */
export class CategoryAdminResponse extends CategoryResponse {
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiPropertyOptional({ nullable: true }) parentId: string | null;
  @ApiProperty() sortOrder: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}
