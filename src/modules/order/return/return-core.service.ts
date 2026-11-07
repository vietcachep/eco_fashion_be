import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { ConflictException, NotFoundException } from '@common/exception/business.exception';
import { INVENTORY_GATEWAY, InventoryGateway } from '@common/gateway/inventory.gateway';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from '@common/gateway/payment.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { money } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ShopQueryApi } from '../../shop/queryapi/shop.queryapi';
import { OrderAuditLogService } from '../audit/order-audit-log.service';
import {
  ORDER_AUDIT,
  ORDER_ERR,
  ORDER_EVENT,
  ORDER_STATUS,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  RETURN_ESCALATE_SOURCE,
  RETURN_REFUNDED_STATUSES,
  RETURN_STATUS,
  canReturnTransition,
  type ReturnStatus,
} from '../foundation/order.constants';
import { OrderRepository, OrderRow } from '../order/repository/order.repository';
import { OrderOutboxService } from '../outbox/order-outbox.service';
import { ReturnRequestResponse } from './dto/return.responses';
import { RETURN_INCLUDE, ReturnRow, ReturnViewer, toReturnResponse } from './return.mapper';
import { type EvidenceHostContext, readRefundAccount, readReturnAddress, refundReason, type ReturnAddress } from './return.rules';

/* Người thao tác ghi audit; null = hệ thống (job SLA, hook từ payment). */
export type ReturnActor = Pick<AuthenticatedActor, 'userId' | 'email'> | null;

type EscalateSource = (typeof RETURN_ESCALATE_SOURCE)[keyof typeof RETURN_ESCALATE_SOURCE];

const SOURCE_LABEL: Record<EscalateSource, string> = {
  customer: 'Khách khiếu nại shop từ chối',
  shop_timeout: 'Shop không phản hồi đúng hạn',
  shop_receive_timeout: 'Shop không xác nhận nhận hàng đúng hạn',
  shop_not_matching: 'Shop báo hàng nhận về không khớp',
};

/*
 * Lõi dùng chung của đổi trả (PLAN-0022): khoá dòng, chuyển trạng thái CÓ KIỂM TRA (RETURN_TRANSITIONS), chuyển sàn phân xử, hoàn tiền + nhập kho + đơn → returned,
 * thông báo đúng người, dựng response theo lô. Các service theo vai (khách ReturnService · shop ShopReturnService · sàn AdminReturnService · job ReturnSlaService)
 * chỉ gọi vào đây nên máy trạng thái và hệ quả tiền/kho nằm MỘT chỗ.
 *
 * Transaction/lock: mọi hàm ghi nhận `tx` của service gọi (không tự mở transaction); thứ tự khoá luôn là YÊU CẦU trước, ĐƠN sau (job/duyệt/nhận hàng cùng thứ tự ⇒ không deadlock).
 * Mỗi chuyển trạng thái là compare-and-set `status = <trạng thái đã đọc>` — chạy đồng thời/job chạy lại chỉ thắng một lần. Audit do service gọi ghi; outbox
 * RETURN_STATUS_CHANGED ghi ở đây. Không gọi mạng trong transaction (payment.requestRefund chỉ GHI yêu cầu hoàn vào DB, việc chi do payment làm sau).
 */
