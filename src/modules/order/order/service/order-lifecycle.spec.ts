import { Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { InventoryGateway } from '@common/gateway/inventory.gateway';
import type { NotifyCommand } from '@common/gateway/notification.gateway';
import type { PaymentGateway, RefundSummary } from '@common/gateway/payment.gateway';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { Basket, CartQueryApi } from '../../../cart/queryapi/cart.queryapi';
import type { ShopBrief, ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '../../../system/enums/setting-keys';
import type { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { ORDER_AUDIT, ORDER_ERR, ORDER_EVENT, ORDER_STATUS, PAYMENT_STATUS, STAFF_TRANSITIONS } from '../../foundation/order.constants';
import { OrderPaymentGatewayImpl } from '../../gateway/order-payment.gateway.impl';
import { ReturnService } from '../../return/return.service';
import type { OrderGroupResponse } from '../dto/order.responses';
import type { OrderRepository, OrderRow } from '../repository/order.repository';
import { OrderService } from './order.service';

/*
 * Vòng đời đơn (sau đợt sửa PLAN-0017): autoComplete theo lô + outbox, onPaid cho đơn đã huỷ/trả (tiền đến muộn → hoàn ngay), onRefunded luỹ kế,
 * canRetryPayment, hạn thanh toán PayOS, lưới chuyển trạng thái không còn `returned`, và công thức hoàn tiền đổi trả theo tỉ lệ trên total.
 * OrderService chạy THẬT; repository là kho đơn trong bộ nhớ (có rollback khi transaction ném lỗi) nên kiểm được cả trạng thái sau cùng. Đổi trả (ReturnService & các service theo vai): return/*.spec.ts.
 */

const USER = 'user-1';
const SHOP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DAY = 86_400_000;
const TX = { __tx: true } as unknown as Tx;
const actor: AuthenticatedActor = { userId: USER, email: 'khach@fitly.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-1' };
const staff: AuthenticatedActor = { userId: 'staff-1', email: 'nv@fitly.vn', roleCode: 'staff', permissionVersion: 1, tokenId: 'jti-2' };

interface OrderState {
  id: string;
  code: string;
  userId: string;
  shopId: string;
  orderGroupId: string;
  status: string;
  paymentStatus: string;
  paymentMethodCode: string;
  total: Prisma.Decimal;
  deliveredAt: Date | null;
  paymentExpiresAt: Date | null;
  items: Array<{ id: string; productId: string; variantId: string; quantity: number }>;
}

function mkOrder(n: number, over: Partial<OrderState> = {}): OrderState {
  return {
    id: `o${n}`,
    code: `DH26100${n}`,
    userId: USER,
    shopId: SHOP,
    orderGroupId: 'grp-1',
    status: ORDER_STATUS.PENDING,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMethodCode: 'payos',
    total: new Prisma.Decimal(430_000),
    deliveredAt: null,
    paymentExpiresAt: new Date(Date.now() + DAY),
    items: [{ id: `i${n}`, productId: `prod-${n}`, variantId: `var-${n}`, quantity: 2 }],
    ...over,
  };
}

/* Đơn đã giao cách đây `ageDays` ngày (sắp xếp "cũ nhất trước" theo deliveredAt). */
const delivered = (n: number, ageDays = 30 - n, over: Partial<OrderState> = {}) => mkOrder(n, { status: ORDER_STATUS.DELIVERED, paymentStatus: PAYMENT_STATUS.PAID, deliveredAt: new Date(Date.now() - ageDays * DAY), ...over });

interface AuditLike {
  action: string;
  entityType: string;
  entityId?: string | null;
  entityCode?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}
interface OutboxLike {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

const SETTINGS: Record<string, number> = {
  [SETTING_KEY.ORDER_AUTO_COMPLETE_DAYS]: 7,
  [SETTING_KEY.ORDER_ONLINE_PAYMENT_TIMEOUT_MINUTES]: 15,
  [SETTING_KEY.ORDER_COD_MAX_AMOUNT]: 0,
  [SETTING_KEY.ORDER_PAYMENT_GRACE_MINUTES]: 10,
  [SETTING_KEY.RETURN_WINDOW_DAYS]: 7,
  [SETTING_KEY.RETURN_NOT_RECEIVED_DAYS]: 3,
};

const brief: ShopBrief = { id: SHOP, code: 'S-A', slug: 'shop-a', name: 'Shop A', logoUrl: null, ratingAvg: null, status: 'approved', commissionRate: '5.00'  };
const ADDRESS = { recipientName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '79', provinceName: 'TP. Hồ Chí Minh', districtName: 'Q.1', wardName: null, street: '12 Nguyễn Huệ' };

function buildFixture(seed: OrderState[] = []) {
  const state = new Map(seed.map((o) => [o.code, { ...o }]));
  const snapshot = () => new Map([...state].map(([k, v]) => [k, { ...v }]));
  const view = (o: OrderState | undefined): OrderRow | null => (o ? ({ ...o } as unknown as OrderRow) : null);

  const findByCode = jest.fn((code: string): Promise<OrderRow | null> => Promise.resolve(view(state.get(code))));
  const findByCodeForUpdate = jest.fn((code: string, _tx: Tx): Promise<OrderRow | null> => Promise.resolve(view(state.get(code))));
  const findDeliveredBefore = jest.fn((before: Date, limit: number, exclude: string[] = []): Promise<Array<{ code: string }>> => {
    const rows = [...state.values()].filter((o) => o.status === ORDER_STATUS.DELIVERED && o.deliveredAt !== null && o.deliveredAt < before && !exclude.includes(o.code)).sort((a, b) => (a.deliveredAt as Date).getTime() - (b.deliveredAt as Date).getTime());
    return Promise.resolve(rows.slice(0, limit).map((o) => ({ code: o.code })));
  });
  const update = jest.fn((id: string, data: Prisma.OrderUncheckedUpdateInput, _tx: Tx): Promise<OrderRow> => {
    const o = [...state.values()].find((x) => x.id === id);
    if (!o) return Promise.reject(new Error('kho đơn giả: không có đơn để update'));
    if (typeof data.status === 'string') o.status = data.status;
    if (typeof data.paymentStatus === 'string') o.paymentStatus = data.paymentStatus;
    if (data.paymentExpiresAt === null) o.paymentExpiresAt = null;
    return Promise.resolve(view(o) as OrderRow);
  });
  const addHistory = jest.fn((_orderId: string, _from: string | null, _to: string, _note: string | null, _actorId: string | null, _tx: Tx): Promise<void> => Promise.resolve());
  let childSeq = 0;
  const nextGroupCode = jest.fn((_tx: Tx): Promise<string> => Promise.resolve('DHN261001'));
  const nextCode = jest.fn((_tx: Tx): Promise<string> => Promise.resolve(`DH26200${(childSeq += 1)}`));
  const createGroup = jest.fn((data: Prisma.OrderGroupUncheckedCreateInput, _tx: Tx): Promise<{ id: string; code: string }> => Promise.resolve({ id: `grp-${data.code}`, code: data.code }));
  const create = jest.fn((data: Prisma.OrderUncheckedCreateInput, _tx: Tx): Promise<OrderRow> => Promise.resolve({ id: `ord-${data.code}`, code: data.code } as unknown as OrderRow));
  const openReturnOrderIds = new Set<string>(); // test đặt đơn nào đang có yêu cầu đổi trả MỞ
  const hasOpenReturn = jest.fn((orderId: string, _tx?: Tx | null): Promise<boolean> => Promise.resolve(openReturnOrderIds.has(orderId)));
  const groupSiblingInfo = jest.fn((_groupId: string, _excludeId: string, _tx: Tx): Promise<{ groupCode: string; activeOthers: number } | null> => Promise.resolve({ groupCode: 'DHN261001', activeOthers: 0 }));
  const list = jest.fn((_f: unknown, _skip: number, _take: number): Promise<{ items: OrderRow[]; total: number }> => Promise.resolve({ items: [], total: 0 }));
  const returnedQtyByItem = jest.fn((_orderIds: string[], _tx?: Tx | null): Promise<Map<string, number>> => Promise.resolve(new Map<string, number>()));
  const expiredRows: Array<{ code: string; paymentExpiresAt: Date | null }> = []; // test đặt đơn nào được job huỷ quá hạn nhìn thấy
  const findPaymentExpired = jest.fn((_limit: number, _grace?: number): Promise<Array<{ code: string; paymentExpiresAt: Date | null }>> => Promise.resolve([...expiredRows]));
  const repo = { findByCode, findByCodeForUpdate, findDeliveredBefore, findPaymentExpired, update, addHistory, nextGroupCode, nextCode, createGroup, create, hasOpenReturn, groupSiblingInfo, list, returnedQtyByItem };

  // PLAN-0027: các hàm repo mới mà OrderService gọi (cờ "Đã nhận hàng" theo lô; hạn chót không cần ở đây).
  Object.assign(repo, { openReturnOrderIds: jest.fn((ids: string[], _tx?: Tx | null): Promise<Set<string>> => Promise.resolve(new Set(ids.filter((id) => [...openReturnOrderIds].includes(id))))) });

  const auditWrite = jest.fn((_tx: Tx, _actor: unknown, _entry: AuditLike): Promise<void> => Promise.resolve());
  const outboxPublish = jest.fn((_tx: Tx, _evt: OutboxLike): Promise<void> => Promise.resolve());
  const notifyOne = jest.fn((_cmd: NotifyCommand, _tx?: Tx): Promise<void> => Promise.resolve());
  const notifyMany = jest.fn((_cmds: NotifyCommand[], _tx?: Tx): Promise<void> => Promise.resolve());
  const addSold = jest.fn((_items: Array<{ productId: string; quantity: number }>, _tx?: Tx): Promise<void> => Promise.resolve());
  const staffIds = jest.fn((_perm: string): Promise<string[]> => Promise.resolve(['staff-1']));

  const commit = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const reserve = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const release = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const restock = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const inventory = { commit, reserve, release, restock, availableOf: jest.fn() } as unknown as InventoryGateway;

  const requestRefund = jest.fn((_input: { orderCode: string; shopId: string | null; amount: bigint; reason: string; returnRequestId: string | null; actorUserId: string | null; paymentId?: string }, _tx: Tx): Promise<{ refundId: string | null }> => Promise.resolve({ refundId: 'rf-1' }));
  const initiate = jest.fn((_input: { orderCode: string; amount: bigint; methodCode: string; bankCode?: string | null }, _tx: Tx): Promise<unknown> => Promise.resolve({}));
  const createCheckoutLinks = jest.fn((_codes: string[]): Promise<Map<string, unknown>> => Promise.resolve(new Map()));
  const cancelPayment = jest.fn((_code: string, _reason: string, _tx: Tx): Promise<void> => Promise.resolve());
  const refundSummaries = jest.fn((_codes: string[]): Promise<Map<string, RefundSummary>> => Promise.resolve(new Map<string, RefundSummary>()));
  const payment = { isMethodActive: jest.fn((_m: string): Promise<boolean> => Promise.resolve(true)), initiate, createCheckoutLinks, requestRefund, cancel: cancelPayment, markCodCollected: jest.fn(), confirmPaymentStatus: jest.fn((_code: string): Promise<'paid' | 'unpaid' | 'unknown'> => Promise.resolve('unpaid')), refundSummaries, codAvailability: jest.fn((ids: string[]) => Promise.resolve(new Map(ids.map((i) => [i, true])))) } as unknown as PaymentGateway;

  const cart = {
    basketOf: jest.fn((_userId: string, _sel: boolean): Promise<Basket> => {
      const unitPrice = 400_000n;
      const lines = [{ variantId: 'v-a', productId: 'p-a', slug: 'sp-a', name: 'SP A', categorySlug: 'ao', imageUrl: null, color: 'Đen', size: 'M', sku: 'SKU-A', quantity: 1, unitPrice, lineTotal: unitPrice, available: 10, isSellable: true, shopId: SHOP }];
      return Promise.resolve({ userId: USER, lines, subtotal: unitPrice, itemCount: 1 });
    }),
  };
  const system = {
    settingNumber: jest.fn((key: string): Promise<number> => Promise.resolve(SETTINGS[key] ?? 0)),
    shippingFeeFor: jest.fn((_subtotal: bigint, _hint: string | null | undefined) => Promise.resolve({ fee: 30_000n, province: { code: '79', name: 'TP. Hồ Chí Minh' } })),
  };
  const findManyBrief = jest.fn((ids: string[]): Promise<Map<string, ShopBrief>> => Promise.resolve(new Map(ids.map((id) => [id, brief]))));
  const shopMembers = jest.fn((_id: string, _perm: string): Promise<string[]> => Promise.resolve(['shop-user-1']));
  const shops = { findBrief: jest.fn((_id: string): Promise<ShopBrief | null> => Promise.resolve(brief)), findManyBrief, memberUserIdsWithPermission: shopMembers, activeMemberUserIds: jest.fn((_id: string): Promise<string[]> => Promise.resolve([])) };
  const promotion = { scopeOf: jest.fn(), quote: jest.fn(), consume: jest.fn(), release: jest.fn() };

  /* Chạy callback với kho đơn giả; nếu ném lỗi thì HOÀN TÁC kho (mô phỏng rollback của transaction thật). */
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: Tx) => Promise<unknown>, _opts?: unknown): Promise<unknown> => {
      const snap = snapshot();
      try {
        return await fn(TX);
      } catch (err) {
        state.clear();
        for (const [k, v] of snap) state.set(k, v);
        throw err;
      }
    }),
  };

  const service = new OrderService(
    prisma as unknown as PrismaService,
    repo as unknown as OrderRepository,
    { write: auditWrite } as never,
    { publish: outboxPublish } as never,
    cart as unknown as CartQueryApi,
    {} as never,
    system as unknown as SystemQueryApi,
    // `orderRefundCommitted` (PLAN-0027, hoàn phần còn lại khi huỷ đơn partially_refunded): mặc định chưa có khoản hoàn nào; test đặt lại qua `(service as any).payments`.
    { extrasForOrder: jest.fn((_code: string) => Promise.resolve({ paymentUrl: null, transactionCode: null, cardBrand: null, cardLast4: null })), orderRefundCommitted: jest.fn((_code: string, _tx?: Tx): Promise<bigint> => Promise.resolve(0n)) } as never,
    shops as unknown as ShopQueryApi,
    inventory,
    promotion,
    payment,
    { removeLines: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) } as never,
    { notify: notifyOne, notifyMany },
    { addSold, setRating: jest.fn(), addView: jest.fn() },
    { staffUserIdsWithPermission: staffIds } as never,
  );
  const getAdmin = jest.spyOn(service, 'getAdmin').mockResolvedValue({ code: 'DH261001' } as never);
  jest.spyOn(service, 'myOrderGroup').mockResolvedValue({ code: 'DHN261001' } as unknown as OrderGroupResponse);

  return { service, state, repo, expiredRows, findPaymentExpired, payment, update, addHistory, findByCodeForUpdate, findDeliveredBefore, findByCode, create, createGroup, auditWrite, outboxPublish, notifyOne, notifyMany, addSold, commit, requestRefund, initiate, createCheckoutLinks, getAdmin, shops, restock, release, cancelPayment, refundSummaries, openReturnOrderIds, staffIds, shopMembers };
}

