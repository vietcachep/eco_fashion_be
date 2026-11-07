import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductCardResponse } from '../../product/queryapi/product.queryapi';
import { VisualMatchResponse } from './visual-search.dto';

/*
 * Kết quả POST /ai/image-search.
 * - available=false: chưa cấu hình khoá OpenAI → FE ẩn tính năng (không phải lỗi).
 * - items rỗng + message: không có sản phẩm giống ảnh (KHÔNG trả sản phẩm nổi bật ngẫu nhiên cho đủ số lượng).
 * - items chỉ gồm sản phẩm có lý do liên quan (cùng LOẠI sản phẩm / cùng ngành vision nhận ra) và có thể ít hơn 12; ít quá hoặc chỉ cùng ngành ⇒ `message` gợi ý.
 */
export class ImageSearchResponse {
  @ApiPropertyOptional({ enum: ['visual', 'hybrid', 'description', 'unavailable'] }) searchMode?: string;
  @ApiPropertyOptional({ type: [VisualMatchResponse] }) matches?: VisualMatchResponse[];
  @ApiProperty({
    description: 'Có cấu hình encoder ảnh hoặc vision; runtime không sẵn sàng được báo qua message',
  })
  available: boolean;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Mô tả ảnh/vùng tìm kiếm' }) description:
    string | null;
  @ApiProperty({ type: [String], description: 'Loại/thuộc tính và chữ đọc được trên ảnh' })
  keywords: string[];
  @ApiProperty({
    type: [ProductCardResponse],
    description: 'Tối đa12 sản phẩm đã kiểm tra được bán; imageUrl là ảnh khớp truy vấn',
  })
  items: ProductCardResponse[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'No-match hoặc giải thích chế độ dự phòng',
  })
  message: string | null;
}
