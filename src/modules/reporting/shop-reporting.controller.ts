import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ApiResponse } from '@common/response/api-response';
import { CurrentShop, RequireShopPermission, ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { ShopDashboardResponse, ShopLowStockResponse, ShopRevenueResponse, ShopTopProductResponse } from './shop-reporting.responses';
import { ShopReportingService } from './shop-reporting.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

class RangeQuery {
  @ApiPropertyOptional({ example: '2026-09-01', description: 'Mặc định: đầu tháng hiện tại' }) @IsOptional() @Matches(DAY) from?: string;
  @ApiPropertyOptional({ example: '2026-09-30', description: 'Mặc định: hôm nay' }) @IsOptional() @Matches(DAY) to?: string;
}
class RevenueQuery extends RangeQuery {
  @ApiPropertyOptional({ enum: ['day', 'month'], default: 'day' }) @IsOptional() @IsIn(['day', 'month']) granularity?: 'day' | 'month';
}
class TopQuery extends RangeQuery {
  @ApiPropertyOptional({ default: 10 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
class LowStockQuery {
  @ApiPropertyOptional({ default: 5 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) threshold?: number;
  @ApiPropertyOptional({ default: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

/* /shop/reports — chủ/nhân viên gian hàng xem báo cáo của gian hàng mình (PLAN-0017 B4). */
@ApiTags('shop-reports')
@ApiBearerAuth()
@Controller('shop/reports')
@UseGuards(ShopContextGuard)
export class ShopReportingController {
  constructor(private readonly reports: ShopReportingService) {}

  @Get('dashboard')
  @RequireShopPermission('shop.report.read')
  @ApiOkResponse({ type: ShopDashboardResponse })
  @ApiOperation({ summary: 'Tổng quan: hôm nay, tháng này, việc đang chờ, 7 ngày, top 5, trạng thái đơn (của gian hàng mình)' })
  async dashboard(@CurrentShop() shop: ShopContext): Promise<ApiResponse<ShopDashboardResponse>> {
    return ApiResponse.ok(await this.reports.dashboard(shop.shopId));
  }

  @Get('revenue')
  @RequireShopPermission('shop.report.read')
  @ApiOkResponse({ type: ShopRevenueResponse })
  @ApiOperation({ summary: 'Doanh thu của gian hàng mình theo ngày / tháng (tối đa 400 ngày hoặc 60 tháng)' })
  async revenue(@CurrentShop() shop: ShopContext, @Query() q: RevenueQuery): Promise<ApiResponse<ShopRevenueResponse>> {
    const { from, to } = ShopReportingController.range(q);
    return ApiResponse.ok(await this.reports.revenue(shop.shopId, from, to, q.granularity ?? 'day'));
  }

  @Get('top-products')
  @RequireShopPermission('shop.report.read')
  @ApiOkResponse({ type: [ShopTopProductResponse] })
  @ApiOperation({ summary: 'Sản phẩm bán chạy nhất của gian hàng mình trong kỳ (tối đa 400 ngày)' })
  async top(@CurrentShop() shop: ShopContext, @Query() q: TopQuery): Promise<ApiResponse<ShopTopProductResponse[]>> {
    const { from, to } = ShopReportingController.range(q);
    return ApiResponse.ok(await this.reports.topProducts(shop.shopId, from, to, q.limit ?? 10));
  }

  @Get('low-stock')
  @RequireShopPermission('shop.report.read')
  @ApiOkResponse({ type: [ShopLowStockResponse] })
  @ApiOperation({ summary: 'Biến thể sắp hết của gian hàng mình (khả dụng ≤ ngưỡng)' })
  async lowStock(@CurrentShop() shop: ShopContext, @Query() q: LowStockQuery): Promise<ApiResponse<ShopLowStockResponse[]>> {
    return ApiResponse.ok(await this.reports.lowStock(shop.shopId, q.threshold ?? 5, q.limit ?? 100));
  }

  private static range(q: RangeQuery): { from: string; to: string } {
    const today = ShopReportingService.vnDay(new Date());
    return { from: q.from ?? `${today.slice(0, 7)}-01`, to: q.to ?? today };
  }
}
