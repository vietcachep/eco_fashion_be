import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { BusinessException, NotFoundException, ServiceUnavailableException } from '@common/exception/business.exception';
import { ORDER_PAYMENT_GATEWAY, OrderPaymentGateway, PaymentGateway, PaymentInitiateInput, PaymentInitiateResult } from '@common/gateway/payment.gateway';
import { OutboxEventInput, writeOutboxEvent } from '@common/outbox/outbox';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import { money, MoneyResponse } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { METHOD, PAY_STATUS, PAYMENT_AUDIT, PAYMENT_ERR, PAYMENT_EVENT, PAYMENT_MODULE, REFUND_KIND, REFUND_STATUS, REFUND_STUCK_MS, TX_TYPE } from '../foundation/payment.constants';
import { PayosService } from '../payos/payos.service';

export interface PaymentMethodResponse {
  code: string;
  name: string;
  description: string | null;
  kind: string;
  isActive: boolean;
  sortOrder: number;
}

export interface PaymentResponse {
  id: string;
  orderCode: string;
  methodCode: string;
  amount: MoneyResponse;
  status: string;
  transactionCode: string | null;
  bankCode: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  transferContent: string | null;
  refundedAmount: MoneyResponse;
  paidAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface RefundResponse {
  id: string;
  orderCode: string;
  amount: MoneyResponse;
  status: string;
  method: string;
  reason: string | null;
  note: string | null;
  providerRef: string | null;
  processedAt: string | null;
  createdAt: string;
  /* order = hoàn theo đơn · duplicate_payment = hoàn khoản khách trả trùng (không đổi trạng thái thanh toán của đơn). */
  kind: string;
  /* Dữ liệu LỊCH SỬ: failed mà cổng (VNPay cũ) từng được gọi không rõ kết quả — đối chiếu trên cổng rồi nhập providerRef để ghi sổ (không còn gọi lại cổng). */
  needsReconcile: boolean;
}

type RefundKind = (typeof REFUND_KIND)[keyof typeof REFUND_KIND];
type RefundActor = Pick<AuthenticatedActor, 'userId' | 'email'>;
type RefundWithPayment = Prisma.RefundGetPayload<{ include: { payment: true } }>;
/* Kết quả bước "chi tiền": `viaGateway` = cổng đã chi (tiền ĐÃ đi, provider_ref đã ghi vào refund) — khác hoàn tay (kế toán đã chuyển, chưa có dấu vết trong hệ thống). */
interface RefundDisbursement {
  providerRef: string;
  raw: unknown;
  viaGateway: boolean;
  meta: Record<string, unknown>;
}

/*
 * Thanh toán (PLAN-0007/0018). Cài PaymentGateway cho order. CHỈ CÒN HAI phương thức, mọi khoản tiền đều về SÀN:
 *  - cod: giao dịch pending, đến khi giao thành công sàn xác nhận đã thu hộ (markCodCollected) → paid; sau đó đối soát/chi trả shop như đơn PayOS.
 *  - payos: link thanh toán PayOS; webhook/return xác minh chữ ký + số tiền, IDEMPOTENT theo (type, provider_ref) → paid.
 * Mọi chuyển paid/refunded gọi OrderPaymentGateway TRONG CÙNG tx. Hoàn tiền: yêu cầu → kế toán xử lý (PayOS payout khi đủ số TK, hoặc chuyển tay).
 * Payment lịch sử có methodCode vnpay/bank_transfer vẫn đọc/hoàn tay được (mapper không phụ thuộc phương thức), nhưng không tạo mới.
 * Webhook/return luôn qua settlePayos (khoá dòng payment, idempotent).
 */
@Injectable()
export class PaymentService implements PaymentGateway {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payos: PayosService,
    @Inject(ENV) private readonly env: Env,
    private readonly moduleRef: ModuleRef,
  ) {}

  /*
   * Cổng ngược sang order lấy LƯỜI (lúc gọi) thay vì tiêm ở constructor: OrderService → PaymentGateway → PaymentService →
   * OrderPaymentGateway → OrderService là vòng phụ thuộc; tiêm thẳng làm Nest treo khi khởi tạo.
   */
  private get orders(): OrderPaymentGateway {
    return this.moduleRef.get<OrderPaymentGateway>(ORDER_PAYMENT_GATEWAY, { strict: false });
  }

  // ------------------------------------------------------------------ methods

  async listMethods(onlyActive: boolean): Promise<PaymentMethodResponse[]> {
    const rows = await this.prisma.paymentMethod.findMany({ where: onlyActive ? { isActive: true } : {}, orderBy: { sortOrder: 'asc' } });
    return rows
      .filter((m) => !onlyActive || this.methodUsable(m.code))
      .map((m) => ({ code: m.code, name: m.name, description: m.description, kind: m.kind, isActive: m.isActive, sortOrder: m.sortOrder }));
  }

  private methodUsable(code: string): boolean {
    if (code === METHOD.PAYOS) return this.payos.isConfigured; // khoá PayOS trống ⇒ method payos tự ẩn
    return code === METHOD.COD; // vnpay/bank_transfer (lịch sử) không còn dùng được cho đơn mới
  }

  async isMethodActive(methodCode: string): Promise<boolean> {
    const m = await this.prisma.paymentMethod.findUnique({ where: { code: methodCode } });
    return Boolean(m?.isActive) && this.methodUsable(methodCode);
  }

  async setMethodActive(actor: AuthenticatedActor, code: string, isActive: boolean): Promise<PaymentMethodResponse> {
    const m = await this.prisma.paymentMethod.findUnique({ where: { code } });
    if (!m) throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không có phương thức này');
    const after = await this.prisma.$transaction(async (tx) => {
      const r = await tx.paymentMethod.update({ where: { code }, data: { isActive, updatedBy: actor.userId } });
      await this.audit(tx, actor, { action: PAYMENT_AUDIT.METHOD_UPDATED, entityType: 'payment_method', entityCode: code, before: { isActive: m.isActive }, after: { isActive } });
      return r;
    });
    return { code: after.code, name: after.name, description: after.description, kind: after.kind, isActive: after.isActive, sortOrder: after.sortOrder };
  }

  // ------------------------------------------------------------------ gateway cho order

