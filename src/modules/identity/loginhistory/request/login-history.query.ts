import { ApiPropertyOptional } from '@nestjs/swagger';
import { ToBoolean } from '@common/utils/transform';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';

export class ListLoginHistoryQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Lọc theo email (chứa)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'true = chỉ thành công, false = chỉ thất bại' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  success?: boolean;
}
