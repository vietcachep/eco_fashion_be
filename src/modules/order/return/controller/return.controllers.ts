import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { PageQuery } from '@common/utils/pagination';
import { CurrentShop, RequireShopPermission, ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { AdminReturnService } from '../admin-return.service';
import { ReturnRequestResponse, ShopReturnRequestResponse } from '../dto/return.responses';
import { ApproveReturnRequest, CreateReturnRequest, EscalateReturnRequest, ReceiveReturnRequest, RejectReturnRequest, ResolveReturnRequest, ReturnListQuery, ShipBackReturnRequest, ShopReturnListQuery } from '../request/return.requests';
import { ReturnService } from '../return.service';
import { ShopReturnService } from '../shop-return.service';

/*
 * Khách: tạo yêu cầu đổi trả, xem, rút khi chưa gửi hàng, báo đã gửi hàng trả, khiếu nại lên sàn khi shop từ chối (PLAN-0022 §4.2).
 * Dữ liệu LUÔN lọc theo user từ JWT. Controller không chứa nghiệp vụ.
 */
@ApiTags('returns')
@ApiBearerAuth()
@Controller()
export class ReturnController {
  constructor(private readonly returns: ReturnService) {}

  @Post('orders/:code/returns')
  @ApiOperation({ summary: 'Gửi yêu cầu đổi trả: lý do chuẩn + minh chứng (URL từ POST /uploads/media, ≤ 8) + tài khoản nhận hoàn (bắt buộc với đơn COD đã thu tiền). reasonCode=not_received: không cần items/evidence' })
  @ApiOkResponse({ type: ReturnRequestResponse })
  async create(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: CreateReturnRequest): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.create(actor, code.toUpperCase(), body), 'Đã gửi yêu cầu đổi trả');
  }

  @Get('returns')
  @ApiOperation({ summary: 'Yêu cầu đổi trả của tôi (mới nhất trước)' })
  @ApiOkResponse({ type: PageResponse })
  async mine(@CurrentActor() actor: AuthenticatedActor, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<ReturnRequestResponse>>> {
    return ApiResponse.ok(await this.returns.mine(actor, q.page, q.size));
  }

  @Get('returns/:id')
  @ApiOperation({ summary: 'Chi tiết một yêu cầu đổi trả của tôi (hạn của bước đang chờ + canCancel/canShipBack/canEscalate)' })
  @ApiOkResponse({ type: ReturnRequestResponse })
  async get(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.getMine(actor, id));
  }

  @Post('returns/:id/ship-back')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Báo đã gửi hàng trả (đơn vị vận chuyển + mã vận đơn) — chỉ khi shop đã duyệt yêu cầu trả hàng và còn trong hạn gửi' })
  @ApiOkResponse({ type: ReturnRequestResponse })
  async shipBack(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ShipBackReturnRequest): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.shipBack(actor, id, body), 'Đã ghi nhận gửi hàng trả');
  }

  @Post('returns/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rút yêu cầu khi chưa gửi hàng (đang chờ shop duyệt, hoặc đã duyệt nhưng chưa báo gửi)' })
  @ApiOkResponse({ type: ReturnRequestResponse })
  async cancel(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.cancel(actor, id), 'Đã rút yêu cầu đổi trả');
  }

  @Post('returns/:id/escalate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Khiếu nại lên sàn khi shop từ chối (trong return.escalate_days). Sàn từ chối là quyết định cuối' })
  @ApiOkResponse({ type: ReturnRequestResponse })
  async escalate(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: EscalateReturnRequest): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.escalate(actor, id, body.reason), 'Đã chuyển yêu cầu cho sàn xem xét');
  }
}

/*
 * Sàn: xem (order.return.read) và PHÂN XỬ (order.return.process) — chỉ yêu cầu đã chuyển lên sàn (escalated). Endpoint `process` kiểu cũ (sàn duyệt/từ chối thay shop) đã bị xoá.
 */
@ApiTags('admin-returns')
@ApiBearerAuth()
@Controller('admin/returns')
export class AdminReturnController {
  constructor(private readonly returns: AdminReturnService) {}

