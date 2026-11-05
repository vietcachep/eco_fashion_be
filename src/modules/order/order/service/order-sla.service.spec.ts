import { Logger } from '@nestjs/common';
import type { NotifyCommand } from '@common/gateway/notification.gateway';
import type { PrismaService } from '@common/prisma/prisma.service';
import { type Tx } from '@common/prisma/types';
import type { ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '../../../system/enums/setting-keys';
import type { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { ORDER_EVENT, ORDER_STATUS, VIOLATION_KIND } from '../../foundation/order.constants';
import type { ShopViolationService } from '../../violation/shop-violation.service';
import type { OrderRepository, OrderRow } from '../repository/order.repository';
import type { OrderFulfilmentService } from './order-fulfilment.service';
import { OrderSlaService, SLA_MAX_GAP_MS } from './order-sla.service';
import type { OrderService } from './order.service';

/*
 * Job SLA đơn hàng (PLAN-0027 §2.1): FUL-03 (nhắc đúng 1 lần), FUL-04 (quá hạn xác nhận), FUL-06 (quá hạn giao), FUL-14 + G72 (bật SLA không huỷ hàng loạt đơn cũ), CONC-05 (job ↔ thao tác của người cùng lúc).
 * OrderSlaService chạy THẬT; kho đơn là bộ nhớ với các finder mô phỏng đúng điều kiện SQL thật (chỉ đơn có hạn KHÁC NULL và đã quá hạn); OrderService.doCancel được giả để kiểm tham số.
 */
const HOUR = 3_600_000;
const SHOP = 'shop-1';

type Row = Record<string, unknown> & { id: string; code: string };
const mk = (n: number, over: Record<string, unknown> = {}): Row => ({
  id: `o${n}`,
  code: `DH26100${n}`,
  shopId: SHOP,
  userId: 'user-1',
  status: ORDER_STATUS.PENDING,
  paymentMethodCode: 'cod',
  paymentStatus: 'unpaid',
  confirmDueAt: null,
  shipDueAt: null,
  confirmRemindedAt: null,
  shipRemindedAt: null,
  cancelRequestStatus: null,
  cancelRequestDueAt: null,
  ...over,
});
const ago = (h: number) => new Date(Date.now() - h * HOUR);
const ahead = (h: number) => new Date(Date.now() + h * HOUR);

function build(seed: Row[], opts: { enabled?: boolean; acquired?: boolean; rebased?: boolean } = {}) {
  const state = new Map(seed.map((r) => [r.code, { ...r }]));
  const dueBefore = (key: string, now: Date) => (r: Row) => r[key] instanceof Date && r[key] < now;
  const select = (pred: (r: Row) => boolean, exclude: string[], limit: number, sortKey: string) =>
    Promise.resolve(
      [...state.values()]
        .filter((r) => pred(r) && !exclude.includes(r.code))
        .sort((a, b) => (a[sortKey] as Date).getTime() - (b[sortKey] as Date).getTime())
        .slice(0, limit)
        .map((r) => ({ code: r.code })),
    );
  const findConfirmOverdue = jest.fn((now: Date, limit: number, exclude: string[] = []) => select((r) => r.status === ORDER_STATUS.PENDING && dueBefore('confirmDueAt', now)(r), exclude, limit, 'confirmDueAt'));
  const findShipOverdue = jest.fn((now: Date, limit: number, exclude: string[] = []) => select((r) => (r.status === ORDER_STATUS.CONFIRMED || r.status === ORDER_STATUS.PACKING) && dueBefore('shipDueAt', now)(r), exclude, limit, 'shipDueAt'));
  const findCancelRequestsDue = jest.fn((now: Date, limit: number, exclude: string[] = []) => select((r) => r.status === ORDER_STATUS.PACKING && r.cancelRequestStatus === 'pending' && dueBefore('cancelRequestDueAt', now)(r), exclude, limit, 'cancelRequestDueAt'));
  const findConfirmToRemind = jest.fn((now: Date, within: number, limit: number, exclude: string[] = []) =>
    select((r) => r.status === ORDER_STATUS.PENDING && r.confirmRemindedAt == null && r.confirmDueAt instanceof Date && r.confirmDueAt > now && r.confirmDueAt.getTime() <= now.getTime() + within, exclude, limit, 'confirmDueAt'),
  );
  const findShipToRemind = jest.fn((now: Date, within: number, limit: number, exclude: string[] = []) =>
    select((r) => (r.status === ORDER_STATUS.CONFIRMED || r.status === ORDER_STATUS.PACKING) && r.shipRemindedAt == null && r.shipDueAt instanceof Date && r.shipDueAt > now && r.shipDueAt.getTime() <= now.getTime() + within, exclude, limit, 'shipDueAt'),
  );
  const findByCodeForUpdate = jest.fn((code: string, _tx: Tx): Promise<OrderRow | null> => Promise.resolve(state.has(code) ? ({ ...state.get(code) } as unknown as OrderRow) : null));
  const beginSlaTick = jest.fn((_tx: Tx, _now: Date, _gap: number, _hours: { confirm: number; ship: number; cancelRequest: number }) => Promise.resolve({ acquired: opts.acquired ?? true, rebased: opts.rebased ?? false }));
  const repo = { findConfirmOverdue, findShipOverdue, findCancelRequestsDue, findConfirmToRemind, findShipToRemind, findByCodeForUpdate, beginSlaTick } as unknown as OrderRepository;

  /* tx.order giả: updateMany = compare-and-set cho cờ nhắc (đúng điều kiện where của job), findUniqueOrThrow đọc hạn + shop. */
  const matchStatus = (cond: unknown, status: unknown) => (typeof cond === 'string' ? cond === status : Array.isArray((cond as { in?: unknown[] })?.in) && (cond as { in: unknown[] }).in.includes(status));
  const updateMany = jest.fn((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const r = state.get(args.where.code as string);
    const w = args.where;
    const ok =
      !!r &&
      matchStatus(w.status, r.status) &&
      ('confirmRemindedAt' in w ? r.confirmRemindedAt == null : true) &&
      ('shipRemindedAt' in w ? r.shipRemindedAt == null : true) &&
      (w.confirmDueAt ? (r.confirmDueAt as Date) > ((w.confirmDueAt as { gt: Date }).gt) : true) &&
      (w.shipDueAt ? (r.shipDueAt as Date) > ((w.shipDueAt as { gt: Date }).gt) : true);
    if (ok) Object.assign(r, args.data);
    return Promise.resolve({ count: ok ? 1 : 0 });
  });
  const findUniqueOrThrow = jest.fn((args: { where: { code: string } }) => {
    const r = state.get(args.where.code);
    return r ? Promise.resolve({ shopId: r.shopId, confirmDueAt: r.confirmDueAt, shipDueAt: r.shipDueAt }) : Promise.reject(new Error('không có đơn'));
  });
  const tx = { order: { updateMany, findUniqueOrThrow } } as unknown as Tx;
  const prisma = { $transaction: jest.fn((fn: (t: Tx) => Promise<unknown>) => fn(tx)) } as unknown as PrismaService;

  const doCancel = jest.fn((o: OrderRow, _reason: string, _actor: unknown, _tx: Tx, _opts: Record<string, unknown>): Promise<void> => {
    const r = state.get(o.code);
    if (r) r.status = ORDER_STATUS.CANCELLED;
    return Promise.resolve();
  });
  const orders = { doCancel } as unknown as OrderService;
  const autoAccept = jest.fn((code: string): Promise<boolean> => {
    const r = state.get(code);
    if (!r || r.cancelRequestStatus !== 'pending') return Promise.resolve(false);
    r.cancelRequestStatus = 'auto_accepted';
    r.status = ORDER_STATUS.CANCELLED;
    return Promise.resolve(true);
  });
  const fulfilment = { autoAcceptCancelRequest: autoAccept } as unknown as OrderFulfilmentService;
  const settings: Record<string, number> = { [SETTING_KEY.ORDER_SHOP_CONFIRM_HOURS]: 24, [SETTING_KEY.ORDER_SHOP_SHIP_HOURS]: 48, [SETTING_KEY.ORDER_CANCEL_REQUEST_HOURS]: 24 };
  const settingBool = jest.fn((_k: string): Promise<boolean> => Promise.resolve(opts.enabled ?? true));
  const system = { settingNumber: jest.fn((k: string): Promise<number> => Promise.resolve(settings[k] ?? 0)), settingBool } as unknown as SystemQueryApi;
  const memberUserIdsWithPermission = jest.fn((_s: string, _p: string): Promise<string[]> => Promise.resolve(['shop-user-1']));
  const shops = { memberUserIdsWithPermission } as unknown as ShopQueryApi;
  const record = jest.fn((_tx: Tx, _v: { shopId: string; orderCode: string; kind: string }): Promise<boolean> => Promise.resolve(true));
  const violations = { record } as unknown as ShopViolationService;
  const audit = { write: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) };
  const publish = jest.fn((_tx: Tx, _e: { eventType: string; payload: Record<string, unknown> }): Promise<void> => Promise.resolve());
  const notifyMany = jest.fn((_c: NotifyCommand[], _tx?: Tx): Promise<void> => Promise.resolve());
  const service = new OrderSlaService(prisma, repo, orders, fulfilment, system, shops, audit as never, { publish } as never, violations, { notify: jest.fn(), notifyMany });
  return { service, state, doCancel, record, beginSlaTick, settingBool, notifyMany, publish, autoAccept, memberUserIdsWithPermission, findConfirmOverdue, findShipOverdue };
}

const statusOf = (f: ReturnType<typeof build>, code: string) => f.state.get(code)?.status;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('OrderSlaService — điểm an toàn bật SLA (G72, FUL-14)', () => {
  it('[FUL-14] setting order.sla_enabled TẮT (mặc định) ⇒ job không làm gì: không mở lượt, không huỷ, không nhắc — kể cả đơn đã quá hạn', async () => {
    const f = build([mk(1, { confirmDueAt: ago(100) }), mk(2, { status: ORDER_STATUS.CONFIRMED, shipDueAt: ago(100) })], { enabled: false });
    const r = await f.service.runAll();
    expect(r.ran).toBe(false);
    expect(f.settingBool).toHaveBeenCalledWith('order.sla_enabled');
    expect(f.beginSlaTick).not.toHaveBeenCalled();
    expect(f.doCancel).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.PENDING);
  });

  it('[FUL-14] mở lượt với giờ cấu hình + ngưỡng nghỉ 30 phút; đơn CŨ (hạn NULL) KHÔNG BAO GIỜ bị động tới dù đơn tạo từ rất lâu', async () => {
    const f = build([mk(1, { confirmDueAt: null }), mk(2, { status: ORDER_STATUS.CONFIRMED, shipDueAt: null }), mk(3, { status: ORDER_STATUS.PACKING, shipDueAt: null, cancelRequestStatus: null })]);
    const r = await f.service.runAll();
    expect(r).toMatchObject({ ran: true, confirmTimeouts: 0, shipTimeouts: 0, requestsAutoAccepted: 0, remindedConfirm: 0, remindedShip: 0 });
    expect(f.beginSlaTick).toHaveBeenCalledTimes(1);
    expect(f.beginSlaTick.mock.calls[0][2]).toBe(SLA_MAX_GAP_MS);
    expect(f.beginSlaTick.mock.calls[0][3]).toEqual({ confirm: 24, ship: 48, cancelRequest: 24 });
    expect(f.doCancel).not.toHaveBeenCalled();
  });

  it('[FUL-14] lần đầu bật / nghỉ lâu ⇒ repo "rebase" hạn đã trễ (beginSlaTick báo rebased) và job báo cảnh báo; không có đơn nào bị huỷ nhờ lượt rebase', async () => {
    const f = build([mk(1, { confirmDueAt: ahead(24) })], { rebased: true });
    const r = await f.service.runAll();
    expect(r).toMatchObject({ ran: true, rebased: true, confirmTimeouts: 0 });
    expect(f.doCancel).not.toHaveBeenCalled();
  });

  it('worker khác đang giữ khoá advisory ⇒ bỏ lượt này, không làm gì', async () => {
    const f = build([mk(1, { confirmDueAt: ago(5) })], { acquired: false });
    expect((await f.service.runAll()).ran).toBe(false);
    expect(f.findConfirmOverdue).not.toHaveBeenCalled();
    expect(f.doCancel).not.toHaveBeenCalled();
  });
});

