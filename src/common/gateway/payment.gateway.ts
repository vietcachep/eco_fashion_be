import type { Tx } from '../prisma/types';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
export const ORDER_PAYMENT_GATEWAY = Symbol('ORDER_PAYMENT_GATEWAY');

export interface PaymentInitiateInput {
  orderId: string;
  orderCode: string;
  /* Gian hàng của đơn con — ghi vào payment để sàn lọc giao dịch theo shop. */
  shopId: string;
  userId: string;
  amount: bigint;
  /* cod | payos (PLAN-0018: chỉ còn hai phương thức) */
  methodCode: string;
  clientIp: string;
  collectionMode?: string;
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
 * Số liệu đơn COD để ghi ví cọc (PLAN-0030): `total` = khách trả (tiền mặt shop giữ) · `commissionBase` = gốc hoa hồng (tiền hàng sau voucher shop, KHÔNG phí ship)
 * · `platformCredit` = voucher SÀN sàn chịu (sàn nợ shop khoản này) · `commissionRate` = PHẦN TRĂM (snapshot trên đơn). Ví ghi: −hoa hồng + platformCredit.
 */
export interface CodSale {
  shopId: string;
  total: bigint;
  commissionBase: bigint;
  platformCredit: bigint;
  commissionRate: string;
}

/* Tài khoản ngân hàng NHẬN tiền hoàn do khách khai (PLAN-0021): `bankBin` = BIN 6 số chuẩn Napas/PayOS (cùng dạng `toBin` của PayOS payout). */
export interface RefundPayee {
  bankBin: string;
  accountNumber: string;
  accountName: string;
}

/* Tình trạng khoản hoàn MỚI NHẤT của một đơn — order hiện trên chi tiết đơn ("đang hoàn tiền" thay vì vẫn ghi "đã thanh toán"). */
export interface RefundSummary {
  status: 'requested' | 'processing' | 'failed' | 'done';
  amount: bigint;
}

/*
 * Cổng thanh toán — payment cài; order gọi trong tx tạo đơn (initiate), huỷ đơn (cancel), duyệt đổi trả (refund),
 * giao COD thành công (markCodCollected). KHÔNG BAO GIỜ nhận số thẻ.
 */
export interface PaymentGateway {
  initiate(input: PaymentInitiateInput, tx: Tx): Promise<PaymentInitiateResult>;
  cancel(orderCode: string, reason: string, tx: Tx): Promise<void>;
  /* `sale`: số liệu doanh thu/hoa hồng của đơn — payment trừ hoa hồng khỏi ví đặt cọc COD của shop (PLAN-0020) trong CÙNG tx. */
  confirmCarrierCod(orderCode:string,actor:import('../security/authenticated-actor').AuthenticatedActor,input:{amount:string;reference:string;note?:string},tx:Tx):Promise<void>;
  markCodCollected(orderCode: string, actorUserId: string | null, tx: Tx, sale: CodSale): Promise<void>;
  /*
   * PLAN-0040 Tầng 3.6 (COD-08b, PLAN-0031 §2.3): ĐẢO ghi thu COD. Shop báo đã giao (payment COD `paid`, ví shop đã bị trừ hoa hồng) nhưng khách báo CHƯA NHẬN hàng ⇒ khách chưa từng trả tiền mặt ⇒ KHÔNG có gì
   * để hoàn cho khách: payment về `cancelled` kèm `reversed_at`, ví shop được ghi dòng `cod_reversal` ngược dấu với dòng `cod_commission` của đơn (trả lại hoa hồng / thu lại phần voucher sàn đã bù).
   * Caller PHẢI đã khoá ĐƠN (FOR UPDATE) trước (thứ tự khoá ĐƠN → PAYMENT → ví) và tự cập nhật `payment_status` của đơn. Idempotent: payment COD không ở `paid` (đã đảo rồi / chưa thu / đơn PayOS) ⇒ `{ reversed: false }`,
   * không ghi gì. Payment COD đã có hoàn tiền (hoàn một phần) ⇒ 409 PAYMENT_INVALID_STATE — không đảo thu khi sổ ví đã đảo theo tỉ lệ hoàn.
   */
  reverseCodCollection(input: { orderCode: string; shopId: string; reason: string; actorUserId: string | null }, tx: Tx): Promise<{ reversed: boolean }>;
  /* PLAN-0020: shop nào bán được COD (ví đặt cọc > 0, hoặc gian hàng chính chủ). Trả đủ mọi shopId truyền vào. */
  codAvailability(shopIds: string[], tx?: Tx): Promise<Map<string, boolean>>;
  /* `paymentId` (tuỳ chọn): hoàn đúng khoản thanh toán đó (vd khoản trả TRÙNG/ĐẾN MUỘN); bỏ trống = khoản đã thu mới nhất của đơn. */
  /* `payee` (PLAN-0021): tài khoản nhận tiền hoàn do khách khai (bắt buộc với đơn COD; PayOS thì dùng tài khoản đã trả nếu có, thiếu thì lấy `payee`). */
  /* PLAN-0022: payment chuẩn hoá payee (tên bỏ dấu + in hoa); payee SAI định dạng ⇒ BusinessException 400 `PAYMENT_REFUND_PAYEE_INVALID` (BIN ≠ 6 số, số TK ≠ 6–19 số, tên lạ), vượt phần còn lại ⇒ `PAYMENT_REFUND_EXCEEDS`.
     THIẾU payee (đơn COD…) KHÔNG làm hỏng luồng của order: refund vẫn được tạo (cần chuyển tay) và kế toán được báo liên hệ khách xin tài khoản. `reason` được cắt ≤ 255 ký tự. */
  requestRefund(input: { orderCode: string; shopId: string | null; amount: bigint; reason: string; returnRequestId: string | null; actorUserId: string | null; paymentId?: string; payee?: RefundPayee | null }, tx: Tx): Promise<{ refundId: string | null }>;
  /* Khoản hoàn mới nhất theo từng mã đơn (đơn không có khoản hoàn nào ⇒ không có trong Map). */
  refundSummaries(orderCodes: string[]): Promise<Map<string, RefundSummary>>;
  isMethodActive(methodCode: string): Promise<boolean>;
  /*
   * PLAN-0025: trước khi huỷ đơn quá hạn thanh toán, HỎI LẠI cổng. 'paid' = khách đã trả (đã ghi nhận trên đường webhook, KHÔNG được huỷ) · 'unpaid' = chắc chắn chưa trả · 'unknown' = không tra được
   * (lỗi mạng) — caller để lần sau, trừ khi đã quá hạn rất lâu. Gọi NGOÀI transaction (có HTTP).
   */
  confirmPaymentStatus(orderCode: string): Promise<'paid' | 'unpaid' | 'unknown'>;
  /*
   * PLAN-0025 §2.1 (AUD-06): với PayOS, `initiate` KHÔNG gọi mạng — chỉ tạo payment `pending` (không link). Sau khi transaction đặt hàng COMMIT, order gọi hàm này để tạo link PayOS cho các đơn con
   * (timeout 8s/link, song song tối đa 3). Lỗi một link ⇒ payment vẫn `pending` kèm `last_link_error`, đơn VẪN được tạo, khách bấm "Thanh toán lại" (`linkRetryable`). Idempotent: đơn đã có link thì trả link cũ.
   * Mã đơn không phải PayOS / không còn chờ thanh toán ⇒ không có trong Map.
   */
  createCheckoutLinks(orderCodes: string[]): Promise<Map<string, { paymentUrl: string; qrCode: string | null; expiresAt: Date | null } | { error: string }>>;
}

/*
 * Cổng ngược — order cài (@Global): payment báo tiền về / thất bại / hoàn xong trong CÙNG transaction xử lý IPN
 * để trạng thái thanh toán trên đơn và giao dịch không bao giờ lệch nhau.
 */
export interface OrderPaymentGateway {
  /* Nguồn đơn mô phỏng bất biến: chặn hoàn/chi tiền thật kể cả job phục hồi. */
  simulatedOrderCodes(codes: string[]): Promise<ReadonlySet<string>>;
  /*
   * KHOÁ dòng đơn (FOR UPDATE) ngay đầu transaction của payment. THỨ TỰ KHOÁ BẤT BIẾN toàn hệ thống là ĐƠN trước, PAYMENT sau (huỷ đơn / đổi trạng thái / hoàn tiền của order đều khoá đơn rồi mới đụng payment):
   * payment muốn khoá payment rồi gọi onPaid/onRefunded (cũng khoá đơn) thì PHẢI khoá đơn trước bằng hàm này — nếu không, webhook tiền về chạy đồng thời với khách huỷ đơn sẽ deadlock (AUD-01).
   * Khoá lại trong cùng transaction là no-op. Không có đơn ⇒ không làm gì (caller tự xử lý tiếp).
   */
  lockOrder(orderCode: string, tx: Tx): Promise<void>;
  onPaid(orderCode: string, info: { paymentId: string; methodCode: string; transactionCode: string | null; bankCode: string | null; paidAt: Date }, tx: Tx): Promise<void>;
  onPaymentFailed(orderCode: string, reason: string, tx: Tx): Promise<void>;
  /* `fullyRefunded`: payment cho biết ĐÃ hoàn đủ (luỹ kế) — order không tự đoán từ một khoản hoàn lẻ. */
  onRefunded(orderCode: string, amount: bigint, refundId: string, tx: Tx, fullyRefunded?: boolean): Promise<void>;
  /* Khách còn thanh toán/thử lại được không: đơn còn `pending` và chưa thu tiền (payment dùng chặn retry link cho đơn đã huỷ). */
  canRetryPayment(orderCode: string): Promise<boolean>;
  /*
   * PLAN-0025 §2.2 (AUD-05): khách thanh toán lại ⇒ gia hạn hạn thanh toán của ĐƠN (`paymentExpiresAt`) = `until` (chỉ KÉO DÀI, không rút ngắn), để job huỷ không huỷ ngay đơn vừa có link mới.
   * Khoá đơn (FOR UPDATE) — gọi ĐẦU transaction của payment theo thứ tự khoá ĐƠN → PAYMENT. Đơn không còn pending/đã thanh toán ⇒ không làm gì.
   */
  extendPaymentDeadline(orderCode: string, until: Date, tx: Tx): Promise<void>;
  /* Hoàn tiền của yêu cầu đổi trả đã xong → yêu cầu sang refunded */
  markReturnRefunded(returnRequestId: string, tx: Tx): Promise<void>;
}
