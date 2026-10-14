import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AttributeValueDetail {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Đỏ' }) value: string;
  @ApiPropertyOptional({ nullable: true, example: { hex: '#ff0000' } }) extra: Record<string, unknown> | null;
  @ApiProperty() sortOrder: number;
}

export class AttributeDetail {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'color2' }) code: string;
  @ApiProperty({ example: 'Màu sắc' }) name: string;
  @ApiProperty({ example: 'select', enum: ['select', 'text', 'number'] }) inputType: string;
  @ApiProperty({ type: [AttributeValueDetail] }) values: AttributeValueDetail[];
}

export class CategoryAttributeDetail {
  @ApiProperty() id: string;
  @ApiProperty() attributeId: string;
  @ApiProperty({ type: AttributeDetail }) attribute: AttributeDetail;
  @ApiProperty() required: boolean;
  @ApiProperty() isVariantAxis: boolean;
  @ApiProperty() sortOrder: number;
}

export class CategoryAttributeTemplate {
  @ApiProperty({ type: [CategoryAttributeDetail] }) attributes: CategoryAttributeDetail[];
}
