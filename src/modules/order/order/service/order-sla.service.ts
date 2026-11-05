import { Inject, Injectable, Logger } from '@nestjs/common';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '../../../system/enums/setting-keys';
import { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { OrderAuditLogService } from '../../audit/order-audit-log.service';
import { CANCEL_SOURCE, ORDER_AUDIT_V2, ORDER_EVENT, ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, VIOLATION_KIND } from '../../foundation/order.constants';
import { OrderOutboxService } from '../../outbox/order-outbox.service';
import { ShopViolationService } from '../../violation/shop-violation.service';
import { OrderRepository } from '../repository/order.repository';
import { OrderFulfilmentService } from './order-fulfilment.service';
import { OrderService } from './order.service';

const HOUR = 3_600_000;
/* Nhắc shop MỘT lần: còn ≤ 6 giờ là hết hạn xác nhận · còn ≤ 12 giờ là hết hạn giao (docs/10 §3). */
const CONFIRM_REMIND_BEFORE_MS = 6 * HOUR;
const SHIP_REMIND_BEFORE_MS = 12 * HOUR;
/* Job chạy mỗi 5 phút; nghỉ quá 30 phút (SLA vừa bật / bật lại, worker sập) ⇒ "rebase" các hạn đã trễ — xem OrderRepository.beginSlaTick. */
export const SLA_MAX_GAP_MS = 30 * 60_000;
const BATCH = 100;
const MAX_BATCHES = 10;
const DEFAULT_CONFIRM_HOURS = 24;
const DEFAULT_SHIP_HOURS = 48;
const DEFAULT_CANCEL_REQUEST_HOURS = 24;

export interface OrderSlaResult {
  /* false = SLA đang tắt (`order.sla_enabled`) hoặc worker khác đang chạy lượt này ⇒ không làm gì. */
  ran: boolean;
  rebased: boolean;
  confirmTimeouts: number;
  shipTimeouts: number;
  requestsAutoAccepted: number;
  remindedConfirm: number;
  remindedShip: number;
}

const IDLE: OrderSlaResult = { ran: false, rebased: false, confirmTimeouts: 0, shipTimeouts: 0, requestsAutoAccepted: 0, remindedConfirm: 0, remindedShip: 0 };

/*
 * Job SLA đơn hàng (PLAN-0027 §2.1; chạy mỗi 5 phút ở worker, hoặc `npm run job -- order-sla`):
 *   1. `pending` quá `confirm_due_at` ⇒ tự huỷ (hệ thống, `shop_confirm_timeout`) + hoàn tiền nếu đã trả + 1 điểm vi phạm + báo khách/shop;
 *   2. `confirmed`/`packing` quá `ship_due_at` ⇒ tự huỷ (`shop_ship_timeout`) + nhập lại kho + hoàn + 1 điểm vi phạm;
 *   3. yêu cầu huỷ (đơn đóng gói) shop im lặng quá hạn ⇒ tự chấp nhận (OrderFulfilmentService.autoAcceptCancelRequest);
 *   4. nhắc shop MỘT lần: còn 6 giờ xác nhận / 12 giờ giao.
 *
 * ĐIỂM AN TOÀN (G72, FUL-14): (a) chạy CHỈ khi setting `order.sla_enabled` = true (mặc định TẮT); (b) chỉ xét đơn có hạn KHÁC NULL — đơn cũ đang treo (không có hạn) KHÔNG BAO GIỜ bị động tới;
 * (c) lần đầu bật / bật lại / nghỉ lâu ⇒ mọi hạn đã trễ lúc đó được đẩy sang "bây giờ + số giờ" (beginSlaTick) — không huỷ hàng loạt vì đơn trễ từ trước khi bật.
 * Idempotent + an toàn nhiều worker: khoá advisory chặn hai worker cùng mở lượt; mỗi đơn xử lý trong MỘT tx — FOR UPDATE, ĐỌC LẠI trạng thái + hạn rồi mới huỷ (đã đổi/chưa tới hạn ⇒ bỏ qua);
 * điểm vi phạm UNIQUE(order_code, kind) nên chạy lại không cộng hai lần; cờ nhắc là compare-and-set cùng tx với thông báo. Một đơn lỗi không làm hỏng cả lô.
 */
@Injectable()
export class OrderSlaService {
  private readonly logger = new Logger(OrderSlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OrderRepository,
    private readonly orders: OrderService,
    private readonly fulfilment: OrderFulfilmentService,
    private readonly system: SystemQueryApi,
    private readonly shops: ShopQueryApi,
    private readonly audit: OrderAuditLogService,
    private readonly outbox: OrderOutboxService,
    private readonly violations: ShopViolationService,
    @Inject(NOTIFICATION_GATEWAY) private readonly notify: NotificationGateway,
  ) {}

  private async hours(key: string, fallback: number): Promise<number> {
    const h = await this.system.settingNumber(key);
    return h > 0 ? h : fallback;
  }

  async runAll(): Promise<OrderSlaResult> {
    if (!(await this.system.settingBool(SETTING_KEY.ORDER_SLA_ENABLED))) return { ...IDLE };
    const hours = {
      confirm: await this.hours(SETTING_KEY.ORDER_SHOP_CONFIRM_HOURS, DEFAULT_CONFIRM_HOURS),
      ship: await this.hours(SETTING_KEY.ORDER_SHOP_SHIP_HOURS, DEFAULT_SHIP_HOURS),
      cancelRequest: await this.hours(SETTING_KEY.ORDER_CANCEL_REQUEST_HOURS, DEFAULT_CANCEL_REQUEST_HOURS),
    };
    const tick = await this.prisma.$transaction((tx) => this.repo.beginSlaTick(tx, new Date(), SLA_MAX_GAP_MS, hours));
    if (!tick.acquired) return { ...IDLE };
    if (tick.rebased) this.logger.warn('Job SLA đơn hàng chạy lại sau thời gian nghỉ (hoặc vừa bật lần đầu): các hạn đã trễ được đẩy sang "bây giờ + số giờ", không huỷ hàng loạt');
    const confirmTimeouts = await this.expireConfirm();
    const shipTimeouts = await this.expireShip();
    const requestsAutoAccepted = await this.autoAcceptCancelRequests();
    const remindedConfirm = await this.remindConfirm();
    const remindedShip = await this.remindShip();
    return { ran: true, rebased: tick.rebased, confirmTimeouts, shipTimeouts, requestsAutoAccepted, remindedConfirm, remindedShip };
  }

  /* Lặp theo lô (cũ nhất trước); `handle` trả true nếu đơn được xử lý thật. Lỗi / không xử lý được một đơn ⇒ loại khỏi các lô sau của lần chạy này (không "đói" các đơn tốt đứng sau). */
  private async drain(fetch: (exclude: string[]) => Promise<Array<{ code: string }>>, handle: (code: string) => Promise<boolean>, what: string): Promise<number> {
    let n = 0;
    const skip = new Set<string>();
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await fetch([...skip]);
      if (rows.length === 0) break;
      for (const { code } of rows) {
        try {
          if (await handle(code)) n += 1;
          else skip.add(code);
        } catch (err) {
          skip.add(code);
          this.logger.warn({ err, code, what }, 'Job SLA đơn hàng lỗi một đơn — bỏ qua');
        }
      }
      if (rows.length < BATCH) break;
    }
    return n;
  }

  /* 1. Shop không xác nhận kịp. Đơn PayOS chưa trả không có hạn xác nhận (do job huỷ quá hạn thanh toán lo) — kiểm lại cho chắc. */
  async expireConfirm(): Promise<number> {
    const n = await this.drain(
      (exclude) => this.repo.findConfirmOverdue(new Date(), BATCH, exclude),
      (code) =>
        this.prisma.$transaction(async (tx) => {
          const o = await this.repo.findByCodeForUpdate(code, tx);
          if (!o || o.status !== ORDER_STATUS.PENDING || !o.confirmDueAt || o.confirmDueAt.getTime() >= Date.now()) return false;
          if (o.paymentMethodCode !== PAYMENT_METHOD.COD && o.paymentStatus !== PAYMENT_STATUS.PAID) return false;
          const paid = o.paymentStatus === PAYMENT_STATUS.PAID;
          await this.orders.doCancel(o, 'Shop không xác nhận đơn trong thời hạn quy định', null, tx, {
            source: CANCEL_SOURCE.SYSTEM,
            reasonCode: 'shop_confirm_timeout',
            notify: { title: `Đơn ${o.code} đã huỷ vì shop không xác nhận`, content: `Gian hàng không xác nhận đơn đúng hạn.${paid ? ' Chúng tôi sẽ hoàn lại toàn bộ số tiền bạn đã thanh toán.' : ''} Xin lỗi bạn vì sự bất tiện.` },
            notifyShop: { title: `Đơn ${o.code} đã tự huỷ vì quá hạn xác nhận`, content: 'Đơn quá hạn xác nhận nên bị huỷ; gian hàng bị ghi 1 điểm vi phạm.', permission: 'shop.order.read' },
          });
          await this.violations.record(tx, { shopId: o.shopId, orderCode: o.code, kind: VIOLATION_KIND.CONFIRM_TIMEOUT });
          return true;
        }),
      'confirm_timeout',
    );
    if (n > 0) this.logger.log({ n }, 'Đã tự huỷ đơn shop không xác nhận đúng hạn');
    return n;
  }

  /* 2. Shop không giao kịp (confirmed/packing). Hàng chưa rời shop ⇒ doCancel nhập lại kho. */
  async expireShip(): Promise<number> {
    const n = await this.drain(
      (exclude) => this.repo.findShipOverdue(new Date(), BATCH, exclude),
      (code) =>
        this.prisma.$transaction(async (tx) => {
          const o = await this.repo.findByCodeForUpdate(code, tx);
          if (!o || (o.status !== ORDER_STATUS.CONFIRMED && o.status !== ORDER_STATUS.PACKING) || !o.shipDueAt || o.shipDueAt.getTime() >= Date.now()) return false;
          const paid = o.paymentStatus === PAYMENT_STATUS.PAID;
          await this.orders.doCancel(o, 'Shop không giao hàng trong thời hạn quy định', null, tx, {
            source: CANCEL_SOURCE.SYSTEM,
            reasonCode: 'shop_ship_timeout',
            notify: { title: `Đơn ${o.code} đã huỷ vì shop không giao hàng đúng hạn`, content: `Gian hàng không giao hàng đúng hạn.${paid ? ' Chúng tôi sẽ hoàn lại toàn bộ số tiền bạn đã thanh toán.' : ''} Xin lỗi bạn vì sự bất tiện.` },
            notifyShop: { title: `Đơn ${o.code} đã tự huỷ vì quá hạn giao`, content: 'Đơn quá hạn giao nên bị huỷ, hàng đã được nhập lại kho; gian hàng bị ghi 1 điểm vi phạm.', permission: 'shop.order.read' },
          });
          await this.violations.record(tx, { shopId: o.shopId, orderCode: o.code, kind: VIOLATION_KIND.SHIP_TIMEOUT });
          return true;
        }),
      'ship_timeout',
    );
    if (n > 0) this.logger.log({ n }, 'Đã tự huỷ đơn shop không giao đúng hạn');
    return n;
  }

  /* 3. Yêu cầu huỷ của khách mà shop im lặng ⇒ tự chấp nhận. */
  async autoAcceptCancelRequests(): Promise<number> {
    const n = await this.drain(
      (exclude) => this.repo.findCancelRequestsDue(new Date(), BATCH, exclude),
      (code) => this.fulfilment.autoAcceptCancelRequest(code),
      'cancel_request_timeout',
    );
    if (n > 0) this.logger.log({ n }, 'Đã tự chấp nhận yêu cầu huỷ đơn shop không phản hồi');
    return n;
  }

  private async remind(kind: 'confirm' | 'ship', code: string, tx: Tx, dueAt: Date, shopId: string): Promise<void> {
    const members = await this.shops.memberUserIdsWithPermission(shopId, 'shop.order.update');
    const title = kind === 'confirm' ? `Đơn ${code} sắp quá hạn xác nhận` : `Đơn ${code} sắp quá hạn giao`;
    const content =
      kind === 'confirm'
        ? 'Còn dưới 6 giờ để xác nhận đơn. Quá hạn đơn sẽ tự huỷ (hoàn tiền cho khách) và gian hàng bị tính điểm vi phạm.'
        : 'Còn dưới 12 giờ để giao đơn (có mã vận đơn). Cần thêm thời gian có thể gia hạn MỘT lần kèm lý do. Quá hạn đơn sẽ tự huỷ và gian hàng bị tính điểm vi phạm.';
    await this.notify.notifyMany(members.map((userId) => ({ userId, type: 'order', title, content, link: `/vendor/orders/${code}` })), tx);
    await this.audit.write(tx, null, { action: ORDER_AUDIT_V2.SLA_REMINDED, entityType: 'order', entityCode: code, after: { kind, dueAt: dueAt.toISOString() } });
    await this.outbox.publish(tx, { eventType: ORDER_EVENT.SLA_REMINDER, aggregateType: 'order', aggregateId: code, payload: { orderCode: code, shopId, kind, dueAt: dueAt.toISOString() } });
  }

  /* 4a. Nhắc xác nhận — compare-and-set `confirm_reminded_at IS NULL` cùng tx với thông báo (thông báo lỗi ⇒ hoàn tác dấu, lần sau thử lại). */
  async remindConfirm(): Promise<number> {
    const n = await this.drain(
      (exclude) => this.repo.findConfirmToRemind(new Date(), CONFIRM_REMIND_BEFORE_MS, BATCH, exclude),
      (code) =>
        this.prisma.$transaction(async (tx) => {
          const claimed = await tx.order.updateMany({ where: { code, status: ORDER_STATUS.PENDING, confirmRemindedAt: null, confirmDueAt: { gt: new Date() } }, data: { confirmRemindedAt: new Date() } });
          if (claimed.count === 0) return false;
          const o = await tx.order.findUniqueOrThrow({ where: { code }, select: { shopId: true, confirmDueAt: true } });
          await this.remind('confirm', code, tx, o.confirmDueAt as Date, o.shopId);
          return true;
        }),
      'remind_confirm',
    );
    if (n > 0) this.logger.log({ n }, 'Đã nhắc shop các đơn sắp quá hạn xác nhận');
    return n;
  }

  /* 4b. Nhắc giao. */
  async remindShip(): Promise<number> {
    const n = await this.drain(
      (exclude) => this.repo.findShipToRemind(new Date(), SHIP_REMIND_BEFORE_MS, BATCH, exclude),
      (code) =>
        this.prisma.$transaction(async (tx) => {
          const claimed = await tx.order.updateMany({ where: { code, status: { in: [ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING] }, shipRemindedAt: null, shipDueAt: { gt: new Date() } }, data: { shipRemindedAt: new Date() } });
          if (claimed.count === 0) return false;
          const o = await tx.order.findUniqueOrThrow({ where: { code }, select: { shopId: true, shipDueAt: true } });
          await this.remind('ship', code, tx, o.shipDueAt as Date, o.shopId);
          return true;
        }),
      'remind_ship',
    );
    if (n > 0) this.logger.log({ n }, 'Đã nhắc shop các đơn sắp quá hạn giao');
    return n;
  }
}
