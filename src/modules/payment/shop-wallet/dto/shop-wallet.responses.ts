import { ApiProperty } from '@nestjs/swagger';

export class ShopWalletTransactionResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['cod_commission', 'deposit', 'adjust'] }) type!: string;
  @ApiProperty({ example: '-25000', description: 'Âm = trừ (hoa hồng), dương = cộng (nộp quỹ / điều chỉnh) (VND)' }) amount!: string;
  @ApiProperty({ example: '975000', description: 'Số dư sau giao dịch (VND)' }) balanceAfter!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Mã đơn (hoa hồng COD)' }) orderCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() createdAt!: string;
}

export class PendingDepositResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '500000' }) amount!: string;
}

export class ShopWalletResponse {
  @ApiProperty() shopId!: string;
  @ApiProperty({ example: '1000000', description: 'Số dư quỹ COD (VND); ≤ 0 ⇒ COD bị khoá' }) balance!: string;
  @ApiProperty({ description: 'COD của shop đang bật?' }) codEnabled!: boolean;
  @ApiProperty({ type: PendingDepositResponse, nullable: true }) pendingDeposit!: PendingDepositResponse | null;
}

export class AdminWalletRowResponse {
  @ApiProperty() shopId!: string;
  @ApiProperty({ nullable: true, type: String }) shopName!: string | null;
  @ApiProperty({ example: '1000000' }) balance!: string;
  @ApiProperty() codEnabled!: boolean;
  @ApiProperty() updatedAt!: string;
}

export class DepositRequestResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty({ nullable: true, type: String }) shopName!: string | null;
  @ApiProperty({ example: '500000' }) amount!: string;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) proofUrl!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() createdAt!: string;
}
