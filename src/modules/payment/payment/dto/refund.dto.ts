import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyResponse } from '@common/response/money-response';

/* Tài khoản nhận hoàn đã che số — số đầy đủ không bao giờ ra API (chỉ dùng khi gọi PayOS payout). */
export class RefundPayeeResponse {
  @ApiProperty({ example: '970436', description: 'BIN ngân hàng (6 số Napas)' }) bankBin: string;
  @ApiProperty({ example: '****3344', description: 'Số tài khoản che, chỉ lộ 4 số cuối' }) accountNumberMasked: string;
  @ApiProperty({ example: 'NGUYEN VAN A', description: 'Tên chủ tài khoản (rỗng nếu nguồn không cung cấp)' }) accountName: string;
}

/*
 * Một khoản hoàn tiền cho màn kế toán (PLAN-0022 §4.6). `payee`/`payeeSource` cho biết khoản sẽ chi về đâu (payer = tài khoản đã trả tiền, ưu tiên · customer = khách khai · none = chưa có);
 * `gatewayStatus` = trạng thái lệnh chi PayOS (submitted · processing · succeeded · failed · null); `needsManual` = vì sao khoản đang CHỜ TAY (kế toán chuyển khoản rồi nhập mã giao dịch).
 */
export class RefundResponse {
  @ApiProperty() id: string;
  @ApiProperty() orderCode: string;
  @ApiProperty({ type: MoneyResponse }) amount: MoneyResponse;
  @ApiProperty({ enum: ['requested', 'processing', 'done', 'failed'] }) status: string;
  @ApiProperty({ enum: ['gateway', 'manual_transfer'] }) method: string;
  @ApiProperty({ nullable: true, type: String }) reason: string | null;
  @ApiProperty({ nullable: true, type: String }) note: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Mã giao dịch hoàn: mã tay kế toán nhập, hoặc `payos-refund:<payoutId>` khi PayOS xác nhận đã chuyển. Duy nhất toàn hệ thống.' }) providerRef: string | null;
  @ApiProperty({ nullable: true, type: String }) processedAt: string | null;
  @ApiProperty() createdAt: string;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Gian hàng của khoản hoàn (null: khoản trả trùng / tiền lệch không thuộc shop nào)' }) shopId?: string | null;
  @ApiPropertyOptional({ description: 'Tên gian hàng — kế toán không có quyền đọc shop nên BE trả kèm' }) shopName?: string;
  @ApiPropertyOptional({ description: 'Mã gian hàng (FT-…)' }) shopCode?: string;
  @ApiProperty({ enum: ['order', 'duplicate_payment', 'mismatch'], description: 'order = hoàn theo đơn · duplicate_payment = hoàn khoản khách trả trùng · mismatch = hoàn phần tiền lệch (trả thừa / trả thiếu rồi đơn huỷ)' }) kind: string;
  @ApiProperty({ description: 'failed mà cổng ĐÃ được gọi nhưng KHÔNG rõ kết quả (timeout / lỗi 5xx của PayOS, hoặc dữ liệu VNPay cũ): đối chiếu trên bảng điều khiển PayOS rồi nhập providerRef nếu tiền đã chuyển, hoặc chạy lại (cùng khoá idempotency — không chi đôi)' }) needsReconcile: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Yêu cầu đổi trả sinh ra khoản hoàn này (null = hoàn do huỷ đơn / thanh toán trùng)' }) returnRequestId: string | null;
  @ApiProperty({ nullable: true, type: RefundPayeeResponse, description: 'Tài khoản sẽ nhận (ưu tiên tài khoản đã trả tiền, sau đó tài khoản khách khai); null = chưa có' }) payee: RefundPayeeResponse | null;
  @ApiProperty({ enum: ['payer', 'customer', 'none'] }) payeeSource: string;
  @ApiProperty({ enum: ['submitted', 'processing', 'succeeded', 'failed'], nullable: true, type: String, description: 'Trạng thái lệnh chi PayOS; null = chưa gửi lệnh / hoàn tay. Chỉ `succeeded` mới ghi sổ done.' }) gatewayStatus: string | null;
  @ApiProperty({ description: 'Khoản đang chờ kế toán chuyển khoản tay + nhập mã giao dịch (thiếu tài khoản nhận / chưa cấu hình payout / PayOS treo bất thường)' }) needsManual: boolean;
}

/*
 * Tài khoản nhận hoàn ĐẦY ĐỦ SỐ cho kế toán chuyển khoản tay (GET /admin/refunds/:id/payee). Dữ liệu nhạy cảm: chỉ quyền `payment.refund.process`, mỗi lần xem ghi audit (không ghi số tài khoản),
 * response `Cache-Control: no-store`. Chỉ khi refund còn mở (requested | processing | failed) — đã `done` ⇒ 409, số tài khoản chỉ còn lộ 4 số cuối ở RefundResponse.payee.
 */
export class RefundPayeeRevealResponse {
  @ApiProperty({ example: '970436', description: 'BIN ngân hàng (6 số Napas)' }) bankBin: string;
  @ApiProperty({ nullable: true, type: String, example: 'Vietcombank', description: 'Tên ngân hàng khi nguồn cung cấp (tài khoản đã trả tiền: counterAccountBankName của webhook PayOS); khách khai thì null — tra theo BIN' }) bankName: string | null;
  @ApiProperty({ example: '0011223344', description: 'Số tài khoản ĐẦY ĐỦ — không log, không ghi audit' }) accountNumber: string;
  @ApiProperty({ example: 'NGUYEN VAN A', description: 'Tên chủ tài khoản (rỗng nếu nguồn không cung cấp)' }) accountName: string;
  @ApiProperty({ enum: ['payer', 'customer'], description: 'payer = tài khoản ĐÃ TRẢ tiền (ưu tiên) · customer = khách khai' }) source: string;
}
