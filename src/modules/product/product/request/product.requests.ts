import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
  @ApiPropertyOptional({ example: 'techzone', description: 'Slug gian hàng — chỉ hàng của shop đó (shop chưa duyệt/đã khoá ⇒ danh sách rỗng)' }) @IsOptional() @Matches(SLUG) @MaxLength(160) shop?: string;
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

export class VariantOptionInput {
  @ApiProperty() @IsUUID() attributeId: string;
  @ApiProperty() @IsUUID() attributeValueId: string;
}

export class VariantInput {
  @ApiPropertyOptional({ example: 'den', description: 'Bắt buộc cho category legacy_fashion; null cho dynamic' }) @IsOptional() @Matches(CODE) @MaxLength(40) colorCode?: string;
  @ApiPropertyOptional({ example: 'M', description: 'Bắt buộc cho category legacy_fashion; null cho dynamic' }) @IsOptional() @IsString() @Length(1, 40) sizeCode?: string;
  @ApiPropertyOptional({ type: [VariantOptionInput], description: 'Bắt buộc cho category dynamic (tối đa 2); null cho legacy' }) @IsOptional() @IsArray() @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => VariantOptionInput) options?: VariantOptionInput[];
  @ApiPropertyOptional({ example: 'AOTHUN-DE-M', description: 'Mã SKU, unique TRONG gian hàng (hai shop được trùng). Tự chuẩn hoá IN HOA. Bỏ trống → biến thể đã có giữ SKU cũ; biến thể mới sinh từ slug + màu + size (legacy) hoặc slug + giá trị các trục (dynamic), trùng thì thêm hậu tố -2, -3…' }) @IsOptional() @Matches(/^[A-Z0-9-]+$/i) @MaxLength(64) sku?: string;
  @ApiPropertyOptional({ nullable: true, description: 'Giá riêng (VND, phải > 0); bỏ trống/null = theo giá sản phẩm' }) @IsOptional() @IsNumberString() price?: string | null;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isActive?: boolean;
}

/* Giá trị thuộc tính cấp sản phẩm (không tạo biến thể). Mỗi dòng đúng MỘT trong hai: attributeValueId (thuộc tính kiểu select,
   giá trị phải thuộc đúng thuộc tính) HOẶC customValue (kiểu text/number nhập tay; number phải là số hợp lệ). */
export class AttributeValueInput {
  @ApiProperty({ description: 'Thuộc tính thuộc mẫu của ngành hàng, KHÔNG phải trục biến thể; không được lặp trong danh sách' }) @IsUUID() attributeId: string;
  @ApiPropertyOptional({ description: 'Giá trị có sẵn (thuộc tính kiểu select) — phải thuộc đúng attributeId' }) @IsOptional() @IsUUID() attributeValueId?: string;
  @ApiPropertyOptional({ description: 'Giá trị nhập tay (thuộc tính kiểu text/number), không rỗng' }) @IsOptional() @IsString() @MaxLength(255) customValue?: string;
}

