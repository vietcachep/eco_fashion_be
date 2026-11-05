import { Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { NotifyCommand } from '@common/gateway/notification.gateway';
import type { PrismaService } from '@common/prisma/prisma.service';
import { type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '../../../system/enums/setting-keys';
import type { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { ORDER_ERR, ORDER_ERR_V2, ORDER_EVENT, ORDER_STATUS } from '../../foundation/order.constants';
import type { OrderRepository, OrderRow } from '../repository/order.repository';
import { OrderFulfilmentService } from './order-fulfilment.service';
import type { OrderService } from './order.service';

/*
 * Lối thoát & hạn chót của đơn (PLAN-0027): yêu cầu huỷ đơn đóng gói (CAN-04) · gia hạn giao (FUL-07) · đổi địa chỉ (CAN-14) · "Đã nhận hàng" (SHP-02) · shop bị khoá (SHOP-01c).
 * OrderFulfilmentService chạy THẬT; kho đơn là bộ nhớ, OrderService.doCancel được giả để kiểm ĐÚNG tham số (nguồn huỷ, mã lý do, kiểu thông báo) — phần tiền/kho của doCancel đã có test ở order-lifecycle.spec.ts.
 */
const TX = { __tx: true } as unknown as Tx;
const USER = 'user-1';
const SHOP = 'shop-1';
const HOUR = 3_600_000;
const customer: AuthenticatedActor = { userId: USER, email: 'khach@fitly.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 't1' };
const shopUser: AuthenticatedActor = { userId: 'shop-user-1', email: 'shop@fitly.vn', roleCode: 'shop_owner', permissionVersion: 1, tokenId: 't2' };
const SETTINGS: Record<string, number> = { [SETTING_KEY.ORDER_CANCEL_REQUEST_HOURS]: 24, [SETTING_KEY.ORDER_SHOP_SHIP_HOURS]: 48 };

type Row = Record<string, unknown> & { id: string; code: string };

function mk(n: number, over: Record<string, unknown> = {}): Row {
  return {
    id: `o${n}`,
    code: `DH26100${n}`,
    userId: USER,
    shopId: SHOP,
    status: ORDER_STATUS.PACKING,
    paymentStatus: 'paid',
    paymentMethodCode: 'payos',
    provinceName: 'TP. Hồ Chí Minh',
    recipientName: 'Nguyễn Văn A',
    recipientPhone: '0901234567',
    shippingAddress: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
    cancelRequestStatus: null,
    cancelRequestReasonCode: null,
    cancelRequestNote: null,
    cancelRequestDueAt: null,
    shipDueAt: null,
    shipExtendedAt: null,
    completedBy: null,
    items: [{ productId: 'prod-1', quantity: 2 }],
    ...over,
  };
}

function build(seed: Row[], opts: { shopStatus?: string } = {}) {
  const state = new Map(seed.map((r) => [r.code, { ...r }]));
  const openReturns = new Set<string>();
  const view = (r: Row | undefined) => (r ? ({ ...r } as unknown as OrderRow) : null);
  const findByCodeForUpdate = jest.fn((code: string, _tx: Tx): Promise<OrderRow | null> => Promise.resolve(view(state.get(code))));
  const update = jest.fn((id: string, data: Record<string, unknown>, _tx: Tx): Promise<OrderRow> => {
    const r = [...state.values()].find((x) => x.id === id);
    if (!r) return Promise.reject(new Error('kho giả: không có đơn'));
    Object.assign(r, data);
    return Promise.resolve(view(r) as OrderRow);
  });
  const addHistory = jest.fn((_id: string, _from: string | null, _to: string, _note: string | null, _by: string | null, _tx: Tx): Promise<void> => Promise.resolve());
  const hasOpenReturn = jest.fn((orderId: string, _tx?: Tx | null): Promise<boolean> => Promise.resolve(openReturns.has(orderId)));
  const findByShopAndStatus = jest.fn((shopId: string, statuses: string[], limit: number, exclude: string[] = []): Promise<Array<{ code: string; status: string }>> =>
    Promise.resolve([...state.values()].filter((r) => r.shopId === shopId && statuses.includes(r.status as string) && !exclude.includes(r.code)).slice(0, limit).map((r) => ({ code: r.code, status: r.status as string }))),
  );
  const openCountsByShop = jest.fn((shopId: string, statuses: string[]): Promise<Record<string, number>> =>
    Promise.resolve(Object.fromEntries(statuses.map((s) => [s, [...state.values()].filter((r) => r.shopId === shopId && r.status === s).length]))),
  );
  const repo = { findByCodeForUpdate, update, addHistory, hasOpenReturn, findByShopAndStatus, openCountsByShop } as unknown as OrderRepository;
  const doCancel = jest.fn((o: OrderRow, _reason: string, _actor: unknown, _tx: Tx, _opts: Record<string, unknown>): Promise<void> => {
    const r = state.get(o.code);
    if (r) r.status = ORDER_STATUS.CANCELLED;
    return Promise.resolve();
  });
  const orders = { doCancel } as unknown as OrderService;
  const prisma = { $transaction: jest.fn((fn: (tx: Tx) => Promise<unknown>) => fn(TX)) } as unknown as PrismaService;
  const audit = { write: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) };
  const publish = jest.fn((_tx: Tx, _e: { eventType: string; payload: Record<string, unknown> }): Promise<void> => Promise.resolve());
  const system = { settingNumber: jest.fn((k: string): Promise<number> => Promise.resolve(SETTINGS[k] ?? 0)) } as unknown as SystemQueryApi;
  const memberUserIdsWithPermission = jest.fn((_shopId: string, _perm: string): Promise<string[]> => Promise.resolve(['shop-user-1']));
  const findBrief = jest.fn((_id: string) => Promise.resolve({ id: SHOP, name: 'Shop A', status: opts.shopStatus ?? 'suspended' }));
  const shops = { memberUserIdsWithPermission, findBrief } as unknown as ShopQueryApi;
  const notifyOne = jest.fn((_c: NotifyCommand, _tx?: Tx): Promise<void> => Promise.resolve());
  const notifyMany = jest.fn((_c: NotifyCommand[], _tx?: Tx): Promise<void> => Promise.resolve());
  const addSold = jest.fn((_i: unknown, _tx?: Tx): Promise<void> => Promise.resolve());
  const service = new OrderFulfilmentService(prisma, repo, orders, audit as never, { publish } as never, system, shops, { notify: notifyOne, notifyMany }, { addSold, setRating: jest.fn(), addView: jest.fn() });
  return { service, state, openReturns, update, addHistory, doCancel, publish, memberUserIdsWithPermission, notifyOne, notifyMany, addSold, audit, findByShopAndStatus };
}

const events = (f: ReturnType<typeof build>) => f.publish.mock.calls.map((c) => c[1]);
const statusOf = (f: ReturnType<typeof build>, code = 'DH261001') => f.state.get(code)?.status;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ====================================================================== khách yêu cầu huỷ đơn đang đóng gói
describe('OrderFulfilmentService — yêu cầu huỷ đơn đang đóng gói', () => {
  it('[CAN-04] khách gửi yêu cầu: lưu trạng thái pending + hạn (order.cancel_request_hours), báo shop có quyền shop.order.cancel, phát ORDER_CANCEL_REQUESTED', async () => {
    const f = build([mk(1)]);
    await f.service.requestCancel(customer, 'DH261001', { reasonCode: 'changed_mind', note: 'Đổi kế hoạch' });
    const data = f.update.mock.calls[0][1] as { cancelRequestStatus: string; cancelRequestDueAt: Date; cancelRequestReasonCode: string; cancelRequestNote: string };
    expect(data).toMatchObject({ cancelRequestStatus: 'pending', cancelRequestReasonCode: 'changed_mind', cancelRequestNote: 'Đổi kế hoạch' });
    expect(Math.abs(data.cancelRequestDueAt.getTime() - (Date.now() + 24 * HOUR))).toBeLessThan(5_000);
    expect(statusOf(f)).toBe(ORDER_STATUS.PACKING); // chưa huỷ — chờ shop
    expect(f.memberUserIdsWithPermission).toHaveBeenCalledWith(SHOP, 'shop.order.cancel');
    expect(f.notifyMany.mock.calls[0][0]).toMatchObject([{ userId: 'shop-user-1', title: 'Khách yêu cầu huỷ đơn DH261001', link: '/vendor/orders/DH261001' }]);
    expect(events(f).map((e) => e.eventType)).toEqual([ORDER_EVENT.CANCEL_REQUESTED]);
    expect(events(f)[0].payload).toMatchObject({ orderCode: 'DH261001', shopId: SHOP, reasonCode: 'changed_mind' });
  });

  it('[CAN-04] mỗi đơn MỘT yêu cầu: đang chờ hoặc đã bị từ chối ⇒ 409 CANCEL_REQUEST_EXISTS; đơn pending/confirmed ⇒ gợi ý huỷ trực tiếp; từ shipping trở đi ⇒ CANNOT_CANCEL; đơn người khác ⇒ 404', async () => {
    const f = build([mk(1, { cancelRequestStatus: 'pending' }), mk(2, { cancelRequestStatus: 'rejected' }), mk(3, { status: ORDER_STATUS.CONFIRMED }), mk(4, { status: ORDER_STATUS.SHIPPING }), mk(5, { userId: 'nguoi-khac' })]);
    for (const code of ['DH261001', 'DH261002']) await expect(f.service.requestCancel(customer, code, { reasonCode: 'other' })).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.CANCEL_REQUEST_EXISTS, httpStatus: 409 });
    await expect(f.service.requestCancel(customer, 'DH261003', { reasonCode: 'other' })).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL, details: { hint: 'cancel_direct' } });
    await expect(f.service.requestCancel(customer, 'DH261004', { reasonCode: 'other' })).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
    await expect(f.service.requestCancel(customer, 'DH261005', { reasonCode: 'other' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.requestCancel(customer, 'DH261001', { reasonCode: 'out_of_stock' })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' }); // mã của bên khác
    expect(f.update).not.toHaveBeenCalled();
  });

  it('[CAN-04] shop CHẤP NHẬN: huỷ qua doCancel với nguồn customer + mã lý do của yêu cầu, không báo lại shop, chốt accepted; thiếu yêu cầu ⇒ 409; đơn shop khác ⇒ 404', async () => {
    const f = build([mk(1, { cancelRequestStatus: 'pending', cancelRequestReasonCode: 'changed_mind', cancelRequestNote: 'Đổi kế hoạch' }), mk(2), mk(3, { shopId: 'shop-khac', cancelRequestStatus: 'pending' })]);
    await f.service.acceptCancelRequest(shopUser, SHOP, 'DH261001');
    expect(statusOf(f)).toBe(ORDER_STATUS.CANCELLED);
    const [o, reason, actor, , opts] = f.doCancel.mock.calls[0];
    expect(o.code).toBe('DH261001');
    expect(reason).toBe('Khách yêu cầu huỷ, shop đã chấp nhận: Đổi ý, không muốn mua nữa — Đổi kế hoạch');
    expect(actor).toBe(shopUser);
    expect(opts).toMatchObject({ source: 'customer', reasonCode: 'changed_mind', notifyShop: false, requestResolution: 'accepted' });
    expect(events(f).map((e) => e.eventType)).toEqual([ORDER_EVENT.CANCEL_REQUEST_RESOLVED]);
    await expect(f.service.acceptCancelRequest(shopUser, SHOP, 'DH261002')).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.CANCEL_REQUEST_NOT_FOUND });
    await expect(f.service.acceptCancelRequest(shopUser, SHOP, 'DH261003')).rejects.toBeInstanceOf(NotFoundException);
    expect(f.doCancel).toHaveBeenCalledTimes(1);
  });

  it('[CAN-04] shop TỪ CHỐI: lý do ≥ 10 ký tự, đơn tiếp tục (vẫn packing), khách được báo kèm lý do, hạn xử lý bị xoá; từ chối lần hai ⇒ 409', async () => {
    const f = build([mk(1, { cancelRequestStatus: 'pending', cancelRequestDueAt: new Date(Date.now() + HOUR) })]);
    await expect(f.service.rejectCancelRequest(shopUser, SHOP, 'DH261001', 'không')).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
    await f.service.rejectCancelRequest(shopUser, SHOP, 'DH261001', 'Hàng đã giao cho đơn vị vận chuyển, không thể huỷ');
    expect(statusOf(f)).toBe(ORDER_STATUS.PACKING);
    expect(f.state.get('DH261001')).toMatchObject({ cancelRequestStatus: 'rejected', cancelRequestDueAt: null, cancelRequestRejectReason: 'Hàng đã giao cho đơn vị vận chuyển, không thể huỷ', cancelRequestResolvedBy: 'shop-user-1' });
    expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, title: 'Shop từ chối yêu cầu huỷ đơn DH261001' });
    expect(f.notifyOne.mock.calls[0][0].content).toContain('Hàng đã giao cho đơn vị vận chuyển');
    expect(f.doCancel).not.toHaveBeenCalled();
    await expect(f.service.rejectCancelRequest(shopUser, SHOP, 'DH261001', 'Từ chối thêm một lần nữa')).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.CANCEL_REQUEST_NOT_FOUND });
  });

  it('[CAN-04] shop im lặng quá hạn ⇒ job TỰ CHẤP NHẬN (auto_accepted, nguồn customer, báo shop); chưa tới hạn / đã xử lý ⇒ false và không đụng gì', async () => {
    const f = build([
      mk(1, { cancelRequestStatus: 'pending', cancelRequestReasonCode: 'other', cancelRequestDueAt: new Date(Date.now() - HOUR) }),
      mk(2, { cancelRequestStatus: 'pending', cancelRequestReasonCode: 'other', cancelRequestDueAt: new Date(Date.now() + HOUR) }),
      mk(3, { cancelRequestStatus: 'rejected', cancelRequestDueAt: new Date(Date.now() - HOUR) }),
    ]);
    expect(await f.service.autoAcceptCancelRequest('DH261001')).toBe(true);
    expect(f.doCancel.mock.calls[0][4]).toMatchObject({ source: 'customer', requestResolution: 'auto_accepted', notifyShop: { permission: 'shop.order.read' } });
    expect(f.doCancel.mock.calls[0][2]).toBeNull(); // hệ thống, không có người thao tác
    expect(await f.service.autoAcceptCancelRequest('DH261002')).toBe(false);
    expect(await f.service.autoAcceptCancelRequest('DH261003')).toBe(false);
    expect(await f.service.autoAcceptCancelRequest('DH261001')).toBe(false); // chạy lại sau khi đã huỷ: idempotent
    expect(f.doCancel).toHaveBeenCalledTimes(1);
  });
});

