import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ToBoolean } from '@common/utils/transform';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';

/* Số tiền VND dạng chuỗi số nguyên dương (không dấu phẩy) — nhận chuỗi để không mất chính xác. */
const VND = /^[1-9]\d{0,13}$/;
/* Số nguyên có dấu cho chỉnh ví tay (cộng/trừ). */
const SIGNED_VND = /^-?[1-9]\d{0,13}$/;

export class DepositRequest {
  @ApiProperty({ example: '2000000', description: 'Số tiền shop đã chuyển cho sàn (VND)' }) @Matches(VND, { message: 'Số tiền không hợp lệ' }) amount!: string;
  @ApiProperty({ example: 'FT26102312345', description: 'Mã giao dịch / nội dung chuyển khoản để kế toán đối chiếu' }) @IsString() @Length(3, 120) transferRef!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RejectDepositRequest {
  @ApiProperty({ example: 'Không thấy khoản chuyển khớp mã giao dịch' }) @IsNotEmpty() @IsString() @Length(3, 500) reason!: string;
}

export class AdjustWalletRequest {
  @ApiProperty({ example: '-100000', description: 'Số tiền có dấu: dương = cộng ví, âm = trừ ví' }) @Matches(SIGNED_VND, { message: 'Số tiền không hợp lệ' }) amount!: string;
  @ApiProperty({ example: 'Đối soát lệch kỳ 09/2026' }) @IsNotEmpty() @IsString() @Length(3, 500) note!: string;
}

export class DepositListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected'] }) @IsOptional() @IsIn(['pending', 'approved', 'rejected']) status?: string;
  @ApiPropertyOptional({ description: 'Lọc theo gian hàng (chỉ dành cho sàn)' }) @IsOptional() @IsUUID('loose') shopId?: string;
}

export class WalletListQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'true = chỉ ví về 0 hoặc âm (COD đang đóng)' }) @IsOptional() @ToBoolean() @IsBoolean() lowOnly?: boolean;
}

export class WalletDepositResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  @ApiPropertyOptional() shopName?: string;
  @ApiProperty({ example: '2000000' }) amount!: string;
  @ApiProperty() transferRef!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) rejectReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) reviewedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class WalletResponse {
  @ApiProperty() shopId!: string;
  @ApiPropertyOptional() shopName?: string;
  @ApiProperty({ example: '1500000', description: 'Số dư (VND), CÓ THỂ ÂM — âm là khoản shop còn nợ sàn, được bù bằng lần nộp cọc kế tiếp' }) balance!: string;
  @ApiProperty({ description: 'Gian hàng được bán COD cho đơn mới (số dư > 0, hoặc gian hàng chính chủ của sàn)' }) codEnabled!: boolean;
  @ApiProperty({ description: 'Gian hàng chính chủ của sàn — miễn đặt cọc' }) exempt!: boolean;
  @ApiProperty({ nullable: true, type: () => WalletDepositResponse }) pendingDeposit!: WalletDepositResponse | null;
  @ApiProperty({ example: 500000, description: 'Số tiền nộp tối thiểu mỗi lần' }) minDeposit!: number;
  @ApiProperty({ description: 'Hướng dẫn chuyển khoản cho shop' }) instructions!: string;
}

export class WalletSummaryResponse {
  @ApiProperty() shopId!: string;
  @ApiPropertyOptional() shopName?: string;
  @ApiProperty({ example: '-20000' }) balance!: string;
  @ApiProperty() codEnabled!: boolean;
  @ApiProperty() updatedAt!: string;
}

export class WalletTransactionResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['deposit', 'cod_commission', 'cod_refund', 'adjust'] }) type!: string;
  @ApiProperty({ example: '-50000', description: 'Có dấu: + cộng ví, − trừ ví' }) amount!: string;
  @ApiProperty({ example: '1450000' }) balanceAfter!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Mã đơn COD (cod_refund: mã dòng hoàn RF-…)' }) orderCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() createdAt!: string;
}
