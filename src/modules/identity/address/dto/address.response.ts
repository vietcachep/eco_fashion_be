import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddressResponse {
  @ApiPropertyOptional() addressSystem?: string;
  @ApiPropertyOptional({ type: Number, nullable: true }) ghnProvinceId?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) ghnDistrictId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) ghnWardCode?: string | null;
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Nguyễn Văn An' }) recipientName: string;
  @ApiProperty({ example: '0901234567' }) phone: string;
  @ApiPropertyOptional({ nullable: true, example: '79' }) provinceCode: string | null;
  @ApiProperty({ example: 'TP. Hồ Chí Minh' }) provinceName: string;
  @ApiPropertyOptional({ nullable: true, example: 'Quận 1' }) districtName: string | null;
  @ApiPropertyOptional({ nullable: true, example: 'Phường Bến Nghé' }) wardName: string | null;
  @ApiProperty({ example: '12 Nguyễn Huệ' }) street: string;
  @ApiProperty() isDefault: boolean;
  @ApiPropertyOptional({ nullable: true }) note: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}
