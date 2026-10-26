import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { ToBoolean } from '@common/utils/transform';
import { PROMO_TYPE } from './promotion.service';

export class TargetInput {
  @ApiProperty({ enum: ['category', 'product'] }) @IsIn(['category', 'product']) targetType: string;
  @ApiProperty({ description: 'slug ngành hàng hoặc id sản phẩm' }) @IsString() @MaxLength(160) targetRef: string;
}
export class PromotionForm {
  @ApiPropertyOptional({ example: 'FREESHIP' }) @IsOptional() @Matches(/^[A-Za-z0-9_-]{3,40}$/) code?: string;
  @ApiPropertyOptional({ example: 'Miễn phí vận chuyển' }) @IsOptional() @IsString() @Length(2, 200) name?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @ApiPropertyOptional({ enum: Object.values(PROMO_TYPE) }) @IsOptional() @IsIn(Object.values(PROMO_TYPE)) type?: string;
  @ApiPropertyOptional({ example: '10', description: '% hoặc VND' }) @IsOptional() @IsNumberString() value?: string;
  @ApiPropertyOptional({ nullable: true, example: '50000' }) @IsOptional() @IsNumberString() maxDiscount?: string | null;
  @ApiPropertyOptional({ example: '300000' }) @IsOptional() @IsNumberString() minOrderAmount?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) usageLimit?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) usageLimitPerUser?: number | null;
  @ApiPropertyOptional({ enum: ['all', 'category', 'product'] }) @IsOptional() @IsIn(['all', 'category', 'product']) appliesTo?: string;
  @ApiPropertyOptional({ type: [TargetInput] }) @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => TargetInput) targets?: TargetInput[];
  @ApiPropertyOptional({ example: '2026-09-01T00:00:00Z' }) @IsOptional() @IsISO8601() startsAt?: string;
  @ApiPropertyOptional({ example: '2026-12-31T23:59:59Z' }) @IsOptional() @IsISO8601() endsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublic?: boolean;
}
export class CreatePromotionRequest extends PromotionForm {
  @ApiProperty({ example: 'FREESHIP' }) @Matches(/^[A-Za-z0-9_-]{3,40}$/) declare code: string;
  @ApiProperty() @IsString() @Length(2, 200) declare name: string;
  @ApiProperty({ enum: Object.values(PROMO_TYPE) }) @IsIn(Object.values(PROMO_TYPE)) declare type: string;
  @ApiProperty() @IsISO8601() declare startsAt: string;
  @ApiProperty() @IsISO8601() declare endsAt: string;
}
export class PromotionListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional() @IsOptional() @ToBoolean() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ enum: ['platform', 'shop'], description: 'Chỉ dành cho sàn: lọc mã sàn / mã gian hàng' }) @IsOptional() @IsIn(['platform', 'shop']) scope?: string;
  @ApiPropertyOptional({ description: 'Chỉ dành cho sàn: mã của một gian hàng' }) @IsOptional() @IsUUID('loose') shopId?: string;
}

/* Vendor (/shop/promotions): chỉ lọc q/active — scope + shopId luôn do server gắn từ ngữ cảnh, không nhận từ request. */
export class ShopPromotionListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional() @IsOptional() @ToBoolean() @IsBoolean() active?: boolean;
}
