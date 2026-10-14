import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/* Trang gian hàng công khai (web bán hàng). Chỉ trường an toàn: không có hoa hồng, ngân hàng, chủ sở hữu, trạng thái nội bộ. */
export class ShopStorefrontResponse {
  @ApiProperty({ example: 'techzone' }) slug: string;
  @ApiProperty({ example: 'TechZone Việt Nam' }) name: string;
  @ApiPropertyOptional({ nullable: true }) logoUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) bannerUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiPropertyOptional({ nullable: true, example: 4.7, description: 'Điểm đánh giá trung bình của shop (null = chưa có đánh giá)' }) ratingAvg: number | null;
  @ApiProperty({ example: 128, description: 'Tổng lượt đánh giá của các sản phẩm đang bán' }) reviewCount: number;
  @ApiProperty({ example: 56, description: 'Số sản phẩm đang bán' }) productCount: number;
}
