import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import { Public } from '@common/security/decorators';
import { ProductCardResponse, ProductDetailResponse, ProductFiltersResponse } from '../dto/product.responses';
import { ProductIdsQuery, ProductListQuery, SuggestQuery } from '../request/product.requests';
import { ProductQueryService } from '../service/product-query.service';

/* Công khai (web bán hàng) — docs/06_FE_CONTRACT.md mục catalog + product. Route tĩnh khai TRƯỚC `:slug`. */
@ApiTags('products')
@Controller('products')
export class ProductController {
  constructor(private readonly products: ProductQueryService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Danh sách sản phẩm đang bán — lọc q/category/gender/size/color/minPrice/maxPrice/sale/tag, sort, phân trang' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: ProductListQuery): Promise<ApiResponse<PageResponse<ProductCardResponse>>> {
    return ApiResponse.ok(await this.products.list({ page: q.page, size: q.pageSize, q: q.q, category: q.category, gender: q.gender, sizeCode: q.size, color: q.color, minPrice: q.minPrice, maxPrice: q.maxPrice, sale: q.sale, tag: q.tag, sort: q.sort }));
  }

  @Public()
  @Get('filters')
  @ApiOperation({ summary: 'Bộ lọc: màu (hex) / size đang có hàng + khoảng giá' })
  @ApiOkResponse({ type: ProductFiltersResponse })
  async filters(): Promise<ApiResponse<ProductFiltersResponse>> {
    return ApiResponse.ok(await this.products.filters());
  }

  @Public()
  @Get('suggest')
  @ApiOperation({ summary: 'Gợi ý khi gõ tìm kiếm (≤ 20 thẻ)' })
  @ApiOkResponse({ type: [ProductCardResponse] })
  async suggest(@Query() q: SuggestQuery): Promise<ApiResponse<ProductCardResponse[]>> {
    return ApiResponse.ok(await this.products.suggest(q.q, q.limit ?? 8));
  }

  @Public()
  @Get('by-ids')
  @ApiOperation({ summary: 'Thẻ sản phẩm theo danh sách id (so sánh, yêu thích) — giữ thứ tự ids' })
  @ApiOkResponse({ type: [ProductCardResponse] })
  async byIds(@Query() q: ProductIdsQuery): Promise<ApiResponse<ProductCardResponse[]>> {
    return ApiResponse.ok(await this.products.byIds(q.ids));
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Chi tiết sản phẩm (ảnh theo màu, biến thể + tồn có thể bán)' })
  @ApiOkResponse({ type: ProductDetailResponse })
  async detail(@Param('slug') slug: string): Promise<ApiResponse<ProductDetailResponse>> {
    return ApiResponse.ok(await this.products.detail(slug));
  }

  @Public()
  @Get(':slug/related')
  @ApiOperation({ summary: 'Sản phẩm liên quan (cùng ngành hàng, bán chạy)' })
  @ApiOkResponse({ type: [ProductCardResponse] })
  async related(@Param('slug') slug: string): Promise<ApiResponse<ProductCardResponse[]>> {
    return ApiResponse.ok(await this.products.related(slug));
  }
}
