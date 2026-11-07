import { Injectable, Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { SETTING_KEY } from '../../system/enums/setting-keys';
import { SystemQueryApi } from '../../system/queryapi/system.queryapi';
import { OrderAuditLogService } from '../audit/order-audit-log.service';
import { ORDER_AUDIT, ORDER_ERR, ORDER_EVENT, ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, RETURN_ESCALATE_SOURCE, RETURN_REASON_LABEL, RETURN_REJECTED_BY, RETURN_STATUS, type ReturnReasonCode } from '../foundation/order.constants';
import { OrderRepository, OrderRow } from '../order/repository/order.repository';
import { OrderOutboxService } from '../outbox/order-outbox.service';
import { ReturnRequestResponse } from './dto/return.responses';
import { RETURN_INCLUDE } from './return.mapper';
import { snapshotRefund } from '../checkout/live-allocation';
import { boundedSetting, canCancel, canEscalate, normalizeEvidence, normalizeRefundAccount, proportionalRefund } from './return.rules';
import { ReturnCoreService } from './return-core.service';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface CreateReturnInput {
  reasonCode: string;
  reason?: string;
  detail?: string;
  items?: Array<{ orderItemId: string; quantity: number }>;
  evidence?: Array<{ type: string; url: string; name: string }>;
  refundAccount?: { bankBin: string; bankName?: string; accountNumber: string; accountName: string };
}

/*
 * Đổi trả phía KHÁCH (PLAN-0022): tạo yêu cầu (lý do chuẩn, minh chứng từ kho upload của hệ thống, tài khoản nhận hoàn với đơn COD), xem, rút khi chưa gửi hàng, báo đã gửi hàng trả,
 * khiếu nại lên sàn khi shop từ chối (trong hạn). Dữ liệu LUÔN lọc theo `userId` từ JWT (người khác ⇒ 404). Duyệt/từ chối/nhận hàng là việc của SHOP (ShopReturnService),
 * phân xử là việc của SÀN (AdminReturnService) — khách chỉ thấy kết quả + hạn của bước đang chờ.
 *
 * Transaction: mỗi use case ghi MỘT transaction: khoá yêu cầu (FOR UPDATE) → kiểm điều kiện → chuyển trạng thái (compare-and-set) + audit + thông báo (+ outbox khi đổi trạng thái).
 * Tạo yêu cầu khoá ĐƠN (cùng khoá với mọi thao tác đơn) rồi kiểm số lượng còn trả được trong tx — hai yêu cầu đồng thời cho cùng món không thể cùng qua.
 * `markRefunded` là hook của payment (cổng ngược): received → refunded, idempotent (compare-and-set).
 */
@Injectable()
export class ReturnService {
  private readonly logger = new Logger(ReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderRepository,
    private readonly audit: OrderAuditLogService,
    private readonly outbox: OrderOutboxService,
    private readonly system: SystemQueryApi,
    private readonly core: ReturnCoreService,
  ) {}

  /* Điều kiện thời gian/trạng thái theo lý do: `not_received` (đơn đang giao hoặc vừa báo đã giao ≤ return.not_received_days) · còn lại: đã giao trong return.window_days. */
  private assertCreatable(o: OrderRow, notReceived: boolean, windowDays: number, notReceivedDays: number): void {
    if (notReceived) {
      if (o.status === ORDER_STATUS.SHIPPING) return;
      if (o.status !== ORDER_STATUS.DELIVERED) throw new BusinessException(ORDER_ERR.RETURN_NOT_ALLOWED, 'Chỉ báo chưa nhận hàng được khi đơn đang giao hoặc vừa báo đã giao');
      if (!o.deliveredAt || Date.now() - o.deliveredAt.getTime() > notReceivedDays * DAY) throw new BusinessException(ORDER_ERR.RETURN_WINDOW_CLOSED, `Đã quá ${notReceivedDays} ngày kể từ khi đơn báo đã giao — không báo chưa nhận hàng được nữa`);
      return;
    }
    if (o.status !== ORDER_STATUS.DELIVERED && o.status !== ORDER_STATUS.COMPLETED) throw new BusinessException(ORDER_ERR.RETURN_NOT_ALLOWED, 'Chỉ đổi trả được đơn đã giao');
    if (!o.deliveredAt || Date.now() - o.deliveredAt.getTime() > windowDays * DAY) throw new BusinessException(ORDER_ERR.RETURN_WINDOW_CLOSED, `Đã quá ${windowDays} ngày kể từ khi nhận hàng`);
  }

  async create(actor: AuthenticatedActor, orderCode: string, input: CreateReturnInput): Promise<ReturnRequestResponse> {
    const reasonCode = input.reasonCode as ReturnReasonCode;
    const notReceived = reasonCode === 'not_received';
    // Kiểm hình dạng trước khi mở transaction (rẻ, không khoá gì).
    const evidence = normalizeEvidence(input.evidence, this.core.evidenceContext(), { required: !notReceived });
    // `not_received` LUÔN áp CẢ ĐƠN (bỏ qua `items` khách gửi): nếu cho báo một phần thì phần còn lại của đơn `shipping` sẽ không được hoàn khi đơn bị huỷ (huỷ chỉ hoàn khi đã thu đủ, chưa hoàn lần nào).
    const wanted = new Map<string, number>(); // gộp dòng trùng — (return, orderItem) là duy nhất
    if (!notReceived) for (const it of input.items ?? []) wanted.set(it.orderItemId, (wanted.get(it.orderItemId) ?? 0) + it.quantity);
    if (!notReceived && wanted.size === 0) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Chọn ít nhất một sản phẩm cần trả');
    const reason = input.reason?.trim() || (reasonCode === 'other' ? '' : RETURN_REASON_LABEL[reasonCode]);
    if (reason.length < 3) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Vui lòng nêu lý do đổi trả');
    const account = input.refundAccount ? normalizeRefundAccount(input.refundAccount) : null;
    const [windowDays, notReceivedRaw, respondRaw] = await Promise.all([this.system.settingNumber(SETTING_KEY.RETURN_WINDOW_DAYS), this.system.settingNumber(SETTING_KEY.RETURN_NOT_RECEIVED_DAYS), this.system.settingNumber(SETTING_KEY.RETURN_SHOP_RESPOND_HOURS)]);
    const notReceivedDays = boundedSetting(notReceivedRaw, 'days', 7); // PLAN-0031 §2.3: mặc định 7 ngày (trước đây 3)
    const respondHours = boundedSetting(respondRaw, 'hours', 72);

    const created = await this.prisma.$transaction(async (tx: Tx) => {
      const o = await this.orders.findByCodeForUpdate(orderCode, tx);
      if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      this.assertCreatable(o, notReceived, windowDays, notReceivedDays);
      // Đơn COD ĐÃ THU tiền mặt: khoản hoàn phải chuyển khoản ⇒ cần tài khoản nhận. PayOS dùng tài khoản đã trả (khai thêm thì lưu để dự phòng).
      const collected = o.paymentStatus === PAYMENT_STATUS.PAID || o.paymentStatus === PAYMENT_STATUS.PARTIALLY_REFUNDED;
      // COD-08b (PLAN-0031 §2.3): "chưa nhận hàng" trên đơn COD đã ghi thu KHÔNG đòi tài khoản nhận hoàn — khách chưa từng trả tiền mặt nên sẽ không có khoản hoàn (shop/sàn duyệt ⇒ đảo ghi thu COD).
      const codNotReceived = notReceived && o.paymentMethodCode === PAYMENT_METHOD.COD;
      if (o.paymentMethodCode === PAYMENT_METHOD.COD && collected && !account && !codNotReceived) throw new BusinessException(ORDER_ERR.RETURN_REFUND_ACCOUNT_REQUIRED, 'Đơn thanh toán khi nhận hàng cần khai tài khoản ngân hàng để nhận tiền hoàn');

      const used = await this.orders.returnedQtyByItem([o.id], tx); // đang mở / đã hoàn / bị shop từ chối còn hạn khiếu nại
      const asked = notReceived ? new Map(o.items.map((i) => [i.id, i.quantity])) : wanted;
      const rows = [];
      const priced: Array<{ unitPrice: bigint; quantity: number }> = [];
      let exactRefund=0n;let hasExact=true;
      for (const [orderItemId, quantity] of asked) {
        const oi = o.items.find((x) => x.id === orderItemId);
        if (!oi) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Dòng hàng không thuộc đơn này');
        const left = oi.quantity - (used.get(oi.id) ?? 0);
        if (quantity > left) {
          throw new BusinessException(
            ORDER_ERR.RETURN_NOT_ALLOWED,
            notReceived ? `${oi.name}: đã có yêu cầu đổi trả khác giữ ${oi.quantity - left}/${oi.quantity} sản phẩm — báo chưa nhận hàng phải áp cho CẢ ĐƠN, hãy xử lý hoặc rút yêu cầu kia trước` : `${oi.name}: chỉ còn ${left} có thể trả`,
          );
        }
        rows.push({ orderItemId: oi.id, variantId: oi.variantId, name: oi.name, color: oi.color, size: oi.size, quantity, imageUrl: oi.imageUrl, unitPrice: oi.unitPrice });
        priced.push({ unitPrice: vnd(oi.unitPrice.toString()), quantity });
        const exact=snapshotRefund(oi.discountAllocation,oi.quantity,used.get(oi.id)??0,quantity);
        if(exact===null)hasExact=false;else exactRefund+=exact;
      }
      const refund = hasExact ? exactRefund : proportionalRefund(priced, vnd(o.subtotal.toString()), vnd(o.total.toString()));
      const now = new Date();
      const r = await tx.returnRequest.create({
        data: {
          orderId: o.id,
          orderCode: o.code,
          userId: actor.userId,
          shopId: o.shopId,
          reasonCode,
          requireReturn: !notReceived,
          reason: reason.slice(0, 255),
          detail: input.detail?.trim() || null,
          refundAmount: refund.toString(),
          calculatedRefundAmount: refund.toString(),
          evidence,
          refundAccount: (codNotReceived ? null : account) ?? Prisma.DbNull, // đơn COD "chưa nhận hàng": không lưu tài khoản (không có khoản hoàn nào để chuyển)
          shopRespondDueAt: new Date(now.getTime() + respondHours * HOUR),
          items: { create: rows },
        },
        include: RETURN_INCLUDE,
      });
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_REQUESTED, entityType: 'return_request', entityId: r.id, entityCode: o.code, after: { reasonCode, reason: r.reason, items: rows.length, refund: refund.toString(), requireReturn: !notReceived, evidence: evidence.length, refundAccount: account && !codNotReceived ? 'khai' : null } });
      // Báo SHOP (người duyệt) — KHÔNG báo CSKH: sàn chỉ vào cuộc khi khiếu nại / shop quá hạn / hàng không khớp.
      await this.core.shopNote(tx, o.shopId, r.id, `Yêu cầu đổi trả đơn ${o.code}`, `${RETURN_REASON_LABEL[reasonCode]} — cần duyệt hoặc từ chối trong ${respondHours} giờ`);
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.RETURN_REQUESTED, aggregateType: 'return_request', aggregateId: r.id, payload: { orderCode: o.code, userId: actor.userId, shopId: o.shopId, returnId: r.id, reasonCode } });
      return r;
    });
    this.logger.log({ id: created.id, orderCode, reasonCode }, 'Khách đã gửi yêu cầu đổi trả');
    return this.core.respond(created, 'customer');
  }

  async mine(actor: AuthenticatedActor, page: number, size: number): Promise<PageResponse<ReturnRequestResponse>> {
    const where = { userId: actor.userId };
    const [items, total] = await Promise.all([this.prisma.returnRequest.findMany({ where, include: RETURN_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.returnRequest.count({ where })]);
    return PageResponse.of(await this.core.responses(items, 'customer'), page, size, total);
  }

  async getMine(actor: AuthenticatedActor, id: string): Promise<ReturnRequestResponse> {
    return this.core.respond(await this.core.find(id, { userId: actor.userId }), 'customer');
  }

  /* Khách báo ĐÃ GỬI hàng trả (mã vận đơn) — bắt đầu đồng hồ `return.shop_receive_days` của shop. Quá hạn gửi ⇒ 409 (job đã/sẽ chuyển `expired`). */
  async shipBack(actor: AuthenticatedActor, id: string, input: { carrier: string; trackingCode: string; note?: string }): Promise<ReturnRequestResponse> {
    const receiveDays = boundedSetting(await this.system.settingNumber(SETTING_KEY.RETURN_SHOP_RECEIVE_DAYS), 'days', 5);
    await this.prisma.$transaction(async (tx: Tx) => {
      const r = await this.core.lock(tx, id, { userId: actor.userId });
      if (r.status !== RETURN_STATUS.APPROVED || !r.requireReturn || r.shippedBackAt) throw new BusinessException(ORDER_ERR.RETURN_INVALID_STATE, 'Chỉ báo đã gửi hàng khi shop đã duyệt yêu cầu trả hàng và bạn chưa báo gửi', 409);
      const now = new Date();
      if (r.shipBackDueAt && now.getTime() > r.shipBackDueAt.getTime()) throw new BusinessException(ORDER_ERR.RETURN_DEADLINE_PASSED, 'Đã quá hạn gửi hàng trả — yêu cầu hết hiệu lực', 409);
      await this.core.move(tx, r, null, { carrier: input.carrier.trim(), trackingCode: input.trackingCode.trim(), shipBackNote: input.note?.trim() || null, shippedBackAt: now, shipBackDueAt: null, shopReceiveDueAt: new Date(now.getTime() + receiveDays * DAY) }, actor.userId);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_SHIPPED_BACK, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, after: { carrier: input.carrier.trim(), trackingCode: input.trackingCode.trim() } });
      await this.core.shopNote(tx, r.shopId, r.id, `Khách đã gửi hàng trả đơn ${r.orderCode}`, `${input.carrier.trim()} · mã vận đơn ${input.trackingCode.trim()} — vui lòng xác nhận khi nhận được hàng`);
    });
    return this.getMine(actor, id);
  }

  /* Khách rút yêu cầu khi CHƯA gửi hàng (đang chờ shop duyệt, hoặc đã duyệt nhưng chưa báo gửi). */
  async cancel(actor: AuthenticatedActor, id: string): Promise<ReturnRequestResponse> {
    await this.prisma.$transaction(async (tx: Tx) => {
      const r = await this.core.lock(tx, id, { userId: actor.userId });
      if (!canCancel(r)) throw new BusinessException(ORDER_ERR.RETURN_INVALID_STATE, 'Chỉ rút được yêu cầu khi bạn chưa gửi hàng trả', 409);
      await this.core.move(tx, r, RETURN_STATUS.CANCELLED, { closedAt: new Date(), shopRespondDueAt: null, shipBackDueAt: null }, actor.userId);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_CANCELLED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: r.status }, after: { status: RETURN_STATUS.CANCELLED } });
      await this.core.shopNote(tx, r.shopId, r.id, `Khách đã rút yêu cầu đổi trả đơn ${r.orderCode}`);
    });
    return this.getMine(actor, id);
  }

  /* Khiếu nại lên sàn: CHỈ khi SHOP từ chối và còn trong hạn `return.escalate_days`; sàn từ chối rồi là quyết định cuối. */
  async escalate(actor: AuthenticatedActor, id: string, reason: string): Promise<ReturnRequestResponse> {
    await this.prisma.$transaction(async (tx: Tx) => {
      const r = await this.core.lock(tx, id, { userId: actor.userId });
      if (r.status !== RETURN_STATUS.REJECTED || r.rejectedBy !== RETURN_REJECTED_BY.SHOP) throw new BusinessException(ORDER_ERR.RETURN_INVALID_STATE, 'Chỉ khiếu nại được khi shop đã từ chối yêu cầu', 409);
      if (!canEscalate(r, new Date())) throw new BusinessException(ORDER_ERR.RETURN_DEADLINE_PASSED, 'Đã quá hạn khiếu nại yêu cầu đổi trả này', 409);
      await this.core.escalate(tx, r, { source: RETURN_ESCALATE_SOURCE.CUSTOMER, reason: reason.trim(), actor });
    });
    return this.getMine(actor, id);
  }

  /*
   * payment báo khoản hoàn của yêu cầu đã chi xong (cổng ngược, trong tx của payment) → received → refunded. Idempotent: compare-and-set `status = received`, gọi lại/yêu cầu ở trạng thái
   * khác thì bỏ qua êm. Thông báo "đã hoàn tiền" do chỗ khác lo (khách: `onRefunded` của đơn; shop: payment) nên ở đây KHÔNG báo thêm — chỉ audit + outbox đổi trạng thái.
   */
  async markRefunded(returnRequestId: string, tx: Tx): Promise<void> {
    const r = await tx.returnRequest.findUnique({ where: { id: returnRequestId }, select: { id: true, orderCode: true, userId: true, shopId: true, status: true } });
    if (!r) return;
    const won = await tx.returnRequest.updateMany({ where: { id: r.id, status: RETURN_STATUS.RECEIVED }, data: { status: RETURN_STATUS.REFUNDED, refundedAt: new Date(), version: { increment: 1 } } });
    if (won.count === 0) return;
    await this.audit.write(tx, null, { action: ORDER_AUDIT.RETURN_REFUNDED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: RETURN_STATUS.RECEIVED }, after: { status: RETURN_STATUS.REFUNDED } });
    await this.outbox.publish(tx, { eventType: ORDER_EVENT.RETURN_STATUS_CHANGED, aggregateType: 'return_request', aggregateId: r.id, payload: { returnId: r.id, orderCode: r.orderCode, userId: r.userId, shopId: r.shopId, from: RETURN_STATUS.RECEIVED, to: RETURN_STATUS.REFUNDED } });
  }
}
