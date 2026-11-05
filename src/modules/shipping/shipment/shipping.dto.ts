import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { PageResponse } from '@common/response/api-response';

export class ShippingListQuery {
  @ApiPropertyOptional({ type: Number, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional({ type: Number, default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) size: number = 20;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 40) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 60) q?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shopId?: string;
}
export class ShippingLocationQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) provinceId?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) districtId?: number;
}
export class ShippingLocationResponse {
  @ApiProperty({ oneOf: [{ type: 'number' }, { type: 'string' }] }) id: number | string;
  @ApiProperty() name: string;
  @ApiPropertyOptional() code?: string;
  @ApiPropertyOptional() parentId?: number;
}
export class SimulateShipmentRequest {
  @ApiProperty() @IsUUID() shipmentId: string;
  @ApiProperty({ enum: ['picked', 'in_transit', 'delivering', 'delivered', 'delivery_fail', 'returning', 'returned', 'cancel', 'lost'] })
  @IsIn(['picked', 'in_transit', 'delivering', 'delivered', 'delivery_fail', 'returning', 'returned', 'cancel', 'lost']) event: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) eventId?: string;
}
export class ConfirmCarrierCodRequest {
  @ApiProperty({ example: '530000' }) @IsNumberString({ no_symbols: true }) @Length(1, 14) amount: string;
  @ApiProperty() @IsString() @Length(3, 100) reference: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 500) note?: string;
}
export class ShipmentEventResponse {
  @ApiProperty() id: string;
  @ApiProperty() status: string;
  @ApiProperty() rawStatus: string;
  @ApiProperty() source: string;
  @ApiProperty() eventTime: string;
  @ApiProperty({ nullable: true, type: String }) processedAt: string | null;
}
export class ShipmentResponse {
  @ApiProperty() id: string;
  @ApiProperty() orderCode: string;
  @ApiProperty() shopId: string;
  @ApiProperty() provider: string;
  @ApiProperty() environment: string;
  @ApiProperty() createStatus: string;
  @ApiProperty() cancelStatus: string;
  @ApiProperty({ nullable: true, type: String }) status: string | null;
  @ApiProperty() active: boolean;
  @ApiProperty({ nullable: true, type: String }) carrierOrderCode: string | null;
  @ApiProperty() clientOrderCode: string;
  @ApiProperty({ nullable: true, type: String }) trackingUrl: string | null;
  @ApiProperty({ nullable: true, type: String }) pickedUpAt: string | null;
  @ApiProperty({ nullable: true, type: String }) deliveredAt: string | null;
  @ApiProperty() attemptNo: number;
  @ApiProperty() quotedFee: string;
  @ApiProperty({ nullable: true, type: String }) actualFee: string | null;
  @ApiProperty() codAmount: string;
  @ApiProperty({ nullable: true, type: String }) expectedDeliveryAt: string | null;
  @ApiProperty({ nullable: true, type: String }) error: string | null;
  @ApiProperty() simulated: boolean;
  @ApiProperty() deliveryAttempts: number;
  @ApiProperty({ nullable: true, type: String }) codCollectedAt: string | null;
  @ApiProperty({ nullable: true, type: String }) codRemittedAt: string | null;
  @ApiProperty({ type: [ShipmentEventResponse] }) events: ShipmentEventResponse[];
}
export class ShippingLabelResponse {
  @ApiPropertyOptional() url?: string;
  @ApiPropertyOptional() html?: string;
  @ApiProperty() internal: boolean;
}
export class ShipmentPageResponse extends PageResponse<ShipmentResponse> {
  @ApiProperty({ type: [ShipmentResponse] }) override content: ShipmentResponse[] = [];
}
