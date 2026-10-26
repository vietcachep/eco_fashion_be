import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ShopResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'SHOP-000123' }) code: string;
  @ApiProperty({ example: 'fitly-boutique' }) slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) logoUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) bannerUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty({ example: 'approved' }) status: string;
  @ApiProperty({ example: 'Đã duyệt' }) statusLabel: string;
  @ApiProperty({ example: '10.00', description: '% hoa hồng sàn thu' }) commissionRate: string;
  @ApiPropertyOptional({ nullable: true, example: '4.80' }) ratingAvg: string | null;
  @ApiProperty() totalProducts: number;
  @ApiProperty() ownerUserId: string;
  @ApiPropertyOptional({ nullable: true, example: '970436', description: 'Mã BIN ngân hàng' }) bankCode: string | null;
  @ApiPropertyOptional({ nullable: true, example: 'NGUYEN VAN A', description: 'Tên chủ tài khoản' }) bankAccountName: string | null;
  @ApiPropertyOptional({ nullable: true, example: '••••6789', description: 'Số tài khoản (che giấu, chỉ 4 chữ số cuối)' }) bankAccountNumberMasked: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

/*
 * Response cho NHÂN VIÊN SÀN (list + các thao tác approve/suspend/reject/commission): ShopResponse + chủ shop (tên/email) để FE khỏi tra
 * `GET /admin/users/:id` từng dòng (N+1; kế toán không có quyền đó). KHÔNG dùng cho vendor (`/shop/**` vẫn trả ShopResponse trần).
 * `null` khi chủ shop không còn tra được (user bị xoá hẳn).
 */
export class AdminShopSummaryResponse extends ShopResponse {
  @ApiPropertyOptional({ nullable: true, example: 'Nguyễn Văn A', description: 'Họ tên chủ shop (null nếu tài khoản chủ không còn)' }) ownerName: string | null;
  @ApiPropertyOptional({ nullable: true, example: 'chu.shop@fitly.vn', description: 'Email chủ shop (null nếu tài khoản chủ không còn)' }) ownerEmail: string | null;
}

/* Chi tiết cho admin (supplier.shop.read) — thêm full số tài khoản để xác thực payout (chỉ màn chi tiết, danh sách KHÔNG trả). */
export class AdminShopResponse extends AdminShopSummaryResponse {
  @ApiPropertyOptional({ nullable: true, example: '123456789012', description: 'Số tài khoản đầy đủ (chỉ admin xem)' }) bankAccountNumber: string | null;
}

/* Phiên vendor: gian hàng + vai + MÃ QUYỀN shop.* của người đăng nhập trong shop đó — FE dựng menu/ẩn nút theo đây. */
export class ShopSessionResponse {
  @ApiProperty({ type: () => ShopResponse }) shop: ShopResponse;
  @ApiProperty({ example: 'shop_owner' }) roleCode: string;
  @ApiProperty({ example: 'Chủ gian hàng' }) roleName: string;
  @ApiProperty({ type: [String], example: ['shop.product.read', 'shop.order.read'] }) permissions: string[];
}

/* Danh bạ gian hàng gọn cho các màn giám sát của sàn (chọn shop để xem đơn / sản phẩm / thanh toán…) — KHÔNG có chủ shop, ngân hàng, hoa hồng. */
export class ShopDirectoryItemResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'SHOP-000123' }) code: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) logoUrl: string | null;
  @ApiProperty({ example: 'approved' }) status: string;
  @ApiProperty() totalProducts: number;
}
