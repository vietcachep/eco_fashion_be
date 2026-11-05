import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { RETURN_EVIDENCE_MAX, RETURN_REASON_CODES, RETURN_RECEIVED_CONDITION, RETURN_RESOLVE_DECISION, RETURN_STATUS } from '../../foundation/order.constants';

const PHONE_VN = /^(0|\+84)(\d{9,10})$/;

export class MediaItemInput {
  @ApiProperty({ enum: ['image', 'video'] }) @IsIn(['image', 'video']) type: string;
  @ApiProperty({ description: 'URL do POST /uploads/media trả về (chỉ nhận tệp thuộc kho upload của hệ thống)' }) @IsString() @MaxLength(500) url: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
}

export class ReturnItemInput {
  @ApiProperty() @IsUUID() orderItemId: string;
  @ApiProperty({ example: 1 }) @Type(() => Number) @IsInt() @Min(1) quantity: number;
}

/* Tài khoản nhận tiền hoàn do khách khai: BIN 6 số (Napas) + số tài khoản 6–19 chữ số + tên chủ tài khoản (server chuẩn hoá không dấu, in hoa). */
export class RefundAccountInput {
  @ApiProperty({ example: '970422', description: 'Mã BIN ngân hàng (6 số, chuẩn Napas)' }) @IsString() @Matches(/^\d{6}$/, { message: 'Mã ngân hàng (BIN) phải gồm đúng 6 chữ số' }) bankBin: string;
  @ApiPropertyOptional({ example: 'MB Bank', description: 'Tên ngân hàng để hiển thị lại (không bắt buộc)' }) @IsOptional() @IsString() @MaxLength(100) bankName?: string;
  @ApiProperty({ example: '0123456789' }) @IsString() @Length(6, 30) accountNumber: string;
  @ApiProperty({ example: 'Nguyễn Văn A' }) @IsString() @Length(2, 80) accountName: string;
}

/*
 * Khách tạo yêu cầu đổi trả. `reasonCode` bắt buộc; `reason` (tự do) bỏ trống ⇒ lấy nhãn của reasonCode (bắt buộc khi `other`). `not_received` (chưa nhận hàng): không cần
 * `items` (mặc định cả đơn) và `evidence`. Đơn COD đã thu tiền BẮT BUỘC `refundAccount`; PayOS thì không (dùng tài khoản đã trả).
 * Mảng minh chứng/dòng hàng được service kiểm tiếp (host upload, số lượng còn trả được) — DTO chỉ chặn hình dạng.
 */
export class CreateReturnRequest {
  @ApiProperty({ enum: RETURN_REASON_CODES, example: 'size_issue' }) @IsIn(RETURN_REASON_CODES) reasonCode: string;
  @ApiPropertyOptional({ example: 'Không vừa size', description: 'Lý do tự nêu; bỏ trống thì lấy nhãn của reasonCode' }) @IsOptional() @IsString() @Length(3, 255) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) detail?: string;
  @ApiPropertyOptional({ type: [ReturnItemInput], description: 'Bắt buộc (≥ 1 dòng) trừ khi reasonCode = not_received (mặc định cả đơn)' }) @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ReturnItemInput) items?: ReturnItemInput[];
  @ApiPropertyOptional({ type: [MediaItemInput], description: `Ảnh/video minh chứng ≥ 1, tối đa ${RETURN_EVIDENCE_MAX} (upload trước qua POST /uploads/media) — không bắt buộc khi reasonCode = not_received` }) @IsOptional() @IsArray() @ArrayMaxSize(RETURN_EVIDENCE_MAX) @ValidateNested({ each: true }) @Type(() => MediaItemInput) evidence?: MediaItemInput[];
  @ApiPropertyOptional({ type: RefundAccountInput, description: 'Bắt buộc với đơn COD đã thu tiền' }) @IsOptional() @ValidateNested() @Type(() => RefundAccountInput) refundAccount?: RefundAccountInput;
}

