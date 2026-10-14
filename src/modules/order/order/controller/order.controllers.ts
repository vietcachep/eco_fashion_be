import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { PageQuery } from '@common/utils/pagination';
import { ReturnService } from '../../return/return.service';
import { CheckoutSummaryResponse, OrderGroupResponse, OrderResponse, OrderSummaryResponse, ReturnRequestResponse } from '../dto/order.responses';
import { AdminOrderListQuery, CancelOrderRequest, CheckoutSummaryQuery, CreateOrderRequest, CreateReturnRequest, MyOrderListQuery, ProcessReturnRequest, ReturnListQuery, UpdateOrderStatusRequest } from '../request/order.requests';
import { OrderService } from '../service/order.service';

/* Khách: bảng tiền checkout, đặt hàng (Idempotency-Key), đơn của tôi, huỷ, đổi trả (docs/06 mục order). */
@ApiTags('orders')
@ApiBearerAuth()
@Controller()
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly returns: ReturnService,
  ) {}

  @Get('checkout/summary') @ApiOperation({ summary: 'Bảng tiền cho giỏ đang tick (ship theo tỉnh, mã giảm) — cùng công thức với POST /orders' }) @ApiOkResponse({ type: CheckoutSummaryResponse })
  async summary(@CurrentActor() actor: AuthenticatedActor, @Query() q: CheckoutSummaryQuery): Promise<ApiResponse<CheckoutSummaryResponse>> {
    return ApiResponse.ok(await this.orders.checkoutSummary(actor, q));
  }

  @Post('orders') @RateLimit({ name: 'place-order', limit: 10, windowSeconds: 600, by: 'user' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Gửi lại cùng key → trả đúng đơn đã tạo, không tạo đôi' })
  @ApiOperation({ summary: 'Đặt hàng từ giỏ (dòng đã tick) — trả đơn CHA kèm đơn con theo shop (PLAN-0014 bước 7). Không gửi tiền; không gửi số thẻ (card → VNPay redirect)' }) @ApiOkResponse({ type: OrderGroupResponse })
  async place(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreateOrderRequest, @Headers('idempotency-key') key?: string): Promise<ApiResponse<OrderGroupResponse>> {
    const address = body.address ? { ...body.address, provinceCode: null, districtName: body.address.districtName ?? null, wardName: body.address.wardName ?? null } : undefined;
    return ApiResponse.ok(await this.orders.placeOrder(actor, { addressId: body.addressId, address, paymentMethodCode: body.paymentMethodCode, bankCode: body.bankCode ?? null, note: body.note, voucherCode: body.voucherCode ?? null, voucherCodes: body.voucherCodes }, key ?? null), 'Đặt hàng thành công');
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

  @Post('orders/:code/cancel') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Khách huỷ đơn (chỉ khi còn chờ xác nhận)' }) @ApiOkResponse({ type: OrderResponse })
  async cancel(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: CancelOrderRequest): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.orders.cancelByCustomer(actor, code.toUpperCase(), body.reason), 'Đã huỷ đơn');
  }

  @Post('orders/:code/returns') @ApiOperation({ summary: 'Gửi yêu cầu đổi trả (đơn đã giao, trong hạn, có minh chứng)' }) @ApiOkResponse({ type: ReturnRequestResponse })
  async createReturn(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: CreateReturnRequest): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.create(actor, code.toUpperCase(), body), 'Đã gửi yêu cầu đổi trả');
  }

  @Get('returns') @ApiOkResponse({ type: PageResponse })
  async myReturns(@CurrentActor() actor: AuthenticatedActor, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<ReturnRequestResponse>>> {
    return ApiResponse.ok(await this.returns.mine(actor, q.page, q.size));
  }
}

@ApiTags('admin-orders')
@ApiBearerAuth()
@Controller('admin')
export class AdminOrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly returns: ReturnService,
  ) {}

  @Get('orders') @RequirePermission('order.order.read') @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: AdminOrderListQuery): Promise<ApiResponse<PageResponse<OrderSummaryResponse>>> {
    return ApiResponse.ok(await this.orders.listAdmin({ status: q.status, paymentStatus: q.paymentStatus, paymentMethodCode: q.paymentMethodCode, q: q.q }, q.page, q.size));
  }

  @Get('orders/:code') @RequirePermission('order.order.read') @ApiOkResponse({ type: OrderResponse })
  async get(@Param('code') code: string): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.orders.getAdmin(code.toUpperCase()));
  }

  @Put('orders/:code/status') @RequirePermission('order.order.status.update') @ApiOperation({ summary: 'confirmed (trừ kho) → packing → shipping (trackingUrl) → delivered (COD thu tiền) → completed' }) @ApiOkResponse({ type: OrderResponse })
  async status(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: UpdateOrderStatusRequest): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.orders.updateStatus(actor, code.toUpperCase(), body.status, { trackingUrl: body.trackingUrl, note: body.note }), 'Đã cập nhật trạng thái');
  }

  @Post('orders/:code/cancel') @HttpCode(HttpStatus.OK) @RequirePermission('order.order.cancel') @ApiOkResponse({ type: OrderResponse })
  async cancel(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: CancelOrderRequest): Promise<ApiResponse<OrderResponse>> {
    return ApiResponse.ok(await this.orders.cancelByStaff(actor, code.toUpperCase(), body.reason), 'Đã huỷ đơn');
  }

  @Get('returns') @RequirePermission('order.return.read') @ApiOkResponse({ type: PageResponse })
  async returnsList(@Query() q: ReturnListQuery): Promise<ApiResponse<PageResponse<ReturnRequestResponse>>> {
    return ApiResponse.ok(await this.returns.listAdmin(q.page, q.size, q.status));
  }

  @Get('returns/:id') @RequirePermission('order.return.read') @ApiOkResponse({ type: ReturnRequestResponse })
  async returnGet(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.getAdmin(id));
  }

  @Post('returns/:id/process') @HttpCode(HttpStatus.OK) @RequirePermission('order.return.process') @ApiOperation({ summary: 'Duyệt (hoàn tiền + hàng về kho) / từ chối (có lý do)' }) @ApiOkResponse({ type: ReturnRequestResponse })
  async returnProcess(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ProcessReturnRequest): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.process(actor, id, body.decision as 'approved' | 'rejected', { rejectReason: body.rejectReason, refundAmount: body.refundAmount }), body.decision === 'approved' ? 'Đã duyệt đổi trả' : 'Đã từ chối');
  }
}
