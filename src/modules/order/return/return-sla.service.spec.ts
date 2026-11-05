import { Logger } from '@nestjs/common';
import { ORDER_AUDIT, ORDER_STATUS } from '../foundation/order.constants';
import { buildHarness, CS_STAFF, CUSTOMER, DAY, HOUR, mkOrderLike, mkReturn, SHOP, SHOP_STAFF } from '../../../../test/helpers/return-harness';

/*
 * Job SLA đổi trả (PLAN-0022 §3): hết hạn thì HỆ THỐNG chuyển bước. Mỗi hạn một nhóm test: chuyển đúng bước + thông báo đúng người, không đụng dòng chưa tới hạn / sai trạng thái,
 * idempotent (chạy lại không làm gì thêm), một dòng lỗi không chặn cả lô. Nhắc shop trước 24h (một lần) và cảnh báo đơn `shipping` quá hạn (một lần).
 */

let warn: jest.SpyInstance<void, [message: unknown, ...optionalParams: unknown[]]>;
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

describe('ReturnSlaService — shop quá hạn duyệt/từ chối (return.shop_respond_hours)', () => {
  it('requested quá hạn ⇒ escalated (shop_timeout): báo CSKH + shop + khách, audit hệ thống, outbox', async () => {
    const h = buildHarness({ returns: [mkReturn({ shopRespondDueAt: ago(HOUR) })] });
    expect(await h.sla.escalateShopTimeouts()).toBe(1);
    expect(h.ret()).toMatchObject({ status: 'escalated', escalateSource: 'shop_timeout', shopRespondDueAt: null });
    expect(h.ret().escalatedAt).toBeInstanceOf(Date);
    expect(h.ret().escalateReason).toContain('Shop không duyệt');
    expect(h.notesTo(CS_STAFF)[0]).toMatchObject({ title: 'Đổi trả đơn DH260001 cần phân xử', link: '/order/returns/rr-1' });
    expect(h.notesTo(SHOP_STAFF)[0].title).toBe('Đổi trả đơn DH260001 đã chuyển sàn phân xử');
    expect(h.notesTo(CUSTOMER)).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ action: ORDER_AUDIT.RETURN_ESCALATED, actor: null });
    expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:escalated']);
  });

  it('chưa tới hạn / đã được shop xử lý / sai trạng thái ⇒ không đụng', async () => {
    const h = buildHarness({ returns: [mkReturn({ id: 'future', shopRespondDueAt: ahead(HOUR) }), mkReturn({ id: 'approved', status: 'approved', shopRespondDueAt: ago(HOUR) }), mkReturn({ id: 'rejected', status: 'rejected', shopRespondDueAt: ago(HOUR) }), mkReturn({ id: 'nodue', shopRespondDueAt: null })] });
    expect(await h.sla.escalateShopTimeouts()).toBe(0);
    expect(['future', 'approved', 'rejected', 'nodue'].map((id) => h.ret(id).status)).toEqual(['requested', 'approved', 'rejected', 'requested']);
    expect(h.notes).toHaveLength(0);
  });

  it('idempotent: chạy lại không chuyển/thông báo thêm', async () => {
    const h = buildHarness({ returns: [mkReturn({ shopRespondDueAt: ago(HOUR) })] });
    await h.sla.escalateShopTimeouts();
    const notes = h.notes.length;
    expect(await h.sla.escalateShopTimeouts()).toBe(0);
    expect(h.notes).toHaveLength(notes);
    expect(h.events).toHaveLength(1);
  });

  it('shop vừa duyệt giữa lúc quét và lúc khoá (đọc lại thấy approved) ⇒ bỏ qua, không đổi', async () => {
    const h = buildHarness({ returns: [mkReturn({ shopRespondDueAt: ago(HOUR) })] });
    // finder "cũ" thấy yêu cầu, nhưng khi khoá thì shop đã duyệt xong
    h.mocks.returnRequest.findMany.mockImplementationOnce(() => Promise.resolve([{ ...h.ret() }]));
    h.returns.set('rr-1', { ...h.ret(), status: 'approved', shopRespondDueAt: null });
    expect(await h.sla.escalateShopTimeouts()).toBe(0);
    expect(h.ret().status).toBe('approved');
    expect(h.notes).toHaveLength(0);
  });

  it('một dòng LỖI không chặn các dòng khác (hoàn tác dòng lỗi, ghi cảnh báo, không lặp vô hạn)', async () => {
    const h = buildHarness({ returns: [mkReturn({ id: 'a', orderCode: 'DH-A', shopRespondDueAt: ago(3 * HOUR) }), mkReturn({ id: 'b', orderCode: 'DH-B', shopRespondDueAt: ago(2 * HOUR) }), mkReturn({ id: 'c', orderCode: 'DH-C', shopRespondDueAt: ago(HOUR) })] });
    const real = h.core.escalate.bind(h.core);
    jest.spyOn(h.core, 'escalate').mockImplementation((tx, r, p) => (r.id === 'b' ? Promise.reject(new Error('lỗi giả')) : real(tx, r, p)));
    expect(await h.sla.escalateShopTimeouts()).toBe(2);
    expect([h.ret('a').status, h.ret('b').status, h.ret('c').status]).toEqual(['escalated', 'requested', 'escalated']);
    expect(warn.mock.calls.some((c) => (c[0] as { id: string }).id === 'b')).toBe(true);
  });

  it('tồn đọng nhiều hơn một lô (105 dòng) vẫn xử lý hết trong một lần chạy', async () => {
    const rows = Array.from({ length: 105 }, (_, i) => mkReturn({ id: `r${i}`, orderCode: `DH${i}`, shopRespondDueAt: ago((200 - i) * HOUR) }));
    const h = buildHarness({ returns: rows });
    expect(await h.sla.escalateShopTimeouts()).toBe(105);
    expect([...h.returns.values()].every((r) => r.status === 'escalated')).toBe(true);
  });
});

