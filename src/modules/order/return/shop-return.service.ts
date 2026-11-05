import { Injectable, Logger } from '@nestjs/common';
import { BusinessException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import { money } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { SETTING_KEY } from '../../system/enums/setting-keys';
import { SystemQueryApi } from '../../system/queryapi/system.queryapi';
import { OrderAuditLogService } from '../audit/order-audit-log.service';
import { ORDER_AUDIT, ORDER_ERR, RETURN_ESCALATE_SOURCE, RETURN_RECEIVED_CONDITION, RETURN_REJECTED_BY, RETURN_STATUS } from '../foundation/order.constants';
import { ReturnRequestResponse, ShopReturnRequestResponse } from './dto/return.responses';
import { RETURN_INCLUDE } from './return.mapper';
import { boundedSetting, normalizeEvidence, resolveShopRefundAmount, type ReturnAddress } from './return.rules';
import { ReturnCoreService } from './return-core.service';

const DAY = 86_400_000;

type MediaInput = Array<{ type: string; url: string; name: string }>;

/*
 * Đổi trả phía SHOP (PLAN-0022): shop là bên DUYỆT / TỪ CHỐI / XÁC NHẬN ĐÃ NHẬN LẠI HÀNG — sàn không làm thay (chỉ phân xử khi khiếu nại hoặc shop quá hạn).
 * `shopId` CHỈ đến từ ngữ cảnh phiên (ShopContextGuard), không từ URL/body: yêu cầu của shop khác ⇒ 404 (không lộ sự tồn tại). Response là whitelist riêng của shop:
 * không có tài khoản nhận hoàn của khách (refundAccount = null), không có id nhân viên sàn.
 *
 * Mỗi use case ghi = MỘT transaction: khoá yêu cầu FOR UPDATE (rồi khoá đơn nếu phát sinh tiền/kho) → kiểm trạng thái → chuyển trạng thái (compare-and-set) → audit → thông báo.
 *  - approve: cần trả hàng ⇒ `approved` (+ địa chỉ gửi trả, hạn khách gửi); `not_received` ⇒ hoàn tiền NGAY, không nhập kho. Số tiền hoàn chỉ được GIẢM và phải nêu lý do.
 *  - reject: lý do ≥ 10 ký tự (+ minh chứng); mở hạn khiếu nại của khách.
 *  - receive: `ok` ⇒ nhập kho + yêu cầu hoàn tiền (payment) + đơn → returned nếu trả hết, tất cả CÙNG tx; `not_matching` ⇒ chuyển sàn phân xử.
 */
@Injectable()
export class ShopReturnService {
  private readonly logger = new Logger(ShopReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OrderAuditLogService,
    private readonly system: SystemQueryApi,
    private readonly core: ReturnCoreService,
  ) {}

  async list(shopId: string, status: string | undefined, page: number, size: number): Promise<PageResponse<ReturnRequestResponse>> {
    const where: Prisma.ReturnRequestWhereInput = { shopId, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([this.prisma.returnRequest.findMany({ where, include: RETURN_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.returnRequest.count({ where })]);
    return PageResponse.of(await this.core.responses(items, 'shop'), page, size, total);
  }

  async get(shopId: string, id: string): Promise<ShopReturnRequestResponse> {
    const [res, suggested] = await Promise.all([this.core.find(id, { shopId }).then((r) => this.core.respond(r, 'shop')), this.core.lastReturnAddress(shopId)]);
    return { ...res, suggestedReturnAddress: suggested };
  }

  async approve(actor: AuthenticatedActor, shopId: string, id: string, input: { refundAmount?: string; adjustReason?: string; returnAddress?: ReturnAddress }): Promise<ShopReturnRequestResponse> {
    const shipBackDays = boundedSetting(await this.system.settingNumber(SETTING_KEY.RETURN_SHIP_BACK_DAYS), 'days', 7);
    await this.prisma.$transaction(async (tx: Tx) => {
      const r = await this.core.lock(tx, id, { shopId });
      if (r.status !== RETURN_STATUS.REQUESTED) throw new BusinessException(ORDER_ERR.RETURN_INVALID_STATE, 'Yêu cầu đã được xử lý', 409);
      const { amount, adjustReason } = resolveShopRefundAmount(vnd((r.calculatedRefundAmount ?? r.refundAmount).toString()), input.refundAmount, input.adjustReason);
      const now = new Date();
      const decided = { approvedAt: now, approvedBy: actor.userId, processedBy: actor.userId, processedAt: now, refundAmount: amount.toString(), adjustReason, shopRespondDueAt: null };
      let codReversed = false; // COD-08b: đảo ghi thu (không có khoản hoàn) — để audit ghi đúng

      if (!r.requireReturn) {
        // Khách báo CHƯA NHẬN hàng: không có hàng để trả ⇒ hoàn tiền ngay, KHÔNG nhập kho.
        const o = await this.core.lockOrder(tx, r);
        if (this.core.isCodReversal(r, o)) {
          // COD-08b (PLAN-0031 §2.3): đơn COD shop đã báo giao + khách báo chưa nhận ⇒ khách CHƯA từng trả tiền mặt ⇒ ĐẢO ghi thu (payment về chưa thu, ví shop được trả lại hoa hồng/voucher sàn), KHÔNG tạo hoàn tiền.
          codReversed = true;
          const reversed = await this.core.reverseCod(tx, r, o, { actor, reason: r.reason });
          await this.core.move(tx, r, reversed, { ...decided, refundAmount: '0', adjustReason: 'Đơn COD chưa thu tiền của khách — đảo ghi thu, không hoàn tiền', refundedAt: now }, actor.userId);
          await this.core.afterRefund(tx, o, { actor, amount: 0n, label: 'Khách chưa nhận hàng (COD) — shop đồng ý', reversed: true });
          await this.core.customerNote(tx, r, `Shop đồng ý yêu cầu chưa nhận hàng đơn ${r.orderCode}`, 'Đây là đơn thanh toán khi nhận hàng nên bạn chưa phải trả khoản nào — đơn đã được huỷ, không có khoản hoàn tiền.');
        } else {
          const next = await this.core.settleRefund(tx, r, o, { actor, restock: false, amount, reason: r.reason });
          await this.core.move(tx, r, next, { ...decided, ...(next === RETURN_STATUS.REFUNDED ? { refundedAt: now } : {}) }, actor.userId);
          await this.core.afterRefund(tx, o, { actor, amount, label: 'Khách chưa nhận hàng — shop đồng ý hoàn tiền' });
          await this.core.customerNote(tx, r, `Shop đồng ý hoàn tiền đơn ${r.orderCode}`, next === RETURN_STATUS.REFUNDED ? 'Yêu cầu của bạn đã hoàn tất.' : `Khoản ${money(amount).display} đang được hoàn về bạn.`);
        }
      } else {
        const address = input.returnAddress ?? (await this.core.lastReturnAddress(shopId, tx));
        if (!address) throw new BusinessException(ORDER_ERR.RETURN_ADDRESS_REQUIRED, 'Vui lòng nhập địa chỉ nhận hàng trả để khách gửi hàng về');
        await this.core.move(tx, r, RETURN_STATUS.APPROVED, { ...decided, returnAddress: { name: address.name.trim(), phone: address.phone.trim(), address: address.address.trim() }, shipBackDueAt: new Date(now.getTime() + shipBackDays * DAY) }, actor.userId);
        await this.core.customerNote(tx, r, `Shop đã duyệt yêu cầu đổi trả đơn ${r.orderCode}`, `Gửi hàng về: ${address.name.trim()} · ${address.phone.trim()} · ${address.address.trim()} trong ${shipBackDays} ngày rồi báo mã vận đơn. Hoàn ${money(amount).display} sau khi shop nhận lại hàng.`);
      }
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_APPROVED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: r.status, refundAmount: r.refundAmount.toString() }, after: { refundAmount: codReversed ? '0' : amount.toString(), adjustReason, requireReturn: r.requireReturn, codReversed, shopId } });
    });
    this.logger.log({ id, shopId, by: actor.userId }, 'Shop đã duyệt yêu cầu đổi trả');
    return this.get(shopId, id);
  }

  async reject(actor: AuthenticatedActor, shopId: string, id: string, input: { reason: string; evidence?: MediaInput }): Promise<ShopReturnRequestResponse> {
    const reason = input.reason.trim();
    if (reason.length < 10) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Lý do từ chối phải từ 10 ký tự');
    const evidence = normalizeEvidence(input.evidence, this.core.evidenceContext(), { required: false });
    const escalateDays = boundedSetting(await this.system.settingNumber(SETTING_KEY.RETURN_ESCALATE_DAYS), 'days', 3);
    await this.prisma.$transaction(async (tx: Tx) => {
      const r = await this.core.lock(tx, id, { shopId });
      if (r.status !== RETURN_STATUS.REQUESTED) throw new BusinessException(ORDER_ERR.RETURN_INVALID_STATE, 'Yêu cầu đã được xử lý', 409);
      const now = new Date();
      await this.core.move(tx, r, RETURN_STATUS.REJECTED, { rejectedBy: RETURN_REJECTED_BY.SHOP, rejectedAt: now, rejectReason: reason.slice(0, 500), rejectEvidence: evidence, processedBy: actor.userId, processedAt: now, shopRespondDueAt: null, escalateDueAt: new Date(now.getTime() + escalateDays * DAY) }, actor.userId);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_REJECTED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: r.status }, after: { status: RETURN_STATUS.REJECTED, reason: reason.slice(0, 200), evidence: evidence.length, shopId } });
      await this.core.customerNote(tx, r, `Yêu cầu đổi trả đơn ${r.orderCode} bị shop từ chối`, `${reason}. Bạn có thể khiếu nại lên sàn trong ${escalateDays} ngày.`);
    });
    return this.get(shopId, id);
  }

  async receive(actor: AuthenticatedActor, shopId: string, id: string, input: { condition: string; note?: string; evidence?: MediaInput }): Promise<ShopReturnRequestResponse> {
    const note = input.note?.trim() ?? '';
    const notMatching = input.condition === RETURN_RECEIVED_CONDITION.NOT_MATCHING;
    if (notMatching && note.length < 10) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Hàng nhận về không khớp: mô tả rõ (từ 10 ký tự) để sàn phân xử');
    const evidence = normalizeEvidence(input.evidence, this.core.evidenceContext(), { required: false });
    await this.prisma.$transaction(async (tx: Tx) => {
      const r = await this.core.lock(tx, id, { shopId });
      if (r.status !== RETURN_STATUS.APPROVED || !r.requireReturn) throw new BusinessException(ORDER_ERR.RETURN_INVALID_STATE, 'Chỉ xác nhận nhận hàng khi yêu cầu trả hàng đã được duyệt', 409);
      const now = new Date();
      const received = { receivedAt: now, receivedBy: actor.userId, receivedCondition: input.condition, receivedNote: note || null, receivedEvidence: evidence, shipBackDueAt: null, shopReceiveDueAt: null };
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.RETURN_RECEIVED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: r.status }, after: { condition: input.condition, note: note.slice(0, 200), evidence: evidence.length, shopId } });
      if (notMatching) {
        // Hàng về nhưng không khớp ⇒ shop KHÔNG tự quyết: chuyển sàn phân xử (chưa nhập kho, chưa hoàn tiền).
        await this.core.escalate(tx, r, { source: RETURN_ESCALATE_SOURCE.SHOP_NOT_MATCHING, reason: note, actor, extra: received });
        return;
      }
      // Hàng đúng ⇒ nhập kho + yêu cầu hoàn tiền (kèm tài khoản nhận hoàn của khách) + đơn → returned nếu trả hết — CÙNG transaction.
      const o = await this.core.lockOrder(tx, r);
      const amount = vnd(r.refundAmount.toString());
      const next = await this.core.settleRefund(tx, r, o, { actor, restock: true, amount, reason: r.reason });
      await this.core.move(tx, r, next, { ...received, ...(next === RETURN_STATUS.REFUNDED ? { refundedAt: now } : {}) }, actor.userId);
      await this.core.afterRefund(tx, o, { actor, amount, label: 'Shop đã nhận lại hàng đổi trả' });
      await this.core.customerNote(tx, r, `Shop đã nhận lại hàng đơn ${r.orderCode}`, `Khoản ${money(amount).display} đang được hoàn về bạn.`);
    });
    this.logger.log({ id, shopId, condition: input.condition, by: actor.userId }, 'Shop đã xác nhận nhận lại hàng đổi trả');
    return this.get(shopId, id);
  }
}
