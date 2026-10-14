import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BasketForPromotion } from '@common/gateway/promotion.gateway';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { PageQuery } from '@common/utils/pagination';
import { CartQueryApi } from '../cart/queryapi/cart.queryapi';
import { CreatePromotionRequest, PromotionForm, PromotionListQuery } from './promotion.requests';
import { PromotionAdminResponse, PromotionOfferResponse, PromotionService } from './promotion.service';

/*
 * Web: phiếu voucher với mức giảm THẬT cho giỏ hiện tại của tôi (FE `GET /promotions/offers`): voucher SÀN trên cả giỏ + voucher
 * của từng gian hàng có trong giỏ (tính trên phần hàng của shop đó).
 */
@ApiTags('promotions')
@ApiBearerAuth()
@Controller('promotions')
export class PromotionController {
  constructor(
    private readonly promotions: PromotionService,
    private readonly cart: CartQueryApi,
  ) {}

  @Get('offers') @ApiOperation({ summary: 'Mã đang chạy (sàn + shop có trong giỏ) + giảm thật cho giỏ (eligible / còn thiếu bao nhiêu)' })
  async offers(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<PromotionOfferResponse[]>> {
    const b = await this.cart.basketOf(actor.userId, true);
    const sellable = b.lines.filter((l) => l.isSellable);
    const toLine = (l: (typeof sellable)[number]) => ({ productId: l.productId, categorySlug: l.categorySlug, lineTotal: l.lineTotal });
    // Phí ship để tính freeship: chưa biết tỉnh ở bước giỏ → dùng 0; order tính lại chính xác lúc checkout.
    const platform: BasketForPromotion = { userId: actor.userId, subtotal: b.subtotal, shippingFee: 0n, lines: sellable.map(toLine) };
    const byShop = new Map<string, typeof sellable>();
    for (const l of sellable) byShop.set(l.shopId, [...(byShop.get(l.shopId) ?? []), l]);
    const shopBaskets: BasketForPromotion[] = [...byShop].map(([shopId, lines]) => ({ userId: actor.userId, shopId, subtotal: lines.reduce((s, l) => s + l.lineTotal, 0n), shippingFee: 0n, lines: lines.map(toLine) }));
    return ApiResponse.ok(await this.promotions.offers(platform, shopBaskets));
  }
}

/* Sàn quản lý mã khuyến mãi: tạo/sửa mã SÀN; xem (và bật/tắt) cả mã của các gian hàng. */
@ApiTags('admin-promotions')
@ApiBearerAuth()
@Controller('admin/promotions')
export class AdminPromotionController {
  constructor(private readonly promotions: PromotionService) {}

  @Get() @RequirePermission('promotion.promotion.read')
  async list(@Query() q: PromotionListQuery): Promise<ApiResponse<PageResponse<PromotionAdminResponse>>> {
    return ApiResponse.ok(await this.promotions.listAdmin(q.page, q.size, q.q, q.active, q.scope, q.shopId));
  }

  @Get(':id') @RequirePermission('promotion.promotion.read')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<PromotionAdminResponse>> {
    return ApiResponse.ok(await this.promotions.getAdmin(id));
  }

  @Get(':id/usages') @RequirePermission('promotion.promotion.read')
  async usages(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQuery) {
    return ApiResponse.ok(await this.promotions.usages(id, q.page, q.size));
  }

  @Post() @RequirePermission('promotion.promotion.manage')
  async create(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreatePromotionRequest): Promise<ApiResponse<PromotionAdminResponse>> {
    return ApiResponse.ok(await this.promotions.create(actor, body), 'Đã tạo mã khuyến mãi');
  }

  @Patch(':id') @RequirePermission('promotion.promotion.manage')
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: PromotionForm): Promise<ApiResponse<PromotionAdminResponse>> {
    return ApiResponse.ok(await this.promotions.update(actor, id, body), 'Đã cập nhật');
  }

  @Delete(':id') @HttpCode(HttpStatus.OK) @RequirePermission('promotion.promotion.manage')
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.promotions.remove(actor, id);
    return ApiResponse.ok(null, 'Đã xoá mã khuyến mãi');
  }
}
