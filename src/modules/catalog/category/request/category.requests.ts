import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min } from 'class-validator';
import { ATTRIBUTE_MODES } from '../../foundation/catalog.constants';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateCategoryRequest {
  @ApiProperty({ example: 'Áo thun' }) @IsString() @Length(2, 120) name: string;
  @ApiPropertyOptional({ example: 'ao-thun', description: 'Bỏ trống → sinh từ tên' }) @IsOptional() @Matches(SLUG, { message: 'Slug chỉ gồm a-z, 0-9 và dấu gạch' }) @MaxLength(120) slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() parentId?: string | null;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ enum: ATTRIBUTE_MODES, default: 'dynamic', description: 'dynamic = ngành mới dùng bộ thuộc tính riêng (CategoryAttribute); legacy_fashion = thời trang dùng gender/màu/size như cũ. Bỏ trống → dynamic' }) @IsOptional() @IsIn(ATTRIBUTE_MODES) attributeMode?: string;
}

export class UpdateCategoryRequest {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(SLUG, { message: 'Slug chỉ gồm a-z, 0-9 và dấu gạch' }) @MaxLength(120) slug?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() parentId?: string | null;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ enum: ATTRIBUTE_MODES, description: 'Đổi chế độ thuộc tính — chỉ khi ngành CHƯA có sản phẩm, nếu không 409 CATALOG_CATEGORY_MODE_LOCKED' }) @IsOptional() @IsIn(ATTRIBUTE_MODES) attributeMode?: string;
}
