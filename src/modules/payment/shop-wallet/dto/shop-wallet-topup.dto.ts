import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { TOPUP_STATUS_VALUES } from '../../foundation/payment.constants';

/*
 * DTO nạp cọc COD qua PayOS (PLAN-0041 §5.3) — request/response của /shop/wallet/topups* (vendor) và /admin/wallet-topups* (sàn xem-only).
 * Tiền là CHUỖI số nguyên VND (không float); thời gian ISO-8601. Đây là whitelist trả ra ngoài: KHÔNG có userId/email của khách, KHÔNG có raw của webhook.
 * File này KHÔNG import shop-wallet.dto.ts (tránh vòng: shop-wallet.dto.ts import PayosTopupInfoResponse từ đây).
 */

/* Số tiền VND dạng chuỗi số nguyên dương — khai lại cục bộ (hằng VND ở shop-wallet.dto.ts không export; không import ngược để tránh vòng). */
const VND = /^[1-9]\d{0,13}$/;

export class CreateTopupRequest {
  @ApiProperty({ example: '1000000', description: 'Số tiền nạp (VND, chuỗi số nguyên). Tối thiểu wallet.min_deposit, tối đa wallet.max_topup_amount' })
  @Matches(VND, { message: 'Số tiền không hợp lệ' })
  amount!: string;
}

export class TopupListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: [...TOPUP_STATUS_VALUES] }) @IsOptional() @IsIn(TOPUP_STATUS_VALUES) status?: string;
  @ApiPropertyOptional({ description: 'Lọc theo gian hàng — chỉ sàn dùng; route vendor BỎ QUA trường này (shopId lấy từ phiên)' }) @IsOptional() @IsUUID('loose') shopId?: string;
}

export class WalletTopupReceiptResponse {
  @ApiProperty({ description: 'Mã giao dịch PayOS (reference) của khoản tiền đã nhận' }) reference!: string;
  @ApiProperty({ example: '500000' }) amount!: string;
  @ApiProperty() createdAt!: string;
}

export class WalletTopupResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  @ApiPropertyOptional() shopName?: string;
  @ApiProperty({ example: '1000000', description: 'Số tiền yêu cầu (= số tiền của link PayOS)' }) amount!: string;
  @ApiProperty({ example: '600000', description: 'Tổng ĐÃ GHI CÓ vào ví cho khoản này' }) receivedAmount!: string;
  @ApiProperty({ enum: [...TOPUP_STATUS_VALUES] }) status!: 'creating' | 'pending' | 'partial' | 'paid' | 'expired' | 'cancelled' | 'failed';
  @ApiProperty({ description: 'Mã PayOS của khoản (để kế toán đối chiếu bảng điều khiển PayOS)' }) payosOrderCode!: string;
  @ApiProperty({ nullable: true, type: String, description: 'CHỈ route vendor và CHỈ khi status ∈ {pending, partial} và chưa quá expiresAt; còn lại null' }) checkoutUrl!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Như checkoutUrl' }) qrCode!: string | null;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ nullable: true, type: String }) paidAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) closedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: 'Vendor: true khi status ∈ {pending, partial} — được phép huỷ link' }) canCancel!: boolean;
}

export class CreateTopupResponse extends WalletTopupResponse {
  @ApiProperty({ description: 'true = trả lại khoản đang mở còn hạn (không tạo link mới, kể cả số tiền khác)' }) reused!: boolean;
}

export class WalletTopupDetailResponse extends WalletTopupResponse {
  @ApiProperty({ type: () => [WalletTopupReceiptResponse] }) receipts!: WalletTopupReceiptResponse[];
  @ApiProperty({ nullable: true, type: String }) lastGatewayStatus!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastCheckedAt!: string | null;
}

export class PayosTopupInfoResponse {
  @ApiProperty({ description: 'Cờ wallet.payos_deposit_enabled BẬT VÀ PayOS đã cấu hình VÀ EF_ADMIN_URL dùng được' }) enabled!: boolean;
  @ApiProperty({ example: 500000, description: 'Số tiền nạp tối thiểu (wallet.min_deposit)' }) minAmount!: number;
  @ApiProperty({ example: 50000000, description: 'Số tiền nạp tối đa mỗi lần (wallet.max_topup_amount)' }) maxAmount!: number;
  @ApiProperty({ nullable: true, type: () => WalletTopupResponse, description: 'Khoản pending|partial còn hạn của shop; không có thì null' }) active!: WalletTopupResponse | null;
}
