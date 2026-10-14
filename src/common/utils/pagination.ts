import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/*
 * Tham số phân trang chuẩn cho mọi API danh sách (page bắt đầu từ 1, size tối đa 100).
 * Request DTO của module extends class này rồi thêm bộ lọc riêng.
 */
export class PageQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;

  get skip(): number {
    return (this.page - 1) * this.size;
  }
}
