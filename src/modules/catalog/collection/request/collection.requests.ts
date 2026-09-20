import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, MaxLength, Min } from 'class-validator';
import { GENDERS } from '../../foundation/catalog.constants';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateCollectionRequest {
  @ApiProperty({ example: 'Hàng mới về' }) @IsString() @Length(2, 120) name: string;
  @ApiPropertyOptional({ example: 'hang-moi' }) @IsOptional() @Matches(SLUG) @MaxLength(120) slug?: string;
  @ApiPropertyOptional({ example: 'Bộ sưu tập mùa này' }) @IsOptional() @IsString() @MaxLength(200) tagline?: string;
  @ApiPropertyOptional({ example: 'dam', description: 'Lọc theo slug ngành hàng' }) @IsOptional() @Matches(SLUG) @MaxLength(120) queryCategorySlug?: string;
  @ApiPropertyOptional({ enum: GENDERS }) @IsOptional() @IsIn(GENDERS as readonly string[]) queryGender?: string;
  @ApiPropertyOptional({ example: 'new', description: 'Tag sản phẩm (new, sale…)' }) @IsOptional() @Matches(/^[a-z0-9-]+$/) @MaxLength(40) queryTag?: string;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateCollectionRequest {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(SLUG) @MaxLength(120) slug?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(200) tagline?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(SLUG) @MaxLength(120) queryCategorySlug?: string | null;
  @ApiPropertyOptional({ nullable: true, enum: GENDERS }) @IsOptional() @IsIn(GENDERS as readonly string[]) queryGender?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(/^[a-z0-9-]+$/) @MaxLength(40) queryTag?: string | null;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
