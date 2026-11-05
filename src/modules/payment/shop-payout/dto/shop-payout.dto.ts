import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';

export class RunPayoutRequest {
  @ApiProperty({ example: '2026-09-01T00:00:00Z', description: 'Đầu kỳ đối soát' })
  @IsDateString()
  periodStart!: string;

  @ApiProperty({ example: '2026-09-30T23:59:59Z', description: 'Cuối kỳ đối soát (không muộn hơn hiện tại; đơn tính theo hạn đổi trả tới mốc này)' })
  @IsDateString()
  periodEnd!: string;

  @ApiPropertyOptional({ description: 'Chỉ chạy kỳ cho gian hàng này (bỏ trống = mọi shop)' })
  @IsOptional()
  @IsUUID()
  shopId?: string;
}

export class CreatePayoutHoldRequest {
  @ApiProperty({ description: 'Gian hàng bị giữ tiền chi trả' })
  @IsUUID()
  shopId!: string;

  @ApiProperty({ example: 'Đang điều tra khiếu nại bán hàng giả', description: 'Lý do giữ (5–255 ký tự) — hiển thị cho kế toán/quản lý' })
  @IsString()
  @MinLength(5)
  @MaxLength(255)
  reason!: string;
}

export class PayoutHoldResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  @ApiPropertyOptional({ description: 'Tên gian hàng' }) shopName?: string;
  @ApiPropertyOptional({ description: 'Mã gian hàng' }) shopCode?: string;
  @ApiProperty() reason!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String, description: 'null = đang giữ' }) releasedAt!: string | null;
}

export class ReleasePayoutHoldResponse {
  @ApiProperty({ type: PayoutHoldResponse }) hold!: PayoutHoldResponse;
  @ApiProperty({ description: 'Số kỳ `held` của shop được mở giữ ngay (kỳ còn lý do giữ khác — shop bị khoá / đổi TK — vẫn giữ)' }) releasedPayouts!: number;
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

  @ApiPropertyOptional({ description: 'Bắt buộc = true khi kỳ đang processing/unknown: kế toán ĐÃ tra bảng điều khiển PayOS và xác nhận lệnh chi KHÔNG được thực hiện (chống chi trùng)' })
  @IsOptional()
  @IsBoolean()
  confirmGatewayNotExecuted?: boolean;
}

export class PayoutListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['pending', 'awaiting_approval', 'processing', 'paid', 'failed', 'unknown', 'held', 'deferred', 'merged', 'carried', 'settled'] })
  @IsOptional()
  @IsIn(['pending', 'awaiting_approval', 'processing', 'paid', 'failed', 'unknown', 'held', 'deferred', 'merged', 'carried', 'settled'])
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
  @ApiPropertyOptional({ description: 'Mã gian hàng (FT-…) — đi cùng shopName; không cần quyền đọc shop' }) shopCode?: string;
  @ApiPropertyOptional({ description: 'Tên gian hàng — để màn đối soát không phải tra thêm danh sách shop (kế toán không có quyền đọc shop)' }) shopName?: string;
  @ApiProperty() periodStart!: string;
  @ApiProperty() periodEnd!: string;
  @ApiProperty({ example: '10000000', description: 'Tổng tiền hàng các đơn đã qua hạn đổi trả (VND)' }) grossRevenue!: string;
  @ApiProperty({ example: '1000000', description: 'Hoa hồng sàn ròng (đã trừ phần hoàn lại trên hàng bị hoàn) (VND)' }) commission!: string;
  @ApiProperty({ example: '500000', description: 'Hoàn tiền cho khách đã trừ vào kỳ (VND)' }) refundAmount!: string;
  @ApiProperty({ example: '0', description: 'Nợ mang sang từ kỳ trước (VND)' }) carriedDebt!: string;
  @ApiProperty({ example: '8500000', description: 'Thực chi = gross − commission − refund − carriedDebt; âm = nợ mang sang kỳ sau' }) netPayout!: string;
  @ApiProperty({ enum: ['pending', 'awaiting_approval', 'processing', 'paid', 'failed', 'unknown', 'held', 'deferred', 'merged', 'carried', 'settled'], description: 'unknown = gửi lệnh nhưng không rõ kết quả (KHÔNG chi lại / KHÔNG đánh dấu tay — dùng Kiểm tra với PayOS) · awaiting_approval = vượt hạn mức tự chi, chờ duyệt · held = shop bị khoá / đang giữ · deferred = dưới mức tối thiểu, dồn kỳ sau · carried = net âm (không chi) · settled = net 0' }) status!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Kết quả cổng: submitted | failed (PayOS từ chối chắc chắn) | not_received | succeeded | unknown' }) gatewayStatus!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Lý do giữ (khi status = held)' }) holdReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) providerRef!: string | null;
  @ApiProperty({ nullable: true, type: String }) failReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) paidAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: 'Lần cập nhật gần nhất — kỳ `processing` quá 10 phút không đổi là treo (được phép gửi lại)' }) updatedAt!: string;
  @ApiProperty({ description: 'TK nhận đã che số (4 số cuối) — chỉ để đối chiếu', nullable: true, type: String }) bankAccountMasked!: string | null;
}

export class ShopPayoutLineResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Mã ĐƠN của dòng — sale: đơn đã bán · refund: đơn bị hoàn tiền (PLAN-0022; trước đây là mã dòng RF-…). Dòng hoàn tiền cũ không khớp được thì còn mã RF-… (xem lineKey).' }) orderCode!: string;
  @ApiProperty({ description: 'Khoá kỹ thuật của dòng (duy nhất toàn bảng) — sale: mã đơn · refund: "RF-" + 26 hex đầu của id hoàn tiền' }) lineKey!: string;
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
