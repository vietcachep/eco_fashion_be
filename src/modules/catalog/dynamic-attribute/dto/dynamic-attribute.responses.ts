import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DynamicAttributeValueResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Đỏ' }) value: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true, example: { hex: '#ff0000' } }) extra: Record<string, unknown> | null;
  @ApiProperty() sortOrder: number;
}

export class DynamicAttributeResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'color2' }) code: string;
  @ApiProperty({ example: 'Màu sắc' }) name: string;
  @ApiProperty({ example: 'select', enum: ['select', 'text', 'number'] }) inputType: string;
  @ApiProperty({ type: [DynamicAttributeValueResponse] }) values: DynamicAttributeValueResponse[];
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}
