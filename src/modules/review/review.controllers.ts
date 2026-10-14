import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, Public, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { PageQuery } from '@common/utils/pagination';
import { MyReviewResponse, ProductReviewSummary, ReviewAdminResponse, ReviewResponse, ReviewService } from './review.service';

class MediaInput {
  @ApiProperty({ enum: ['image', 'video'] }) @IsIn(['image', 'video']) type: string;
  @ApiProperty() @IsString() @MaxLength(500) url: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
}
class CreateReviewRequest {
  @ApiProperty({ example: 5 }) @Type(() => Number) @IsInt() @Min(1) @Max(5) rating: number;
  @ApiProperty() @IsString() @Length(10, 2000) content: string;
  @ApiPropertyOptional({ type: [MediaInput] }) @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => MediaInput) media?: MediaInput[];
}
class UpdateReviewRequest {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(10, 2000) content?: string;
  @ApiPropertyOptional({ type: [MediaInput] }) @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => MediaInput) media?: MediaInput[];
}
class ReviewListQuery extends PageQuery {
  @ApiPropertyOptional({ example: 5 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
}
class AdminReviewListQuery extends ReviewListQuery {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'hidden'] }) @IsOptional() @IsIn(['pending', 'approved', 'hidden']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
}
class ModerateRequest {
  @ApiProperty({ enum: ['approved', 'hidden'] }) @IsIn(['approved', 'hidden']) status: 'approved' | 'hidden';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class ReplyRequest {
  @ApiProperty() @IsString() @Length(2, 2000) content: string;
}

/* Công khai: đánh giá của sản phẩm; đăng nhập: điều kiện, viết, đánh giá của tôi (docs/06 mục review). */
@ApiTags('reviews')
@Controller()
export class ReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Public() @Get('products/:slug/reviews') @ApiOperation({ summary: 'Đánh giá đã duyệt của sản phẩm + phân bố sao' })
  async list(@Param('slug') slug: string, @Query() q: ReviewListQuery): Promise<ApiResponse<PageResponse<ReviewResponse> & { summary: ProductReviewSummary }>> {
    return ApiResponse.ok(await this.reviews.listForProduct(slug, q.page, q.size, q.rating));
  }

  @ApiBearerAuth() @Get('products/:slug/reviews/eligibility') @ApiOperation({ summary: 'Tôi có được đánh giá sản phẩm này không (đã mua & nhận, chưa đánh giá)' })
  async eligibility(@CurrentActor() actor: AuthenticatedActor, @Param('slug') slug: string) {
    return ApiResponse.ok(await this.reviews.eligibility(actor, slug));
  }

  @ApiBearerAuth() @Post('products/:slug/reviews') @RateLimit({ name: 'review-create', limit: 10, windowSeconds: 3600, by: 'user' }) @ApiOperation({ summary: 'Viết đánh giá (đã mua) — media upload trước qua POST /uploads/media' })
  async create(@CurrentActor() actor: AuthenticatedActor, @Param('slug') slug: string, @Body() body: CreateReviewRequest): Promise<ApiResponse<MyReviewResponse>> {
    return ApiResponse.ok(await this.reviews.create(actor, slug, { rating: body.rating, content: body.content, media: body.media ?? [] }), 'Cảm ơn bạn đã đánh giá');
  }

  @ApiBearerAuth() @Get('reviews/me')
  async mine(@CurrentActor() actor: AuthenticatedActor, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<MyReviewResponse>>> {
    return ApiResponse.ok(await this.reviews.mine(actor, q.page, q.size));
  }

  @ApiBearerAuth() @Patch('reviews/me/:id')
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateReviewRequest): Promise<ApiResponse<MyReviewResponse>> {
    return ApiResponse.ok(await this.reviews.updateMine(actor, id, body), 'Đã cập nhật đánh giá');
  }

  @ApiBearerAuth() @Delete('reviews/me/:id') @HttpCode(HttpStatus.OK)
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.reviews.deleteMine(actor, id);
    return ApiResponse.ok(null, 'Đã xoá đánh giá');
  }
}

@ApiTags('admin-reviews')
@ApiBearerAuth()
@Controller('admin/reviews')
export class AdminReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Get() @RequirePermission('review.review.read')
  async list(@Query() q: AdminReviewListQuery): Promise<ApiResponse<PageResponse<ReviewAdminResponse>>> {
    return ApiResponse.ok(await this.reviews.listAdmin(q.page, q.size, { status: q.status, rating: q.rating, q: q.q }));
  }

  @Put(':id/moderate') @RequirePermission('review.review.moderate') @ApiOperation({ summary: 'Ẩn / hiện đánh giá (ghi lý do)' })
  async moderate(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ModerateRequest): Promise<ApiResponse<ReviewAdminResponse>> {
    return ApiResponse.ok(await this.reviews.moderate(actor, id, body.status, body.note), body.status === 'hidden' ? 'Đã ẩn đánh giá' : 'Đã hiện đánh giá');
  }

  @Post(':id/reply') @HttpCode(HttpStatus.OK) @RequirePermission('review.review.reply') @ApiOperation({ summary: 'Nhân viên sàn trả lời thay cửa hàng (một trả lời / đánh giá, gọi lại = sửa); hiện công khai dưới tên "Sàn FITLY", không lộ họ tên nhân viên' })
  async reply(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReplyRequest): Promise<ApiResponse<ReviewAdminResponse>> {
    return ApiResponse.ok(await this.reviews.reply(actor, id, body.content), 'Đã trả lời');
  }
}
