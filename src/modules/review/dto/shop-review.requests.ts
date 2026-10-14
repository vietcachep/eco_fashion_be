import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

/* Không có `status`: vendor chỉ xem đánh giá đã duyệt (approved) — ẩn/chờ duyệt là việc của nhân viên sàn. */
export class ShopReviewListQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) size?: number;
}

export class ShopReviewReplyRequest {
  @ApiProperty({ minLength: 1, maxLength: 1000, description: 'Nội dung trả lời (hiển thị công khai dưới tên gian hàng)' }) @IsString() @Length(1, 1000) @Matches(/\S/, { message: 'Nội dung trả lời không được để trống' }) content: string;
}