describe('ReturnSlaService — khách không gửi hàng kịp (return.ship_back_days)', () => {
  const approved = (over = {}) => mkReturn({ status: 'approved', approvedAt: ago(8 * DAY), shopRespondDueAt: null, shipBackDueAt: ago(HOUR), ...over });

  it('approved + chưa gửi + quá hạn ⇒ expired: đóng yêu cầu, báo khách + shop (không báo CSKH)', async () => {
    const h = buildHarness({ returns: [approved()] });
    expect(await h.sla.expireShipBack()).toBe(1);
    expect(h.ret()).toMatchObject({ status: 'expired', shipBackDueAt: null });
    expect(h.ret().closedAt).toBeInstanceOf(Date);
    expect(h.notesTo(CUSTOMER)[0].title).toBe('Yêu cầu đổi trả đơn DH260001 đã hết hiệu lực');
    expect(h.notesTo(SHOP_STAFF)[0].title).toBe('Yêu cầu đổi trả đơn DH260001 đã hết hiệu lực');
    expect(h.notesTo(CS_STAFF)).toHaveLength(0);
    expect(h.auditActions()).toEqual([ORDER_AUDIT.RETURN_EXPIRED]);
    expect(h.eventTypes()).toEqual(['RETURN_STATUS_CHANGED:expired']);
  });

  it('đã báo gửi hàng · chưa tới hạn · không cần trả hàng · sai trạng thái ⇒ không đụng; chạy lại không làm gì', async () => {
    const h = buildHarness({ returns: [approved({ id: 'shipped', shippedBackAt: ago(DAY), shopReceiveDueAt: ahead(DAY) }), approved({ id: 'future', shipBackDueAt: ahead(HOUR) }), approved({ id: 'noreturn', requireReturn: false }), mkReturn({ id: 'req', shipBackDueAt: ago(HOUR) }), approved({ id: 'due' })] });
    expect(await h.sla.expireShipBack()).toBe(1);
    expect(['shipped', 'future', 'noreturn', 'req', 'due'].map((id) => h.ret(id).status)).toEqual(['approved', 'approved', 'approved', 'requested', 'expired']);
    expect(await h.sla.expireShipBack()).toBe(0);
  });

  it('sau khi expired khách không báo gửi / rút được nữa', async () => {
    const h = buildHarness({ returns: [approved()] });
    await h.sla.expireShipBack();
    expect(h.ret().status).toBe('expired');
  });
});

