import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyResponse } from '@common/response/money-response';
import { CARRIER_CODES } from '../../foundation/order.constants';

/* Khoản hoàn tiền MỚI NHẤT của đơn (payment) — chi tiết đơn/danh sách hiện "đang hoàn tiền" thay vì vẫn ghi "đã thanh toán". null = đơn chưa có khoản hoàn nào. */
export class OrderRefundResponse {
  @ApiProperty({ enum: ['requested', 'processing', 'failed', 'done'], description: 'requested/processing = đang hoàn · failed = chi thất bại (kế toán xử lý lại) · done = đã hoàn' }) status: string;
  @ApiProperty({ type: MoneyResponse }) amount: MoneyResponse;
}

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

/* PLAN-0027 — yêu cầu huỷ đơn đang đóng gói của khách: shop duyệt/từ chối, im lặng quá `dueAt` ⇒ tự chấp nhận. */
export class OrderCancelRequestResponse {
  @ApiProperty({ enum: ['pending', 'accepted', 'rejected', 'auto_accepted'] }) status: string;
  @ApiPropertyOptional({ nullable: true }) reasonCode: string | null;
  @ApiPropertyOptional({ nullable: true }) reasonLabel: string | null;
  @ApiPropertyOptional({ nullable: true }) note: string | null;
  @ApiPropertyOptional({ nullable: true }) requestedAt: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Hạn shop xử lý (đang chờ) — quá hạn hệ thống tự chấp nhận' }) dueAt: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Lý do shop từ chối (khi status = rejected)' }) rejectReason: string | null;
}

/* Đơn hàng (FE `OrderResponse`). Tiền do server tính; FE chỉ hiện. */
import { ShipmentResponse } from '@modules/shipping/queryapi/shipping.queryapi';

