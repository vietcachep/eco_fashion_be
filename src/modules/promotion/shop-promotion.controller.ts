import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { PageQuery } from '@common/utils/pagination';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { CurrentShop, RequireShopPermission, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { CreatePromotionRequest, PromotionForm, ShopPromotionListQuery } from './promotion.requests';
import { PromotionAdminResponse, PromotionService } from './promotion.service';

/*
 * Vendor tự quản MÃ GIẢM GIÁ của gian hàng mình. `shopId` CHỈ lấy từ ngữ cảnh (ShopContextGuard) — request không có chỗ nào nhận
 * shopId/scope; mã của shop khác → 404. Mã shop do SHOP chịu chi phí và chỉ áp cho đơn con của chính shop.
 */
@ApiTags('shop-promotions')
@ApiBearerAuth()
@Controller('shop/promotions')
@UseGuards(ShopContextGuard)
export class ShopPromotionController {
  constructor(private readonly promotions: PromotionService) {}

  @Get() @RequireShopPermission('shop.promotion.read')
  @ApiOperation({ summary: 'Mã giảm giá của gian hàng mình' })
  async list(@CurrentShop() shop: ShopContext, @Query() q: ShopPromotionListQuery): Promise<ApiResponse<PageResponse<PromotionAdminResponse>>> {
    return ApiResponse.ok(await this.promotions.listAdmin(q.page, q.size, q.q, q.active, 'shop', shop.shopId));
  }

  @Get(':id') @RequireShopPermission('shop.promotion.read')
  async get(@CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<PromotionAdminResponse>> {
    return ApiResponse.ok(await this.promotions.getAdmin(id, shop.shopId));
  }

  @Get(':id/usages') @RequireShopPermission('shop.promotion.read')
  @ApiOperation({ summary: 'Lượt dùng của mã (ẩn danh khách)' })
  async usages(@CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: PageQuery) {
    return ApiResponse.ok(await this.promotions.usages(id, q.page, q.size, shop.shopId));
  }

  @Post() @RequireShopPermission('shop.promotion.manage')
  async create(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Body() body: CreatePromotionRequest): Promise<ApiResponse<PromotionAdminResponse>> {
    return ApiResponse.ok(await this.promotions.create(actor, body, shop.shopId), 'Đã tạo mã giảm giá');
  }

  @Patch(':id') @RequireShopPermission('shop.promotion.manage')
  async update(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PromotionForm): Promise<ApiResponse<PromotionAdminResponse>> {
    return ApiResponse.ok(await this.promotions.update(actor, id, body, shop.shopId), 'Đã cập nhật');
  }

  @Delete(':id') @HttpCode(HttpStatus.OK) @RequireShopPermission('shop.promotion.manage')
  async remove(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.promotions.remove(actor, id, shop.shopId);
    return ApiResponse.ok(null, 'Đã xoá mã giảm giá');
  }
}
