import { Injectable, Logger } from '@nestjs/common';
import { BusinessException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import { money } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { OrderAuditLogService } from '../audit/order-audit-log.service';
import { ORDER_AUDIT, ORDER_ERR, RETURN_RECEIVED_CONDITION, RETURN_REFUNDED_STATUSES, RETURN_REJECTED_BY, RETURN_RESOLVE_DECISION, RETURN_STATUS } from '../foundation/order.constants';
import { ReturnRequestResponse } from './dto/return.responses';
import { RETURN_INCLUDE } from './return.mapper';
import { ReturnCoreService } from './return-core.service';

/*
 * Đổi trả phía SÀN (PLAN-0022): nhân viên sàn XEM (order.return.read) và PHÂN XỬ (order.return.process) — CHỈ yêu cầu đã chuyển lên sàn (`escalated`: khách khiếu nại shop từ chối,
 * shop quá hạn duyệt / nhận hàng, shop báo hàng không khớp). Sàn không duyệt/từ chối thay shop khi shop còn trong hạn.
 *
 * resolve = MỘT transaction: khoá yêu cầu (FOR UPDATE) → kiểm đang `escalated` → (hoàn tiền) khoá đơn, kiểm trần số tiền, nhập kho CHỈ khi shop đã nhận hàng (`receivedAt`) và hàng KHÔNG bị báo không khớp, yêu cầu hoàn
 * qua payment, đơn → returned nếu trả hết; hoặc (từ chối lần cuối) rejected do sàn — khách không khiếu nại lại. `note` bắt buộc, khách + shop đều thấy. Có audit; thông báo khách + shop.
 */
@Injectable()
export class AdminReturnService {
  private readonly logger = new Logger(AdminReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OrderAuditLogService,
    private readonly core: ReturnCoreService,
  ) {}

  async list(page: number, size: number, status?: string, shopId?: string): Promise<PageResponse<ReturnRequestResponse>> {
    const where: Prisma.ReturnRequestWhereInput = { ...(status ? { status } : {}), ...(shopId ? { shopId } : {}) };
    const [items, total] = await Promise.all([this.prisma.returnRequest.findMany({ where, include: RETURN_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.returnRequest.count({ where })]);
    return PageResponse.of(await this.core.responses(items, 'admin'), page, size, total);
  }

  async get(id: string): Promise<ReturnRequestResponse> {
    return this.core.respond(await this.core.find(id), 'admin');
  }

  async resolve(actor: AuthenticatedActor, id: string, input: { decision: string; note: string; refundAmount?: string }): Promise<ReturnRequestResponse> {
    const note = input.note.trim();
    if (note.length < 5) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Cần ghi chú phân xử (từ 5 ký tự) — khách và shop đều thấy');
    if (input.decision === RETURN_RESOLVE_DECISION.REJECT && input.refundAmount !== undefined) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Từ chối thì không có số tiền hoàn');
    await this.prisma.$transaction(async (tx: Tx) => {
      const r = await this.core.lock(tx, id);
      if (r.status !== RETURN_STATUS.ESCALATED) throw new BusinessException(ORDER_ERR.RETURN_INVALID_STATE, 'Chỉ phân xử được yêu cầu đã chuyển lên sàn', 409);
      const now = new Date();
      const resolved = { resolvedAt: now, resolvedBy: actor.userId, resolveDecision: input.decision, resolveNote: note.slice(0, 500), processedBy: r.processedBy ?? actor.userId, processedAt: r.processedAt ?? now, escalateDueAt: null };

      if (input.decision === RETURN_RESOLVE_DECISION.REJECT) {
        await this.core.move(tx, r, RETURN_STATUS.REJECTED, { ...resolved, rejectedBy: RETURN_REJECTED_BY.PLATFORM, rejectedAt: now, closedAt: now }, actor.userId);
        await this.core.customerNote(tx, r, `Sàn đã xem xét yêu cầu đổi trả đơn ${r.orderCode}`, `Yêu cầu bị từ chối. ${note}`);
        await this.core.shopNote(tx, r.shopId, r.id, `Sàn đã phân xử đổi trả đơn ${r.orderCode}`, `Từ chối yêu cầu của khách. ${note}`);
        await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_RESOLVED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: r.status }, after: { decision: 'reject', note: note.slice(0, 200), shopId: r.shopId } });
        return;
      }

      const o = await this.core.lockOrder(tx, r);
      if (this.core.isCodReversal(r, o)) {
        // COD-08b (PLAN-0031 §2.3, đường CSKH phân xử): đơn COD shop đã báo giao + khách báo chưa nhận ⇒ khách CHƯA từng trả tiền mặt ⇒ "hoàn" = ĐẢO ghi thu (payment về chưa thu, ví shop được trả lại hoa hồng/voucher sàn),
        // KHÔNG tạo hoàn tiền, `refundAmount` (nếu CSKH nhập) bị bỏ qua. Không nhập kho (hàng chưa từng tới tay khách / thất lạc).
        const reversed = await this.core.reverseCod(tx, r, o, { actor, reason: r.reason, suffix: ' (sàn phân xử)' });
        await this.core.move(tx, r, reversed, { ...resolved, refundAmount: '0', adjustReason: 'Đơn COD chưa thu tiền của khách — đảo ghi thu, không hoàn tiền', refundedAt: now }, actor.userId);
        await this.core.afterRefund(tx, o, { actor, amount: 0n, label: 'Sàn phân xử đổi trả (COD, khách chưa nhận hàng)', reversed: true });
        await this.core.customerNote(tx, r, `Sàn đã phân xử yêu cầu chưa nhận hàng đơn ${r.orderCode}`, `Sàn đồng ý với bạn. Đây là đơn thanh toán khi nhận hàng nên bạn chưa phải trả khoản nào — đơn đã được huỷ, không có khoản hoàn tiền. ${note}`);
        await this.core.shopNote(tx, r.shopId, r.id, `Sàn đã phân xử đổi trả đơn ${r.orderCode}`, `Đồng ý với khách (chưa nhận hàng). Ghi thu COD của đơn được đảo: hoa hồng đã trừ được trả lại ví. ${note}`);
        await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_RESOLVED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: r.status, refundAmount: r.refundAmount.toString() }, after: { decision: 'refund', refundAmount: '0', codReversed: true, ignoredRefundAmount: input.refundAmount ?? null, note: note.slice(0, 200), shopId: r.shopId } });
        return;
      }
      // Trần: tổng đơn − số đã hoàn ở các yêu cầu KHÁC của đơn (received/refunded). Payment còn kiểm tiếp theo số đã thu thật.
      const others = await tx.returnRequest.aggregate({ _sum: { refundAmount: true }, where: { orderId: o.id, id: { not: r.id }, status: { in: [...RETURN_REFUNDED_STATUSES] } } });
      const cap = vnd(o.total.toString()) - vnd((others._sum.refundAmount ?? 0).toString());
      const current = vnd(r.refundAmount.toString());
      const amount = input.refundAmount === undefined ? current : vnd(input.refundAmount);
      if (amount <= 0n || amount > cap) throw new BusinessException(ORDER_ERR.RETURN_REFUND_TOO_HIGH, `Số tiền hoàn phải từ 1 đến ${money(cap).display} (tổng đơn trừ phần đã hoàn)`);
      // Nhập kho CHỈ khi shop đã nhận hàng VÀ hàng không bị báo "không khớp": hàng không khớp/hỏng KHÔNG được cộng vào tồn bán được (sai mã, hư hỏng, đã dùng…);
      // chưa nhận hàng (shop quá hạn, khách khiếu nại, không cần trả hàng) thì hàng cũng không nằm trong kho shop. Shop tự xử lý hàng không khớp ngoài hệ thống.
      const restock = r.requireReturn && r.receivedAt !== null && r.receivedCondition !== RETURN_RECEIVED_CONDITION.NOT_MATCHING;
      const next = await this.core.settleRefund(tx, r, o, { actor, restock, amount, reason: r.reason, suffix: ' (sàn phân xử)' });
      await this.core.move(tx, r, next, { ...resolved, refundAmount: amount.toString(), adjustReason: amount === current ? r.adjustReason : note.slice(0, 500), ...(next === RETURN_STATUS.REFUNDED ? { refundedAt: now } : {}) }, actor.userId);
      await this.core.afterRefund(tx, o, { actor, amount, label: 'Sàn phân xử đổi trả' });
      await this.core.customerNote(tx, r, `Sàn đã phân xử yêu cầu đổi trả đơn ${r.orderCode}`, `Sàn đồng ý hoàn ${money(amount).display}. ${note}`);
      await this.core.shopNote(tx, r.shopId, r.id, `Sàn đã phân xử đổi trả đơn ${r.orderCode}`, `Hoàn ${money(amount).display} cho khách. ${note}`);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_RESOLVED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: r.status, refundAmount: current.toString() }, after: { decision: 'refund', refundAmount: amount.toString(), restock, note: note.slice(0, 200), shopId: r.shopId } });
    });
    this.logger.log({ id, decision: input.decision, by: actor.userId }, 'Sàn đã phân xử yêu cầu đổi trả');
    return this.get(id);
  }
}
