import { ApiProperty } from '@nestjs/swagger';

/*
 * Thành viên gian hàng nhìn từ chính chủ/nhân viên của shop. CỐ Ý KHÔNG có `userId` (id tài khoản trong identity):
 * id đó là định danh dùng chung toàn hệ thống — để lộ cho vendor cho phép đối chiếu một người qua nhiều ngữ cảnh khác.
 * FE định danh dòng bằng `id` (id thành viên) và biết "đây là tôi" qua `isSelf`.
 */
export class ShopMemberResponse {
  @ApiProperty({ description: 'Id thành viên (ShopMember) — dùng cho PATCH/DELETE /shop/members/:id' }) id: string;
  @ApiProperty() email: string;
  @ApiProperty() fullName: string;
  @ApiProperty() roleId: string;
  @ApiProperty({ example: 'shop_owner' }) roleCode: string;
  @ApiProperty({ example: 'Chủ gian hàng' }) roleName: string;
  @ApiProperty({ type: [String], description: 'Quyền hiệu lực của thành viên (chủ = đủ quyền chủ; nhân viên = quyền chủ shop đã đặt hoặc preset vai)' }) permissionCodes: string[];
  @ApiProperty({ description: 'true = chủ shop đã tự đặt quyền riêng cho nhân viên này (không theo preset vai)' }) customPermissions: boolean;
  @ApiProperty({ example: 'active' }) status: string;
  @ApiProperty({ description: 'true nếu dòng này chính là người đang gọi API (để hiện "Bạn"/nút rời gian hàng)' }) isSelf: boolean;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

/* Kết quả thêm nhân viên (POST /shop/members): thành viên + cờ `restored`. */
export class AddShopMemberResponse extends ShopMemberResponse {
  @ApiProperty({ description: 'true = nhân viên TỪNG làm ở shop này (đã bị gỡ) nên tài khoản cũ được khôi phục — mật khẩu KHÔNG đổi (họ dùng mật khẩu cũ, không phải mật khẩu vừa nhập). false = tài khoản mới tạo với mật khẩu vừa nhập.' }) restored: boolean;
}