type Fixture = ReturnType<typeof buildFixture>;

type WarnSpy = jest.SpyInstance<void, [message: unknown, ...optionalParams: unknown[]]>;
let warn: WarnSpy;
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const statusOf = (f: Fixture, code: string) => f.state.get(code)?.status;
const events = (f: Fixture) => f.outboxPublish.mock.calls.map((c) => c[1]);

// ====================================================================== (a) autoComplete
describe('OrderService.autoComplete — hoàn tất tự động theo lô', () => {
  it('lặp theo lô tới hết: limit 2, 5 đơn ⇒ 3 lô (2+2+1), mọi đơn sang completed, trả về 5', async () => {
    const f = buildFixture([1, 2, 3, 4, 5].map((n) => delivered(n)));
    const n = await f.service.autoComplete(2);
    expect(n).toBe(5);
    expect([1, 2, 3, 4, 5].map((i) => statusOf(f, `DH26100${i}`))).toEqual(Array(5).fill(ORDER_STATUS.COMPLETED));
    expect(f.findDeliveredBefore).toHaveBeenCalledTimes(3);
    expect(f.findDeliveredBefore.mock.calls.every((c) => c[1] === 2)).toBe(true);
  });

  it('xử lý đơn CŨ NHẤT trước (đúng thứ tự lô)', async () => {
    const f = buildFixture([delivered(1, 10), delivered(2, 20), delivered(3, 15)]);
    await f.service.autoComplete(1);
    expect(events(f).map((e) => e.payload.orderCode)).toEqual(['DH261002', 'DH261003', 'DH261001']);
  });

  it('mỗi đơn: update completed + addHistory + addSold + audit + outbox ORDER_STATUS_CHANGED {orderCode,userId,from,to}', async () => {
    const f = buildFixture([delivered(1)]);
    expect(await f.service.autoComplete()).toBe(1);

    const [id, data, tx] = f.update.mock.calls[0];
    expect(id).toBe('o1');
    expect(data.status).toBe(ORDER_STATUS.COMPLETED);
    expect(data.completedAt).toBeInstanceOf(Date);
    expect(tx).toBe(TX);
    expect(f.addHistory).toHaveBeenCalledWith('o1', ORDER_STATUS.DELIVERED, ORDER_STATUS.COMPLETED, 'Tự hoàn tất sau 7 ngày', null, TX);
    expect(f.addSold).toHaveBeenCalledWith([{ productId: 'prod-1', quantity: 2 }], TX);
    expect(f.auditWrite).toHaveBeenCalledWith(TX, null, { action: ORDER_AUDIT.STATUS_CHANGED, entityType: 'order', entityId: 'o1', entityCode: 'DH261001', before: { status: 'delivered' }, after: { status: 'completed', note: 'Tự hoàn tất sau 7 ngày' } });
    expect(f.outboxPublish).toHaveBeenCalledTimes(1);
    expect(f.outboxPublish).toHaveBeenCalledWith(TX, { eventType: ORDER_EVENT.STATUS_CHANGED, aggregateType: 'order', aggregateId: 'o1', payload: { orderCode: 'DH261001', userId: USER, from: 'delivered', to: 'completed' } });
    expect(ORDER_EVENT.STATUS_CHANGED).toBe('ORDER_STATUS_CHANGED');
  });

  it('chỉ lấy đơn giao quá N ngày (N = setting order.auto_complete_days): mốc cắt = now − N ngày', async () => {
    const f = buildFixture([delivered(1)]);
    await f.service.autoComplete();
    const before = f.findDeliveredBefore.mock.calls[0][0];
    expect(Math.abs(before.getTime() - (Date.now() - 7 * DAY))).toBeLessThan(5_000);
  });

  it('đơn mới giao (chưa quá hạn) không bị đụng', async () => {
    const f = buildFixture([delivered(1, 2), delivered(2, 20)]);
    expect(await f.service.autoComplete()).toBe(1);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.DELIVERED);
    expect(statusOf(f, 'DH261002')).toBe(ORDER_STATUS.COMPLETED);
  });

  it('không có đơn nào ⇒ 0, không mở transaction', async () => {
    const f = buildFixture([mkOrder(1)]);
    expect(await f.service.autoComplete()).toBe(0);
    expect(f.findByCodeForUpdate).not.toHaveBeenCalled();
    expect(f.outboxPublish).not.toHaveBeenCalled();
  });

  it('đơn không còn delivered lúc khoá dòng (đã completed/returned do luồng khác) ⇒ bỏ qua, không ghi gì, không tính', async () => {
    const f = buildFixture([delivered(1), delivered(2, 25, { status: ORDER_STATUS.COMPLETED }), delivered(3, 24, { status: ORDER_STATUS.RETURNED })]);
    // finder "cũ" vẫn trả cả đơn đã đổi trạng thái (race giữa lúc quét và lúc khoá)
    f.findDeliveredBefore.mockResolvedValueOnce([{ code: 'DH261002' }, { code: 'DH261003' }, { code: 'DH261001' }]);
    expect(await f.service.autoComplete(100)).toBe(1);
    expect(statusOf(f, 'DH261002')).toBe(ORDER_STATUS.COMPLETED);
    expect(statusOf(f, 'DH261003')).toBe(ORDER_STATUS.RETURNED);
    expect(events(f).map((e) => e.payload.orderCode)).toEqual(['DH261001']);
    expect(f.addSold).toHaveBeenCalledTimes(1);
    expect(f.addHistory).toHaveBeenCalledTimes(1);
  });

  it('một đơn LỖI không chặn các đơn khác (rollback đơn lỗi, không phát outbox cho nó), job không lặp vô hạn', async () => {
    const f = buildFixture([1, 2, 3, 4].map((n) => delivered(n)));
    f.addSold.mockImplementation((items) => (items[0].productId === 'prod-2' ? Promise.reject(new Error('stats lỗi')) : Promise.resolve()));
    const n = await f.service.autoComplete(2);
    expect(n).toBe(3);
    expect([1, 2, 3, 4].map((i) => statusOf(f, `DH26100${i}`))).toEqual(['completed', 'delivered', 'completed', 'completed']); // đơn 2 rollback về delivered
    expect(events(f).map((e) => e.payload.orderCode)).not.toContain('DH261002');
    expect(warn.mock.calls.some((c) => (c[0] as { code: string }).code === 'DH261002')).toBe(true);
    expect(f.findDeliveredBefore.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('mọi đơn đều lỗi ⇒ trả 0; MỖI đơn lỗi chỉ thử đúng 1 lần (loại khỏi lô sau, không quét lại mãi)', async () => {
    const f = buildFixture([1, 2, 3].map((n) => delivered(n)));
    f.addSold.mockRejectedValue(new Error('stats lỗi'));
    expect(await f.service.autoComplete(2)).toBe(0);
    expect(f.findDeliveredBefore).toHaveBeenCalledTimes(2); // lô 1 (2 đơn lỗi) → lô 2 (đơn còn lại, lô chưa đầy ⇒ dừng)
    expect(warn).toHaveBeenCalledTimes(3);
    expect([1, 2, 3].every((i) => statusOf(f, `DH26100${i}`) === ORDER_STATUS.DELIVERED)).toBe(true);
  });

  it('dừng khi lô không đầy (đã hết): lô cuối < limit không gọi thêm lần quét', async () => {
    const f = buildFixture([delivered(1), delivered(2), delivered(3)]);
    expect(await f.service.autoComplete(5)).toBe(3);
    expect(f.findDeliveredBefore).toHaveBeenCalledTimes(1);
  });

  /* Đơn LỖI nằm đầu lô (cũ nhất trước): được loại khỏi các lô sau trong CÙNG lần chạy để các đơn TỐT phía sau vẫn được hoàn tất (không đói). */
  it('đơn lỗi ở đầu lô (≥ limit) KHÔNG chặn các đơn tốt phía sau — job vẫn hoàn tất đơn tốt', async () => {
    const f = buildFixture([1, 2, 3, 4, 5].map((n) => delivered(n)));
    f.addSold.mockImplementation((items) => (['prod-1', 'prod-2'].includes(items[0].productId) ? Promise.reject(new Error('stats lỗi')) : Promise.resolve()));
    expect(await f.service.autoComplete(2)).toBe(3);
  });
});

// ====================================================================== (b) onPaid
describe('OrderService.onPaid — tiền về', () => {
  const info = (over: Partial<{ methodCode: string }> = {}) => ({ paymentId: 'pay-1', methodCode: 'payos', transactionCode: 'T-1', bankCode: null, paidAt: new Date(), ...over });
  const titles = (f: Fixture) => f.notifyOne.mock.calls.map((c) => c[0].title);

  describe.each([ORDER_STATUS.CANCELLED, ORDER_STATUS.RETURNED])('đơn đã %s (tiền đến muộn)', (status) => {
    const seed = () => [mkOrder(1, { status, paymentMethodCode: 'payos', total: new Prisma.Decimal(430_000) })];

    it('ghi nhận paymentStatus = paid và TẠO NGAY yêu cầu hoàn đủ total cho đúng khoản thanh toán đến muộn', async () => {
      const f = buildFixture(seed());
      await f.service.onPaid('DH261001', info(), TX);
      expect(f.update).toHaveBeenCalledWith('o1', { paymentStatus: PAYMENT_STATUS.PAID, paymentExpiresAt: null, updatedBy: null }, TX);
      expect(f.state.get('DH261001')).toMatchObject({ status, paymentStatus: 'paid', paymentExpiresAt: null });
      expect(f.requestRefund).toHaveBeenCalledTimes(1);
      expect(f.requestRefund).toHaveBeenCalledWith({ orderCode: 'DH261001', shopId: SHOP, amount: 430_000n, reason: 'Thanh toán đến sau khi đơn đã huỷ', returnRequestId: null, actorUserId: null, paymentId: 'pay-1' }, TX);
    });

    it('KHÔNG gửi "đã nhận thanh toán" cho khách/nhân viên và KHÔNG phát ORDER_PAID; chỉ báo "đã huỷ — khoản thanh toán sẽ được hoàn"', async () => {
      const f = buildFixture(seed());
      await f.service.onPaid('DH261001', info(), TX);
      expect(f.notifyOne).toHaveBeenCalledTimes(1);
      expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, type: 'payment', title: 'Đơn DH261001 đã huỷ — khoản thanh toán sẽ được hoàn', link: '/account/orders/DH261001' });
      expect(titles(f).some((t) => t.includes('Đã nhận thanh toán'))).toBe(false);
      expect(f.notifyMany).not.toHaveBeenCalled();
      expect(f.outboxPublish).not.toHaveBeenCalled();
    });

    it('audit ORDER_PAID ghi rõ đơn đã huỷ/trả và đã yêu cầu hoàn', async () => {
      const f = buildFixture(seed());
      await f.service.onPaid('DH261001', info(), TX);
      expect(f.auditWrite).toHaveBeenCalledWith(TX, null, { action: ORDER_AUDIT.PAID, entityType: 'order', entityId: 'o1', entityCode: 'DH261001', after: { method: 'payos', lateAfter: status, refundRequested: true } });
    });

    it('IPN/webhook lặp (paymentStatus đã paid) ⇒ không làm gì thêm: chỉ 1 yêu cầu hoàn, 1 thông báo', async () => {
      const f = buildFixture(seed());
      await f.service.onPaid('DH261001', info(), TX);
      await f.service.onPaid('DH261001', info(), TX);
      expect(f.requestRefund).toHaveBeenCalledTimes(1);
      expect(f.notifyOne).toHaveBeenCalledTimes(1);
      expect(f.update).toHaveBeenCalledTimes(1);
    });
  });

  it('[NTF-03] đơn pending bình thường (online): paid + audit + thông báo "Đã nhận thanh toán" cho khách + outbox ORDER_PAID; KHÔNG thông báo nhân viên sàn (không tra staff); KHÔNG hoàn', async () => {
    const f = buildFixture([mkOrder(1, { paymentMethodCode: 'payos', total: new Prisma.Decimal(430_000) })]);
    await f.service.onPaid('DH261001', info({ methodCode: 'payos' }), TX);
    expect(f.state.get('DH261001')).toMatchObject({ status: 'pending', paymentStatus: 'paid', paymentExpiresAt: null });
    expect(f.requestRefund).not.toHaveBeenCalled();
    expect(f.auditWrite).toHaveBeenCalledWith(TX, null, { action: ORDER_AUDIT.PAID, entityType: 'order', entityId: 'o1', entityCode: 'DH261001', after: { method: 'payos', transactionCode: 'T-1' } });
    expect(f.notifyOne).toHaveBeenCalledTimes(1);
    expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, type: 'payment', title: 'Đã nhận thanh toán đơn DH261001' });
    expect(f.notifyMany).not.toHaveBeenCalled(); // AUD-11a: nhân viên sàn không còn nhận "Đơn … đã thanh toán" cho từng đơn con
    expect(f.staffIds).not.toHaveBeenCalled();
    expect(f.outboxPublish).toHaveBeenCalledWith(TX, { eventType: ORDER_EVENT.PAID, aggregateType: 'order', aggregateId: 'o1', payload: { orderCode: 'DH261001', userId: USER, methodCode: 'payos' } });
  });

  it('đơn COD: không thông báo "đã nhận thanh toán" (thu khi giao) nhưng vẫn ghi paid + phát ORDER_PAID', async () => {
    const f = buildFixture([mkOrder(1, { paymentMethodCode: 'cod', status: ORDER_STATUS.DELIVERED })]);
    await f.service.onPaid('DH261001', info({ methodCode: 'cod' }), TX);
    expect(f.state.get('DH261001')?.paymentStatus).toBe('paid');
    expect(f.notifyOne).not.toHaveBeenCalled();
    expect(f.notifyMany).not.toHaveBeenCalled();
    expect(events(f).map((e) => e.eventType)).toEqual([ORDER_EVENT.PAID]);
    expect(f.requestRefund).not.toHaveBeenCalled();
  });

  it.each([ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING])('đơn %s nhận tiền: đi đường bình thường (không hoàn)', async (status) => {
    const f = buildFixture([mkOrder(1, { status })]);
    await f.service.onPaid('DH261001', info(), TX);
    expect(f.requestRefund).not.toHaveBeenCalled();
    expect(events(f).map((e) => e.eventType)).toEqual([ORDER_EVENT.PAID]);
  });

  it('onPaid lặp trên đơn thường (paymentStatus đã paid) ⇒ không làm gì', async () => {
    const f = buildFixture([mkOrder(1, { paymentStatus: PAYMENT_STATUS.PAID })]);
    await f.service.onPaid('DH261001', info(), TX);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.auditWrite).not.toHaveBeenCalled();
    expect(f.notifyOne).not.toHaveBeenCalled();
    expect(f.outboxPublish).not.toHaveBeenCalled();
    expect(f.requestRefund).not.toHaveBeenCalled();
  });

  it('đơn không tồn tại ⇒ NotFoundException ORDER_NOT_FOUND', async () => {
    const f = buildFixture();
    await expect(f.service.onPaid('DH-NOPE', info(), TX)).rejects.toMatchObject({ errorCode: ORDER_ERR.NOT_FOUND });
    await expect(f.service.onPaid('DH-NOPE', info(), TX)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ====================================================================== (c) onRefunded
describe('OrderService.onRefunded — hoàn tiền luỹ kế', () => {
  const total100k = () => buildFixture([mkOrder(1, { paymentStatus: PAYMENT_STATUS.PAID, total: new Prisma.Decimal(100_000) })]);

  it('hoàn 60k rồi 40k trên đơn 100k, payment báo cờ fullyRefunded ⇒ lần 1 partially_refunded, lần 2 refunded', async () => {
    const f = total100k();
    await f.service.onRefunded('DH261001', 60_000n, 'rf-1', TX, false);
    expect(f.state.get('DH261001')?.paymentStatus).toBe(PAYMENT_STATUS.PARTIALLY_REFUNDED);
    await f.service.onRefunded('DH261001', 40_000n, 'rf-2', TX, true);
    expect(f.state.get('DH261001')?.paymentStatus).toBe(PAYMENT_STATUS.REFUNDED);
  });

  it('có cờ thì DÙNG cờ, không so từng khoản với total: 40k (nhỏ hơn total) + cờ true ⇒ refunded; 100k + cờ false ⇒ partially_refunded', async () => {
    const f = total100k();
    await f.service.onRefunded('DH261001', 40_000n, 'rf-1', TX, true);
    expect(f.state.get('DH261001')?.paymentStatus).toBe(PAYMENT_STATUS.REFUNDED);
    const g = total100k();
    await g.service.onRefunded('DH261001', 100_000n, 'rf-2', TX, false);
    expect(g.state.get('DH261001')?.paymentStatus).toBe(PAYMENT_STATUS.PARTIALLY_REFUNDED);
  });

  it('thiếu cờ ⇒ so MỘT khoản với total như cũ: ≥ total ⇒ refunded, < total ⇒ partially_refunded', async () => {
    const f = total100k();
    await f.service.onRefunded('DH261001', 60_000n, 'rf-1', TX);
    expect(f.state.get('DH261001')?.paymentStatus).toBe(PAYMENT_STATUS.PARTIALLY_REFUNDED);
    await f.service.onRefunded('DH261001', 100_000n, 'rf-2', TX);
    expect(f.state.get('DH261001')?.paymentStatus).toBe(PAYMENT_STATUS.REFUNDED);
  });

  it('thiếu cờ: hai khoản 60k + 40k (không cờ) KHÔNG ra refunded — đúng lý do payment phải truyền cờ luỹ kế', async () => {
    const f = total100k();
    await f.service.onRefunded('DH261001', 60_000n, 'rf-1', TX);
    await f.service.onRefunded('DH261001', 40_000n, 'rf-2', TX);
    expect(f.state.get('DH261001')?.paymentStatus).toBe(PAYMENT_STATUS.PARTIALLY_REFUNDED);
  });

  it('ghi lịch sử + thông báo khách kèm refundId', async () => {
    const f = total100k();
    await f.service.onRefunded('DH261001', 60_000n, 'rf-1', TX, false);
    expect(f.addHistory).toHaveBeenCalledWith('o1', ORDER_STATUS.PENDING, ORDER_STATUS.PENDING, 'Đã hoàn 60.000 ₫', null, TX);
    expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, type: 'payment', title: 'Đã hoàn tiền đơn DH261001', content: 'Số tiền 60.000 ₫ đã được hoàn.', payload: { refundId: 'rf-1' } });
  });

  it('đơn không tồn tại ⇒ bỏ qua êm (không ném, không ghi)', async () => {
    const f = buildFixture();
    await expect(f.service.onRefunded('DH-NOPE', 1n, 'rf', TX, true)).resolves.toBeUndefined();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.notifyOne).not.toHaveBeenCalled();
  });

  describe('OrderPaymentGatewayImpl chuyển tiếp đủ tham số', () => {
    const impl = () => {
      const onRefunded = jest.fn((_c: string, _a: bigint, _r: string, _tx: Tx, _full?: boolean): Promise<void> => Promise.resolve());
      const canRetryPayment = jest.fn((_c: string): Promise<boolean> => Promise.resolve(true));
      const onPaid = jest.fn((_c: string, _i: unknown, _tx: Tx): Promise<void> => Promise.resolve());
      const markRefunded = jest.fn((_id: string, _tx: Tx): Promise<void> => Promise.resolve());
      const gw = new OrderPaymentGatewayImpl({ onRefunded, canRetryPayment, onPaid } as unknown as OrderService, { markRefunded } as unknown as ReturnService);
      return { gw, onRefunded, canRetryPayment, onPaid, markRefunded };
    };

    it('onRefunded truyền nguyên cờ fullyRefunded (true / false / bỏ trống)', async () => {
      const g = impl();
      await g.gw.onRefunded('DH1', 60_000n, 'rf-1', TX, true);
      await g.gw.onRefunded('DH1', 40_000n, 'rf-2', TX, false);
      await g.gw.onRefunded('DH1', 40_000n, 'rf-3', TX);
      expect(g.onRefunded.mock.calls.map((c) => c[4])).toEqual([true, false, undefined]);
      expect(g.onRefunded.mock.calls[0]).toEqual(['DH1', 60_000n, 'rf-1', TX, true]);
    });

    it('canRetryPayment / onPaid / markReturnRefunded ủy quyền đúng service', async () => {
      const g = impl();
      await expect(g.gw.canRetryPayment('DH1')).resolves.toBe(true);
      await g.gw.onPaid('DH1', { paymentId: 'p', methodCode: 'payos', transactionCode: null, bankCode: null, paidAt: new Date() }, TX);
      await g.gw.markReturnRefunded('rr-1', TX);
      expect(g.canRetryPayment).toHaveBeenCalledWith('DH1');
      expect(g.onPaid).toHaveBeenCalledTimes(1);
      expect(g.markRefunded).toHaveBeenCalledWith('rr-1', TX);
    });
  });
});