@Injectable()
export class ReturnCoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderRepository,
    private readonly audit: OrderAuditLogService,
    private readonly outbox: OrderOutboxService,
    private readonly shops: ShopQueryApi,
    @Inject(INVENTORY_GATEWAY) private readonly inventory: InventoryGateway,
    @Inject(PAYMENT_GATEWAY) private readonly payment: PaymentGateway,
    @Inject(NOTIFICATION_GATEWAY) private readonly notify: NotificationGateway,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /* Host upload hợp lệ cho URL minh chứng (xem isTrustedEvidenceUrl). */
  evidenceContext(): EvidenceHostContext {
    return { cloudinaryCloudName: this.env.EF_CLOUDINARY_CLOUD_NAME, apiPublicUrl: this.env.EF_API_PUBLIC_URL };
  }

  // ====================================================================== đọc + khoá

  /* Khoá dòng yêu cầu (FOR UPDATE) rồi đọc kèm dòng hàng; `scope` lọc chủ sở hữu — sai shop/khách ⇒ 404 (không lộ sự tồn tại). */
  async lock(tx: Tx, id: string, scope: { shopId?: string; userId?: string } = {}): Promise<ReturnRow> {
    const head = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "order"."return_requests" WHERE id = ${id}::uuid FOR UPDATE`;
    const r = head[0] ? await tx.returnRequest.findUnique({ where: { id }, include: RETURN_INCLUDE }) : null;
    if (!r || (scope.shopId && r.shopId !== scope.shopId) || (scope.userId && r.userId !== scope.userId)) throw new NotFoundException(ORDER_ERR.RETURN_NOT_FOUND, 'Không tìm thấy yêu cầu đổi trả');
    return r;
  }

  /* Khoá đơn của yêu cầu (sau khi đã khoá yêu cầu). */
  async lockOrder(tx: Tx, r: Pick<ReturnRow, 'orderCode'>): Promise<OrderRow> {
    const o = await this.orders.findByCodeForUpdate(r.orderCode, tx);
    if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
    return o;
  }

  /* Đọc (ngoài transaction) một yêu cầu theo id, tuỳ chọn lọc chủ sở hữu. */
  async find(id: string, scope: { shopId?: string; userId?: string } = {}): Promise<ReturnRow> {
    const r = await this.prisma.returnRequest.findUnique({ where: { id }, include: RETURN_INCLUDE });
    if (!r || (scope.shopId && r.shopId !== scope.shopId) || (scope.userId && r.userId !== scope.userId)) throw new NotFoundException(ORDER_ERR.RETURN_NOT_FOUND, 'Không tìm thấy yêu cầu đổi trả');
    return r;
  }

  /*
   * Dựng response theo LÔ: tên shop một lần (findManyBrief), khoản hoàn bên payment một lần (refundSummaries cho cả trang) — không N+1 theo dòng.
   * `viewer` quyết định phần nào được lộ (xem return.mapper.ts).
   */
  async responses(rows: ReturnRow[], viewer: ReturnViewer): Promise<ReturnRequestResponse[]> {
    if (rows.length === 0) return [];
    const refundCodes = [...new Set(rows.filter((r) => r.status === RETURN_STATUS.RECEIVED || r.status === RETURN_STATUS.REFUNDED).map((r) => r.orderCode))];
    const [shops, refunds] = await Promise.all([this.shops.findManyBrief(rows.map((r) => r.shopId)), this.payment.refundSummaries(refundCodes)]);
    const now = new Date();
    return rows.map((r) => toReturnResponse(r, { shopName: shops.get(r.shopId)?.name ?? 'Gian hàng', refund: refunds.get(r.orderCode) ?? null, now, viewer }));
  }

  async respond(row: ReturnRow, viewer: ReturnViewer): Promise<ReturnRequestResponse> {
    return (await this.responses([row], viewer))[0];
  }

  /* Địa chỉ nhận hàng trả shop đã dùng ở lần duyệt gần nhất — điền sẵn / mặc định cho các lần sau (shop chưa có địa chỉ nào khác trong hệ thống). */
  async lastReturnAddress(shopId: string, tx?: Tx): Promise<ReturnAddress | null> {
    const last = await (tx ?? this.prisma).returnRequest.findFirst({ where: { shopId, requireReturn: true, approvedAt: { not: null } }, orderBy: { approvedAt: 'desc' }, select: { returnAddress: true } });
    return readReturnAddress(last?.returnAddress);
  }

  // ====================================================================== chuyển trạng thái

  /*
   * Ghi thay đổi lên yêu cầu bằng compare-and-set theo trạng thái ĐANG GIỮ. `to` = trạng thái mới (kiểm RETURN_TRANSITIONS, phát outbox RETURN_STATUS_CHANGED); `to = null` = chỉ cập nhật
   * trường (vd khách báo đã gửi hàng). Có người khác đổi trước (count = 0) ⇒ 409 — người dùng tải lại thấy trạng thái mới.
   */
  async move(tx: Tx, r: ReturnRow, to: ReturnStatus | null, data: Prisma.ReturnRequestUncheckedUpdateManyInput, actorId: string | null): Promise<void> {
    if (to !== null && !canReturnTransition(r.status, to)) throw new ConflictException(ORDER_ERR.RETURN_INVALID_STATE, `Không thể chuyển yêu cầu đổi trả từ "${r.status}" sang "${to}"`);
    const res = await tx.returnRequest.updateMany({ where: { id: r.id, status: r.status }, data: { ...data, ...(to ? { status: to } : {}), updatedBy: actorId, version: { increment: 1 } } });
    if (res.count === 0) throw new ConflictException(ORDER_ERR.RETURN_INVALID_STATE, 'Yêu cầu đổi trả vừa được xử lý ở nơi khác — vui lòng tải lại');
    if (to) await this.outbox.publish(tx, { eventType: ORDER_EVENT.RETURN_STATUS_CHANGED, aggregateType: 'return_request', aggregateId: r.id, payload: { returnId: r.id, orderCode: r.orderCode, userId: r.userId, shopId: r.shopId, from: r.status, to } });
  }

  /*
   * Chuyển lên SÀN phân xử (khách khiếu nại · shop quá hạn duyệt/nhận hàng · shop báo hàng không khớp): ghi nguồn + lý do + dấu mốc, xoá mọi hạn của shop, báo CSKH + shop + khách.
   * `extra` = trường kèm theo (vd shop xác nhận nhận hàng không khớp: receivedAt/Condition/Note). `actor` null = hệ thống.
   */
  async escalate(tx: Tx, r: ReturnRow, p: { source: EscalateSource; reason: string; actor: ReturnActor; extra?: Prisma.ReturnRequestUncheckedUpdateManyInput }): Promise<void> {
    const now = new Date();
    await this.move(tx, r, RETURN_STATUS.ESCALATED, { ...p.extra, escalatedAt: now, escalateReason: p.reason.slice(0, 500), escalateSource: p.source, shopRespondDueAt: null, shopReceiveDueAt: null, shipBackDueAt: null, escalateDueAt: null }, p.actor?.userId ?? null);
    await this.audit.write(tx, p.actor, { action: ORDER_AUDIT.RETURN_ESCALATED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: r.status }, after: { status: RETURN_STATUS.ESCALATED, source: p.source, reason: p.reason.slice(0, 200) } });
    const label = SOURCE_LABEL[p.source];
    await this.staffNote(tx, r.id, `Đổi trả đơn ${r.orderCode} cần phân xử`, `${label}. ${p.reason}`);
    await this.shopNote(tx, r.shopId, r.id, `Đổi trả đơn ${r.orderCode} đã chuyển sàn phân xử`, label);
    await this.customerNote(tx, r, `Yêu cầu đổi trả đơn ${r.orderCode} đã chuyển cho sàn xem xét`, 'Chăm sóc khách hàng của sàn sẽ xem xét và phản hồi bạn.');
  }

  // ====================================================================== tiền + kho

  /*
   * Hệ quả khi hàng/tiền được xác nhận: (1) nhập kho lại nếu `restock`; (2) đơn đã thu tiền ⇒ yêu cầu hoàn qua payment TRONG CÙNG transaction (kèm tài khoản nhận hoàn của khách);
   * chưa thu tiền / không có khoản nào để hoàn ⇒ không có tiền cần chi ⇒ `refunded` luôn. Trả trạng thái yêu cầu nên chuyển sang: `received` (chờ payment báo xong) hoặc `refunded`.
   */
  async settleRefund(tx: Tx, r: ReturnRow, o: OrderRow, p: { actor: ReturnActor; restock: boolean; amount: bigint; reason: string; suffix?: string }): Promise<typeof RETURN_STATUS.RECEIVED | typeof RETURN_STATUS.REFUNDED> {
    if(p.amount===0n && o.items.some(i=>!!i.discountAllocation)) {
      if(o.collectionMode==='carrier_cod' && !o.deliveredAt && (o.shippingSnapshot as Prisma.JsonObject|null)?.verifiedCarrierStatus!=='returned') throw new ConflictException('PAYMENT_COD_CARRIER_DISPUTE','Cần xác minh với hãng về kiện hàng trước khi duyệt');
      if(p.restock)await this.inventory.restock(r.items.map(i=>({variantId:i.variantId,quantity:i.quantity})),{type:'return',id:r.orderCode},tx);
      return RETURN_STATUS.REFUNDED; // Hàng được giảm hết phần phân bổ: ghi hoàn lượng, không tạo lệnh chi0đ.
    }
    if(o.collectionMode==='carrier_cod' && o.paymentStatus !== PAYMENT_STATUS.PAID && o.paymentStatus !== PAYMENT_STATUS.PARTIALLY_REFUNDED) {
      if(!o.deliveredAt && (o.shippingSnapshot as Prisma.JsonObject | null)?.verifiedCarrierStatus==='returned') {
        await this.payment.cancel(o.code,'Hãng đã trả kiện, COD chưa thu',tx);
        return RETURN_STATUS.REFUNDED;
      }
      if(!o.deliveredAt) throw new ConflictException('PAYMENT_COD_CARRIER_DISPUTE','Cần xác minh với hãng về kiện hàng và số tiền đã thu trước khi duyệt');
      // Hãng đã thu nhưng chưa nộp: ghi nghĩa vụ hoàn chờ kế toán, không báo đã hoàn.
      if(p.restock) await this.inventory.restock(r.items.map((i)=>({variantId:i.variantId,quantity:i.quantity})),{type:'return',id:r.orderCode},tx);
      const account=readRefundAccount(r.refundAccount);
      await this.payment.requestRefund({orderCode:r.orderCode,shopId:o.shopId,amount:p.amount,reason:refundReason('Chờ tiền COD hãng: ',p.reason),returnRequestId:r.id,actorUserId:p.actor?.userId ?? null,payee:account ?? null},tx);
      return RETURN_STATUS.RECEIVED;
    }
    if(o.paymentMethodCode===PAYMENT_METHOD.COD && o.paymentStatus!==PAYMENT_STATUS.PAID && o.paymentStatus!==PAYMENT_STATUS.PARTIALLY_REFUNDED) await this.payment.cancel(o.code,'Đóng COD chưa thu do yêu cầu đổi trả',tx);
    if (p.restock) await this.inventory.restock(r.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), { type: 'return', id: r.orderCode }, tx);
    if (o.paymentStatus !== PAYMENT_STATUS.PAID && o.paymentStatus !== PAYMENT_STATUS.PARTIALLY_REFUNDED) return RETURN_STATUS.REFUNDED;
    const account = readRefundAccount(r.refundAccount);
    const res = await this.payment.requestRefund(
      { orderCode: r.orderCode, shopId: o.shopId, amount: p.amount, reason: refundReason('Đổi trả: ', p.reason, p.suffix), returnRequestId: r.id, actorUserId: p.actor?.userId ?? null, payee: account ? { bankBin: account.bankBin, accountNumber: account.accountNumber, accountName: account.accountName } : null },
      tx,
    );
    return res.refundId === null ? RETURN_STATUS.REFUNDED : RETURN_STATUS.RECEIVED;
  }

  /*
   * Sau khi yêu cầu đã sang received/refunded: tổng số lượng đã hoàn của đơn ≥ số hàng của đơn ⇒ đơn → `returned` (một phần thì chỉ ghi lịch sử). PHẢI gọi SAU khi cập nhật trạng thái
   * yêu cầu trong cùng tx (cộng cả yêu cầu này). Chỉ đơn shipping/delivered/completed mới chuyển được (đơn `shipping` = báo chưa nhận hàng).
   */
  async afterRefund(tx: Tx, o: OrderRow, p: { actor: ReturnActor; amount: bigint; label: string; reversed?: boolean }): Promise<boolean> {
    const agg = await tx.returnRequestItem.aggregate({ _sum: { quantity: true }, where: { request: { orderId: o.id, status: { in: [...RETURN_REFUNDED_STATUSES] } } } });
    const actorId = p.actor?.userId ?? null;
    const tail = p.reversed ? 'đảo ghi thu COD, không hoàn tiền' : `hoàn ${money(p.amount).display}`; // COD-08b: đảo ghi thu không phải khoản hoàn
    if ((agg._sum.quantity ?? 0) >= o.itemCount && ([ORDER_STATUS.SHIPPING, ORDER_STATUS.DELIVERED, ORDER_STATUS.COMPLETED] as string[]).includes(o.status)) {
      await this.orders.update(o.id, { status: ORDER_STATUS.RETURNED, updatedBy: actorId }, tx);
      await this.orders.addHistory(o.id, o.status, ORDER_STATUS.RETURNED, `${p.label} — ${tail}`, actorId, tx);
      return true;
    }
    await this.orders.addHistory(o.id, o.status, o.status, `${p.label} một phần — ${tail}`, actorId, tx);
    return false;
  }

  // ====================================================================== COD-08b — khách chưa nhận hàng, đơn COD đã ghi thu

  /*
   * PLAN-0031 §2.3 (COD-08b, G19): yêu cầu "chưa nhận hàng" trên đơn COD mà shop đã báo giao (payment COD `paid`, ví shop đã bị trừ hoa hồng) ⇒ khách CHƯA TỪNG trả tiền mặt nên không có khoản nào để hoàn
   * cho khách. Mọi đường duyệt (shop duyệt · sàn phân xử "hoàn") phải ĐẢO ghi thu (reverseCod) thay vì tạo refund. `not_received` luôn áp cả đơn nên đảo toàn bộ. Điều kiện xét trên đơn ĐÃ KHOÁ: COD
   * + `paymentStatus = paid` (đã ghi thu). Đơn COD còn đang giao (chưa thu) đi nhánh "không có gì để hoàn" của settleRefund; đơn PayOS giữ nguyên đường hoàn tiền.
   */
  isCodReversal(r: Pick<ReturnRow, 'reasonCode'>, o: Pick<OrderRow, 'paymentMethodCode' | 'paymentStatus'> & {collectionMode?:string|null}): boolean {
    return o.collectionMode !== 'carrier_cod' && r.reasonCode === 'not_received' && o.paymentMethodCode === PAYMENT_METHOD.COD && o.paymentStatus === PAYMENT_STATUS.PAID;
  }

  /*
   * Đảo ghi thu COD trong CÙNG tx (đơn đã khoá, yêu cầu đã khoá — thứ tự YÊU CẦU → ĐƠN → PAYMENT → ví): payment về `cancelled` + `reversed_at`, ví shop được trả lại hoa hồng / thu lại phần voucher sàn đã bù
   * (payment.reverseCodCollection), đơn về `unpaid`, ghi audit. Idempotent: đơn đã `unpaid` thì isCodReversal = false nên không vào đây lần hai; payment không còn `paid` ⇒ reversed:false (không ghi gì thêm).
   * Trả `refunded` — không có tiền nào cần chi nên yêu cầu kết thúc luôn.
   */
  async reverseCod(tx: Tx, r: ReturnRow, o: OrderRow, p: { actor: ReturnActor; reason: string; suffix?: string }): Promise<typeof RETURN_STATUS.REFUNDED> {
    const actorId = p.actor?.userId ?? null;
    const res = await this.payment.reverseCodCollection({ orderCode: r.orderCode, shopId: o.shopId, reason: refundReason('Khách chưa nhận hàng: ', p.reason, p.suffix), actorUserId: actorId }, tx);
    await this.orders.update(o.id, { paymentStatus: PAYMENT_STATUS.UNPAID, updatedBy: actorId }, tx);
    await this.audit.write(tx, p.actor, { action: ORDER_AUDIT.COD_REVERSED, entityType: 'order', entityId: o.id, entityCode: r.orderCode, before: { paymentStatus: o.paymentStatus }, after: { paymentStatus: PAYMENT_STATUS.UNPAID, returnId: r.id, paymentReversed: res.reversed, shopId: o.shopId } });
    return RETURN_STATUS.REFUNDED;
  }

  // ====================================================================== thông báo (PLAN-0022 §7)

  async customerNote(tx: Tx, r: Pick<ReturnRow, 'userId'>, title: string, content?: string | null): Promise<void> {
    await this.notify.notify({ userId: r.userId, type: 'order', title, content: content ?? null, link: '/account/returns' }, tx);
  }

  /* Chỉ thành viên shop có `shop.return.process` (người thật sự xử lý được) — không làm phiền nhân viên chỉ có quyền xem. */
  async shopNote(tx: Tx, shopId: string, returnId: string, title: string, content?: string | null): Promise<void> {
    await this.shopNotify(tx, shopId, 'shop.return.process', { title, content, link: `/vendor/returns/${returnId}` });
  }

  /* CSKH sàn (quyền phân xử `order.return.process`). */
  async staffNote(tx: Tx, returnId: string, title: string, content?: string | null): Promise<void> {
    await this.staffNotify(tx, 'order.return.process', { title, content, link: `/order/returns/${returnId}` });
  }

  /* Thông báo cho thành viên shop CÓ mã quyền `permissionCode` (dùng chung cho việc đơn hàng: báo giao thất bại, đơn giao quá hạn). */
  async shopNotify(tx: Tx, shopId: string, permissionCode: string, n: { title: string; content?: string | null; link: string }): Promise<void> {
    const userIds = await this.shops.memberUserIdsWithPermission(shopId, permissionCode);
    await this.notify.notifyMany(userIds.map((userId) => ({ userId, type: 'order', title: n.title, content: n.content ?? null, link: n.link })), tx);
  }

  /* Thông báo cho nhân viên sàn có mã quyền `permissionCode`. */
  async staffNotify(tx: Tx, permissionCode: string, n: { title: string; content?: string | null; link: string }): Promise<void> {
    const staff = await this.users.staffUserIdsWithPermission(permissionCode);
    await this.notify.notifyMany(staff.map((userId) => ({ userId, type: 'order', title: n.title, content: n.content ?? null, link: n.link })), tx);
  }
}
