import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { CurrentShop, RequireShopPermission, ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { ProductAdminResponse, ProductCardResponse } from '../dto/product.responses';
import { AdminProductListQuery, CreateShopProductRequest, SaveAttributesRequest, SaveVariantsRequest, UpdateShopProductRequest } from '../request/product.requests';
import { ProductService } from '../service/product.service';

/*
 * /shop/products — vendor quản lý sản phẩm CỦA RIÊNG gian hàng mình. shopId suy từ ShopContextGuard
 * (PLAN-0014 bước 5): vendor không thể truyền shopId qua body/param để quản lý sản phẩm của shop khác.
 * Tái sử dụng ProductService/ProductRepository, chỉ thêm lọc shopId. Body tạo/sửa dùng request RIÊNG của vendor (không có isFeatured/isNew/tags —
 * nhãn/ưu tiên hiển thị là quyền của sàn).
 */
@ApiTags('shops')
@ApiBearerAuth()
@Controller('shop/products')
@UseGuards(ShopContextGuard)
export class ShopProductController {
  constructor(private readonly products: ProductService) {}

  @Get()
  @RequireShopPermission('shop.product.read')
  @ApiOperation({ summary: 'Danh sách sản phẩm của gian hàng mình (mọi trạng thái)' })
  @ApiOkResponse({ type: PageResponse })
  async list(
    @CurrentShop() shop: ShopContext,
    @Query() q: AdminProductListQuery,
  ): Promise<ApiResponse<PageResponse<ProductCardResponse & { status: string }>>> {
    return ApiResponse.ok(
      await this.products.listShop({
        shopId: shop.shopId,
        page: q.page,
        size: q.pageSize,
        q: q.q,
        category: q.category,
        gender: q.gender,
        status: q.status,
        sort: q.sort,
      }),
    );
  }

  @Get(':id')
  @RequireShopPermission('shop.product.read')
  @ApiOkResponse({ type: ProductAdminResponse })
  async get(
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.products.getShop(shop.shopId, id));
  }

  @Post()
  @RequireShopPermission('shop.product.manage')
  @ApiOperation({ summary: 'Tạo sản phẩm mới cho gian hàng của tôi (trạng thái nháp)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async create(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Body() body: CreateShopProductRequest,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    const { variants, ...input } = body;
    return ApiResponse.ok(
      await this.products.createShop(actor, shop.shopId, input, variants ?? []),
      'Đã tạo sản phẩm (nháp)',
    );
  }

  @Patch(':id')
  @RequireShopPermission('shop.product.manage')
  @ApiOperation({ summary: 'Sửa thông tin / giá / ngành hàng sản phẩm của gian hàng mình' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async update(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateShopProductRequest,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(
      await this.products.updateShop(actor, shop.shopId, id, body),
      'Đã cập nhật',
    );
  }

  @Put(':id/variants')
  @RequireShopPermission('shop.product.manage')
  @RateLimit({ name: 'shop-product-variants', limit: 120, windowSeconds: 3600, by: 'user' })
  @ApiOperation({ summary: 'Thay toàn bộ biến thể (khớp biến thể cũ theo màu×size / tổ hợp trục → giữ id & tồn kho; thiếu = xoá mềm)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async variants(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SaveVariantsRequest,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(
      await this.products.saveVariantsShop(actor, shop.shopId, id, body.variants),
      'Đã lưu biến thể',
    );
  }

  @Put(':id/attributes')
  @RequireShopPermission('shop.product.manage')
  @RateLimit({ name: 'shop-product-attributes', limit: 120, windowSeconds: 3600, by: 'user' })
  @ApiOperation({ summary: 'Thay toàn bộ thuộc tính cấp sản phẩm (ngành dynamic) — kiểm theo mẫu thuộc tính của ngành' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async attributes(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SaveAttributesRequest,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(
      await this.products.saveAttributesShop(actor, shop.shopId, id, body.attributeValues),
      'Đã lưu thuộc tính',
    );
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.product.manage')
  @ApiOperation({ summary: 'Đăng bán sản phẩm (cần ≥1 biến thể, ≥1 ảnh và đủ thuộc tính bắt buộc của ngành)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async publish(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(
      await this.products.publishShop(actor, shop.shopId, id),
      'Đã đăng bán',
    );
  }

  @Post(':id/hide')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.product.manage')
  @ApiOperation({ summary: 'Ẩn sản phẩm khỏi web bán hàng' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async hide(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(
      await this.products.hideShop(actor, shop.shopId, id),
      'Đã ẩn sản phẩm',
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.product.manage')
  @ApiOperation({ summary: 'Xoá mềm sản phẩm của gian hàng mình' })
  async remove(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiResponse<null>> {
    await this.products.removeShop(actor, shop.shopId, id);
    return ApiResponse.ok(null, 'Đã xoá sản phẩm');
  }
}
