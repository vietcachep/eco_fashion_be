import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { ProductAdminResponse, ProductCardResponse } from '../dto/product.responses';
import { AdminProductListQuery } from '../request/product.requests';
import { ProductService } from '../service/product.service';

/*
 * /admin/products — SÀN giám sát sản phẩm của mọi shop: xem + chặn bán (ẩn) / mở bán lại. Tạo / sửa / biến thể / ảnh / xoá là việc của CHỦ SHOP (/shop/products) —
 * sàn không làm thay (PLAN-0021).
 */
@ApiTags('admin-products')
@ApiBearerAuth()
@Controller('admin/products')
export class AdminProductController {
  constructor(private readonly products: ProductService) {}

  @Get()
  @RequirePermission('product.product.read')
  @ApiOperation({ summary: 'Danh sách mọi trạng thái (draft/active/hidden), tìm kiếm, lọc' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: AdminProductListQuery): Promise<ApiResponse<PageResponse<ProductCardResponse & { status: string }>>> {
    return ApiResponse.ok(await this.products.listAdmin({ page: q.page, size: q.pageSize, q: q.q, category: q.category, gender: q.gender, status: q.status, shopId: q.shopId, sort: q.sort }));
  }

  @Get(':id')
  @RequirePermission('product.product.read')
  @ApiOkResponse({ type: ProductAdminResponse })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.products.getAdmin(id));
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product.product.publish')
  @ApiOperation({ summary: 'Đăng bán (cần ≥1 biến thể, ≥1 ảnh và đủ thuộc tính bắt buộc của ngành)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async publish(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.products.publish(actor, id), 'Đã đăng bán');
  }

  @Post(':id/hide')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product.product.publish')
  @ApiOperation({ summary: 'Ẩn khỏi web bán hàng' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async hide(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.products.hide(actor, id), 'Đã ẩn sản phẩm');
  }
}
