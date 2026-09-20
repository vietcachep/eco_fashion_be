import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyResponse } from '@common/response/money-response';

export class StockRowResponse {
  @ApiProperty() variantId: string;
  @ApiProperty() productId: string;
  @ApiProperty() productName: string;
  @ApiProperty() productSlug: string;
  @ApiProperty() productStatus: string;
  @ApiProperty() sku: string;
  @ApiProperty() color: string;
  @ApiProperty() size: string;
  @ApiProperty({ description: 'Tồn thô' }) stock: number;
  @ApiProperty({ description: 'Đang giữ cho đơn' }) reserved: number;
  @ApiProperty({ description: 'Có thể bán' }) available: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty() isLow: boolean;
}

export class StockReceiptItemResponse {
  @ApiProperty() variantId: string;
  @ApiProperty() sku: string;
  @ApiProperty() quantity: number;
  @ApiProperty({ type: MoneyResponse }) unitCost: MoneyResponse;
}

export class StockReceiptResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'PN260900001' }) code: string;
  @ApiPropertyOptional({ nullable: true }) supplierName: string | null;
  @ApiPropertyOptional({ nullable: true }) note: string | null;
  @ApiProperty({ example: 'draft', description: 'draft | posted | cancelled' }) status: string;
  @ApiProperty({ type: MoneyResponse }) totalCost: MoneyResponse;
  @ApiProperty({ type: [StockReceiptItemResponse] }) items: StockReceiptItemResponse[];
  @ApiPropertyOptional({ nullable: true }) postedAt: string | null;
  @ApiProperty() createdAt: string;
}

export class StockMovementResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'RECEIPT' }) type: string;
  @ApiProperty() quantity: number;
  @ApiProperty() stockAfter: number;
  @ApiPropertyOptional({ nullable: true }) refType: string | null;
  @ApiPropertyOptional({ nullable: true }) refId: string | null;
  @ApiPropertyOptional({ nullable: true }) note: string | null;
  @ApiProperty() createdAt: string;
}
