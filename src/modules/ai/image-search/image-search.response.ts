import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ProductCardResponse } from '../../product/queryapi/product.queryapi';

/*
 * Kết quả POST /ai/image-search.
 * - available=false: chưa cấu hình khoá OpenAI → FE ẩn tính năng (không phải lỗi).
 * - items rỗng + message: không có sản phẩm giống ảnh (KHÔNG trả sản phẩm nổi bật ngẫu nhiên cho đủ số lượng).
 * - items chỉ gồm sản phẩm có lý do liên quan (cùng LOẠI sản phẩm / cùng ngành vision nhận ra) và có thể ít hơn 12; ít quá hoặc chỉ cùng ngành ⇒ `message` gợi ý.
 */
export class ImageSearchResponse {
  @ApiProperty({ description: 'false khi chưa cấu hình khoá OpenAI — FE ẩn tính năng' }) available: boolean;
  @ApiPropertyOptional({ nullable: true, description: 'Mô tả ngắn ảnh do vision sinh (≤ 500 ký tự)' }) description: string | null;
  @ApiProperty({ type: [String], example: ['áo thun', 'màu trắng'], description: 'Từ khoá vision rút ra từ ảnh: loại sản phẩm trước, màu/chất liệu sau (≤ 6); chỉ loại sản phẩm được dùng để tìm' }) keywords: string[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'Thẻ sản phẩm (cùng dạng ProductCardResponse của GET /products), tối đa 12 (có thể ít hơn — chỉ sản phẩm liên quan), khớp loại sản phẩm trước rồi gợi ý cùng ngành',
  })
  items: ProductCardResponse[];

  @ApiPropertyOptional({ nullable: true, example: 'Không tìm thấy sản phẩm giống ảnh', description: 'Giải thích khi không có kết quả khớp / chỉ có gợi ý theo ngành / rất ít kết quả khớp / vision lỗi' }) message: string | null;
}
