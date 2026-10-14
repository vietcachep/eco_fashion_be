import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';

/* Số tiền VND luôn là số nguyên; trần 1 tỷ chặn nhập nhầm. */
const MAX_AMOUNT = 1_000_000_000;

export class CreateDepositRequestDto {
  @ApiProperty({ example: 500000, description: 'Số tiền muốn nộp (VND)' })
  @Type(() => Number)
  @IsInt()
  @Min(10_000, { message: 'Số tiền nộp tối thiểu 10.000đ' })
  @Max(MAX_AMOUNT)
  amount!: number;

  @ApiPropertyOptional({ description: 'Ảnh chứng từ chuyển khoản (URL)' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  proofUrl?: string;

  @ApiPropertyOptional({ example: 'Nộp quỹ để mở lại COD' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AdjustWalletDto {
  @ApiProperty({ example: 100000, description: 'Số tiền điều chỉnh: dương = cộng, âm = trừ (VND, khác 0)' })
  @Type(() => Number)
  @IsInt()
  @Min(-MAX_AMOUNT)
  @Max(MAX_AMOUNT)
  amount!: number;

  @ApiProperty({ example: 'Điều chỉnh do khiếu nại hoàn tiền #123', description: 'Lý do (≥ 5 ký tự) — vào sổ cái và nhật ký' })
  @IsString()
  @MinLength(5, { message: 'Ghi chú tối thiểu 5 ký tự' })
  @MaxLength(500)
  note!: string;
}

export class ApproveDepositDto {
  @ApiPropertyOptional({ example: 'Đã đối chiếu sao kê' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectDepositDto {
  @ApiProperty({ example: 'Chứng từ không khớp số tiền' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note!: string;
}

export class DepositListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected'] })
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: string;
}

export class WalletListQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Chỉ ví đang ≤ 0 (COD bị khoá)' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  lowOnly?: boolean;
}
