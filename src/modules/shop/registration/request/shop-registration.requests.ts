import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsBoolean, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { normalizeShopName, normalizeVnPhone, VN_MOBILE_PHONE_REGEX } from '../rules/shop-registration.rules';

/* Chuẩn hoá TRƯỚC khi validate (như NormalizeEmail ở common): không phải string thì để validator báo lỗi. */
const NormalizeText = () => Transform(({ value }): unknown => (typeof value === 'string' ? normalizeShopName(value) : value));
const NormalizePhone = () => Transform(({ value }): unknown => (typeof value === 'string' ? (normalizeVnPhone(value) ?? value.trim()) : value));
const TrimText = () => Transform(({ value }): unknown => (typeof value === 'string' ? value.trim() : value));

/*
 * Người bán nộp hồ sơ đăng ký gian hàng (PLAN-0019). Không nhận userId/shopId/status từ body — người nộp là chính actor (JWT), shop luôn
 * tạo ở trạng thái `pending`. `acceptTerms` PHẢI là `true` (đồng ý điều khoản người bán) — `false`/thiếu ⇒ 400.
 */
export class SubmitShopRegistrationRequest {
  @ApiProperty({ example: 'Xưởng May Mộc', minLength: 3, maxLength: 100, description: 'Tên gian hàng (hiển thị công khai khi được duyệt); không trùng tên shop đang chờ/đã duyệt/đang khoá (không phân biệt hoa/thường)' })
  @NormalizeText()
  @IsString()
  @Length(3, 100, { message: 'Tên gian hàng phải từ 3 đến 100 ký tự' })
  shopName: string;

  @ApiProperty({ example: 'Nguyễn Văn An', minLength: 2, maxLength: 120, description: 'Họ tên người đại diện' })
  @NormalizeText()
  @IsString()
  @Length(2, 120, { message: 'Tên người đại diện phải từ 2 đến 120 ký tự' })
  representativeName: string;

  @ApiProperty({ example: '0912345678', description: 'SĐT di động Việt Nam: 0[35789]xxxxxxxx hoặc +84… (có thể có khoảng trắng/dấu chấm) — server chuẩn hoá về 0xxxxxxxxx' })
  @NormalizePhone()
  @Matches(VN_MOBILE_PHONE_REGEX, { message: 'Số điện thoại không hợp lệ — nhập số di động Việt Nam, vd 0912345678 hoặc +84912345678' })
  phone: string;

  @ApiProperty({ format: 'uuid', description: 'Ngành hàng chính (id ngành đang hoạt động — lấy từ GET /categories)' })
  @IsUUID('all', { message: 'Ngành hàng không hợp lệ' })
  categoryId: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Giới thiệu ngắn về shop / mặt hàng định bán' })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(1000, { message: 'Mô tả tối đa 1000 ký tự' })
  description?: string;

  @ApiProperty({ example: true, description: 'Đồng ý điều khoản người bán — PHẢI là true' })
  @IsBoolean({ message: 'Bạn cần đồng ý điều khoản người bán' })
  @Equals(true, { message: 'Bạn cần đồng ý điều khoản người bán' })
  acceptTerms: boolean;
}