export class CreateProductRequest {
  @ApiProperty({ example: 'Áo thun cotton nam basic' }) @IsString() @Length(3, 200) name: string;
  @ApiPropertyOptional({ example: 'ao-thun-cotton-nam-basic' }) @IsOptional() @Matches(SLUG) @MaxLength(160) slug?: string;
  @ApiProperty() @IsUUID() categoryId: string;
  @ApiPropertyOptional({ enum: GENDERS, description: 'Bắt buộc cho category legacy_fashion; null cho dynamic' }) @IsOptional() @IsIn(GENDERS as readonly string[]) gender?: string;
  @ApiProperty({ example: '159000', description: 'VND' }) @IsNumberString() basePrice: string;
  @ApiPropertyOptional({ example: '199000', nullable: true }) @IsOptional() @IsNumberString() listPrice?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @ApiPropertyOptional({ example: '100% cotton', description: 'Bắt buộc cho category legacy_fashion; null cho dynamic' }) @IsOptional() @IsString() @MaxLength(200) material?: string;
  @ApiPropertyOptional({ type: [String], description: 'Bắt buộc cho category legacy_fashion; null cho dynamic' }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(120, { each: true }) care?: string[];
  @ApiPropertyOptional({ type: [String], example: ['new'] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(/^[a-z0-9-]+$/, { each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isNew?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional({ type: [VariantInput], description: 'Có thể tạo kèm biến thể (giá riêng nếu có phải > 0)' }) @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => VariantInput) variants?: VariantInput[];
  @ApiPropertyOptional({ type: [AttributeValueInput], description: 'Thuộc tính cấp sản phẩm (ngành dynamic): đúng mẫu của ngành, không lặp, đúng kiểu. Các thuộc tính required=true có thể bổ sung sau nhưng PHẢI đủ trước khi đăng bán. Sửa về sau qua PUT …/attributes' }) @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AttributeValueInput) attributeValues?: AttributeValueInput[];
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
  @ApiPropertyOptional({ nullable: true, description: 'Bắt buộc cho category legacy_fashion' }) @IsOptional() @IsString() @MaxLength(200) material?: string | null;
  @ApiPropertyOptional({ type: [String], description: 'Bắt buộc cho category legacy_fashion' }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) care?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(/^[a-z0-9-]+$/, { each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isNew?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
}

/*
 * Vendor (/shop/products) KHÔNG được tự đặt nhãn/ưu tiên hiển thị của sàn: isFeatured (nổi bật), isNew (nhãn "Mới") và tags
 * (bộ sưu tập dùng tag để gom sản phẩm) do nhân viên sàn quyết định. Tách class riêng — ValidationPipe whitelist sẽ bỏ các key này
 * nếu vendor gửi lên — thay vì dùng chung request với /admin/products.
 */
export class CreateShopProductRequest extends OmitType(CreateProductRequest, ['isNew', 'isFeatured', 'tags'] as const) {}

export class UpdateShopProductRequest extends OmitType(UpdateProductRequest, ['isNew', 'isFeatured', 'tags'] as const) {}

export class SaveVariantsRequest {
  @ApiProperty({
    type: [VariantInput],
    description:
      'Thay TOÀN BỘ danh sách biến thể. Biến thể khớp theo tổ hợp trục (ngành dynamic: attributeId+attributeValueId) hoặc màu×size (thời trang) được CẬP NHẬT tại chỗ — giữ nguyên id, tồn kho, hàng đang giữ. ' +
      'Tổ hợp mới = biến thể mới (tồn 0). Biến thể thiếu trong danh sách = xoá mềm, nhưng 409 PRODUCT_VARIANT_IN_USE nếu đang giữ hàng cho đơn hoặc nằm trong phiếu nhập nháp. Giá riêng (nếu có) phải > 0.',
  })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => VariantInput)
  variants: VariantInput[];
}

/* Thay toàn bộ thuộc tính cấp sản phẩm (ngành dynamic). Danh sách rỗng = xoá hết (không được nếu sản phẩm đang bán mà ngành có thuộc tính bắt buộc). */
export class SaveAttributesRequest {
  @ApiProperty({ type: [AttributeValueInput], description: 'Thay TOÀN BỘ giá trị thuộc tính cấp sản phẩm; kiểm theo mẫu thuộc tính của ngành hàng (không ngoài mẫu, không lặp, đúng kiểu select/text/number)' })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AttributeValueInput)
  attributeValues: AttributeValueInput[];
}

export class ReorderImagesRequest {
  @ApiProperty({ type: [String], description: 'Id ảnh theo thứ tự mới (không trùng, đúng và đủ mọi ảnh); ảnh đầu = ảnh chính' }) @IsArray() @ArrayMaxSize(12) @ArrayUnique() @IsUUID('4', { each: true }) imageIds: string[];
}

export class UpdateImageRequest {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(CODE) @MaxLength(40) colorCode?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(200) alt?: string | null;
  @ApiPropertyOptional({ description: 'true = đặt làm ảnh chính (ảnh chính cũ tự bỏ cờ). false trên ảnh chính hiện tại bị từ chối — chọn ảnh khác làm chính' }) @IsOptional() @IsBoolean() isPrimary?: boolean;
}
