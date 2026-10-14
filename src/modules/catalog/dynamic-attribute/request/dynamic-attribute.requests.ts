import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Length, Min } from 'class-validator';
import { DYNAMIC_INPUT_TYPES } from '../../foundation/catalog.constants';

export class CreateDynamicAttributeRequest {
  @ApiProperty({ example: 'color2' })
  @IsString()
  @Length(2, 60)
  code: string;

  @ApiProperty({ example: 'Màu sắc' })
  @IsString()
  @Length(2, 100)
  name: string;

  @ApiPropertyOptional({ default: 'select', enum: DYNAMIC_INPUT_TYPES, description: 'select = chọn từ giá trị có sẵn (làm được trục biến thể); text | number = nhập tay' })
  @IsOptional()
  @IsIn(DYNAMIC_INPUT_TYPES)
  inputType?: string;
}

export class CreateDynamicAttributeValueRequest {
  @ApiProperty({ example: 'Đỏ' })
  @IsString()
  @Length(1, 100)
  value: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true, example: { hex: '#ff0000' }, description: 'Dữ liệu phụ của giá trị (vd màu: {hex}); null = xoá' })
  @IsOptional()
  @IsObject()
  extra?: Record<string, unknown> | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateDynamicAttributeValueRequest {
  @ApiPropertyOptional({ example: 'Xanh' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  value?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true, example: { hex: '#0000ff' }, description: 'Dữ liệu phụ của giá trị (vd màu: {hex}); null = xoá' })
  @IsOptional()
  @IsObject()
  extra?: Record<string, unknown> | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
