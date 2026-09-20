import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

export class SaveAttributeValueRequest {
  @ApiProperty({ example: 'den', description: 'Mã ổn định (a-z0-9-), biến thể tham chiếu theo mã này' }) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @Length(1, 40) code: string;
  @ApiProperty({ example: 'Đen' }) @IsString() @Length(1, 120) name: string;
  @ApiPropertyOptional({ nullable: true, example: '#1c1c1c' }) @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Mã màu dạng #rrggbb' }) hex?: string | null;
  @ApiPropertyOptional({ nullable: true, example: 'ao' }) @IsOptional() @Matches(/^[a-z0-9-]{1,20}$/) groupCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
