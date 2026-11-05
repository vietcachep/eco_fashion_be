import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { PageQuery } from '@common/utils/pagination';
import { CheckoutSummaryResponse, OrderGroupResponse, OrderResponse, OrderSummaryResponse } from '../dto/order.responses';
import { AdminCancelOrderRequest, AdminOrderListQuery, CancelOrderRequest, CancelOrderRequestRequest, ChangeOrderAddressRequest, CheckoutSummaryQuery, CreateOrderRequest, MyOrderListQuery } from '../request/order.requests';
import { OrderFulfilmentService } from '../service/order-fulfilment.service';
import { OrderService } from '../service/order.service';

/* Khách: bảng tiền checkout, đặt hàng (Idempotency-Key), đơn của tôi, huỷ (docs/06 mục order). Đổi trả: return/controller/return.controllers.ts (PLAN-0022). */
@ApiTags('orders')
@ApiBearerAuth()
@Controller()
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly fulfilment: OrderFulfilmentService,
  ) {}

  @Get('checkout/summary') @ApiOperation({ summary: 'Bảng tiền cho giỏ đang tick (ship theo tỉnh, mã giảm) — cùng công thức với POST /orders' }) @ApiOkResponse({ type: CheckoutSummaryResponse })
  async summary(@CurrentActor() actor: AuthenticatedActor, @Query() q: CheckoutSummaryQuery): Promise<ApiResponse<CheckoutSummaryResponse>> {
    return ApiResponse.ok(await this.orders.checkoutSummary(actor, q));
  }

  @Post('orders') @RateLimit({ name: 'place-order', limit: 10, windowSeconds: 600, by: 'user' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Gửi lại cùng key → trả đúng đơn đã tạo, không tạo đôi' })
  @ApiOperation({ summary: 'Đặt hàng từ giỏ (dòng đã tick) — trả đơn CHA kèm đơn con theo shop (PLAN-0014 bước 7). Không gửi tiền; không gửi số thẻ (payos → redirect sang link PayOS)' }) @ApiOkResponse({ type: OrderGroupResponse })
  @ApiConflictResponse({ type: CheckoutSummaryResponse, description: '409 `ORDER_PRICE_CHANGED` (chỉ khi body có `expectedTotal`): tổng tiền server tính lại lúc đặt khác số khách đã thấy — `data` = báo giá MỚI (cùng dạng `GET /checkout/summary`), `error.details.{expectedTotal,currentTotal}` là số VND dạng chuỗi; không tạo đơn, không giữ kho, không ghi voucher, Idempotency-Key không bị tiêu. Các 409 khác: `ORDER_CART_CHANGED` · `ORDER_OUT_OF_STOCK` · `ORDER_PROMOTION_INVALID` · `ORDER_SHOP_NOT_AVAILABLE` · `ORDER_COD_NOT_AVAILABLE`.' })
  async place(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreateOrderRequest, @Headers('idempotency-key') key?: string): Promise<ApiResponse<OrderGroupResponse>> {
    const address = body.address ? { ...body.address, provinceCode: null, districtName: body.address.districtName ?? null, wardName: body.address.wardName ?? null } : undefined;
    return ApiResponse.ok(await this.orders.placeOrder(actor, { addressId: body.addressId, address, paymentMethodCode: body.paymentMethodCode, note: body.note, voucherCode: body.voucherCode ?? null, voucherCodes: body.voucherCodes, quoteIds:body.quoteIds, expectedTotal: body.expectedTotal ?? null }, key ?? null), 'Đặt hàng thành công');
  }

  @Get('orders') @ApiOkResponse({ type: PageResponse }) @ApiOperation({ summary: 'Đơn của tôi — tóm tắt; `full=true` trả OrderResponse đầy đủ (đơn CON, không gộp nhóm)' })
  async mine(@CurrentActor() actor: AuthenticatedActor, @Query() q: MyOrderListQuery): Promise<ApiResponse<PageResponse<OrderSummaryResponse | OrderResponse>>> {
    return ApiResponse.ok(q.full ? await this.orders.myOrdersFull(actor, q.page, q.size, q.status) : await this.orders.myOrders(actor, q.page, q.size, q.status));
  }

  /* Khai báo TRƯỚC 'orders/:code' — nếu không, Nest khớp path theo thứ tự đăng ký và 'groups' sẽ rơi vào :code. */
  @Get('orders/groups') @ApiOkResponse({ type: PageResponse }) @ApiOperation({ summary: 'Đơn của tôi theo nhóm (đơn cha + đơn con từng shop) — PLAN-0014 bước 7' })
  async mineGroups(@CurrentActor() actor: AuthenticatedActor, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<OrderGroupResponse>>> {
    return ApiResponse.ok(await this.orders.myOrderGroups(actor, q.page, q.size));
  }

  @Get('orders/groups/:code') @ApiOkResponse({ type: OrderGroupResponse })
  async detailGroup(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string): Promise<ApiResponse<OrderGroupResponse>> {
    return ApiResponse.ok(await this.orders.myOrderGroup(actor, code.toUpperCase()));
  }

  @Get('orders/:code') @ApiOkResponse({ type: OrderResponse })
  async detail(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.orders.myOrder(actor, code.toUpperCase()));
  }

  @Post('orders/:code/cancel') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Khách huỷ đơn TỨC THÌ khi chờ xác nhận / đã xác nhận (PLAN-0027; đơn đang đóng gói ⇒ 409, dùng cancel-request). Gửi reasonCode (+note) hoặc reason' }) @ApiOkResponse({ type: OrderResponse })
  async cancel(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: CancelOrderRequest): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.orders.cancelByCustomer(actor, code.toUpperCase(), body.reason ?? '', { reasonCode: body.reasonCode, note: body.note }), 'Đã huỷ đơn');
  }

  @Post('orders/:code/cancel-request') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Khách YÊU CẦU huỷ đơn đang đóng gói — shop chấp nhận / từ chối, im lặng quá order.cancel_request_hours ⇒ tự chấp nhận (mỗi đơn một yêu cầu)' }) @ApiOkResponse({ type: OrderResponse })
  async requestCancel(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: CancelOrderRequestRequest): Promise<ApiResponse<OrderResponse>> {
    await this.fulfilment.requestCancel(actor, code.toUpperCase(), { reasonCode: body.reasonCode, note: body.note });
    return ApiResponse.ok(await this.orders.myOrder(actor, code.toUpperCase()), 'Đã gửi yêu cầu huỷ đơn');
  }

  @Put('orders/:code/address') @ApiOperation({ summary: 'Khách đổi người nhận / SĐT / địa chỉ khi đơn chờ xác nhận hoặc đã xác nhận (không đổi sang tỉnh/thành khác; đang đóng gói ⇒ 409)' }) @ApiOkResponse({ type: OrderResponse })
  async changeAddress(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: ChangeOrderAddressRequest): Promise<ApiResponse<OrderResponse>> {
    if(body.addressId) { await this.orders.changeCarrierAddress(actor,code.toUpperCase(),body.addressId); return ApiResponse.ok(await this.orders.myOrder(actor,code.toUpperCase()),'Đã đổi địa chỉ nhận hàng'); }
    await this.fulfilment.changeAddress(actor, code.toUpperCase(), { recipientName: body.recipientName, recipientPhone: body.recipientPhone, addressLine: body.addressLine, ward: body.ward, district: body.district, province: body.province });
    return ApiResponse.ok(await this.orders.myOrder(actor, code.toUpperCase()), 'Đã đổi địa chỉ nhận hàng');
  }

  @Post('orders/:code/received') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Khách xác nhận "Đã nhận hàng": đơn đã giao ⇒ hoàn tất ngay (409 khi còn yêu cầu đổi trả / chưa nhận hàng đang mở)' }) @ApiOkResponse({ type: OrderResponse })
  async received(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string): Promise<ApiResponse<OrderResponse>> {
    await this.fulfilment.markReceived(actor, code.toUpperCase());
    return ApiResponse.ok(await this.orders.myOrder(actor, code.toUpperCase()), 'Cảm ơn bạn đã xác nhận nhận hàng');
  }
}