  async initiate(input: PaymentInitiateInput, tx: Tx): Promise<PaymentInitiateResult> {
    if (!(await this.isMethodActive(input.methodCode))) throw new BusinessException(PAYMENT_ERR.METHOD_INACTIVE, 'Phương thức thanh toán không khả dụng');
    const expiresAt = input.methodCode === METHOD.COD ? null : await this.expiryFor(input.methodCode);
    const p = await tx.payment.create({
      data: {
        orderId: input.orderId,
        orderCode: input.orderCode,
        userId: input.userId,
        methodCode: input.methodCode,
        amount: input.amount.toString(),
        status: PAY_STATUS.PENDING,
        expiresAt,
        createdBy: input.userId,
      },
    });
    let paymentUrl: string | null = null;
    let qrCode: string | null = null;
    if (input.methodCode === METHOD.PAYOS) {
      const link = await this.createPayosLink(tx, p.id, input.orderCode, input.amount, expiresAt!);
      paymentUrl = link.checkoutUrl;
      qrCode = link.qrCode;
    }
    await this.audit(tx, { userId: input.userId, email: '' }, { action: PAYMENT_AUDIT.INITIATED, entityType: 'payment', entityId: p.id, entityCode: input.orderCode, after: { method: input.methodCode, amount: input.amount.toString() } });
    return { paymentId: p.id, status: 'unpaid', paymentUrl, qrCode, expiresAt };
  }

  /*
   * Tạo link PayOS cho một Payment và ghi giao dịch create_url (lưu checkoutUrl để mở lại link khi khách quay lại đơn chưa trả).
   * Không tạo được link ⇒ NÉM LỖI (rollback đơn) — không để lại đơn chờ thanh toán mà khách không có đường trả.
   */
  private async createPayosLink(tx: Tx, paymentId: string, orderCode: string, amount: bigint, expiresAt: Date): Promise<{ checkoutUrl: string; qrCode: string | null }> {
    if (!this.payos.isConfigured) throw new ServiceUnavailableException(PAYMENT_ERR.PAYOS_NOT_CONFIGURED, 'PayOS chưa được cấu hình');
    const payosOrderCode = PayosService.generateOrderCode();
    const web = this.env.EF_WEB_URL.replace(/\/$/, '');
    const link = await this.payos.createPaymentLink({ orderCode: payosOrderCode, amount, description: orderCode, returnUrl: `${web}/checkout/payos-return`, cancelUrl: `${web}/checkout/payos-return`, expiresAt });
    if (!link.checkoutUrl) throw new ServiceUnavailableException(PAYMENT_ERR.PAYOS_NOT_CONFIGURED, 'Không tạo được liên kết thanh toán PayOS — vui lòng thử lại hoặc chọn phương thức khác');
    await tx.paymentTransaction.create({
      data: { paymentId, type: TX_TYPE.CREATE_URL, status: 'ok', amount: amount.toString(), providerRef: String(payosOrderCode), rawRequest: { payosOrderCode, checkoutUrl: link.checkoutUrl, paymentLinkId: link.paymentLinkId } },
    });
    return { checkoutUrl: link.checkoutUrl, qrCode: link.qrCode };
  }

  private expiryFor(methodCode: string): Promise<Date> {
    // Link PayOS sống 30 phút (cùng mốc mặc định của setting hạn thanh toán đơn online); phương thức khác (lịch sử) giữ 24 giờ.
    const minutes = methodCode === METHOD.PAYOS ? 30 : 24 * 60;
    return Promise.resolve(new Date(Date.now() + minutes * 60_000));
  }

  async cancel(orderCode: string, reason: string, tx: Tx): Promise<void> {
    const live = await tx.payment.findFirst({ where: { orderCode, status: { in: [PAY_STATUS.PENDING, PAY_STATUS.PROCESSING] } } });
    if (!live) return;
    await tx.payment.update({ where: { id: live.id }, data: { status: PAY_STATUS.CANCELLED, version: { increment: 1 } } });
    if (live.methodCode === METHOD.PAYOS) this.cancelPayosLinkLater(live.id);
    await this.audit(tx, null, { action: PAYMENT_AUDIT.CANCELLED, entityType: 'payment', entityId: live.id, entityCode: orderCode, after: { reason } });
  }

