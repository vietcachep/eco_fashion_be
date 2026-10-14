import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyResponse } from '@common/response/money-response';

export class ColorOptionResponse {
  @ApiProperty({ example: 'den' }) code: string;
  @ApiProperty({ example: 'Đen' }) name: string;
  @ApiPropertyOptional({ nullable: true, example: '#1c1c1c' }) hex: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Ảnh của màu này — thẻ đổi ảnh khi rê chấm màu' }) imageUrl: string | null;
}

/* Gian hàng bán sản phẩm — tóm tắt gắn kèm thẻ/chi tiết sản phẩm (PLAN-0014). Khớp `ShopSummary` FE đã
   thiết kế sẵn từ trước khi module shop merge (đọc field CHÍNH XÁC tên này, không phải shopId/shopSlug rời). */
export class ProductShopSummaryResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'fitly-official' }) slug: string;
  @ApiProperty({ example: 'FITLY Official' }) name: string;
  @ApiPropertyOptional({ nullable: true }) logoUrl: string | null;
  @ApiPropertyOptional({ nullable: true, example: 4.7 }) ratingAvg: number | null;
}

/* Thẻ sản phẩm cho list/trang chủ/gợi ý (FE `ProductCardResponse`). */
export class ProductCardResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'ao-thun-cotton-nam-basic' }) slug: string;
  @ApiProperty({ example: 'Áo thun cotton nam basic' }) name: string;
  @ApiProperty({ example: 'ao-thun' }) categorySlug: string;
  /* PLAN-0014 bước 5+ — gian hàng sở hữu sản phẩm này. null CHỈ khi shop bị xoá dữ liệu (không nên xảy ra). */
  @ApiPropertyOptional({ type: ProductShopSummaryResponse, nullable: true }) shop: ProductShopSummaryResponse | null;
  @ApiProperty({ example: 'nam', description: 'nam | nu | unisex' }) gender: string;
  @ApiProperty({ type: MoneyResponse }) price: MoneyResponse;
  @ApiPropertyOptional({ type: MoneyResponse, nullable: true, description: 'Giá gốc (gạch) khi đang giảm' }) listPrice: MoneyResponse | null;
  @ApiPropertyOptional({ nullable: true }) imageUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) hoverImageUrl: string | null;
  @ApiProperty({ type: [ColorOptionResponse] }) colors: ColorOptionResponse[];
  @ApiProperty({ type: [String], example: ['S', 'M', 'L'] }) sizes: string[];
  @ApiProperty({ example: 4.7 }) avgRating: number;
  @ApiProperty({ example: 128 }) reviewCount: number;
  @ApiProperty({ example: 940 }) soldCount: number;
  @ApiProperty() isNew: boolean;
  @ApiPropertyOptional({ nullable: true, example: '-20%', description: 'Nhãn góc thẻ: "-20%" / "Mới" / "Bán chạy" — server tính' }) badge: string | null;
  @ApiProperty({ description: 'Còn hàng ở ít nhất một biến thể' }) inStock: boolean;
}

export class ProductImageResponse {
  @ApiProperty() id: string;
  @ApiProperty() url: string;
  @ApiPropertyOptional({ nullable: true, example: 'Đen', description: 'Tên màu ảnh thuộc về (null = ảnh chung)' }) color: string | null;
  @ApiPropertyOptional({ nullable: true }) colorCode: string | null;
  @ApiProperty() sortOrder: number;
  @ApiProperty() isPrimary: boolean;
}

export class VariantOptionResponse {
  @ApiProperty() attributeId: string;
  @ApiProperty() attributeValueId: string;
  @ApiProperty({ description: 'Tên hiển thị snapshot' }) displayValue: string;
  @ApiPropertyOptional({ example: 'Dung lượng', description: 'Tên trục biến thể (vd "Màu sắc"); thiếu khi thuộc tính đã bị xoá khỏi danh mục' }) attributeName?: string;
}

export class ProductVariantResponse {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ example: 'Đen', nullable: true, description: 'null cho category dynamic' }) color: string | null;
  @ApiPropertyOptional({ example: 'den', nullable: true, description: 'null cho category dynamic' }) colorCode: string | null;
  @ApiPropertyOptional({ example: 'M', nullable: true, description: 'null cho category dynamic' }) size: string | null;
  @ApiProperty({ example: 'AOTHUN-DE-M' }) sku: string;
  @ApiProperty({ description: 'Tồn có thể bán (stock − reserved)' }) stock: number;
  @ApiProperty({ type: MoneyResponse }) price: MoneyResponse;
  @ApiPropertyOptional({ type: [VariantOptionResponse], description: 'Trục biến thể (category dynamic)' }) options?: VariantOptionResponse[];
  @ApiPropertyOptional({ description: 'Chỉ có ở API quản trị/vendor (công khai chỉ trả biến thể đang bán): false = đang tắt, không bán' }) isActive?: boolean;
}

export class ProductAttributeValueResponse {
  @ApiProperty() attributeId: string;
  @ApiProperty({ description: 'Tên thuộc tính' }) attributeName: string;
  @ApiPropertyOptional({ nullable: true, description: 'ID giá trị (null nếu nhập tay)' }) attributeValueId: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Tên giá trị hoặc giá trị nhập tay' }) value: string | null;
}

/* Chi tiết sản phẩm (FE `ProductDetailResponse`). */
export class ProductDetailResponse extends ProductCardResponse {
  @ApiPropertyOptional({ nullable: true }) shortDescription: string | null;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty({ type: [ProductImageResponse] }) images: ProductImageResponse[];
  @ApiProperty({ type: [ProductVariantResponse] }) variants: ProductVariantResponse[];
  @ApiPropertyOptional({ nullable: true, example: '100% cotton' }) material: string | null;
  @ApiProperty({ type: [String] }) care: string[];
  @ApiPropertyOptional({ type: [ProductAttributeValueResponse], description: 'Thuộc tính cấp sản phẩm (category dynamic)' }) attributeValues?: ProductAttributeValueResponse[];
}

/* Quản trị: thêm trạng thái, tồn thô, thống kê. */
export class ProductAdminResponse extends ProductDetailResponse {
  @ApiProperty({ example: 'active' }) status: string;
  @ApiProperty() isFeatured: boolean;
  @ApiProperty({ type: [String] }) tags: string[];
  @ApiProperty() categoryId: string;
  @ApiProperty() viewCount: number;
  @ApiProperty({ description: 'Tổng tồn kho thô (chưa trừ giữ hàng)' }) totalStock: number;
  @ApiProperty({ description: 'Tổng đang giữ cho đơn' }) totalReserved: number;
  @ApiPropertyOptional({ nullable: true }) publishedAt: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

export class PriceRangeResponse {
  @ApiProperty({ type: MoneyResponse }) min: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) max: MoneyResponse;
}

/* Bộ lọc cho trang danh sách: màu/size đang có hàng, khoảng giá. */
export class ProductFiltersResponse {
  @ApiProperty({ type: [ColorOptionResponse] }) colors: ColorOptionResponse[];
  @ApiProperty({ type: [String] }) sizes: string[];
  @ApiProperty({ type: PriceRangeResponse }) priceRange: PriceRangeResponse;
}
