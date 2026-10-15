import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ShopRegistrationCategoryResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Thời trang nữ', description: 'Tên ngành hàng tại thời điểm nộp (snapshot)' }) name: string;
}

/*
 * Hồ sơ đăng ký gian hàng nhìn từ CHÍNH người nộp (POST /shop/registrations, GET /shop/registrations/me). `status` là trạng thái THẬT của
 * gian hàng (Shop.status — nguồn sự thật duy nhất, không có trạng thái thứ hai trên hồ sơ). Không có userId/email: người nộp chỉ thấy hồ sơ của mình.
 */
export class ShopRegistrationResponse {
  @ApiProperty({ format: 'uuid', description: 'Id hồ sơ' }) id: string;
  @ApiProperty({ format: 'uuid', description: 'Id gian hàng được tạo kèm hồ sơ' }) shopId: string;
  @ApiProperty({ example: 'SHOP-000019' }) shopCode: string;
  @ApiProperty({ example: 'Xưởng May Mộc' }) shopName: string;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'suspended'], description: 'pending = chờ sàn duyệt · approved = đã duyệt (người nộp đã là chủ shop) · rejected = bị từ chối (xem rejectReason, được nộp lại) · suspended = đã bị khoá' }) status: string;
  @ApiProperty() representativeName: string;
  @ApiProperty({ example: '0912345678', description: 'SĐT đã chuẩn hoá 0xxxxxxxxx' }) phone: string;
  @ApiPropertyOptional({ type: ShopRegistrationCategoryResponse, nullable: true, description: 'Ngành hàng chính (snapshot lúc nộp)' }) category: ShopRegistrationCategoryResponse | null;
  @ApiPropertyOptional({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ description: 'Thời điểm nộp hồ sơ (ISO 8601)' }) submittedAt: string;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Thời điểm sàn ra quyết định đầu tiên (duyệt/từ chối); null khi còn chờ' }) decidedAt: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Lý do sàn từ chối — chỉ có khi status = rejected' }) rejectReason: string | null;
  @ApiProperty({ description: 'true khi bị từ chối: người bán được nộp hồ sơ mới (POST /shop/registrations)' }) canReapply: boolean;
}

export class ShopRegistrationApplicantResponse {
  @ApiProperty({ format: 'uuid' }) userId: string;
  @ApiProperty() fullName: string;
  @ApiProperty() email: string;
}

/* Hồ sơ nhìn từ NHÂN VIÊN SÀN (GET /admin/shops/:id/registration, quyền supplier.shop.read): thêm thông tin người nộp. */
export class ShopRegistrationDetailResponse extends ShopRegistrationResponse {
  @ApiPropertyOptional({ type: ShopRegistrationApplicantResponse, nullable: true, description: 'Người nộp (tên + email tài khoản); null khi tài khoản không còn tra được' }) applicant: ShopRegistrationApplicantResponse | null;
}
