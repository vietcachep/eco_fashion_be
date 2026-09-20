import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { PHONE_VN } from '../../auth/request/auth.requests';

/*
 * Địa chỉ giao hàng: mã tỉnh theo danh mục module system (PLAN system) — identity chỉ lưu mã + tên chụp lại
 * để địa chỉ cũ không đổi khi danh mục đổi tên.
 */
export class CreateAddressRequest {
  @ApiProperty({ example: 'Nguyễn Văn An' })
  @IsString()
  @Length(2, 120)
  recipientName: string;

  @ApiProperty({ example: '0901234567' })
  @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' })
  phone: string;

  @ApiPropertyOptional({ example: '79', description: 'Mã tỉnh/thành (danh mục system.provinces) — FE nhập tay có thể bỏ trống, BE khớp theo tên' })
  @IsOptional()
  @IsString()
  @Length(1, 10)
  provinceCode?: string;

  @ApiProperty({ example: 'TP. Hồ Chí Minh' })
  @IsString()
  @Length(2, 100)
  provinceName: string;

  @ApiPropertyOptional({ example: 'Quận 1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  districtName?: string;

  @ApiPropertyOptional({ example: 'Phường Bến Nghé' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  wardName?: string;

  @ApiProperty({ example: '12 Nguyễn Huệ' })
  @IsString()
  @Length(3, 255)
  street: string;

  @ApiPropertyOptional({ description: 'Đặt làm mặc định (địa chỉ đầu tiên luôn mặc định)' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ example: 'Giao giờ hành chính' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class UpdateAddressRequest {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) recipientName?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(PHONE_VN, { message: 'Số điện thoại Việt Nam không hợp lệ' }) phone?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @Length(1, 10) provinceCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 100) provinceName?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(100) districtName?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(100) wardName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(3, 255) street?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(255) note?: string | null;
}