// ====================================================================== gia hạn giao
describe('OrderFulfilmentService.extendShip — gia hạn giao MỘT lần', () => {
  const REASON = 'Hàng đặt trước, nhà cung cấp giao muộn 2 ngày';

  it('[FUL-07] gia hạn: ship_due_at += order.shop_ship_hours, ghi lý do + thời điểm, xoá cờ nhắc, báo khách', async () => {
    const due = new Date(Date.now() + 10 * HOUR);
    const f = build([mk(1, { status: ORDER_STATUS.CONFIRMED, shipDueAt: due })]);
    await f.service.extendShip(shopUser, SHOP, 'DH261001', REASON);
    const data = f.update.mock.calls[0][1] as { shipDueAt: Date; shipExtendedAt: Date; shipExtendReason: string; shipRemindedAt: null };
    expect(data.shipDueAt.getTime()).toBe(due.getTime() + 48 * HOUR);
    expect(data).toMatchObject({ shipExtendReason: REASON, shipRemindedAt: null });
    expect(data.shipExtendedAt).toBeInstanceOf(Date);
    expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, title: 'Shop gia hạn thời gian giao đơn DH261001' });
  });

  it('[FUL-07] lần hai bị chặn (SHIP_ALREADY_EXTENDED); quá hạn ⇒ SHIP_OVERDUE; đơn cũ không có hạn ⇒ SHIP_NO_DEADLINE; lý do < 10 ký tự ⇒ 400; sai trạng thái ⇒ 409; đơn shop khác ⇒ 404', async () => {
    const future = new Date(Date.now() + HOUR);
    const f = build([
      mk(1, { status: ORDER_STATUS.CONFIRMED, shipDueAt: future }),
      mk(2, { status: ORDER_STATUS.PACKING, shipDueAt: future, shipExtendedAt: new Date() }),
      mk(3, { status: ORDER_STATUS.PACKING, shipDueAt: new Date(Date.now() - HOUR) }),
      mk(4, { status: ORDER_STATUS.CONFIRMED, shipDueAt: null }),
      mk(5, { status: ORDER_STATUS.SHIPPING, shipDueAt: future }),
    ]);
    await f.service.extendShip(shopUser, SHOP, 'DH261001', REASON);
    await expect(f.service.extendShip(shopUser, SHOP, 'DH261001', REASON)).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.SHIP_ALREADY_EXTENDED });
    await expect(f.service.extendShip(shopUser, SHOP, 'DH261002', REASON)).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.SHIP_ALREADY_EXTENDED });
    await expect(f.service.extendShip(shopUser, SHOP, 'DH261003', REASON)).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.SHIP_OVERDUE });
    await expect(f.service.extendShip(shopUser, SHOP, 'DH261004', REASON)).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.SHIP_NO_DEADLINE });
    await expect(f.service.extendShip(shopUser, SHOP, 'DH261005', REASON)).rejects.toMatchObject({ errorCode: ORDER_ERR.INVALID_TRANSITION });
    await expect(f.service.extendShip(shopUser, SHOP, 'DH261001', 'ngắn')).rejects.toBeInstanceOf(BusinessException);
    await expect(f.service.extendShip(shopUser, 'shop-khac', 'DH261001', REASON)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.update).toHaveBeenCalledTimes(1);
  });
});

