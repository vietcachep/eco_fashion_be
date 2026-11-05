import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { BusinessException, NotFoundException, ServiceUnavailableException } from '@common/exception/business.exception';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { CodSale, ORDER_PAYMENT_GATEWAY, OrderPaymentGateway, PaymentGateway, PaymentInitiateInput, PaymentInitiateResult, RefundPayee, RefundSummary } from '@common/gateway/payment.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { OutboxEventInput, writeOutboxEvent } from '@common/outbox/outbox';
import { retryOnDeadlock } from '@common/prisma/errors';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import { money, MoneyResponse } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { GATEWAY_REF_PREFIX, GATEWAY_STATUS, METHOD, PAY_STATUS, PAYEE_SOURCE, PAYMENT_AUDIT, PAYMENT_ERR, PAYMENT_EVENT, PAYMENT_MODULE, REFUND_GATEWAY_STALL_MS, REFUND_KIND, REFUND_PROCESS_PERMISSION, REFUND_STATUS, REFUND_STUCK_MS, TX_TYPE } from '../foundation/payment.constants';
import { PayosService } from '../payos/payos.service';
import { ShopWalletService } from '../shop-wallet/shop-wallet.service';
import { ShopWalletTopupSettleService } from '../shop-wallet/shop-wallet-topup-settle.service';
import { RefundPayeeRevealResponse, RefundResponse } from './dto/refund.dto';
import { clipText, maskAccountNumber, normalizeManualProviderRef, normalizePayee, payerAccountOf, resolvePayee, type ResolvedPayee } from './refund-payee';

export { RefundResponse };

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
  /** Tiền thực nhận từ cổng, cộng dồn theo từng khoản (PLAN-0025 §2.4) — khác `amount` khi khách trả thiếu/thừa. */
  receivedAmount: MoneyResponse;
  paidAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

type RefundKind = (typeof REFUND_KIND)[keyof typeof REFUND_KIND];
type RefundActor = Pick<AuthenticatedActor, 'userId' | 'email'>;
type RefundWithPayment = Prisma.RefundGetPayload<{ include: { payment: true } }>;
/* Refund kèm phần payment đủ để dựng response (tài khoản đã trả tiền nằm trong gatewayResponse của payment PayOS). */
type RefundView = Prisma.RefundGetPayload<{ include: { payment: { select: { methodCode: true; gatewayResponse: true } } } }>;
const REFUND_VIEW_INCLUDE = { payment: { select: { methodCode: true, gatewayResponse: true } } } as const;
/* Kết quả bước "chi tiền" bằng TAY (kế toán đã chuyển khoản ngoài hệ thống, nhập mã giao dịch) hoặc dữ liệu lịch sử — ghi sổ ngay. Lệnh chi PayOS KHÔNG đi đường này: PayOS "00" chỉ là đã nhận lệnh (xem submitPayout). */
interface RefundDisbursement {
  providerRef: string;
  raw: unknown;
  meta: Record<string, unknown>;
}
/* Kết quả một lần đối chiếu lệnh chi PayOS: done = đã ghi sổ · failed = PayOS báo thất bại (refund về failed) · pending = chưa chốt · manual_blocked = người dùng đòi xác nhận tay nhưng PayOS còn đang xử lý trong hạn. */
type GatewayOutcome = 'done' | 'failed' | 'pending' | 'manual_blocked';
const REFUND_STATUS_SET: ReadonlySet<string> = new Set(Object.values(REFUND_STATUS));
/* PayOS TRẢ LỜI rằng lệnh không được tạo ⇒ tiền chắc chắn chưa đi (từ chối nghiệp vụ, HTTP 4xx). KHÔNG rõ kết quả: mất kết nối/timeout (raw null, mã 99), HTTP 5xx, mã 20 (lỗi nội bộ phía PayOS) — PayOS có thể đã nhận lệnh. */
const isDefiniteRejection = (res: { code: string; raw: unknown }): boolean => res.raw !== null && !/^(5\d\d|99|20)$/.test(res.code);
/* refunds.reason là VARCHAR(255): order ghép tiền tố ("Đổi trả: …", "Huỷ đơn: …", " (sàn phân xử)") nên có thể tràn ⇒ cắt thay vì để Postgres báo lỗi 500. */
const REFUND_REASON_MAX = 255;
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
/* Tác nhân HỆ THỐNG cho việc tự chạy (job tự chi hoàn nhỏ): UUID rỗng — không có tài khoản thật nào mang id này; audit/`processed_by` thấy ngay là máy làm. */
const SYSTEM_ACTOR: AuthenticatedActor = { userId: '00000000-0000-0000-0000-000000000000', email: 'system@fitly', roleCode: 'system', permissionVersion: 0, tokenId: 'system' };
const isUniqueViolation = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
/*
 * PLAN-0040 2b.2 (AUD-20) — phương thức KHÔNG được tự chi hoàn: COD là tiền mặt shop giữ, "đã thu" chỉ là ghi nhận của sàn và có thể sai (khách báo chưa nhận hàng — COD-08b). Tự chi qua PayOS cho khoản này là
 * chi tiền thật ra ngoài cho khoản chưa từng vào. GỠ COD khỏi danh sách này CHỈ khi Tầng 3.6 (COD-08b: đảo ghi thu thay vì hoàn tiền mặt chưa thu) đã xong và được kiểm trên Postgres thật.
 */
const AUTO_REFUND_EXCLUDED_METHODS: readonly string[] = [METHOD.COD];

