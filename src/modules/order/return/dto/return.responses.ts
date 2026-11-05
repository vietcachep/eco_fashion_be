import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyResponse } from '@common/response/money-response';
import { RETURN_DEADLINE_KIND, RETURN_ESCALATE_SOURCE, RETURN_REASON_CODES, RETURN_RECEIVED_CONDITION, RETURN_REJECTED_BY, RETURN_RESOLVE_DECISION, RETURN_STATUS } from '../../foundation/order.constants';

export class ReturnItemResponse {
  @ApiProperty() orderItemId: string;
  @ApiProperty() name: string;
  @ApiProperty() color: string;
  @ApiProperty() size: string;
  @ApiProperty() quantity: number;
  @ApiPropertyOptional({ nullable: true }) imageUrl: string | null;
}

export class MediaItemResponse {
  @ApiProperty({ example: 'image' }) type: string;
  @ApiProperty() url: string;
  @ApiProperty() name: string;
}

/* Nơi khách gửi hàng trả (shop khai lúc duyệt) — chỉ có khi yêu cầu đang `approved`. */
export class ReturnAddressResponse {
  @ApiProperty() name: string;
  @ApiProperty() phone: string;
  @ApiProperty() address: string;
}

/* Tài khoản nhận hoàn do khách khai — số tài khoản CHỈ lộ 4 số cuối; không bao giờ có trong response của shop. */
export class RefundAccountResponse {
  @ApiProperty({ example: '970422' }) bankBin: string;
  @ApiPropertyOptional({ nullable: true }) bankName: string | null;
  @ApiProperty({ example: '****1234' }) accountNumberMasked: string;
  @ApiProperty({ example: 'NGUYEN VAN A' }) accountName: string;
}

/* Khoản hoàn tiền mới nhất của đơn bên payment (chỉ có khi yêu cầu đã `received`/`refunded`). */
export class ReturnRefundResponse {
  @ApiProperty({ enum: ['requested', 'processing', 'failed', 'done'] }) status: string;
  @ApiProperty({ type: MoneyResponse }) amount: MoneyResponse;
}

/*
 * Yêu cầu đổi trả (PLAN-0022 §4.1). `deadlineAt/deadlineKind` = hạn của bước ĐANG CHỜ; `canCancel/canShipBack/canEscalate` là quyền hành động của KHÁCH
 * (FE không tự suy từ trạng thái + giờ). Phần dành cho shop/sàn (`refundAccount`, `resolvedBy`) lọc theo người xem — xem return.mapper.ts.
 */
