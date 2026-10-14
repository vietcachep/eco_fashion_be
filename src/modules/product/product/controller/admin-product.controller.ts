import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { ProductAdminResponse, ProductCardResponse } from '../dto/product.responses';
import { AdminProductListQuery, CreateProductRequest, SaveAttributesRequest, SaveVariantsRequest, UpdateProductRequest } from '../request/product.requests';
import { ProductService } from '../service/product.service';

/* /admin/products — quản trị sản phẩm; mỗi route gác bằng mã quyền product.product.* */
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
    return ApiResponse.ok(await this.products.listAdmin({ page: q.page, size: q.pageSize, q: q.q, category: q.category, gender: q.gender, status: q.status, sort: q.sort }));
  }

  @Get(':id')
  @RequirePermission('product.product.read')
  @ApiOkResponse({ type: ProductAdminResponse })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.products.getAdmin(id));
  }

  @Post()
  @RequirePermission('product.product.create')
  @ApiOperation({ summary: 'Tạo sản phẩm (trạng thái nháp; có thể kèm biến thể)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async create(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreateProductRequest): Promise<ApiResponse<ProductAdminResponse>> {
    const { variants, ...input } = body;
    return ApiResponse.ok(await this.products.create(actor, input, variants ?? []), 'Đã tạo sản phẩm (nháp)');
  }

  @Patch(':id')
  @RequirePermission('product.product.update')
  @ApiOperation({ summary: 'Sửa thông tin / giá / ngành hàng' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProductRequest): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.products.update(actor, id, body), 'Đã cập nhật');
  }

  @Put(':id/variants')
  @RequirePermission('product.product.update')
  @ApiOperation({ summary: 'Thay toàn bộ biến thể (khớp biến thể cũ theo màu×size / tổ hợp trục → giữ id & tồn kho; thiếu = xoá mềm; mã màu/size phải có trong catalog)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async variants(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaveVariantsRequest): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.products.saveVariants(actor, id, body.variants), 'Đã lưu biến thể');
  }

  @Put(':id/attributes')
  @RequirePermission('product.product.update')
  @ApiOperation({ summary: 'Thay toàn bộ thuộc tính cấp sản phẩm (ngành dynamic) — kiểm theo mẫu thuộc tính của ngành' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async attributes(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaveAttributesRequest): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.products.saveAttributes(actor, id, body.attributeValues), 'Đã lưu thuộc tính');
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

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product.product.delete')
  @ApiOperation({ summary: 'Xoá mềm' })
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.products.remove(actor, id);
    return ApiResponse.ok(null, 'Đã xoá sản phẩm');
  }
}