export class OrderResponse {
  @ApiPropertyOptional() fulfilmentMode?: string;
  @ApiPropertyOptional() collectionMode?: string;
  @ApiPropertyOptional() carrierCodStatus?: string;
  @ApiPropertyOptional({type:ShipmentResponse,nullable:true}) shipment?: ShipmentResponse | null;
  @ApiPropertyOptional() canShip?: boolean;
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
  @ApiPropertyOptional({ nullable: true, description: 'PayOS: URL chuyển hướng để thanh toán' }) paymentUrl: string | null;
  @ApiProperty({ description: 'Đơn PayOS còn chờ thanh toán nhưng CHƯA tạo được link (PayOS lỗi/chậm lúc đặt) — hiện nút "Thanh toán lại" (POST /payments/payos/retry/:code)' }) linkRetryable: boolean;
  @ApiPropertyOptional({ nullable: true }) paymentExpiresAt: string | null;
  @ApiPropertyOptional({ nullable: true }) trackingUrl: string | null;
  /* PLAN-0031 §2.1 — giao hàng có bằng chứng: hãng + mã vận đơn (đơn đã `shipping` trước khi có tính năng này = null). `trackingUrl` ở trên là link tra cứu (sinh theo hãng). */
  @ApiPropertyOptional({ nullable: true, enum: CARRIER_CODES, description: 'Hãng vận chuyển (ghn | ghtk | viettel_post | jnt | spx | ahamove | ninja_van | vnpost | other)' }) carrier: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Tên hãng để hiển thị' }) carrierName: string | null;
  @ApiPropertyOptional({ nullable: true }) trackingCode: string | null;
  @ApiProperty({ description: 'SHP-13: mã vận đơn này đã dùng cho đơn khác của shop (nghi gian lận) — CHỈ có ý nghĩa ở API shop/sàn; luôn false với khách' }) trackingReused: boolean;
  /* PLAN-0031 §2.4 (SHP-09): đơn huỷ vì giao thất bại — lúc báo + mã lý do + lúc hàng về kho (đã nhập kho). `canConfirmGoodsReturned` = shop còn bấm "Hàng đã về kho" được (hàng chưa về, trong 30 ngày). */
  @ApiPropertyOptional({ nullable: true }) deliveryFailedAt: string | null;
  @ApiPropertyOptional({ nullable: true }) deliveryFailedReason: string | null;
  @ApiPropertyOptional({ nullable: true }) goodsReturnedAt: string | null;
  @ApiProperty({ description: 'Shop xác nhận được "hàng đã về kho" (POST /shop/orders/:code/goods-returned)' }) canConfirmGoodsReturned: boolean;
  @ApiPropertyOptional({ nullable: true }) cancelReason: string | null;
  @ApiProperty({ type: [OrderHistoryResponse] }) history: OrderHistoryResponse[];
  /* PLAN-0027 — hạn chót xử lý của shop (NULL = đơn cũ / chưa có hạn) và dấu vết huỷ. */
  @ApiPropertyOptional({ nullable: true, description: 'Hạn shop xác nhận đơn (đơn chờ xác nhận)' }) confirmDueAt: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Hạn shop giao đơn (đơn đã xác nhận / đang đóng gói)' }) shipDueAt: string | null;
  @ApiProperty({ description: 'Shop đã dùng lượt gia hạn giao (chỉ 1 lần)' }) shipExtended: boolean;
  @ApiPropertyOptional({ nullable: true, description: 'Mã lý do huỷ (docs/10 §7)' }) cancelReasonCode: string | null;
  @ApiPropertyOptional({ nullable: true, enum: ['customer', 'shop', 'platform', 'system'], description: 'Ai huỷ đơn' }) cancelledBy: string | null;
  @ApiPropertyOptional({ type: OrderCancelRequestResponse, nullable: true, description: 'Yêu cầu huỷ của khách (đơn đang đóng gói)' }) cancelRequest: OrderCancelRequestResponse | null;
  @ApiProperty({ description: 'Khách gửi được yêu cầu huỷ (đơn đang đóng gói, chưa có yêu cầu nào)' }) canRequestCancel: boolean;
  @ApiProperty({ description: 'Khách đổi được địa chỉ nhận (chờ xác nhận / đã xác nhận)' }) canChangeAddress: boolean;
  @ApiProperty({ description: 'Khách bấm được "Đã nhận hàng" (đã giao, không có đổi trả đang mở)' }) canMarkReceived: boolean;
  @ApiProperty({ description: 'Khách còn huỷ được' }) canCancel: boolean;
  @ApiProperty({ description: 'Còn trong hạn đổi trả' }) canReturn: boolean;
  @ApiProperty({ description: 'Khách báo "chưa nhận hàng" được: đơn đang giao, hoặc vừa báo đã giao trong return.not_received_days (và chưa có yêu cầu đổi trả giữ hết hàng)' }) canReportNotReceived: boolean;
  @ApiPropertyOptional({ type: OrderRefundResponse, nullable: true, description: 'Khoản hoàn tiền mới nhất của đơn (payment)' }) refund: OrderRefundResponse | null;
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
  @ApiPropertyOptional({ type: OrderRefundResponse, nullable: true, description: 'Khoản hoàn tiền mới nhất của đơn (payment)' }) refund: OrderRefundResponse | null;
  /* PLAN-0027 — cột "Hạn xác nhận / giao" đếm ngược ở danh sách đơn của shop (NULL = đơn cũ chưa có hạn). */
  @ApiPropertyOptional({ nullable: true, description: 'Hạn shop xác nhận đơn' }) confirmDueAt: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Hạn shop giao đơn' }) shipDueAt: string | null;
  @ApiPropertyOptional({ nullable: true, enum: ['pending', 'accepted', 'rejected', 'auto_accepted'], description: 'Khách có yêu cầu huỷ đơn đang đóng gói (pending = shop cần xử lý)' }) cancelRequestStatus: string | null;
  @ApiProperty() createdAt: string;
}

/* PLAN-0014 bước 7 — xem trước 1 gói hàng (1 shop) sẽ tách thành TRƯỚC khi đặt (checkout sẽ tạo bấy nhiêu Order
   con). Phí ship tính RIÊNG theo subtotal của CHÍNH gói này (giải thích ở ShopGroupPriced/order.service.ts). */
export class CheckoutShopGroupResponse {
  @ApiPropertyOptional() shippingQuoteId?: string;
  @ApiPropertyOptional() shippingQuoteExpiresAt?: string;
  @ApiPropertyOptional() shippingFeeSource?: string;
  @ApiPropertyOptional() fulfilmentMode?: string;
  @ApiProperty() shopId: string;
  @ApiProperty() shopName: string;
  @ApiProperty({ description: 'PLAN-0020: gian hàng này nhận COD (đã đặt cọc, ví > 0) — false thì khách phải chọn PayOS cho giỏ có shop này' }) codAvailable: boolean;
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
