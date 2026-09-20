import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ApiResponse } from '@common/response/api-response';
import { RequirePermission } from '@common/security/decorators';
import { DashboardResponse, InventorySummary, LowStockRow, ReportingService, RevenueResponse, TopProductRow } from './reporting.service';

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
class RecomputeRequest {
  @ApiProperty({ example: '2026-09-01' }) @Matches(DAY) from: string;
  @ApiProperty({ example: '2026-09-15' }) @Matches(DAY) to: string;
}

/* /admin/reports — dashboard, doanh thu theo kỳ, bán chạy, tồn kho (docs/06 mục reporting). */
@ApiTags('admin-reports')
@ApiBearerAuth()
@Controller('admin/reports')
export class AdminReportingController {
  constructor(private readonly reports: ReportingService) {}

  @Get('dashboard') @RequirePermission('reporting.dashboard.read') @ApiOperation({ summary: 'Tổng quan: hôm nay, tháng này, việc đang chờ, 7 ngày, top 5, trạng thái đơn' })
  async dashboard(): Promise<ApiResponse<DashboardResponse>> {
    return ApiResponse.ok(await this.reports.dashboard());
  }

  @Get('revenue') @RequirePermission('reporting.revenue.read') @ApiOperation({ summary: 'Doanh thu theo ngày / tháng (từ daily_sales)' })
  async revenue(@Query() q: RevenueQuery): Promise<ApiResponse<RevenueResponse>> {
    const { from, to } = AdminReportingController.range(q);
    return ApiResponse.ok(await this.reports.revenue(from, to, q.granularity ?? 'day'));
  }

  @Get('top-products') @RequirePermission('reporting.revenue.read') @ApiOperation({ summary: 'Sản phẩm bán chạy trong kỳ' })
  async top(@Query() q: TopQuery): Promise<ApiResponse<TopProductRow[]>> {
    const { from, to } = AdminReportingController.range(q);
    return ApiResponse.ok(await this.reports.topProducts(from, to, q.limit ?? 10));
  }

  @Get('low-stock') @RequirePermission('reporting.inventory.read') @ApiOperation({ summary: 'Biến thể sắp hết (khả dụng ≤ ngưỡng)' })
  async lowStock(@Query() q: LowStockQuery): Promise<ApiResponse<LowStockRow[]>> {
    return ApiResponse.ok(await this.reports.lowStock(q.threshold ?? 5, q.limit ?? 100));
  }

  @Get('inventory') @RequirePermission('reporting.inventory.read') @ApiOperation({ summary: 'Tổng quan tồn kho: số SP/biến thể, tồn, giữ chỗ, giá trị tồn' })
  async inventory(): Promise<ApiResponse<InventorySummary>> {
    return ApiResponse.ok(await this.reports.inventorySummary());
  }

  @Post('recompute') @HttpCode(HttpStatus.OK) @RequirePermission('reporting.revenue.read') @ApiOperation({ summary: 'Tính lại daily_sales cho khoảng ngày (tối đa 400 ngày)' })
  async recompute(@Body() body: RecomputeRequest): Promise<ApiResponse<{ days: number }>> {
    return ApiResponse.ok({ days: await this.reports.recomputeRange(body.from, body.to) }, 'Đã tính lại số liệu');
  }

  private static range(q: RangeQuery): { from: string; to: string } {
    const today = ReportingService.vnDay(new Date());
    return { from: q.from ?? `${today.slice(0, 7)}-01`, to: q.to ?? today };
  }
}