export class ReturnRequestResponse {
  @ApiProperty() id: string;
  @ApiProperty() orderCode: string;
  @ApiProperty() shopId: string;
  @ApiProperty() shopName: string;
  @ApiProperty({ enum: Object.values(RETURN_STATUS), example: 'requested' }) status: string;
  @ApiProperty({ enum: RETURN_REASON_CODES }) reasonCode: string;
  @ApiProperty({ description: 'false = không cần trả hàng (khách báo chưa nhận hàng) — shop duyệt là hoàn tiền ngay, không nhập kho' }) requireReturn: boolean;
  @ApiProperty() reason: string;
  @ApiPropertyOptional({ nullable: true }) detail: string | null;
  @ApiProperty({ type: MoneyResponse, description: 'Số tiền sẽ hoàn thực tế (shop chỉ được giảm; sàn ≤ tổng đơn − đã hoàn)' }) refundAmount: MoneyResponse;
  @ApiProperty({ type: MoneyResponse, description: 'Số tiền hệ thống tính lúc tạo yêu cầu (theo tỉ lệ hàng trả) — so với refundAmount để thấy mức đã chỉnh' }) calculatedRefundAmount: MoneyResponse;
  @ApiPropertyOptional({ nullable: true, description: 'Lý do chỉnh số tiền hoàn (có khi refundAmount ≠ calculatedRefundAmount)' }) adjustReason: string | null;
  @ApiProperty({ type: [ReturnItemResponse] }) items: ReturnItemResponse[];
  @ApiProperty({ type: [MediaItemResponse], description: 'Minh chứng của khách' }) evidence: MediaItemResponse[];
  @ApiPropertyOptional({ nullable: true, description: 'Hạn của bước đang chờ (ISO)' }) deadlineAt: string | null;
  @ApiPropertyOptional({ enum: Object.values(RETURN_DEADLINE_KIND), nullable: true }) deadlineKind: string | null;
  @ApiPropertyOptional({ nullable: true }) approvedAt: string | null;
  @ApiPropertyOptional({ type: ReturnAddressResponse, nullable: true, description: 'Địa chỉ gửi trả — chỉ có khi status = approved' }) returnAddress: ReturnAddressResponse | null;
  @ApiPropertyOptional({ nullable: true }) carrier: string | null;
  @ApiPropertyOptional({ nullable: true }) trackingCode: string | null;
  @ApiPropertyOptional({ nullable: true }) shippedBackAt: string | null;
  @ApiPropertyOptional({ nullable: true }) receivedAt: string | null;
  @ApiPropertyOptional({ enum: Object.values(RETURN_RECEIVED_CONDITION), nullable: true }) receivedCondition: string | null;
  @ApiPropertyOptional({ nullable: true }) receivedNote: string | null;
  @ApiProperty({ type: [MediaItemResponse], description: 'Minh chứng shop đính kèm khi xác nhận nhận hàng' }) receivedEvidence: MediaItemResponse[];
  @ApiPropertyOptional({ enum: Object.values(RETURN_REJECTED_BY), nullable: true }) rejectedBy: string | null;
  @ApiPropertyOptional({ nullable: true }) rejectReason: string | null;
  @ApiProperty({ type: [MediaItemResponse], description: 'Minh chứng shop đính kèm khi từ chối' }) rejectEvidence: MediaItemResponse[];
  @ApiPropertyOptional({ nullable: true }) escalatedAt: string | null;
  @ApiPropertyOptional({ nullable: true }) escalateReason: string | null;
  @ApiPropertyOptional({ enum: Object.values(RETURN_ESCALATE_SOURCE), nullable: true }) escalateSource: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Id nhân viên sàn phân xử — chỉ có ở API của sàn' }) resolvedBy: string | null;
  @ApiPropertyOptional({ nullable: true }) resolvedAt: string | null;
  @ApiPropertyOptional({ enum: Object.values(RETURN_RESOLVE_DECISION), nullable: true }) resolveDecision: string | null;
  @ApiPropertyOptional({ nullable: true }) resolveNote: string | null;
  @ApiPropertyOptional({ type: RefundAccountResponse, nullable: true, description: 'Tài khoản nhận hoàn đã che số — không có ở API của shop' }) refundAccount: RefundAccountResponse | null;
  @ApiPropertyOptional({ type: ReturnRefundResponse, nullable: true, description: 'Khoản hoàn tiền bên payment — chỉ có khi status = received/refunded' }) refund: ReturnRefundResponse | null;
  @ApiProperty({ description: 'COD-08b: true khi yêu cầu "chưa nhận hàng" của đơn COD đã ghi thu kết thúc bằng ĐẢO ghi thu COD (refundAmount = 0, khách chưa trả tiền nên KHÔNG có khoản hoàn; ví shop được trả lại hoa hồng)' }) codReversed: boolean;
  @ApiProperty({ description: 'Khách rút được (chưa gửi hàng)' }) canCancel: boolean;
  @ApiProperty({ description: 'Khách báo đã gửi hàng trả được (đã duyệt, cần trả hàng, còn hạn)' }) canShipBack: boolean;
  @ApiProperty({ description: 'Khách khiếu nại lên sàn được (shop từ chối, còn hạn khiếu nại)' }) canEscalate: boolean;
  @ApiPropertyOptional({ nullable: true }) processedAt: string | null;
  @ApiPropertyOptional({ nullable: true }) refundedAt: string | null;
  @ApiProperty() createdAt: string;
}

/* Chi tiết cho shop: thêm gợi ý địa chỉ nhận hàng trả (lần duyệt gần nhất của chính shop) để điền sẵn form duyệt. */
export class ShopReturnRequestResponse extends ReturnRequestResponse {
  @ApiPropertyOptional({ type: ReturnAddressResponse, nullable: true, description: 'Chỉ có ở GET /shop/returns/:id' }) suggestedReturnAddress: ReturnAddressResponse | null;
}
