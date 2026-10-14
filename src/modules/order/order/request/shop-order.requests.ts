import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { ORDER_STATUS, PAYMENT_METHOD } from '../../foundation/order.constants';

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

  /* Hiển thị cho khách bấm vào → chỉ nhận https (chặn `javascript:`, `data:`, `http` thường, đường dẫn tương đối). */
  @ApiPropertyOptional({ example: 'https://tracking.ghn.vn/?order=GHN123', description: 'URL theo dõi vận chuyển (chỉ https)' })
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

/* Huỷ đơn hàng (vendor) — chỉ khi đơn chờ xác nhận / đã xác nhận (chưa đóng gói). */
export class ShopCancelOrderRequest {
  @ApiProperty({ example: 'Sản phẩm hết hàng', description: 'Lý do huỷ đơn' })
  @IsString()
  @Length(5, 255)
  reason: string;
}