// ====================================================================== (d) canRetryPayment
describe('OrderService.canRetryPayment', () => {
  const can = async (over: Partial<OrderState> | null) => {
    const f = buildFixture(over ? [mkOrder(1, over)] : []);
    return f.service.canRetryPayment('DH261001');
  };

  it('true chỉ khi đơn pending và paymentStatus ≠ paid (unpaid / processing)', async () => {
    expect(await can({ status: ORDER_STATUS.PENDING, paymentStatus: PAYMENT_STATUS.UNPAID })).toBe(true);
    expect(await can({ status: ORDER_STATUS.PENDING, paymentStatus: PAYMENT_STATUS.PROCESSING })).toBe(true);
  });

  it('pending nhưng đã paid ⇒ false', async () => {
    expect(await can({ status: ORDER_STATUS.PENDING, paymentStatus: PAYMENT_STATUS.PAID })).toBe(false);
  });

  it.each([ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING, ORDER_STATUS.DELIVERED, ORDER_STATUS.COMPLETED, ORDER_STATUS.CANCELLED, ORDER_STATUS.RETURNED])('đơn %s (chưa thanh toán) ⇒ false', async (status) => {
    expect(await can({ status, paymentStatus: PAYMENT_STATUS.UNPAID })).toBe(false);
  });

  it('đơn không tồn tại ⇒ false', async () => {
    expect(await can(null)).toBe(false);
  });
});

