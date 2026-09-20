import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ToBoolean } from '@common/utils/transform';
import { PageQuery } from '@common/utils/pagination';

export class ChatRequest {
  @ApiPropertyOptional({ description: 'Phiên đang chat; bỏ trống = tạo phiên mới' }) @IsOptional() @IsUUID() sessionId?: string;
  @ApiProperty({ example: 'áo thun nữ màu trắng dưới 200k' }) @IsString() @Length(1, 1000) message: string;
}

export class SupportRequestBody {
  @ApiPropertyOptional() @IsOptional() @IsUUID() sessionId?: string;
  @ApiProperty({ example: 'Tôi muốn đổi size đơn DH260915001' }) @IsString() @Length(5, 1000) summary: string;
  @ApiPropertyOptional({ description: 'Khách vãng lai để lại email' }) @IsOptional() @IsString() @MaxLength(255) email?: string;
}

/* multipart: field `image` + gender/occasion (chuỗi) */
export class StyleAnalysisBody {
  @ApiPropertyOptional({ enum: ['nam', 'nu'] }) @IsOptional() @IsIn(['nam', 'nu']) gender?: string;
  @ApiPropertyOptional({ example: 'đi làm' }) @IsOptional() @IsString() @MaxLength(100) occasion?: string;
}

/* multipart: field `image` + productId (+ colorCode) */
export class TryOnBody {
  @ApiProperty() @IsUUID() productId: string;
  @ApiPropertyOptional({ example: 'trang' }) @IsOptional() @IsString() @MaxLength(40) colorCode?: string;
}

export class ViewEventRequest {
  @ApiProperty() @IsUUID() productId: string;
}

export class RecommendQuery {
  @ApiPropertyOptional({ default: 8 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) limit?: number;
}

// ----- admin

export class DocumentListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['policy', 'faq', 'guide', 'product'] }) @IsOptional() @IsIn(['policy', 'faq', 'guide', 'product']) kind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class SaveDocumentRequest {
  @ApiProperty({ example: 'Chính sách đổi trả' }) @IsString() @Length(3, 200) title: string;
  @ApiProperty({ enum: ['policy', 'faq', 'guide', 'product'] }) @IsIn(['policy', 'faq', 'guide', 'product']) kind: string;
  @ApiProperty() @IsString() @Length(10, 20000) content: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @ToBoolean() @IsBoolean() isActive?: boolean;
}

export class UpdateDocumentRequest {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(3, 200) title?: string;
  @ApiPropertyOptional({ enum: ['policy', 'faq', 'guide', 'product'] }) @IsOptional() @IsIn(['policy', 'faq', 'guide', 'product']) kind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(10, 20000) content?: string;
  @ApiPropertyOptional() @IsOptional() @ToBoolean() @IsBoolean() isActive?: boolean;
}

export class SupportListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['open', 'in_progress', 'resolved'] }) @IsOptional() @IsIn(['open', 'in_progress', 'resolved']) status?: string;
}

export class UpdateSupportRequest {
  @ApiProperty({ enum: ['open', 'in_progress', 'resolved'] }) @IsIn(['open', 'in_progress', 'resolved']) status: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @ApiPropertyOptional({ description: 'Nhận xử lý' }) @IsOptional() @ToBoolean() @IsBoolean() assignToMe?: boolean;
}

export class FlagListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['ok', 'spam', 'toxic', 'off_topic'], description: 'Bỏ trống = mọi nhãn khác ok' }) @IsOptional() @IsIn(['ok', 'spam', 'toxic', 'off_topic']) label?: string;
}

export class CopyRequest {
  @ApiProperty({ enum: ['product_description', 'review_reply', 'promotion_copy'] }) @IsIn(['product_description', 'review_reply', 'promotion_copy']) kind: 'product_description' | 'review_reply' | 'promotion_copy';
  @ApiProperty({ description: 'Ngữ cảnh: tên/chất liệu/đặc điểm sản phẩm, nội dung đánh giá, thông tin KM…' }) @IsString() @Length(5, 3000) context: string;
  @ApiPropertyOptional({ example: 'trẻ trung' }) @IsOptional() @IsString() @MaxLength(60) tone?: string;
}

export class UsageQuery {
  @ApiPropertyOptional({ default: 14 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}

// ----- đợt 3: agent, tín hiệu, so sánh, nhân viên

export class ChatRequestV2 extends ChatRequest {
  @ApiPropertyOptional({ description: 'Slug sản phẩm khách đang xem (widget ở trang chi tiết) — "cái này" = sản phẩm đó' }) @IsOptional() @IsString() @MaxLength(160) contextProductSlug?: string;
}

export class SignalEventRequest {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty({ enum: ['view', 'add_to_cart', 'click', 'impression'] }) @IsIn(['view', 'add_to_cart', 'click', 'impression']) eventType: string;
  @ApiPropertyOptional({ enum: ['for_you', 'similar', 'bought_together', 'cart', 'chat', 'collection', 'search', 'compare', 'style', 'faq'] }) @IsOptional() @IsString() @MaxLength(30) source?: string;
}

export class SignalBatchRequest {
  @ApiProperty({ type: [SignalEventRequest] }) @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => SignalEventRequest) events: SignalEventRequest[];
}

export class CompareRequest {
  @ApiProperty({ type: [String], example: ['ao-thun-cotton-nam-basic', 'ao-thun-oversize-nam'] }) @IsArray() @ArrayMinSize(2) @ArrayMaxSize(3) @IsString({ each: true }) slugs: string[];
}

export class AskRequest {
  @ApiProperty({ example: 'Tuần này bán chạy gì, còn bao nhiêu đơn chờ xác nhận?' }) @IsString() @Length(3, 1000) question: string;
}

export class ClassifyRequest {
  @ApiProperty() @IsString() @Length(2, 200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) material?: string;
}

export class DaysQuery {
  @ApiPropertyOptional({ default: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}

export class LimitQuery {
  @ApiPropertyOptional({ default: 8 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) limit?: number;
}