describe('ReturnSlaService — shop không xác nhận nhận hàng kịp (return.shop_receive_days)', () => {
  const shipped = (over = {}) => mkReturn({ status: 'approved', approvedAt: ago(5 * DAY), shopRespondDueAt: null, shippedBackAt: ago(6 * DAY), shopReceiveDueAt: ago(HOUR), carrier: 'GHN', trackingCode: 'X1', ...over });

  it('approved + đã báo gửi + quá hạn nhận ⇒ escalated (shop_receive_timeout), báo CSKH + shop + khách', async () => {
    const h = buildHarness({ returns: [shipped()] });
    expect(await h.sla.escalateReceiveTimeouts()).toBe(1);
    expect(h.ret()).toMatchObject({ status: 'escalated', escalateSource: 'shop_receive_timeout', shopReceiveDueAt: null });
    expect(h.ret().escalateReason).toContain('không xác nhận nhận hàng');
    expect(h.notesTo(CS_STAFF)).toHaveLength(1);
    expect(h.notesTo(SHOP_STAFF)).toHaveLength(1);
    expect(h.notesTo(CUSTOMER)).toHaveLength(1);
    expect(await h.sla.escalateReceiveTimeouts()).toBe(0);
  });

  it('chưa báo gửi · chưa tới hạn · không cần trả hàng ⇒ không đụng', async () => {
    const h = buildHarness({ returns: [shipped({ id: 'notshipped', shippedBackAt: null }), shipped({ id: 'future', shopReceiveDueAt: ahead(HOUR) }), shipped({ id: 'noreturn', requireReturn: false })] });
    expect(await h.sla.escalateReceiveTimeouts()).toBe(0);
    expect(['notshipped', 'future', 'noreturn'].every((id) => h.ret(id).status === 'approved')).toBe(true);
  });
});

describe('ReturnSlaService — nhắc shop trước 24 giờ (một lần)', () => {
  it('còn ≤ 24 giờ ⇒ nhắc shop ĐÚNG MỘT LẦN (đặt shop_reminded_at); chạy lại không nhắc thêm', async () => {
    const h = buildHarness({ returns: [mkReturn({ shopRespondDueAt: ahead(10 * HOUR) })] });
    expect(await h.sla.remindShops()).toBe(1);
    expect(h.ret().shopRemindedAt).toBeInstanceOf(Date);
    expect(h.ret().status).toBe('requested');
    expect(h.notesTo(SHOP_STAFF)).toEqual([expect.objectContaining({ title: 'Sắp hết hạn duyệt đổi trả đơn DH260001', link: '/vendor/returns/rr-1' })]);
    expect(h.notesTo(CS_STAFF)).toHaveLength(0);
    expect(await h.sla.remindShops()).toBe(0);
    expect(h.notes).toHaveLength(1);
  });

  it('còn > 24 giờ · đã nhắc · quá hạn (việc của escalate) · không phải requested ⇒ không nhắc', async () => {
    const h = buildHarness({ returns: [mkReturn({ id: 'far', shopRespondDueAt: ahead(30 * HOUR) }), mkReturn({ id: 'done', shopRespondDueAt: ahead(5 * HOUR), shopRemindedAt: ago(HOUR) }), mkReturn({ id: 'late', shopRespondDueAt: ago(HOUR) }), mkReturn({ id: 'appr', status: 'approved', shopRespondDueAt: ahead(5 * HOUR) })] });
    expect(await h.sla.remindShops()).toBe(0);
    expect(h.notes).toHaveLength(0);
  });

  it('gửi thông báo lỗi ⇒ hoàn tác dấu nhắc (lần chạy sau thử lại, không mất nhắc)', async () => {
    const h = buildHarness({ returns: [mkReturn({ shopRespondDueAt: ahead(5 * HOUR) })] });
    h.control.failNotify = true;
    expect(await h.sla.remindShops()).toBe(0);
    expect(h.ret().shopRemindedAt).toBeNull();
    h.control.failNotify = false;
    expect(await h.sla.remindShops()).toBe(1);
  });
});