// ====================================================================== (e) hạn thanh toán PayOS
describe('cancelExpired — hỏi lại PayOS trước khi huỷ (PLAN-0025)', () => {
  const confirm = (f: Fixture) => (f.payment as unknown as { confirmPaymentStatus: jest.Mock }).confirmPaymentStatus;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const overdue = (f: Fixture, paymentExpiresAt: Date) => {
    f.state.get('DH261001')!.paymentExpiresAt = paymentExpiresAt;
    f.expiredRows.push({ code: 'DH261001', paymentExpiresAt });
  };
  const pending = () => mkOrder(1, { status: ORDER_STATUS.PENDING, paymentStatus: PAYMENT_STATUS.UNPAID });

  it('[PAY-05] job lấy đơn quá hạn CỘNG ÂN HẠN (order.payment_grace_minutes) — truyền ân hạn vào truy vấn', async () => {
    const f = buildFixture([pending()]);
    await f.service.cancelExpired();
    expect(f.findPaymentExpired).toHaveBeenCalledWith(50, 10);
  });

  it('[PAY-04] cổng báo đã trả (mất webhook) ⇒ KHÔNG huỷ đơn', async () => {
    const f = buildFixture([pending()]);
    overdue(f, minutesAgo(30));
    confirm(f).mockResolvedValue('paid');
    expect(await f.service.cancelExpired()).toBe(0);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.PENDING);
    expect(f.release).not.toHaveBeenCalled();
  });

  it('cổng xác nhận CHƯA trả ⇒ huỷ đơn như cũ (nhả kho, huỷ thanh toán)', async () => {
    const f = buildFixture([pending()]);
    overdue(f, minutesAgo(30));
    confirm(f).mockResolvedValue('unpaid');
    expect(await f.service.cancelExpired()).toBe(1);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
    expect(f.cancelPayment).toHaveBeenCalled();
  });

  it('[PAY-13] không tra được PayOS (unknown) + mới quá hạn ⇒ để lần sau, KHÔNG huỷ', async () => {
    const f = buildFixture([pending()]);
    overdue(f, minutesAgo(30)); // < ân hạn 10' + 60'
    confirm(f).mockResolvedValue('unknown');
    expect(await f.service.cancelExpired()).toBe(0);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.PENDING);
  });

  it('unknown mà quá hạn + ân hạn + 60 phút ⇒ huỷ (không giữ kho vô hạn khi PayOS mất liên lạc)', async () => {
    const f = buildFixture([pending()]);
    overdue(f, minutesAgo(120));
    confirm(f).mockResolvedValue('unknown');
    expect(await f.service.cancelExpired()).toBe(1);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
  });

  it('hỏi PayOS NGOÀI transaction: $transaction chỉ mở sau khi đã có câu trả lời của cổng', async () => {
    const f = buildFixture([pending()]);
    overdue(f, minutesAgo(30));
    const order: string[] = [];
    confirm(f).mockImplementation(() => {
      order.push('confirm');
      return Promise.resolve('unpaid');
    });
    f.findByCodeForUpdate.mockImplementation((code: string) => {
      order.push('lock');
      return Promise.resolve(({ ...f.state.get(code) } as unknown) as never);
    });
    await f.service.cancelExpired();
    expect(order.indexOf('confirm')).toBeLessThan(order.indexOf('lock'));
  });
});

