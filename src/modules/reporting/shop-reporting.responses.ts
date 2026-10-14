import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyResponse } from '@common/response/money-response';

/*
 * DTO response của /shop/reports/* (PLAN-0017 B4). Viết thành class có @ApiProperty để Swagger khai đúng schema ⇒ Orval sinh kiểu
 * thật thay vì `unknown`. Service trả đúng hình các class này (khớp cấu trúc), không thêm/bớt trường so với interface cũ —
 * ngoại lệ duy nhất: `ShopLowStockResponse.variantLabel` (tuỳ chọn).
 */

export class ShopDailyPointResponse {
  @ApiProperty({ example: '2026-09-15', description: 'yyyy-mm-dd theo giờ Việt Nam' }) day: string;
  @ApiProperty() orderCount: number;
  @ApiProperty() paidCount: number;
  @ApiProperty() cancelledCount: number;
  @ApiProperty({ type: MoneyResponse }) revenue: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) discount: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) shippingFee: MoneyResponse;
  @ApiProperty() itemsSold: number;
  @ApiProperty() newCustomers: number;
  @ApiProperty({ type: MoneyResponse }) refunded: MoneyResponse;
}

export class ShopMonthSummaryResponse {
  @ApiProperty({ type: MoneyResponse }) revenue: MoneyResponse;
  @ApiProperty() orderCount: number;
  @ApiProperty() paidCount: number;
  @ApiProperty() itemsSold: number;
  @ApiProperty() newCustomers: number;
  @ApiProperty({ type: MoneyResponse }) refunded: MoneyResponse;
}

export class ShopPendingResponse {
  @ApiProperty() awaitingConfirm: number;
  @ApiProperty() packing: number;
  @ApiProperty() shipping: number;
  @ApiProperty() lowStock: number;
}

export class ShopOrderStatusCountResponse {
  @ApiProperty({ example: 'pending' }) status: string;
  @ApiProperty() count: number;
}

export class ShopTopProductResponse {
  @ApiProperty() productId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) imageUrl: string | null;
  @ApiProperty({ description: 'Số lượng bán ròng (đã trừ hàng khách trả và đã hoàn tiền)' }) quantity: number;
  @ApiProperty({ type: MoneyResponse, description: 'Doanh thu ròng của dòng hàng (đã trừ giảm giá của shop và hàng đã trả)' }) revenue: MoneyResponse;
  @ApiProperty() orderCount: number;
}

export class ShopLowStockResponse {
  @ApiProperty() variantId: string;
  @ApiProperty() productId: string;
  @ApiProperty() productName: string;
  @ApiProperty() slug: string;
  @ApiProperty() sku: string;
  @ApiProperty({ description: 'Rỗng với sản phẩm ngành hàng mới (dynamic) — xem variantLabel' }) colorName: string;
  @ApiProperty({ description: 'Rỗng với sản phẩm ngành hàng mới (dynamic) — xem variantLabel' }) sizeCode: string;
  @ApiProperty() stock: number;
  @ApiProperty() reserved: number;
  @ApiProperty() available: number;
  @ApiPropertyOptional({ example: '128GB / Đen', description: 'Mô tả biến thể: các tuỳ chọn ghép bằng " / " (dynamic) hoặc "màu / size" (thời trang)' }) variantLabel?: string;
}

export class ShopRevenuePointResponse {
  @ApiProperty({ example: '2026-09-15', description: 'yyyy-mm-dd (day) hoặc yyyy-mm (month)' }) period: string;
  @ApiProperty({ type: MoneyResponse }) revenue: MoneyResponse;
  @ApiProperty() orderCount: number;
  @ApiProperty() paidCount: number;
  @ApiProperty() cancelledCount: number;
  @ApiProperty() itemsSold: number;
  @ApiProperty({ type: MoneyResponse }) discount: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) refunded: MoneyResponse;
}

export class ShopRevenueTotalResponse {
  @ApiProperty({ type: MoneyResponse }) revenue: MoneyResponse;
  @ApiProperty() orderCount: number;
  @ApiProperty() paidCount: number;
  @ApiProperty() cancelledCount: number;
  @ApiProperty() itemsSold: number;
  @ApiProperty({ type: MoneyResponse }) discount: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) refunded: MoneyResponse;
}

export class ShopRevenueResponse {
  @ApiProperty({ example: '2026-09-01' }) from: string;
  @ApiProperty({ example: '2026-09-30' }) to: string;
  @ApiProperty({ enum: ['day', 'month'] }) granularity: 'day' | 'month';
  @ApiProperty({ type: [ShopRevenuePointResponse] }) points: ShopRevenuePointResponse[];
  @ApiProperty({ type: ShopRevenueTotalResponse }) total: ShopRevenueTotalResponse;
}

export class ShopDashboardResponse {
  @ApiProperty({ type: ShopDailyPointResponse }) today: ShopDailyPointResponse;
  @ApiProperty({ type: ShopMonthSummaryResponse }) month: ShopMonthSummaryResponse;
  @ApiProperty({ type: ShopPendingResponse }) pending: ShopPendingResponse;
  @ApiProperty({ type: [ShopDailyPointResponse] }) last7Days: ShopDailyPointResponse[];
  @ApiProperty({ type: [ShopTopProductResponse] }) topProducts: ShopTopProductResponse[];
  @ApiProperty({ type: [ShopOrderStatusCountResponse] }) orderStatus: ShopOrderStatusCountResponse[];
  @ApiProperty({ example: '2026-09-15T03:00:00.000Z' }) generatedAt: string;
}
