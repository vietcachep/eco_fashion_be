import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';

export class RunPayoutRequest {
  @ApiProperty({ example: '2026-09-01T00:00:00Z', description: 'Đầu kỳ đối soát' })
  @IsDateString()
  periodStart!: string;

  @ApiProperty({ example: '2026-09-30T23:59:59Z', description: 'Cuối kỳ đối soát (không muộn hơn hiện tại; đơn tính theo hạn đổi trả tới mốc này)' })
  @IsDateString()
  periodEnd!: string;
}

export class MarkPaidRequest {
  @ApiProperty({ example: 'FT26093012345', description: 'Mã giao dịch / chứng từ chuyển khoản' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  providerRef!: string;

  @ApiPropertyOptional({ example: 'Chuyển tay qua Vietcombank 30/09' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class PayoutListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['pending', 'processing', 'paid', 'failed', 'carried', 'settled'] })
  @IsOptional()
  @IsIn(['pending', 'processing', 'paid', 'failed', 'carried', 'settled'])
  status?: string;

  @ApiPropertyOptional({ description: 'Lọc theo gian hàng (chỉ dành cho sàn)' })
  @IsOptional()
  @IsUUID()
  shopId?: string;
}

export class ShopPayoutResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'PAY-260901-260930-1A2B3C4D' }) code!: string;
  @ApiProperty() shopId!: string;
  @ApiPropertyOptional({ description: 'Tên gian hàng — để màn đối soát không phải tra thêm danh sách shop (kế toán không có quyền đọc shop)' }) shopName?: string;
  @ApiProperty() periodStart!: string;
  @ApiProperty() periodEnd!: string;
  @ApiProperty({ example: '10000000', description: 'Tổng tiền hàng các đơn đã qua hạn đổi trả (VND)' }) grossRevenue!: string;
  @ApiProperty({ example: '1000000', description: 'Hoa hồng sàn ròng (đã trừ phần hoàn lại trên hàng bị hoàn) (VND)' }) commission!: string;
  @ApiProperty({ example: '500000', description: 'Hoàn tiền cho khách đã trừ vào kỳ (VND)' }) refundAmount!: string;
  @ApiProperty({ example: '0', description: 'Nợ mang sang từ kỳ trước (VND)' }) carriedDebt!: string;
  @ApiProperty({ example: '8500000', description: 'Thực chi = gross − commission − refund − carriedDebt; âm = nợ mang sang kỳ sau' }) netPayout!: string;
  @ApiProperty({ enum: ['pending', 'processing', 'paid', 'failed', 'carried', 'settled'], description: 'carried = net âm (không chi), settled = net 0' }) status!: string;
  @ApiProperty({ nullable: true, type: String }) providerRef!: string | null;
  @ApiProperty({ nullable: true, type: String }) failReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) paidAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: 'Lần cập nhật gần nhất — kỳ `processing` quá 10 phút không đổi là treo (được phép gửi lại)' }) updatedAt!: string;
  @ApiProperty({ description: 'TK nhận đã che số (4 số cuối) — chỉ để đối chiếu', nullable: true, type: String }) bankAccountMasked!: string | null;
}

export class ShopPayoutLineResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'sale: mã đơn · refund: mã dòng hoàn tiền (RF-…)' }) orderCode!: string;
  @ApiProperty({ enum: ['sale', 'refund'] }) kind!: string;
  @ApiProperty({ example: '5000000', description: 'Tiền hàng (sale) hoặc tiền hoàn (refund) (VND)' }) gross!: string;
  @ApiProperty({ example: '500000', description: 'Hoa hồng của dòng (với refund: hoa hồng hoàn lại cho shop)' }) commission!: string;
}

export class ShopPayoutDetailResponse {
  @ApiProperty({ type: ShopPayoutResponse }) payout!: ShopPayoutResponse;
  @ApiProperty({ type: [ShopPayoutLineResponse] }) lines!: ShopPayoutLineResponse[];
}

export class PayosBalanceResponse {
  @ApiProperty({ description: 'Đã cấu hình khoá PayOS payout chưa' }) configured!: boolean;
  @ApiProperty({ example: '50000000', nullable: true, type: String, description: 'Số dư tài khoản chi (VND); null nếu chưa cấu hình hoặc tra cứu lỗi' }) balance!: string | null;
}
