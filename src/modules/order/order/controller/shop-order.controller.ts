import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { CurrentShop, RequireShopPermission, ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { OrderResponse, OrderSummaryResponse, ShopOrderSummaryResponse } from '../dto/order.responses';
import { DeliveryFailedRequest, ShopOrderListQuery, ShopUpdateOrderStatusRequest, ShopCancelOrderRequest, ShopReasonRequest } from '../request/shop-order.requests';
import { OrderFulfilmentService } from '../service/order-fulfilment.service';
import type { DeliveryFailedReason } from '../../foundation/order.constants';
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
  constructor(
    private readonly shopOrders: ShopOrderService,
    private readonly fulfilment: OrderFulfilmentService,
  ) {}

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
    summary: 'Cập nhật trạng thái đơn (vendor chỉ được: pending→confirmed→packing→shipping→delivered). Chuyển sang shipping BẮT BUỘC `carrier` + `trackingCode` (400 ORDER_TRACKING_REQUIRED); báo delivered khi khách đang báo chưa nhận hàng ⇒ 409 ORDER_NOT_RECEIVED_OPEN',
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
        carrier: body.carrier,
        trackingCode: body.trackingCode,
        note: body.note,
      }),
      'Đã cập nhật trạng thái',
    );
  }

  @Post(':code/cancel')
  @RequireShopPermission('shop.order.cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Vendor huỷ đơn pending/confirmed/packing (PLAN-0027, quyền shop.order.cancel): gửi reasonCode (+note) hoặc reason; out_of_stock / price_error / huỷ đơn đã đóng gói bị tính điểm vi phạm. Đang giao trở đi ⇒ 409 ORDER_CANNOT_CANCEL' })
  @ApiOkResponse({ type: OrderResponse })
  async cancel(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('code') code: string,
    @Body() body: ShopCancelOrderRequest,
  ): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(
      await this.shopOrders.cancel(actor, shop.shopId, code, { reason: body.reason, reasonCode: body.reasonCode, note: body.note }),
      'Đã huỷ đơn',
    );
  }

  @Post(':code/cancel-request/accept')
  @RequireShopPermission('shop.order.cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Chấp nhận yêu cầu huỷ của khách (đơn đang đóng gói): huỷ đơn, nhập lại kho, hoàn tiền nếu đã trả — không tính vi phạm' })
  @ApiOkResponse({ type: OrderResponse })
  async acceptCancelRequest(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('code') code: string): Promise<ApiResponse<OrderResponse>> {
    await this.fulfilment.acceptCancelRequest(actor, shop.shopId, code.toUpperCase());
    return ApiResponse.ok(await this.shopOrders.get(shop.shopId, code), 'Đã chấp nhận yêu cầu huỷ — đơn đã huỷ');
  }

  @Post(':code/cancel-request/reject')
  @RequireShopPermission('shop.order.cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Từ chối yêu cầu huỷ của khách (lý do ≥ 10 ký tự, khách đọc được); sau đó shop tự huỷ đơn này sẽ bị tính điểm vi phạm' })
  @ApiOkResponse({ type: OrderResponse })
  async rejectCancelRequest(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('code') code: string, @Body() body: ShopReasonRequest): Promise<ApiResponse<OrderResponse>> {
    await this.fulfilment.rejectCancelRequest(actor, shop.shopId, code.toUpperCase(), body.reason);
    return ApiResponse.ok(await this.shopOrders.get(shop.shopId, code), 'Đã từ chối yêu cầu huỷ');
  }

  @Post(':code/extend-ship')
  @RequireShopPermission('shop.order.update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gia hạn hạn giao MỘT lần (+order.shop_ship_hours) kèm lý do ≥ 10 ký tự — chỉ khi đơn confirmed/packing còn hạn' })
  @ApiOkResponse({ type: OrderResponse })
  async extendShip(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('code') code: string, @Body() body: ShopReasonRequest): Promise<ApiResponse<OrderResponse>> {
    await this.fulfilment.extendShip(actor, shop.shopId, code.toUpperCase(), body.reason);
    return ApiResponse.ok(await this.shopOrders.get(shop.shopId, code), 'Đã gia hạn thời gian giao');
  }

  @Post(':code/goods-returned')
  @RequireShopPermission('shop.order.update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xác nhận "hàng đã về kho" cho đơn đã huỷ vì giao thất bại mà lúc báo goodsReturned=false: nhập kho lại đúng số đã giao, đúng MỘT lần, trong 30 ngày (SHP-09). 400 ORDER_GOODS_RETURN_NOT_ALLOWED · 409 ORDER_GOODS_ALREADY_RETURNED' })
  @ApiOkResponse({ type: OrderResponse })
  async goodsReturned(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('code') code: string): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.shopOrders.goodsReturned(actor, shop.shopId, code), 'Đã xác nhận hàng về kho — đã nhập kho lại');
  }

  @Post(':code/delivery-failed')
  @RequireShopPermission('shop.order.update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Báo giao KHÔNG thành công (khách từ chối / không liên lạc được / sai địa chỉ / thất lạc / hư hỏng): đơn đang giao → huỷ; goodsReturned ⇒ nhập kho lại (không thì xác nhận sau ở POST :code/goods-returned); đơn đã thu tiền online ⇒ hoàn đủ cho khách (PLAN-0022, quyền shop.order.update từ PLAN-0031)' })
  @ApiOkResponse({ type: OrderResponse })
  async deliveryFailed(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('code') code: string,
    @Body() body: DeliveryFailedRequest,
  ): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(
      await this.shopOrders.deliveryFailed(actor, shop.shopId, code, { reasonCode: body.reasonCode as DeliveryFailedReason, note: body.note, goodsReturned: body.goodsReturned }),
      'Đã ghi nhận giao không thành công — đơn đã huỷ',
    );
  }
}
