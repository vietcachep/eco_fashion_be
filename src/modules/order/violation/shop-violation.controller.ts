import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import { RequirePermission } from '@common/security/decorators';
import { PageQuery } from '@common/utils/pagination';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { CurrentShop, RequireShopPermission, ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ORDER_STATUS } from '../foundation/order.constants';
import { OrderRepository } from '../order/repository/order.repository';
import { ShopViolationService, type ShopViolationSummary, type ShopViolationView } from './shop-violation.service';

export class ShopViolationResponse {
  @ApiProperty() id: string;
  @ApiProperty() orderCode: string;
  @ApiProperty({ enum: ['confirm_timeout', 'ship_timeout', 'cancel_out_of_stock', 'cancel_price_error', 'cancel_packing', 'reject_then_cancel'] }) kind: string;
  @ApiProperty() kindLabel: string;
  @ApiProperty() points: number;
  @ApiProperty() createdAt: string;
}

export class ShopViolationSummaryResponse {
  @ApiProperty({ description: 'Tổng điểm trong windowDays ngày gần nhất' }) points: number;
  @ApiProperty({ example: 30 }) windowDays: number;
  @ApiProperty({ description: 'Ngưỡng nhắc quản lý xem xét khoá (setting shop.violation_suspend_points)' }) threshold: number;
}

/* Số đơn đang mở của một gian hàng theo trạng thái — hộp thoại khoá shop hiện trước khi quản lý bấm khoá. */
export class ShopOpenOrdersSummaryResponse {
  @ApiProperty({ description: 'Sẽ TỰ HUỶ + hoàn tiền khi khoá shop' }) pending: number;
  @ApiProperty({ description: 'Sẽ TỰ HUỶ + hoàn tiền khi khoá shop' }) confirmed: number;
  @ApiProperty({ description: 'CSKH quyết từng đơn (huỷ + hoàn nếu shop không giao được)' }) packing: number;
  @ApiProperty({ description: 'CSKH quyết từng đơn' }) shipping: number;
}

/* /admin/shops/:id/violations — sàn xem điểm vi phạm xử lý đơn của một gian hàng (tab "Vi phạm" ở chi tiết shop). */
@ApiTags('admin-shops')
@ApiBearerAuth()
@Controller('admin/shops')
export class AdminShopViolationController {
  constructor(
    private readonly violations: ShopViolationService,
    private readonly orders: OrderRepository,
  ) {}

  @Get(':id/violations/summary')
  @RequirePermission('supplier.shop.read')
  @ApiOperation({ summary: 'Tổng điểm vi phạm xử lý đơn của gian hàng trong 30 ngày + ngưỡng nhắc khoá' })
  @ApiOkResponse({ type: ShopViolationSummaryResponse })
  async summary(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ShopViolationSummary>> {
    return ApiResponse.ok(await this.violations.summary(id));
  }

  @Get(':id/violations')
  @RequirePermission('supplier.shop.read')
  @ApiOperation({ summary: 'Lịch sử điểm vi phạm xử lý đơn của gian hàng (mới nhất trước)' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<ShopViolationView>>> {
    return ApiResponse.ok(await this.violations.list(id, q.page, q.size));
  }

  @Get(':id/open-orders-summary')
  @RequirePermission('supplier.shop.read')
  @ApiOperation({ summary: 'Số đơn đang mở của gian hàng theo trạng thái (pending/confirmed tự huỷ + hoàn khi khoá; packing/shipping do CSKH quyết)' })
  @ApiOkResponse({ type: ShopOpenOrdersSummaryResponse })
  async openOrders(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ShopOpenOrdersSummaryResponse>> {
    const c = await this.orders.openCountsByShop(id, [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING]);
    return ApiResponse.ok({ pending: c.pending ?? 0, confirmed: c.confirmed ?? 0, packing: c.packing ?? 0, shipping: c.shipping ?? 0 });
  }
}

/* /shop/violations — gian hàng xem điểm vi phạm của CHÍNH mình (shopId từ ShopContextGuard, không nhận từ request). */
@ApiTags('shop-orders')
@ApiBearerAuth()
@Controller('shop/violations')
@UseGuards(ShopContextGuard)
export class ShopViolationController {
  constructor(private readonly violations: ShopViolationService) {}

  @Get('summary')
  @RequireShopPermission('shop.order.read')
  @ApiOperation({ summary: 'Tổng điểm vi phạm xử lý đơn của gian hàng mình trong 30 ngày + ngưỡng' })
  @ApiOkResponse({ type: ShopViolationSummaryResponse })
  async summary(@CurrentShop() shop: ShopContext): Promise<ApiResponse<ShopViolationSummary>> {
    return ApiResponse.ok(await this.violations.summary(shop.shopId));
  }

  @Get()
  @RequireShopPermission('shop.order.read')
  @ApiOperation({ summary: 'Lịch sử điểm vi phạm xử lý đơn của gian hàng mình' })
  @ApiOkResponse({ type: PageResponse })
  async list(@CurrentShop() shop: ShopContext, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<ShopViolationView>>> {
    return ApiResponse.ok(await this.violations.list(shop.shopId, q.page, q.size));
  }
}
