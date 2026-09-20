import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumberString, IsOptional, IsString, Length, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { PageQuery } from '@common/utils/pagination';
import { ToBoolean } from '@common/utils/transform';
import { CartQueryApi } from '../cart/queryapi/cart.queryapi';
import { PROMO_TYPE, PromotionAdminResponse, PromotionOfferResponse, PromotionService } from './promotion.service';

class TargetInput {
  @ApiProperty({ enum: ['category', 'product'] }) @IsIn(['category', 'product']) targetType: string;
  @ApiProperty({ description: 'slug ngành hàng hoặc id sản phẩm' }) @IsString() @MaxLength(160) targetRef: string;
}
class PromotionForm {
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
class CreatePromotionRequest extends PromotionForm {
  @ApiProperty({ example: 'FREESHIP' }) @Matches(/^[A-Za-z0-9_-]{3,40}$/) declare code: string;
  @ApiProperty() @IsString() @Length(2, 200) declare name: string;
  @ApiProperty({ enum: Object.values(PROMO_TYPE) }) @IsIn(Object.values(PROMO_TYPE)) declare type: string;
  @ApiProperty() @IsISO8601() declare startsAt: string;
  @ApiProperty() @IsISO8601() declare endsAt: string;
}
class PromotionListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional() @IsOptional() @ToBoolean() @IsBoolean() active?: boolean;
}

/* Web: phiếu voucher với mức giảm THẬT cho giỏ hiện tại của tôi (FE `GET /promotions/offers`). */
@ApiTags('promotions')
@ApiBearerAuth()
@Controller('promotions')
export class PromotionController {
  constructor(
    private readonly promotions: PromotionService,
    private readonly cart: CartQueryApi,
  ) {}

  @Get('offers') @ApiOperation({ summary: 'Mã đang chạy + giảm thật cho giỏ (eligible / còn thiếu bao nhiêu)' })
  async offers(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<PromotionOfferResponse[]>> {
    const b = await this.cart.basketOf(actor.userId, true);
    // Phí ship để tính freeship: chưa biết tỉnh ở bước giỏ → dùng 0; order tính lại chính xác lúc checkout.
    return ApiResponse.ok(await this.promotions.offers({ userId: actor.userId, subtotal: b.subtotal, shippingFee: 0n, lines: b.lines.filter((l) => l.isSellable).map((l) => ({ productId: l.productId, categorySlug: l.categorySlug, lineTotal: l.lineTotal })) }));
  }
}

@ApiTags('admin-promotions')
@ApiBearerAuth()
@Controller('admin/promotions')
export class AdminPromotionController {
  constructor(private readonly promotions: PromotionService) {}

  @Get() @RequirePermission('promotion.promotion.read')
  async list(@Query() q: PromotionListQuery): Promise<ApiResponse<PageResponse<PromotionAdminResponse>>> {
    return ApiResponse.ok(await this.promotions.listAdmin(q.page, q.size, q.q, q.active));
  }

  @Get(':id') @RequirePermission('promotion.promotion.read')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<PromotionAdminResponse>> {
    return ApiResponse.ok(await this.promotions.getAdmin(id));
  }

  @Get(':id/usages') @RequirePermission('promotion.promotion.read')
  async usages(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQuery) {
    return ApiResponse.ok(await this.promotions.usages(id, q.page, q.size));
  }

  @Post() @RequirePermission('promotion.promotion.manage')
  async create(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreatePromotionRequest): Promise<ApiResponse<PromotionAdminResponse>> {
    return ApiResponse.ok(await this.promotions.create(actor, body), 'Đã tạo mã khuyến mãi');
  }

  @Patch(':id') @RequirePermission('promotion.promotion.manage')
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: PromotionForm): Promise<ApiResponse<PromotionAdminResponse>> {
    return ApiResponse.ok(await this.promotions.update(actor, id, body), 'Đã cập nhật');
  }

  @Delete(':id') @HttpCode(HttpStatus.OK) @RequirePermission('promotion.promotion.manage')
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.promotions.remove(actor, id);
    return ApiResponse.ok(null, 'Đã xoá mã khuyến mãi');
  }
}