// ====================================================================== đổi địa chỉ
describe('OrderFulfilmentService.changeAddress — đổi địa chỉ nhận', () => {
  const input = { recipientName: 'Người mới', recipientPhone: '0911222333', addressLine: '1 Lê Lợi', ward: 'Bến Nghé', district: 'Quận 1', province: 'Hồ Chí Minh' };

  it.each([ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED])('[CAN-14] đơn %s: cập nhật người nhận/SĐT/địa chỉ, ghi lịch sử trước→sau, báo shop (shop.order.update), phát ORDER_ADDRESS_CHANGED', async (status) => {
    const f = build([mk(1, { status })]);
    await f.service.changeAddress(customer, 'DH261001', input);
    expect(f.update.mock.calls[0][1]).toMatchObject({ recipientName: 'Người mới', recipientPhone: '0911222333', street: '1 Lê Lợi', wardName: 'Bến Nghé', districtName: 'Quận 1', shippingAddress: '1 Lê Lợi, Bến Nghé, Quận 1, TP. Hồ Chí Minh' });
    const note = f.addHistory.mock.calls[0][3] as string;
    expect(note).toContain('Nguyễn Văn A, 0901234567, 12 Nguyễn Huệ');
    expect(note).toContain('→ Người mới, 0911222333, 1 Lê Lợi');
    expect(f.memberUserIdsWithPermission).toHaveBeenCalledWith(SHOP, 'shop.order.update');
    expect(f.notifyMany.mock.calls[0][0]).toMatchObject([{ title: 'Khách đổi địa chỉ nhận đơn DH261001' }]);
    expect(events(f).map((e) => e.eventType)).toEqual([ORDER_EVENT.ADDRESS_CHANGED]);
  });

  it('[CAN-14] đơn PACKING (hoặc muộn hơn) ⇒ 409 ADDRESS_LOCKED; đổi sang tỉnh/thành KHÁC ⇒ 409 ADDRESS_PROVINCE_CHANGED (phí ship không tính lại); đơn người khác ⇒ 404', async () => {
    const f = build([mk(1), mk(2, { status: ORDER_STATUS.SHIPPING }), mk(3, { status: ORDER_STATUS.PENDING }), mk(4, { status: ORDER_STATUS.PENDING, userId: 'nguoi-khac' })]);
    await expect(f.service.changeAddress(customer, 'DH261001', input)).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.ADDRESS_LOCKED, httpStatus: 409 });
    await expect(f.service.changeAddress(customer, 'DH261002', input)).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.ADDRESS_LOCKED });
    await expect(f.service.changeAddress(customer, 'DH261003', { ...input, province: 'Hà Nội' })).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.ADDRESS_PROVINCE_CHANGED, httpStatus: 409 });
    await expect(f.service.changeAddress(customer, 'DH261004', input)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.notifyMany).not.toHaveBeenCalled();
  });
});