describe('ReturnSlaService — đơn shipping quá hạn (order.shipping_alert_days = 10)', () => {
  const stuck = (over = {}) => mkOrderLike({ status: ORDER_STATUS.SHIPPING, deliveredAt: null, shippedAt: ago(11 * DAY), ...over });

  it('shipping quá 10 ngày ⇒ cảnh báo shop (thành viên xử lý đơn) + CSKH MỘT lần, đánh dấu trên đơn, audit', async () => {
    const h = buildHarness({ orders: [stuck()] });
    expect(await h.sla.alertShippingOverdue()).toBe(1);
    expect(h.order().shippingAlertedAt).toBeInstanceOf(Date);
    expect(h.mocks.shops.memberUserIdsWithPermission).toHaveBeenCalledWith(SHOP, 'shop.order.update');
    expect(h.mocks.users.staffUserIdsWithPermission).toHaveBeenCalledWith('order.return.process');
    expect(h.notesTo(SHOP_STAFF)[0]).toMatchObject({ title: 'Đơn DH260001 đang giao quá hạn', link: '/vendor/orders/DH260001' });
    expect(h.notesTo(CS_STAFF)[0]).toMatchObject({ title: 'Đơn DH260001 đang giao quá hạn', link: '/order/orders/DH260001' });
    expect(h.audits[0]).toMatchObject({ action: ORDER_AUDIT.SHIPPING_OVERDUE_ALERTED, entityCode: 'DH260001', actor: null });
    expect(await h.sla.alertShippingOverdue()).toBe(0);
    expect(h.notes).toHaveLength(2);
  });

  it('chưa quá hạn · không phải shipping · đã cảnh báo ⇒ không đụng', async () => {
    const h = buildHarness({ orders: [stuck({ code: 'A', id: 'oa', shippedAt: ago(5 * DAY) }), stuck({ code: 'B', id: 'ob', status: ORDER_STATUS.DELIVERED }), stuck({ code: 'C', id: 'oc', shippingAlertedAt: ago(DAY) })] });
    expect(await h.sla.alertShippingOverdue()).toBe(0);
    expect(h.notes).toHaveLength(0);
  });

  it('đọc ngưỡng từ setting: đổi thành 3 ngày thì đơn 5 ngày bị cảnh báo; giá trị sai được kẹp [1, 365] ngày', async () => {
    const h = buildHarness({ orders: [stuck({ shippedAt: ago(5 * DAY) })], settings: { 'order.shipping_alert_days': 3 } });
    expect(await h.sla.alertShippingOverdue()).toBe(1);
    // 0 ⇒ 1 ngày: đơn mới gửi 12 giờ chưa bị báo, đơn 2 ngày thì bị báo
    const zero = buildHarness({ orders: [stuck({ code: 'A', id: 'oa', shippedAt: ago(12 * HOUR) }), stuck({ code: 'B', id: 'ob', shippedAt: ago(2 * DAY) })], settings: { 'order.shipping_alert_days': 0 } });
    expect(await zero.sla.alertShippingOverdue()).toBe(1);
    expect(zero.order('B').shippingAlertedAt).toBeInstanceOf(Date);
    expect(zero.order('A').shippingAlertedAt).toBeNull();
    // quá lớn ⇒ 365 ngày: đơn 100 ngày (ngoài cửa sổ 90 ngày) cũng không bị báo; NaN ⇒ mặc định 10 ngày
    const huge = buildHarness({ orders: [stuck({ shippedAt: ago(60 * DAY) })], settings: { 'order.shipping_alert_days': 1e9 } });
    expect(await huge.sla.alertShippingOverdue()).toBe(0);
    const nan = buildHarness({ orders: [stuck({ shippedAt: ago(11 * DAY) })], settings: { 'order.shipping_alert_days': Number.NaN } });
    expect(await nan.sla.alertShippingOverdue()).toBe(1);
  });

  it('CHỈ cảnh báo đơn gửi đi trong 90 ngày gần nhất — đơn cũ hơn (tồn từ trước deploy) không bị báo ồ ạt', async () => {
    const h = buildHarness({ orders: [stuck({ code: 'OLD', id: 'o-old', shippedAt: ago(120 * DAY) }), stuck({ code: 'EDGE', id: 'o-edge', shippedAt: ago(89 * DAY) }), stuck({ code: 'NEW', id: 'o-new', shippedAt: ago(11 * DAY) })] });
    expect(await h.sla.alertShippingOverdue()).toBe(2);
    expect(h.order('OLD').shippingAlertedAt).toBeNull();
    expect(h.order('EDGE').shippingAlertedAt).toBeInstanceOf(Date);
    expect(h.order('NEW').shippingAlertedAt).toBeInstanceOf(Date);
  });

  it('tối đa 200 đơn mỗi lần chạy: 250 đơn ⇒ lần 1 báo 200 (cũ nhất trước), lần 2 báo nốt 50, lần 3 không còn gì', async () => {
    const orders = Array.from({ length: 250 }, (_, i) => stuck({ code: `S${i}`, id: `os${i}`, shippedAt: ago((80 - i / 10) * DAY) }));
    const h = buildHarness({ orders });
    expect(await h.sla.alertShippingOverdue()).toBe(200);
    expect([...h.orders.values()].filter((o) => o.shippingAlertedAt !== null)).toHaveLength(200);
    expect(h.order('S0').shippingAlertedAt).toBeInstanceOf(Date); // cũ nhất được báo trước
    expect(h.order('S249').shippingAlertedAt).toBeNull();
    expect(await h.sla.alertShippingOverdue()).toBe(50);
    expect(await h.sla.alertShippingOverdue()).toBe(0);
  });
});

