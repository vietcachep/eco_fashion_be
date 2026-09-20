import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ToBoolean } from '@common/utils/transform';
import { GENDERS } from '../../../catalog/enums/gender';
import { PRODUCT_SORTS, PRODUCT_STATUS } from '../../foundation/product.constants';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

/*
 * Bộ lọc danh sách — tên tham số trùng URL của FE (`?category=&gender=&size=&color=&minPrice=&maxPrice=&sale=&sort=&page=`).
 * `size` là SIZE QUẦN ÁO (M, 30…) nên cỡ trang đặt tên `pageSize` (FE cố định 12) — không extends PageQuery.
 */
export class ProductListQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 48 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(48) pageSize: number = 12;
  @ApiPropertyOptional({ description: 'Từ khoá (không dấu cũng được)' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ example: 'ao-thun' }) @IsOptional() @Matches(SLUG) @MaxLength(120) category?: string;
  @ApiPropertyOptional({ enum: GENDERS }) @IsOptional() @IsIn(GENDERS as readonly string[]) gender?: string;
  @ApiPropertyOptional({ example: 'M' }) @IsOptional() @IsString() @MaxLength(40) size?: string;
  @ApiPropertyOptional({ example: 'den' }) @IsOptional() @IsString() @MaxLength(40) color?: string;
  @ApiPropertyOptional({ example: 100000 }) @IsOptional() @IsNumberString() minPrice?: string;
  @ApiPropertyOptional({ example: 500000 }) @IsOptional() @IsNumberString() maxPrice?: string;
  @ApiPropertyOptional({ description: 'true = chỉ hàng đang giảm giá' }) @IsOptional() @ToBoolean() @IsBoolean() sale?: boolean;
  @ApiPropertyOptional({ example: 'new', description: 'Tag (bộ sưu tập dùng)' }) @IsOptional() @Matches(/^[a-z0-9-]+$/) @MaxLength(40) tag?: string;
  @ApiPropertyOptional({ enum: PRODUCT_SORTS, default: 'featured' }) @IsOptional() @IsIn(PRODUCT_SORTS as readonly string[]) sort?: string;
}

export class AdminProductListQuery extends ProductListQuery {
  @ApiPropertyOptional({ enum: Object.values(PRODUCT_STATUS) }) @IsOptional() @IsIn(Object.values(PRODUCT_STATUS)) status?: string;
}

export class ProductIdsQuery {
  @ApiProperty({ description: 'Danh sách id cách nhau bằng dấu phẩy (≤ 50)', example: 'uuid1,uuid2' })
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value))
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  ids: string[];
}

export class SuggestQuery {
  @ApiProperty({ example: 'áo thun' }) @IsString() @Length(1, 100) q: string;
  @ApiPropertyOptional({ default: 8 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}

export class VariantInput {
  @ApiProperty({ example: 'den' }) @Matches(CODE) @MaxLength(40) colorCode: string;
  @ApiProperty({ example: 'M' }) @IsString() @Length(1, 40) sizeCode: string;
  @ApiPropertyOptional({ example: 'AOTHUN-DE-M', description: 'Bỏ trống → sinh từ slug + màu + size' }) @IsOptional() @Matches(/^[A-Z0-9-]+$/i) @MaxLength(64) sku?: string;
  @ApiPropertyOptional({ nullable: true, description: 'Giá riêng (VND); null = theo giá sản phẩm' }) @IsOptional() @IsNumberString() price?: string | null;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateProductRequest {
  @ApiProperty({ example: 'Áo thun cotton nam basic' }) @IsString() @Length(3, 200) name: string;
  @ApiPropertyOptional({ example: 'ao-thun-cotton-nam-basic' }) @IsOptional() @Matches(SLUG) @MaxLength(160) slug?: string;
  @ApiProperty() @IsUUID() categoryId: string;
  @ApiProperty({ enum: GENDERS, example: 'nam' }) @IsIn(GENDERS as readonly string[]) gender: string;
  @ApiProperty({ example: '159000', description: 'VND' }) @IsNumberString() basePrice: string;
  @ApiPropertyOptional({ example: '199000', nullable: true }) @IsOptional() @IsNumberString() listPrice?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @ApiPropertyOptional({ example: '100% cotton' }) @IsOptional() @IsString() @MaxLength(200) material?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(120, { each: true }) care?: string[];
  @ApiPropertyOptional({ type: [String], example: ['new'] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(/^[a-z0-9-]+$/, { each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isNew?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional({ type: [VariantInput], description: 'Có thể tạo kèm biến thể' }) @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => VariantInput) variants?: VariantInput[];
}

export class UpdateProductRequest {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(3, 200) name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(SLUG) @MaxLength(160) slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ enum: GENDERS }) @IsOptional() @IsIn(GENDERS as readonly string[]) gender?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() basePrice?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumberString() listPrice?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(500) shortDescription?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(20000) description?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(200) material?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) care?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(/^[a-z0-9-]+$/, { each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isNew?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
}

export class SaveVariantsRequest {
  @ApiProperty({ type: [VariantInput], description: 'Thay TOÀN BỘ danh sách biến thể (thiếu = xoá mềm; tồn kho biến thể cũ giữ nguyên)' })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => VariantInput)
  variants: VariantInput[];
}

export class ReorderImagesRequest {
  @ApiProperty({ type: [String], description: 'Id ảnh theo thứ tự mới; ảnh đầu = ảnh chính' }) @IsArray() @ArrayMaxSize(12) @IsUUID('4', { each: true }) imageIds: string[];
}

export class UpdateImageRequest {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(CODE) @MaxLength(40) colorCode?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(200) alt?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
}
