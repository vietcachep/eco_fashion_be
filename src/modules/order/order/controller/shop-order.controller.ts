import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { CurrentShop, RequireShopPermission, ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { OrderResponse, OrderSummaryResponse, ShopOrderSummaryResponse } from '../dto/order.responses';
import { ShopOrderListQuery, ShopUpdateOrderStatusRequest, ShopCancelOrderRequest } from '../request/shop-order.requests';
import { ShopOrderService } from '../service/shop-order.service';

/*
 * /shop/orders — vendor quản lý đơn hàng CỦA RIÊNG gian hàng mình (PLAN-0014 bước 5).
 * shopId được ShopContextGuard suy ra từ JWT — vendor không thể truyền shopId qua body/param.
 * Chỉ cho phép chuyển trạng thái pending→confirmed→packing→shipping→delivered
 * (vendor không được chuyển sang completed — quyền admin). Huỷ đơn chỉ khi pending/confirmed.
 * Cả 3 route chi tiết/đổi trạng thái/huỷ trả CÙNG dạng OrderResponse, không có thông tin thanh toán của khách.
 */
@ApiTags('shop-orders')
@ApiBearerAuth()
@Controller('shop/orders')
@UseGuards(ShopContextGuard)
export class ShopOrderController {
  constructor(private readonly shopOrders: ShopOrderService) {}

  @Get()
  @RequireShopPermission('shop.order.read')
  @ApiOperation({ summary: 'Danh sách đơn hàng của gian hàng mình (tìm kiếm, lọc trạng thái, phân trang)' })
  @ApiOkResponse({ type: PageResponse })
  async list(
    @CurrentShop() shop: ShopContext,
    @Query() q: ShopOrderListQuery,
  ): Promise<ApiResponse<PageResponse<OrderSummaryResponse>>> {
    return ApiResponse.ok(
      await this.shopOrders.list(
        shop.shopId,
        { status: q.status, q: q.q, paymentStatus: q.paymentStatus, paymentMethodCode: q.paymentMethodCode },
        q.page,
        q.size,
      ),
    );
  }

  @Get('summary')
  @RequireShopPermission('shop.order.read')
  @ApiOperation({ summary: 'Thống kê số lượng đơn theo trạng thái (pending, confirmed, packing, shipping, delivered, completed, cancelled)' })
  @ApiOkResponse({ type: ShopOrderSummaryResponse })
  async summary(@CurrentShop() shop: ShopContext): Promise<ApiResponse<ShopOrderSummaryResponse>> {
    const c = await this.shopOrders.summary(shop.shopId);
    return ApiResponse.ok({ pending: c.pending ?? 0, confirmed: c.confirmed ?? 0, packing: c.packing ?? 0, shipping: c.shipping ?? 0, delivered: c.delivered ?? 0, completed: c.completed ?? 0, cancelled: c.cancelled ?? 0, returned: c.returned ?? 0 });
  }

  @Get(':code')
  @RequireShopPermission('shop.order.read')
  @ApiOperation({ summary: 'Chi tiết đơn của gian hàng mình (không kèm thông tin thanh toán của khách)' })
  @ApiOkResponse({ type: OrderResponse })
  async get(@CurrentShop() shop: ShopContext, @Param('code') code: string): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.shopOrders.get(shop.shopId, code));
  }

  @Put(':code/status')
  @RequireShopPermission('shop.order.update')
  @ApiOperation({
    summary: 'Cập nhật trạng thái đơn (vendor chỉ được: pending→confirmed→packing→shipping→delivered)',
  })
  @ApiOkResponse({ type: OrderResponse })
  async updateStatus(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('code') code: string,
    @Body() body: ShopUpdateOrderStatusRequest,
  ): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(
      await this.shopOrders.updateStatus(actor, shop.shopId, code, body.status, {
        trackingUrl: body.trackingUrl,
        note: body.note,
      }),
      'Đã cập nhật trạng thái',
    );
  }

  @Post(':code/cancel')
  @RequireShopPermission('shop.order.update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Vendor huỷ đơn (chỉ khi pending/confirmed — đơn đang đóng gói trở đi không huỷ được, 409 ORDER_CANNOT_CANCEL)' })
  @ApiOkResponse({ type: OrderResponse })
  async cancel(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('code') code: string,
    @Body() body: ShopCancelOrderRequest,
  ): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(
      await this.shopOrders.cancel(actor, shop.shopId, code, body.reason),
      'Đã huỷ đơn',
    );
  }
}
