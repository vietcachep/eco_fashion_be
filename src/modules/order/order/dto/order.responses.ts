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
  /* PLAN-0014 bước 7 — mỗi đơn thuộc ĐÚNG 1 gian hàng. FE hiện tên shop trên mỗi đơn con của OrderGroup. */
  @ApiProperty() shopId: string;
  /* Slug gian hàng để FE link tới trang shop (`/shop/{slug}`); chỉ có ở đường khách hàng. */
  @ApiPropertyOptional() shopSlug?: string;
  @ApiProperty() shopName: string;
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
  @ApiPropertyOptional({ nullable: true, description: 'Voucher SÀN (sàn chịu chi phí)' }) promotion: { code: string; name: string | null } | null;
  @ApiPropertyOptional({ nullable: true, description: 'Voucher GIAN HÀNG (shop chịu chi phí)' }) shopPromotion: { code: string; name: string | null } | null;
  @ApiProperty({ type: MoneyResponse, description: 'Phần giảm do shop chịu' }) shopDiscount: MoneyResponse;
  @ApiProperty({ type: MoneyResponse, description: 'Phần giảm do sàn chịu (sàn hoàn lại cho shop)' }) platformDiscount: MoneyResponse;
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

/* Đơn CHA (PLAN-0014 bước 7) — 1 lần checkout, giỏ có hàng từ nhiều gian hàng → nhiều `orders` con, mỗi con
   giữ nguyên state machine/thanh toán riêng của nó. Giỏ single-shop cũng trả về hình dạng này (nhóm 1-đơn)
   để FE chỉ cần xử lý MỘT hình dạng dữ liệu. OrderGroup không có status riêng — xem status ở từng đơn con. */
export class OrderGroupResponse {
  @ApiProperty({ example: 'DHN2609150001' }) code: string;
  @ApiProperty() recipientName: string;
  @ApiProperty() recipientPhone: string;
  @ApiProperty() shippingAddress: string;
  @ApiProperty({ type: MoneyResponse }) subtotal: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) shippingFee: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) discount: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) total: MoneyResponse;
  @ApiProperty({ type: [OrderResponse] }) orders: OrderResponse[];
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

/* PLAN-0014 bước 7 — xem trước 1 gói hàng (1 shop) sẽ tách thành TRƯỚC khi đặt (checkout sẽ tạo bấy nhiêu Order
   con). Phí ship tính RIÊNG theo subtotal của CHÍNH gói này (giải thích ở ShopGroupPriced/order.service.ts). */
export class CheckoutShopGroupResponse {
  @ApiProperty() shopId: string;
  @ApiProperty() shopName: string;
  @ApiProperty() itemCount: number;
  @ApiProperty({ type: MoneyResponse }) subtotal: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) shippingFee: MoneyResponse;
  @ApiProperty({ type: MoneyResponse, description: 'Tổng giảm của đơn con này (voucher shop + phần voucher sàn phân bổ)' }) discount: MoneyResponse;
  @ApiProperty({ type: MoneyResponse, description: 'Khách phải trả cho đơn con này' }) total: MoneyResponse;
}

/* Từng mã khách đã nhập ở bước đặt hàng — nhận hay bị từ chối, giảm bao nhiêu. */
export class CheckoutVoucherResponse {
  @ApiProperty() code: string;
  @ApiProperty({ enum: ['platform', 'shop'], description: 'platform = mã của sàn · shop = mã của gian hàng' }) scope: string;
  @ApiPropertyOptional({ nullable: true }) shopId: string | null;
  @ApiPropertyOptional({ nullable: true }) shopName: string | null;
  @ApiProperty({ description: 'Mã được nhận (true) hay bị từ chối (false)' }) ok: boolean;
  @ApiPropertyOptional({ nullable: true, description: 'Lý do từ chối (tiếng Việt)' }) error: string | null;
  @ApiProperty({ type: MoneyResponse }) discount: MoneyResponse;
}

/* Số đơn con của gian hàng theo từng trạng thái (đếm cả đơn đã huỷ/hoàn) — thẻ thống kê màn đơn hàng vendor. */
export class ShopOrderSummaryResponse {
  @ApiProperty({ example: 5 }) pending: number;
  @ApiProperty({ example: 3 }) confirmed: number;
  @ApiProperty({ example: 2 }) packing: number;
  @ApiProperty({ example: 1 }) shipping: number;
  @ApiProperty({ example: 10 }) delivered: number;
  @ApiProperty({ example: 50 }) completed: number;
  @ApiProperty({ example: 2 }) cancelled: number;
  @ApiProperty({ example: 0 }) returned: number;
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
  /* PLAN-0014 bước 7 — giỏ có hàng từ N shop → đặt hàng sẽ tạo N đơn con (1 đơn cha). FE hiện rõ để khách biết
     trước sẽ nhận N gói hàng, phí ship tính riêng từng gói — không phải 1 đơn duy nhất như trước. */
  @ApiProperty({ type: [CheckoutShopGroupResponse] }) shopGroups: CheckoutShopGroupResponse[];
  /* Mỗi đơn dùng tối đa 1 mã sàn + 1 mã gian hàng cho mỗi shop trong giỏ; `promotionCode/promotionError` giữ cho FE cũ. */
  @ApiProperty({ type: [CheckoutVoucherResponse] }) vouchers: CheckoutVoucherResponse[];
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
