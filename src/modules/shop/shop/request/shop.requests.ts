import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsBoolean, IsInt, ValidateNested, IsNumber, IsOptional, IsString, IsUrl, Length, Max, MaxLength, Min, Matches } from 'class-validator';
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

/* Quản lý sàn xác minh TK ngân hàng chờ xác minh (PLAN-0040 5.2). `bankAccountNumber` = số TK ĐẦY ĐỦ quản lý đang xem (admin thấy ở chi tiết shop): chủ shop vừa đổi sang TK khác ⇒ 409 thay vì xác minh nhầm. */
export class VerifyShopBankRequest {
  @ApiPropertyOptional({ example: '123456789012', description: 'Số tài khoản đang xem (6-20 số) — khác số hiện tại của shop ⇒ 409 SHOP_BANK_CHANGED_SINCE; nên luôn gửi' })
  @IsOptional()
  @Matches(/^\d{6,20}$/, { message: 'Số tài khoản phải từ 6 đến 20 chữ số' })
  bankAccountNumber?: string;
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
export class ShopShippingAddressRequest {
  @ApiProperty() @IsString() @Length(2,120) name: string;
  @ApiProperty() @Matches(/^(0|\+84)(\d{9,10})$/) phone: string;
  @ApiProperty() @IsString() @Length(3,255) street: string;
  @ApiProperty() @IsString() @Length(2,100) provinceName: string;
  @ApiProperty() @IsString() @Length(1,100) districtName: string;
  @ApiProperty() @IsString() @Length(1,100) wardName: string;
  @ApiProperty() @IsInt() @Min(1) provinceId: number;
  @ApiProperty() @IsInt() @Min(1) districtId: number;
  @ApiProperty() @IsString() @Length(1,20) wardCode: string;
  @ApiProperty({enum:['legacy_3level']}) @IsIn(['legacy_3level']) addressSystem: 'legacy_3level';
}

export class UpdateShopProfileRequest {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() shippingCarrierEnabled?: boolean;
  @ApiPropertyOptional({type:ShopShippingAddressRequest}) @IsOptional() @ValidateNested() @Type(() => ShopShippingAddressRequest) shippingPickup?: ShopShippingAddressRequest;
  @ApiPropertyOptional({type:ShopShippingAddressRequest}) @IsOptional() @ValidateNested() @Type(() => ShopShippingAddressRequest) shippingReturn?: ShopShippingAddressRequest;
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

  @ApiPropertyOptional({ description: 'Mật khẩu hiện tại của người đang thao tác — BẮT BUỘC khi thay đổi mã ngân hàng / số tài khoản / tên chủ tài khoản (chống chiếm phiên đổi nơi nhận tiền); không cần khi chỉ sửa hồ sơ' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;
}
