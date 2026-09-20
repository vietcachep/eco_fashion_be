import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { BusinessException, NotFoundException, ServiceUnavailableException } from '@common/exception/business.exception';
import { ORDER_PAYMENT_GATEWAY, OrderPaymentGateway, PaymentGateway, PaymentInitiateInput, PaymentInitiateResult } from '@common/gateway/payment.gateway';
import { OutboxEventInput, writeOutboxEvent } from '@common/outbox/outbox';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { RequestTraceContext } from '@common/request/request-trace.context';
import { PageResponse } from '@common/response/api-response';
import { money, MoneyResponse } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { METHOD, PAY_STATUS, PAYMENT_AUDIT, PAYMENT_ERR, PAYMENT_EVENT, PAYMENT_MODULE, REFUND_STATUS, TX_TYPE, VNPAY_RESPONSE } from '../foundation/payment.constants';
import { VnpayService } from '../vnpay/vnpay.service';

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
}

export interface VnpayResult {
  orderCode: string;
  success: boolean;
  message: string;
  responseCode: string;
  amount: MoneyResponse;
  transactionCode: string | null;
}

/*
 * Thanh toán (PLAN-0007). Cài PaymentGateway cho order:
 *  - cod: giao dịch pending, đến khi giao thành công (markCodCollected) → paid.
 *  - bank_transfer: intent VietQR (ảnh QR img.vietqr.io, nội dung = mã đơn); kế toán đối soát (confirmTransfer) → paid.
 *  - vnpay: URL redirect (HMAC); IPN/return xác minh chữ ký + số tiền, IDEMPOTENT theo (type, provider_ref) unique → paid.
 * Mọi chuyển paid/refunded gọi OrderPaymentGateway TRONG CÙNG tx. Hoàn tiền: yêu cầu → kế toán xử lý (VNPay API hoặc chuyển tay).
 */
