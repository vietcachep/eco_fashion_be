import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { SETTING_KEY } from '../../system/enums/setting-keys';
import { SystemQueryApi } from '../../system/queryapi/system.queryapi';
import { OrderAuditLogService } from '../audit/order-audit-log.service';
import { ORDER_AUDIT, ORDER_STATUS, RETURN_ESCALATE_SOURCE, RETURN_STATUS } from '../foundation/order.constants';
import { boundedSetting } from './return.rules';
import { ReturnCoreService } from './return-core.service';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/* Nhắc shop khi còn ≤ 24 giờ là hết hạn duyệt (đúng PLAN-0022 §7). */
const REMIND_BEFORE_MS = 24 * HOUR;
/* Mỗi lô tối đa 100, tối đa 10 lô mỗi hạn mỗi lần chạy — tồn đọng lớn (sau khi worker nghỉ lâu) được dọn dần qua các lần chạy sau. */
const BATCH = 100;
const MAX_BATCHES = 10;
/*
 * Cảnh báo đơn `shipping` quá hạn: chỉ đơn gửi đi trong 90 ngày gần nhất (đơn cũ hơn gần như chắc chắn đã được xử lý ngoài hệ thống — tránh báo ồ ạt mọi đơn tồn sau deploy) và
 * tối đa 200 đơn mỗi lần chạy (2 lô × 100); phần còn lại được báo dần ở các lần chạy sau.
 */
const SHIPPING_ALERT_MAX_AGE_DAYS = 90;
const SHIPPING_ALERT_MAX_BATCHES = 2;

export interface SlaResult {
  shopTimeouts: number;
  expired: number;
  receiveTimeouts: number;
  reminded: number;
  shippingAlerts: number;
}

/*
 * Job SLA đổi trả (PLAN-0022 §3) — chạy mỗi 10 phút ở worker: hết hạn thì HỆ THỐNG chuyển bước, không ai âm thầm làm thay ai.
 *   1. requested quá `return.shop_respond_hours`        ⇒ escalated (shop_timeout) — báo CSKH + shop + khách
 *   2. approved, khách chưa gửi, quá `return.ship_back_days` ⇒ expired — báo khách + shop
 *   3. approved, khách đã báo gửi, quá `return.shop_receive_days` ⇒ escalated (shop_receive_timeout)
 *   4. requested còn ≤ 24 giờ hết hạn duyệt ⇒ nhắc shop MỘT lần (`shop_reminded_at`)
 *   5. đơn `shipping` quá `order.shipping_alert_days` (gửi trong 90 ngày gần nhất, ≤ 200 đơn/lần chạy) ⇒ cảnh báo shop + CSKH MỘT lần (`orders.shipping_alerted_at`)
 *
 * Idempotent + an toàn nhiều instance worker: mỗi dòng xử lý trong MỘT transaction — khoá dòng (FOR UPDATE), ĐỌC LẠI trạng thái/hạn rồi mới đổi (đã đổi/chưa tới hạn ⇒ bỏ qua),
 * chuyển trạng thái bằng compare-and-set; nhắc/cảnh báo dùng compare-and-set `*_at IS NULL` cùng transaction với thông báo (thông báo lỗi ⇒ hoàn tác dấu, lần sau thử lại).
 * Một dòng lỗi không làm hỏng cả lô (ghi cảnh báo, loại khỏi các lô sau của lần chạy này). Quét bằng chỉ mục (status, *_due_at) — không tính lại hạn.
 */
@Injectable()
export class ReturnSlaService {
  private readonly logger = new Logger(ReturnSlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemQueryApi,
    private readonly audit: OrderAuditLogService,
    private readonly core: ReturnCoreService,
  ) {}

  async runAll(): Promise<SlaResult> {
    const shopTimeouts = await this.escalateShopTimeouts();
    const expired = await this.expireShipBack();
    const receiveTimeouts = await this.escalateReceiveTimeouts();
    const reminded = await this.remindShops();
    const shippingAlerts = await this.alertShippingOverdue();
    return { shopTimeouts, expired, receiveTimeouts, reminded, shippingAlerts };
  }

