import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ProductCardResponse } from '@modules/product/queryapi/product.queryapi';

export class LiveListQuery {
  @ApiPropertyOptional({ type: Number, default: 1 }) @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional({ type: Number, default: 15 }) @Type(() => Number) @IsInt() @Min(1) @Max(50) size = 15;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['draft', 'scheduled', 'starting', 'live', 'reconnecting', 'ended', 'terminated', 'cancelled'])
  state?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shopId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) shopSlug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) categorySlug?: string;
}
export class LiveCreateRequest {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(160) title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  coverUrl?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsDateString() scheduledAt?:
    string | null;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('loose', { each: true })
  productIds?: string[];
}
export class LiveEditRequest extends PartialType(LiveCreateRequest) {
  @ApiProperty() @IsInt() @Min(0) version: number;
}
export class LiveVersionRequest {
  @ApiProperty() @IsInt() @Min(0) version: number;
}
export class LiveProductsRequest extends LiveVersionRequest {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('loose', { each: true })
  productIds: string[];
}
export class LivePinRequest extends LiveVersionRequest {
  @ApiProperty({ type: String, nullable: true }) @IsOptional() @IsUUID() productId: string | null;
}
export class LiveStartRequest {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() rehearsal?: boolean;
}
export class LiveEndRequest {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class LiveAdmissionRequest {
  @ApiProperty() @IsUUID() admissionId: string;
}
export class LiveLikeRequest extends LiveAdmissionRequest {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(20) count?: number;
}
export class LiveGrantRequest {
  @ApiPropertyOptional() @IsOptional() @IsUUID() admissionId?: string;
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsInt() @Min(1) @Max(10) quantity: number;
}
export class LiveMessageRequest {
  @ApiProperty() @IsUUID() clientMessageId: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(300) body: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() replyToId?: string;
}
export class LiveMessageQuery {
  @ApiPropertyOptional({ type: Number, default: 0 }) @Type(() => Number) @IsInt() @Min(0) after = 0;
  @ApiPropertyOptional({ type: Number, default: 20 }) @Type(() => Number) @IsInt() @Min(1) @Max(50) size = 20;
}
export class LiveModerationRequest {
  @ApiProperty({ enum: ['delete_message', 'pin_message', 'unpin_message', 'mute', 'unmute'] })
  @IsIn(['delete_message', 'pin_message', 'unpin_message', 'mute', 'unmute'])
  action: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() messageId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class LiveModeratorsRequest {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('loose', { each: true })
  userIds: string[];
}
export class LiveReportRequest {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(100) reason: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
export class LiveReportProcessRequest {
  @ApiProperty({ enum: ['dismissed', 'resolved'] }) @IsIn(['dismissed', 'resolved']) decision: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
export class LiveReportListQuery extends LiveListQuery {
  @ApiPropertyOptional() @IsOptional() @IsIn(['pending', 'dismissed', 'resolved']) status?: string;
}
export class LiveRestrictRequest {
  @ApiProperty() @IsBoolean() restricted: boolean;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(500) reason: string;
}
export class LiveFollowRequest {
  @ApiProperty() @IsBoolean() following: boolean;
}
export class LiveShopResponse {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) logoUrl: string | null;
}
export class LiveSessionResponse {
  @ApiProperty() id: string;
  @ApiProperty() shopId: string;
  @ApiProperty() title: string;
  @ApiProperty({ type: String, nullable: true }) description: string | null;
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
  @ApiProperty({ type: String, nullable: true }) scheduledAt: string | null;
  @ApiProperty() state: string;
  @ApiProperty() mode: string;
  @ApiProperty() version: number;
  @ApiProperty({ type: String, nullable: true }) startedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) endedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) endReason: string | null;
  @ApiProperty() mediaStopStatus: string;
  @ApiProperty({ type: String, nullable: true }) pinnedProductId: string | null;
  @ApiProperty({ type: String, nullable: true }) pinnedMessageId: string | null;
  @ApiProperty() viewerCount: number;
  @ApiProperty({ type: LiveShopResponse, nullable: true }) shop: LiveShopResponse | null;
  @ApiProperty() isFollowing: boolean;
  @ApiProperty() productsCount: number;
  @ApiProperty() likes: number;
  @ApiPropertyOptional({ type: () => LiveProductResponse, nullable: true })
  pinnedProduct?: LiveProductResponse | null;
  @ApiPropertyOptional() mediaAvailable?: boolean;
  @ApiPropertyOptional() canModerate?: boolean;
}
export class LiveMediaResponse {
  @ApiProperty({ type: LiveSessionResponse }) session: LiveSessionResponse;
  @ApiProperty() token: string;
  @ApiProperty() serverUrl: string;
  @ApiProperty() participantIdentity: string;
  @ApiProperty() expiresAt: string;
}
export class LiveViewerResponse {
  @ApiProperty() admissionId: string;
  @ApiProperty() participantIdentity: string;
  @ApiProperty() token: string;
  @ApiProperty() serverUrl: string;
  @ApiProperty() expiresAt: string;
}
export class LiveProductResponse {
  @ApiProperty() productId: string;
  @ApiProperty() displayNumber: number;
  @ApiProperty() position: number;
  @ApiProperty() pinned: boolean;
  @ApiProperty({ type: ProductCardResponse }) card: ProductCardResponse;
}
export class LiveMessageResponse {
  @ApiProperty() id: string;
  @ApiProperty() sequence: number;
  @ApiProperty() userId: string;
  @ApiProperty() displayName: string;
  @ApiProperty() body: string;
  @ApiProperty({ type: String, nullable: true }) replyToId: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty() deleted: boolean;
}
