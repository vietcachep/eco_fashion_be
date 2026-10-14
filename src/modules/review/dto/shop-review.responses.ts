import { ApiProperty } from '@nestjs/swagger';

/* Phần trả lời của gian hàng dưới đánh giá — CỐ Ý không có tên/id nhân viên (xem ShopReviewResponse). */
export class ShopReviewReplyResponse {
  @ApiProperty({ description: 'Nội dung trả lời' }) content: string;
  @ApiProperty({ description: 'ISO-8601' }) createdAt: string;
}

/*
 * Đánh giá nhìn từ CỔNG VENDOR (/shop/reviews) — KHÁC ReviewAdminResponse của nhân viên sàn.
 * Vendor là bên thứ ba, chỉ được thấy những gì khách đã công khai trên trang sản phẩm:
 *  - KHÔNG userId / email / orderCode (định danh khách + liên kết tới đơn → vendor đối chiếu được người mua thật);
 *  - tên khách đã che ('Nguyễn V. A.') — không bao giờ trả tên đầy đủ;
 *  - KHÔNG moderationNote (ghi chú nội bộ của nhân viên sàn), KHÔNG status (vendor chỉ thấy đánh giá approved);
 *  - reply không có staffName/staffUserId (họ tên thật nhân viên của shop) — chỉ nội dung + thời điểm.
 */
export class ShopReviewResponse {
  @ApiProperty() id: string;
  @ApiProperty() productId: string;
  @ApiProperty() productName: string;
  @ApiProperty() productSlug: string;
  @ApiProperty({ example: 5, minimum: 1, maximum: 5 }) rating: number;
  @ApiProperty() content: string;
  @ApiProperty({ example: 'Nguyễn V. A.', description: 'Tên khách đã che — chỉ giữ họ, viết tắt phần còn lại' }) authorDisplay: string;
  @ApiProperty({ nullable: true, type: String, example: 'Đen / M' }) variantLabel: string | null;
  @ApiProperty({ type: [String], description: 'URL ảnh khách đính kèm' }) images: string[];
  @ApiProperty({ example: 0 }) helpfulCount: number;
  @ApiProperty({ type: () => ShopReviewReplyResponse, nullable: true }) reply: ShopReviewReplyResponse | null;
  @ApiProperty({ description: 'ISO-8601' }) createdAt: string;
}