  /* Lặp theo lô tới hết (cũ nhất trước); `handle` trả true nếu dòng được xử lý thật. Lỗi một dòng ⇒ loại khỏi các lô sau. */
  private async drain(fetch: (exclude: string[]) => Promise<string[]>, handle: (id: string) => Promise<boolean>, what: string, maxBatches = MAX_BATCHES): Promise<number> {
    let n = 0;
    const failed = new Set<string>();
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const ids = await fetch([...failed]);
      if (ids.length === 0) break;
      for (const id of ids) {
        try {
          if (await handle(id)) n += 1;
          else failed.add(id); // không đổi được (đã xử lý ở nơi khác / chưa tới hạn) — đừng gặp lại trong lần chạy này
        } catch (err) {
          failed.add(id);
          this.logger.warn({ err, id, what }, 'Job SLA đổi trả lỗi một dòng — bỏ qua');
        }
      }
      if (ids.length < BATCH) break;
    }
    return n;
  }

  private excluding(ids: string[]) {
    return ids.length > 0 ? { id: { notIn: ids } } : {};
  }

  /* 1. Shop không duyệt/từ chối kịp ⇒ chuyển sàn. */
  async escalateShopTimeouts(): Promise<number> {
    const n = await this.drain(
      async (exclude) => (await this.prisma.returnRequest.findMany({ where: { status: RETURN_STATUS.REQUESTED, shopRespondDueAt: { lt: new Date() }, ...this.excluding(exclude) }, orderBy: { shopRespondDueAt: 'asc' }, select: { id: true }, take: BATCH })).map((r) => r.id),
      (id) =>
        this.prisma.$transaction(async (tx: Tx) => {
          const r = await this.core.lock(tx, id);
          if (r.status !== RETURN_STATUS.REQUESTED || !r.shopRespondDueAt || r.shopRespondDueAt.getTime() >= Date.now()) return false;
          await this.core.escalate(tx, r, { source: RETURN_ESCALATE_SOURCE.SHOP_TIMEOUT, reason: 'Shop không duyệt hoặc từ chối trong thời hạn quy định', actor: null });
          return true;
        }),
      'shop_timeout',
    );
    if (n > 0) this.logger.log({ n }, 'Đã chuyển sàn các yêu cầu đổi trả shop quá hạn duyệt');
    return n;
  }

  /* 2. Khách duyệt xong mà không gửi hàng kịp ⇒ hết hiệu lực. */
  async expireShipBack(): Promise<number> {
    const n = await this.drain(
      async (exclude) =>
        (await this.prisma.returnRequest.findMany({ where: { status: RETURN_STATUS.APPROVED, requireReturn: true, shippedBackAt: null, shipBackDueAt: { lt: new Date() }, ...this.excluding(exclude) }, orderBy: { shipBackDueAt: 'asc' }, select: { id: true }, take: BATCH })).map((r) => r.id),
      (id) =>
        this.prisma.$transaction(async (tx: Tx) => {
          const r = await this.core.lock(tx, id);
          if (r.status !== RETURN_STATUS.APPROVED || r.shippedBackAt || !r.shipBackDueAt || r.shipBackDueAt.getTime() >= Date.now()) return false;
          await this.core.move(tx, r, RETURN_STATUS.EXPIRED, { closedAt: new Date(), shipBackDueAt: null, shopReceiveDueAt: null }, null);
          await this.audit.write(tx, null, { action: ORDER_AUDIT.RETURN_EXPIRED, entityType: 'return_request', entityId: r.id, entityCode: r.orderCode, before: { status: r.status }, after: { status: RETURN_STATUS.EXPIRED, reason: 'ship_back_timeout' } });
          await this.core.customerNote(tx, r, `Yêu cầu đổi trả đơn ${r.orderCode} đã hết hiệu lực`, 'Bạn chưa gửi hàng trả trong thời hạn quy định. Nếu vẫn cần đổi trả, hãy tạo yêu cầu mới (còn trong hạn đổi trả).');
          await this.core.shopNote(tx, r.shopId, r.id, `Yêu cầu đổi trả đơn ${r.orderCode} đã hết hiệu lực`, 'Khách không gửi hàng trả đúng hạn.');
          return true;
        }),
      'ship_back_timeout',
    );
    if (n > 0) this.logger.log({ n }, 'Đã đóng các yêu cầu đổi trả khách không gửi hàng đúng hạn');
    return n;
  }

  /* 3. Khách đã báo gửi mà shop không xác nhận nhận hàng kịp ⇒ chuyển sàn. */
  async escalateReceiveTimeouts(): Promise<number> {
    const n = await this.drain(
      async (exclude) =>
        (await this.prisma.returnRequest.findMany({ where: { status: RETURN_STATUS.APPROVED, requireReturn: true, shippedBackAt: { not: null }, shopReceiveDueAt: { lt: new Date() }, ...this.excluding(exclude) }, orderBy: { shopReceiveDueAt: 'asc' }, select: { id: true }, take: BATCH })).map((r) => r.id),
      (id) =>
        this.prisma.$transaction(async (tx: Tx) => {
          const r = await this.core.lock(tx, id);
          if (r.status !== RETURN_STATUS.APPROVED || !r.shippedBackAt || !r.shopReceiveDueAt || r.shopReceiveDueAt.getTime() >= Date.now()) return false;
          await this.core.escalate(tx, r, { source: RETURN_ESCALATE_SOURCE.SHOP_RECEIVE_TIMEOUT, reason: 'Khách đã báo gửi hàng trả nhưng shop không xác nhận nhận hàng trong thời hạn quy định', actor: null });
          return true;
        }),
      'shop_receive_timeout',
    );
    if (n > 0) this.logger.log({ n }, 'Đã chuyển sàn các yêu cầu đổi trả shop quá hạn xác nhận nhận hàng');
    return n;
  }

  /* 4. Nhắc shop còn ≤ 24 giờ hết hạn duyệt — MỘT lần mỗi yêu cầu. */
  async remindShops(): Promise<number> {
    const now = new Date();
    const n = await this.drain(
      async (exclude) =>
        (await this.prisma.returnRequest.findMany({ where: { status: RETURN_STATUS.REQUESTED, shopRemindedAt: null, shopRespondDueAt: { gt: now, lte: new Date(now.getTime() + REMIND_BEFORE_MS) }, ...this.excluding(exclude) }, orderBy: { shopRespondDueAt: 'asc' }, select: { id: true }, take: BATCH })).map((r) => r.id),
      (id) =>
        this.prisma.$transaction(async (tx: Tx) => {
          const claimed = await tx.returnRequest.updateMany({ where: { id, status: RETURN_STATUS.REQUESTED, shopRemindedAt: null }, data: { shopRemindedAt: new Date() } });
          if (claimed.count === 0) return false;
          const r = await tx.returnRequest.findUniqueOrThrow({ where: { id }, select: { id: true, orderCode: true, shopId: true } });
          await this.core.shopNote(tx, r.shopId, r.id, `Sắp hết hạn duyệt đổi trả đơn ${r.orderCode}`, 'Còn dưới 24 giờ để duyệt hoặc từ chối — quá hạn yêu cầu sẽ chuyển sàn phân xử.');
          return true;
        }),
      'remind',
    );
    if (n > 0) this.logger.log({ n }, 'Đã nhắc shop các yêu cầu đổi trả sắp hết hạn duyệt');
    return n;
  }

  /* 5. Đơn `shipping` quá lâu (thất lạc? COD bom?) ⇒ cảnh báo shop + CSKH MỘT lần; lối thoát: shop báo giao không thành công / CSKH huỷ khi tranh chấp. */
  async alertShippingOverdue(): Promise<number> {
    const days = boundedSetting(await this.system.settingNumber(SETTING_KEY.ORDER_SHIPPING_ALERT_DAYS), 'days', 10);
    const now = Date.now();
    const before = new Date(now - days * DAY);
    const oldest = new Date(now - SHIPPING_ALERT_MAX_AGE_DAYS * DAY);
    const n = await this.drain(
      async (exclude) => (await this.prisma.order.findMany({ where: { status: ORDER_STATUS.SHIPPING, isDeleted: false, shippedAt: { lt: before, gte: oldest }, shippingAlertedAt: null, ...this.excluding(exclude) }, orderBy: { shippedAt: 'asc' }, select: { id: true }, take: BATCH })).map((o) => o.id),
      (id) =>
        this.prisma.$transaction(async (tx: Tx) => {
          const claimed = await tx.order.updateMany({ where: { id, status: ORDER_STATUS.SHIPPING, shippingAlertedAt: null }, data: { shippingAlertedAt: new Date() } });
          if (claimed.count === 0) return false;
          const o = await tx.order.findUniqueOrThrow({ where: { id }, select: { id: true, code: true, shopId: true } });
          const content = `Đơn đang giao quá ${days} ngày chưa có kết quả — hãy kiểm tra với đơn vị vận chuyển; giao không thành công thì báo trên đơn để huỷ/hoàn tiền.`;
          await this.core.shopNotify(tx, o.shopId, 'shop.order.update', { title: `Đơn ${o.code} đang giao quá hạn`, content, link: `/vendor/orders/${o.code}` });
          await this.core.staffNotify(tx, 'order.return.process', { title: `Đơn ${o.code} đang giao quá hạn`, content, link: `/order/orders/${o.code}` });
          await this.audit.write(tx, null, { action: ORDER_AUDIT.SHIPPING_OVERDUE_ALERTED, entityType: 'order', entityId: o.id, entityCode: o.code, after: { alertDays: days } });
          return true;
        }),
      'shipping_alert',
      SHIPPING_ALERT_MAX_BATCHES,
    );
    if (n > 0) this.logger.log({ n, days }, 'Đã cảnh báo đơn đang giao quá hạn');
    return n;
  }
}
