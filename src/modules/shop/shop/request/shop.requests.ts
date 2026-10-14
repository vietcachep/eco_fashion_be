import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsUrl, Length, Max, MaxLength, Min, Matches } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { SHOP_STATUS } from '../../foundation/shop.constants';

export class ShopListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: Object.values(SHOP_STATUS) }) @IsOptional() @IsIn(Object.values(SHOP_STATUS)) status?: string;
  @ApiPropertyOptional({ description: 'Tìm theo mã / tên / slug' }) @IsOptional() @IsString() @MaxLength(160) q?: string;
}

export class RejectShopRequest {
  @ApiProperty({ example: 'Hồ sơ pháp lý không hợp lệ' }) @IsString() @Length(3, 500) reason: string;
}

export class SuspendShopRequest {
  @ApiProperty({ example: 'Bán hàng giả, khách phản ánh nhiều lần' }) @IsString() @Length(3, 500) reason: string;
}

export class UpdateCommissionRequest {
  @ApiProperty({ example: 8.5, minimum: 0, maximum: 100, description: '% hoa hồng sàn thu, không hồi tố đơn cũ' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  commissionRate: number;
}

/* Vendor tự sửa hồ sơ CHÍNH gian hàng mình (PATCH /shop/me) — KHÔNG có status/commissionRate/code/slug (sàn quản).
   logoUrl/bannerUrl/description nhận `null` để xoá (khác `undefined` = không đổi trường đó).
   Tài khoản ngân hàng: tất cả ba trường cùng lúc hoặc không gửi tất cả — xác thực trong service. */
export class UpdateShopProfileRequest {
  @ApiPropertyOptional({ example: 'FITLY Boutique' }) @IsOptional() @IsString() @Length(2, 200) name?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUrl() logoUrl?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUrl() bannerUrl?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @ApiPropertyOptional({ example: '970436', description: 'Mã BIN ngân hàng (6 chữ số)' })
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'Mã BIN phải là 6 chữ số' })
  bankCode?: string;

  @ApiPropertyOptional({ example: '123456789012', description: 'Số tài khoản (6-20 chữ số)' })
  @IsOptional()
  @Matches(/^\d{6,20}$/, { message: 'Số tài khoản phải từ 6 đến 20 chữ số' })
  bankAccountNumber?: string;

  @ApiPropertyOptional({ example: 'NGUYEN VAN A', description: 'Tên chủ tài khoản (2-120 ký tự)' })
  @IsOptional()
  @IsString()
  @Length(2, 120, { message: 'Tên chủ tài khoản phải từ 2 đến 120 ký tự' })
  bankAccountName?: string;
}
