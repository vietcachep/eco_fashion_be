import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { MoneyResponse } from '@common/response/money-response';

export class CreateLiveCampaignRequest {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9_-]{3,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ enum: ['percentage', 'fixed_amount', 'free_shipping'] })
  @IsIn(['percentage', 'fixed_amount', 'free_shipping'])
  type: string;
  @ApiProperty() @IsInt() @Min(0) @Max(100_000_000) value: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\d{1,14}$/) minOrderAmount?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\d{1,14}$/) maxDiscount?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(10000) claimLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(10000) usageLimit?: number;
}
export class LiveCampaignReasonRequest {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class LiveVoucherClaimResponse {
  @ApiProperty() id: string;
  @ApiProperty() campaignId: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() state: string;
  @ApiProperty({ type: String, nullable: true }) redeemUntil: string | null;
  @ApiProperty() policyVersion: string;
  @ApiProperty({ type: String, nullable: true }) recoveryEntitlementId: string | null;
  @ApiProperty({ type: String, nullable: true }) restoreReason: string | null;
}
export class LiveCampaignResponse {
  @ApiProperty() id: string;
  @ApiProperty() sessionId: string;
  @ApiProperty() shopId: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() type: string;
  @ApiProperty() scope: string;
  @ApiProperty() value: string;
  @ApiProperty({ type: MoneyResponse }) minOrderAmount: MoneyResponse;
  @ApiProperty({ type: MoneyResponse, nullable: true }) maxDiscount: MoneyResponse | null;
  @ApiProperty() claimLimit: number;
  @ApiProperty({ type: Number, nullable: true }) usageLimit: number | null;
  @ApiProperty() claimedCount: number;
  @ApiProperty() usedCount: number;
  @ApiProperty() state: string;
  @ApiProperty({ type: String, nullable: true }) redeemUntil: string | null;
  @ApiProperty() policyVersion: string;
  @ApiProperty({ type: LiveVoucherClaimResponse, nullable: true }) claim: LiveVoucherClaimResponse | null;
}
