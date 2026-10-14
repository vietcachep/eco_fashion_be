import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/* Ngành hàng cho web bán hàng (FE `CategoryResponse`). parentId public để FE dựng mega menu theo NHÓM NGÀNH
   HÀNG (PLAN-0016: sàn đa ngành hàng) thay vì liệt kê phẳng — không lộ gì nhạy cảm, chỉ là cấu trúc cây.
   attributeMode public để FE ẩn bộ lọc Màu/Size (chỉ đúng cho legacy_fashion) khi khách đang xem ngành hàng
   dynamic (điện thoại, đồ gia dụng…). */
export class CategoryResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'ao-thun' }) slug: string;
  @ApiProperty({ example: 'Áo thun' }) name: string;
  @ApiPropertyOptional({ nullable: true }) imageUrl: string | null;
  @ApiProperty({ example: 6 }) productCount: number;
  @ApiPropertyOptional({ nullable: true }) parentId: string | null;
  @ApiProperty({ example: 'legacy_fashion' }) attributeMode: string;
}

/* Ngành hàng cho khu quản trị — thêm trạng thái, thứ tự. */
export class CategoryAdminResponse extends CategoryResponse {
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty() sortOrder: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}
