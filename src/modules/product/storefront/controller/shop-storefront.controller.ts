import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import { Public } from '@common/security/decorators';
import { ShopStorefrontResponse } from '../dto/shop-storefront.responses';
import { ShopStorefrontService } from '../service/shop-storefront.service';

class ShopStorefrontListQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 48 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(48) pageSize: number = 12;
  @ApiPropertyOptional({ description: 'Tìm theo tên gian hàng' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/* Công khai (web bán hàng) — chỉ gian hàng ĐÃ DUYỆT. Route tĩnh `/shops` khai trước `/shops/:slug`. */
@ApiTags('shops')
@Controller('shops')
export class ShopStorefrontController {
  constructor(private readonly storefront: ShopStorefrontService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Danh sách gian hàng đang hoạt động (điểm đánh giá cao trước) — tìm theo tên, phân trang' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: ShopStorefrontListQuery): Promise<ApiResponse<PageResponse<ShopStorefrontResponse>>> {
    return ApiResponse.ok(await this.storefront.list(q.q?.trim() || undefined, q.page, q.pageSize));
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Trang gian hàng: hồ sơ công khai + điểm đánh giá + số sản phẩm (404 nếu chưa duyệt/đã khoá)' })
  @ApiOkResponse({ type: ShopStorefrontResponse })
  async detail(@Param('slug') slug: string): Promise<ApiResponse<ShopStorefrontResponse>> {
    return ApiResponse.ok(await this.storefront.detail(slug));
  }
}
