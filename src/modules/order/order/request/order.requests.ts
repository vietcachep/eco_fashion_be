import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ToBoolean } from '@common/utils/transform';
import { ValidateIf, IsInt, Min, ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateNested } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { CUSTOMER_CANCEL_REASONS, ORDER_STATUS, PAYMENT_METHOD, PLATFORM_CANCEL_REASONS } from '../../foundation/order.constants';

const PHONE_VN = /^(0|\+84)(\d{9,10})$/;

/* Địa chỉ nhập tay ở bước đặt hàng (FE checkoutSchema: fullName, phone, province, district, ward, address). */
export class CheckoutAddressInput {
  @ApiPropertyOptional() @IsOptional() @IsIn(['legacy_3level']) addressSystem?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) ghnProvinceId?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) ghnDistrictId?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) ghnWardCode?: string;
  @ApiProperty({ example: 'Nguyễn Văn An' }) @IsString() @Length(2, 120) recipientName: string;
  @ApiProperty({ example: '0901234567' }) @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' }) phone: string;
  @ApiProperty({ example: 'TP. Hồ Chí Minh' }) @IsString() @Length(2, 100) provinceName: string;
  @ApiPropertyOptional({ example: 'Quận 1' }) @IsOptional() @IsString() @MaxLength(100) districtName?: string;
  @ApiPropertyOptional({ example: 'Phường Bến Nghé' }) @IsOptional() @IsString() @MaxLength(100) wardName?: string;
  @ApiProperty({ example: '12 Nguyễn Huệ' }) @IsString() @Length(3, 255) street: string;
}

export class CheckoutSummaryQuery {
  @ApiPropertyOptional({enum:['cod','payos']}) @IsOptional() @IsIn(['cod','payos']) paymentMethodCode?: string;
  @ApiPropertyOptional({ example: 'FREESHIP' }) @IsOptional() @IsString() @MaxLength(40) voucherCode?: string;
  @ApiPropertyOptional({ example: 'FREESHIP,SHOPA10', description: 'Nhiều mã cách nhau dấu phẩy: tối đa 1 mã sàn + 1 mã gian hàng cho mỗi shop trong giỏ' })
  @IsOptional() @Transform(({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.split(',').map((x) => x.trim()).filter(Boolean) : value)) @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(40, { each: true }) voucherCodes?: string[];
  @ApiPropertyOptional({ description: 'Tỉnh/thành để tính ship (bỏ trống = địa chỉ mặc định)' }) @IsOptional() @IsString() @MaxLength(100) province?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() addressId?: string;
}

/* Lệnh đặt hàng: chỉ gửi thứ CHỈ CLIENT biết (địa chỉ, cách trả, ghi chú, mã) — KHÔNG gửi tiền, KHÔNG gửi số thẻ. */
export class CreateOrderRequest {
  @ApiPropertyOptional({type:[String]}) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('loose',{each:true}) quoteIds?: string[];
  @ApiPropertyOptional({ description: 'Địa chỉ trong sổ (ưu tiên nếu có)' }) @IsOptional() @IsUUID() addressId?: string;
  @ApiPropertyOptional({ type: CheckoutAddressInput, description: 'Hoặc nhập tay' }) @IsOptional() @ValidateNested() @Type(() => CheckoutAddressInput) address?: CheckoutAddressInput;
  @ApiProperty({ enum: Object.values(PAYMENT_METHOD), example: 'cod', description: 'Chỉ còn `cod` (shipper thu hộ cho sàn) hoặc `payos`' }) @IsIn(Object.values(PAYMENT_METHOD)) paymentMethodCode: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ example: 'FREESHIP', nullable: true }) @IsOptional() @IsString() @MaxLength(40) voucherCode?: string | null;
  @ApiPropertyOptional({ type: [String], example: ['SHOPA10'], description: 'Mã bổ sung (gộp với voucherCode): tối đa 1 mã sàn + 1 mã gian hàng cho mỗi shop trong giỏ' })
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(40, { each: true }) voucherCodes?: string[];
  /* CK-05 (PLAN-0032 §2.1): KHÔNG phải để server tin số tiền này — chỉ là "điều khách đã thấy" để server so với số TỰ TÍNH lúc đặt; lệch ⇒ 409 ORDER_PRICE_CHANGED. Số nguyên VND dạng chuỗi (nhận cả số nguyên JSON). */
  @ApiPropertyOptional({ example: '1250000', description: 'Tổng tiền cả lần đặt (Σ total các đơn con) khách đã thấy ở `GET /checkout/summary` (`total.amount`). Có gửi mà khác số server tính lại lúc đặt ⇒ 409 `ORDER_PRICE_CHANGED` kèm báo giá mới ở `data`, KHÔNG tạo đơn/giữ kho/ghi voucher. Bỏ trống ⇒ không kiểm (tương thích client cũ).' })
  @IsOptional() @Transform(({ value }: { value: unknown }): unknown => (typeof value === 'number' && Number.isInteger(value) ? String(value) : value)) @IsString() @Matches(/^\d{1,14}(\.0+)?$/, { message: 'expectedTotal phải là số tiền VND nguyên không âm (vd "1250000")' }) expectedTotal?: string;
}