  async markCodCollected(orderCode: string, actorUserId: string | null, tx: Tx): Promise<void> {
    const p = await tx.payment.findFirst({ where: { orderCode, methodCode: METHOD.COD, status: PAY_STATUS.PENDING } });
    if (!p) return;
    const now = new Date();
    await tx.payment.update({ where: { id: p.id }, data: { status: PAY_STATUS.PAID, paidAt: now, updatedBy: actorUserId, version: { increment: 1 } } });
    await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.COD_COLLECT, status: 'ok', amount: p.amount, providerRef: `cod:${orderCode}` } });
    await this.audit(tx, actorUserId ? { userId: actorUserId, email: '' } : null, { action: PAYMENT_AUDIT.PAID, entityType: 'payment', entityId: p.id, entityCode: orderCode, after: { method: METHOD.COD } });
    await this.orders.onPaid(orderCode, { paymentId: p.id, methodCode: METHOD.COD, transactionCode: null, bankCode: null, paidAt: now }, tx);
  }

  /* Huỷ link PayOS của một payment (best-effort, không chặn/không làm hỏng transaction gọi): khách không còn trả được vào link của đơn đã huỷ/đổi link. */
  private cancelPayosLinkLater(paymentId: string): void {
    void this.prisma.paymentTransaction
      .findFirst({ where: { paymentId, type: TX_TYPE.CREATE_URL }, select: { providerRef: true }, orderBy: { createdAt: 'desc' } })
      .then((t) => (t?.providerRef ? this.payos.cancelPaymentLink(t.providerRef) : undefined))
      .catch((err: unknown) => this.logger.warn({ err, paymentId }, 'Huỷ link PayOS lỗi (bỏ qua)'));
  }

  /*
   * Khoản thanh toán thứ hai cho đơn ĐÃ có khoản khác thu xong (khách trả cả link cũ lẫn link mới): ghi nhận rồi tạo yêu cầu hoàn khoản thừa — không gắn shop
   * (không phải doanh thu shop). Yêu cầu mang `kind = duplicate_payment` ⇒ khi hoàn xong KHÔNG đổi payment_status của đơn (đơn vẫn `paid` nhờ khoản kia), không
   * phát PAYMENT_REFUNDED, không đảo hoa hồng/doanh thu. Idempotent: một khoản thanh toán chỉ có tối đa MỘT yêu cầu hoàn trùng dù chạy lại qua đường nào.
   */
  private async refundDuplicate(tx: Tx, p: { id: string; orderCode: string; amount: Prisma.Decimal }): Promise<boolean> {
    const other = await tx.payment.findFirst({ where: { orderCode: p.orderCode, id: { not: p.id }, status: { in: [PAY_STATUS.PAID, PAY_STATUS.PARTIALLY_REFUNDED, PAY_STATUS.REFUNDED] } }, select: { id: true } });
    if (!other) return false;
    const existing = await tx.refund.findFirst({ where: { paymentId: p.id, kind: REFUND_KIND.DUPLICATE_PAYMENT }, select: { id: true } });
    if (existing) return true;
    await this.requestRefund({ orderCode: p.orderCode, shopId: null, amount: vnd(p.amount.toString()), reason: 'Thanh toán trùng — đơn đã được thanh toán bằng giao dịch khác', returnRequestId: null, actorUserId: null, paymentId: p.id, kind: REFUND_KIND.DUPLICATE_PAYMENT }, tx);
    return true;
  }

  /*
   * Tạo yêu cầu hoàn (chưa chi). Không chỉ định `paymentId` ⇒ hoàn khoản đã thu mới nhất CỦA ĐƠN, BỎ QUA khoản trả trùng đang chờ trả lại cho khách (nó đã có yêu cầu
   * hoàn đủ riêng nên phần còn lại = 0 — chọn nhầm nó sẽ chặn huỷ đơn / đổi trả của khoản thanh toán hợp lệ).
   */
  async requestRefund(input: { orderCode: string; shopId: string | null; amount: bigint; reason: string; returnRequestId: string | null; actorUserId: string | null; paymentId?: string; kind?: RefundKind }, tx: Tx): Promise<{ refundId: string | null }> {
    const target = input.paymentId ? { id: input.paymentId } : { refunds: { none: { kind: REFUND_KIND.DUPLICATE_PAYMENT } } };
    const p = await tx.payment.findFirst({ where: { orderCode: input.orderCode, ...target, status: { in: [PAY_STATUS.PAID, PAY_STATUS.PARTIALLY_REFUNDED] } }, orderBy: { createdAt: 'desc' } });
    if (!p) return { refundId: null }; // chưa thu tiền → không có gì để hoàn
    // Còn lại = đã thu − đã hoàn − các yêu cầu hoàn ĐANG CHỜ/xử lý (nếu không, hai yêu cầu cùng lúc đều qua rồi tổng hoàn vượt số đã thu).
    const inflight = await tx.refund.aggregate({ _sum: { amount: true }, where: { paymentId: p.id, status: { in: [REFUND_STATUS.REQUESTED, REFUND_STATUS.PROCESSING] } } });
    const remaining = vnd(p.amount.toString()) - vnd(p.refundedAmount.toString()) - vnd((inflight._sum.amount ?? 0).toString());
    if (input.amount > remaining) throw new BusinessException(PAYMENT_ERR.REFUND_EXCEEDS, `Số tiền hoàn vượt phần còn lại (${money(remaining).display})`);
    const r = await tx.refund.create({ data: { paymentId: p.id, orderCode: input.orderCode, shopId: input.shopId, returnRequestId: input.returnRequestId, amount: input.amount.toString(), status: REFUND_STATUS.REQUESTED, method: p.methodCode === METHOD.PAYOS ? 'gateway' : 'manual_transfer', reason: input.reason, requestedBy: input.actorUserId, kind: input.kind ?? REFUND_KIND.ORDER } });
    await this.audit(tx, input.actorUserId ? { userId: input.actorUserId, email: '' } : null, { action: PAYMENT_AUDIT.REFUND_REQUESTED, entityType: 'refund', entityId: r.id, entityCode: input.orderCode, after: { amount: input.amount.toString(), reason: input.reason, kind: input.kind ?? REFUND_KIND.ORDER } });
    return { refundId: r.id };
  }

  /* Khách thanh toán lại đơn PayOS (link hết hạn / đã huỷ trên cổng): huỷ giao dịch cũ chưa trả, tạo giao dịch + link mới. */
  async retryPayos(actor: AuthenticatedActor, orderCode: string): Promise<{ paymentUrl: string }> {
    if (!this.payos.isConfigured) throw new ServiceUnavailableException(PAYMENT_ERR.PAYOS_NOT_CONFIGURED, 'PayOS chưa được cấu hình');
    const last = await this.prisma.payment.findFirst({ where: { orderCode, userId: actor.userId, methodCode: METHOD.PAYOS }, orderBy: { createdAt: 'desc' } });
    if (!last) throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không tìm thấy giao dịch');
    if (last.status === PAY_STATUS.PAID) throw new BusinessException(PAYMENT_ERR.ALREADY_PAID, 'Đơn đã thanh toán');
    if (!(await this.orders.canRetryPayment(orderCode))) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Đơn không còn ở trạng thái chờ thanh toán (đã huỷ hoặc đã xử lý)');
    const expiresAt = await this.expiryFor(METHOD.PAYOS);
    const url = await this.prisma.$transaction(async (tx) => {
      if (last.status === PAY_STATUS.PENDING) await tx.payment.update({ where: { id: last.id }, data: { status: PAY_STATUS.CANCELLED, version: { increment: 1 } } });
      const p = await tx.payment.create({ data: { orderId: last.orderId, orderCode, userId: actor.userId, methodCode: METHOD.PAYOS, amount: last.amount, status: PAY_STATUS.PENDING, expiresAt, createdBy: actor.userId } });
      return (await this.createPayosLink(tx, p.id, orderCode, vnd(last.amount.toString()), expiresAt)).checkoutUrl;
    }, { timeout: 20_000 }); // gọi PayOS (tối đa 8s) trong tx — mặc định Prisma 5s sẽ P2028 và để lại link mồ côi
    if (last.status === PAY_STATUS.PENDING) this.cancelPayosLinkLater(last.id); // link cũ không còn trả được
    return { paymentUrl: url };
  }

  // ------------------------------------------------------------------ PayOS webhook + return

  /*
   * Webhook PayOS (server-to-server, chỉ gửi khi KHÁCH ĐÃ TRẢ TIỀN): xác minh chữ ký → tìm giao dịch theo orderCode PayOS → settlePayos.
   * Thành công khi body.code === '00' && data.code === '00'; data.amount = số tiền thực nhận (VND, KHÔNG nhân 100 như VNPay).
   * Trả 200 cho mọi webhook hợp lệ (kể cả orderCode lạ/đã xử lý — PayOS thử lại đến khi nhận 200, và lúc đăng ký URL nó gửi mẫu orderCode=123);
   * 401 chữ ký sai; 500 lỗi hệ thống để PayOS gửi lại.
   */
  async handlePayos(body: Record<string, unknown>): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    if (!this.payos.isConfigured) return { statusCode: 401, body: { code: '01', message: 'PayOS not configured' } };
    const typed = body as { code?: string; data?: Record<string, unknown>; signature?: string };
    if (!this.payos.verifyWebhookSignature(typed)) return { statusCode: 401, body: { code: '97', message: 'Invalid signature' } };

    const data = typed.data ?? {};
    const payosOrderCode = typeof data.orderCode === 'number' || typeof data.orderCode === 'string' ? String(data.orderCode) : '';
    const paidOk = typed.code === '00' && data.code === '00';
    const found = await this.findPayosPayment(payosOrderCode);
    if (!found) {
      this.logger.warn({ payosOrderCode }, 'Webhook PayOS cho orderCode không có trong hệ thống (có thể là mẫu kiểm tra URL)');
      return { statusCode: 200, body: { code: '00', message: 'Ignored: unknown order' } };
    }
    if (!paidOk) return { statusCode: 200, body: { code: '00', message: 'Ignored: not a success event' } };

    try {
      const r = await this.settlePayos(found.paymentId, payosOrderCode, BigInt(Math.round(Number(data.amount ?? 0))), data, 'webhook');
      return { statusCode: 200, body: { code: '00', message: r === 'mismatch' ? 'Amount mismatch — recorded for review' : 'Success' } };
    } catch (err) {
      this.logger.error({ err, payosOrderCode }, 'Xử lý webhook PayOS lỗi');
      return { statusCode: 500, body: { code: '99', message: 'Internal error' } };
    }
  }

  /*
   * FE trang kết quả PayOS gọi với orderCode PayOS (query chuyển về KHÔNG đáng tin): hỏi lại PayOS trực tiếp (server-to-server) rồi mới
   * ghi nhận — cùng đường settlePayos với webhook nên idempotent. Chỉ đọc trạng thái; huỷ/hết hạn thì để job hết hạn xử lý.
   */
  async handlePayosReturn(payosOrderCode: string): Promise<{ success: boolean; orderCode: string | null; status: string; message: string }> {
    const found = await this.findPayosPayment(payosOrderCode);
    if (!found) return { success: false, orderCode: null, status: 'UNKNOWN', message: 'Không tìm thấy giao dịch' };
    const payment = await this.prisma.payment.findUnique({ where: { id: found.paymentId } });
    if (!payment) return { success: false, orderCode: null, status: 'UNKNOWN', message: 'Không tìm thấy giao dịch' };
    if (payment.status === PAY_STATUS.PAID) return { success: true, orderCode: payment.orderCode, status: 'PAID', message: 'Thanh toán thành công' };

    const info = await this.payos.getPaymentLink(payosOrderCode);
    if (info.status === 'PAID') {
      await this.settlePayos(found.paymentId, payosOrderCode, BigInt(Math.round(info.amountPaid ?? 0)), { orderCode: payosOrderCode, amount: info.amountPaid ?? 0, source: 'return-query' }, 'return');
      const after = await this.prisma.payment.findUnique({ where: { id: found.paymentId }, select: { status: true } });
      const ok = after?.status === PAY_STATUS.PAID;
      return { success: ok, orderCode: payment.orderCode, status: ok ? 'PAID' : 'MISMATCH', message: ok ? 'Thanh toán thành công' : 'Số tiền không khớp — vui lòng liên hệ cửa hàng' };
    }
    const message = info.status === 'CANCELLED' ? 'Bạn đã huỷ thanh toán' : info.status === 'EXPIRED' ? 'Liên kết thanh toán đã hết hạn' : 'Chưa nhận được thanh toán';
    return { success: false, orderCode: payment.orderCode, status: info.status ?? 'PENDING', message };
  }

  private async findPayosPayment(payosOrderCode: string): Promise<{ paymentId: string } | null> {
    if (!/^\d{1,16}$/.test(payosOrderCode)) return null;
    const row = await this.prisma.paymentTransaction.findFirst({ where: { type: TX_TYPE.CREATE_URL, providerRef: payosOrderCode, payment: { methodCode: METHOD.PAYOS } }, select: { paymentId: true } });
    return row ? { paymentId: row.paymentId } : null;
  }

  /*
   * Ghi nhận một khoản PayOS đã trả (webhook hoặc return): KHOÁ dòng payment rồi kiểm lại trạng thái trong cùng transaction ⇒ webhook lặp
   * hoặc webhook + return đồng thời chỉ cộng tiền MỘT lần. Số tiền phải khớp đơn (VND); lệch ⇒ chỉ ghi giao dịch `mismatch`, KHÔNG đánh dấu paid.
   */
  private async settlePayos(paymentId: string, payosOrderCode: string, amountPaid: bigint, data: Record<string, unknown>, source: 'webhook' | 'return'): Promise<'paid' | 'already' | 'mismatch' | 'not_pending'> {
    return this.prisma.$transaction(async (tx) => {
      const head = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "payment"."payments" WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = head[0] ? await tx.payment.findUnique({ where: { id: paymentId } }) : null;
      if (!p) return 'not_pending' as const;
      if (p.status === PAY_STATUS.PAID || p.status === PAY_STATUS.REFUNDED || p.status === PAY_STATUS.PARTIALLY_REFUNDED) {
        // Trang return thắng webhook thì gatewayResponse thiếu tài khoản đối ứng (cần để hoàn tiền tự động) — webhook đến sau BỔ SUNG, không bỏ qua.
        const stored = (p.gatewayResponse ?? {}) as Record<string, unknown>;
        if (source === 'webhook' && !stored.counterAccountNumber && data.counterAccountNumber) {
          await tx.payment.update({ where: { id: p.id }, data: { gatewayResponse: { ...stored, ...data } as Prisma.InputJsonObject } });
        }
        return 'already' as const;
      }
      const expected = vnd(p.amount.toString());
      if (amountPaid !== expected) {
        await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.PAYOS_WEBHOOK, status: 'mismatch', amount: amountPaid.toString(), providerRef: payosOrderCode, rawResponse: data as Prisma.InputJsonObject } });
        await this.audit(tx, null, { action: PAYMENT_AUDIT.FAILED, entityType: 'payment', entityId: p.id, entityCode: p.orderCode, after: { method: METHOD.PAYOS, reason: 'amount_mismatch', expected: expected.toString(), received: amountPaid.toString(), source } });
        return 'mismatch' as const;
      }
      const now = new Date();
      // return-query không mang tài khoản đối ứng ⇒ KHÔNG ghi gatewayResponse (để webhook đến sau bổ sung trọn bộ)
      await tx.payment.update({ where: { id: p.id }, data: { status: PAY_STATUS.PAID, paidAt: now, transactionCode: payosOrderCode, ...(source === 'webhook' ? { gatewayResponse: data as Prisma.InputJsonObject } : {}), version: { increment: 1 } } });
      await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.PAYOS_WEBHOOK, status: 'ok', amount: expected.toString(), providerRef: payosOrderCode, rawResponse: data as Prisma.InputJsonObject } });
      await this.audit(tx, null, { action: PAYMENT_AUDIT.PAID, entityType: 'payment', entityId: p.id, entityCode: p.orderCode, after: { method: METHOD.PAYOS, payosOrderCode, source } });
      if (await this.refundDuplicate(tx, p)) return 'paid' as const; // đơn đã được trả bằng khoản khác — hoàn khoản này, không onPaid lần hai
      await this.orders.onPaid(p.orderCode, { paymentId: p.id, methodCode: METHOD.PAYOS, transactionCode: payosOrderCode, bankCode: null, paidAt: now }, tx);
      await writeOutboxEvent(tx.paymentOutboxEvent, { eventType: PAYMENT_EVENT.PAID, aggregateType: 'payment', aggregateId: p.id, payload: { orderCode: p.orderCode, userId: p.userId, amount: expected.toString(), method: METHOD.PAYOS } });
      return 'paid' as const;
    });
  }

  // ------------------------------------------------------------------ hoàn tiền (kế toán)

  /*
   * Xử lý hoàn tiền: gateway (PayOS payout) hoặc thủ công (kế toán đã chuyển, nhập mã tham chiếu — gồm hoàn đơn COD và dữ liệu VNPay/chuyển khoản lịch sử).
   *
   * Máy trạng thái an toàn tiền — KHÔNG BAO GIỜ chi hai lần:
   *   requested|failed ─CHIẾM (compare-and-set)→ processing ─cổng chi OK→ ghi `provider_ref` ─→ GHI SỔ (1 transaction, idempotent) ─→ done
   *  - CHIẾM trước khi gọi cổng ⇒ bấm đúp / hai kế toán cùng lúc chỉ một người đi tiếp (chống hoàn hai lần thật).
   *  - Cổng vừa báo đã chi, `provider_ref` được ghi vào refund NGAY, TRƯỚC khi ghi sổ. Ghi sổ lỗi (DB chết, tổng hoàn vượt số đã thu…) ⇒ refund giữ nguyên
   *    `processing` + `provider_ref`; chạy lại CHỈ phần ghi sổ (gọi lại process / retryFinalizeRefund / job recoverStuckRefunds), tuyệt đối không gọi cổng lần hai.
   *  - PayOS gọi lại với cùng idempotency-key (= refund.id) nên an toàn, không cần dấu `gateway_attempted_at` (chỉ còn trên dữ liệu VNPay cũ: refund `failed`
   *    có dấu mà chưa có `provider_ref` ⇒ người xử lý đối chiếu trên cổng cũ rồi nhập `providerRef` để ghi sổ — không còn gọi lại cổng).
   *  - `processing` quá REFUND_STUCK_MS mà chưa có `provider_ref` ⇒ chiếm lại bằng compare-and-set theo `updated_at` (hai người cùng bấm chỉ một người thắng).
   * Ghi sổ cuối KHOÁ dòng payment và cộng `refundedAmount` từ giá trị mới nhất (không mất cập nhật khi hai khoản hoàn một phần của cùng payment hoàn tất song song),
   * kiểm lại không vượt số đã thu. Lỗi trước khi cổng chạy ⇒ nhả chiếm về `requested`.
   */
  async processRefund(actor: AuthenticatedActor, refundId: string, input: { providerRef?: string; note?: string }): Promise<RefundResponse> {
    const claimed = await this.prisma.refund.updateMany({ where: { id: refundId, status: { in: [REFUND_STATUS.REQUESTED, REFUND_STATUS.FAILED] } }, data: { status: REFUND_STATUS.PROCESSING, processedBy: actor.userId, updatedAt: new Date(), version: { increment: 1 } } });
    if (claimed.count === 0) {
      const cur = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { status: true, providerRef: true, updatedAt: true } });
      if (!cur) throw new NotFoundException(PAYMENT_ERR.REFUND_NOT_FOUND, 'Không tìm thấy yêu cầu hoàn tiền');
      if (cur.status === REFUND_STATUS.DONE) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Đã hoàn xong');
      // processing còn "tươi" ⇒ người khác đang xử lý (bấm đúp): từ chối như cũ. Quá hạn ⇒ coi là treo: đã có provider_ref (cổng ĐÃ chi) thì chỉ ghi sổ, chưa có thì chiếm lại.
      const stuckBefore = new Date(Date.now() - REFUND_STUCK_MS);
      const stuck = cur.status === REFUND_STATUS.PROCESSING && cur.updatedAt < stuckBefore;
      if (stuck && cur.providerRef) return this.retryFinalizeRefund(actor, refundId);
      const retaken = stuck
        ? await this.prisma.refund.updateMany({ where: { id: refundId, status: REFUND_STATUS.PROCESSING, providerRef: null, updatedAt: { lt: stuckBefore } }, data: { processedBy: actor.userId, updatedAt: new Date(), version: { increment: 1 } } })
        : { count: 0 };
      if (retaken.count === 0) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, `Yêu cầu đang ở trạng thái ${cur.status} — không xử lý được`);
    }
    return this.runClaimedRefund(actor, refundId, input);
  }

  /*
   * Hoàn tất GHI SỔ cho refund mà cổng ĐÃ chi (`processing` + `provider_ref`) nhưng ghi sổ trước đó thất bại. KHÔNG gọi cổng. Idempotent: ghi sổ chạy dưới khoá dòng
   * payment và chỉ MỘT lần thắng compare-and-set processing → done; gọi thêm (kể cả đồng thời với request gốc / job) không ghi sổ lần hai.
   */
  async retryFinalizeRefund(actor: AuthenticatedActor, refundId: string): Promise<RefundResponse> {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!r) throw new NotFoundException(PAYMENT_ERR.REFUND_NOT_FOUND, 'Không tìm thấy yêu cầu hoàn tiền');
    if (r.status === REFUND_STATUS.DONE) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Đã hoàn xong');
    if (r.status !== REFUND_STATUS.PROCESSING || !r.providerRef) {
      throw new BusinessException(PAYMENT_ERR.INVALID_STATE, `Chỉ hoàn tất ghi sổ được yêu cầu đang processing đã có mã tham chiếu của cổng (hiện: ${r.status}${r.providerRef ? '' : ', chưa có providerRef'})`);
    }
    await this.finalizeRefund(actor, r, r.providerRef, { recovered: true }, undefined, { via: 'retry-finalize' });
    return this.getRefund(refundId);
  }

  /*
   * Job phục hồi (worker, định kỳ): refund `processing` quá hạn.
   *  - đã có provider_ref (cổng đã chi) ⇒ GHI SỔ nốt (không gọi cổng);
   *  - chưa có provider_ref, CHƯA từng gọi cổng ⇒ nhả về `requested`;
   *  - chưa có provider_ref, ĐÃ từng gọi cổng (VNPay cũ — dữ liệu lịch sử) ⇒ `failed` kèm lý do — chờ người đối chiếu (không tự đoán, không tự chi).
   * Mỗi refund một try/catch; mọi bước là compare-and-set nên chạy chồng với người bấm tay / nhiều worker vẫn an toàn.
   */
  async recoverStuckRefunds(limit = 20): Promise<{ finalized: number; released: number; flagged: number }> {
    const stuckBefore = new Date(Date.now() - REFUND_STUCK_MS);
    const rows = await this.prisma.refund.findMany({ where: { status: REFUND_STATUS.PROCESSING, updatedAt: { lt: stuckBefore } }, orderBy: { updatedAt: 'asc' }, take: limit, include: { payment: true } });
    const out = { finalized: 0, released: 0, flagged: 0 };
    for (const r of rows) {
      try {
        if (r.providerRef) {
          if (await this.finalizeRefund(null, r, r.providerRef, { recovered: true }, undefined, { via: 'job' })) out.finalized += 1;
          continue;
        }
        const flagged = Boolean(r.gatewayAttemptedAt);
        const moved = await this.prisma.$transaction(async (tx) => {
          const data = flagged
            ? { status: REFUND_STATUS.FAILED, note: 'Treo khi gọi cổng — chưa rõ cổng đã hoàn khoản này hay chưa. Đối chiếu trên cổng (VNPay cũ): nhập providerRef để ghi sổ, hoặc hoàn tay rồi nhập mã tham chiếu.', processedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } }
            : { status: REFUND_STATUS.REQUESTED, updatedAt: new Date(), version: { increment: 1 } };
          const res = await tx.refund.updateMany({ where: { id: r.id, status: REFUND_STATUS.PROCESSING, providerRef: null, updatedAt: { lt: stuckBefore } }, data });
          if (res.count === 0) return false;
          await this.audit(tx, null, { action: PAYMENT_AUDIT.REFUND_RECOVERED, entityType: 'refund', entityId: r.id, entityCode: r.orderCode, before: { status: REFUND_STATUS.PROCESSING }, after: { status: data.status, gatewayAttempted: flagged } });
          return true;
        });
        if (moved) out[flagged ? 'flagged' : 'released'] += 1;
      } catch (err) {
        this.logger.error({ err, refundId: r.id }, 'Phục hồi refund treo lỗi');
      }
    }
    return out;
  }

  /* Phần còn lại của processRefund sau khi đã CHIẾM: chi tiền (cổng/tay) → ghi sổ. Tách riêng để lỗi từng bước có cách xử lý khác nhau (xem comment processRefund). */
  private async runClaimedRefund(actor: AuthenticatedActor, refundId: string, input: { providerRef?: string; note?: string }): Promise<RefundResponse> {
    const r = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
    const ctx = { gatewayCalled: false };
    let paid: RefundDisbursement;
    try {
      paid = await this.disburseRefund(actor, r, input, ctx);
    } catch (err) {
      // Lỗi TRƯỚC khi cổng chạy (cấu hình/thiếu providerRef…): nhả chiếm. Cổng đã được gọi thì KHÔNG nhả: từ chối rõ ràng đã ghi `failed` (failRefund), còn không rõ kết quả
      // thì giữ `processing` + dấu để job/người phục hồi — tuyệt đối không quay về `requested` để ai đó bấm gọi lại cổng.
      if (!ctx.gatewayCalled) await this.releaseRefundClaim(refundId);
      throw err;
    }

    try {
      await this.finalizeRefund(actor, r, paid.providerRef, paid.raw, input.note ?? null, { via: 'process', ...paid.meta });
    } catch (err) {
      // Hoàn tay chưa để lại dấu vết ngoài hệ thống ⇒ nhả chiếm để làm lại. Cổng đã chi ⇒ GIỮ `processing` + `provider_ref` (đã ghi) để chỉ ghi sổ lại, không chi đôi.
      if (!paid.viaGateway) await this.releaseRefundClaim(refundId);
      else this.logger.error({ err, refundId, providerRef: paid.providerRef }, 'Cổng ĐÃ hoàn tiền nhưng ghi sổ lỗi — refund giữ processing + providerRef, chạy lại bước ghi sổ (retry-finalize)');
      throw err;
    }
    return this.getRefund(refundId);
  }

  private releaseRefundClaim(refundId: string): Promise<unknown> {
    return this.prisma.refund.updateMany({ where: { id: refundId, status: REFUND_STATUS.PROCESSING }, data: { status: REFUND_STATUS.REQUESTED, updatedAt: new Date(), version: { increment: 1 } } });
  }

  /* Bước CHI TIỀN của một refund đã chiếm: gọi PayOS payout (ghi providerRef) hoặc xác nhận hoàn tay. Ném lỗi nếu cổng từ chối / chưa đủ điều kiện. */
  private async disburseRefund(actor: AuthenticatedActor, r: RefundWithPayment, input: { providerRef?: string }, ctx: { gatewayCalled: boolean }): Promise<RefundDisbursement> {
    const amount = vnd(r.amount.toString());
    const manual = (providerRef: string): RefundDisbursement => ({ providerRef, raw: { manual: true }, viaGateway: false, meta: {} });
    if (r.method !== 'gateway') {
      if (!input.providerRef) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Hoàn tiền tay cần mã tham chiếu chuyển khoản (providerRef)');
      return manual(input.providerRef);
    }

    if (r.payment.methodCode === METHOD.PAYOS) {
      // PayOS hoàn tự động CHỈ khi có tài khoản đối ứng (webhook mang counterAccount*) VÀ đã cấu hình khoá payout; thiếu một trong hai ⇒ kế toán chuyển tay + nhập `providerRef`.
      const gatewayResp = (r.payment.gatewayResponse ?? {}) as Record<string, unknown>;
      const toBin = typeof gatewayResp.counterAccountBankId === 'string' ? gatewayResp.counterAccountBankId : undefined;
      const toAccountNumber = typeof gatewayResp.counterAccountNumber === 'string' ? gatewayResp.counterAccountNumber : undefined;
      if (!!toBin && !!toAccountNumber && this.payos.isPayoutConfigured) {
        ctx.gatewayCalled = true;
        let res: Awaited<ReturnType<PayosService['payout']>>;
        try {
          res = await this.payos.payout({ referenceId: r.id, amount, toBin, toAccountNumber, description: `Hoan tien don ${r.orderCode}`, idempotencyKey: r.id });
        } catch (err) {
          res = { ok: false, code: '99', message: err instanceof Error ? err.message : 'Không gọi được cổng PayOS', raw: null };
        }
        if (!res.ok) {
          await this.failRefund(r, actor, `PayOS ${res.code}: ${res.message}`, res.raw);
          throw new BusinessException('PAYMENT_REFUND_FAILED', `Cổng PayOS từ chối hoàn tiền: ${res.message} (${res.code})`, HttpStatus.BAD_GATEWAY);
        }
        const providerRef = `payos-refund:${res.transactionId ?? r.id}`;
        await this.recordGatewayRef(r.id, providerRef);
        return { providerRef, raw: res.raw, viaGateway: true, meta: {} };
      }
      if (!input.providerRef) {
        throw new BusinessException('PAYMENT_REFUND_MANUAL_REQUIRED', !toBin || !toAccountNumber ? 'PayOS không có sẵn số tài khoản khách — chuyển khoản tay rồi nhập mã tham chiếu (providerRef)' : 'PayOS payout chưa cấu hình — chuyển khoản tay rồi nhập mã tham chiếu (providerRef)');
      }
      return manual(input.providerRef); // kế toán đã chuyển tay → ghi sổ như hoàn thủ công
    }
    // Refund lịch sử qua cổng đã bỏ (VNPay): không còn gọi cổng — kế toán đối chiếu/chuyển tay rồi nhập mã tham chiếu để ghi sổ.
    if (!input.providerRef) throw new BusinessException('PAYMENT_REFUND_MANUAL_REQUIRED', 'Cổng hoàn tiền này không còn hỗ trợ — chuyển khoản tay (hoặc đối chiếu trên cổng cũ) rồi nhập mã tham chiếu (providerRef)');
    return { providerRef: input.providerRef, raw: { manual: true, legacyGateway: r.payment.methodCode }, viaGateway: false, meta: { legacyGateway: r.payment.methodCode } };
  }

  /*
   * Ghi `provider_ref` vào refund NGAY sau khi cổng báo đã chi (compare-and-set dưới quyền chiếm; không đổi trạng thái nên không tăng version). Từ đây refund là
   * "cổng đã chi, chờ ghi sổ": mọi đường phục hồi chỉ ghi sổ, không gọi lại cổng. Ghi lỗi thì ném lên — refund còn dấu + chưa providerRef ⇒ đối chiếu tay (an toàn).
   */
  private async recordGatewayRef(refundId: string, providerRef: string): Promise<void> {
    const res = await this.prisma.refund.updateMany({ where: { id: refundId, status: REFUND_STATUS.PROCESSING }, data: { providerRef, updatedAt: new Date() } });
    if (res.count === 0) this.logger.error({ refundId, providerRef }, 'Cổng đã hoàn tiền nhưng refund không còn ở processing — cần đối chiếu tay');
    else this.logger.log({ refundId, providerRef }, 'Cổng đã hoàn tiền — chờ ghi sổ');
  }

  /*
   * GHI SỔ một refund mà tiền đã đi (cổng chi xong / kế toán chuyển tay / đối chiếu). MỘT transaction, KHOÁ dòng payment trước, rồi compare-and-set `processing → done` (ai đến sau
   * thấy đã done thì bỏ qua êm — request gốc, retry-finalize và job có chạy đồng thời cũng chỉ ghi sổ MỘT lần). Trả true nếu lần gọi này là lần ghi sổ.
   *  - kind = order: cập nhật payment + giao dịch + audit, báo order (onRefunded, markReturnRefunded) + outbox PAYMENT_REFUNDED.
   *  - kind = duplicate_payment: chỉ trả tiền thừa — payment + giao dịch + audit; KHÔNG đụng đơn (payment_status vẫn `paid` nhờ khoản kia), KHÔNG outbox hoàn theo đơn.
   * `actor` null = hệ thống (job phục hồi). `note` undefined = giữ ghi chú hiện có.
   */
  private async finalizeRefund(actor: RefundActor | null, r: RefundWithPayment, providerRef: string, raw: unknown, note: string | null | undefined, meta: Record<string, unknown>): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const head = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "payment"."payments" WHERE id = ${r.paymentId}::uuid FOR UPDATE`;
      const pay = head[0] ? await tx.payment.findUnique({ where: { id: r.paymentId } }) : null;
      if (!pay) throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không tìm thấy giao dịch');
      const won = await tx.refund.updateMany({
        where: { id: r.id, status: REFUND_STATUS.PROCESSING },
        data: { status: REFUND_STATUS.DONE, providerRef, ...(note !== undefined ? { note } : {}), ...(actor ? { processedBy: actor.userId } : {}), processedAt: new Date(), version: { increment: 1 } },
      });
      if (won.count === 0) return false; // đã được ghi sổ (hoặc đổi trạng thái) bởi luồng khác
      const refunded = vnd(pay.refundedAmount.toString()) + vnd(r.amount.toString());
      if (refunded > vnd(pay.amount.toString())) throw new BusinessException(PAYMENT_ERR.REFUND_EXCEEDS, 'Tổng hoàn vượt số đã thu — kiểm tra các yêu cầu hoàn khác của giao dịch này');
      const full = refunded >= vnd(pay.amount.toString());
      await tx.payment.update({ where: { id: r.paymentId }, data: { refundedAmount: refunded.toString(), status: full ? PAY_STATUS.REFUNDED : PAY_STATUS.PARTIALLY_REFUNDED, version: { increment: 1 } } });
      await tx.paymentTransaction.create({ data: { paymentId: r.paymentId, type: TX_TYPE.REFUND, status: 'ok', amount: r.amount, providerRef, rawResponse: (raw ?? { manual: true }) } });
      await this.audit(tx, actor, { action: PAYMENT_AUDIT.REFUND_PROCESSED, entityType: 'refund', entityId: r.id, entityCode: r.orderCode, after: { amount: r.amount.toString(), method: r.method, providerRef, kind: r.kind, ...meta } });
      if (r.kind === REFUND_KIND.DUPLICATE_PAYMENT) return true;
      await this.orders.onRefunded(r.orderCode, vnd(r.amount.toString()), r.id, tx, full);
      if (r.returnRequestId) await this.orders.markReturnRefunded(r.returnRequestId, tx);
      // payload mang refundId, phương thức, shop — đối soát chi trả shop trừ hoàn tiền theo refund `done` (cả đơn COD lẫn PayOS).
      await writeOutboxEvent(tx.paymentOutboxEvent, { eventType: PAYMENT_EVENT.REFUNDED, aggregateType: 'refund', aggregateId: r.id, payload: { refundId: r.id, orderCode: r.orderCode, userId: r.payment.userId, amount: r.amount.toString(), methodCode: r.payment.methodCode, shopId: r.shopId } });
      return true;
    });
  }

  /* Cổng TỪ CHỐI hoàn tiền rõ ràng (tiền chưa đi): ghi `failed` + giao dịch lỗi, xoá dấu gọi cổng — cho phép xử lý lại sau. */
  private async failRefund(r: { id: string; paymentId: string; amount: Prisma.Decimal }, actor: AuthenticatedActor, note: string, raw: unknown): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.refund.update({ where: { id: r.id }, data: { status: REFUND_STATUS.FAILED, note: note.slice(0, 500), gatewayAttemptedAt: null, processedBy: actor.userId, processedAt: new Date(), version: { increment: 1 } } });
      await tx.paymentTransaction.create({ data: { paymentId: r.paymentId, type: TX_TYPE.REFUND, status: 'failed', amount: r.amount, rawResponse: (raw ?? {}) } });
    });
  }

  // ------------------------------------------------------------------ đọc

  async extrasForOrder(orderCode: string): Promise<{ paymentUrl: string | null; transactionCode: string | null; cardBrand: string | null; cardLast4: string | null }> {
    const p = await this.prisma.payment.findFirst({ where: { orderCode }, orderBy: { createdAt: 'desc' } });
    if (!p) return { paymentUrl: null, transactionCode: null, cardBrand: null, cardLast4: null };
    const pending = p.status === PAY_STATUS.PENDING && (!p.expiresAt || p.expiresAt > new Date());
    let paymentUrl: string | null = null;
    if (pending && p.methodCode === METHOD.PAYOS) {
      const t = await this.prisma.paymentTransaction.findFirst({ where: { paymentId: p.id, type: TX_TYPE.CREATE_URL }, orderBy: { createdAt: 'desc' }, select: { rawRequest: true } });
      paymentUrl = (t?.rawRequest as { checkoutUrl?: string } | null)?.checkoutUrl ?? null;
    }
    return { paymentUrl, transactionCode: p.transactionCode, cardBrand: p.cardBrand, cardLast4: p.cardLast4 };
  }

  async getPayment(id: string): Promise<PaymentResponse> {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không tìm thấy giao dịch');
    return PaymentService.toPayment(p);
  }

  async listPayments(page: number, size: number, f: { status?: string; methodCode?: string; q?: string }): Promise<PageResponse<PaymentResponse>> {
    const where: Prisma.PaymentWhereInput = { ...(f.status ? { status: f.status } : {}), ...(f.methodCode ? { methodCode: f.methodCode } : {}), ...(f.q ? { OR: [{ orderCode: { contains: f.q.toUpperCase() } }, { transactionCode: { contains: f.q } }] } : {}) };
    const [items, total] = await Promise.all([this.prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.payment.count({ where })]);
    return PageResponse.of(items.map((p) => PaymentService.toPayment(p)), page, size, total);
  }

  async listRefunds(page: number, size: number, status?: string): Promise<PageResponse<RefundResponse>> {
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([this.prisma.refund.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.refund.count({ where })]);
    return PageResponse.of(items.map((r) => PaymentService.toRefund(r)), page, size, total);
  }

  async getRefund(id: string): Promise<RefundResponse> {
    const r = await this.prisma.refund.findUnique({ where: { id } });
    if (!r) throw new NotFoundException(PAYMENT_ERR.REFUND_NOT_FOUND, 'Không tìm thấy yêu cầu hoàn tiền');
    return PaymentService.toRefund(r);
  }

  private static toPayment(p: { id: string; orderCode: string; methodCode: string; amount: Prisma.Decimal; status: string; transactionCode: string | null; bankCode: string | null; cardBrand: string | null; cardLast4: string | null; transferContent: string | null; refundedAmount: Prisma.Decimal; paidAt: Date | null; expiresAt: Date | null; createdAt: Date }): PaymentResponse {
    return { id: p.id, orderCode: p.orderCode, methodCode: p.methodCode, amount: money(p.amount.toString()), status: p.status, transactionCode: p.transactionCode, bankCode: p.bankCode, cardBrand: p.cardBrand, cardLast4: p.cardLast4, transferContent: p.transferContent, refundedAmount: money(p.refundedAmount.toString()), paidAt: p.paidAt?.toISOString() ?? null, expiresAt: p.expiresAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString() };
  }

  private static toRefund(r: { id: string; orderCode: string; amount: Prisma.Decimal; status: string; method: string; reason: string | null; note: string | null; providerRef: string | null; processedAt: Date | null; createdAt: Date; kind: string; gatewayAttemptedAt: Date | null }): RefundResponse {
    return {
      id: r.id,
      orderCode: r.orderCode,
      amount: money(r.amount.toString()),
      status: r.status,
      method: r.method,
      reason: r.reason,
      note: r.note,
      providerRef: r.providerRef,
      processedAt: r.processedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      kind: r.kind ?? REFUND_KIND.ORDER,
      needsReconcile: r.status === REFUND_STATUS.FAILED && Boolean(r.gatewayAttemptedAt) && !r.providerRef,
    };
  }

  private audit(tx: Tx, actor: Pick<AuthenticatedActor, 'userId' | 'email'> | null, entry: AuditEntry): Promise<void> {
    return writeAuditLog(tx.paymentAuditLog, PAYMENT_MODULE, actor, entry);
  }

  publish(tx: Tx, input: OutboxEventInput): Promise<void> {
    return writeOutboxEvent(tx.paymentOutboxEvent, input);
  }
}