describe('hạn thanh toán (paymentExpiry)', () => {
  const near = (d: Date | null | undefined, ms: number) => d instanceof Date && Math.abs(d.getTime() - (Date.now() + ms)) < 5_000;
  const place = (f: Fixture, paymentMethodCode: string) => f.service.placeOrder(actor, { address: ADDRESS, paymentMethodCode }, null);
  const expiresAt = (f: Fixture) => f.create.mock.calls[0][0].paymentExpiresAt as Date | null | undefined;

  it('đơn PayOS có paymentExpiresAt theo tham số hạn thanh toán online (15 phút)', async () => {
    const f = buildFixture();
    await place(f, 'payos');
    expect(near(expiresAt(f), 15 * 60_000)).toBe(true);
    expect(f.initiate.mock.calls[0][0]).toMatchObject({ methodCode: 'payos', amount: 430_000n });
  });

  it('[CK-15] PayOS: tạo link SAU khi transaction đặt hàng commit (không gọi mạng trong tx); COD không tạo link', async () => {
    const f = buildFixture();
    const opened: string[] = [];
    const tx = (f.service as unknown as { prisma: { $transaction: (fn: unknown, o?: unknown) => Promise<unknown> } }).prisma;
    const inner = tx.$transaction.bind(tx);
    tx.$transaction = async (fn, o) => {
      const r = await inner(fn, o);
      opened.push('commit');
      return r;
    };
    f.createCheckoutLinks.mockImplementation((codes) => {
      opened.push('links:' + codes.join(','));
      return Promise.resolve(new Map());
    });
    await place(f, 'payos');
    expect(opened).toEqual(['commit', 'links:DH262001']);
    const cod = buildFixture();
    await place(cod, 'cod');
    expect(cod.createCheckoutLinks).not.toHaveBeenCalled();
  });

  it('[CK-15] PayOS lỗi lúc tạo link (createCheckoutLinks trả {error}) ⇒ placeOrder KHÔNG ném, đơn vẫn được tạo', async () => {
    const f = buildFixture();
    f.createCheckoutLinks.mockResolvedValue(new Map([['DH262001', { error: 'PayOS timeout' }]]));
    await expect(place(f, 'payos')).resolves.toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('chỉ còn cod + payos: PayOS 15 phút, COD không có hạn', async () => {
    const payos = buildFixture();
    await place(payos, 'payos');
    expect(near(expiresAt(payos), 15 * 60_000)).toBe(true);
    const cod = buildFixture();
    await place(cod, 'cod');
    expect(expiresAt(cod)).toBeNull();
  });

  it('paymentExpiry trực tiếp: payos = 15 phút, cod = null', async () => {
    const f = buildFixture();
    expect(near(await f.service['paymentExpiry']('payos'), 15 * 60_000)).toBe(true);
    expect(await f.service['paymentExpiry']('cod')).toBeNull();
  });
});

// PLAN-0040 tầng 4 — AUD-11a / NTF-03: đặt hàng KHÔNG báo "Đơn mới" cho nhân viên sàn theo từng đơn con.
describe('thông báo khi đặt hàng (NTF-03 — chống spam nhân viên sàn)', () => {
  const place = (f: Fixture, paymentMethodCode: string) => f.service.placeOrder(actor, { address: ADDRESS, paymentMethodCode }, null);

  for (const method of ['cod', 'payos']) {
    it(`[NTF-03] ${method}: không tra nhân viên sàn, không notifyMany; chỉ khách nhận 1 thông báo tổng "Đặt hàng thành công"; shop nhận qua outbox ORDER_CREATED`, async () => {
      const f = buildFixture();
      await place(f, method);
      expect(f.staffIds).not.toHaveBeenCalled();
      expect(f.notifyMany).not.toHaveBeenCalled();
      expect(f.notifyOne).toHaveBeenCalledTimes(1);
      expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, type: 'order' });
      expect(f.notifyOne.mock.calls[0][0].title).toMatch(/^Đặt hàng thành công — DHN/);
      expect(events(f).filter((e) => e.eventType === ORDER_EVENT.CREATED)).toHaveLength(1);
    });
  }
});

// ====================================================================== (f) lưới chuyển trạng thái không còn `returned`
describe('STAFF_TRANSITIONS / updateStatus — không chuyển tay sang returned', () => {
  it('lưới: delivered → [completed], completed → [], shipping → [delivered, cancelled] (huỷ khi tranh chấp), không trạng thái nào cho phép sang returned', () => {
    expect(STAFF_TRANSITIONS.delivered).toEqual(['completed']);
    expect(STAFF_TRANSITIONS.completed).toEqual([]);
    expect(STAFF_TRANSITIONS.shipping).toEqual(['delivered', 'cancelled']);
    for (const next of Object.values(STAFF_TRANSITIONS)) expect(next).not.toContain(ORDER_STATUS.RETURNED);
  });

  it.each([ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING, ORDER_STATUS.DELIVERED, ORDER_STATUS.COMPLETED])('updateStatus %s → returned ⇒ INVALID_TRANSITION, không ghi gì', async (status) => {
    const f = buildFixture([mkOrder(1, { status, paymentStatus: PAYMENT_STATUS.PAID })]);
    const err = await f.service.updateStatus(staff, 'DH261001', ORDER_STATUS.RETURNED, {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BusinessException);
    expect((err as BusinessException).errorCode).toBe(ORDER_ERR.INVALID_TRANSITION);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.addHistory).not.toHaveBeenCalled();
    expect(f.outboxPublish).not.toHaveBeenCalled();
    expect(statusOf(f, 'DH261001')).toBe(status);
  });

  it('thông báo lỗi dùng nhãn tiếng Việt: Đã giao → Đã trả hàng', async () => {
    const f = buildFixture([delivered(1)]);
    await expect(f.service.updateStatus(staff, 'DH261001', ORDER_STATUS.RETURNED, {})).rejects.toMatchObject({ message: 'Không thể chuyển từ "Đã giao" sang "Đã trả hàng"' });
  });

  it('delivered → completed vẫn đi được: cộng đã bán + outbox ORDER_STATUS_CHANGED', async () => {
    const f = buildFixture([delivered(1)]);
    await f.service.updateStatus(staff, 'DH261001', ORDER_STATUS.COMPLETED, { note: 'ok' });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.COMPLETED);
    expect(f.addSold).toHaveBeenCalledWith([{ productId: 'prod-1', quantity: 2 }], TX);
    expect(events(f)).toEqual([{ eventType: ORDER_EVENT.STATUS_CHANGED, aggregateType: 'order', aggregateId: 'o1', payload: { orderCode: 'DH261001', userId: USER, from: 'delivered', to: 'completed' } }]);
  });

  it('completed không còn chuyển tiếp trạng thái nào; huỷ đơn đã giao/hoàn tất ⇒ CANNOT_CANCEL', async () => {
    const f = buildFixture([mkOrder(1, { status: ORDER_STATUS.COMPLETED }), delivered(2)]);
    await expect(f.service.updateStatus(staff, 'DH261001', ORDER_STATUS.COMPLETED, {})).rejects.toMatchObject({ errorCode: ORDER_ERR.INVALID_TRANSITION });
    await expect(f.service.cancelByStaff(staff, 'DH261001', 'x')).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
    await expect(f.service.cancelByStaff(staff, 'DH261002', 'x')).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
  });
});

// ====================================================================== (g) huỷ đơn ĐANG GIAO (sàn) — PLAN-0022
describe('OrderService.cancelByStaff — đơn đang giao khi tranh chấp', () => {
  const shipping = (over: Partial<OrderState> = {}) => mkOrder(1, { status: ORDER_STATUS.SHIPPING, paymentStatus: PAYMENT_STATUS.PAID, paymentMethodCode: 'payos', total: new Prisma.Decimal(430_000), ...over });
  const WHY = 'Khách báo thất lạc, đã xác minh với đơn vị vận chuyển';

  it('đơn online đã thu tiền: cancelled + hoàn ĐỦ, KHÔNG nhập kho (hàng đang ở đơn vị vận chuyển), nhả voucher, báo khách + thành viên shop', async () => {
    const f = buildFixture([shipping()]);
    await f.service.cancelByStaff(staff, 'DH261001', WHY);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
    expect(f.requestRefund).toHaveBeenCalledTimes(1);
    expect(f.requestRefund.mock.calls[0][0]).toMatchObject({ orderCode: 'DH261001', shopId: SHOP, amount: 430_000n, reason: `Huỷ đơn: ${WHY}`, actorUserId: 'staff-1' });
    expect(f.restock).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.cancelPayment).not.toHaveBeenCalled();
    expect(f.addHistory).toHaveBeenCalledWith('o1', ORDER_STATUS.SHIPPING, ORDER_STATUS.CANCELLED, WHY, 'staff-1', TX);
    expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, title: 'Đơn DH261001 đã huỷ', content: WHY });
    expect(f.shopMembers).toHaveBeenCalledWith(SHOP, 'shop.order.update');
    expect(f.notifyMany.mock.calls[0][0]).toMatchObject([{ userId: 'shop-user-1', title: 'Sàn đã huỷ đơn DH261001 đang giao', link: '/vendor/orders/DH261001' }]);
    expect(f.outboxPublish.mock.calls.map((c) => c[1].eventType)).toEqual([ORDER_EVENT.CANCELLED]);
  });

  it('đơn COD chưa thu tiền: huỷ giao dịch COD, KHÔNG hoàn tiền, KHÔNG nhập kho', async () => {
    const f = buildFixture([shipping({ paymentMethodCode: 'cod', paymentStatus: PAYMENT_STATUS.UNPAID })]);
    await f.service.cancelByStaff(staff, 'DH261001', WHY);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
    expect(f.requestRefund).not.toHaveBeenCalled();
    expect(f.cancelPayment).toHaveBeenCalledWith('DH261001', WHY, TX);
    expect(f.restock).not.toHaveBeenCalled();
  });

  it('lý do dài 255 ký tự ⇒ lý do hoàn gửi payment vẫn ≤ 255 (tiền tố "Huỷ đơn: " không làm tràn VARCHAR(255) bên payment)', async () => {
    const f = buildFixture([shipping()]);
    await f.service.cancelByStaff(staff, 'DH261001', 'z'.repeat(255));
    const reason = f.requestRefund.mock.calls[0][0].reason;
    expect(reason).toHaveLength(255);
    expect(reason.startsWith('Huỷ đơn: z')).toBe(true);
  });

  it('BẮT BUỘC lý do rõ ràng (≥ 10 ký tự) khi huỷ đơn đang giao — không ghi gì', async () => {
    const f = buildFixture([shipping()]);
    await expect(f.service.cancelByStaff(staff, 'DH261001', 'ngắn')).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.SHIPPING);
    expect(f.requestRefund).not.toHaveBeenCalled();
  });

  it('đơn còn yêu cầu đổi trả MỞ (khách báo chưa nhận hàng…) ⇒ ORDER_HAS_OPEN_RETURN, không huỷ', async () => {
    const f = buildFixture([shipping()]);
    f.openReturnOrderIds.add('o1');
    await expect(f.service.cancelByStaff(staff, 'DH261001', WHY)).rejects.toMatchObject({ errorCode: ORDER_ERR.HAS_OPEN_RETURN });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.SHIPPING);
    expect(f.requestRefund).not.toHaveBeenCalled();
  });

  it('không đổi hành vi cũ: confirmed huỷ vẫn NHẬP KHO lại; pending thì NHẢ giữ chỗ; PLAN-0027: shop LUÔN được báo khi sàn huỷ (đơn chưa giao: quyền shop.order.read)', async () => {
    const confirmed = buildFixture([mkOrder(1, { status: ORDER_STATUS.CONFIRMED })]);
    await confirmed.service.cancelByStaff(staff, 'DH261001', 'Hết hàng');
    expect(confirmed.restock).toHaveBeenCalledTimes(1);
    expect(confirmed.release).not.toHaveBeenCalled();
    expect(confirmed.shopMembers).toHaveBeenCalledWith(SHOP, 'shop.order.read');
    expect(confirmed.notifyMany).toHaveBeenCalledTimes(1);
    const pending = buildFixture([mkOrder(1)]);
    await pending.service.cancelByStaff(staff, 'DH261001', 'Khách đổi ý');
    expect(pending.release).toHaveBeenCalledTimes(1);
    expect(pending.restock).not.toHaveBeenCalled();
  });

  it('đơn đã giao/hoàn tất vẫn không huỷ được (CANNOT_CANCEL)', async () => {
    const f = buildFixture([delivered(1), mkOrder(2, { status: ORDER_STATUS.COMPLETED })]);
    await expect(f.service.cancelByStaff(staff, 'DH261001', WHY)).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
    await expect(f.service.cancelByStaff(staff, 'DH261002', WHY)).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
  });
});