/* Khách huỷ đơn (pending/confirmed). PLAN-0027: gửi `reasonCode` (+ `note`) hoặc `reason` tự do (API cũ, chatbot) — cần ít nhất một trong hai. */
export class CancelOrderRequest {
  @ApiPropertyOptional({ enum: CUSTOMER_CANCEL_REASONS, example: 'changed_mind', description: 'Mã lý do (thiếu ⇒ other)' }) @IsOptional() @IsIn(CUSTOMER_CANCEL_REASONS) reasonCode?: string;
  @ApiPropertyOptional({ example: 'Đổi ý, không muốn mua nữa', description: 'Lý do tự do (hiển thị cho shop)' }) @IsOptional() @IsString() @Length(3, 255) reason?: string;
  @ApiPropertyOptional({ example: 'Mình nhập nhầm địa chỉ' }) @IsOptional() @IsString() @MaxLength(255) note?: string;
}

/* Sàn huỷ thay khách. PLAN-0027: `reasonCode` sàn (dispute | fraud | other); lý do ≥ 10 ký tự với đơn đóng gói / đang giao (kiểm ở service). */
export class AdminCancelOrderRequest {
  @ApiProperty({ example: 'CSKH huỷ đơn tranh chấp, shop không phản hồi' }) @IsString() @Length(3, 255) reason: string;
  @ApiPropertyOptional({ enum: PLATFORM_CANCEL_REASONS, example: 'dispute' }) @IsOptional() @IsIn(PLATFORM_CANCEL_REASONS) reasonCode?: string;
}

/* Khách yêu cầu huỷ đơn ĐANG ĐÓNG GÓI (PLAN-0027 §2.2) — shop chấp nhận/từ chối; im lặng quá `order.cancel_request_hours` ⇒ tự chấp nhận. */
export class CancelOrderRequestRequest {
  @ApiProperty({ enum: CUSTOMER_CANCEL_REASONS, example: 'changed_mind' }) @IsIn(CUSTOMER_CANCEL_REASONS) reasonCode: string;
  @ApiPropertyOptional({ example: 'Mình cần huỷ vì đổi kế hoạch' }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/* Đổi địa chỉ nhận hàng (pending/confirmed; không đổi sang tỉnh/thành khác vì phí ship không tính lại). */
export class ChangeOrderAddressRequest {
  @ApiPropertyOptional() @IsOptional() @IsUUID() addressId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() expectedTotal?: string;
  @ApiProperty({ example: 'Nguyễn Văn An' }) @ValidateIf((o:ChangeOrderAddressRequest)=>!o.addressId) @IsString() @Length(2, 120) recipientName: string;
  @ApiProperty({ example: '0901234567' }) @ValidateIf((o:ChangeOrderAddressRequest)=>!o.addressId) @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' }) recipientPhone: string;
  @ApiProperty({ example: '12 Nguyễn Huệ' }) @ValidateIf((o:ChangeOrderAddressRequest)=>!o.addressId) @IsString() @Length(3, 255) addressLine: string;
  @ApiPropertyOptional({ example: 'Phường Bến Nghé' }) @IsOptional() @IsString() @MaxLength(100) ward?: string;
  @ApiPropertyOptional({ example: 'Quận 1' }) @IsOptional() @IsString() @MaxLength(100) district?: string;
  @ApiProperty({ example: 'TP. Hồ Chí Minh', description: 'Phải trùng tỉnh/thành của đơn' }) @ValidateIf((o:ChangeOrderAddressRequest)=>!o.addressId) @IsString() @Length(2, 100) province: string;
}

export class OrderListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: Object.values(ORDER_STATUS) }) @IsOptional() @IsIn(Object.values(ORDER_STATUS)) status?: string;
}

export class MyOrderListQuery extends OrderListQuery {
  @ApiPropertyOptional({ description: 'true = trả OrderResponse đầy đủ (dòng hàng, tiền) thay vì tóm tắt — trang "Đơn của tôi" của FE vẽ từng món' }) @IsOptional() @ToBoolean() @IsBoolean() full?: boolean;
}

export class AdminOrderListQuery extends OrderListQuery {
  @ApiPropertyOptional({ description: 'Mã đơn con (DH…) / mã nhóm (DHN…) / tên / SĐT người nhận / email khách (nhập đủ email). Không cần chọn shop.' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['unpaid', 'processing', 'paid', 'refunded', 'partially_refunded']) paymentStatus?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn([...Object.values(PAYMENT_METHOD)]) paymentMethodCode?: string;
  @ApiPropertyOptional({ description: 'Chỉ đơn con của gian hàng này' }) @IsOptional() @IsUUID('loose') shopId?: string;
}

export class UpdateOrderStatusRequest {
  @ApiProperty({ enum: ['confirmed', 'packing', 'shipping', 'delivered', 'completed'] }) @IsIn(['confirmed', 'packing', 'shipping', 'delivered', 'completed']) status: string;
  @ApiPropertyOptional({ example: 'https://tracking.ghn.vn/?order=GHN123' }) @IsOptional() @IsString() @MaxLength(500) trackingUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
