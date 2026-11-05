import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { PRODUCT_STATS_GATEWAY, ProductStatsGateway } from '@common/gateway/product-stats.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '../../../system/enums/setting-keys';
import { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { OrderAuditLogService } from '../../audit/order-audit-log.service';
import { normalizeProvince, resolveCancelReason } from '../../foundation/cancel.rules';
import {
  CANCEL_REASON_LABEL,
  CANCEL_REQUEST_STATUS,
  CANCEL_SOURCE,
  ORDER_AUDIT_V2,
  ORDER_ERR,
  ORDER_ERR_V2,
  ORDER_EVENT,
  ORDER_STATUS,
  PAYMENT_STATUS,
  STATUS_LABEL,
} from '../../foundation/order.constants';
import { OrderOutboxService } from '../../outbox/order-outbox.service';
import { OrderRepository, OrderRow } from '../repository/order.repository';
import { OrderService } from './order.service';

const HOUR = 3_600_000;
const DEFAULT_CANCEL_REQUEST_HOURS = 24;
const DEFAULT_SHIP_HOURS = 48;
/* Mỗi lô tối đa 100 đơn, tối đa 20 lô mỗi lần xử lý một sự kiện khoá shop — tồn đọng lớn được dọn tiếp ở lần retry của relay. */
const SUSPEND_BATCH = 100;
const SUSPEND_MAX_BATCHES = 20;
/* Danh sách đơn đóng gói/đang giao đưa vào thông báo CSKH khi shop bị khoá (chỉ hiện tối đa từng này mã, phần còn lại đếm theo số). */
const SUSPEND_HOLD_SAMPLE = 10;

export interface ChangeAddressInput {
  recipientName: string;
  recipientPhone: string;
  addressLine: string;
  ward?: string | null;
  district?: string | null;
  province: string;
}

/*
 * Lối thoát & hạn chót của đơn (PLAN-0027 §2.2–§2.5), phần có TRẠNG THÁI RIÊNG ngoài huỷ trực tiếp:
 *   - khách YÊU CẦU huỷ đơn đang đóng gói → shop chấp nhận / từ chối → im lặng quá hạn thì job tự chấp nhận;
 *   - shop gia hạn giao MỘT lần; khách đổi địa chỉ nhận (pending/confirmed); khách bấm "Đã nhận hàng";
 *   - shop bị khoá → tự huỷ + hoàn đơn pending/confirmed, báo CSKH các đơn đóng gói/đang giao.
 * Mọi hàm ghi MỘT transaction, KHOÁ DÒNG ĐƠN (FOR UPDATE) trước khi kiểm trạng thái (G15 — chống đua với shop/khách/job/CSKH), idempotent khi chạy lặp. Huỷ thật đi qua
 * OrderService.doCancel (nhả/nhập kho, voucher, hoàn tiền, thông báo, outbox) nên luật tiền/kho nằm MỘT chỗ. Thứ tự khoá ĐƠN → PAYMENT → ví (doCancel/payment lo phần sau).
 */
@Injectable()
export class OrderFulfilmentService {
  private readonly logger = new Logger(OrderFulfilmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OrderRepository,
    private readonly orders: OrderService,
    private readonly audit: OrderAuditLogService,
    private readonly outbox: OrderOutboxService,
    private readonly system: SystemQueryApi,
    private readonly shops: ShopQueryApi,
    @Inject(NOTIFICATION_GATEWAY) private readonly notify: NotificationGateway,
    @Inject(PRODUCT_STATS_GATEWAY) private readonly productStats: ProductStatsGateway,
  ) {}

  private async hours(key: string, fallback: number): Promise<number> {
    const h = await this.system.settingNumber(key);
    return h > 0 ? h : fallback;
  }

  private async shopNote(tx: Tx, shopId: string, permission: string, n: { title: string; content?: string | null; orderCode: string }): Promise<void> {
    const members = await this.shops.memberUserIdsWithPermission(shopId, permission);
    await this.notify.notifyMany(members.map((userId) => ({ userId, type: 'order', title: n.title, content: n.content ?? null, link: `/vendor/orders/${n.orderCode}` })), tx);
  }

  // ================================================================ khách yêu cầu huỷ đơn đang đóng gói

  /*
   * POST /orders/:code/cancel-request — chỉ đơn `packing` (pending/confirmed huỷ thẳng; từ shipping trở đi không huỷ được), mỗi đơn MỘT yêu cầu (đang chờ hoặc đã bị từ chối ⇒ 409,
   * khách không spam). Hạn xử lý = `order.cancel_request_hours`; shop có quyền `shop.order.cancel` được báo.
   */
  async requestCancel(actor: AuthenticatedActor, code: string, input: { reasonCode: string; note?: string }): Promise<void> {
    const { reasonCode } = resolveCancelReason('customer', { reasonCode: input.reasonCode });
    const note = input.note?.trim() || null;
    const hours = await this.hours(SETTING_KEY.ORDER_CANCEL_REQUEST_HOURS, DEFAULT_CANCEL_REQUEST_HOURS);
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.status === ORDER_STATUS.PENDING || o.status === ORDER_STATUS.CONFIRMED) {
        throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, 'Đơn chưa đóng gói — bạn có thể huỷ trực tiếp, không cần gửi yêu cầu', 409, { hint: 'cancel_direct' });
      }
      if (o.status !== ORDER_STATUS.PACKING) throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, `Không gửi được yêu cầu huỷ cho đơn đang "${STATUS_LABEL[o.status]}"`, 409);
      if (o.cancelRequestStatus) throw new BusinessException(ORDER_ERR_V2.CANCEL_REQUEST_EXISTS, o.cancelRequestStatus === CANCEL_REQUEST_STATUS.PENDING ? 'Bạn đã gửi yêu cầu huỷ, đang chờ shop phản hồi' : 'Yêu cầu huỷ của bạn đã được shop phản hồi — vui lòng liên hệ CSKH nếu cần hỗ trợ thêm', 409);
      const now = new Date();
      const dueAt = new Date(now.getTime() + hours * HOUR);
      await this.repo.update(o.id, { cancelRequestStatus: CANCEL_REQUEST_STATUS.PENDING, cancelRequestedAt: now, cancelRequestReasonCode: reasonCode, cancelRequestNote: note, cancelRequestDueAt: dueAt, cancelRequestResolvedBy: null, cancelRequestRejectReason: null, updatedBy: actor.userId }, tx);
      await this.repo.addHistory(o.id, o.status, o.status, `Khách yêu cầu huỷ đơn: ${CANCEL_REASON_LABEL[reasonCode]}${note ? ` — ${note}` : ''}`.slice(0, 500), actor.userId, tx);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT_V2.CANCEL_REQUESTED, entityType: 'order', entityId: o.id, entityCode: o.code, after: { reasonCode, note, dueAt: dueAt.toISOString() } });
      await this.shopNote(tx, o.shopId, 'shop.order.cancel', { orderCode: o.code, title: `Khách yêu cầu huỷ đơn ${o.code}`, content: `${CANCEL_REASON_LABEL[reasonCode]}${note ? ` — ${note}` : ''}. Hãy chấp nhận hoặc từ chối trước ${dueAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}; quá hạn hệ thống tự chấp nhận.` });
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.CANCEL_REQUESTED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: o.code, userId: o.userId, shopId: o.shopId, reasonCode, dueAt: dueAt.toISOString() } });
    });
  }

  /* Lý do ghi vào đơn khi yêu cầu huỷ được chấp nhận (khách là bên khởi xướng). */
  private static requestReason(o: Pick<OrderRow, 'cancelRequestReasonCode' | 'cancelRequestNote'>, prefix: string): string {
    const label = CANCEL_REASON_LABEL[o.cancelRequestReasonCode ?? 'other'] ?? CANCEL_REASON_LABEL.other;
    return `${prefix}: ${label}${o.cancelRequestNote ? ` — ${o.cancelRequestNote}` : ''}`.slice(0, 255);
  }

  private static assertPendingRequest(o: OrderRow | null, shopId: string): asserts o is OrderRow {
    if (!o || o.shopId !== shopId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
    if (o.status !== ORDER_STATUS.PACKING || o.cancelRequestStatus !== CANCEL_REQUEST_STATUS.PENDING) throw new BusinessException(ORDER_ERR_V2.CANCEL_REQUEST_NOT_FOUND, 'Đơn không có yêu cầu huỷ nào đang chờ xử lý', 409);
  }

  /* Shop chấp nhận ⇒ huỷ đơn (nhập lại kho, hoàn tiền nếu đã trả, báo khách); không tính vi phạm. */
  async acceptCancelRequest(actor: AuthenticatedActor, shopId: string, code: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      OrderFulfilmentService.assertPendingRequest(o, shopId);
      const paid = o.paymentStatus === PAYMENT_STATUS.PAID;
      await this.orders.doCancel(o, OrderFulfilmentService.requestReason(o, 'Khách yêu cầu huỷ, shop đã chấp nhận'), actor, tx, {
        source: CANCEL_SOURCE.CUSTOMER,
        reasonCode: o.cancelRequestReasonCode ?? 'other',
        notifyShop: false,
        requestResolution: CANCEL_REQUEST_STATUS.ACCEPTED,
        notify: { title: `Đơn ${o.code} đã huỷ theo yêu cầu của bạn`, content: `Shop đã chấp nhận yêu cầu huỷ.${paid ? ' Chúng tôi sẽ hoàn lại toàn bộ số tiền bạn đã thanh toán.' : ''}` },
      });
      await this.audit.write(tx, actor, { action: ORDER_AUDIT_V2.CANCEL_REQUEST_ACCEPTED, entityType: 'order', entityId: o.id, entityCode: o.code, after: { decision: CANCEL_REQUEST_STATUS.ACCEPTED } });
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.CANCEL_REQUEST_RESOLVED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: o.code, userId: o.userId, shopId: o.shopId, decision: CANCEL_REQUEST_STATUS.ACCEPTED } });
    });
  }

  /* Shop từ chối (lý do ≥ 10 ký tự, khách đọc được) ⇒ đơn tiếp tục; sau đó shop tự huỷ đơn này bị tính điểm vi phạm (`reject_then_cancel`). */
  async rejectCancelRequest(actor: AuthenticatedActor, shopId: string, code: string, reason: string): Promise<void> {
    const why = reason.trim();
    if (why.length < 10) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Lý do từ chối cần ít nhất 10 ký tự');
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      OrderFulfilmentService.assertPendingRequest(o, shopId);
      await this.repo.update(o.id, { cancelRequestStatus: CANCEL_REQUEST_STATUS.REJECTED, cancelRequestResolvedBy: actor.userId, cancelRequestRejectReason: why.slice(0, 500), cancelRequestDueAt: null, updatedBy: actor.userId }, tx);
      await this.repo.addHistory(o.id, o.status, o.status, `Shop từ chối yêu cầu huỷ: ${why}`.slice(0, 500), actor.userId, tx);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT_V2.CANCEL_REQUEST_REJECTED, entityType: 'order', entityId: o.id, entityCode: o.code, after: { decision: CANCEL_REQUEST_STATUS.REJECTED, reason: why.slice(0, 200) } });
      await this.notify.notify({ userId: o.userId, type: 'order', title: `Shop từ chối yêu cầu huỷ đơn ${o.code}`, content: `${why}. Đơn vẫn đang được xử lý; nếu cần hỗ trợ, hãy liên hệ chăm sóc khách hàng.`, link: `/account/orders/${o.code}` }, tx);
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.CANCEL_REQUEST_RESOLVED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: o.code, userId: o.userId, shopId: o.shopId, decision: CANCEL_REQUEST_STATUS.REJECTED } });
    });
  }

  /*
   * Job SLA: yêu cầu huỷ shop im lặng quá hạn ⇒ TỰ CHẤP NHẬN. Idempotent + an toàn nhiều worker: khoá dòng, đọc lại trạng thái + hạn rồi mới huỷ (đã xử lý ở nơi khác / chưa tới hạn ⇒ false).
   */
  async autoAcceptCancelRequest(code: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.status !== ORDER_STATUS.PACKING || o.cancelRequestStatus !== CANCEL_REQUEST_STATUS.PENDING || !o.cancelRequestDueAt || o.cancelRequestDueAt.getTime() >= Date.now()) return false;
      const paid = o.paymentStatus === PAYMENT_STATUS.PAID;
      await this.orders.doCancel(o, OrderFulfilmentService.requestReason(o, 'Khách yêu cầu huỷ, shop không phản hồi đúng hạn — hệ thống tự chấp nhận'), null, tx, {
        source: CANCEL_SOURCE.CUSTOMER,
        reasonCode: o.cancelRequestReasonCode ?? 'other',
        requestResolution: CANCEL_REQUEST_STATUS.AUTO_ACCEPTED,
        notifyShop: { title: `Đơn ${o.code} đã huỷ theo yêu cầu của khách`, content: 'Quá hạn phản hồi nên hệ thống tự chấp nhận yêu cầu huỷ. Hàng đã được nhập lại kho.', permission: 'shop.order.read' },
        notify: { title: `Đơn ${o.code} đã huỷ theo yêu cầu của bạn`, content: `Shop không phản hồi đúng hạn nên hệ thống đã chấp nhận yêu cầu huỷ.${paid ? ' Chúng tôi sẽ hoàn lại toàn bộ số tiền bạn đã thanh toán.' : ''}` },
      });
      await this.audit.write(tx, null, { action: ORDER_AUDIT_V2.CANCEL_REQUEST_ACCEPTED, entityType: 'order', entityId: o.id, entityCode: o.code, after: { decision: CANCEL_REQUEST_STATUS.AUTO_ACCEPTED } });
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.CANCEL_REQUEST_RESOLVED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: o.code, userId: o.userId, shopId: o.shopId, decision: CANCEL_REQUEST_STATUS.AUTO_ACCEPTED } });
      return true;
    });
  }

  // ================================================================ gia hạn giao

  /* POST /shop/orders/:code/extend-ship — MỘT lần, +`order.shop_ship_hours`, chỉ khi còn hạn (đơn quá hạn ⇒ job huỷ, không gia hạn chắp vá). Đơn cũ không có hạn ⇒ 409. */
  async extendShip(actor: AuthenticatedActor, shopId: string, code: string, reason: string): Promise<void> {
    const why = reason.trim();
    if (why.length < 10) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Lý do gia hạn cần ít nhất 10 ký tự');
    const extra = await this.hours(SETTING_KEY.ORDER_SHOP_SHIP_HOURS, DEFAULT_SHIP_HOURS);
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.shopId !== shopId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.status !== ORDER_STATUS.CONFIRMED && o.status !== ORDER_STATUS.PACKING) throw new BusinessException(ORDER_ERR.INVALID_TRANSITION, `Chỉ gia hạn giao khi đơn đã xác nhận hoặc đang đóng gói (hiện: "${STATUS_LABEL[o.status]}")`, 409);
      if (o.shipExtendedAt) throw new BusinessException(ORDER_ERR_V2.SHIP_ALREADY_EXTENDED, 'Đơn này đã được gia hạn giao một lần, không gia hạn thêm được', 409);
      if (!o.shipDueAt) throw new BusinessException(ORDER_ERR_V2.SHIP_NO_DEADLINE, 'Đơn này không có hạn giao nên không cần gia hạn', 409);
      const now = new Date();
      if (o.shipDueAt.getTime() <= now.getTime()) throw new BusinessException(ORDER_ERR_V2.SHIP_OVERDUE, 'Đơn đã quá hạn giao, không gia hạn được nữa', 409);
      const dueAt = new Date(o.shipDueAt.getTime() + extra * HOUR);
      await this.repo.update(o.id, { shipDueAt: dueAt, shipExtendedAt: now, shipExtendReason: why.slice(0, 500), shipRemindedAt: null, updatedBy: actor.userId }, tx);
      await this.repo.addHistory(o.id, o.status, o.status, `Shop gia hạn thời gian giao: ${why}`.slice(0, 500), actor.userId, tx);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT_V2.SHIP_EXTENDED, entityType: 'order', entityId: o.id, entityCode: o.code, before: { shipDueAt: o.shipDueAt.toISOString() }, after: { shipDueAt: dueAt.toISOString(), reason: why.slice(0, 200) } });
      await this.notify.notify({ userId: o.userId, type: 'order', title: `Shop gia hạn thời gian giao đơn ${o.code}`, content: `Lý do: ${why}`, link: `/account/orders/${o.code}` }, tx);
    });
  }

  // ================================================================ đổi địa chỉ

  /*
   * PUT /orders/:code/address — khách đổi người nhận / SĐT / địa chỉ khi `pending` hoặc `confirmed` (CAN-14). `packing` trở đi ⇒ 409 (hàng đã đóng theo địa chỉ cũ → liên hệ shop hoặc gửi yêu cầu huỷ).
   * KHÔNG tính lại phí ship ⇒ chặn đổi sang tỉnh/thành khác (gợi ý huỷ và đặt lại). Ghi lịch sử (trước → sau) + audit, báo shop, phát ORDER_ADDRESS_CHANGED.
   */
  async changeAddress(actor: AuthenticatedActor, code: string, input: ChangeAddressInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.status !== ORDER_STATUS.PENDING && o.status !== ORDER_STATUS.CONFIRMED) {
        throw new BusinessException(ORDER_ERR_V2.ADDRESS_LOCKED, o.status === ORDER_STATUS.PACKING ? 'Đơn đang được đóng gói nên không đổi được địa chỉ — hãy liên hệ shop hoặc gửi yêu cầu huỷ đơn' : `Không đổi được địa chỉ của đơn đang "${STATUS_LABEL[o.status]}"`, 409);
      }
      if (normalizeProvince(input.province) !== normalizeProvince(o.provinceName)) {
        throw new BusinessException(ORDER_ERR_V2.ADDRESS_PROVINCE_CHANGED, 'Không đổi sang tỉnh/thành khác được vì phí giao hàng khác nhau — hãy huỷ đơn và đặt lại với địa chỉ mới', 409);
      }
      if(o.fulfilmentMode === 'carrier') throw new BusinessException('ORDER_ADDRESS_STRUCTURED_REQUIRED','Vui lòng chọn địa chỉ có mã giao hàng trong sổ địa chỉ',409);
      const street = input.addressLine.trim();
      const ward = input.ward?.trim() || null;
      const district = input.district?.trim() || null;
      const shippingAddress = [street, ward, district, o.provinceName].filter(Boolean).join(', ');
      const before = { recipientName: o.recipientName, recipientPhone: o.recipientPhone, shippingAddress: o.shippingAddress };
      const after = { recipientName: input.recipientName.trim(), recipientPhone: input.recipientPhone.trim(), shippingAddress };
      await this.repo.update(o.id, { recipientName: after.recipientName, recipientPhone: after.recipientPhone, street, wardName: ward, districtName: district, shippingAddress, updatedBy: actor.userId }, tx);
      await this.repo.addHistory(o.id, o.status, o.status, `Khách đổi thông tin nhận hàng: ${before.recipientName}, ${before.recipientPhone}, ${before.shippingAddress} → ${after.recipientName}, ${after.recipientPhone}, ${after.shippingAddress}`.slice(0, 500), actor.userId, tx);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT_V2.ADDRESS_CHANGED, entityType: 'order', entityId: o.id, entityCode: o.code, before, after });
      await this.shopNote(tx, o.shopId, 'shop.order.update', { orderCode: o.code, title: `Khách đổi địa chỉ nhận đơn ${o.code}`, content: `Người nhận: ${after.recipientName} · ${after.recipientPhone} · ${shippingAddress}. Hãy giao theo địa chỉ mới.` });
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.ADDRESS_CHANGED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: o.code, userId: o.userId, shopId: o.shopId } });
    });
  }

  // ================================================================ "Đã nhận hàng"

  /*
   * POST /orders/:code/received — khách xác nhận đã nhận: `delivered` → `completed` (completedBy = customer). Không cho khi đang có yêu cầu đổi trả / "chưa nhận hàng" mở (409).
   * Escrow vẫn tính từ `deliveredAt + return.window_days` (settlementOrders) nên bấm sớm không rút ngắn thời gian khiếu nại. Phát ORDER_STATUS_CHANGED như updateStatus (listener ví COD chỉ nghe sự kiện này).
   * Idempotent: đơn đã `completed` do chính khách bấm ⇒ trả thành công, không ghi lại.
   */
  async markReceived(actor: AuthenticatedActor, code: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.status === ORDER_STATUS.COMPLETED && o.completedBy === 'customer') return;
      if (o.status !== ORDER_STATUS.DELIVERED) throw new BusinessException(ORDER_ERR_V2.NOT_DELIVERED, `Chỉ xác nhận đã nhận hàng khi đơn ở trạng thái "${STATUS_LABEL[ORDER_STATUS.DELIVERED]}" (hiện: "${STATUS_LABEL[o.status]}")`, 409);
      if (await this.repo.hasOpenReturn(o.id, tx)) throw new BusinessException(ORDER_ERR.HAS_OPEN_RETURN, 'Đơn đang có yêu cầu đổi trả / báo chưa nhận hàng chưa xử lý xong — chưa xác nhận đã nhận hàng được', 409);
      await this.repo.update(o.id, { status: ORDER_STATUS.COMPLETED, completedAt: new Date(), completedBy: 'customer', updatedBy: actor.userId }, tx);
      await this.repo.addHistory(o.id, o.status, ORDER_STATUS.COMPLETED, 'Khách xác nhận đã nhận hàng', actor.userId, tx);
      await this.productStats.addSold(o.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), tx);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT_V2.RECEIVED, entityType: 'order', entityId: o.id, entityCode: o.code, before: { status: o.status }, after: { status: ORDER_STATUS.COMPLETED } });
      await this.shopNote(tx, o.shopId, 'shop.order.read', { orderCode: o.code, title: `Khách đã xác nhận nhận hàng đơn ${o.code}`, content: 'Đơn hoàn tất; tiền về ví sau thời gian giữ tiền theo quy định đổi trả.' });
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.STATUS_CHANGED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: o.code, userId: o.userId, from: o.status, to: ORDER_STATUS.COMPLETED } });
    });
  }

  // ================================================================ shop bị khoá (listener SHOP_SUSPENDED)

  /*
   * Shop bị khoá ⇒ đơn KHÔNG đóng băng (SHOP-01c): `pending`/`confirmed` tự huỷ (hệ thống, mã `shop_suspended`) + hoàn tiền nếu đã trả + báo khách; mỗi đơn một tx (một đơn lỗi không chặn cả lô).
   * Chỉ chạy khi shop VẪN đang bị khoá (mở khoá nhanh sau đó ⇒ không huỷ oan). Đơn `packing`/`shipping` KHÔNG tự huỷ (hàng có thể đã đóng/đang trên đường): CSKH quyết từng đơn — hàm này trả danh sách
   * để listener báo CSKH MỘT lần. Idempotent: relay phát lại sự kiện chỉ thấy ít đơn pending/confirmed hơn.
   */
  async cancelOpenOrdersOfSuspendedShop(shopId: string): Promise<{ cancelled: number; failed: number }> {
    const brief = await this.shops.findBrief(shopId);
    if (!brief || brief.status !== 'suspended') return { cancelled: 0, failed: 0 };
    let cancelled = 0;
    const failedCodes = new Set<string>();
    for (let batch = 0; batch < SUSPEND_MAX_BATCHES; batch += 1) {
      const rows = await this.repo.findByShopAndStatus(shopId, [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED], SUSPEND_BATCH, [...failedCodes]);
      if (rows.length === 0) break;
      for (const { code } of rows) {
        try {
          const done = await this.prisma.$transaction(async (tx) => {
            const o = await this.repo.findByCodeForUpdate(code, tx);
            if (!o || (o.status !== ORDER_STATUS.PENDING && o.status !== ORDER_STATUS.CONFIRMED)) return false;
            const paid = o.paymentStatus === PAYMENT_STATUS.PAID;
            await this.orders.doCancel(o, 'Gian hàng tạm ngừng hoạt động — đơn được huỷ tự động', null, tx, {
              source: CANCEL_SOURCE.SYSTEM,
              reasonCode: 'shop_suspended',
              notifyShop: false,
              notify: { title: `Đơn ${o.code} đã huỷ vì gian hàng tạm ngừng hoạt động`, content: `Gian hàng hiện không thể xử lý đơn nên đơn được huỷ tự động.${paid ? ' Chúng tôi sẽ hoàn lại toàn bộ số tiền bạn đã thanh toán.' : ''} Xin lỗi bạn vì sự bất tiện.` },
            });
            return true;
          });
          if (done) cancelled += 1;
          else failedCodes.add(code); // đã đổi trạng thái ở nơi khác — đừng gặp lại trong lần chạy này
        } catch (err) {
          failedCodes.add(code);
          this.logger.warn({ err, code, shopId }, 'Tự huỷ đơn của shop bị khoá lỗi một dòng — bỏ qua');
        }
      }
      if (rows.length < SUSPEND_BATCH) break;
    }
    const failed = [...failedCodes].length;
    if (cancelled > 0) this.logger.log({ shopId, cancelled }, 'Đã tự huỷ đơn pending/confirmed của shop bị khoá');
    return { cancelled, failed };
  }

  /* Đơn đóng gói/đang giao của shop bị khoá ⇒ MỘT thông báo cho CSKH kèm số lượng + vài mã đơn (CSKH quyết từng đơn). Gọi trong tx của listener (đã đánh dấu sự kiện). */
  async alertSupportAboutHeldOrders(tx: Tx, shopId: string, staffIds: string[]): Promise<number> {
    const brief = await this.shops.findBrief(shopId);
    if (!brief || brief.status !== 'suspended') return 0; // đã mở khoá lại trước khi xử lý sự kiện ⇒ không báo
    const statuses: string[] = [ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING];
    const counts = await this.repo.openCountsByShop(shopId, statuses);
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    if (total === 0 || staffIds.length === 0) return total;
    const sample = await this.repo.findByShopAndStatus(shopId, statuses, SUSPEND_HOLD_SAMPLE);
    const list = sample.map((r) => `${r.code} (${STATUS_LABEL[r.status]})`).join(', ');
    await this.notify.notifyMany(
      staffIds.map((userId) => ({
        userId,
        type: 'order',
        title: `Gian hàng ${brief?.name ?? shopId} bị khoá — ${total} đơn đang đóng gói/đang giao cần xử lý`,
        content: `Đang đóng gói: ${counts[ORDER_STATUS.PACKING]} · đang giao: ${counts[ORDER_STATUS.SHIPPING]}. ${list}${total > sample.length ? ', …' : ''}. Hãy xem từng đơn: huỷ + hoàn tiền nếu shop không thể giao.`,
        link: `/order/orders?shopId=${shopId}`,
      })),
      tx,
    );
    return total;
  }
}
