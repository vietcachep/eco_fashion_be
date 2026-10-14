import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { INVENTORY_GATEWAY, InventoryGateway } from '@common/gateway/inventory.gateway';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from '@common/gateway/payment.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import { money } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { SETTING_KEY } from '../../system/enums/setting-keys';
import { SystemQueryApi } from '../../system/queryapi/system.queryapi';
import { OrderAuditLogService } from '../audit/order-audit-log.service';
import { ORDER_AUDIT, ORDER_ERR, ORDER_EVENT, ORDER_STATUS, PAYMENT_STATUS, RETURN_STATUS } from '../foundation/order.constants';
import { ReturnRequestResponse } from '../order/dto/order.responses';
import { toReturnResponse } from '../order/mapper/order.mapper';
import { OrderRepository } from '../order/repository/order.repository';
import { OrderOutboxService } from '../outbox/order-outbox.service';

const RETURN_INCLUDE = { items: true } as const;

/*
 * Đổi trả (PLAN-0006): khách gửi yêu cầu cho đơn đã giao trong hạn (setting return.window_days), minh chứng ≥ 1;
 * nhân viên (order.return.process) duyệt → hoàn tiền qua PaymentGateway + hàng về kho (restock) + đơn → returned nếu trả hết;
 * hoặc từ chối (có lý do). Mỗi dòng đơn chỉ được yêu cầu trả tối đa số lượng đã mua (trừ các yêu cầu đang mở/đã duyệt).
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
    @Inject(INVENTORY_GATEWAY) private readonly inventory: InventoryGateway,
    @Inject(PAYMENT_GATEWAY) private readonly payment: PaymentGateway,
    @Inject(NOTIFICATION_GATEWAY) private readonly notify: NotificationGateway,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
  ) {}

  async create(actor: AuthenticatedActor, orderCode: string, input: { reason: string; detail?: string; items: Array<{ orderItemId: string; quantity: number }>; evidence: Array<{ type: string; url: string; name: string }> }): Promise<ReturnRequestResponse> {
    if (input.evidence.length === 0) throw new BusinessException(ORDER_ERR.EVIDENCE_REQUIRED, 'Cần ít nhất một ảnh/video minh chứng');
    const created = await this.prisma.$transaction(async (tx) => {
      const o = await this.orders.findByCodeForUpdate(orderCode, tx);
      if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.status !== ORDER_STATUS.DELIVERED && o.status !== ORDER_STATUS.COMPLETED) throw new BusinessException(ORDER_ERR.RETURN_NOT_ALLOWED, 'Chỉ đổi trả được đơn đã giao');
      const days = await this.system.settingNumber(SETTING_KEY.RETURN_WINDOW_DAYS);
      if (!o.deliveredAt || Date.now() - o.deliveredAt.getTime() > days * 86_400_000) throw new BusinessException(ORDER_ERR.RETURN_WINDOW_CLOSED, `Đã quá ${days} ngày kể từ khi nhận hàng`);
      // số lượng đã yêu cầu (đang mở / đã duyệt) theo dòng
      const open = await tx.returnRequestItem.groupBy({ by: ['orderItemId'], where: { request: { orderId: o.id, status: { in: [RETURN_STATUS.REQUESTED, RETURN_STATUS.APPROVED, RETURN_STATUS.REFUNDED] } } }, _sum: { quantity: true } });
      const used = new Map(open.map((g) => [g.orderItemId, g._sum.quantity ?? 0]));
      const rows = [];
      let refund = 0n;
      for (const it of input.items) {
        const oi = o.items.find((x) => x.id === it.orderItemId);
        if (!oi) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Dòng hàng không thuộc đơn này');
        if (it.quantity > oi.quantity - (used.get(oi.id) ?? 0)) throw new BusinessException(ORDER_ERR.RETURN_NOT_ALLOWED, `${oi.name}: chỉ còn ${oi.quantity - (used.get(oi.id) ?? 0)} có thể trả`);
        rows.push({ orderItemId: oi.id, variantId: oi.variantId, name: oi.name, color: oi.color, size: oi.size, quantity: it.quantity, imageUrl: oi.imageUrl, unitPrice: oi.unitPrice });
        refund += vnd(oi.unitPrice.toString()) * BigInt(it.quantity);
      }
      // Hoàn theo TỈ LỆ hàng trả trên tổng tiền khách ĐÃ TRẢ (gồm phí ship, đã trừ mọi voucher): hoàn đủ ⇒ đúng bằng `total`. Cách cũ (trừ discount/subtotal) hoàn thiếu
      // khi có voucher freeship (discount gồm cả phần ship nhưng chia cho subtotal không gồm ship) và lệch với đối soát (đảo doanh thu theo tỉ lệ trên total).
      const subtotal = vnd(o.subtotal.toString());
      const total = vnd(o.total.toString());
      if (subtotal > 0n) refund = (refund * total) / subtotal;
      if (refund > total) refund = total;
      const r = await tx.returnRequest.create({
        data: {
          orderId: o.id,
          orderCode: o.code,
          userId: actor.userId,
          reason: input.reason.trim(),
          detail: input.detail?.trim() || null,
          refundAmount: refund.toString(),
          evidence: input.evidence,
          items: { create: rows },
        },
        include: RETURN_INCLUDE,
      });
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_REQUESTED, entityType: 'return_request', entityId: r.id, entityCode: o.code, after: { reason: r.reason, items: rows.length, refund: refund.toString() } });
      const staff = await this.users.staffUserIdsWithPermission('order.return.process');
      await this.notify.notifyMany(staff.map((userId) => ({ userId, type: 'order', title: `Yêu cầu đổi trả đơn ${o.code}`, content: input.reason, link: `/returns/${r.id}` })), tx);
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.RETURN_REQUESTED, aggregateType: 'return_request', aggregateId: r.id, payload: { orderCode: o.code, userId: actor.userId, returnId: r.id } });
      return r;
    });
    return toReturnResponse(created);
  }

  async mine(actor: AuthenticatedActor, page: number, size: number): Promise<PageResponse<ReturnRequestResponse>> {
    const where = { userId: actor.userId };
    const [items, total] = await Promise.all([this.prisma.returnRequest.findMany({ where, include: RETURN_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.returnRequest.count({ where })]);
    return PageResponse.of(items.map(toReturnResponse), page, size, total);
  }

  async listAdmin(page: number, size: number, status?: string): Promise<PageResponse<ReturnRequestResponse>> {
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([this.prisma.returnRequest.findMany({ where, include: RETURN_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.returnRequest.count({ where })]);
    return PageResponse.of(items.map(toReturnResponse), page, size, total);
  }

  async getAdmin(id: string): Promise<ReturnRequestResponse> {
    const r = await this.prisma.returnRequest.findUnique({ where: { id }, include: RETURN_INCLUDE });
    if (!r) throw new NotFoundException(ORDER_ERR.RETURN_NOT_FOUND, 'Không tìm thấy yêu cầu đổi trả');
    return toReturnResponse(r);
  }

  /* Duyệt: hoàn tiền (gateway) + hàng về kho + đơn → returned nếu trả hết; từ chối: cần lý do. */
  async process(actor: AuthenticatedActor, id: string, decision: 'approved' | 'rejected', opts: { rejectReason?: string; refundAmount?: string }): Promise<ReturnRequestResponse> {
    await this.prisma.$transaction(async (tx) => {
      const head = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "order"."return_requests" WHERE id = ${id}::uuid FOR UPDATE`;
      const r = head[0] ? await tx.returnRequest.findUnique({ where: { id }, include: RETURN_INCLUDE }) : null;
      if (!r) throw new NotFoundException(ORDER_ERR.RETURN_NOT_FOUND, 'Không tìm thấy yêu cầu đổi trả');
      if (r.status !== RETURN_STATUS.REQUESTED) throw new BusinessException(ORDER_ERR.RETURN_INVALID_STATE, 'Yêu cầu đã được xử lý');
      const o = await this.orders.findByCodeForUpdate(r.orderCode, tx);
      if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (decision === 'rejected') {
        if (!opts.rejectReason) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Cần lý do từ chối');
        await tx.returnRequest.update({ where: { id }, data: { status: RETURN_STATUS.REJECTED, rejectReason: opts.rejectReason, processedBy: actor.userId, processedAt: new Date(), updatedBy: actor.userId, version: { increment: 1 } } });
        await this.notify.notify({ userId: r.userId, type: 'order', title: `Yêu cầu đổi trả đơn ${r.orderCode} bị từ chối`, content: opts.rejectReason, link: `/account/returns` }, tx);
      } else {
        const amount = opts.refundAmount ? vnd(opts.refundAmount) : vnd(r.refundAmount.toString());
        if (amount > vnd(o.total.toString())) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Số tiền hoàn vượt tổng đơn');
        await this.inventory.restock(r.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), { type: 'return', id: r.orderCode }, tx);
        let status: string = RETURN_STATUS.APPROVED;
        if (o.paymentStatus === PAYMENT_STATUS.PAID || o.paymentStatus === PAYMENT_STATUS.PARTIALLY_REFUNDED) {
          await this.payment.requestRefund({ orderCode: r.orderCode, shopId: o.shopId, amount, reason: `Đổi trả: ${r.reason}`, returnRequestId: r.id, actorUserId: actor.userId }, tx);
        } else {
          status = RETURN_STATUS.REFUNDED; // chưa thu tiền (COD chưa giao?) — coi như xong
        }
        await tx.returnRequest.update({ where: { id }, data: { status, refundAmount: amount.toString(), processedBy: actor.userId, processedAt: new Date(), updatedBy: actor.userId, version: { increment: 1 } } });
        const returnedQty = r.items.reduce((n, i) => n + i.quantity, 0);
        if (returnedQty >= o.itemCount) {
          await this.orders.update(o.id, { status: ORDER_STATUS.RETURNED, updatedBy: actor.userId }, tx);
          await this.orders.addHistory(o.id, o.status, ORDER_STATUS.RETURNED, `Đổi trả được duyệt — hoàn ${money(amount).display}`, actor.userId, tx);
        } else {
          await this.orders.addHistory(o.id, o.status, o.status, `Đổi trả một phần được duyệt — hoàn ${money(amount).display}`, actor.userId, tx);
        }
        await this.notify.notify({ userId: r.userId, type: 'order', title: `Đổi trả đơn ${r.orderCode} được duyệt`, content: `Hoàn ${money(amount).display}. Vui lòng gửi hàng về theo hướng dẫn.`, link: `/account/returns` }, tx);
      }
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_PROCESSED, entityType: 'return_request', entityId: id, entityCode: r.orderCode, after: { decision, rejectReason: opts.rejectReason ?? null, refundAmount: opts.refundAmount ?? r.refundAmount.toString() } });
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.RETURN_PROCESSED, aggregateType: 'return_request', aggregateId: id, payload: { orderCode: r.orderCode, userId: r.userId, decision } });
    });
    this.logger.log({ id, decision, by: actor.userId }, 'Đã xử lý yêu cầu đổi trả');
    return this.getAdmin(id);
  }

  /* payment báo hoàn xong → yêu cầu trả sang refunded. */
  async markRefunded(returnRequestId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.returnRequest.updateMany({ where: { id: returnRequestId, status: RETURN_STATUS.APPROVED }, data: { status: RETURN_STATUS.REFUNDED, refundedAt: new Date() } });
  }
}