describe('ReturnSlaService.runAll', () => {
  it('chạy đủ 5 việc và trả số lượng từng loại; chạy lần hai không còn gì', async () => {
    const h = buildHarness({
      returns: [
        mkReturn({ id: 'late', orderCode: 'DH1', shopRespondDueAt: ago(HOUR) }),
        mkReturn({ id: 'soon', orderCode: 'DH2', shopRespondDueAt: ahead(5 * HOUR) }),
        mkReturn({ id: 'exp', orderCode: 'DH3', status: 'approved', shopRespondDueAt: null, shipBackDueAt: ago(HOUR) }),
        mkReturn({ id: 'rcv', orderCode: 'DH4', status: 'approved', shopRespondDueAt: null, shippedBackAt: ago(DAY), shopReceiveDueAt: ago(HOUR) }),
      ],
      orders: [mkOrderLike({ status: ORDER_STATUS.SHIPPING, deliveredAt: null, shippedAt: ago(11 * DAY) })],
    });
    expect(await h.sla.runAll()).toEqual({ shopTimeouts: 1, expired: 1, receiveTimeouts: 1, reminded: 1, shippingAlerts: 1 });
    expect(await h.sla.runAll()).toEqual({ shopTimeouts: 0, expired: 0, receiveTimeouts: 0, reminded: 0, shippingAlerts: 0 });
  });
});