// ====================================================================== (h) shop báo giao KHÔNG thành công — PLAN-0022
describe('OrderService.deliveryFailed', () => {
  const shipping = (over: Partial<OrderState> = {}) => mkOrder(1, { status: ORDER_STATUS.SHIPPING, paymentStatus: PAYMENT_STATUS.PAID, paymentMethodCode: 'payos', total: new Prisma.Decimal(430_000), ...over });
  const input = { reasonCode: 'refused' as const, note: ' Khách từ chối nhận, shipper đã thử giao 3 lần ', goodsReturned: false };

  it('đơn online ĐÃ THU tiền: cancelled kèm lý do, yêu cầu hoàn ĐỦ cho khách, chưa nhập kho (hàng chưa về); báo khách (kèm hoàn tiền) + CSKH; audit', async () => {
    const f = buildFixture([shipping()]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', input);
    const reason = 'Khách từ chối nhận hàng: Khách từ chối nhận, shipper đã thử giao 3 lần';
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
    expect(f.addHistory).toHaveBeenCalledWith('o1', ORDER_STATUS.SHIPPING, ORDER_STATUS.CANCELLED, reason, USER, TX);
    expect(f.requestRefund.mock.calls[0][0]).toMatchObject({ orderCode: 'DH261001', shopId: SHOP, amount: 430_000n, reason: `Huỷ đơn: ${reason}`, returnRequestId: null });
    expect(f.restock).not.toHaveBeenCalled();
    expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, title: 'Giao hàng không thành công — đơn DH261001 đã huỷ', content: `${reason}. Chúng tôi sẽ hoàn lại toàn bộ số tiền bạn đã thanh toán.`, link: '/account/orders/DH261001' });
    expect(f.staffIds).toHaveBeenCalledWith('order.return.process');
    expect(f.notifyMany.mock.calls[0][0]).toMatchObject([{ userId: 'staff-1', title: 'Giao không thành công — đơn DH261001', link: '/order/orders/DH261001' }]);
    expect(f.auditWrite).toHaveBeenCalledWith(TX, actor, expect.objectContaining({ action: ORDER_AUDIT.DELIVERY_FAILED, entityCode: 'DH261001', after: expect.objectContaining({ reasonCode: 'refused', goodsReturned: false, refundRequested: true, shopId: SHOP }) as unknown }));
    // PLAN-0031 §2.4: thêm sự kiện ORDER_DELIVERY_FAILED cho WP-08 (đếm "bom" của khách) — khách từ chối nhận ⇒ customerFault.
    expect(f.outboxPublish.mock.calls.map((c) => c[1].eventType)).toEqual([ORDER_EVENT.CANCELLED, ORDER_EVENT.DELIVERY_FAILED]);
    expect(f.outboxPublish.mock.calls[1][1].payload).toMatchObject({ orderCode: 'DH261001', userId: USER, shopId: SHOP, reasonCode: 'refused', paymentMethod: 'payos', customerFault: true });
  });

  it('goodsReturned = true ⇒ NHẬP KHO lại đúng các dòng của đơn', async () => {
    const f = buildFixture([shipping()]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', { ...input, goodsReturned: true, reasonCode: 'unreachable' });
    expect(f.restock).toHaveBeenCalledTimes(1);
    expect(f.restock.mock.calls[0][0]).toEqual([{ variantId: 'var-1', quantity: 2 }]);
    expect(f.restock.mock.calls[0][1]).toEqual({ type: 'order', id: 'DH261001' });
    expect(f.auditWrite.mock.calls.some((c) => (c[2].after as { goodsReturned?: boolean } | undefined)?.goodsReturned === true)).toBe(true);
  });

  it('lý do gửi payment ≤ 255 ký tự dù khách/shop nhập dài (giữ tiền tố "Huỷ đơn: ")', async () => {
    const f = buildFixture([shipping()]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', { reasonCode: 'other', note: 'n'.repeat(500), goodsReturned: false });
    const reason = f.requestRefund.mock.calls[0][0].reason;
    expect(reason.length).toBeLessThanOrEqual(255);
    expect(reason.startsWith('Huỷ đơn: Giao không thành công: n')).toBe(true);
  });

  it('đơn COD CHƯA thu tiền ⇒ huỷ giao dịch COD, KHÔNG hoàn tiền, thông báo khách không nhắc hoàn tiền', async () => {
    const f = buildFixture([shipping({ paymentMethodCode: 'cod', paymentStatus: PAYMENT_STATUS.UNPAID })]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', { ...input, reasonCode: 'lost' });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
    expect(f.requestRefund).not.toHaveBeenCalled();
    expect(f.cancelPayment).toHaveBeenCalledTimes(1);
    expect(f.notifyOne.mock.calls[0][0].content).not.toContain('hoàn lại');
    expect(f.notifyOne.mock.calls[0][0].content).toContain('Hàng thất lạc trong quá trình vận chuyển');
  });

  it('chỉ đơn ĐANG GIAO: đã giao / đóng gói / đã huỷ ⇒ ORDER_INVALID_TRANSITION, không ghi gì', async () => {
    for (const status of [ORDER_STATUS.PENDING, ORDER_STATUS.PACKING, ORDER_STATUS.DELIVERED, ORDER_STATUS.COMPLETED, ORDER_STATUS.CANCELLED]) {
      const f = buildFixture([mkOrder(1, { status, paymentStatus: PAYMENT_STATUS.PAID })]);
      await expect(f.service.deliveryFailed(actor, SHOP, 'DH261001', input)).rejects.toMatchObject({ errorCode: ORDER_ERR.INVALID_TRANSITION });
      expect(statusOf(f, 'DH261001')).toBe(status);
      expect(f.requestRefund).not.toHaveBeenCalled();
      expect(f.notifyOne).not.toHaveBeenCalled();
    }
  });

  it('đơn của shop khác / không tồn tại ⇒ 404 (không lộ tồn tại); shopId chỉ từ ngữ cảnh', async () => {
    const f = buildFixture([shipping()]);
    await expect(f.service.deliveryFailed(actor, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'DH261001', input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.deliveryFailed(actor, SHOP, 'DH-NOPE', input)).rejects.toBeInstanceOf(NotFoundException);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.SHIPPING);
  });

  it('còn yêu cầu đổi trả MỞ ⇒ ORDER_HAS_OPEN_RETURN, hoàn tác', async () => {
    const f = buildFixture([shipping()]);
    f.openReturnOrderIds.add('o1');
    await expect(f.service.deliveryFailed(actor, SHOP, 'DH261001', input)).rejects.toMatchObject({ errorCode: ORDER_ERR.HAS_OPEN_RETURN });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.SHIPPING);
    expect(f.requestRefund).not.toHaveBeenCalled();
  });

  it('gọi hai lần: lần hai thấy đã huỷ (không hoàn hai lần)', async () => {
    const f = buildFixture([shipping()]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', input);
    await expect(f.service.deliveryFailed(actor, SHOP, 'DH261001', input)).rejects.toMatchObject({ errorCode: ORDER_ERR.INVALID_TRANSITION });
    expect(f.requestRefund).toHaveBeenCalledTimes(1);
  });
});

// ====================================================================== (i) OrderResponse/OrderSummary: khoản hoàn + cờ đổi trả, tra theo LÔ — PLAN-0022 §4.5
describe('OrderService — refund + canReturn/canReportNotReceived theo lô (không N+1)', () => {
  const fullRow = (n: number, over: Partial<OrderState> & Record<string, unknown> = {}): OrderRow => {
    const base = mkOrder(n, over);
    return {
      ...base,
      recipientName: 'Nguyễn Văn A',
      recipientPhone: '0901234567',
      shippingAddress: '12 Nguyễn Huệ',
      customerNote: null,
      subtotal: new Prisma.Decimal(400_000),
      shippingFee: new Prisma.Decimal(30_000),
      discount: new Prisma.Decimal(0),
      shopDiscount: new Prisma.Decimal(0),
      platformDiscount: new Prisma.Decimal(0),
      promotionCode: null,
      promotionName: null,
      shopPromotionCode: null,
      shopPromotionName: null,
      itemCount: 2,
      trackingUrl: null,
      cancelReason: null,
      createdAt: new Date(),
      items: base.items.map((i) => ({ ...i, slug: 's', name: 'SP', imageUrl: null, color: 'Đen', size: 'M', sku: 'SKU', unitPrice: new Prisma.Decimal(200_000), lineTotal: new Prisma.Decimal(400_000), reviewed: false })),
      histories: [],
    } as unknown as OrderRow;
  };

  it('myOrdersFull: MỘT lần refundSummaries / findManyBrief / returnedQtyByItem cho cả trang; gắn khoản hoàn đúng đơn', async () => {
    const f = buildFixture();
    const rows = [fullRow(1, { status: ORDER_STATUS.DELIVERED, deliveredAt: new Date(Date.now() - DAY), paymentStatus: PAYMENT_STATUS.PAID }), fullRow(2, { status: ORDER_STATUS.SHIPPING }), fullRow(3, { status: ORDER_STATUS.CANCELLED })];
    f.repo.list.mockResolvedValue({ items: rows, total: 3 });
    f.refundSummaries.mockResolvedValue(new Map([['DH261002', { status: 'processing', amount: 430_000n }]]));
    const page = await f.service.myOrdersFull(actor, 1, 20);
    expect(f.refundSummaries).toHaveBeenCalledTimes(1);
    expect(f.refundSummaries).toHaveBeenCalledWith(['DH261001', 'DH261002', 'DH261003']);
    expect(f.shops.findManyBrief).toHaveBeenCalledTimes(1);
    expect(f.repo.returnedQtyByItem).toHaveBeenCalledTimes(1);
    expect(f.repo.returnedQtyByItem.mock.calls[0][0]).toEqual(['o1', 'o2']); // chỉ đơn có thể trả/báo chưa nhận
    expect(page.content.map((o) => o.refund?.status ?? null)).toEqual([null, 'processing', null]);
    expect(page.content[1].refund?.amount.amount).toBe('430000');
  });

  it('canReturn / canReportNotReceived: đang giao ⇒ chỉ báo chưa nhận; vừa giao ⇒ cả hai; giao quá hạn báo chưa nhận ⇒ chỉ đổi trả; hết số lượng ⇒ cả hai false', async () => {
    const f = buildFixture();
    const rows = [fullRow(1, { status: ORDER_STATUS.SHIPPING }), fullRow(2, { status: ORDER_STATUS.DELIVERED, deliveredAt: new Date(Date.now() - DAY) }), fullRow(3, { status: ORDER_STATUS.DELIVERED, deliveredAt: new Date(Date.now() - 5 * DAY) }), fullRow(4, { status: ORDER_STATUS.DELIVERED, deliveredAt: new Date(Date.now() - DAY) })];
    f.repo.list.mockResolvedValue({ items: rows, total: 4 });
    f.repo.returnedQtyByItem.mockResolvedValue(new Map([['i4', 2]])); // đơn 4 đã giữ hết 2/2 món
    const page = await f.service.myOrdersFull(actor, 1, 20);
    expect(page.content.map((o) => [o.canReturn, o.canReportNotReceived])).toEqual([
      [false, true],
      [true, true],
      [true, false],
      [false, false],
    ]);
  });

  it('danh sách tóm tắt (khách + sàn): MỘT lần refundSummaries cho cả trang, mỗi dòng mang refund của đơn', async () => {
    const f = buildFixture();
    f.repo.list.mockResolvedValue({ items: [fullRow(1), fullRow(2)], total: 2 });
    f.refundSummaries.mockResolvedValue(new Map([['DH261001', { status: 'done', amount: 100_000n }]]));
    const mine = await f.service.myOrders(actor, 1, 20);
    const admin = await f.service.listAdmin({}, 1, 20);
    expect(f.refundSummaries).toHaveBeenCalledTimes(2);
    expect(mine.content.map((o) => o.refund?.status ?? null)).toEqual(['done', null]);
    expect(admin.content.map((o) => o.refund?.status ?? null)).toEqual(['done', null]);
  });
});

// ====================================================================== (PLAN-0027) ma trận huỷ · hạn chót · SHP-04
describe('PLAN-0027 — ma trận huỷ đơn (khách · shop · sàn) trên OrderService', () => {
  const customerOrder = (over: Partial<OrderState> = {}) => mkOrder(1, { paymentMethodCode: 'cod', ...over });
  const paidOnline = (over: Partial<OrderState> = {}) => mkOrder(1, { paymentMethodCode: 'payos', paymentStatus: PAYMENT_STATUS.PAID, total: new Prisma.Decimal(430_000), ...over });
  const WHY = 'CSKH huỷ đơn tranh chấp, shop không phản hồi';
  const stubMyOrder = (f: Fixture) => jest.spyOn(f.service, 'myOrder').mockResolvedValue({ code: 'DH261001' } as never);
  const lastCancelledPayload = (f: Fixture) => events(f).find((e) => e.eventType === ORDER_EVENT.CANCELLED)?.payload;
  const updateData = (f: Fixture) => f.update.mock.calls.map((c) => c[1]).find((d) => d.status === ORDER_STATUS.CANCELLED) as Prisma.OrderUncheckedUpdateInput;

  it('[CAN-03] khách huỷ đơn CONFIRMED: tức thì, NHẬP LẠI kho (không nhả giữ chỗ), báo thành viên shop, ghi nguồn customer + mã lý do', async () => {
    const f = buildFixture([customerOrder({ status: ORDER_STATUS.CONFIRMED })]);
    stubMyOrder(f);
    await f.service.cancelByCustomer(actor, 'DH261001', 'Đổi ý', { reasonCode: 'changed_mind' });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
    expect(f.restock).toHaveBeenCalledTimes(1);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.requestRefund).not.toHaveBeenCalled(); // COD chưa thu tiền
    expect(updateData(f)).toMatchObject({ cancelSource: 'customer', cancelReasonCode: 'changed_mind', cancelReason: 'Đổi ý' });
    // G12: shop PHẢI biết khi khách huỷ
    expect(f.shopMembers).toHaveBeenCalledWith(SHOP, 'shop.order.read');
    expect(f.notifyMany.mock.calls[0][0]).toMatchObject([{ userId: 'shop-user-1', title: 'Đơn DH261001 đã bị huỷ', link: '/vendor/orders/DH261001' }]);
    expect(lastCancelledPayload(f)).toMatchObject({ orderCode: 'DH261001', shopId: SHOP, cancelSource: 'customer', reasonCode: 'changed_mind', fromStatus: 'confirmed' });
  });

  it('[CAN-03] khách huỷ đơn CONFIRMED đã trả PayOS ⇒ hoàn ĐỦ total', async () => {
    const f = buildFixture([paidOnline({ status: ORDER_STATUS.CONFIRMED })]);
    stubMyOrder(f);
    await f.service.cancelByCustomer(actor, 'DH261001', '', { reasonCode: 'found_cheaper', note: 'Giá rẻ hơn' });
    expect(f.requestRefund).toHaveBeenCalledTimes(1);
    expect(f.requestRefund.mock.calls[0][0]).toMatchObject({ orderCode: 'DH261001', amount: 430_000n, actorUserId: USER });
    expect(updateData(f).cancelReason).toBe('Tìm được nơi bán giá tốt hơn: Giá rẻ hơn');
  });

  it('[CAN-04] khách huỷ thẳng đơn PACKING ⇒ 409 CANNOT_CANCEL + gợi ý cancel_request, không động kho/tiền; SHIPPING ⇒ CANNOT_CANCEL', async () => {
    const f = buildFixture([customerOrder({ status: ORDER_STATUS.PACKING }), mkOrder(2, { status: ORDER_STATUS.SHIPPING })]);
    const err = await f.service.cancelByCustomer(actor, 'DH261001', 'Đổi ý').then(() => null, (e: unknown) => e as BusinessException);
    expect(err).toBeInstanceOf(BusinessException);
    expect(err?.errorCode).toBe(ORDER_ERR.CANNOT_CANCEL);
    expect(err?.httpStatus).toBe(409);
    expect(err?.details).toMatchObject({ hint: 'cancel_request' });
    await expect(f.service.cancelByCustomer(actor, 'DH261002', 'Đổi ý')).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
    expect(f.restock).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it('[CAN-07] shop huỷ đơn PACKING: nhập lại kho + hoàn đủ + nguồn shop; KHÔNG tự báo chính shop; yêu cầu huỷ đang chờ được chốt accepted', async () => {
    const f = buildFixture([paidOnline({ status: ORDER_STATUS.PACKING })]);
    Object.assign(f.state.get('DH261001') as object, { cancelRequestStatus: 'pending' }); // khách đã gửi yêu cầu huỷ, shop chưa trả lời
    await f.service.cancelByShop(staff, SHOP, 'DH261001', { reasonCode: 'customer_request', reason: 'Khách xin huỷ qua điện thoại' });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
    expect(f.restock).toHaveBeenCalledTimes(1);
    expect(f.requestRefund.mock.calls[0][0]).toMatchObject({ amount: 430_000n, shopId: SHOP });
    expect(updateData(f)).toMatchObject({ cancelSource: 'shop', cancelReasonCode: 'customer_request', cancelRequestStatus: 'accepted', cancelRequestResolvedBy: 'staff-1' });
    expect(f.shopMembers).not.toHaveBeenCalled();
    expect(f.notifyMany).not.toHaveBeenCalled();
    expect(lastCancelledPayload(f)).toMatchObject({ cancelSource: 'shop', reasonCode: 'customer_request', fromStatus: 'packing', hadRejectedRequest: false });
  });

  it('[CAN-07] shop huỷ: đơn shop khác ⇒ 404; đang giao/đã giao ⇒ 409 CANNOT_CANCEL; lý do < 5 ký tự ⇒ 400; mã lý do của bên khác ⇒ 400', async () => {
    const f = buildFixture([customerOrder(), mkOrder(2, { status: ORDER_STATUS.SHIPPING }), delivered(3)]);
    await expect(f.service.cancelByShop(staff, 'shop-khac', 'DH261001', { reason: 'Hết hàng thật' })).rejects.toBeInstanceOf(NotFoundException);
    for (const code of ['DH261002', 'DH261003']) await expect(f.service.cancelByShop(staff, SHOP, code, { reason: 'Hết hàng thật' })).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL, httpStatus: 409 });
    await expect(f.service.cancelByShop(staff, SHOP, 'DH261001', { reason: 'ngắn' })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
    await expect(f.service.cancelByShop(staff, SHOP, 'DH261001', { reasonCode: 'changed_mind', reason: 'Hết hàng thật' })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.PENDING);
    expect(f.requestRefund).not.toHaveBeenCalled();
  });

  it('[CAN-06] shop huỷ đơn CONFIRMED lý do out_of_stock: payload ORDER_CANCELLED mang đủ dữ liệu để listener ghi 1 điểm vi phạm', async () => {
    const f = buildFixture([customerOrder({ status: ORDER_STATUS.CONFIRMED })]);
    await f.service.cancelByShop(staff, SHOP, 'DH261001', { reasonCode: 'out_of_stock' });
    expect(updateData(f).cancelReason).toBe('Hết hàng');
    expect(lastCancelledPayload(f)).toMatchObject({ cancelSource: 'shop', reasonCode: 'out_of_stock', fromStatus: 'confirmed', shopId: SHOP });
  });

  it('[CAN-08] sàn huỷ đơn PACKING (tranh chấp): cần lý do ≥ 10 ký tự; nhập lại kho + hoàn; báo khách và người xử lý đơn của shop', async () => {
    const f = buildFixture([paidOnline({ status: ORDER_STATUS.PACKING })]);
    await expect(f.service.cancelByStaff(staff, 'DH261001', 'ngắn')).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.PACKING);
    await f.service.cancelByStaff(staff, 'DH261001', WHY, { reasonCode: 'dispute' });
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
    expect(f.restock).toHaveBeenCalledTimes(1);
    expect(f.requestRefund.mock.calls[0][0]).toMatchObject({ amount: 430_000n, actorUserId: 'staff-1' });
    expect(updateData(f)).toMatchObject({ cancelSource: 'platform', cancelReasonCode: 'dispute' });
    expect(f.shopMembers).toHaveBeenCalledWith(SHOP, 'shop.order.update');
    expect(f.notifyMany.mock.calls[0][0]).toMatchObject([{ title: 'Sàn đã huỷ đơn DH261001 đang đóng gói' }]);
    expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, title: 'Đơn DH261001 đã huỷ' });
  });

  it('[CAN-13] đơn partially_refunded: hoàn PHẦN CÒN LẠI = total − đã hoàn theo đơn; đã hoàn hết số tiền ⇒ không tạo thêm khoản hoàn', async () => {
    const f = buildFixture([paidOnline({ status: ORDER_STATUS.CONFIRMED, paymentStatus: PAYMENT_STATUS.PARTIALLY_REFUNDED })]);
    const committed = (f.service as unknown as { payments: { orderRefundCommitted: jest.Mock } }).payments.orderRefundCommitted;
    committed.mockResolvedValue(130_000n);
    stubMyOrder(f);
    await f.service.cancelByCustomer(actor, 'DH261001', 'Đổi ý');
    expect(committed).toHaveBeenCalledWith('DH261001', TX);
    expect(f.requestRefund).toHaveBeenCalledTimes(1);
    expect(f.requestRefund.mock.calls[0][0]).toMatchObject({ amount: 300_000n, reason: 'Huỷ đơn (hoàn phần còn lại): Đổi ý' });
    expect(f.cancelPayment).not.toHaveBeenCalled();

    const g = buildFixture([paidOnline({ status: ORDER_STATUS.CONFIRMED, paymentStatus: PAYMENT_STATUS.PARTIALLY_REFUNDED })]);
    (g.service as unknown as { payments: { orderRefundCommitted: jest.Mock } }).payments.orderRefundCommitted.mockResolvedValue(430_000n);
    stubMyOrder(g);
    await g.service.cancelByCustomer(actor, 'DH261001', 'Đổi ý');
    expect(statusOf(g, 'DH261001')).toBe(ORDER_STATUS.CANCELLED);
    expect(g.requestRefund).not.toHaveBeenCalled();
  });

  it('[CONC-03/CONC-05] mọi đường huỷ khoá dòng đơn TRƯỚC khi kiểm trạng thái: huỷ lần hai (đã cancelled) bị từ chối, hoàn tiền đúng 1 lần', async () => {
    const f = buildFixture([paidOnline({ status: ORDER_STATUS.CONFIRMED })]);
    stubMyOrder(f);
    await f.service.cancelByCustomer(actor, 'DH261001', 'Đổi ý');
    await f.service.cancelByCustomer(actor, 'DH261001', 'Đổi ý lần nữa'); // chính khách bấm lại: idempotent, không lỗi, không hoàn lần hai
    await expect(f.service.cancelByShop(staff, SHOP, 'DH261001', { reason: 'Hết hàng thật' })).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
    await expect(f.service.cancelByStaff(staff, 'DH261001', WHY)).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
    expect(f.requestRefund).toHaveBeenCalledTimes(1);
    expect(f.findByCodeForUpdate.mock.calls.length).toBe(4);
    expect(f.notifyOne).toHaveBeenCalledTimes(1); // khách chỉ nhận MỘT thông báo huỷ
    expect(f.findByCode).not.toHaveBeenCalled(); // không đọc-rồi-quyết ngoài khoá
  });

  it('[ORDER_CANCELLED] đơn hết hạn thanh toán do hệ thống huỷ: nguồn system + mã payment_expired, KHÔNG báo shop', async () => {
    const f = buildFixture([mkOrder(1, { paymentExpiresAt: new Date(Date.now() - 3 * DAY) })]);
    f.expiredRows.push({ code: 'DH261001', paymentExpiresAt: new Date(Date.now() - 3 * DAY) });
    expect(await f.service.cancelExpired()).toBe(1);
    expect(updateData(f)).toMatchObject({ cancelSource: 'system', cancelReasonCode: 'payment_expired' });
    expect(f.notifyMany).not.toHaveBeenCalled();
  });
});

