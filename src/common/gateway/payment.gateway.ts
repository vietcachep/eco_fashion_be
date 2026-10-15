import type { Tx } from '../prisma/types';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
export const ORDER_PAYMENT_GATEWAY = Symbol('ORDER_PAYMENT_GATEWAY');

export interface PaymentInitiateInput {
  orderId: string;
  orderCode: string;
  userId: string;
  amount: bigint;
  /* cod | payos (PLAN-0018: chỉ còn hai phương thức) */
  methodCode: string;
  clientIp: string;
}

export interface PaymentInitiateResult {
  paymentId: string;
  /* unpaid: chờ khách trả (COD/PayOS) — order giữ hàng; paid chỉ khi cổng trả về ngay (không có) */
  status: 'unpaid';
  paymentUrl: string | null;
  qrCode?: string | null;
  expiresAt: Date | null;
}

/*
 * Cổng thanh toán — payment cài; order gọi trong tx tạo đơn (initiate), huỷ đơn (cancel), duyệt đổi trả (refund),
 * giao COD thành công (markCodCollected). KHÔNG BAO GIỜ nhận số thẻ.
 */
export interface PaymentGateway {
  initiate(input: PaymentInitiateInput, tx: Tx): Promise<PaymentInitiateResult>;
  cancel(orderCode: string, reason: string, tx: Tx): Promise<void>;
  markCodCollected(orderCode: string, actorUserId: string | null, tx: Tx): Promise<void>;
  /* `paymentId` (tuỳ chọn): hoàn đúng khoản thanh toán đó (vd khoản trả TRÙNG/ĐẾN MUỘN); bỏ trống = khoản đã thu mới nhất của đơn. */
  requestRefund(input: { orderCode: string; shopId: string | null; amount: bigint; reason: string; returnRequestId: string | null; actorUserId: string | null; paymentId?: string }, tx: Tx): Promise<{ refundId: string | null }>;
  isMethodActive(methodCode: string): Promise<boolean>;
}

/*
 * Cổng ngược — order cài (@Global): payment báo tiền về / thất bại / hoàn xong trong CÙNG transaction xử lý IPN
 * để trạng thái thanh toán trên đơn và giao dịch không bao giờ lệch nhau.
 */
export interface OrderPaymentGateway {
  onPaid(orderCode: string, info: { paymentId: string; methodCode: string; transactionCode: string | null; bankCode: string | null; paidAt: Date }, tx: Tx): Promise<void>;
  onPaymentFailed(orderCode: string, reason: string, tx: Tx): Promise<void>;
  /* `fullyRefunded`: payment cho biết ĐÃ hoàn đủ (luỹ kế) — order không tự đoán từ một khoản hoàn lẻ. */
  onRefunded(orderCode: string, amount: bigint, refundId: string, tx: Tx, fullyRefunded?: boolean): Promise<void>;
  /* Khách còn thanh toán/thử lại được không: đơn còn `pending` và chưa thu tiền (payment dùng chặn retry link cho đơn đã huỷ). */
  canRetryPayment(orderCode: string): Promise<boolean>;
  /* Hoàn tiền của yêu cầu đổi trả đã xong → yêu cầu sang refunded */
  markReturnRefunded(returnRequestId: string, tx: Tx): Promise<void>;
}