describe('OrderSlaService — quá hạn xác nhận / quá hạn giao', () => {
  it('[FUL-04] pending quá confirm_due_at ⇒ tự huỷ (hệ thống, shop_confirm_timeout) qua doCancel + 1 điểm vi phạm; chưa tới hạn thì giữ nguyên', async () => {
    const f = build([mk(1, { confirmDueAt: ago(1) }), mk(2, { paymentMethodCode: 'payos', paymentStatus: 'paid', confirmDueAt: ago(2) }), mk(3, { confirmDueAt: ahead(5) })]);
    const r = await f.service.runAll();
    expect(r.confirmTimeouts).toBe(2);
    expect(['DH261001', 'DH261002', 'DH261003'].map((c) => statusOf(f, c))).toEqual([ORDER_STATUS.CANCELLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.PENDING]);
    for (const call of f.doCancel.mock.calls) {
      expect(call[2]).toBeNull();
      expect(call[4]).toMatchObject({ source: 'system', reasonCode: 'shop_confirm_timeout', notifyShop: { permission: 'shop.order.read' } });
    }
    const paidNotify = (f.doCancel.mock.calls.find((c) => c[0].code === 'DH261002')?.[4] as { notify: { content: string } }).notify;
    expect(paidNotify.content).toContain('hoàn lại toàn bộ số tiền');
    expect(f.record.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining([{ shopId: SHOP, orderCode: 'DH261001', kind: VIOLATION_KIND.CONFIRM_TIMEOUT }, { shopId: SHOP, orderCode: 'DH261002', kind: VIOLATION_KIND.CONFIRM_TIMEOUT }]));
  });

  it('[FUL-04] đơn PayOS CHƯA trả không thuộc job này (hạn thanh toán do job khác lo) dù có hạn; chạy lại job ⇒ không huỷ/cộng điểm lần hai', async () => {
    const f = build([mk(1, { paymentMethodCode: 'payos', paymentStatus: 'unpaid', confirmDueAt: ago(3) }), mk(2, { confirmDueAt: ago(3) })]);
    await f.service.runAll();
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.PENDING);
    expect(statusOf(f, 'DH261002')).toBe(ORDER_STATUS.CANCELLED);
    const r2 = await f.service.runAll();
    expect(r2.confirmTimeouts).toBe(0);
    expect(f.doCancel).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenCalledTimes(1);
  });

  it('[FUL-06] confirmed/packing quá ship_due_at ⇒ tự huỷ (shop_ship_timeout) + 1 điểm ship_timeout; còn hạn / đang giao thì không', async () => {
    const f = build([
      mk(1, { status: ORDER_STATUS.CONFIRMED, shipDueAt: ago(1) }),
      mk(2, { status: ORDER_STATUS.PACKING, shipDueAt: ago(30), paymentMethodCode: 'payos', paymentStatus: 'paid' }),
      mk(3, { status: ORDER_STATUS.PACKING, shipDueAt: ahead(3) }),
      mk(4, { status: ORDER_STATUS.SHIPPING, shipDueAt: ago(10) }),
    ]);
    const r = await f.service.runAll();
    expect(r.shipTimeouts).toBe(2);
    expect(['DH261001', 'DH261002', 'DH261003', 'DH261004'].map((c) => statusOf(f, c))).toEqual([ORDER_STATUS.CANCELLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING]);
    expect(f.doCancel.mock.calls.every((c) => c[4].reasonCode === 'shop_ship_timeout' && c[4].source === 'system')).toBe(true);
    expect(f.record.mock.calls.map((c) => c[1].kind)).toEqual([VIOLATION_KIND.SHIP_TIMEOUT, VIOLATION_KIND.SHIP_TIMEOUT]);
  });

  it('[CONC-05] job thấy đơn quá hạn nhưng NGƯỜI vừa chuyển nó sang shipping/đã huỷ trước khi job khoá được ⇒ job bỏ qua (không vừa huỷ vừa shipping), không cộng điểm', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.PACKING, shipDueAt: ago(1) }), mk(2, { confirmDueAt: ago(1) })]);
    // finder (quét trước) trả cả hai đơn; trước khi khoá, người thao tác đổi trạng thái:
    const real = f.service as unknown as { repo: { findByCodeForUpdate: jest.Mock } };
    real.repo.findByCodeForUpdate.mockImplementation((code: string) => Promise.resolve({ ...f.state.get(code), status: code === 'DH261001' ? ORDER_STATUS.SHIPPING : ORDER_STATUS.CANCELLED }));
    const r = await f.service.runAll();
    expect(r.shipTimeouts).toBe(0);
    expect(r.confirmTimeouts).toBe(0);
    expect(f.doCancel).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });

  it('một đơn lỗi không làm hỏng cả lô: đơn khác vẫn huỷ, đơn lỗi không bị gặp lại trong lần chạy', async () => {
    const f = build([mk(1, { confirmDueAt: ago(5) }), mk(2, { confirmDueAt: ago(4) })]);
    f.doCancel.mockRejectedValueOnce(new Error('kho lỗi'));
    const r = await f.service.runAll();
    expect(r.confirmTimeouts).toBe(1);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.PENDING);
    expect(statusOf(f, 'DH261002')).toBe(ORDER_STATUS.CANCELLED);
    expect(f.doCancel).toHaveBeenCalledTimes(2);
  });
});

