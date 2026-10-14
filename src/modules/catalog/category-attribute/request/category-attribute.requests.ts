import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';

export class SetCategoryAttributeTemplateItemRequest {
  @ApiProperty()
  @IsUUID()
  attributeId: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isVariantAxis?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class SetCategoryAttributeTemplateRequest {
  @ApiProperty({ type: [SetCategoryAttributeTemplateItemRequest], description: 'Mảng thuộc tính cho category — tối đa 2 dòng isVariantAxis=true' })
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SetCategoryAttributeTemplateItemRequest)
  attributes: SetCategoryAttributeTemplateItemRequest[];
}
