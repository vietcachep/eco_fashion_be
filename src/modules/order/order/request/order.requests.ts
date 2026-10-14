import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ToBoolean } from '@common/utils/transform';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { ORDER_STATUS, PAYMENT_METHOD } from '../../foundation/order.constants';

const PHONE_VN = /^(0|\+84)(\d{9,10})$/;

/* Địa chỉ nhập tay ở bước đặt hàng (FE checkoutSchema: fullName, phone, province, district, ward, address). */
export class CheckoutAddressInput {
  @ApiProperty({ example: 'Nguyễn Văn An' }) @IsString() @Length(2, 120) recipientName: string;
  @ApiProperty({ example: '0901234567' }) @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' }) phone: string;
  @ApiProperty({ example: 'TP. Hồ Chí Minh' }) @IsString() @Length(2, 100) provinceName: string;
  @ApiPropertyOptional({ example: 'Quận 1' }) @IsOptional() @IsString() @MaxLength(100) districtName?: string;
  @ApiPropertyOptional({ example: 'Phường Bến Nghé' }) @IsOptional() @IsString() @MaxLength(100) wardName?: string;
  @ApiProperty({ example: '12 Nguyễn Huệ' }) @IsString() @Length(3, 255) street: string;
}

export class CheckoutSummaryQuery {
  @ApiPropertyOptional({ example: 'FREESHIP' }) @IsOptional() @IsString() @MaxLength(40) voucherCode?: string;
  @ApiPropertyOptional({ example: 'FREESHIP,SHOPA10', description: 'Nhiều mã cách nhau dấu phẩy: tối đa 1 mã sàn + 1 mã gian hàng cho mỗi shop trong giỏ' })
  @IsOptional() @Transform(({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.split(',').map((x) => x.trim()).filter(Boolean) : value)) @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(40, { each: true }) voucherCodes?: string[];
  @ApiPropertyOptional({ description: 'Tỉnh/thành để tính ship (bỏ trống = địa chỉ mặc định)' }) @IsOptional() @IsString() @MaxLength(100) province?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() addressId?: string;
}

/* Lệnh đặt hàng: chỉ gửi thứ CHỈ CLIENT biết (địa chỉ, cách trả, ghi chú, mã) — KHÔNG gửi tiền, KHÔNG gửi số thẻ. */
export class CreateOrderRequest {
  @ApiPropertyOptional({ description: 'Địa chỉ trong sổ (ưu tiên nếu có)' }) @IsOptional() @IsUUID() addressId?: string;
  @ApiPropertyOptional({ type: CheckoutAddressInput, description: 'Hoặc nhập tay' }) @IsOptional() @ValidateNested() @Type(() => CheckoutAddressInput) address?: CheckoutAddressInput;
  @ApiProperty({ enum: [...Object.values(PAYMENT_METHOD), 'card'], example: 'cod', description: '`card` = VNPay thẻ quốc tế' }) @IsIn([...Object.values(PAYMENT_METHOD), 'card']) paymentMethodCode: string;
  @ApiPropertyOptional({ description: 'VNPay: VNBANK (ATM) · INTCARD (Visa/Master) · VNPAYQR' }) @IsOptional() @IsIn(['VNBANK', 'INTCARD', 'VNPAYQR']) bankCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ example: 'FREESHIP', nullable: true }) @IsOptional() @IsString() @MaxLength(40) voucherCode?: string | null;
  @ApiPropertyOptional({ type: [String], example: ['SHOPA10'], description: 'Mã bổ sung (gộp với voucherCode): tối đa 1 mã sàn + 1 mã gian hàng cho mỗi shop trong giỏ' })
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(40, { each: true }) voucherCodes?: string[];
}

export class CancelOrderRequest {
  @ApiProperty({ example: 'Đổi ý, không muốn mua nữa' }) @IsString() @Length(3, 255) reason: string;
}

export class OrderListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: Object.values(ORDER_STATUS) }) @IsOptional() @IsIn(Object.values(ORDER_STATUS)) status?: string;
}

export class MyOrderListQuery extends OrderListQuery {
  @ApiPropertyOptional({ description: 'true = trả OrderResponse đầy đủ (dòng hàng, tiền) thay vì tóm tắt — trang "Đơn của tôi" của FE vẽ từng món' }) @IsOptional() @ToBoolean() @IsBoolean() full?: boolean;
}

export class AdminOrderListQuery extends OrderListQuery {
  @ApiPropertyOptional({ description: 'Mã đơn / tên / SĐT người nhận' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['unpaid', 'processing', 'paid', 'refunded', 'partially_refunded']) paymentStatus?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn([...Object.values(PAYMENT_METHOD)]) paymentMethodCode?: string;
}

export class UpdateOrderStatusRequest {
  @ApiProperty({ enum: ['confirmed', 'packing', 'shipping', 'delivered', 'completed'] }) @IsIn(['confirmed', 'packing', 'shipping', 'delivered', 'completed']) status: string;
  @ApiPropertyOptional({ example: 'https://tracking.ghn.vn/?order=GHN123' }) @IsOptional() @IsString() @MaxLength(500) trackingUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class MediaItemInput {
  @ApiProperty({ enum: ['image', 'video'] }) @IsIn(['image', 'video']) type: string;
  @ApiProperty() @IsString() @MaxLength(500) url: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
}

export class ReturnItemInput {
  @ApiProperty() @IsUUID() orderItemId: string;
  @ApiProperty({ example: 1 }) @Type(() => Number) @IsInt() @Min(1) quantity: number;
}

export class CreateReturnRequest {
  @ApiProperty({ example: 'Không vừa size' }) @IsString() @Length(3, 255) reason: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) detail?: string;
  @ApiProperty({ type: [ReturnItemInput] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ReturnItemInput) items: ReturnItemInput[];
  @ApiProperty({ type: [MediaItemInput], description: 'Ảnh/video minh chứng ≥ 1 (upload trước qua POST /uploads/media)' }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => MediaItemInput) evidence: MediaItemInput[];
}

export class ProcessReturnRequest {
  @ApiProperty({ enum: ['approved', 'rejected'] }) @IsIn(['approved', 'rejected']) decision: string;
  @ApiPropertyOptional({ description: 'Bắt buộc khi từ chối' }) @IsOptional() @IsString() @MaxLength(500) rejectReason?: string;
  @ApiPropertyOptional({ description: 'Ghi đè số tiền hoàn (VND, mặc định = tổng dòng trả)' }) @IsOptional() @Matches(/^\d+$/) refundAmount?: string;
}

export class ReturnListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['requested', 'approved', 'rejected', 'refunded'] }) @IsOptional() @IsIn(['requested', 'approved', 'rejected', 'refunded']) status?: string;
}
