import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CheckoutSummaryResponse, OrderGroupResponse } from '../order/dto/order.responses';
import { MoneyResponse } from '@common/response/money-response';

export class IntentLineRequest {
  @ApiProperty() @IsUUID() variantId: string;
  @ApiProperty() @IsInt() @Min(1) @Max(100) quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourceGrantId?: string;
}
export class CreateCheckoutIntentRequest {
  @ApiProperty({ enum: ['buy_now', 'cart_selection'] }) @IsIn(['buy_now', 'cart_selection']) mode:
    'buy_now' | 'cart_selection';
  @ApiPropertyOptional({ type: [IntentLineRequest] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => IntentLineRequest)
  lines?: IntentLineRequest[];
}
export class IntentQuoteRequest {
  @ApiProperty() @IsInt() @Min(0) intentVersion: number;
  @ApiProperty() @IsUUID() addressId: string;
  @ApiProperty({ enum: ['cod', 'payos'] }) @IsIn(['cod', 'payos']) paymentMethodCode: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  voucherCodes?: string[];
}
export class IntentAttemptRequest extends IntentQuoteRequest {
  @ApiProperty() @IsString() @Matches(/^\d{1,14}$/) expectedTotal: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('loose', { each: true })
  quoteIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class IntentLineResponse {
  @ApiProperty() variantId: string;
  @ApiProperty() productId: string;
  @ApiProperty() shopId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) imageUrl: string | null;
  @ApiProperty() color: string;
  @ApiProperty() size: string;
  @ApiProperty() quantity: number;
  @ApiProperty({ type: MoneyResponse }) unitPrice: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) lineTotal: MoneyResponse;
  @ApiProperty({ type: String, nullable: true }) sourceSessionId: string | null;
  @ApiProperty() eligibleQuantity: number;
}
export class CheckoutIntentResponse {
  @ApiProperty() id: string;
  @ApiProperty() version: number;
  @ApiProperty() mode: string;
  @ApiProperty() state: string;
  @ApiProperty() expiresAt: string;
  @ApiProperty({ type: [IntentLineResponse] }) lines: IntentLineResponse[];
  @ApiProperty() itemCount: number;
  @ApiProperty({ type: String, nullable: true }) resultGroupCode: string | null;
  @ApiProperty({ type: String, nullable: true }) latestAttemptId: string | null;
}
export class CheckoutIntentQuoteResponse {
  @ApiProperty() intentId: string;
  @ApiProperty() intentVersion: number;
  @ApiProperty({ type: CheckoutSummaryResponse }) summary: CheckoutSummaryResponse;
}
export class CheckoutAttemptResponse {
  @ApiProperty() id: string;
  @ApiProperty() intentId: string;
  @ApiProperty({ enum: ['processing', 'succeeded', 'failed_known'] }) state: string;
  @ApiProperty({ type: String, nullable: true }) groupCode: string | null;
  @ApiProperty({ type: OrderGroupResponse, nullable: true }) group: OrderGroupResponse | null;
  @ApiProperty({ type: String, nullable: true }) errorCode: string | null;
  @ApiProperty({ type: String, nullable: true }) message: string | null;
}
