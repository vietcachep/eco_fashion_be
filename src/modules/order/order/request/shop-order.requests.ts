import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, Length, Matches, MaxLength } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { CARRIER_CODES, DELIVERY_FAILED_REASONS, ORDER_STATUS, PAYMENT_METHOD, SHOP_CANCEL_REASONS, TRACKING_CODE_PATTERN } from '../../foundation/order.constants';

/* Danh sách đơn của gian hàng — lọc theo trạng thái và tìm kiếm. */
export class ShopOrderListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: Object.values(ORDER_STATUS), description: 'Lọc theo trạng thái' })
  @IsOptional()
  @IsIn(Object.values(ORDER_STATUS))
  status?: string;

  @ApiPropertyOptional({ enum: ['unpaid', 'processing', 'paid', 'refunded', 'partially_refunded'], description: 'Lọc theo trạng thái thanh toán' })
  @IsOptional()
  @IsIn(['unpaid', 'processing', 'paid', 'refunded', 'partially_refunded'])
  paymentStatus?: string;

  @ApiPropertyOptional({ enum: Object.values(PAYMENT_METHOD), description: 'Lọc theo phương thức thanh toán' })
  @IsOptional()
  @IsIn(Object.values(PAYMENT_METHOD))
  paymentMethodCode?: string;

  @ApiPropertyOptional({ description: 'Tìm kiếm theo mã đơn, tên / SĐT người nhận' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

/* Cập nhật trạng thái đơn hàng (vendor). Chỉ cho phép chuyển từ pending→confirmed→packing→shipping→delivered. */
export class ShopUpdateOrderStatusRequest {
  @ApiProperty({ enum: ['confirmed', 'packing', 'shipping', 'delivered'], description: 'Trạng thái tiếp theo cho phép' })
  @IsIn(['confirmed', 'packing', 'shipping', 'delivered'])
  status: string;

  /* PLAN-0031 §2.1 / FUL-08: BẮT BUỘC khi status = shipping (OrderService.updateStatus kiểm ⇒ 400 ORDER_TRACKING_REQUIRED); các trạng thái khác bỏ qua. */
  @ApiPropertyOptional({ enum: CARRIER_CODES, example: 'ghn', description: 'Hãng vận chuyển — BẮT BUỘC khi status = shipping' })
  @IsOptional()
  @IsIn(CARRIER_CODES)
  carrier?: string;

  @ApiPropertyOptional({ example: 'GHN123456789', description: 'Mã vận đơn (4–40 ký tự: chữ, số, dấu gạch ngang) — BẮT BUỘC khi status = shipping' })
  @IsOptional()
  @Matches(TRACKING_CODE_PATTERN, { message: 'Mã vận đơn gồm 4–40 ký tự chữ, số hoặc dấu gạch ngang' })
  trackingCode?: string;

  /* Hiển thị cho khách bấm vào → chỉ nhận https (chặn `javascript:`, `data:`, `http` thường, đường dẫn tương đối). Link tra cứu của hãng có mẫu (ghn, ghtk, …) do hệ thống tự sinh — chỉ hãng `other`/ahamove mới dùng link này. */
  @ApiPropertyOptional({ example: 'https://tracking.example.com/?order=ABC123', description: 'URL theo dõi vận chuyển (chỉ https) — chỉ dùng khi hãng không có mẫu link (other, ahamove)' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  trackingUrl?: string;

  @ApiPropertyOptional({ description: 'Ghi chú' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/*
 * Huỷ đơn hàng (vendor) — PLAN-0027: pending / confirmed / packing (quyền `shop.order.cancel`). Gửi `reasonCode` (+ `note`) hoặc `reason` tự do (API cũ); cần ít nhất một lý do đọc được (≥ 5 ký tự — kiểm ở service).
 * Mã `out_of_stock` / `price_error` (và huỷ đơn đã đóng gói) bị tính điểm vi phạm.
 */
export class ShopCancelOrderRequest {
  @ApiPropertyOptional({ enum: SHOP_CANCEL_REASONS, example: 'out_of_stock', description: 'Mã lý do (thiếu ⇒ other)' })
  @IsOptional()
  @IsIn(SHOP_CANCEL_REASONS)
  reasonCode?: string;

  @ApiPropertyOptional({ example: 'Sản phẩm hết hàng', description: 'Lý do huỷ tự do' })
  @IsOptional()
  @IsString()
  @Length(5, 255)
  reason?: string;

  @ApiPropertyOptional({ example: 'Lô hàng về trễ 2 tuần' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

/* Từ chối yêu cầu huỷ của khách / gia hạn giao: lý do bắt buộc ≥ 10 ký tự (khách và CSKH đều đọc được). */
export class ShopReasonRequest {
  @ApiProperty({ example: 'Hàng đã giao cho đơn vị vận chuyển, không thể huỷ' })
  @IsString()
  @Length(10, 500)
  reason: string;
}

/*
 * Shop báo đơn đang giao GIAO KHÔNG THÀNH CÔNG (PLAN-0022): đơn → huỷ; `goodsReturned` = hàng đã về tay shop (⇒ nhập kho lại); đơn đã thu tiền online ⇒ hoàn đủ cho khách.
 */
export class DeliveryFailedRequest {
  @ApiProperty({ enum: DELIVERY_FAILED_REASONS, example: 'refused', description: 'refused = khách từ chối nhận · unreachable = không liên lạc được · wrong_address = sai/không tìm thấy địa chỉ · lost = thất lạc · damaged = hư hỏng khi vận chuyển · other = khác' })
  @IsIn(DELIVERY_FAILED_REASONS)
  reasonCode: string;

  @ApiProperty({ example: 'Khách từ chối nhận, shipper đã thử giao 3 lần', description: 'Ghi chú cụ thể (5–500 ký tự) — khách và CSKH đều thấy' })
  @IsString()
  @Length(5, 500)
  note: string;

  @ApiProperty({ example: false, description: 'true = hàng đã về tay shop ⇒ nhập kho lại; false = chưa về (không nhập kho)' })
  @IsBoolean()
  goodsReturned: boolean;
}