@Injectable()
export class PaymentService implements PaymentGateway {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vnpay: VnpayService,
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
    if (code === METHOD.VNPAY) return this.vnpay.isConfigured;
    if (code === METHOD.BANK_TRANSFER) return Boolean(this.env.EF_BANK_TRANSFER_ACCOUNT_NO);
    return true;
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
        bankCode: input.bankCode ?? null,
        transferContent: input.methodCode === METHOD.BANK_TRANSFER ? input.orderCode : null,
        expiresAt,
        createdBy: input.userId,
      },
    });
    let paymentUrl: string | null = null;
    if (input.methodCode === METHOD.VNPAY) {
      paymentUrl = this.vnpay.buildPayUrl({ txnRef: PaymentService.txnRef(input.orderCode, 1), amount: input.amount, orderInfo: `Thanh toan don ${input.orderCode}`, ipAddr: input.clientIp, bankCode: input.bankCode, expiresAt: expiresAt! });
      await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.CREATE_URL, status: 'ok', amount: input.amount.toString(), providerRef: null, rawRequest: { txnRef: PaymentService.txnRef(input.orderCode, 1), bankCode: input.bankCode ?? null } } });
    }
    await this.audit(tx, { userId: input.userId, email: '' }, { action: PAYMENT_AUDIT.INITIATED, entityType: 'payment', entityId: p.id, entityCode: input.orderCode, after: { method: input.methodCode, amount: input.amount.toString() } });
    return { paymentId: p.id, status: 'unpaid', paymentIntent: input.methodCode === METHOD.BANK_TRANSFER ? this.bankIntent(input.orderCode, input.amount, expiresAt) : null, paymentUrl, expiresAt };
  }

  /* txnRef VNPay: mã đơn + '-' + lần thử (khách thử lại sau khi huỷ trên cổng → ref mới). */
  static txnRef(orderCode: string, attempt: number): string {
    return `${orderCode}-${attempt}`;
  }

  private expiryFor(methodCode: string): Promise<Date> {
    // Thời hạn lấy theo setting của order (đơn tự huỷ) — payment giữ cùng mốc để URL VNPay có ExpireDate khớp.
    const minutes = methodCode === METHOD.VNPAY ? 30 : 24 * 60;
    return Promise.resolve(new Date(Date.now() + minutes * 60_000));
  }

  private bankIntent(orderCode: string, amount: bigint, expiresAt: Date | null) {
    const bank = this.env.EF_BANK_TRANSFER_BANK_CODE;
    const acc = this.env.EF_BANK_TRANSFER_ACCOUNT_NO;
    const name = this.env.EF_BANK_TRANSFER_ACCOUNT_NAME;
    const qrUrl = bank && acc ? `https://img.vietqr.io/image/${encodeURIComponent(bank)}-${encodeURIComponent(acc)}-compact2.png?amount=${amount.toString()}&addInfo=${encodeURIComponent(orderCode)}&accountName=${encodeURIComponent(name)}` : null;
    return { bankCode: bank, accountNumber: acc, accountName: name, transferContent: orderCode, qrUrl, amount: amount.toString(), expiresAt: expiresAt?.toISOString() ?? null };
  }

  async cancel(orderCode: string, reason: string, tx: Tx): Promise<void> {
    const live = await tx.payment.findFirst({ where: { orderCode, status: { in: [PAY_STATUS.PENDING, PAY_STATUS.PROCESSING] } } });
    if (!live) return;
    await tx.payment.update({ where: { id: live.id }, data: { status: PAY_STATUS.CANCELLED, version: { increment: 1 } } });
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

  async requestRefund(input: { orderCode: string; amount: bigint; reason: string; returnRequestId: string | null; actorUserId: string | null }, tx: Tx): Promise<{ refundId: string | null }> {
    const p = await tx.payment.findFirst({ where: { orderCode: input.orderCode, status: { in: [PAY_STATUS.PAID, PAY_STATUS.PARTIALLY_REFUNDED] } }, orderBy: { createdAt: 'desc' } });
    if (!p) return { refundId: null }; // chưa thu tiền → không có gì để hoàn
    const remaining = vnd(p.amount.toString()) - vnd(p.refundedAmount.toString());
    if (input.amount > remaining) throw new BusinessException(PAYMENT_ERR.REFUND_EXCEEDS, `Số tiền hoàn vượt phần còn lại (${money(remaining).display})`);
    const r = await tx.refund.create({ data: { paymentId: p.id, orderCode: input.orderCode, returnRequestId: input.returnRequestId, amount: input.amount.toString(), status: REFUND_STATUS.REQUESTED, method: p.methodCode === METHOD.VNPAY ? 'gateway' : 'manual_transfer', reason: input.reason, requestedBy: input.actorUserId } });
    await this.audit(tx, input.actorUserId ? { userId: input.actorUserId, email: '' } : null, { action: PAYMENT_AUDIT.REFUND_REQUESTED, entityType: 'refund', entityId: r.id, entityCode: input.orderCode, after: { amount: input.amount.toString(), reason: input.reason } });
    return { refundId: r.id };
  }

  // ------------------------------------------------------------------ VNPay return / IPN

  /*
   * Xử lý kết quả VNPay (return từ FE hoặc IPN server-to-server): xác minh chữ ký → tìm giao dịch theo TxnRef →
   * kiểm số tiền → ghi payment_transactions (unique provider_ref chặn lặp) → paid + order.onPaid cùng tx.
   * Trả mã theo chuẩn IPN VNPay: 00 thành công · 02 đã xác nhận · 01 không tìm thấy · 04 sai số tiền · 97 sai chữ ký · 99 lỗi.
   */
  async handleVnpay(query: Record<string, string>, source: 'ipn' | 'return'): Promise<{ rspCode: string; message: string; result: VnpayResult | null }> {
    if (!this.vnpay.verify(query)) return { rspCode: '97', message: 'Invalid signature', result: null };
    const txnRef = query.vnp_TxnRef ?? '';
    const orderCode = txnRef.split('-')[0];
    const amount = BigInt(query.vnp_Amount ?? '0') / 100n;
    const responseCode = query.vnp_ResponseCode ?? '99';
    const success = responseCode === '00' && (query.vnp_TransactionStatus ?? '00') === '00';
    const transactionNo = query.vnp_TransactionNo || null;
    const providerRef = `${transactionNo ?? txnRef}:${responseCode}`;
    const p = await this.prisma.payment.findFirst({ where: { orderCode, methodCode: METHOD.VNPAY }, orderBy: { createdAt: 'desc' } });
    if (!p) return { rspCode: '01', message: 'Order not found', result: null };
    const result: VnpayResult = { orderCode, success, message: VNPAY_RESPONSE[responseCode] ?? `Mã lỗi ${responseCode}`, responseCode, amount: money(amount), transactionCode: transactionNo };
    if (vnd(p.amount.toString()) !== amount) return { rspCode: '04', message: 'Invalid amount', result: { ...result, success: false, message: 'Số tiền không khớp' } };
    if (p.status === PAY_STATUS.PAID) return { rspCode: '02', message: 'Order already confirmed', result: { ...result, success: true, message: VNPAY_RESPONSE['00'] } };

    try {
      await this.prisma.$transaction(async (tx) => {
        const exists = await tx.paymentTransaction.findFirst({ where: { type: TX_TYPE.IPN, providerRef } });
        if (exists) return; // lặp (return + IPN cùng đến) — đã xử lý
        await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.IPN, status: success ? 'ok' : 'failed', amount: amount.toString(), providerRef, rawResponse: { ...query, source } } });
        if (success) {
          const now = new Date();
          await tx.payment.update({ where: { id: p.id }, data: { status: PAY_STATUS.PAID, paidAt: now, transactionCode: transactionNo, bankCode: query.vnp_BankCode ?? p.bankCode, cardBrand: query.vnp_CardType ?? null, gatewayResponse: query, version: { increment: 1 } } });
          await this.audit(tx, null, { action: PAYMENT_AUDIT.PAID, entityType: 'payment', entityId: p.id, entityCode: orderCode, after: { method: METHOD.VNPAY, transactionNo, bank: query.vnp_BankCode ?? null, source } });
          await this.orders.onPaid(orderCode, { paymentId: p.id, methodCode: METHOD.VNPAY, transactionCode: transactionNo, bankCode: query.vnp_BankCode ?? null, paidAt: now }, tx);
          await writeOutboxEvent(tx.paymentOutboxEvent, { eventType: PAYMENT_EVENT.PAID, aggregateType: 'payment', aggregateId: p.id, payload: { orderCode, userId: p.userId, amount: amount.toString(), method: METHOD.VNPAY } });
        } else {
          await tx.payment.update({ where: { id: p.id }, data: { status: PAY_STATUS.FAILED, gatewayResponse: query, version: { increment: 1 } } });
          await this.audit(tx, null, { action: PAYMENT_AUDIT.FAILED, entityType: 'payment', entityId: p.id, entityCode: orderCode, after: { responseCode, source } });
          await this.orders.onPaymentFailed(orderCode, result.message, tx);
        }
      });
    } catch (err) {
      this.logger.error({ err, orderCode, source }, 'Xử lý kết quả VNPay lỗi');
      return { rspCode: '99', message: 'Unknown error', result: { ...result, success: false, message: 'Lỗi xử lý, vui lòng liên hệ cửa hàng' } };
    }
    this.logger.log({ orderCode, success, source, transactionNo }, 'Đã xử lý kết quả VNPay');
    return { rspCode: '00', message: 'Confirm Success', result };
  }

  /* Khách thử lại sau khi thất bại/huỷ trên cổng: giao dịch failed/cancelled → tạo giao dịch mới + URL mới. */
  async retryVnpay(actor: AuthenticatedActor, orderCode: string): Promise<{ paymentUrl: string }> {
    if (!this.vnpay.isConfigured) throw new ServiceUnavailableException(PAYMENT_ERR.VNPAY_NOT_CONFIGURED, 'VNPay chưa được cấu hình');
    const last = await this.prisma.payment.findFirst({ where: { orderCode, userId: actor.userId, methodCode: METHOD.VNPAY }, orderBy: { createdAt: 'desc' } });
    if (!last) throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không tìm thấy giao dịch');
    if (last.status === PAY_STATUS.PAID) throw new BusinessException(PAYMENT_ERR.ALREADY_PAID, 'Đơn đã thanh toán');
    const attempts = await this.prisma.payment.count({ where: { orderCode, methodCode: METHOD.VNPAY } });
    const expiresAt = await this.expiryFor(METHOD.VNPAY);
    const ip = RequestTraceContext.current()?.ip ?? '127.0.0.1';
    const url = await this.prisma.$transaction(async (tx) => {
      if (last.status === PAY_STATUS.PENDING) {
        await tx.payment.update({ where: { id: last.id }, data: { status: PAY_STATUS.CANCELLED, version: { increment: 1 } } });
      }
      const p = await tx.payment.create({ data: { orderId: last.orderId, orderCode, userId: actor.userId, methodCode: METHOD.VNPAY, amount: last.amount, status: PAY_STATUS.PENDING, bankCode: last.bankCode, expiresAt, createdBy: actor.userId } });
      const ref = PaymentService.txnRef(orderCode, attempts + 1);
      const u = this.vnpay.buildPayUrl({ txnRef: ref, amount: vnd(last.amount.toString()), orderInfo: `Thanh toan don ${orderCode}`, ipAddr: ip, bankCode: last.bankCode, expiresAt });
      await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.CREATE_URL, status: 'ok', amount: last.amount, rawRequest: { txnRef: ref, retry: true } } });
      return u;
    });
    return { paymentUrl: url };
  }

  // ------------------------------------------------------------------ đối soát chuyển khoản, hoàn tiền (kế toán)

  async confirmTransfer(actor: AuthenticatedActor, paymentId: string, input: { bankRef?: string; note?: string }): Promise<PaymentResponse> {
    await this.prisma.$transaction(async (tx) => {
      const head = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "payment"."payments" WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = head[0] ? await tx.payment.findUnique({ where: { id: paymentId } }) : null;
      if (!p) throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không tìm thấy giao dịch');
      if (p.methodCode !== METHOD.BANK_TRANSFER) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Chỉ đối soát giao dịch chuyển khoản');
      if (p.status === PAY_STATUS.PAID) throw new BusinessException(PAYMENT_ERR.ALREADY_PAID, 'Giao dịch đã được xác nhận');
      if (p.status !== PAY_STATUS.PENDING) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, `Giao dịch đang ở trạng thái ${p.status}`);
      const now = new Date();
      await tx.payment.update({ where: { id: p.id }, data: { status: PAY_STATUS.PAID, paidAt: now, transactionCode: input.bankRef ?? null, updatedBy: actor.userId, version: { increment: 1 } } });
      await tx.bankTransferConfirmation.create({ data: { paymentId: p.id, amount: p.amount, bankRef: input.bankRef ?? null, note: input.note ?? null, confirmedBy: actor.userId } });
      await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.MANUAL_CONFIRM, status: 'ok', amount: p.amount, providerRef: `manual:${p.id}` } });
      await this.audit(tx, actor, { action: PAYMENT_AUDIT.TRANSFER_CONFIRMED, entityType: 'payment', entityId: p.id, entityCode: p.orderCode, after: { bankRef: input.bankRef ?? null, amount: p.amount.toString() } });
      await this.orders.onPaid(p.orderCode, { paymentId: p.id, methodCode: METHOD.BANK_TRANSFER, transactionCode: input.bankRef ?? null, bankCode: this.env.EF_BANK_TRANSFER_BANK_CODE || null, paidAt: now }, tx);
      await writeOutboxEvent(tx.paymentOutboxEvent, { eventType: PAYMENT_EVENT.PAID, aggregateType: 'payment', aggregateId: p.id, payload: { orderCode: p.orderCode, userId: p.userId, amount: p.amount.toString(), method: METHOD.BANK_TRANSFER } });
    });
    return this.getPayment(paymentId);
  }

  /* Xử lý hoàn tiền: gateway (VNPay API) hoặc manual_transfer (kế toán đã chuyển, nhập mã tham chiếu). */
  async processRefund(actor: AuthenticatedActor, refundId: string, input: { providerRef?: string; note?: string }): Promise<RefundResponse> {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!r) throw new NotFoundException(PAYMENT_ERR.REFUND_NOT_FOUND, 'Không tìm thấy yêu cầu hoàn tiền');
    if (r.status === REFUND_STATUS.DONE) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Đã hoàn xong');
    let providerRef = input.providerRef ?? null;
    let gatewayRaw: unknown = null;
    if (r.method === 'gateway') {
      if (!this.vnpay.isConfigured) throw new ServiceUnavailableException(PAYMENT_ERR.VNPAY_NOT_CONFIGURED, 'VNPay chưa được cấu hình');
      const paidTx = await this.prisma.paymentTransaction.findFirst({ where: { paymentId: r.paymentId, type: TX_TYPE.IPN, status: 'ok' }, orderBy: { createdAt: 'desc' } });
      const raw = (paidTx?.rawResponse ?? {}) as Record<string, string>;
      const res = await this.vnpay.refund({
        txnRef: raw.vnp_TxnRef ?? PaymentService.txnRef(r.orderCode, 1),
        amount: vnd(r.amount.toString()),
        transactionNo: r.payment.transactionCode ?? '',
        transactionDate: raw.vnp_PayDate ?? VnpayService.formatDate(r.payment.paidAt ?? r.payment.createdAt),
        fullRefund: vnd(r.amount.toString()) >= vnd(r.payment.amount.toString()),
        createBy: actor.email,
        ipAddr: RequestTraceContext.current()?.ip ?? '127.0.0.1',
        orderInfo: `Hoan tien don ${r.orderCode}`,
      });
      gatewayRaw = res.raw;
      if (!res.ok) {
        await this.prisma.$transaction(async (tx) => {
          await tx.refund.update({ where: { id: refundId }, data: { status: REFUND_STATUS.FAILED, note: `VNPay ${res.code}: ${res.message}`, processedBy: actor.userId, processedAt: new Date(), version: { increment: 1 } } });
          await tx.paymentTransaction.create({ data: { paymentId: r.paymentId, type: TX_TYPE.REFUND, status: 'failed', amount: r.amount, rawResponse: (res.raw ?? {}) } });
        });
        throw new BusinessException('PAYMENT_REFUND_FAILED', `Cổng từ chối hoàn tiền: ${res.message} (${res.code})`, 502);
      }
      providerRef = `vnpay-refund:${(res.raw as { vnp_TransactionNo?: string })?.vnp_TransactionNo ?? Date.now()}`;
    } else if (!providerRef) {
      throw new BusinessException('COMMON_VALIDATION_ERROR', 'Hoàn tiền tay cần mã tham chiếu chuyển khoản (providerRef)');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.refund.update({ where: { id: refundId }, data: { status: REFUND_STATUS.DONE, providerRef, note: input.note ?? null, processedBy: actor.userId, processedAt: new Date(), version: { increment: 1 } } });
      const refunded = vnd(r.payment.refundedAmount.toString()) + vnd(r.amount.toString());
      const full = refunded >= vnd(r.payment.amount.toString());
      await tx.payment.update({ where: { id: r.paymentId }, data: { refundedAmount: refunded.toString(), status: full ? PAY_STATUS.REFUNDED : PAY_STATUS.PARTIALLY_REFUNDED, version: { increment: 1 } } });
      await tx.paymentTransaction.create({ data: { paymentId: r.paymentId, type: TX_TYPE.REFUND, status: 'ok', amount: r.amount, providerRef, rawResponse: (gatewayRaw ?? { manual: true }) } });
      await this.audit(tx, actor, { action: PAYMENT_AUDIT.REFUND_PROCESSED, entityType: 'refund', entityId: refundId, entityCode: r.orderCode, after: { amount: r.amount.toString(), method: r.method, providerRef } });
      await this.orders.onRefunded(r.orderCode, vnd(r.amount.toString()), refundId, tx);
      if (r.returnRequestId) await this.orders.markReturnRefunded(r.returnRequestId, tx);
      await writeOutboxEvent(tx.paymentOutboxEvent, { eventType: PAYMENT_EVENT.REFUNDED, aggregateType: 'refund', aggregateId: refundId, payload: { orderCode: r.orderCode, userId: r.payment.userId, amount: r.amount.toString() } });
    });
    return this.getRefund(refundId);
  }

  // ------------------------------------------------------------------ đọc

  async extrasForOrder(orderCode: string): Promise<{ paymentIntent: ReturnType<PaymentService['bankIntent']> | null; paymentUrl: string | null; transactionCode: string | null; cardBrand: string | null; cardLast4: string | null }> {
    const p = await this.prisma.payment.findFirst({ where: { orderCode }, orderBy: { createdAt: 'desc' } });
    if (!p) return { paymentIntent: null, paymentUrl: null, transactionCode: null, cardBrand: null, cardLast4: null };
    const pending = p.status === PAY_STATUS.PENDING && (!p.expiresAt || p.expiresAt > new Date());
    let paymentUrl: string | null = null;
    if (pending && p.methodCode === METHOD.VNPAY && this.vnpay.isConfigured) {
      const attempts = await this.prisma.payment.count({ where: { orderCode, methodCode: METHOD.VNPAY } });
      paymentUrl = this.vnpay.buildPayUrl({ txnRef: PaymentService.txnRef(orderCode, attempts), amount: vnd(p.amount.toString()), orderInfo: `Thanh toan don ${orderCode}`, ipAddr: RequestTraceContext.current()?.ip ?? '127.0.0.1', bankCode: p.bankCode, expiresAt: p.expiresAt!, createdAt: p.createdAt });
    }
    return {
      paymentIntent: pending && p.methodCode === METHOD.BANK_TRANSFER ? this.bankIntent(orderCode, vnd(p.amount.toString()), p.expiresAt) : null,
      paymentUrl,
      transactionCode: p.transactionCode,
      cardBrand: p.cardBrand,
      cardLast4: p.cardLast4,
    };
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

  private static toRefund(r: { id: string; orderCode: string; amount: Prisma.Decimal; status: string; method: string; reason: string | null; note: string | null; providerRef: string | null; processedAt: Date | null; createdAt: Date }): RefundResponse {
    return { id: r.id, orderCode: r.orderCode, amount: money(r.amount.toString()), status: r.status, method: r.method, reason: r.reason, note: r.note, providerRef: r.providerRef, processedAt: r.processedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() };
  }

  private audit(tx: Tx, actor: Pick<AuthenticatedActor, 'userId' | 'email'> | null, entry: AuditEntry): Promise<void> {
    return writeAuditLog(tx.paymentAuditLog, PAYMENT_MODULE, actor, entry);
  }

  publish(tx: Tx, input: OutboxEventInput): Promise<void> {
    return writeOutboxEvent(tx.paymentOutboxEvent, input);
  }
}