describe('PLAN-0027 — hạn chót luôn được ghi + SHP-04', () => {
  const HOUR_MS = 3_600_000;
  const place = (f: Fixture, paymentMethodCode: string) => f.service.placeOrder(actor, { address: ADDRESS, paymentMethodCode }, null);

  it('[FUL-04a] xác nhận đơn ⇒ ship_due_at = lúc xác nhận + order.shop_ship_hours (mặc định 48h khi chưa cấu hình)', async () => {
    const f = buildFixture([mkOrder(1, { paymentMethodCode: 'cod' })]);
    await f.service.updateStatus(staff, 'DH261001', ORDER_STATUS.CONFIRMED, {});
    const data = f.update.mock.calls[0][1] as { shipDueAt: Date };
    expect(Math.abs(data.shipDueAt.getTime() - (Date.now() + 48 * HOUR_MS))).toBeLessThan(5_000);
  });

  it('[FUL-04a] đặt đơn COD ⇒ confirm_due_at = bây giờ + 24h; đặt đơn PayOS ⇒ chưa có hạn xác nhận (chỉ tính khi nhận tiền)', async () => {
    const cod = buildFixture();
    await place(cod, 'cod');
    const codData = cod.create.mock.calls[0][0] as { confirmDueAt: Date | null };
    expect(Math.abs((codData.confirmDueAt as Date).getTime() - (Date.now() + 24 * HOUR_MS))).toBeLessThan(5_000);
    const payos = buildFixture();
    await place(payos, 'payos');
    expect((payos.create.mock.calls[0][0] as { confirmDueAt: Date | null }).confirmDueAt).toBeNull();
  });

  it('[FUL-04a] tiền PayOS về (onPaid) ⇒ confirm_due_at = lúc nhận tiền + 24h, xoá cờ nhắc; COD không bị ghi đè', async () => {
    const f = buildFixture([mkOrder(1, { paymentMethodCode: 'payos' }), mkOrder(2, { paymentMethodCode: 'cod' })]);
    const paidAt = new Date();
    await f.service.onPaid('DH261001', { paymentId: 'p1', methodCode: 'payos', transactionCode: 'T1', bankCode: null, paidAt }, TX);
    const due = f.update.mock.calls.map((c) => c[1]).find((d) => 'confirmDueAt' in d) as { confirmDueAt: Date; confirmRemindedAt: null };
    expect(Math.abs(due.confirmDueAt.getTime() - (paidAt.getTime() + 24 * HOUR_MS))).toBeLessThan(5_000);
    expect(due.confirmRemindedAt).toBeNull();
    f.update.mockClear();
    await f.service.onPaid('DH261002', { paymentId: 'p2', methodCode: 'cod', transactionCode: null, bankCode: null, paidAt }, TX);
    expect(f.update.mock.calls.map((c) => c[1]).some((d) => 'confirmDueAt' in d)).toBe(false);
  });

  it('[SHP-04] tự hoàn tất BỎ QUA đơn có yêu cầu đổi trả đang mở (kể cả khi yêu cầu mở giữa lúc quét và lúc khoá); đơn khác vẫn hoàn tất; không lặp vô hạn', async () => {
    const f = buildFixture([delivered(1, 20), delivered(2, 15)]);
    f.openReturnOrderIds.add('o1');
    const n = await f.service.autoComplete(1);
    expect(n).toBe(1);
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.DELIVERED);
    expect(statusOf(f, 'DH261002')).toBe(ORDER_STATUS.COMPLETED);
    expect(f.addSold).toHaveBeenCalledTimes(1);
    expect(f.update.mock.calls.every((c) => c[0] !== 'o1')).toBe(true);
    expect(f.update.mock.calls.find((c) => c[0] === 'o2')?.[1]).toMatchObject({ completedBy: 'system' });
  });

  it('[SHP-04] sàn không hoàn tất tay (delivered → completed) khi còn đổi trả mở ⇒ 409 ORDER_HAS_OPEN_RETURN, không cộng đã bán', async () => {
    const f = buildFixture([delivered(1)]);
    f.openReturnOrderIds.add('o1');
    await expect(f.service.updateStatus(staff, 'DH261001', ORDER_STATUS.COMPLETED, {})).rejects.toMatchObject({ errorCode: ORDER_ERR.HAS_OPEN_RETURN, httpStatus: 409 });
    expect(f.addSold).not.toHaveBeenCalled();
    expect(statusOf(f, 'DH261001')).toBe(ORDER_STATUS.DELIVERED);
  });
});