@ApiTags('admin-orders')
@ApiBearerAuth()
@Controller('admin')
export class AdminOrderController {
  constructor(private readonly orders: OrderService) {}

  @Get('orders') @RequirePermission('order.order.read') @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: AdminOrderListQuery): Promise<ApiResponse<PageResponse<OrderSummaryResponse>>> {
    return ApiResponse.ok(await this.orders.listAdmin({ status: q.status, paymentStatus: q.paymentStatus, paymentMethodCode: q.paymentMethodCode, q: q.q, shopId: q.shopId }, q.page, q.size));
  }

  @Get('orders/:code') @RequirePermission('order.order.read') @ApiOkResponse({ type: OrderResponse })
  async get(@Param('code') code: string): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.orders.getAdmin(code.toUpperCase()));
  }

  @Post('orders/:code/cancel') @HttpCode(HttpStatus.OK) @RequirePermission('order.order.cancel') @ApiOperation({ summary: 'Huỷ đơn thay khách (pending/confirmed; đơn ĐANG GIAO khi tranh chấp — bắt buộc lý do ≥ 10 ký tự, không tự nhập kho, hoàn tiền nếu đã thu online)' }) @ApiOkResponse({ type: OrderResponse })
  async cancel(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: AdminCancelOrderRequest): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.orders.cancelByStaff(actor, code.toUpperCase(), body.reason, { reasonCode: body.reasonCode }), 'Đã huỷ đơn');
  }
}
