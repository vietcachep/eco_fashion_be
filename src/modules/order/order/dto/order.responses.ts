import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyResponse } from '@common/response/money-response';

export class OrderItemResponse {
  @ApiProperty() id: string;
  @ApiProperty() variantId: string;
  @ApiProperty() productId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) imageUrl: string | null;
  @ApiProperty() color: string;
  @ApiProperty() size: string;
  @ApiProperty() sku: string;
  @ApiProperty() quantity: number;
  @ApiProperty({ type: MoneyResponse }) unitPrice: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) lineTotal: MoneyResponse;
  @ApiProperty() reviewed: boolean;
}

export class OrderHistoryResponse {
  @ApiPropertyOptional({ nullable: true }) fromStatus: string | null;
  @ApiProperty() toStatus: string;
  @ApiProperty() toStatusLabel: string;
  @ApiPropertyOptional({ nullable: true }) note: string | null;
  @ApiProperty() createdAt: string;
}

export class BankTransferIntentResponse {
  @ApiProperty() bankCode: string;
  @ApiProperty() accountNumber: string;
  @ApiProperty() accountName: string;
  @ApiProperty({ example: 'DH2609150001' }) transferContent: string;
  @ApiPropertyOptional({ nullable: true }) qrUrl: string | null;
  @ApiProperty() amount: string;
  @ApiPropertyOptional({ nullable: true }) expiresAt: string | null;
}

/* Đơn hàng (FE `OrderResponse`). Tiền do server tính; FE chỉ hiện. */
export class OrderResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'DH2609150001' }) code: string;
  @ApiProperty({ example: 'pending' }) status: string;
  @ApiProperty({ example: 'Chờ xác nhận' }) statusLabel: string;
  @ApiProperty({ example: 'cod' }) paymentMethodCode: string;
  @ApiProperty({ example: 'unpaid' }) paymentStatus: string;
  @ApiPropertyOptional({ nullable: true }) cardBrand: string | null;
  @ApiPropertyOptional({ nullable: true }) cardLast4: string | null;
  @ApiPropertyOptional({ nullable: true }) transactionCode: string | null;
  @ApiProperty() recipientName: string;
  @ApiProperty() recipientPhone: string;
  @ApiProperty() shippingAddress: string;
  @ApiPropertyOptional({ nullable: true }) customerNote: string | null;
  @ApiProperty({ type: [OrderItemResponse] }) items: OrderItemResponse[];
  @ApiProperty({ type: MoneyResponse }) subtotal: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) shippingFee: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) discount: MoneyResponse;
  @ApiPropertyOptional({ nullable: true }) promotion: { code: string; name: string | null } | null;
  @ApiProperty({ type: MoneyResponse }) total: MoneyResponse;
  @ApiPropertyOptional({ type: BankTransferIntentResponse, nullable: true }) paymentIntent: BankTransferIntentResponse | null;
  @ApiPropertyOptional({ nullable: true, description: 'VNPay: URL chuyển hướng để thanh toán' }) paymentUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) paymentExpiresAt: string | null;
  @ApiPropertyOptional({ nullable: true }) trackingUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) cancelReason: string | null;
  @ApiProperty({ type: [OrderHistoryResponse] }) history: OrderHistoryResponse[];
  @ApiProperty({ description: 'Khách còn huỷ được' }) canCancel: boolean;
  @ApiProperty({ description: 'Còn trong hạn đổi trả' }) canReturn: boolean;
  @ApiProperty() createdAt: string;
}

export class OrderSummaryResponse {
  @ApiProperty() code: string;
  @ApiProperty() status: string;
  @ApiProperty() statusLabel: string;
  @ApiProperty() paymentMethodCode: string;
  @ApiProperty() paymentStatus: string;
  @ApiProperty() itemCount: number;
  @ApiProperty({ type: MoneyResponse }) total: MoneyResponse;
  @ApiPropertyOptional({ nullable: true }) firstItemName: string | null;
  @ApiPropertyOptional({ nullable: true }) firstItemImage: string | null;
  @ApiProperty() recipientName: string;
  @ApiProperty() createdAt: string;
}

/* Bảng tiền bước đặt hàng — cùng công thức với POST /orders (FE `CheckoutSummaryResponse`). */
export class CheckoutSummaryResponse {
  @ApiProperty({ type: MoneyResponse }) subtotal: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) shippingFee: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) discount: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) total: MoneyResponse;
  @ApiPropertyOptional({ nullable: true }) promotionCode: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Mã khách gõ bị từ chối — lý do hiện dưới ô nhập' }) promotionError: string | null;
  @ApiProperty() itemCount: number;
  @ApiPropertyOptional({ nullable: true }) provinceName: string | null;
  @ApiProperty({ type: [String], description: 'Cảnh báo dòng (hết hàng, ngừng bán)' }) warnings: string[];
}

export class ReturnItemResponse {
  @ApiProperty() orderItemId: string;
  @ApiProperty() name: string;
  @ApiProperty() color: string;
  @ApiProperty() size: string;
  @ApiProperty() quantity: number;
  @ApiPropertyOptional({ nullable: true }) imageUrl: string | null;
}

export class MediaItemResponse {
  @ApiProperty({ example: 'image' }) type: string;
  @ApiProperty() url: string;
  @ApiProperty() name: string;
}

export class ReturnRequestResponse {
  @ApiProperty() id: string;
  @ApiProperty() orderCode: string;
  @ApiProperty({ example: 'requested' }) status: string;
  @ApiProperty() reason: string;
  @ApiPropertyOptional({ nullable: true }) detail: string | null;
  @ApiPropertyOptional({ nullable: true }) rejectReason: string | null;
  @ApiProperty({ type: MoneyResponse }) refundAmount: MoneyResponse;
  @ApiProperty({ type: [ReturnItemResponse] }) items: ReturnItemResponse[];
  @ApiProperty({ type: [MediaItemResponse] }) evidence: MediaItemResponse[];
  @ApiPropertyOptional({ nullable: true }) processedAt: string | null;
  @ApiProperty() createdAt: string;
}