describe('OrderSlaService — yêu cầu huỷ & nhắc hạn', () => {
  it('[CAN-04] yêu cầu huỷ quá hạn ⇒ job gọi autoAcceptCancelRequest cho từng đơn tới hạn (chưa tới hạn không gọi)', async () => {
    const f = build([
      mk(1, { status: ORDER_STATUS.PACKING, cancelRequestStatus: 'pending', cancelRequestDueAt: ago(2) }),
      mk(2, { status: ORDER_STATUS.PACKING, cancelRequestStatus: 'pending', cancelRequestDueAt: ahead(2) }),
    ]);
    const r = await f.service.runAll();
    expect(r.requestsAutoAccepted).toBe(1);
    expect(f.autoAccept.mock.calls.map((c) => c[0])).toEqual(['DH261001']);
  });

  it('[FUL-03] còn ≤ 6h xác nhận ⇒ nhắc shop (shop.order.update) ĐÚNG 1 lần dù chạy nhiều lần; còn xa / quá hạn thì không nhắc', async () => {
    const f = build([mk(1, { confirmDueAt: ahead(5) }), mk(2, { confirmDueAt: ahead(20) }), mk(3, { confirmDueAt: ago(1) })]);
    const r1 = await f.service.runAll();
    expect(r1.remindedConfirm).toBe(1);
    expect((await f.service.runAll()).remindedConfirm).toBe(0);
    expect(f.memberUserIdsWithPermission).toHaveBeenCalledWith(SHOP, 'shop.order.update');
    const note = f.notifyMany.mock.calls.find((c) => c[0][0]?.title === 'Đơn DH261001 sắp quá hạn xác nhận');
    expect(note?.[0][0]).toMatchObject({ userId: 'shop-user-1', link: '/vendor/orders/DH261001' });
    expect(f.notifyMany.mock.calls.filter((c) => c[0][0]?.title.includes('sắp quá hạn xác nhận'))).toHaveLength(1);
    expect(f.publish.mock.calls.filter((c) => c[1].eventType === ORDER_EVENT.SLA_REMINDER)).toHaveLength(1);
    expect(f.state.get('DH261001')?.confirmRemindedAt).toBeInstanceOf(Date);
    expect(f.state.get('DH261002')?.confirmRemindedAt).toBeNull();
  });

  it('[FUL-03] còn ≤ 12h giao ⇒ nhắc 1 lần (confirmed/packing); đơn đã gia hạn xoá cờ nhắc thì được nhắc lại cho hạn mới', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.CONFIRMED, shipDueAt: ahead(10) }), mk(2, { status: ORDER_STATUS.PACKING, shipDueAt: ahead(40) })]);
    expect((await f.service.runAll()).remindedShip).toBe(1);
    expect((await f.service.runAll()).remindedShip).toBe(0);
    expect(f.notifyMany.mock.calls.some((c) => c[0][0]?.title === 'Đơn DH261001 sắp quá hạn giao')).toBe(true);
    Object.assign(f.state.get('DH261001') as object, { shipRemindedAt: null, shipDueAt: ahead(8) }); // như extendShip: dời hạn + xoá cờ
    expect((await f.service.runAll()).remindedShip).toBe(1);
  });
});
