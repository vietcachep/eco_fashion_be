import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from '@common/utils/transform';
import { PageQuery } from '@common/utils/pagination';
import { IsEmail, IsIn, IsString, Length } from 'class-validator';
import { SHOP_MEMBER_ROLE_CODES } from '../../foundation/shop.constants';

export class ShopMemberListQuery extends PageQuery {}

/*
 * Thêm nhân viên = chủ shop TẠO TÀI KHOẢN cho nhân viên (không mời, không chờ chấp nhận). Luật mật khẩu (8–64 ký tự, có chữ và số) do
 * identity kiểm khi tạo (một nguồn duy nhất) — ở đây chỉ chặn độ dài thô để không đẩy chuỗi khổng lồ vào bước băm.
 */
export class AddShopMemberRequest {
  @ApiProperty({ example: 'nhanvien@gmail.com', description: 'Email đăng nhập của nhân viên — phải CHƯA có tài khoản' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @NormalizeEmail()
  email: string;

  @ApiProperty({ example: 'Nguyễn Văn Kho' }) @IsString() @Length(2, 120) fullName: string;

  @ApiProperty({ description: 'Mật khẩu ban đầu (8–64 ký tự, có chữ và số) — chủ shop gửi cho nhân viên, nhân viên nên đổi sau lần đăng nhập đầu' })
  @IsString()
  @Length(8, 64, { message: 'Mật khẩu 8–64 ký tự, gồm cả chữ và số' })
  password: string;

  @ApiProperty({ enum: SHOP_MEMBER_ROLE_CODES }) @IsIn(SHOP_MEMBER_ROLE_CODES as readonly string[]) roleCode: string;
}

export class UpdateShopMemberRequest {
  @ApiProperty({ enum: SHOP_MEMBER_ROLE_CODES }) @IsIn(SHOP_MEMBER_ROLE_CODES as readonly string[]) roleCode: string;
}