// ====================================================================== "Đã nhận hàng"
describe('OrderFulfilmentService.markReceived — khách xác nhận đã nhận hàng', () => {
  it('[SHP-02] delivered → completed ngay: completedBy = customer, cộng đã bán, báo shop, phát ORDER_STATUS_CHANGED (ví COD nghe sự kiện này)', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.DELIVERED })]);
    await f.service.markReceived(customer, 'DH261001');
    expect(statusOf(f)).toBe(ORDER_STATUS.COMPLETED);
    expect(f.update.mock.calls[0][1]).toMatchObject({ status: 'completed', completedBy: 'customer' });
    expect(f.addHistory).toHaveBeenCalledWith('o1', ORDER_STATUS.DELIVERED, ORDER_STATUS.COMPLETED, 'Khách xác nhận đã nhận hàng', USER, TX);
    expect(f.addSold).toHaveBeenCalledWith([{ productId: 'prod-1', quantity: 2 }], TX);
    expect(f.memberUserIdsWithPermission).toHaveBeenCalledWith(SHOP, 'shop.order.read');
    expect(events(f)).toEqual([expect.objectContaining({ eventType: ORDER_EVENT.STATUS_CHANGED, payload: { orderCode: 'DH261001', userId: USER, from: 'delivered', to: 'completed' } })]);
  });

  it('[SHP-02] không cho khi còn đổi trả / "chưa nhận hàng" mở (409 HAS_OPEN_RETURN), khi chưa giao (409 NOT_DELIVERED), đơn người khác (404); bấm lại sau khi đã hoàn tất ⇒ thành công, không ghi lại', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.DELIVERED }), mk(2, { status: ORDER_STATUS.SHIPPING }), mk(3, { status: ORDER_STATUS.DELIVERED, userId: 'nguoi-khac' }), mk(4, { status: ORDER_STATUS.COMPLETED, completedBy: 'customer' })]);
    f.openReturns.add('o1');
    await expect(f.service.markReceived(customer, 'DH261001')).rejects.toMatchObject({ errorCode: ORDER_ERR.HAS_OPEN_RETURN, httpStatus: 409 });
    await expect(f.service.markReceived(customer, 'DH261002')).rejects.toMatchObject({ errorCode: ORDER_ERR_V2.NOT_DELIVERED });
    await expect(f.service.markReceived(customer, 'DH261003')).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.markReceived(customer, 'DH261004')).resolves.toBeUndefined();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.addSold).not.toHaveBeenCalled();
  });
});