export class ShipBackReturnRequest {
  @ApiProperty({ example: 'GHN' }) @IsString() @Length(2, 60) carrier: string;
  @ApiProperty({ example: 'GHN123456789' }) @IsString() @Length(3, 80) trackingCode: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class EscalateReturnRequest {
  @ApiProperty({ example: 'Shop từ chối vô lý — hàng thật sự bị lỗi như ảnh minh chứng' }) @IsString() @Length(10, 500) reason: string;
}

/* Admin (sàn): lọc theo trạng thái + gian hàng. */
export class ReturnListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: Object.values(RETURN_STATUS) }) @IsOptional() @IsIn(Object.values(RETURN_STATUS)) status?: string;
  @ApiPropertyOptional({ description: 'Chỉ đổi trả của gian hàng này' }) @IsOptional() @IsUUID('loose') shopId?: string;
}

/* Shop: chỉ lọc trạng thái — shopId KHÔNG nhận từ query, luôn từ ngữ cảnh phiên (ShopContextGuard). */
export class ShopReturnListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: Object.values(RETURN_STATUS) }) @IsOptional() @IsIn(Object.values(RETURN_STATUS)) status?: string;
}

export class ReturnAddressInput {
  @ApiProperty({ example: 'Kho Shop An Nhiên' }) @IsString() @Length(2, 120) name: string;
  @ApiProperty({ example: '0901234567' }) @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' }) phone: string;
  @ApiProperty({ example: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh' }) @IsString() @Length(5, 300) address: string;
}

/*
 * Shop duyệt. `refundAmount` bỏ trống = số hệ thống đã tính; khác số tính sẵn thì CHỈ được nhỏ hơn và bắt buộc `adjustReason`. `returnAddress` = nơi khách gửi hàng trả
 * (bắt buộc với yêu cầu cần trả hàng nếu shop chưa từng khai — lần sau lấy lại địa chỉ gần nhất; không dùng cho `not_received`).
 */
export class ApproveReturnRequest {
  @ApiPropertyOptional({ example: '90000', description: 'VND — chỉ được ≤ số tính sẵn' }) @IsOptional() @Matches(/^\d+$/, { message: 'Số tiền hoàn phải là số nguyên VND' }) refundAmount?: string;
  @ApiPropertyOptional({ description: 'Bắt buộc khi refundAmount khác số tính sẵn' }) @IsOptional() @IsString() @MaxLength(500) adjustReason?: string;
  @ApiPropertyOptional({ type: ReturnAddressInput }) @IsOptional() @ValidateNested() @Type(() => ReturnAddressInput) returnAddress?: ReturnAddressInput;
}

export class RejectReturnRequest {
  @ApiProperty({ example: 'Hàng đã qua sử dụng, không đúng điều kiện đổi trả' }) @IsString() @Length(10, 500) reason: string;
  @ApiPropertyOptional({ type: [MediaItemInput] }) @IsOptional() @IsArray() @ArrayMaxSize(RETURN_EVIDENCE_MAX) @ValidateNested({ each: true }) @Type(() => MediaItemInput) evidence?: MediaItemInput[];
}

/* Shop xác nhận ĐÃ NHẬN LẠI hàng: `ok` ⇒ nhập kho + yêu cầu hoàn tiền; `not_matching` ⇒ chuyển sàn phân xử (bắt buộc `note` ≥ 10 ký tự — service kiểm). */
export class ReceiveReturnRequest {
  @ApiProperty({ enum: Object.values(RETURN_RECEIVED_CONDITION) }) @IsIn(Object.values(RETURN_RECEIVED_CONDITION)) condition: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ type: [MediaItemInput] }) @IsOptional() @IsArray() @ArrayMaxSize(RETURN_EVIDENCE_MAX) @ValidateNested({ each: true }) @Type(() => MediaItemInput) evidence?: MediaItemInput[];
}

/* Sàn phân xử yêu cầu đã chuyển lên (escalated): hoàn tiền hoặc từ chối lần cuối; `note` bắt buộc (khách + shop đều thấy). */
export class ResolveReturnRequest {
  @ApiProperty({ enum: Object.values(RETURN_RESOLVE_DECISION) }) @IsIn(Object.values(RETURN_RESOLVE_DECISION)) decision: string;
  @ApiProperty({ example: 'Đã xem ảnh minh chứng: hàng lỗi sản xuất, hoàn tiền cho khách' }) @IsString() @Length(5, 500) note: string;
  @ApiPropertyOptional({ example: '90000', description: 'Chỉ khi decision = refund; ≤ tổng đơn − đã hoàn' }) @IsOptional() @Matches(/^\d+$/, { message: 'Số tiền hoàn phải là số nguyên VND' }) refundAmount?: string;
}
