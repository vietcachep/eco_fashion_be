import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ATTRIBUTE_MODES, DYNAMIC_INPUT_TYPES } from '../../foundation/catalog.constants';

/* Ngành LÁ đang bật mà vendor được gán sản phẩm vào (chỉ ngành lá nhận sản phẩm — PLAN-0016). */
export class ShopLeafCategoryResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'dien-thoai' }) slug: string;
  @ApiProperty({ example: 'Điện thoại' }) name: string;
  @ApiPropertyOptional({ nullable: true, example: 'Điện tử', description: 'Tên ngành cha trực tiếp; null nếu là ngành gốc' }) parentName: string | null;
  @ApiProperty({ example: 'Điện tử › Điện thoại', description: 'Đường dẫn đầy đủ từ ngành gốc — để vendor phân biệt ngành lá trùng tên' }) path: string;
  @ApiProperty({ enum: ATTRIBUTE_MODES, example: 'dynamic', description: 'legacy_fashion = form thời trang cũ (gender/màu/size); dynamic = dựng form theo attribute-template' }) attributeMode: string;
}

export class ShopTemplateValueResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: '128GB' }) value: string;
  @ApiPropertyOptional({ nullable: true, example: '#1c1c1c', description: 'Mã màu nếu thuộc tính là màu (extra.hex), ngược lại null' }) hex: string | null;
}

export class ShopTemplateAttributeResponse {
  @ApiProperty() attributeId: string;
  @ApiProperty({ example: 'color2' }) code: string;
  @ApiProperty({ example: 'Màu sắc' }) name: string;
  @ApiProperty({ enum: DYNAMIC_INPUT_TYPES, example: 'select', description: 'select = chọn từ values; text | number = nhập tay' }) inputType: string;
  @ApiProperty({ description: 'Bắt buộc phải có khi đăng bán' }) required: boolean;
  @ApiProperty({ description: 'true = trục biến thể (mỗi biến thể chọn đúng một giá trị); false = thuộc tính cấp sản phẩm' }) isVariantAxis: boolean;
  @ApiProperty() sortOrder: number;
  @ApiProperty({ type: [ShopTemplateValueResponse], description: 'Chỉ có với inputType=select (rỗng với text/number)' }) values: ShopTemplateValueResponse[];
}

/* Mẫu thuộc tính của một ngành — vendor dựng form sản phẩm/biến thể từ đây. Ngành legacy_fashion trả attributes rỗng. */
export class ShopCategoryTemplateResponse {
  @ApiProperty() categoryId: string;
  @ApiProperty({ example: 'dien-thoai' }) slug: string;
  @ApiProperty({ example: 'Điện thoại' }) name: string;
  @ApiProperty({ enum: ATTRIBUTE_MODES, example: 'dynamic' }) attributeMode: string;
  @ApiProperty({ type: [ShopTemplateAttributeResponse] }) attributes: ShopTemplateAttributeResponse[];
}