  @Get()
  @RequirePermission('order.return.read')
  @ApiOperation({ summary: 'Yêu cầu đổi trả của mọi gian hàng (lọc status / shopId) — escalated = đang chờ sàn phân xử' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: ReturnListQuery): Promise<ApiResponse<PageResponse<ReturnRequestResponse>>> {
    return ApiResponse.ok(await this.returns.list(q.page, q.size, q.status, q.shopId));
  }

  @Get(':id')
  @RequirePermission('order.return.read')
  @ApiOkResponse({ type: ReturnRequestResponse })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.get(id));
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('order.return.process')
  @ApiOperation({ summary: 'Phân xử yêu cầu đã chuyển lên sàn: hoàn tiền (nhập kho chỉ khi shop đã nhận hàng) hoặc từ chối lần cuối. note bắt buộc; refundAmount ≤ tổng đơn − đã hoàn' })
  @ApiOkResponse({ type: ReturnRequestResponse })
  async resolve(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ResolveReturnRequest): Promise<ApiResponse<ReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.resolve(actor, id, body), 'Đã phân xử yêu cầu đổi trả');
  }
}

/*
 * Shop: /shop/returns — duyệt / từ chối / xác nhận ĐÃ NHẬN LẠI hàng cho đổi trả của CHÍNH gian hàng mình. shopId do ShopContextGuard suy ra từ JWT, không nhận từ URL/body.
 */
@ApiTags('shop-returns')
@ApiBearerAuth()
@Controller('shop/returns')
@UseGuards(ShopContextGuard)
export class ShopReturnController {
  constructor(private readonly returns: ShopReturnService) {}

  @Get()
  @RequireShopPermission('shop.return.read')
  @ApiOperation({ summary: 'Yêu cầu đổi trả của gian hàng mình (lọc status, phân trang)' })
  @ApiOkResponse({ type: PageResponse })
  async list(@CurrentShop() shop: ShopContext, @Query() q: ShopReturnListQuery): Promise<ApiResponse<PageResponse<ReturnRequestResponse>>> {
    return ApiResponse.ok(await this.returns.list(shop.shopId, q.status, q.page, q.size));
  }

  @Get(':id')
  @RequireShopPermission('shop.return.read')
  @ApiOperation({ summary: 'Chi tiết yêu cầu đổi trả của shop mình (kèm gợi ý địa chỉ nhận hàng trả; không có tài khoản ngân hàng của khách)' })
  @ApiOkResponse({ type: ShopReturnRequestResponse })
  async get(@CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ShopReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.get(shop.shopId, id));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.return.process')
  @ApiOperation({ summary: 'Duyệt: cần trả hàng ⇒ approved (kèm returnAddress để khách gửi về); not_received ⇒ hoàn tiền ngay, không nhập kho. refundAmount chỉ được GIẢM và phải kèm adjustReason' })
  @ApiOkResponse({ type: ShopReturnRequestResponse })
  async approve(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveReturnRequest): Promise<ApiResponse<ShopReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.approve(actor, shop.shopId, id, { refundAmount: body.refundAmount, adjustReason: body.adjustReason, returnAddress: body.returnAddress }), 'Đã duyệt yêu cầu đổi trả');
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.return.process')
  @ApiOperation({ summary: 'Từ chối (lý do ≥ 10 ký tự, minh chứng tuỳ chọn) — khách còn khiếu nại lên sàn được trong return.escalate_days' })
  @ApiOkResponse({ type: ShopReturnRequestResponse })
  async reject(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RejectReturnRequest): Promise<ApiResponse<ShopReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.reject(actor, shop.shopId, id, body), 'Đã từ chối yêu cầu đổi trả');
  }

  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.return.process')
  @ApiOperation({ summary: 'Xác nhận ĐÃ NHẬN LẠI hàng: ok ⇒ nhập kho + yêu cầu hoàn tiền (received); not_matching ⇒ chuyển sàn phân xử (escalated, note ≥ 10 ký tự)' })
  @ApiOkResponse({ type: ShopReturnRequestResponse })
  async receive(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReceiveReturnRequest): Promise<ApiResponse<ShopReturnRequestResponse>> {
    return ApiResponse.ok(await this.returns.receive(actor, shop.shopId, id, body), 'Đã ghi nhận nhận lại hàng');
  }
}