/*
 * Thanh toán (PLAN-0007/0018). Cài PaymentGateway cho order. CHỈ CÒN HAI phương thức, mọi khoản tiền đều về SÀN:
 *  - cod (PLAN-0020): giao dịch pending, đến khi giao thành công sàn xác nhận đã thu (markCodCollected) → paid và TỰ TRỪ hoa hồng khỏi ví đặt cọc của shop; tiền mặt do shop giữ, KHÔNG vào đối soát chi trả.
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
    private readonly wallet: ShopWalletService,
    @Inject(ENV) private readonly env: Env,
    private readonly moduleRef: ModuleRef,
    @Inject(NOTIFICATION_GATEWAY) private readonly notifier: NotificationGateway,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
    private readonly shops: ShopQueryApi,
    private readonly system: SystemQueryApi,
    // PLAN-0041: webhook PayOS không thuộc đơn hàng nào ⇒ thử khoản nạp cọc ở handlePayos (dải mã riêng).
    private readonly topups: ShopWalletTopupSettleService,
  ) {}

  /*
   * Cổng ngược sang order lấy LƯỜI (lúc gọi) thay vì tiêm ở constructor: OrderService → PaymentGateway → PaymentService →
   * OrderPaymentGateway → OrderService là vòng phụ thuộc; tiêm thẳng làm Nest treo khi khởi tạo.
   */
  private get orders(): OrderPaymentGateway {
    return this.moduleRef.get<OrderPaymentGateway>(ORDER_PAYMENT_GATEWAY, { strict: false });
  }
  private async assertRefundFinanceSafety(code: string): Promise<void> {
    if (this.payos.isMockEndpoint) return;
    if ((await this.orders.simulatedOrderCodes([code])).size > 0) throw new BusinessException('PAYMENT_SIMULATED_REAL_TRANSFER_BLOCKED', 'Đơn giả lập chỉ được chi hoàn qua PayOS mock cục bộ, không được chuyển tiền thật', 409);
  }
  private async assertIncomingFinanceSafety(code: string): Promise<void> {
    if (this.payos.isMockEndpoint) return;
    if ((await this.orders.simulatedOrderCodes([code])).size > 0) throw new BusinessException('PAYMENT_SIMULATED_REAL_TRANSFER_BLOCKED', 'Đơn vận chuyển giả lập chỉ thanh toán qua PayOS mock cục bộ; không tạo liên kết thu tiền thật', 409);
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
        shopId: input.shopId,
        userId: input.userId,
        methodCode: input.methodCode,
        collectionMode:input.collectionMode,
        amount: input.amount.toString(),
        status: PAY_STATUS.PENDING,
        expiresAt,
        createdBy: input.userId,
      },
    });
    // PayOS: KHÔNG gọi mạng trong transaction đặt hàng (AUD-06) — link được tạo sau commit bằng `createCheckoutLinks`.
    await this.audit(tx, { userId: input.userId, email: '' }, { action: PAYMENT_AUDIT.INITIATED, entityType: 'payment', entityId: p.id, entityCode: input.orderCode, after: { method: input.methodCode, amount: input.amount.toString() } });
    return { paymentId: p.id, status: 'unpaid', paymentUrl: null, qrCode: null, expiresAt };
  }

  /*
   * Kiểm nguồn đơn rồi gọi PayOS NGOÀI transaction. Hạn link = expiresAt của đơn; nguồn hãng giả không được thu tiền thật.
   */
  private async requestPayosLink(orderCode: string, amount: bigint, expiresAt: Date): Promise<{ payosOrderCode: number; checkoutUrl: string; qrCode: string | null; paymentLinkId: string | null }> {
    await this.assertIncomingFinanceSafety(orderCode);
    if (!this.payos.isConfigured) throw new ServiceUnavailableException(PAYMENT_ERR.PAYOS_NOT_CONFIGURED, 'PayOS chưa được cấu hình');
    const payosOrderCode = PayosService.generateOrderCode();
    const web = this.env.EF_WEB_URL.replace(/\/$/, '');
    const link = await this.payos.createPaymentLink({ orderCode: payosOrderCode, amount, description: orderCode, returnUrl: `${web}/checkout/payos-return`, cancelUrl: `${web}/checkout/payos-return`, expiresAt });
    if (!link.checkoutUrl) throw new ServiceUnavailableException(PAYMENT_ERR.PAYOS_NOT_CONFIGURED, 'Không tạo được liên kết thanh toán PayOS — vui lòng thử lại');
    return { payosOrderCode, checkoutUrl: link.checkoutUrl, qrCode: link.qrCode, paymentLinkId: link.paymentLinkId ?? null };
  }

  /* Ghi giao dịch create_url (lưu checkoutUrl để mở lại link khi khách quay lại đơn chưa trả) + đếm lần tạo link, xoá lỗi cũ — một transaction ngắn, sau khi PayOS đã trả link. */
  private async saveLink(paymentId: string, amount: bigint, link: { payosOrderCode: number; checkoutUrl: string; paymentLinkId: string | null }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.create({
        data: { paymentId, type: TX_TYPE.CREATE_URL, status: 'ok', amount: amount.toString(), providerRef: String(link.payosOrderCode), rawRequest: { payosOrderCode: link.payosOrderCode, checkoutUrl: link.checkoutUrl, paymentLinkId: link.paymentLinkId } },
      });
      await tx.payment.update({ where: { id: paymentId }, data: { linkAttempts: { increment: 1 }, lastLinkError: null } });
    });
  }

  private async markLinkFailed(paymentId: string, err: unknown): Promise<void> {
    const msg = clipText(err instanceof Error ? err.message : String(err), 250);
    this.logger.warn({ paymentId, msg }, 'Tạo link PayOS lỗi — payment giữ pending, khách có thể thử lại');
    await this.prisma.payment.update({ where: { id: paymentId }, data: { linkAttempts: { increment: 1 }, lastLinkError: msg } }).catch((e: unknown) => this.logger.warn({ e, paymentId }, 'Không ghi được lỗi tạo link'));
  }

  /*
   * Tạo link PayOS cho các đơn con VỪA đặt (gọi SAU khi transaction đặt hàng commit — PayOS chậm/lỗi không làm đơn rollback, không giữ khoá DB). Song song tối đa 3.
   * Đơn đã có link ⇒ trả link cũ (idempotent — đặt hàng chạy lại do Idempotency-Key). Lỗi một link ⇒ `{ error }`, payment giữ `pending` + `last_link_error`.
   */
  async createCheckoutLinks(orderCodes: string[]): Promise<Map<string, { paymentUrl: string; qrCode: string | null; expiresAt: Date | null } | { error: string }>> {
    const out = new Map<string, { paymentUrl: string; qrCode: string | null; expiresAt: Date | null } | { error: string }>();
    const queue = [...new Set(orderCodes)];
    const one = async (code: string): Promise<void> => {
      const p = await this.prisma.payment.findFirst({ where: { orderCode: code, methodCode: METHOD.PAYOS, status: PAY_STATUS.PENDING }, orderBy: { createdAt: 'desc' } });
      if (!p) return;
      try { await this.assertIncomingFinanceSafety(code); }
      catch (error) { await this.markLinkFailed(p.id, error); out.set(code, { error: error instanceof Error ? error.message : 'Không tạo liên kết thu tiền thật cho đơn giả lập' }); return; }
      const existing = await this.prisma.paymentTransaction.findFirst({ where: { paymentId: p.id, type: TX_TYPE.CREATE_URL }, orderBy: { createdAt: 'desc' }, select: { rawRequest: true } });
      const url = (existing?.rawRequest as { checkoutUrl?: string } | null)?.checkoutUrl;
      if (url) {
        out.set(code, { paymentUrl: url, qrCode: null, expiresAt: p.expiresAt });
        return;
      }
      try {
        const expiresAt = p.expiresAt ?? (await this.expiryFor(METHOD.PAYOS));
        const link = await this.requestPayosLink(code, vnd(p.amount.toString()), expiresAt);
        await this.saveLink(p.id, vnd(p.amount.toString()), link);
        out.set(code, { paymentUrl: link.checkoutUrl, qrCode: link.qrCode, expiresAt });
      } catch (err) {
        await this.markLinkFailed(p.id, err);
        out.set(code, { error: err instanceof Error ? err.message : String(err) });
      }
    };
    const worker = async (): Promise<void> => {
      for (let code = queue.shift(); code !== undefined; code = queue.shift()) await one(code);
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }

  /* Hạn link PayOS = hạn thanh toán của đơn (setting `order.vnpay_timeout_minutes`) — một nguồn duy nhất (AUD-05). Phương thức khác (lịch sử) giữ 24 giờ. */
  private async expiryFor(methodCode: string): Promise<Date> {
    if (methodCode !== METHOD.PAYOS) return new Date(Date.now() + 24 * 60 * 60_000);
    const minutes = Math.max(1, (await this.system.settingNumber(SETTING_KEY.ORDER_ONLINE_PAYMENT_TIMEOUT_MINUTES)) || 30);
    return new Date(Date.now() + minutes * 60_000);
  }

  async cancel(orderCode: string, reason: string, tx: Tx): Promise<void> {
    const live = await tx.payment.findFirst({ where: { orderCode, status: { in: [PAY_STATUS.PENDING, PAY_STATUS.PROCESSING] } } });
    if (!live) return;
    await tx.payment.update({ where: { id: live.id }, data: { status: PAY_STATUS.CANCELLED, version: { increment: 1 } } });
    if (live.methodCode === METHOD.PAYOS) this.cancelPayosLinkLater(live.id);
    await this.audit(tx, null, { action: PAYMENT_AUDIT.CANCELLED, entityType: 'payment', entityId: live.id, entityCode: orderCode, after: { reason } });
    await this.refundReceivedOfCancelled(tx, live);
  }

  /*
   * PLAN-0040 2b.1 — phần tiền payment đã NHẬN mà CHƯA có yêu cầu hoàn nào phủ: received − Σ MỌI yêu cầu hoàn của payment. Tính cả yêu cầu `failed` (kế toán chạy lại được ⇒ đã có người lo, tạo
   * thêm yêu cầu mới là chi hai lần cùng một khoản). Đây là chốt idempotent duy nhất cho "hoàn tiền của payment không được giữ lại": gọi bao nhiêu lần cũng chỉ bù đúng phần chênh.
   */
  private async unrefundedReceived(tx: Tx, p: { id: string; receivedAmount: Prisma.Decimal }): Promise<bigint> {
    const covered = await tx.refund.aggregate({ _sum: { amount: true }, where: { paymentId: p.id } });
    return vnd(p.receivedAmount.toString()) - vnd((covered._sum.amount ?? 0).toString());
  }

  /*
   * Khách đã trả THIẾU (webhook cộng dồn vào received_amount nhưng chưa đủ để `paid`) rồi payment bị huỷ (hết hạn / huỷ đơn / đổi link) ⇒ tiền đã nhận không được kẹt:
   * tạo yêu cầu hoàn `mismatch` cho phần đã nhận mà chưa có yêu cầu hoàn nào phủ (idempotent theo SỐ DƯ — xem unrefundedReceived; tiền về thêm sau khi huỷ do settleLateMoney bù tiếp) + báo kế toán.
   */
  private async refundReceivedOfCancelled(tx: Tx, p: { id: string; orderCode: string; receivedAmount: Prisma.Decimal }): Promise<void> {
    const owed = await this.unrefundedReceived(tx, p);
    if (owed <= 0n) return;
    await this.requestRefund({ orderCode: p.orderCode, shopId: null, amount: owed, reason: 'Hoàn tiền khách đã trả thiếu — đơn không được thanh toán đủ', returnRequestId: null, actorUserId: null, paymentId: p.id, kind: REFUND_KIND.MISMATCH }, tx);
    await this.notifyMismatch(tx, p, `Đơn ${p.orderCode} bị huỷ khi khách mới trả thiếu`, `Đã nhận ${money(owed).display} nhưng chưa đủ giá trị đơn. Yêu cầu hoàn đã được tạo — xử lý ở màn Hoàn tiền.`, { reason: 'underpaid_cancelled' });
  }

  async codAvailability(shopIds: string[], tx?: Tx): Promise<Map<string, boolean>> {
    return this.wallet.codAvailability(shopIds, tx);
  }

  /*
   * Hỏi lại PayOS trước khi job huỷ đơn quá hạn (PLAN-0025). Đơn không có giao dịch PayOS (COD / link chưa từng tạo) ⇒ 'unpaid'. Giao dịch đã `paid` ⇒ 'paid'. Còn lại hỏi PayOS theo mã PayOS
   * đã lưu: PAID ⇒ ghi nhận đúng đường webhook (settlePayos, idempotent) rồi 'paid' — số tiền lệch ⇒ 'unpaid' (không ghi paid; xử lý tiền lệch ở WP-01 §2.4); không tra được ⇒ 'unknown'.
   */
  async confirmPaymentStatus(orderCode: string): Promise<'paid' | 'unpaid' | 'unknown'> {
    const p = await this.prisma.payment.findFirst({ where: { orderCode, methodCode: METHOD.PAYOS }, orderBy: { createdAt: 'desc' } });
    if (!p) return 'unpaid';
    if (p.status === PAY_STATUS.PAID || p.status === PAY_STATUS.PARTIALLY_REFUNDED || p.status === PAY_STATUS.REFUNDED) return 'paid';
    // Mọi link PayOS từng tạo cho đơn này (khách có thể đã trả link CŨ sau khi bấm thanh toán lại).
    const links = await this.prisma.paymentTransaction.findMany({ where: { type: TX_TYPE.CREATE_URL, payment: { orderCode, methodCode: METHOD.PAYOS } }, select: { providerRef: true, paymentId: true }, orderBy: { createdAt: 'desc' }, take: 5 });
    let unknown = false;
    for (const l of links) {
      if (!l.providerRef) continue;
      const info = await this.payos.getPaymentLink(l.providerRef);
      if (!info.status) {
        unknown = true;
        continue;
      }
      if (info.status === 'PAID') {
        const r = await this.settlePayos(l.paymentId, l.providerRef, BigInt(Math.round(info.amountPaid ?? 0)), { orderCode: l.providerRef, amount: info.amountPaid ?? 0, source: 'expiry-check' }, 'return');
        if (r === 'paid' || r === 'already') return 'paid';
      }
    }
    return unknown ? 'unknown' : 'unpaid';
  }

  async markCodCollected(orderCode: string, actorUserId: string | null, tx: Tx, sale: CodSale): Promise<void> {
    const p = await tx.payment.findFirst({ where: { orderCode, methodCode: METHOD.COD, status: PAY_STATUS.PENDING } });
    if (!p) return;
    const now = new Date();
    if (p.collectionMode === 'carrier_cod') {
      if (p.codCollectedAt) return;
      await tx.payment.update({where:{id:p.id},data:{codCollectedAt:now,version:{increment:1}}});
      await this.audit(tx,null,{action:'CARRIER_COD_COLLECTED',entityType:'payment',entityId:p.id,entityCode:orderCode,after:{amount:p.amount.toString()}});
      return; // Hãng giữ tiền; chưa ghi paid và không trừ ví.
    }
    await tx.payment.update({ where: { id: p.id }, data: { status: PAY_STATUS.PAID, paidAt: now, updatedBy: actorUserId, version: { increment: 1 } } });
    await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.COD_COLLECT, status: 'ok', amount: p.amount, providerRef: `cod:${orderCode}` } });
    await this.audit(tx, actorUserId ? { userId: actorUserId, email: '' } : null, { action: PAYMENT_AUDIT.PAID, entityType: 'payment', entityId: p.id, entityCode: orderCode, after: { method: METHOD.COD } });
    // PLAN-0020: đơn COD thu thành công ⇒ sàn tự trừ hoa hồng của đơn khỏi ví đặt cọc của shop (cùng tx: không bao giờ đã thu mà chưa trừ).
    await this.wallet.applyCodCommission(tx, { shopId: sale.shopId, orderCode, total: sale.total, commissionBase: sale.commissionBase, platformCredit: sale.platformCredit, commissionRate: sale.commissionRate });
    await this.orders.onPaid(orderCode, { paymentId: p.id, methodCode: METHOD.COD, transactionCode: null, bankCode: null, paidAt: now }, tx);
  }

  /* Tiền COD hãng thu về sàn: caller đã khoá đơn/shipment, xác nhận đúng số và mã chứng từ duy nhất. */
  async confirmCarrierCod(orderCode:string,actor:AuthenticatedActor,input:{amount:string;reference:string;note?:string},tx:Tx):Promise<void> {
    const p=await tx.payment.findFirst({where:{orderCode,collectionMode:'carrier_cod'}});
    if(!p || !p.codCollectedAt) throw new BusinessException('PAYMENT_COD_NOT_COLLECTED','Hãng chưa xác nhận thu tiền COD',409);
    if(!/^\d{1,14}$/.test(input.amount) || BigInt(input.amount)!==vnd(p.amount.toString())) throw new BusinessException('PAYMENT_COD_AMOUNT_MISMATCH','Số tiền nhận phải bằng tổng COD của đơn',409);
    if(p.codRemittedAt) { if(p.codRemittanceRef===input.reference) return; throw new BusinessException('PAYMENT_COD_ALREADY_REMITTED','COD đã được xác nhận bằng chứng từ khác',409); }
    const existing=await tx.payment.findFirst({where:{codRemittanceRef:input.reference}});
    if(existing) throw new BusinessException('PAYMENT_COD_REFERENCE_USED','Mã chứng từ COD đã được sử dụng',409);
    const now=new Date();
    await tx.payment.update({where:{id:p.id},data:{status:PAY_STATUS.PAID,paidAt:now,receivedAmount:p.amount,codRemittedAt:now,codRemittedBy:actor.userId,codRemittanceRef:input.reference,codRemittedAmount:p.amount,version:{increment:1}}});
    await tx.paymentTransaction.create({data:{paymentId:p.id,type:TX_TYPE.COD_COLLECT,status:'ok',amount:p.amount,providerRef:'carrier-cod:'+input.reference}});
    await this.audit(tx,actor,{action:'CARRIER_COD_REMITTED',entityType:'payment',entityId:p.id,entityCode:orderCode,after:{amount:input.amount,reference:input.reference,note:input.note}});
    await this.orders.onPaid(orderCode,{paymentId:p.id,methodCode:METHOD.COD,transactionCode:input.reference,bankCode:null,paidAt:now},tx);
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
  private async refundDuplicate(tx: Tx, p: { id: string; orderCode: string; amount: Prisma.Decimal; receivedAmount: Prisma.Decimal }): Promise<boolean> {
    const other = await tx.payment.findFirst({ where: { orderCode: p.orderCode, id: { not: p.id }, status: { in: [PAY_STATUS.PAID, PAY_STATUS.PARTIALLY_REFUNDED, PAY_STATUS.REFUNDED] } }, select: { id: true } });
    if (!other) return false;
    const existing = await tx.refund.findFirst({ where: { paymentId: p.id, kind: REFUND_KIND.DUPLICATE_PAYMENT }, select: { id: true } });
    if (existing) return true;
    // Hoàn đúng số khách THỰC trả (có thể hơn số phải trả của giao dịch này), không phải số phải trả.
    const received = vnd(p.receivedAmount.toString());
    const refundAmount = received > 0n ? received : vnd(p.amount.toString());
    await this.requestRefund({ orderCode: p.orderCode, shopId: null, amount: refundAmount, reason: 'Thanh toán trùng — đơn đã được thanh toán bằng giao dịch khác', returnRequestId: null, actorUserId: null, paymentId: p.id, kind: REFUND_KIND.DUPLICATE_PAYMENT }, tx);
    return true;
  }

  /*
   * Phần được phép hoàn tối đa của một payment: đã thu (paid/hoàn) ⇒ max(số phải trả, số thực nhận) — trả thừa thì hoàn được phần thừa; chưa thu (pending/cancelled…) ⇒ chỉ phần ĐÃ NHẬN (trả thiếu rồi đơn huỷ).
   */
  private static refundCap(p: { status: string; amount: Prisma.Decimal; receivedAmount: Prisma.Decimal; collectionMode?:string|null; codCollectedAt?:Date|null }): bigint {
    const amount = vnd(p.amount.toString());
    const received = vnd(p.receivedAmount.toString());
    const collected = (p.collectionMode === 'carrier_cod' && !!p.codCollectedAt) || p.status === PAY_STATUS.PAID || p.status === PAY_STATUS.PARTIALLY_REFUNDED || p.status === PAY_STATUS.REFUNDED;
    return collected ? (received > amount ? received : amount) : received;
  }

  /* Báo kế toán một khoản tiền lệch (thừa/thiếu/trùng) cần để mắt tới. Best-effort, trong cùng tx như các thông báo hoàn khác. */
  private async notifyMismatch(tx: Tx, p: { id: string; orderCode: string }, title: string, content: string, payload: Record<string, unknown>): Promise<void> {
    await this.notifyAccountants(tx, await this.accountantIds(), { title, content, payload: { paymentId: p.id, orderCode: p.orderCode, ...payload } });
  }

  /* Tập mã giao dịch PayOS (`reference` trong webhook) đã ghi cho payment — khử trùng theo TỪNG khoản tiền, không theo mã link. */
  private static webhookRefs(rows: Array<{ status: string; rawResponse: Prisma.JsonValue | null }>): Map<string, string> {
    const refs = new Map<string, string>(); // mã khoản → trạng thái giao dịch đã ghi (ok | mismatch | seen | duplicate)
    for (const r of rows) {
      const ref = (r.rawResponse as { reference?: unknown } | null)?.reference;
      if (typeof ref === 'string' && ref !== '') refs.set(ref, r.status);
    }
    return refs;
  }

  /* Mã của MỘT khoản tiền trong webhook: `reference` của PayOS; thiếu thì ghép từ thời điểm + số tiền; không có gì để ghép ⇒ null (không khử trùng theo khoản). */
  private static eventRefOf(payosOrderCode: string, data: Record<string, unknown>): string | null {
    if (typeof data.reference === 'string' && data.reference.trim() !== '') return data.reference.trim().slice(0, 100);
    if (typeof data.transactionDateTime === 'string' && data.transactionDateTime !== '') return `${payosOrderCode}:${data.transactionDateTime}:${typeof data.amount === 'number' || typeof data.amount === 'string' ? data.amount : ''}`.slice(0, 100);
    return null;
  }

  /*
   * Tạo yêu cầu hoàn (chưa chi). Không chỉ định `paymentId` ⇒ hoàn khoản đã thu mới nhất CỦA ĐƠN, BỎ QUA khoản trả trùng đang chờ trả lại cho khách (nó đã có yêu cầu
   * hoàn đủ riêng nên phần còn lại = 0 — chọn nhầm nó sẽ chặn huỷ đơn / đổi trả của khoản thanh toán hợp lệ).
   *
   * PLAN-0022 — tài khoản nhận hoàn (`payee`, do KHÁCH khai ở yêu cầu đổi trả): khi CÓ thì chuẩn hoá + kiểm định dạng (sai ⇒ 400 PAYMENT_REFUND_PAYEE_INVALID) rồi lưu vào `refunds.payee_*`.
   * KHÔNG BAO GIỜ chặn luồng của order vì THIẾU payee (đơn COD yêu cầu cũ / `not_received` tạo khi đơn còn đang giao rồi mới thu / PayOS không trả counterAccount…): refund vẫn được tạo
   * (payee_source = none, needs_manual = true, COD ⇒ method manual_transfer) và kế toán được báo liên hệ khách xin tài khoản rồi chuyển tay + nhập mã giao dịch. PayOS: ưu tiên tài khoản đã trả tiền, thiếu thì payee.
   * Khoản không có đường tự chi (không tài khoản / không qua cổng) hoặc chưa cấu hình khoá payout ⇒ báo kế toán ngay (trong CÙNG tx — đơn và thông báo cùng sống cùng chết).
   * `reason` cắt ≤ 255 ký tự (cột VARCHAR(255)). Số tài khoản đầy đủ không vào log/audit/response (chỉ BIN + 4 số cuối).
   */
  async requestRefund(input: { orderCode: string; shopId: string | null; amount: bigint; reason: string; returnRequestId: string | null; actorUserId: string | null; paymentId?: string; kind?: RefundKind; payee?: RefundPayee | null }, tx: Tx): Promise<{ refundId: string | null }> {
    const kind = input.kind ?? REFUND_KIND.ORDER;
    // Hoàn phần tiền LỆCH/TRÙNG của MỘT payment chỉ định thì payment có thể ở trạng thái bất kỳ (đã huỷ vì trả thiếu, đã hoàn hết…): số được hoàn do `refundCap` giới hạn bên dưới.
    const anyState = Boolean(input.paymentId) && kind !== REFUND_KIND.ORDER;
    const collected = { in: [PAY_STATUS.PAID, PAY_STATUS.PARTIALLY_REFUNDED] };
    let p: Awaited<ReturnType<Tx['payment']['findFirst']>>;
    if (input.paymentId) {
      p = await tx.payment.findFirst({ where: { orderCode: input.orderCode, id: input.paymentId, ...(anyState ? {} : { status: collected }) } });
    } else {
      // Khoản đã thu mới nhất của đơn, BỎ QUA payment là khoản trả TRÙNG (payment khác của cùng đơn đã có yêu cầu hoàn trùng) — khoản trùng CÙNG payment (received > amount) thì payment vẫn là khoản thu hợp lệ.
      const candidates = await tx.payment.findMany({ where: { orderCode: input.orderCode, OR:[{status:collected},{collectionMode:'carrier_cod',codCollectedAt:{not:null},status:PAY_STATUS.PENDING}] }, orderBy: { createdAt: 'desc' } });
      const dupPaymentIds = new Set((await tx.refund.findMany({ where: { orderCode: input.orderCode, kind: REFUND_KIND.DUPLICATE_PAYMENT }, select: { paymentId: true } })).map((r) => r.paymentId));
      p = candidates.find((c) => !dupPaymentIds.has(c.id) || vnd(c.receivedAmount.toString()) > vnd(c.amount.toString())) ?? null;
    }
    if (!p) return { refundId: null }; // chưa thu tiền → không có gì để hoàn
    const payee = input.payee ? normalizePayee(input.payee) : null;
    const reason = clipText(input.reason, REFUND_REASON_MAX);
    // Còn lại = đã thu − đã hoàn − các yêu cầu hoàn ĐANG CHỜ/xử lý (nếu không, hai yêu cầu cùng lúc đều qua rồi tổng hoàn vượt số đã thu).
    const inflight = await tx.refund.aggregate({ _sum: { amount: true }, where: { paymentId: p.id, status: { in: [REFUND_STATUS.REQUESTED, REFUND_STATUS.PROCESSING] } } });
    const remaining = PaymentService.refundCap(p) - vnd(p.refundedAmount.toString()) - vnd((inflight._sum.amount ?? 0).toString());
    if (input.amount > remaining) {
      // Hoàn phần lệch/trùng do HỆ THỐNG tạo trong luồng nhận tiền (webhook): không được ném lỗi (webhook sẽ 500 và PayOS gửi lại mãi) — không còn gì để hoàn thì bỏ qua.
      if (kind !== REFUND_KIND.ORDER && remaining <= 0n) return { refundId: null };
      if (kind === REFUND_KIND.ORDER) throw new BusinessException(PAYMENT_ERR.REFUND_EXCEEDS, `Số tiền hoàn vượt phần còn lại (${money(remaining).display})`);
      input = { ...input, amount: remaining };
    }
    // PayOS đi qua cổng chi; COD chỉ khi khách có khai tài khoản (không có "tài khoản đã trả" để lấy lại ⇒ không có đường tự chi, về sau cũng không bổ sung được); payment lịch sử (vnpay / bank_transfer) ⇒ chuyển tay.
    const viaGateway = p.methodCode === METHOD.PAYOS || (p.methodCode === METHOD.COD && payee !== null);
    const hasDestination = payerAccountOf(p) !== null || payee !== null;
    const needsManual = !(viaGateway && hasDestination);
    const r = await tx.refund.create({
      data: {
        paymentId: p.id,
        orderCode: input.orderCode,
        shopId: input.shopId,
        returnRequestId: input.returnRequestId,
        amount: input.amount.toString(),
        status: REFUND_STATUS.REQUESTED,
        method: viaGateway ? 'gateway' : 'manual_transfer',
        reason,
        requestedBy: input.actorUserId,
        kind,
        needsManual,
        ...(payee ? { payeeBankBin: payee.bankBin, payeeAccountNumber: payee.accountNumber, payeeAccountName: payee.accountName, payeeSource: PAYEE_SOURCE.CUSTOMER } : hasDestination ? {} : { payeeSource: PAYEE_SOURCE.NONE }),
      },
    });
    await this.audit(tx, input.actorUserId ? { userId: input.actorUserId, email: '' } : null, {
      action: PAYMENT_AUDIT.REFUND_REQUESTED,
      entityType: 'refund',
      entityId: r.id,
      entityCode: input.orderCode,
      after: { amount: input.amount.toString(), reason, kind, needsManual, payee: payee ? { source: PAYEE_SOURCE.CUSTOMER, bankBin: payee.bankBin, accountNumberMasked: maskAccountNumber(payee.accountNumber) } : null },
    });
    const autoMax = needsManual || !this.payos.isPayoutConfigured ? 0 : await this.system.settingNumber(SETTING_KEY.REFUND_AUTO_MAX_AMOUNT);
    const autoSkipsMethod = AUTO_REFUND_EXCLUDED_METHODS.includes(p.methodCode); // AUD-20: hoàn của đơn COD không bao giờ tự chi — phải để kế toán thấy
    if (!needsManual && this.payos.isPayoutConfigured && (autoSkipsMethod || autoMax <= 0 || input.amount > BigInt(autoMax))) {
      // Khoản này sẽ KHÔNG tự chi (vượt mức tự chi / tự chi đang tắt / đơn COD) ⇒ báo kế toán MỘT lần, ngay lúc tạo yêu cầu.
      await this.notifyAccountants(tx, await this.accountantIds(), {
        title: `Khoản hoàn mới cần xử lý — đơn ${input.orderCode}`,
        content: `${money(input.amount).display} — ${reason}. ${autoSkipsMethod ? 'Đơn COD không tự chi hoàn tiền' : autoMax <= 0 ? 'Hoàn tiền tự động đang tắt' : `Vượt mức tự chi (${money(autoMax).display})`}: mở màn Hoàn tiền để duyệt.`,
        payload: { refundId: r.id, orderCode: input.orderCode, reason: 'above_auto_limit' },
      });
    }
    if (needsManual || !this.payos.isPayoutConfigured) {
      const why =!hasDestination ? 'chưa có tài khoản nhận hoàn (khách chưa khai / PayOS không trả tài khoản đối ứng)' : !viaGateway ? 'khoản thanh toán gốc không hoàn được qua cổng' : 'PayOS payout chưa được cấu hình';
      await this.notifyAccountants(tx, await this.accountantIds(), {
        title: `Khoản hoàn đơn ${input.orderCode} cần chuyển khoản tay`,
        content: !hasDestination
          ? `${money(input.amount).display} — ${why}. Liên hệ khách (SĐT trong đơn) để xin tài khoản nhận hoàn, rồi chuyển khoản tay và nhập mã giao dịch ở màn Hoàn tiền.`
          : `${money(input.amount).display} — ${why}. Chuyển khoản rồi nhập mã giao dịch ở màn Hoàn tiền.`,
        payload: { refundId: r.id, orderCode: input.orderCode, reason: !hasDestination ? 'no_payee' : !viaGateway ? 'no_gateway' : 'payout_not_configured' },
      });
    }
    return { refundId: r.id };
  }

  /*
   * Khoản hoàn MỚI NHẤT của từng đơn (cho chi tiết/danh sách đơn: "đang hoàn tiền" thay vì vẫn ghi "đã thanh toán"). MỘT query cho cả danh sách mã đơn (không N+1); chỉ hoàn THEO ĐƠN
   * (kind order — khoản trả trùng không thuộc đơn); mới nhất theo (createdAt, id) giảm dần. Đơn không có khoản hoàn nào ⇒ không có trong Map; trạng thái lạ (không thuộc 4 trạng thái chuẩn)
   * bị bỏ qua thay vì ép kiểu bừa. Gateway chỉ đọc — không khoá, không ghi.
   */
  async refundSummaries(orderCodes: string[]): Promise<Map<string, RefundSummary>> {
    const out = new Map<string, RefundSummary>();
    const codes = [...new Set(orderCodes.filter((c) => c !== ''))];
    if (codes.length === 0) return out;
    const rows = await this.prisma.refund.findMany({ where: { orderCode: { in: codes }, kind: REFUND_KIND.ORDER }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { orderCode: true, status: true, amount: true } });
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.orderCode)) continue;
      seen.add(r.orderCode);
      if (REFUND_STATUS_SET.has(r.status)) out.set(r.orderCode, { status: r.status as RefundSummary['status'], amount: vnd(r.amount.toString()) });
    }
    return out;
  }

  /* Khách thanh toán lại đơn PayOS (link hết hạn / đã huỷ trên cổng): huỷ giao dịch cũ chưa trả, tạo giao dịch + link mới. */
  async retryPayos(actor: AuthenticatedActor, orderCode: string): Promise<{ paymentUrl: string }> {
    if (!this.payos.isConfigured) throw new ServiceUnavailableException(PAYMENT_ERR.PAYOS_NOT_CONFIGURED, 'PayOS chưa được cấu hình');
    const last = await this.prisma.payment.findFirst({ where: { orderCode, userId: actor.userId, methodCode: METHOD.PAYOS }, orderBy: { createdAt: 'desc' } });
    if (!last) throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không tìm thấy giao dịch');
    await this.assertIncomingFinanceSafety(orderCode);
    if (last.status === PAY_STATUS.PAID) throw new BusinessException(PAYMENT_ERR.ALREADY_PAID, 'Đơn đã thanh toán');
    if (!(await this.orders.canRetryPayment(orderCode))) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Đơn không còn ở trạng thái chờ thanh toán (đã huỷ hoặc đã xử lý)');
    const expiresAt = await this.expiryFor(METHOD.PAYOS);
    // Transaction NGẮN, không có HTTP: khoá đơn TRƯỚC (thứ tự ĐƠN → PAYMENT) + gia hạn hạn đơn, rồi chọn/tạo payment. Link PayOS tạo SAU commit.
    let target: { id: string; reused: boolean };
    try {
      target = await this.pickRetryTarget(actor, orderCode, last, expiresAt);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // AUD-22: lần bấm đồng thời đụng chỉ mục "mỗi đơn MỘT payment sống" (uq_payments_order_live) — không phải lỗi của khách: trả link của payment đang chờ (transaction đã hoàn tác sạch). Không còn payment chờ ⇒ ném lại lỗi gốc.
      const waiting = await this.prisma.payment.findFirst({ where: { orderCode, methodCode: METHOD.PAYOS, status: PAY_STATUS.PENDING }, orderBy: { createdAt: 'desc' } });
      if (!waiting) throw err;
      target = { id: waiting.id, reused: true };
    }
    if (target.reused) {
      // Payment chờ ĐÃ có link (do lần bấm đồng thời kia vừa tạo xong) ⇒ trả đúng link đó, không tạo link thứ hai cho cùng payment. Chưa có link ⇒ tạo cho payment này ngay dưới.
      const existing = await this.prisma.paymentTransaction.findFirst({ where: { paymentId: target.id, type: TX_TYPE.CREATE_URL }, orderBy: { createdAt: 'desc' }, select: { rawRequest: true } });
      const url = (existing?.rawRequest as { checkoutUrl?: string } | null)?.checkoutUrl;
      if (url) return { paymentUrl: url };
    }
    try {
      const link = await this.requestPayosLink(orderCode, vnd(last.amount.toString()), expiresAt);
      await this.saveLink(target.id, vnd(last.amount.toString()), link);
      // Chỉ huỷ link CŨ khi link MỚI đã tạo xong: tạo lỗi thì khách vẫn trả được bằng link đang có (webhook vẫn ghi nhận dù payment cũ đã đánh dấu cancelled).
      if (!target.reused && last.status === PAY_STATUS.PENDING) this.cancelPayosLinkLater(last.id);
      return { paymentUrl: link.checkoutUrl };
    } catch (err) {
      await this.markLinkFailed(target.id, err); // payment giữ pending — khách bấm lại sẽ dùng lại payment này
      throw err instanceof BusinessException ? err : new ServiceUnavailableException(PAYMENT_ERR.PAYOS_NOT_CONFIGURED, 'Không tạo được liên kết thanh toán PayOS — vui lòng thử lại');
    }
  }

  /* Phần transaction của retryPayos: khoá đơn (ĐƠN → PAYMENT) + gia hạn hạn đơn, rồi chọn payment dùng lại hoặc tạo payment chờ mới. Không HTTP. `last` = payment cuối cùng retryPayos đọc TRƯỚC khi khoá. */
  private async pickRetryTarget(actor: AuthenticatedActor, orderCode: string, last: { id: string }, expiresAt: Date): Promise<{ id: string; reused: boolean }> {
    const collected: string[] = [PAY_STATUS.PAID, PAY_STATUS.PARTIALLY_REFUNDED, PAY_STATUS.REFUNDED];
    return this.prisma.$transaction(async (tx) => {
      await this.orders.extendPaymentDeadline(orderCode, expiresAt, tx); // khoá đơn + kéo dài paymentExpiresAt (AUD-05)
      const cur = await tx.payment.findUnique({ where: { id: last.id } });
      if (!cur || collected.includes(cur.status)) throw new BusinessException(PAYMENT_ERR.ALREADY_PAID, 'Đơn đã thanh toán');
      if (cur.status !== PAY_STATUS.PENDING) {
        // AUD-22: cùng khách bấm hai lần ĐỒNG THỜI — lần trước đã huỷ `last` và tạo payment chờ mới trước khi ta giữ được khoá đơn ⇒ dùng lại payment đó (đúng MỘT payment chờ/đơn), không tạo thêm.
        const newest = await tx.payment.findFirst({ where: { orderCode, methodCode: METHOD.PAYOS }, orderBy: { createdAt: 'desc' } });
        if (newest && newest.id !== cur.id) {
          if (collected.includes(newest.status)) throw new BusinessException(PAYMENT_ERR.ALREADY_PAID, 'Đơn đã thanh toán');
          if (newest.status === PAY_STATUS.PENDING) return { id: newest.id, reused: true };
        }
      }
      if (cur.status === PAY_STATUS.PENDING) {
        // Payment đang chờ mà CHƯA có link (lần tạo trước lỗi) ⇒ dùng lại chính nó, không sinh payment mới.
        const hasLink = await tx.paymentTransaction.findFirst({ where: { paymentId: cur.id, type: TX_TYPE.CREATE_URL }, select: { id: true } });
        if (!hasLink) {
          await tx.payment.update({ where: { id: cur.id }, data: { expiresAt, version: { increment: 1 } } });
          return { id: cur.id, reused: true };
        }
        await tx.payment.update({ where: { id: cur.id }, data: { status: PAY_STATUS.CANCELLED, version: { increment: 1 } } });
        await this.refundReceivedOfCancelled(tx, cur); // khách đã trả thiếu trên link cũ ⇒ hoàn phần đã nhận, không để kẹt
      }
      const p = await tx.payment.create({ data: { orderId: cur.orderId, orderCode, shopId: cur.shopId, userId: actor.userId, methodCode: METHOD.PAYOS, amount: cur.amount, status: PAY_STATUS.PENDING, expiresAt, createdBy: actor.userId } });
      return { id: p.id, reused: false };
    });
  }

  // ------------------------------------------------------------------ hỏi PayOS định kỳ (mất webhook)

  /*
   * Job `payos-reconcile-pending` (PLAN-0025 §2.3, mỗi 2 phút): payment PayOS còn `pending` mà SẮP hết hạn (< 2 phút) hoặc đã tạo > 10 phút chưa hỏi trong 5 phút ⇒ hỏi PayOS theo mã link.
   * PAID ⇒ đi ĐÚNG đường webhook (`settlePayos`, nguồn `poll`, idempotent) nên khách đã trả mà mất webhook vẫn được ghi nhận TRƯỚC hạn huỷ + ân hạn. Lưu `last_checked_at` / `last_gateway_status`.
   * Chiếm lượt hỏi bằng compare-and-set theo `last_checked_at` ⇒ nhiều worker không hỏi trùng. Lỗi mạng ⇒ bỏ qua lần này (lần sau hỏi lại).
   */
  async reconcilePendingPayos(limit = 50): Promise<{ checked: number; paid: number; mismatch: number }> {
    const out = { checked: 0, paid: 0, mismatch: 0 };
    if (!this.payos.isConfigured) return out;
    const now = Date.now();
    const recheck = new Date(now - 5 * 60_000);
    const rows = await this.prisma.payment.findMany({
      where: {
        methodCode: METHOD.PAYOS,
        status: PAY_STATUS.PENDING,
        AND: [{ OR: [{ expiresAt: { lt: new Date(now + 2 * 60_000) } }, { createdAt: { lt: new Date(now - 10 * 60_000) } }] }, { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: recheck } }] }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    for (const p of rows) {
      const claimed = await this.prisma.payment.updateMany({ where: { id: p.id, status: PAY_STATUS.PENDING, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: recheck } }] }, data: { lastCheckedAt: new Date() } });
      if (claimed.count === 0) continue;
      out.checked += 1;
      try {
        const links = await this.prisma.paymentTransaction.findMany({ where: { paymentId: p.id, type: TX_TYPE.CREATE_URL }, select: { providerRef: true }, orderBy: { createdAt: 'desc' }, take: 3 });
        let status: string | null = null;
        for (const l of links) {
          if (!l.providerRef) continue;
          const info = await this.payos.getPaymentLink(l.providerRef);
          if (info.status && status === null) status = info.status;
          if (info.status !== 'PAID') continue;
          status = 'PAID';
          const r = await this.settlePayos(p.id, l.providerRef, BigInt(Math.round(info.amountPaid ?? 0)), { orderCode: l.providerRef, amount: info.amountPaid ?? 0, source: 'poll' }, 'poll');
          if (r === 'paid') out.paid += 1;
          else if (r === 'mismatch') out.mismatch += 1;
          break;
        }
        if (status) await this.prisma.payment.update({ where: { id: p.id }, data: { lastGatewayStatus: status.slice(0, 30) } });
      } catch (err) {
        this.logger.warn({ err, paymentId: p.id }, 'Hỏi PayOS trạng thái link lỗi — bỏ qua, lần sau hỏi lại');
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ tự chi hoàn nhỏ

  /*
   * Job `refund-auto-process` (PLAN-0025 §2.5, mỗi 5 phút): hoàn tiền cho khách NHỎ tự chạy qua PayOS — refund `requested`, đi cổng, có tài khoản nhận xác định, payout đã cấu hình, số tiền ≤ `refund.auto_max_amount`
   * (0 = tắt). Dùng đúng `processRefund` (chiếm compare-and-set trước khi gọi cổng ⇒ không chi trùng với kế toán đang bấm tay) với tác nhân HỆ THỐNG. Khoản không đủ điều kiện được báo kế toán MỘT lần lúc tạo yêu cầu.
   * AUD-20: hoàn của payment COD (AUTO_REFUND_EXCLUDED_METHODS) KHÔNG BAO GIỜ tự chi — tiền mặt chưa chắc đã thu (COD-08b), kế toán duyệt tay.
   */
  async autoProcessRefunds(limit = 20): Promise<{ submitted: number; skipped: number; failed: number }> {
    const out = { submitted: 0, skipped: 0, failed: 0 };
    if (!this.payos.isPayoutConfigured) return out;
    const max = await this.system.settingNumber(SETTING_KEY.REFUND_AUTO_MAX_AMOUNT);
    if (max <= 0) return out;
    // AUD-20: lọc phương thức NGAY trong truy vấn (không lọc sau): khoản COD luôn ở `requested` nên nếu lọc sau `take`, 20 khoản COD cũ nhất sẽ chiếm hết lô và các khoản PayOS phía sau không bao giờ được tự chi.
    const rows = await this.prisma.refund.findMany({ where: { status: REFUND_STATUS.REQUESTED, method: 'gateway', needsManual: false, amount: { lte: max.toString() }, payment: { methodCode: { notIn: [...AUTO_REFUND_EXCLUDED_METHODS] } } }, include: { payment: true }, orderBy: { createdAt: 'asc' }, take: limit });
    for (const r of rows) {
      if (!resolvePayee(r, r.payment)) {
        out.skipped += 1;
        continue;
      }
      try {
        await this.processRefund(SYSTEM_ACTOR, r.id, {});
        out.submitted += 1;
      } catch (err) {
        out.failed += 1; // processRefund đã ghi failed + báo kế toán; "đang được người khác xử lý" cũng rơi vào đây (bình thường)
        this.logger.warn({ err, refundId: r.id }, 'Tự chi hoàn tiền không thành — để kế toán xử lý');
      }
    }
    return out;
  }

  /*
   * AUD-14: kế toán đòi GHI SỔ TAY (nhập providerRef) cho refund mà lệnh PayOS ở trạng thái KHÔNG RÕ (failed + đã gọi cổng + chưa biết PayOS có nhận lệnh hay không). PayOS có thể ĐÃ chi — nếu kế toán chuyển tay nữa
   * thì khách nhận hai lần. Hệ thống tra PayOS theo referenceId của lệnh: ĐÃ nhận ⇒ 409 (đối soát, đừng chuyển tay); chưa từng nhận ⇒ cho ghi sổ; không tra được ⇒ 409 trừ khi `confirmGatewayNotExecuted`.
   */
  private async assertManualSafeAfterUnknown(refundId: string, confirmed: boolean): Promise<void> {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!r || r.method !== 'gateway' || r.status !== REFUND_STATUS.FAILED || r.providerRef || r.gatewayAttemptedAt === null || r.gatewayStatus === GATEWAY_STATUS.FAILED) return;
    const attempt = Math.max(r.gatewayAttempt, 1);
    const reference = attempt <= 1 ? r.id : `${r.id}-${attempt}`;
    if (this.payos.isPayoutConfigured) {
      const found = await this.payos.findPayoutByReference(reference);
      if (found.state === 'found') throw new BusinessException(PAYMENT_ERR.REFUND_RECONCILE_REQUIRED, 'PayOS ĐÃ nhận lệnh chi cho khoản hoàn này — KHÔNG chuyển khoản tay (khách sẽ nhận hai lần). Bấm xử lý KHÔNG kèm mã giao dịch để đối soát theo lệnh PayOS đã có.', HttpStatus.CONFLICT);
      if (found.state === 'not_found') return;
    }
    if (!confirmed) throw new BusinessException(PAYMENT_ERR.REFUND_RECONCILE_REQUIRED, 'Chưa rõ PayOS đã chi khoản này hay chưa và hệ thống không tra được PayOS. Đối chiếu trên bảng điều khiển PayOS; chỉ khi chắc chắn lệnh CHƯA chạy mới ghi sổ tay (gửi confirmGatewayNotExecuted=true).', HttpStatus.CONFLICT);
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
      // PLAN-0041: mã không thuộc đơn hàng nào ⇒ thử khoản NẠP CỌC (dải mã 5e15) rồi mới coi là mã lạ (vd mẫu kiểm tra URL orderCode=123).
      try {
        // Mã không phải số nguyên ≤ 16 chữ số không thể là khoản nạp (dải 5e15..) ⇒ không đi vào luồng nạp (không chạm DB), coi là mã lạ như trước.
        const topup = /^\d{1,16}$/.test(payosOrderCode) ? await this.topups.settleWebhookIfTopup(payosOrderCode, data, paidOk) : null;
        if (topup) return { statusCode: 200, body: { code: '00', message: topup.message } };
      } catch (err) {
        this.logger.error({ err, payosOrderCode }, 'Xử lý webhook nạp cọc PayOS lỗi');
        return { statusCode: 500, body: { code: '99', message: 'Internal error' } };
      }
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
  private async settlePayos(paymentId: string, payosOrderCode: string, amountPaid: bigint, data: Record<string, unknown>, source: 'webhook' | 'return' | 'poll'): Promise<'paid' | 'already' | 'mismatch' | 'not_pending'> {
    // AUD-01: thứ tự khoá BẤT BIẾN là ĐƠN → PAYMENT (huỷ đơn của khách khoá đơn rồi mới đụng payment). Khoá payment trước rồi onPaid mới khoá đơn thì webhook ∥ huỷ deadlock ⇒ webhook 500, đơn huỷ mà tiền không ai hoàn.
    // Khoá đơn TRƯỚC (đọc orderCode không khoá), rồi khoá payment; nếu vẫn dính deadlock với đường khác thì thử lại cả transaction.
    return retryOnDeadlock(() => this.settlePayosOnce(paymentId, payosOrderCode, amountPaid, data, source));
  }

  private async settlePayosOnce(paymentId: string, payosOrderCode: string, amountPaid: bigint, data: Record<string, unknown>, source: 'webhook' | 'return' | 'poll'): Promise<'paid' | 'already' | 'mismatch' | 'not_pending'> {
    return this.prisma.$transaction(async (tx) => {
      const ref = await tx.payment.findUnique({ where: { id: paymentId }, select: { orderCode: true } });
      if (!ref) return 'not_pending' as const;
      await this.orders.lockOrder(ref.orderCode, tx);
      const head = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "payment"."payments" WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = head[0] ? await tx.payment.findUnique({ where: { id: paymentId } }) : null;
      if (!p) return 'not_pending' as const;
      const expected = vnd(p.amount.toString());
      const received = vnd(p.receivedAmount.toString());
      // Webhook mang MỘT khoản tiền (có mã giao dịch `reference`); return/poll mang số đã trả LUỸ KẾ của link (không có mã khoản) ⇒ chỉ webhook cộng dồn, return/poll lấy max.
      const eventRef = source === 'webhook' ? PaymentService.eventRefOf(payosOrderCode, data) : null;
      const webhookRows = await tx.paymentTransaction.findMany({ where: { paymentId: p.id, type: TX_TYPE.PAYOS_WEBHOOK }, select: { status: true, rawResponse: true, amount: true } });
      const seenRefs = PaymentService.webhookRefs(webhookRows);
      // Chỉ mục UNIQUE (type, provider_ref): hàng giao dịch đầu của link giữ mã PayOS (như trước); các hàng sau (khoản trả thêm / thiếu / trùng) kèm mã khoản để không đụng nhau.
      const rowRef = webhookRows.length === 0 ? payosOrderCode : `${payosOrderCode}:${eventRef ?? Date.now().toString(36)}`.slice(0, 120);
      // PayOS gửi lại đúng khoản này — đã ghi, không cộng lần hai. Khoản đã từng chỉ là "trả thiếu" thì vẫn là thiếu; còn lại coi như đã ghi nhận.
      if (eventRef && seenRefs.has(eventRef)) return seenRefs.get(eventRef) === 'mismatch' && p.status !== PAY_STATUS.PAID ? ('mismatch' as const) : ('already' as const);

      if (p.status === PAY_STATUS.PAID || p.status === PAY_STATUS.REFUNDED || p.status === PAY_STATUS.PARTIALLY_REFUNDED) {
        // Trang return thắng webhook thì gatewayResponse thiếu tài khoản đối ứng (cần để hoàn tiền tự động) — webhook đến sau BỔ SUNG, không bỏ qua.
        const stored = (p.gatewayResponse ?? {}) as Record<string, unknown>;
        if (source === 'webhook' && !stored.counterAccountNumber && data.counterAccountNumber) {
          await tx.payment.update({ where: { id: p.id }, data: { gatewayResponse: { ...stored, ...data } as Prisma.InputJsonObject } });
        }
        // Payment ĐÃ paid (do return/poll ghi số luỹ kế, hoặc webhook trước): webhook mới (khác mã khoản) chỉ là TIỀN THÊM khi tổng các khoản webhook vượt số đã được tính cho đơn.
        // Số tính cho đơn (base) = received trừ các khoản đã ghi 'duplicate'; tổng khoản chính (primary) = các webhook 'ok' | 'mismatch' | 'seen'. Webhook thuộc số luỹ kế poll/return đã thấy
        // (khách trả 2 lần, poll thấy đủ trước khi 2 webhook về) ⇒ chỉ ghi 'seen', KHÔNG hoàn. Phần VƯỢT mới là trả trùng ⇒ hoàn đúng phần vượt (PLAN-0041: phát hiện khi kiểm, trước đây hoàn nhầm cả khoản thứ hai).
        if (source === 'webhook' && eventRef) {
          let primarySum = 0n;
          let dupSum = 0n;
          for (const r of webhookRows) {
            const m = r.amount === null ? 0n : vnd(r.amount.toString());
            // Hàng 'ok' do return/poll ghi (lúc đánh dấu paid) KHÔNG mang `reference` — nó là số luỹ kế đã nằm trong `received`, không phải một khoản webhook ⇒ không cộng vào primarySum.
            const keyed = typeof (r.rawResponse as { reference?: unknown } | null)?.reference === 'string';
            if (r.status === 'duplicate') dupSum += m;
            else if (keyed && (r.status === 'ok' || r.status === 'mismatch' || r.status === 'seen')) primarySum += m;
          }
          // Payment đã paid thì ít nhất `expected` đã được tính (kể cả dữ liệu cũ chưa có received_amount); thừa hơn thì lấy received trừ phần đã coi là trùng.
          const accounted = received > dupSum ? received - dupSum : 0n;
          const base = accounted > expected ? accounted : expected;
          const withThis = primarySum + amountPaid;
          if (withThis <= base) {
            await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.PAYOS_WEBHOOK, status: 'seen', amount: amountPaid.toString(), providerRef: rowRef, rawResponse: { ...data, reference: eventRef } } });
          } else {
            const excess = withThis - (base > primarySum ? base : primarySum);
            await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.PAYOS_WEBHOOK, status: 'duplicate', amount: excess.toString(), providerRef: rowRef, rawResponse: { ...data, reference: eventRef } } });
            await tx.payment.update({ where: { id: p.id }, data: { receivedAmount: (received + excess).toString() } });
            await this.audit(tx, null, { action: PAYMENT_AUDIT.FAILED, entityType: 'payment', entityId: p.id, entityCode: p.orderCode, after: { method: METHOD.PAYOS, reason: 'duplicate_payment', received: excess.toString(), eventRef, source } });
            const res = await this.requestRefund({ orderCode: p.orderCode, shopId: null, amount: excess, reason: 'Thanh toán trùng — khách chuyển thêm một lần nữa cho cùng đơn', returnRequestId: null, actorUserId: null, paymentId: p.id, kind: REFUND_KIND.DUPLICATE_PAYMENT }, tx);
            await this.notifyMismatch(tx, p, `Khách trả trùng đơn ${p.orderCode}`, `Nhận thêm ${money(excess).display} cho đơn đã thanh toán. ${res.refundId ? 'Yêu cầu hoàn đã được tạo — xử lý ở màn Hoàn tiền.' : 'Không tạo được yêu cầu hoàn — kiểm tra thủ công.'}`, { reason: 'duplicate_payment', refundId: res.refundId });
          }
        }
        return 'already' as const;
      }

      // AUD-21: webhook THIẾU cả `reference` lẫn `transactionDateTime` (PayOS thật luôn có) ⇒ không phân biệt được "PayOS gửi lại" với "khách chuyển thêm". Chọn phía an toàn về tiền: đã có giao dịch webhook
      // CÙNG số tiền ⇒ coi là gửi lại, KHÔNG cộng dồn (cộng nhầm thì hai webhook nửa tiền thành `paid` oan). Ca hợp lệ "trả thiếu rồi trả phần còn lại" khác số tiền nên không bị chặn.
      if (source === 'webhook' && eventRef === null) {
        const sameAmount = webhookRows.find((r) => r.amount !== null && vnd(r.amount.toString()) === amountPaid);
        if (sameAmount) return sameAmount.status === 'mismatch' ? ('mismatch' as const) : ('already' as const);
      }

      const total = source === 'webhook' ? received + amountPaid : received > amountPaid ? received : amountPaid;
      const counter = source === 'webhook' && !((p.gatewayResponse ?? {}) as Record<string, unknown>).counterAccountNumber ? { gatewayResponse: data as Prisma.InputJsonObject } : {};

      // PLAN-0040 2b.1 (AUD-18/19) — payment KHÔNG còn `pending` (đã huỷ / hết hạn) mà vẫn nhận tiền = TIỀN ĐẾN MUỘN. Tiền đã nhận ở khoản trước đang/đã được hoàn nên payment này không bao giờ được `paid`
      // bằng tổng cộng dồn nhiều lần: chỉ cộng `received_amount` và bù yêu cầu hoàn đúng phần chưa được phủ (settleLateMoney). Payment `pending` (đường bình thường) không đi qua đây.
      // Ngoại lệ GIỮ hành vi cũ: khoản ĐẦU TIÊN đã đủ giá trị đơn (received = 0, total ≥ expected) ⇒ ghi paid + onPaid như trước ("trả muộn trên link cũ": đơn còn mở thì được thanh toán,
      // đơn đã huỷ thì order tạo hoàn đủ ở onPaid — PAY-06b/CONC-02/CONC-08).
      // Chỉ mục thật `uq_payments_order_live` (order_id) WHERE status IN (pending, processing, paid) ⇒ đơn chỉ có MỘT payment sống: đơn đã được trả bằng payment khác (`paid`) thì KHÔNG lên paid thêm được (⇒ hoàn trùng);
      // còn payment chờ khác (link mới sau retry) thì phải huỷ TRƯỚC khi payment cũ lên paid, nếu không UPDATE vi phạm chỉ mục ⇒ webhook 500 mãi.
      if (p.status !== PAY_STATUS.PENDING && p.status !== PAY_STATUS.PROCESSING) {
        const live = await tx.payment.findMany({ where: { orderCode: p.orderCode, id: { not: p.id }, status: { in: [PAY_STATUS.PENDING, PAY_STATUS.PROCESSING, PAY_STATUS.PAID] } } });
        const siblingPaid = live.some((s) => s.status === PAY_STATUS.PAID);
        if (siblingPaid || !(received === 0n && total >= expected)) {
          return this.settleLateMoney(tx, p, { total, data, counter, eventRef, rowRef, source, kind: siblingPaid ? REFUND_KIND.DUPLICATE_PAYMENT : REFUND_KIND.MISMATCH });
        }
        if (live.length > 0) await this.cancel(p.orderCode, 'Đơn đã được thanh toán bằng liên kết thanh toán cũ', tx); // huỷ payment chờ (link mới) + hoàn phần nó đã nhận nếu có
      }

      if (total < expected) {
        // Trả THIẾU: chưa `paid`. Ghi nhận khoản đã nhận (để hoàn nếu đơn bị huỷ, hoặc khách chuyển nốt phần còn lại) + báo kế toán.
        // poll/return hỏi lại mà không có tiền mới: im lặng (không tạo giao dịch/thông báo mỗi lần hỏi). Ngoại lệ: PayOS báo PAID mà không kèm số tiền — bất thường, ghi nhận ĐÚNG MỘT lần.
        if (total === received && source !== 'webhook' && (received > 0n || webhookRows.some((r) => r.status === 'mismatch'))) return 'mismatch' as const;
        await tx.payment.update({ where: { id: p.id }, data: { receivedAmount: total.toString(), ...counter } });
        await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.PAYOS_WEBHOOK, status: 'mismatch', amount: amountPaid.toString(), providerRef: rowRef, rawResponse: { ...data, ...(eventRef ? { reference: eventRef } : {}) } } });
        await this.audit(tx, null, { action: PAYMENT_AUDIT.FAILED, entityType: 'payment', entityId: p.id, entityCode: p.orderCode, after: { method: METHOD.PAYOS, reason: 'amount_mismatch', expected: expected.toString(), received: total.toString(), source } });
        await this.notifyMismatch(tx, p, `Khách trả thiếu đơn ${p.orderCode}`, `Đã nhận ${money(total).display} / ${money(expected).display}. Đơn chưa được ghi nhận thanh toán; nếu hết hạn mà chưa đủ, tiền đã nhận sẽ được hoàn.`, { reason: 'underpaid', received: total.toString(), expected: expected.toString() });
        return 'mismatch' as const;
      }

      const now = new Date();
      // return-query không mang tài khoản đối ứng ⇒ KHÔNG ghi gatewayResponse (để webhook đến sau bổ sung trọn bộ)
      await tx.payment.update({ where: { id: p.id }, data: { status: PAY_STATUS.PAID, paidAt: now, transactionCode: payosOrderCode, receivedAmount: total.toString(), ...(source === 'webhook' ? { gatewayResponse: data as Prisma.InputJsonObject } : {}), version: { increment: 1 } } });
      await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.PAYOS_WEBHOOK, status: 'ok', amount: amountPaid.toString(), providerRef: rowRef, rawResponse: { ...data, ...(eventRef ? { reference: eventRef } : {}) } } });
      await this.audit(tx, null, { action: PAYMENT_AUDIT.PAID, entityType: 'payment', entityId: p.id, entityCode: p.orderCode, after: { method: METHOD.PAYOS, payosOrderCode, source, received: total.toString() } });
      if (await this.refundDuplicate(tx, { id: p.id, orderCode: p.orderCode, amount: p.amount, receivedAmount: new Prisma.Decimal(total.toString()) })) return 'paid' as const; // đơn đã được trả bằng khoản khác — hoàn khoản này, không onPaid lần hai
      await this.orders.onPaid(p.orderCode, { paymentId: p.id, methodCode: METHOD.PAYOS, transactionCode: payosOrderCode, bankCode: null, paidAt: now }, tx);
      await writeOutboxEvent(tx.paymentOutboxEvent, { eventType: PAYMENT_EVENT.PAID, aggregateType: 'payment', aggregateId: p.id, payload: { orderCode: p.orderCode, userId: p.userId, amount: expected.toString(), method: METHOD.PAYOS } });
      if (total > expected) {
        // Trả THỪA: đơn vẫn `paid` đúng giá trị; hoàn riêng phần thừa (không đụng trạng thái thanh toán / hoa hồng của đơn).
        const res = await this.requestRefund({ orderCode: p.orderCode, shopId: null, amount: total - expected, reason: 'Hoàn phần khách chuyển thừa so với giá trị đơn', returnRequestId: null, actorUserId: null, paymentId: p.id, kind: REFUND_KIND.MISMATCH }, tx);
        await this.notifyMismatch(tx, p, `Khách trả thừa đơn ${p.orderCode}`, `Đã nhận ${money(total).display}, đơn ${money(expected).display}. ${res.refundId ? `Yêu cầu hoàn phần thừa ${money(total - expected).display} đã được tạo.` : 'Không tạo được yêu cầu hoàn — kiểm tra thủ công.'}`, { reason: 'overpaid', refundId: res.refundId });
      }
      return 'paid' as const;
    });
  }

  /*
   * PLAN-0040 2b.1 (AUD-18/19) — TIỀN ĐẾN MUỘN trên payment đã huỷ / hết hạn (khách quét lại QR cũ, chuyển nốt phần còn lại sau khi đơn bị huỷ, chuyển vào link của đơn đã huỷ…). Bất biến phải giữ, với MỖI payment:
   *   Σ yêu cầu hoàn = received_amount (đơn đã huỷ ⇒ giữ lại 0), luôn ≤ trần hoàn (`refundCap` = received khi chưa thu), webhook hợp lệ luôn 200 (KHÔNG ném — ném là PayOS gửi lại vô hạn mà tiền vẫn không được ghi).
   * Cách làm: chỉ cộng `received_amount` (KHÔNG đổi trạng thái payment) rồi bù yêu cầu hoàn đúng phần CHƯA được phủ (`unrefundedReceived` = received − Σ mọi yêu cầu hoàn) — dùng chung với `refundReceivedOfCancelled`.
   * Idempotent: replay cùng mã khoản đã bị chặn ở settlePayosOnce; return/poll hỏi lại mà không có tiền mới ⇒ im lặng. `kind` = mismatch (đơn huỷ / giao dịch đã huỷ) hoặc duplicate_payment (đơn đã được trả bằng payment khác).
   */
  private async settleLateMoney(
    tx: Tx,
    p: { id: string; orderCode: string; userId: string; receivedAmount: Prisma.Decimal },
    m: { total: bigint; data: Record<string, unknown>; counter: { gatewayResponse?: Prisma.InputJsonObject }; eventRef: string | null; rowRef: string; source: 'webhook' | 'return' | 'poll'; kind: RefundKind },
  ): Promise<'mismatch'> {
    const added = m.total - vnd(p.receivedAmount.toString());
    if (added <= 0n) return 'mismatch'; // return/poll hỏi lại mà không có tiền mới — không tạo giao dịch/thông báo mỗi lần hỏi
    const duplicate = m.kind === REFUND_KIND.DUPLICATE_PAYMENT;
    await tx.payment.update({ where: { id: p.id }, data: { receivedAmount: m.total.toString(), ...m.counter } });
    await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.PAYOS_WEBHOOK, status: 'late', amount: added.toString(), providerRef: m.rowRef, rawResponse: { ...m.data, ...(m.eventRef ? { reference: m.eventRef } : {}) } } });
    await this.audit(tx, null, { action: PAYMENT_AUDIT.FAILED, entityType: 'payment', entityId: p.id, entityCode: p.orderCode, after: { method: METHOD.PAYOS, reason: duplicate ? 'duplicate_payment' : 'late_payment', added: added.toString(), received: m.total.toString(), source: m.source } });
    // received đã cập nhật ở trên (requestRefund đọc lại payment trong cùng tx) ⇒ tính phần chưa phủ theo số mới.
    const owed = await this.unrefundedReceived(tx, { id: p.id, receivedAmount: new Prisma.Decimal(m.total.toString()) });
    const reason = duplicate ? 'Thanh toán trùng — đơn đã được thanh toán bằng giao dịch khác' : 'Hoàn tiền khách chuyển sau khi giao dịch thanh toán đã bị huỷ / hết hạn';
    const res = owed > 0n ? await this.requestRefund({ orderCode: p.orderCode, shopId: null, amount: owed, reason, returnRequestId: null, actorUserId: null, paymentId: p.id, kind: m.kind }, tx) : { refundId: null };
    await this.notifyMismatch(
      tx,
      p,
      duplicate ? `Khách trả trùng đơn ${p.orderCode}` : `Tiền về muộn — đơn ${p.orderCode}`,
      `Nhận thêm ${money(added).display} vào giao dịch ${duplicate ? 'của đơn đã được thanh toán bằng giao dịch khác' : 'đã bị huỷ / hết hạn'} (tổng đã nhận ${money(m.total).display}). ${res.refundId ? `Yêu cầu hoàn ${money(owed).display} đã được tạo — xử lý ở màn Hoàn tiền.` : 'Không tạo được yêu cầu hoàn — kiểm tra thủ công.'}`,
      { reason: duplicate ? 'duplicate_payment' : 'late_payment', refundId: res.refundId, added: added.toString(), received: m.total.toString() },
    );
    if (res.refundId) {
      await this.notifier.notify({ userId: p.userId, type: 'payment', title: `Đơn ${p.orderCode}: khoản chuyển thêm sẽ được hoàn`, content: `Hệ thống nhận ${money(added).display} vào giao dịch thanh toán không còn hiệu lực. Chúng tôi sẽ hoàn lại số tiền này cho bạn.`, link: `/account/orders/${p.orderCode}`, payload: { refundId: res.refundId } }, tx);
    }
    return 'mismatch';
  }

  // ------------------------------------------------------------------ hoàn tiền (kế toán)

  /*
   * Xử lý hoàn tiền (kế toán bấm): chi qua PayOS payout khi đủ điều kiện, hoặc chuyển khoản tay rồi nhập mã giao dịch (hoàn đơn COD khi chưa cấu hình payout, thiếu tài khoản nhận, dữ liệu VNPay/chuyển khoản lịch sử).
   *
   * Máy trạng thái an toàn tiền — KHÔNG BAO GIỜ chi hai lần, và KHÔNG BAO GIỜ coi "PayOS đã nhận lệnh" là "tiền đã đi" (PLAN-0022):
   *   requested|failed ─CHIẾM (compare-and-set)→ processing ─┬ hoàn TAY (providerRef) ──────────────────────────────→ GHI SỔ ─→ done
   *                                                          └ PayOS payout: gửi lệnh → PayOS "00" = ĐÃ NHẬN lệnh → ghi gateway_payout_id + gateway_submitted_at, GIỮ processing
   *                                                               └ đối soát `getPayout` (reconcileGatewayRefunds, 1 phút/lần; hoặc kế toán bấm lại): succeeded → ghi providerRef + GHI SỔ → done
   *                                                                                                                                    failed (lỗi/từ chối/huỷ/hoàn) → failed (kế toán chạy lại — lệnh MỚI)
   *                                                                                                                                    processing/không tra được → giữ nguyên; quá REFUND_GATEWAY_STALL_MS ⇒ báo kế toán MỘT lần
   *  - CHIẾM trước khi gọi cổng ⇒ bấm đúp / hai kế toán cùng lúc chỉ một người đi tiếp (chống hoàn hai lần thật).
   *  - `provider_ref` CHỈ được ghi khi tiền đã đi thật (PayOS báo succeeded, hoặc kế toán nhập mã chuyển tay). Ghi sổ lỗi (DB chết, tổng hoàn vượt số đã thu…) ⇒ refund giữ `processing` + `provider_ref`;
   *    chạy lại CHỈ phần ghi sổ (gọi lại process / retryFinalizeRefund / job), tuyệt đối không gọi cổng lần hai.
   *  - Đã gửi lệnh (gateway_submitted_at) thì KHÔNG gửi lại: bấm "hoàn tiền" lúc đang chờ chỉ tra trạng thái. Lệnh chưa được ghi nhận gửi (tiến trình chết giữa chừng) gửi lại với CÙNG
   *    referenceId/idempotency-key (= refund.id) nên PayOS trả đúng lệnh cũ. Chỉ khi lệnh trước bị PayOS báo THẤT BẠI HẲN mới tạo lệnh mới (`<refund.id>-<lần>`).
   *  - `processing` quá REFUND_STUCK_MS mà chưa có provider_ref và chưa gửi lệnh ⇒ chiếm lại bằng compare-and-set theo `updated_at` (hai người cùng bấm chỉ một người thắng).
   * Ghi sổ cuối KHOÁ dòng payment và cộng `refundedAmount` từ giá trị mới nhất (không mất cập nhật khi hai khoản hoàn một phần của cùng payment hoàn tất song song),
   * kiểm lại không vượt số đã thu. Lỗi trước khi cổng chạy ⇒ nhả chiếm về `requested`.
   * Trả refund ở trạng thái hiện tại: `done` (hoàn tay / PayOS đã chốt) hoặc `processing` (PayOS đã nhận lệnh, đang chờ chốt) hoặc `failed` (PayOS báo thất bại khi tra lại).
   */
  async processRefund(actor: AuthenticatedActor, refundId: string, input: { providerRef?: string; note?: string; confirmGatewayNotExecuted?: boolean }): Promise<RefundResponse> {
    const manual = { providerRef: input.providerRef ? normalizeManualProviderRef(input.providerRef) : undefined, note: input.note };
    if (manual.providerRef) await this.assertManualSafeAfterUnknown(refundId, input.confirmGatewayNotExecuted === true); // TRƯỚC khi chiếm: bị chặn thì refund giữ nguyên trạng thái
    const claimed = await this.prisma.refund.updateMany({
      where: { id: refundId, status: { in: [REFUND_STATUS.REQUESTED, REFUND_STATUS.FAILED] } },
      // Chiếm lại lệnh vừa bị PayOS báo thất bại: xoá mốc "PayOS đã nhận lệnh" cũ (lệnh mới sẽ ghi lại) để job đối soát không tra nhầm lệnh đã chết.
      data: { status: REFUND_STATUS.PROCESSING, processedBy: actor.userId, gatewaySubmittedAt: null, gatewayAlertedAt: null, updatedAt: new Date(), version: { increment: 1 } },
    });
    if (claimed.count === 0) {
      const cur = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { status: true, providerRef: true, updatedAt: true, gatewaySubmittedAt: true } });
      if (!cur) throw new NotFoundException(PAYMENT_ERR.REFUND_NOT_FOUND, 'Không tìm thấy yêu cầu hoàn tiền');
      if (cur.status === REFUND_STATUS.DONE) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Đã hoàn xong');
      // PayOS ĐÃ nhận lệnh chi, chưa có kết quả cuối: KHÔNG BAO GIỜ gửi lại — chỉ tra trạng thái ngay (hoặc xác nhận tay khi treo bất thường).
      if (cur.status === REFUND_STATUS.PROCESSING && cur.gatewaySubmittedAt && !cur.providerRef) return this.checkSubmittedRefund(actor, refundId, manual);
      // processing còn "tươi" ⇒ người khác đang xử lý (bấm đúp): từ chối như cũ. Quá hạn ⇒ coi là treo: đã có provider_ref (tiền ĐÃ đi) thì chỉ ghi sổ, chưa có thì chiếm lại.
      const stuckBefore = new Date(Date.now() - REFUND_STUCK_MS);
      const stuck = cur.status === REFUND_STATUS.PROCESSING && cur.updatedAt < stuckBefore;
      if (stuck && cur.providerRef) return this.retryFinalizeRefund(actor, refundId);
      const retaken = stuck
        ? await this.prisma.refund.updateMany({ where: { id: refundId, status: REFUND_STATUS.PROCESSING, providerRef: null, gatewaySubmittedAt: null, updatedAt: { lt: stuckBefore } }, data: { processedBy: actor.userId, updatedAt: new Date(), version: { increment: 1 } } })
        : { count: 0 };
      if (retaken.count === 0) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, `Yêu cầu đang ở trạng thái ${cur.status} — không xử lý được`);
    }
    return this.runClaimedRefund(actor, refundId, manual);
  }

  /*
   * Hoàn tất GHI SỔ cho refund mà tiền ĐÃ đi (`processing` + `provider_ref`) nhưng ghi sổ trước đó thất bại. KHÔNG gọi cổng. Idempotent: ghi sổ chạy dưới khoá dòng
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
   * Job phục hồi (worker, định kỳ): refund `processing` quá hạn mà PayOS CHƯA nhận lệnh (chưa gateway_submitted_at — lệnh đã gửi do `reconcileGatewayRefunds` lo, không bao giờ nhả/chi lại).
   *  - đã có provider_ref (tiền đã đi) ⇒ GHI SỔ nốt (không gọi cổng);
   *  - chưa có provider_ref, CHƯA từng gọi cổng ⇒ nhả về `requested` (lệnh PayOS gửi lại sau đó dùng cùng idempotency-key ⇒ không chi đôi);
   *  - chưa có provider_ref, ĐÃ từng gọi cổng (VNPay cũ — dữ liệu lịch sử) ⇒ `failed` kèm lý do — chờ người đối chiếu (không tự đoán, không tự chi).
   * Mỗi refund một try/catch; mọi bước là compare-and-set nên chạy chồng với người bấm tay / nhiều worker vẫn an toàn.
   */
  async recoverStuckRefunds(limit = 20): Promise<{ finalized: number; released: number; flagged: number }> {
    const stuckBefore = new Date(Date.now() - REFUND_STUCK_MS);
    const rows = await this.prisma.refund.findMany({ where: { status: REFUND_STATUS.PROCESSING, gatewaySubmittedAt: null, updatedAt: { lt: stuckBefore } }, orderBy: { updatedAt: 'asc' }, take: limit, include: { payment: true } });
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
            ? { status: REFUND_STATUS.FAILED, note: 'Treo khi gọi cổng — chưa rõ cổng đã hoàn khoản này hay chưa. Đối chiếu trên cổng: nhập providerRef để ghi sổ, hoặc hoàn tay rồi nhập mã tham chiếu.', processedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } }
            : { status: REFUND_STATUS.REQUESTED, updatedAt: new Date(), version: { increment: 1 } };
          const res = await tx.refund.updateMany({ where: { id: r.id, status: REFUND_STATUS.PROCESSING, providerRef: null, gatewaySubmittedAt: null, updatedAt: { lt: stuckBefore } }, data });
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

  /*
   * Job đối soát lệnh chi PayOS (worker, 1 phút/lần): mọi refund `processing` mà PayOS ĐÃ nhận lệnh (gateway_submitted_at) — hỏi lại `getPayout`:
   *  succeeded → ghi providerRef + ghi sổ `done`; failed → `failed` (báo kế toán); processing/không tra được → giữ nguyên, quá REFUND_GATEWAY_STALL_MS ⇒ đánh dấu cần người xem + báo kế toán MỘT lần.
   * Đã có provider_ref (PayOS xác nhận từ trước, ghi sổ lỗi) ⇒ chỉ ghi sổ nốt. Tối đa `limit` refund/lượt, chọn theo `updated_at` CŨ NHẤT trước — mỗi lần tra chưa chốt đẩy updated_at lên hiện tại nên các lượt sau
   * xoay vòng hết mọi lệnh treo (≥ `limit` lệnh treo không làm đói lệnh mới); mỗi refund một try/catch.
   * Chạy chồng (nhiều worker / kế toán bấm tay cùng lúc) an toàn: ghi sổ + đánh failed + báo treo đều là compare-and-set — mỗi việc chỉ MỘT bên thắng, không ghi sổ hai lần, không báo hai lần.
   */
  async reconcileGatewayRefunds(limit = 30): Promise<{ checked: number; finalized: number; failed: number; pending: number }> {
    const rows = await this.prisma.refund.findMany({ where: { status: REFUND_STATUS.PROCESSING, gatewaySubmittedAt: { not: null } }, orderBy: [{ updatedAt: 'asc' }, { gatewaySubmittedAt: 'asc' }], take: limit, include: { payment: true } });
    const out = { checked: rows.length, finalized: 0, failed: 0, pending: 0 };
    for (const r of rows) {
      try {
        const outcome = await this.settleSubmitted(r, null, {});
        if (outcome === 'done') out.finalized += 1;
        else if (outcome === 'failed') out.failed += 1;
        else out.pending += 1;
      } catch (err) {
        this.logger.error({ err, refundId: r.id }, 'Đối soát lệnh chi PayOS của refund lỗi');
      }
    }
    return out;
  }

  /* Kế toán bấm "hoàn tiền" lên refund PayOS ĐÃ nhận lệnh: không gửi lại — tra trạng thái ngay; có providerRef thì xác nhận tay (chỉ khi PayOS treo bất thường / không tra được). */
  private async checkSubmittedRefund(actor: AuthenticatedActor, refundId: string, input: { providerRef?: string; note?: string }): Promise<RefundResponse> {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!r) throw new NotFoundException(PAYMENT_ERR.REFUND_NOT_FOUND, 'Không tìm thấy yêu cầu hoàn tiền');
    if (r.status === REFUND_STATUS.DONE) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Đã hoàn xong');
    if (r.status !== REFUND_STATUS.PROCESSING || !r.gatewaySubmittedAt || r.providerRef) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, `Yêu cầu đang ở trạng thái ${r.status} — không xử lý được`);
    const outcome = await this.settleSubmitted(r, actor, input);
    if (outcome === 'manual_blocked') {
      throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'PayOS vẫn đang xử lý lệnh chi — chờ kết quả. Chỉ xác nhận tay (nhập mã giao dịch) được khi PayOS treo quá 30 phút hoặc không tra cứu được lệnh chi');
    }
    return this.getRefund(refundId);
  }

  /*
   * Chốt kết quả lệnh chi PayOS của MỘT refund `processing` đã được PayOS nhận (job đối soát / kế toán bấm lại). `actor` null = hệ thống. Không bao giờ gửi lệnh mới.
   * `input.providerRef` (đã chuẩn hoá) = kế toán xác nhận TAY khi PayOS treo: chỉ nhận khi đã quá hạn bất thường / không tra được — còn trong hạn ⇒ 'manual_blocked' (tránh chốt tay rồi PayOS lại báo lỗi).
   */
  private async settleSubmitted(r: RefundWithPayment, actor: RefundActor | null, input: { providerRef?: string; note?: string }): Promise<GatewayOutcome> {
    await this.assertRefundFinanceSafety(r.orderCode);
    // PayOS đã xác nhận trước đó (providerRef đã ghi) mà ghi sổ lỗi ⇒ chỉ ghi sổ nốt, không tra lại cổng.
    if (r.providerRef) {
      await this.finalizeRefund(actor, r, r.providerRef, { recovered: true }, undefined, { via: actor ? 'process' : 'job' });
      return 'done';
    }
    const payoutId = r.gatewayPayoutId;
    const st = payoutId ? await this.payos.getPayout(payoutId) : { state: 'unknown' as const, detail: 'PayOS nhận lệnh nhưng không trả mã lệnh chi để tra cứu' };
    if (st.state === 'succeeded' && payoutId) {
      const providerRef = `${GATEWAY_REF_PREFIX}${payoutId}`;
      await this.recordGatewayRef(r.id, providerRef);
      await this.finalizeRefund(actor, r, providerRef, { payoutId, state: st.state, detail: st.detail }, input.note, { via: actor ? 'process' : 'poll', payoutId, initiatedBy: r.processedBy });
      return 'done';
    }
    if (st.state === 'failed') {
      // Chỉ đánh failed khi refund VẪN đang ở đúng lượt gửi lệnh mà ta vừa tra (gateway_submitted_at khớp): worker khác có thể đã đánh failed và kế toán đã chiếm lại để gửi lệnh MỚI.
      await this.failRefund(r, actor, `PayOS: ${st.detail}`, { payoutId, state: st.state, detail: st.detail }, { gatewayStatus: GATEWAY_STATUS.FAILED, onlySubmittedAt: r.gatewaySubmittedAt, payeeSource: r.payeeSource ?? undefined });
      return 'failed';
    }
    // Chưa chốt: đánh dấu "vừa tra" bằng updated_at (không tăng version) — job đối soát chọn refund có updated_at CŨ NHẤT trước nên xoay vòng công bằng, lệnh mới không bị đói sau các lệnh treo.
    await this.prisma.refund.updateMany({ where: { id: r.id, status: REFUND_STATUS.PROCESSING }, data: { ...(st.state === 'processing' ? { gatewayStatus: GATEWAY_STATUS.PROCESSING } : {}), updatedAt: new Date() } });
    const stalled = !payoutId || (r.gatewaySubmittedAt !== null && Date.now() - r.gatewaySubmittedAt.getTime() > REFUND_GATEWAY_STALL_MS);
    if (stalled) await this.flagStalledGatewayRefund(r, st.detail);
    if (!input.providerRef) return 'pending';
    if (!stalled && !r.gatewayAlertedAt) return 'manual_blocked';
    await this.assertProviderRefFree(r.id, input.providerRef);
    try {
      await this.finalizeRefund(actor, r, input.providerRef, { manual: true, confirmedPayoutId: payoutId }, input.note, { via: 'process', manualConfirm: true, payoutId });
    } catch (err) {
      throw this.duplicateRefOrSame(err);
    }
    return 'done';
  }

  /* PayOS nhận lệnh quá lâu không chốt (hoặc không trả mã tra cứu): đánh dấu cần người xem + báo kế toán ĐÚNG MỘT LẦN (compare-and-set gateway_alerted_at IS NULL; thông báo ghi cùng tx). */
  private async flagStalledGatewayRefund(r: RefundWithPayment, detail: string): Promise<boolean> {
    if (r.gatewayAlertedAt) return false;
    const accountants = await this.accountantIds();
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.refund.updateMany({ where: { id: r.id, status: REFUND_STATUS.PROCESSING, gatewayAlertedAt: null }, data: { gatewayAlertedAt: new Date(), needsManual: true } });
      if (res.count === 0) return false;
      await this.audit(tx, null, { action: PAYMENT_AUDIT.REFUND_GATEWAY_STALLED, entityType: 'refund', entityId: r.id, entityCode: r.orderCode, after: { payoutId: r.gatewayPayoutId, detail } });
      await this.notifyAccountants(tx, accountants, {
        title: `Lệnh hoàn tiền đơn ${r.orderCode} treo bất thường`,
        content: `${money(r.amount.toString()).display} — PayOS đã nhận lệnh chi nhưng chưa báo kết quả (${detail}). Đối chiếu trên bảng điều khiển PayOS rồi nhập mã giao dịch nếu tiền đã chuyển.`,
        payload: { refundId: r.id, orderCode: r.orderCode, payoutId: r.gatewayPayoutId },
      });
      return true;
    });
  }

  /* Phần còn lại của processRefund sau khi đã CHIẾM: chi tiền (cổng/tay) → ghi sổ. Tách riêng để lỗi từng bước có cách xử lý khác nhau (xem comment processRefund). */
  private async runClaimedRefund(actor: AuthenticatedActor, refundId: string, input: { providerRef?: string; note?: string }): Promise<RefundResponse> {
    const r = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
    if(r.payment.collectionMode === 'carrier_cod' && !r.payment.codRemittedAt) { await this.releaseRefundClaim(refundId); throw new BusinessException('PAYMENT_COD_REMITTANCE_REQUIRED','Cần xác nhận tiền COD hãng nộp về sàn trước khi chi hoàn',409); }
    const ctx = { gatewayCalled: false };
    let paid: RefundDisbursement | null;
    try {
      await this.assertRefundFinanceSafety(r.orderCode);
      paid = await this.disburseRefund(actor, r, input, ctx);
    } catch (err) {
      // Lỗi TRƯỚC khi cổng chạy (cấu hình/thiếu providerRef…): nhả chiếm. Cổng đã được gọi thì KHÔNG nhả: từ chối rõ ràng đã ghi `failed` (failRefund), còn không rõ kết quả
      // thì giữ `processing` để job/người phục hồi — tuyệt đối không quay về `requested` để ai đó bấm gọi lại cổng.
      if (!ctx.gatewayCalled) await this.releaseRefundClaim(refundId);
      throw err;
    }
    if (!paid) return this.getRefund(refundId); // PayOS đã NHẬN lệnh: refund giữ `processing` — job đối soát (hoặc bấm lại) chốt khi PayOS báo xong

    try {
      await this.finalizeRefund(actor, r, paid.providerRef, paid.raw, input.note ?? null, { via: 'process', ...paid.meta });
    } catch (err) {
      // Hoàn tay chưa để lại dấu vết ngoài hệ thống ⇒ nhả chiếm để làm lại (mã giao dịch trùng ⇒ 409 rõ ràng thay vì lỗi DB).
      await this.releaseRefundClaim(refundId);
      throw this.duplicateRefOrSame(err);
    }
    return this.getRefund(refundId);
  }

  private releaseRefundClaim(refundId: string): Promise<unknown> {
    return this.prisma.refund.updateMany({ where: { id: refundId, status: REFUND_STATUS.PROCESSING }, data: { status: REFUND_STATUS.REQUESTED, updatedAt: new Date(), version: { increment: 1 } } });
  }

  /*
   * Bước CHI TIỀN của một refund đã chiếm. Trả `RefundDisbursement` (hoàn tay — ghi sổ ngay) hoặc `null` (PayOS đã NHẬN lệnh chi — chờ đối soát). Ném lỗi nếu cổng từ chối / chưa đủ điều kiện.
   *  - PayOS payment và đơn COD đi qua cổng chi khi có tài khoản nhận (ưu tiên tài khoản ĐÃ TRẢ tiền → tài khoản khách khai) VÀ đã cấu hình khoá payout; thiếu một trong hai ⇒ kế toán chuyển tay + nhập `providerRef`.
   *  - Lệnh PayOS trước đó thất bại / không rõ kết quả mà kế toán nhập providerRef ⇒ coi là chuyển tay (đã chuyển ngoài hệ thống), không gửi lệnh mới.
   *  - Refund lịch sử qua cổng đã bỏ (VNPay): không còn gọi cổng — kế toán đối chiếu/chuyển tay rồi nhập mã tham chiếu để ghi sổ.
   */
  private async disburseRefund(actor: AuthenticatedActor, r: RefundWithPayment, input: { providerRef?: string; note?: string }, ctx: { gatewayCalled: boolean }): Promise<RefundDisbursement | null> {
    const amount = vnd(r.amount.toString());
    const manual = async (): Promise<RefundDisbursement> => {
      if (!input.providerRef) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Hoàn tiền tay cần mã tham chiếu chuyển khoản (providerRef)');
      await this.assertProviderRefFree(r.id, input.providerRef);
      return { providerRef: input.providerRef, raw: { manual: true }, meta: {} };
    };
    if (r.method !== 'gateway') return manual();

    if (r.payment.methodCode === METHOD.PAYOS || r.payment.methodCode === METHOD.COD) {
      const dest = resolvePayee(r, r.payment);
      // Lệnh chi trước đó đã THẤT BẠI (PayOS từ chối ngay / báo lỗi khi tra lại) hoặc không rõ kết quả (đã gọi cổng — needsReconcile) mà kế toán nhập providerRef ⇒ họ đã đối chiếu/chuyển tay:
      // ghi sổ như hoàn tay, KHÔNG gửi lệnh PayOS nữa (tránh chi trùng tay + PayOS, và không bỏ qua providerRef họ vừa nhập).
      const manualAfterFailure = Boolean(input.providerRef) && (r.gatewayStatus === GATEWAY_STATUS.FAILED || r.gatewayAttemptedAt !== null);
      if (dest && this.payos.isPayoutConfigured && !manualAfterFailure) return this.submitPayout(actor, r, dest, amount, ctx, input.note);
      if (!input.providerRef) {
        throw new BusinessException(
          PAYMENT_ERR.REFUND_MANUAL_REQUIRED,
          !dest ? 'Chưa có số tài khoản nhận hoàn (PayOS không trả tài khoản đối ứng, khách cũng chưa khai) — chuyển khoản tay rồi nhập mã tham chiếu (providerRef)' : 'PayOS payout chưa cấu hình — chuyển khoản tay rồi nhập mã tham chiếu (providerRef)',
        );
      }
      return manual(); // kế toán đã chuyển tay → ghi sổ như hoàn thủ công
    }
    // Refund lịch sử qua cổng đã bỏ (VNPay): không còn gọi cổng — kế toán đối chiếu/chuyển tay rồi nhập mã tham chiếu để ghi sổ.
    if (!input.providerRef) throw new BusinessException(PAYMENT_ERR.REFUND_MANUAL_REQUIRED, 'Cổng hoàn tiền này không còn hỗ trợ — chuyển khoản tay (hoặc đối chiếu trên cổng cũ) rồi nhập mã tham chiếu (providerRef)');
    await this.assertProviderRefFree(r.id, input.providerRef);
    return { providerRef: input.providerRef, raw: { manual: true, legacyGateway: r.payment.methodCode }, meta: { legacyGateway: r.payment.methodCode } };
  }

  /*
   * Gửi lệnh chi PayOS (NGOÀI transaction). PayOS "00" = ĐÃ NHẬN lệnh — tiền đi bất đồng bộ — nên chỉ ghi dấu "đã nhận" (gateway_payout_id, gateway_submitted_at) và GIỮ processing; ghi sổ do đối soát.
   * referenceId = idempotency-key: lệnh đầu = refund.id (gửi lại khi chưa rõ kết quả ⇒ PayOS trả đúng lệnh cũ, không chi đôi); chỉ khi lệnh trước bị PayOS báo thất bại hẳn (gateway_status = failed) mới dùng lệnh
   * mới `<refund.id>-<lần>`. PayOS từ chối ngay ⇒ failed, phân biệt hai loại (isDefiniteRejection):
   *  - TỪ CHỐI CHẮC CHẮN (PayOS trả lời lệnh không được tạo: HTTP 4xx / mã nghiệp vụ): gateway_status = failed + ghi lần đã dùng (gateway_attempt) + tài khoản bị từ chối (payee_source) ⇒ kế toán nhập providerRef thì ghi sổ TAY
   *    (không gửi PayOS lại); chạy lại không providerRef ⇒ lệnh MỚI `<id>-<lần>`, đổi sang tài khoản còn lại nếu có (resolvePayee).
   *  - KHÔNG RÕ KẾT QUẢ (mất kết nối/timeout, HTTP 5xx…): đặt gateway_attempted_at ⇒ needsReconcile; chạy lại dùng CÙNG khoá (PayOS trả đúng lệnh cũ, không chi đôi); nhập providerRef ⇒ ghi sổ tay (đã đối chiếu).
   * Số tài khoản đầy đủ chỉ nằm trong lời gọi PayOS, không vào log/audit.
   * `note` của kế toán được lưu ngay lúc PayOS nhận lệnh (lúc ghi sổ do job làm thì không còn đầu vào nào để mang theo).
   */
  private async submitPayout(actor: AuthenticatedActor, r: RefundWithPayment, dest: ResolvedPayee, amount: bigint, ctx: { gatewayCalled: boolean }, note?: string): Promise<null> {
    const attempt = r.gatewayStatus === GATEWAY_STATUS.FAILED ? r.gatewayAttempt + 1 : Math.max(r.gatewayAttempt, 1);
    const reference = attempt <= 1 ? r.id : `${r.id}-${attempt}`;
    ctx.gatewayCalled = true;
    let res: Awaited<ReturnType<PayosService['payout']>>;
    try {
      res = await this.payos.payout({ referenceId: reference, amount, toBin: dest.bankBin, toAccountNumber: dest.accountNumber, description: `Hoan tien don ${r.orderCode}`, idempotencyKey: reference });
    } catch (err) {
      res = { ok: false, code: '99', message: err instanceof Error ? err.message : 'Không gọi được cổng PayOS', raw: null };
    }
    if (!res.ok) {
      const definite = isDefiniteRejection(res);
      await this.failRefund(r, actor, `PayOS ${res.code}: ${res.message}`, res.raw, definite ? { gatewayStatus: GATEWAY_STATUS.FAILED, gatewayAttempt: attempt, payeeSource: dest.source } : { attemptedAt: new Date() });
      throw new BusinessException(PAYMENT_ERR.REFUND_FAILED, `Cổng PayOS từ chối hoàn tiền: ${res.message} (${res.code})`, HttpStatus.BAD_GATEWAY);
    }
    await this.recordGatewaySubmission(r, { payoutId: res.transactionId ?? null, attempt, source: dest.source, reference, note });
    return null;
  }

  /*
   * Ghi dấu "PayOS đã nhận lệnh" ngay sau khi PayOS trả 00 (compare-and-set dưới quyền chiếm; không đổi trạng thái nên không tăng version) + audit. Từ đây refund là "đã gửi lệnh, chờ chốt":
   * mọi đường phục hồi chỉ TRA KẾT QUẢ, không gửi lại. Ghi lỗi thì ném lên — chưa có dấu nên lượt phục hồi sau gửi lại với CÙNG khoá (an toàn nhờ idempotency).
   */
  private async recordGatewaySubmission(r: RefundWithPayment, v: { payoutId: string | null; attempt: number; source: string; reference: string; note?: string }): Promise<void> {
    const now = new Date();
    const won = await this.prisma.$transaction(async (tx) => {
      const res = await tx.refund.updateMany({
        where: { id: r.id, status: REFUND_STATUS.PROCESSING },
        data: { gatewayStatus: GATEWAY_STATUS.SUBMITTED, gatewayPayoutId: v.payoutId, gatewayAttempt: v.attempt, gatewaySubmittedAt: now, gatewayAlertedAt: null, gatewayAttemptedAt: null, payeeSource: v.source, ...(v.note ? { note: v.note.slice(0, 500) } : {}), updatedAt: now },
      });
      if (res.count === 0) return false;
      await this.audit(tx, null, { action: PAYMENT_AUDIT.REFUND_GATEWAY_SUBMITTED, entityType: 'refund', entityId: r.id, entityCode: r.orderCode, after: { payoutId: v.payoutId, attempt: v.attempt, reference: v.reference, payeeSource: v.source } });
      return true;
    });
    if (!won) this.logger.error({ refundId: r.id, payoutId: v.payoutId }, 'PayOS đã nhận lệnh hoàn tiền nhưng refund không còn ở processing — cần đối chiếu tay');
    else this.logger.log({ refundId: r.id, payoutId: v.payoutId, attempt: v.attempt }, 'PayOS đã nhận lệnh hoàn tiền — chờ đối soát kết quả');
  }

  /*
   * Ghi `provider_ref` ngay khi PayOS XÁC NHẬN đã chuyển (succeeded), TRƯỚC khi ghi sổ (compare-and-set dưới trạng thái processing; không đổi trạng thái nên không tăng version).
   * Từ đây tiền ĐÃ đi: mọi đường phục hồi chỉ ghi sổ, không tra/gọi lại cổng.
   */
  private async recordGatewayRef(refundId: string, providerRef: string): Promise<void> {
    const res = await this.prisma.refund.updateMany({ where: { id: refundId, status: REFUND_STATUS.PROCESSING }, data: { providerRef, gatewayStatus: GATEWAY_STATUS.SUCCEEDED, updatedAt: new Date() } });
    if (res.count === 0) this.logger.error({ refundId, providerRef }, 'PayOS xác nhận đã hoàn tiền nhưng refund không còn ở processing — cần đối chiếu tay');
    else this.logger.log({ refundId, providerRef }, 'PayOS xác nhận đã hoàn tiền — chờ ghi sổ');
  }

  /* Mã giao dịch hoàn tay phải DUY NHẤT: kiểm trước để báo lỗi đẹp (unique index một phần là chốt cuối — xem duplicateRefOrSame). */
  private async assertProviderRefFree(refundId: string, providerRef: string): Promise<void> {
    const dup = await this.prisma.refund.findFirst({ where: { providerRef, id: { not: refundId } }, select: { id: true } });
    if (dup) throw this.duplicateRefError();
  }

  private duplicateRefError(): BusinessException {
    return new BusinessException(PAYMENT_ERR.REFUND_PROVIDER_REF_DUPLICATE, 'Mã giao dịch này đã được dùng cho một khoản hoàn khác — kiểm tra lại mã chuyển khoản', HttpStatus.CONFLICT);
  }

  /* Vi phạm unique (P2002) khi ghi mã giao dịch hoàn tay ⇒ 409 REFUND_PROVIDER_REF_DUPLICATE (chạy đua hai người nhập cùng mã); lỗi khác giữ nguyên. */
  private duplicateRefOrSame(err: unknown): unknown {
    return isUniqueViolation(err) ? this.duplicateRefError() : err;
  }

  /*
   * GHI SỔ một refund mà tiền đã đi (PayOS xác nhận succeeded / kế toán chuyển tay / đối chiếu). MỘT transaction, KHOÁ dòng payment trước, rồi compare-and-set `processing → done` (ai đến sau
   * thấy đã done thì bỏ qua êm — request gốc, retry-finalize và job có chạy đồng thời cũng chỉ ghi sổ MỘT lần). Trả true nếu lần gọi này là lần ghi sổ.
   *  - kind = order: cập nhật payment + giao dịch + audit, báo order (onRefunded, markReturnRefunded) + outbox PAYMENT_REFUNDED + thông báo shop.
   *  - kind = duplicate_payment: chỉ trả tiền thừa — payment + giao dịch + audit + thông báo khách; KHÔNG đụng đơn (payment_status vẫn `paid` nhờ khoản kia), KHÔNG outbox hoàn theo đơn.
   * Thông báo ghi trong CÙNG tx (người thắng compare-and-set mới gửi ⇒ đúng một lần). Khách của hoàn theo đơn nhận thông báo "đã hoàn tiền" từ OrderPaymentGateway.onRefunded (order) — không gửi trùng ở đây.
   * `actor` null = hệ thống (job). `note` undefined = giữ ghi chú hiện có.
   */
  private async finalizeRefund(actor: RefundActor | null, r: RefundWithPayment, providerRef: string, raw: unknown, note: string | null | undefined, meta: Record<string, unknown>): Promise<boolean> {
    await this.assertRefundFinanceSafety(r.orderCode);
    const shopUserIds = r.kind === REFUND_KIND.ORDER && r.shopId ? await this.shopUserIds(r.shopId) : [];
    return retryOnDeadlock(() => this.finalizeRefundOnce(actor, r, providerRef, raw, note, meta, shopUserIds));
  }

  /* Một lần ghi sổ trong MỘT transaction — khoá ĐƠN trước payment (cùng thứ tự với huỷ/đổi trạng thái của order; AUD-01) rồi mới khoá payment. */
  private async finalizeRefundOnce(actor: RefundActor | null, r: RefundWithPayment, providerRef: string, raw: unknown, note: string | null | undefined, meta: Record<string, unknown>, shopUserIds: string[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (r.kind === REFUND_KIND.ORDER) await this.orders.lockOrder(r.orderCode, tx); // khoản trả trùng / tiền lệch không đụng đơn
      const head = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "payment"."payments" WHERE id = ${r.paymentId}::uuid FOR UPDATE`;
      const pay = head[0] ? await tx.payment.findUnique({ where: { id: r.paymentId } }) : null;
      if (!pay) throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không tìm thấy giao dịch');
      const won = await tx.refund.updateMany({
        where: { id: r.id, status: REFUND_STATUS.PROCESSING },
        data: {
          status: REFUND_STATUS.DONE,
          providerRef,
          needsManual: false,
          ...(providerRef.startsWith(GATEWAY_REF_PREFIX) ? { gatewayStatus: GATEWAY_STATUS.SUCCEEDED } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(actor ? { processedBy: actor.userId } : {}),
          processedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (won.count === 0) return false; // đã được ghi sổ (hoặc đổi trạng thái) bởi luồng khác
      const refunded = vnd(pay.refundedAmount.toString()) + vnd(r.amount.toString());
      const cap = PaymentService.refundCap(pay);
      if (refunded > cap) throw new BusinessException(PAYMENT_ERR.REFUND_EXCEEDS, 'Tổng hoàn vượt số đã thu — kiểm tra các yêu cầu hoàn khác của giao dịch này');
      // "Đã hoàn đủ ĐƠN" chỉ tính các khoản hoàn THEO ĐƠN: phần tiền thừa/trùng đã hoàn trả riêng (cùng payment) không được làm đơn nhìn như đã hoàn hết.
      const otherDone = r.kind === REFUND_KIND.ORDER ? await tx.refund.aggregate({ _sum: { amount: true }, where: { paymentId: r.paymentId, status: REFUND_STATUS.DONE, kind: { not: REFUND_KIND.ORDER } } }) : null;
      const full = r.kind === REFUND_KIND.ORDER ? refunded - vnd((otherDone?._sum.amount ?? 0).toString()) >= vnd(pay.amount.toString()) : refunded >= vnd(pay.amount.toString());
      // Hoàn phần lệch (mismatch) và hoàn khoản trùng CÙNG payment (received > amount) không đổi trạng thái thanh toán: payment vẫn là khoản thu hợp lệ của đơn (hoặc chưa từng thu).
      const keepStatus = r.kind === REFUND_KIND.MISMATCH || (r.kind === REFUND_KIND.DUPLICATE_PAYMENT && vnd(pay.receivedAmount.toString()) > vnd(pay.amount.toString()));
      await tx.payment.update({ where: { id: r.paymentId }, data: { refundedAmount: refunded.toString(), ...(keepStatus ? {} : { status: full ? PAY_STATUS.REFUNDED : PAY_STATUS.PARTIALLY_REFUNDED }), version: { increment: 1 } } });
      await tx.paymentTransaction.create({ data: { paymentId: r.paymentId, type: TX_TYPE.REFUND, status: 'ok', amount: r.amount, providerRef, rawResponse: (raw ?? { manual: true }) } });
      await this.audit(tx, actor, { action: PAYMENT_AUDIT.REFUND_PROCESSED, entityType: 'refund', entityId: r.id, entityCode: r.orderCode, after: { amount: r.amount.toString(), method: r.method, providerRef, kind: r.kind, ...meta } });
      if (r.kind !== REFUND_KIND.ORDER) {
        const title = r.kind === REFUND_KIND.MISMATCH ? `Đã hoàn phần tiền lệch đơn ${r.orderCode}` : `Đã hoàn khoản thanh toán trùng đơn ${r.orderCode}`;
        await this.notifier.notify({ userId: r.payment.userId, type: 'payment', title, content: `Số tiền ${money(r.amount.toString()).display} đã được hoàn lại cho bạn.`, link: `/account/orders/${r.orderCode}`, payload: { refundId: r.id } }, tx);
        return true;
      }
      if (r.payment.methodCode === METHOD.COD && r.payment.collectionMode !== 'carrier_cod' && r.shopId) await this.wallet.applyCodRefund(tx, { shopId: r.shopId, orderCode: r.orderCode, refundId: r.id, amount: vnd(r.amount.toString()) });
      await this.orders.onRefunded(r.orderCode, vnd(r.amount.toString()), r.id, tx, full);
      if (r.returnRequestId) await this.orders.markReturnRefunded(r.returnRequestId, tx);
      // payload mang refundId, phương thức, shop — đối soát chi trả shop trừ hoàn tiền theo refund `done` (cả đơn COD lẫn PayOS).
      await writeOutboxEvent(tx.paymentOutboxEvent, { eventType: PAYMENT_EVENT.REFUNDED, aggregateType: 'refund', aggregateId: r.id, payload: { refundId: r.id, orderCode: r.orderCode, userId: r.payment.userId, amount: r.amount.toString(), methodCode: r.payment.methodCode, shopId: r.shopId } });
      if (shopUserIds.length > 0) {
        await this.notifier.notifyMany(
          shopUserIds.map((userId) => ({ userId, type: 'payment', title: `Đã hoàn tiền cho khách — đơn ${r.orderCode}`, content: `${money(r.amount.toString()).display} đã được hoàn cho khách${r.returnRequestId ? ' (đổi trả)' : ''}.`, link: `/vendor/orders/${r.orderCode}`, payload: { refundId: r.id } })),
          tx,
        );
      }
      return true;
    });
  }

  /*
   * Lệnh hoàn tiền THẤT BẠI rõ ràng (tiền chưa đi): compare-and-set `processing → failed` + giao dịch lỗi + audit + báo kế toán — cho phép xử lý lại sau. Xoá dấu gọi cổng (VNPay cũ).
   * `opts.gatewayStatus` = 'failed' khi PayOS báo THẤT BẠI HẲN (đã nhận lệnh rồi báo lỗi khi tra lại, hoặc từ chối chắc chắn ngay lúc gửi) ⇒ lần chi sau là lệnh MỚI, kế toán nhập providerRef thì ghi sổ tay;
   * kèm `gatewayAttempt` (lần đã dùng, khi từ chối ngay) và `payeeSource` (tài khoản bị từ chối ⇒ lần sau thử tài khoản còn lại). `opts.attemptedAt` = KHÔNG RÕ kết quả (timeout…): đặt gateway_attempted_at (needsReconcile),
   * chạy lại dùng cùng khoá. `opts.onlySubmittedAt`: chỉ đánh failed khi refund còn đúng lượt gửi lệnh đã tra (chống đánh nhầm lệnh MỚI sau khi bị chiếm lại). Trả true nếu lần này là lần đánh failed.
   */
  private async failRefund(
    r: Pick<RefundWithPayment, 'id' | 'paymentId' | 'orderCode' | 'amount'>,
    actor: RefundActor | null,
    note: string,
    raw: unknown,
    opts: { gatewayStatus?: string; gatewayAttempt?: number; payeeSource?: string; attemptedAt?: Date; onlySubmittedAt?: Date | null } = {},
  ): Promise<boolean> {
    const accountants = await this.accountantIds();
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.refund.updateMany({
        where: { id: r.id, status: REFUND_STATUS.PROCESSING, ...(opts.onlySubmittedAt ? { gatewaySubmittedAt: opts.onlySubmittedAt } : {}) },
        data: {
          status: REFUND_STATUS.FAILED,
          note: note.slice(0, 500),
          gatewayAttemptedAt: opts.attemptedAt ?? null,
          ...(actor ? { processedBy: actor.userId } : {}),
          ...(opts.gatewayStatus ? { gatewayStatus: opts.gatewayStatus } : {}),
          ...(opts.gatewayAttempt !== undefined ? { gatewayAttempt: opts.gatewayAttempt } : {}),
          ...(opts.payeeSource ? { payeeSource: opts.payeeSource } : {}),
          processedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (res.count === 0) return false;
      await tx.paymentTransaction.create({ data: { paymentId: r.paymentId, type: TX_TYPE.REFUND, status: 'failed', amount: r.amount, rawResponse: (raw ?? {}) } });
      await this.audit(tx, actor, { action: PAYMENT_AUDIT.REFUND_FAILED, entityType: 'refund', entityId: r.id, entityCode: r.orderCode, after: { note: note.slice(0, 500), gatewayStatus: opts.gatewayStatus ?? null, needsReconcile: opts.attemptedAt !== undefined } });
      await this.notifyAccountants(tx, accountants, {
        title: `Hoàn tiền đơn ${r.orderCode} thất bại`,
        content: `${money(r.amount.toString()).display} — ${note.slice(0, 200)}. ${
          opts.attemptedAt
            ? 'Chưa rõ PayOS đã nhận lệnh hay chưa — đối chiếu trên bảng điều khiển PayOS: đã chuyển thì nhập mã giao dịch, chưa thì chạy lại (cùng khoá, không chi đôi).'
            : 'Mở màn Hoàn tiền để chạy lại hoặc chuyển khoản tay.'
        }`,
        payload: { refundId: r.id, orderCode: r.orderCode, ...(opts.attemptedAt ? { needsReconcile: true } : {}) },
      });
      return true;
    });
  }

  // ------------------------------------------------------------------ thông báo hoàn tiền

  /* Người nhận thông báo cho kế toán: nhân viên đang active có quyền hoàn tiền. Lỗi tra cứu không được làm hỏng nghiệp vụ tiền ⇒ nuốt + log, coi như không có người nhận. */
  private async accountantIds(): Promise<string[]> {
    try {
      return await this.users.staffUserIdsWithPermission(REFUND_PROCESS_PERMISSION);
    } catch (err) {
      this.logger.warn({ err }, 'Không tra được danh sách kế toán để gửi thông báo hoàn tiền');
      return [];
    }
  }

  /* Thành viên đang active của gian hàng — nhận thông báo "đã hoàn tiền cho khách". Lỗi tra cứu ⇒ nuốt + log. */
  private async shopUserIds(shopId: string): Promise<string[]> {
    try {
      return await this.shops.activeMemberUserIds(shopId);
    } catch (err) {
      this.logger.warn({ err, shopId }, 'Không tra được thành viên gian hàng để gửi thông báo hoàn tiền');
      return [];
    }
  }

  private async notifyAccountants(tx: Tx | undefined, userIds: string[], msg: { title: string; content: string; payload: Record<string, unknown> }): Promise<void> {
    if (userIds.length === 0) return;
    await this.notifier.notifyMany(userIds.map((userId) => ({ userId, type: 'payment', title: msg.title, content: msg.content, link: '/payment/refunds', payload: msg.payload })), tx);
  }

  // ------------------------------------------------------------------ đọc

  async extrasForOrder(orderCode: string): Promise<{ paymentUrl: string | null; linkRetryable: boolean; transactionCode: string | null; cardBrand: string | null; cardLast4: string | null }> {
    const p = await this.prisma.payment.findFirst({ where: { orderCode }, orderBy: { createdAt: 'desc' } });
    if (!p) return { paymentUrl: null, linkRetryable: false, transactionCode: null, cardBrand: null, cardLast4: null };
    const pending = p.status === PAY_STATUS.PENDING && (!p.expiresAt || p.expiresAt > new Date());
    const simulatedReal = pending && p.methodCode === METHOD.PAYOS && !this.payos.isMockEndpoint && (await this.orders.simulatedOrderCodes([orderCode])).size > 0;
    let paymentUrl: string | null = null;
    if (pending && p.methodCode === METHOD.PAYOS && !simulatedReal) {
      const t = await this.prisma.paymentTransaction.findFirst({ where: { paymentId: p.id, type: TX_TYPE.CREATE_URL }, orderBy: { createdAt: 'desc' }, select: { rawRequest: true } });
      paymentUrl = (t?.rawRequest as { checkoutUrl?: string } | null)?.checkoutUrl ?? null;
    }
    // Còn chờ trả mà chưa có link (tạo link lỗi / chưa kịp tạo) ⇒ FE hiện "Thanh toán lại" để gọi POST /payments/payos/retry/:code.
    const linkRetryable = pending && p.methodCode === METHOD.PAYOS && paymentUrl === null && !simulatedReal;
    return { paymentUrl, linkRetryable, transactionCode: p.transactionCode, cardBrand: p.cardBrand, cardLast4: p.cardLast4 };
  }

  async getPayment(id: string): Promise<PaymentResponse> {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không tìm thấy giao dịch');
    return PaymentService.toPayment(p);
  }

  async listPayments(page: number, size: number, f: { status?: string; methodCode?: string; q?: string; shopId?: string }): Promise<PageResponse<PaymentResponse>> {
    const where: Prisma.PaymentWhereInput = { ...(f.shopId ? { shopId: f.shopId } : {}), ...(f.status ? { status: f.status } : {}), ...(f.methodCode ? { methodCode: f.methodCode } : {}), ...(f.q ? { OR: [{ orderCode: { contains: f.q.toUpperCase() } }, { transactionCode: { contains: f.q } }] } : {}) };
    const [items, total] = await Promise.all([this.prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.payment.count({ where })]);
    return PageResponse.of(items.map((p) => PaymentService.toPayment(p)), page, size, total);
  }

  /*
   * Danh sách hoàn tiền cho kế toán (phân trang server, MỘT query dữ liệu + MỘT count; tài khoản đã trả tiền lấy kèm payment bằng include — không N+1). Lọc: status · shopId · `needsManual` = chờ chuyển tay
   * (chỉ giá trị true có tác dụng): chưa xong VÀ (cột needs_manual — thiếu tài khoản / không qua cổng / PayOS treo, hoặc chưa cấu hình khoá payout ⇒ mọi khoản requested|failed).
   */
  async listRefunds(page: number, size: number, f: { status?: string; shopId?: string; needsManual?: boolean } = {}): Promise<PageResponse<RefundResponse>> {
    const payoutOn = this.payos.isPayoutConfigured;
    const where: Prisma.RefundWhereInput = {
      ...(f.status ? { status: f.status } : {}),
      ...(f.shopId ? { shopId: f.shopId } : {}),
      ...(f.needsManual ? { AND: [{ status: { not: REFUND_STATUS.DONE } }, { OR: [{ needsManual: true }, ...(payoutOn ? [] : [{ status: { in: [REFUND_STATUS.REQUESTED, REFUND_STATUS.FAILED] } }])] }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.refund.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * size, take: size, include: REFUND_VIEW_INCLUDE }),
      this.prisma.refund.count({ where }),
    ]);
    const labels = await this.shopLabels(items.map((r) => r.shopId));
    return PageResponse.of(items.map((r) => this.toRefund(r, r.shopId ? labels.get(r.shopId) : undefined)), page, size, total);
  }

  /* Tên + mã gian hàng cho màn hoàn tiền của kế toán (không có quyền đọc shop). Lỗi tra cứu không làm hỏng danh sách. */
  private async shopLabels(shopIds: Array<string | null>): Promise<Map<string, { name: string; code: string }>> {
    const ids = [...new Set(shopIds.filter((x): x is string => x !== null))];
    if (ids.length === 0) return new Map();
    try {
      return new Map([...(await this.shops.findManyBrief(ids))].map(([id, b]) => [id, { name: b.name, code: b.code }]));
    } catch (err) {
      this.logger.warn({ err }, 'Không tra được tên gian hàng cho danh sách hoàn tiền');
      return new Map();
    }
  }

  /*
   * Kế toán xem SỐ TÀI KHOẢN ĐẦY ĐỦ của khoản hoàn để chuyển khoản tay (GET /admin/refunds/:id/payee, quyền payment.refund.process). Cùng quy tắc chọn tài khoản với lúc chi:
   * tài khoản ĐÃ TRẢ tiền → tài khoản khách khai. Chỉ khi refund còn mở (requested | processing | failed): đã `done` ⇒ 409 (số chỉ còn che 4 số cuối ở RefundResponse.payee); chưa có tài khoản nào ⇒ 404.
   * ĐÓNG-KHI-LỖI: audit REFUND_PAYEE_VIEWED (ai, refundId, orderCode, nguồn — KHÔNG có số tài khoản) ghi TRƯỚC khi trả; ghi audit lỗi ⇒ ném lỗi, không lộ số. Số tài khoản không vào log.
   */
  async revealPayee(actor: AuthenticatedActor, refundId: string): Promise<RefundPayeeRevealResponse> {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId }, include: REFUND_VIEW_INCLUDE });
    if (!r) throw new NotFoundException(PAYMENT_ERR.REFUND_NOT_FOUND, 'Không tìm thấy yêu cầu hoàn tiền');
    if (r.status === REFUND_STATUS.DONE) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Khoản hoàn đã hoàn xong — không còn xem số tài khoản đầy đủ', HttpStatus.CONFLICT);
    const dest = resolvePayee(r, r.payment);
    if (!dest) throw new NotFoundException(PAYMENT_ERR.REFUND_PAYEE_NOT_FOUND, 'Khoản hoàn chưa có tài khoản nhận (khách chưa khai, PayOS không trả tài khoản đối ứng)');
    await this.prisma.$transaction((tx) => this.audit(tx, actor, { action: PAYMENT_AUDIT.REFUND_PAYEE_VIEWED, entityType: 'refund', entityId: r.id, entityCode: r.orderCode, after: { source: dest.source, status: r.status } }));
    this.logger.log({ refundId: r.id, orderCode: r.orderCode, actorUserId: actor.userId, source: dest.source }, 'Kế toán xem tài khoản nhận hoàn');
    const bankName = dest.source === PAYEE_SOURCE.PAYER ? text((r.payment.gatewayResponse as Record<string, unknown> | null)?.counterAccountBankName) : null;
    return { bankBin: dest.bankBin, bankName, accountNumber: dest.accountNumber, accountName: dest.accountName, source: dest.source };
  }

  async getRefund(id: string): Promise<RefundResponse> {
    const r = await this.prisma.refund.findUnique({ where: { id }, include: REFUND_VIEW_INCLUDE });
    if (!r) throw new NotFoundException(PAYMENT_ERR.REFUND_NOT_FOUND, 'Không tìm thấy yêu cầu hoàn tiền');
    const labels = await this.shopLabels([r.shopId]);
    return this.toRefund(r, r.shopId ? labels.get(r.shopId) : undefined);
  }

  private static toPayment(p: { id: string; orderCode: string; methodCode: string; amount: Prisma.Decimal; status: string; transactionCode: string | null; bankCode: string | null; cardBrand: string | null; cardLast4: string | null; transferContent: string | null; refundedAmount: Prisma.Decimal; receivedAmount: Prisma.Decimal; paidAt: Date | null; expiresAt: Date | null; createdAt: Date }): PaymentResponse {
    return { id: p.id, orderCode: p.orderCode, methodCode: p.methodCode, amount: money(p.amount.toString()), status: p.status, transactionCode: p.transactionCode, bankCode: p.bankCode, cardBrand: p.cardBrand, cardLast4: p.cardLast4, transferContent: p.transferContent, refundedAmount: money(p.refundedAmount.toString()), receivedAmount: money(p.receivedAmount.toString()), paidAt: p.paidAt?.toISOString() ?? null, expiresAt: p.expiresAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString() };
  }

  /*
   * Response hoàn tiền cho kế toán (PLAN-0022 §4.6). Tài khoản nhận = tài khoản ĐÃ TRẢ tiền (ưu tiên) → tài khoản khách khai → none; số tài khoản CHỈ lộ 4 số cuối.
   * `needsManual` = chưa xong VÀ (cột needs_manual — thiếu tài khoản / không qua cổng / PayOS treo — hoặc đang chờ chi mà chưa tự chi được: thiếu tài khoản, không qua cổng, chưa cấu hình khoá payout).
   */
  private toRefund(r: RefundView, label?: { name: string; code: string }): RefundResponse {
    const effective = resolvePayee(r, r.payment); // đúng tài khoản sẽ dùng ở lần chi kế tiếp (có tính đổi tài khoản sau khi một tài khoản bị PayOS từ chối)
    const waitingToPay = r.status === REFUND_STATUS.REQUESTED || r.status === REFUND_STATUS.FAILED;
    const autoPossible = r.method === 'gateway' && effective !== null && this.payos.isPayoutConfigured;
    return {
      id: r.id,
      orderCode: r.orderCode,
      shopId: r.shopId,
      shopName: label?.name,
      shopCode: label?.code,
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
      returnRequestId: r.returnRequestId,
      payee: effective ? { bankBin: effective.bankBin, accountNumberMasked: maskAccountNumber(effective.accountNumber), accountName: effective.accountName } : null,
      payeeSource: effective ? effective.source : PAYEE_SOURCE.NONE,
      gatewayStatus: r.gatewayStatus,
      needsManual: r.status !== REFUND_STATUS.DONE && (r.needsManual || (waitingToPay && !autoPossible)),
    };
  }

  private audit(tx: Tx, actor: Pick<AuthenticatedActor, 'userId' | 'email'> | null, entry: AuditEntry): Promise<void> {
    return writeAuditLog(tx.paymentAuditLog, PAYMENT_MODULE, actor, entry);
  }

  publish(tx: Tx, input: OutboxEventInput): Promise<void> {
    return writeOutboxEvent(tx.paymentOutboxEvent, input);
  }

  /*
   * PLAN-0040 Tầng 3.6 (COD-08b) — xem PaymentGateway.reverseCodCollection. Đơn COD shop đã báo giao (payment `paid`, ví shop đã bị trừ hoa hồng) mà khách báo CHƯA NHẬN hàng: khách chưa trả tiền mặt nên KHÔNG hoàn tiền,
   * mà ĐẢO ghi thu: payment `paid` → `cancelled` + `reversed_at`, giao dịch `cod_reverse` (UNIQUE (type, provider_ref) ⇒ đảo đúng một lần), ví shop ghi dòng `cod_reversal` ngược dấu `cod_commission`.
   * Thứ tự khoá ĐƠN (caller đã khoá) → PAYMENT (đây) → ví (shop-wallet). Payment COD đã hoàn một phần/toàn phần ⇒ 409 (không đảo chồng lên sổ hoàn). Không có payment COD đã thu (đã đảo rồi / chưa thu / đơn PayOS) ⇒ { reversed: false }.
   */
  async reverseCodCollection(input: { orderCode: string; shopId: string; reason: string; actorUserId: string | null }, tx: Tx): Promise<{ reversed: boolean }> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM "payment"."payments" WHERE order_code = ${input.orderCode} AND method_code = 'cod' AND status IN ('paid', 'partially_refunded', 'refunded') FOR UPDATE`;
    const row = rows[0];
    if (!row) return { reversed: false };
    if (row.status !== PAY_STATUS.PAID) throw new BusinessException(PAYMENT_ERR.INVALID_STATE, 'Đơn COD này đã có khoản hoàn tiền — không đảo ghi thu được, hãy xử lý hoàn tiền theo đổi trả', HttpStatus.CONFLICT);
    const p = await tx.payment.findUniqueOrThrow({ where: { id: row.id } });
    if(p.collectionMode==='carrier_cod') throw new BusinessException('PAYMENT_COD_CARRIER_DISPUTE','COD hãng đã thu cần đối chiếu và hoàn theo chứng từ, không đảo ví cọc',409);
    const now = new Date();
    const reason = input.reason.trim().slice(0, 255);
    await tx.payment.update({ where: { id: p.id }, data: { status: PAY_STATUS.CANCELLED, reversedAt: now, updatedBy: input.actorUserId, version: { increment: 1 } } });
    await tx.paymentTransaction.create({ data: { paymentId: p.id, type: TX_TYPE.COD_REVERSE, status: 'ok', amount: p.amount, providerRef: `cod-reverse:${input.orderCode}`, rawRequest: { reason } } });
    const walletRow = await this.wallet.reverseCodCommission(tx, { shopId: input.shopId, orderCode: input.orderCode, reason });
    await this.audit(tx, input.actorUserId ? { userId: input.actorUserId, email: '' } : null, {
      action: PAYMENT_AUDIT.COD_REVERSED,
      entityType: 'payment',
      entityId: p.id,
      entityCode: input.orderCode,
      before: { status: PAY_STATUS.PAID },
      after: { status: PAY_STATUS.CANCELLED, reason, amount: p.amount.toString(), walletReversed: walletRow ? walletRow.reversedAmount.toString() : null },
    });
    return { reversed: true };
  }
}
