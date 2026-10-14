import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { CurrentShop, RequireShopPermission, ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { ShopReviewResponse } from './dto/shop-review.responses';
import { ShopReviewListQuery, ShopReviewReplyRequest } from './dto/shop-review.requests';
import { ReviewService } from './review.service';

/*
 * /shop/reviews — vendor xem đánh giá sản phẩm của gian hàng mình và trả lời (PLAN-0014 bước 9).
 * shopId suy từ ShopContextGuard (vendor không thể truyền qua param để xem/trả lời đánh giá shop khác).
 * Vendor là bên thứ ba: response là ShopReviewResponse (tên khách đã che, không userId/orderCode/ghi chú kiểm duyệt,
 * không họ tên nhân viên ở phần trả lời) và chỉ có đánh giá đã duyệt (approved) — xem ReviewService.listShop/replyShop.
 */
@ApiTags('shops')
@ApiBearerAuth()
@Controller('shop/reviews')
@UseGuards(ShopContextGuard)
export class ShopReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Get()
  @RequireShopPermission('shop.review.read')
  @ApiOperation({ summary: 'Danh sách đánh giá (đã duyệt) của sản phẩm thuộc gian hàng mình — content là ShopReviewResponse[]' })
  @ApiOkResponse({ type: PageResponse })
  async list(
    @CurrentShop() shop: ShopContext,
    @Query() q: ShopReviewListQuery,
  ): Promise<ApiResponse<PageResponse<ShopReviewResponse>>> {
    return ApiResponse.ok(await this.reviews.listShop(shop.shopId, q.page ?? 1, q.size ?? 10));
  }

  @Post(':id/reply')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.review.reply')
  @ApiOperation({ summary: 'Trả lời một đánh giá đã duyệt của gian hàng mình (hiển thị công khai dưới tên gian hàng)' })
  @ApiOkResponse({ type: ShopReviewResponse })
  async reply(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ShopReviewReplyRequest,
  ): Promise<ApiResponse<ShopReviewResponse>> {
    return ApiResponse.ok(await this.reviews.replyShop(actor, { shopId: shop.shopId, shopName: shop.shopName }, id, body.content), 'Đã trả lời đánh giá');
  }
}