// ====================================================================== shop bị khoá
describe('OrderFulfilmentService — shop bị khoá (SHOP-01c/f)', () => {
  it('[SHOP-01c] pending/confirmed tự huỷ (hệ thống, mã shop_suspended, không báo chính shop); packing/shipping KHÔNG bị động tới', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.PENDING }), mk(2, { status: ORDER_STATUS.CONFIRMED }), mk(3, { status: ORDER_STATUS.PACKING }), mk(4, { status: ORDER_STATUS.SHIPPING })]);
    expect(await f.service.cancelOpenOrdersOfSuspendedShop(SHOP)).toEqual({ cancelled: 2, failed: 0 });
    expect(['DH261001', 'DH261002'].map((c) => statusOf(f, c))).toEqual([ORDER_STATUS.CANCELLED, ORDER_STATUS.CANCELLED]);
    expect(['DH261003', 'DH261004'].map((c) => statusOf(f, c))).toEqual([ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING]);
    for (const call of f.doCancel.mock.calls) {
      expect(call[2]).toBeNull();
      expect(call[4]).toMatchObject({ source: 'system', reasonCode: 'shop_suspended', notifyShop: false });
    }
  });

  it('[SHOP-01c] shop đã được mở khoá lại trước khi xử lý sự kiện ⇒ không huỷ oan; chạy lại sau khi đã huỷ hết ⇒ 0 (idempotent)', async () => {
    const approved = build([mk(1, { status: ORDER_STATUS.PENDING })], { shopStatus: 'approved' });
    expect(await approved.service.cancelOpenOrdersOfSuspendedShop(SHOP)).toEqual({ cancelled: 0, failed: 0 });
    expect(approved.doCancel).not.toHaveBeenCalled();
    const f = build([mk(1, { status: ORDER_STATUS.PENDING })]);
    expect((await f.service.cancelOpenOrdersOfSuspendedShop(SHOP)).cancelled).toBe(1);
    expect((await f.service.cancelOpenOrdersOfSuspendedShop(SHOP)).cancelled).toBe(0);
  });

  it('[SHOP-01c] một đơn lỗi không chặn cả lô: đơn còn lại vẫn huỷ, đếm failed để relay thử lại', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.PENDING }), mk(2, { status: ORDER_STATUS.CONFIRMED })]);
    f.doCancel.mockRejectedValueOnce(new Error('kho lỗi'));
    expect(await f.service.cancelOpenOrdersOfSuspendedShop(SHOP)).toEqual({ cancelled: 1, failed: 1 });
    expect(statusOf(f, 'DH261002')).toBe(ORDER_STATUS.CANCELLED);
  });

  it('[SHOP-01f] đơn đóng gói/đang giao ⇒ MỘT thông báo cho CSKH kèm số lượng + mã đơn; shop đã mở khoá hoặc không có đơn ⇒ không báo', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.PACKING }), mk(2, { status: ORDER_STATUS.PACKING }), mk(3, { status: ORDER_STATUS.SHIPPING })]);
    expect(await f.service.alertSupportAboutHeldOrders(TX, SHOP, ['cs-1', 'cs-2'])).toBe(3);
    const notes = f.notifyMany.mock.calls[0][0];
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ userId: 'cs-1', title: 'Gian hàng Shop A bị khoá — 3 đơn đang đóng gói/đang giao cần xử lý' });
    expect(notes[0].content).toContain('Đang đóng gói: 2 · đang giao: 1');
    expect(notes[0].content).toContain('DH261001');
    const none = build([mk(1, { status: ORDER_STATUS.PENDING })]);
    expect(await none.service.alertSupportAboutHeldOrders(TX, SHOP, ['cs-1'])).toBe(0);
    expect(none.notifyMany).not.toHaveBeenCalled();
    const reopened = build([mk(1, { status: ORDER_STATUS.PACKING })], { shopStatus: 'approved' });
    expect(await reopened.service.alertSupportAboutHeldOrders(TX, SHOP, ['cs-1'])).toBe(0);
    expect(reopened.notifyMany).not.toHaveBeenCalled();
  });
});
