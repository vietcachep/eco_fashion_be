import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AttributeValueResponse {
  @ApiProperty({ example: 'den' }) code: string;
  @ApiProperty({ example: 'Đen' }) name: string;
  @ApiPropertyOptional({ nullable: true, example: '#1c1c1c' }) hex: string | null;
  @ApiPropertyOptional({ nullable: true, example: 'ao', description: 'Nhóm size: ao | quan' }) groupCode: string | null;
  @ApiProperty() sortOrder: number;
  @ApiProperty() isActive: boolean;
}

export class AttributeResponse {
  @ApiProperty({ example: 'color' }) code: string;
  @ApiProperty({ example: 'Màu sắc' }) name: string;
  @ApiProperty({ example: 'color', description: 'color | size | text' }) kind: string;
  @ApiProperty() isFilterable: boolean;
  @ApiProperty({ type: [AttributeValueResponse] }) values: AttributeValueResponse[];
}
