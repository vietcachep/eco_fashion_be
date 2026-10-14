import { Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { InventoryGateway } from '@common/gateway/inventory.gateway';
import type { NotifyCommand } from '@common/gateway/notification.gateway';
import type { PaymentGateway } from '@common/gateway/payment.gateway';
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
 * OrderService/ReturnService chạy THẬT; repository là kho đơn trong bộ nhớ (có rollback khi transaction ném lỗi) nên kiểm được cả trạng thái sau cùng.
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
    paymentMethodCode: 'vnpay',
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
  [SETTING_KEY.ORDER_VNPAY_TIMEOUT_MINUTES]: 15,
  [SETTING_KEY.ORDER_BANK_TRANSFER_TIMEOUT_HOURS]: 24,
  [SETTING_KEY.ORDER_COD_MAX_AMOUNT]: 0,
  [SETTING_KEY.RETURN_WINDOW_DAYS]: 7,
};

const brief: ShopBrief = { id: SHOP, code: 'S-A', slug: 'shop-a', name: 'Shop A', logoUrl: null, ratingAvg: null, status: 'approved', commissionRate: '5.00', codEnabled: true };
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
  const repo = { findByCode, findByCodeForUpdate, findDeliveredBefore, update, addHistory, nextGroupCode, nextCode, createGroup, create };

  const auditWrite = jest.fn((_tx: Tx, _actor: unknown, _entry: AuditLike): Promise<void> => Promise.resolve());
  const outboxPublish = jest.fn((_tx: Tx, _evt: OutboxLike): Promise<void> => Promise.resolve());
  const notifyOne = jest.fn((_cmd: NotifyCommand, _tx?: Tx): Promise<void> => Promise.resolve());
  const notifyMany = jest.fn((_cmds: NotifyCommand[], _tx?: Tx): Promise<void> => Promise.resolve());
  const addSold = jest.fn((_items: Array<{ productId: string; quantity: number }>, _tx?: Tx): Promise<void> => Promise.resolve());
  const staffIds = jest.fn((_perm: string): Promise<string[]> => Promise.resolve(['staff-1']));

  const commit = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const reserve = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const inventory = { commit, reserve, release: jest.fn(), restock: jest.fn(), availableOf: jest.fn() } as unknown as InventoryGateway;

  const requestRefund = jest.fn((_input: { orderCode: string; shopId: string | null; amount: bigint; reason: string; returnRequestId: string | null; actorUserId: string | null; paymentId?: string }, _tx: Tx): Promise<{ refundId: string | null }> => Promise.resolve({ refundId: 'rf-1' }));
  const initiate = jest.fn((_input: { orderCode: string; amount: bigint; methodCode: string; bankCode?: string | null }, _tx: Tx): Promise<unknown> => Promise.resolve({}));
  const payment = { isMethodActive: jest.fn((_m: string): Promise<boolean> => Promise.resolve(true)), initiate, requestRefund, cancel: jest.fn(), markCodCollected: jest.fn() } as unknown as PaymentGateway;

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
  const shops = { findBrief: jest.fn((_id: string): Promise<ShopBrief | null> => Promise.resolve(brief)), activeMemberUserIds: jest.fn((_id: string): Promise<string[]> => Promise.resolve([])) };
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
    {} as never,
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

  return { service, state, repo, update, addHistory, findByCodeForUpdate, findDeliveredBefore, findByCode, create, createGroup, auditWrite, outboxPublish, notifyOne, notifyMany, addSold, commit, requestRefund, initiate, getAdmin, shops };
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

  it('đơn pending bình thường (online): paid + audit + thông báo "Đã nhận thanh toán" + thông báo nhân viên + outbox ORDER_PAID; KHÔNG hoàn', async () => {
    const f = buildFixture([mkOrder(1, { paymentMethodCode: 'vnpay', total: new Prisma.Decimal(430_000) })]);
    await f.service.onPaid('DH261001', info({ methodCode: 'vnpay' }), TX);
    expect(f.state.get('DH261001')).toMatchObject({ status: 'pending', paymentStatus: 'paid', paymentExpiresAt: null });
    expect(f.requestRefund).not.toHaveBeenCalled();
    expect(f.auditWrite).toHaveBeenCalledWith(TX, null, { action: ORDER_AUDIT.PAID, entityType: 'order', entityId: 'o1', entityCode: 'DH261001', after: { method: 'vnpay', transactionCode: 'T-1' } });
    expect(f.notifyOne).toHaveBeenCalledTimes(1);
    expect(f.notifyOne.mock.calls[0][0]).toMatchObject({ userId: USER, type: 'payment', title: 'Đã nhận thanh toán đơn DH261001' });
    expect(f.notifyMany).toHaveBeenCalledTimes(1);
    expect(f.notifyMany.mock.calls[0][0]).toMatchObject([{ userId: 'staff-1', type: 'payment', title: 'Đơn DH261001 đã thanh toán', content: 'vnpay · 430.000 ₫' }]);
    expect(f.outboxPublish).toHaveBeenCalledWith(TX, { eventType: ORDER_EVENT.PAID, aggregateType: 'order', aggregateId: 'o1', payload: { orderCode: 'DH261001', userId: USER, methodCode: 'vnpay' } });
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
describe('hạn thanh toán (paymentExpiry)', () => {
  const near = (d: Date | null | undefined, ms: number) => d instanceof Date && Math.abs(d.getTime() - (Date.now() + ms)) < 5_000;
  const place = (f: Fixture, paymentMethodCode: string) => f.service.placeOrder(actor, { address: ADDRESS, paymentMethodCode }, null);
  const expiresAt = (f: Fixture) => f.create.mock.calls[0][0].paymentExpiresAt as Date | null | undefined;

  it('đơn PayOS có paymentExpiresAt = cùng hạn VNPay (15 phút)', async () => {
    const f = buildFixture();
    await place(f, 'payos');
    expect(near(expiresAt(f), 15 * 60_000)).toBe(true);
    expect(f.initiate.mock.calls[0][0]).toMatchObject({ methodCode: 'payos', amount: 430_000n });
  });

  it('VNPay (và thẻ quốc tế "card") 15 phút; chuyển khoản 24 giờ; COD không có hạn', async () => {
    const vnpay = buildFixture();
    await place(vnpay, 'vnpay');
    expect(near(expiresAt(vnpay), 15 * 60_000)).toBe(true);
    const card = buildFixture();
    await place(card, 'card');
    expect(near(expiresAt(card), 15 * 60_000)).toBe(true);
    expect(card.initiate.mock.calls[0][0]).toMatchObject({ methodCode: 'vnpay', bankCode: 'INTCARD' });
    const bank = buildFixture();
    await place(bank, 'bank_transfer');
    expect(near(expiresAt(bank), 24 * 3_600_000)).toBe(true);
    const cod = buildFixture();
    await place(cod, 'cod');
    expect(expiresAt(cod)).toBeNull();
  });

  it('paymentExpiry trực tiếp: payos = vnpay, bank_transfer = 24h, cod = null', async () => {
    const f = buildFixture();
    const payos = await f.service['paymentExpiry']('payos');
    const vnpay = await f.service['paymentExpiry']('vnpay');
    expect(near(payos, 15 * 60_000)).toBe(true);
    expect(near(vnpay, 15 * 60_000)).toBe(true);
    expect(near(await f.service['paymentExpiry']('bank_transfer'), 24 * 3_600_000)).toBe(true);
    expect(await f.service['paymentExpiry']('cod')).toBeNull();
  });
});

// ====================================================================== (f) lưới chuyển trạng thái không còn `returned`
describe('STAFF_TRANSITIONS / updateStatus — không chuyển tay sang returned', () => {
  it('lưới: delivered → [completed], completed → [], không trạng thái nào cho phép sang returned', () => {
    expect(STAFF_TRANSITIONS.delivered).toEqual(['completed']);
    expect(STAFF_TRANSITIONS.completed).toEqual([]);
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

// ====================================================================== (g) ReturnService — hoàn tiền theo tỉ lệ trên total
describe('ReturnService.create — số tiền hoàn', () => {
  interface RItem {
    id: string;
    qty: number;
    unit: number;
  }
  interface ROrder {
    subtotal: number;
    total: number;
    items: RItem[];
    status?: string;
    userId?: string;
    deliveredDaysAgo?: number;
  }

  function buildReturn(order: ROrder | null, opts: { open?: Array<{ orderItemId: string; _sum: { quantity: number | null } }> } = {}) {
    const row = order
      ? {
          id: 'order-1',
          code: 'DH261001',
          userId: order.userId ?? USER,
          status: order.status ?? ORDER_STATUS.DELIVERED,
          deliveredAt: new Date(Date.now() - (order.deliveredDaysAgo ?? 1) * DAY),
          subtotal: new Prisma.Decimal(order.subtotal),
          total: new Prisma.Decimal(order.total),
          items: order.items.map((i) => ({ id: i.id, variantId: `var-${i.id}`, name: `SP ${i.id}`, color: 'Đen', size: 'M', quantity: i.qty, imageUrl: null, unitPrice: new Prisma.Decimal(i.unit) })),
        }
      : null;
    const groupBy = jest.fn((_args: unknown): Promise<Array<{ orderItemId: string; _sum: { quantity: number | null } }>> => Promise.resolve(opts.open ?? []));
    const create = jest.fn(
      (args: { data: { orderCode: string; reason: string; detail: string | null; refundAmount: string; evidence: unknown; items: { create: Array<{ orderItemId: string; name: string; color: string; size: string; quantity: number; imageUrl: string | null }> } } }) =>
        Promise.resolve({ id: 'rr-1', orderCode: args.data.orderCode, status: 'requested', reason: args.data.reason, detail: args.data.detail, rejectReason: null, refundAmount: new Prisma.Decimal(args.data.refundAmount), evidence: args.data.evidence, processedAt: null, createdAt: new Date(), items: args.data.items.create }),
    );
    const tx = { returnRequestItem: { groupBy }, returnRequest: { create } } as unknown as Tx;
    const prisma = { $transaction: jest.fn((fn: (t: Tx) => Promise<unknown>): Promise<unknown> => fn(tx)) };
    const orders = { findByCodeForUpdate: jest.fn((_code: string, _tx: Tx): Promise<OrderRow | null> => Promise.resolve(row as unknown as OrderRow | null)) };
    const auditWrite = jest.fn((_tx: Tx, _actor: unknown, _entry: AuditLike): Promise<void> => Promise.resolve());
    const outboxPublish = jest.fn((_tx: Tx, _evt: OutboxLike): Promise<void> => Promise.resolve());
    const system = { settingNumber: jest.fn((key: string): Promise<number> => Promise.resolve(SETTINGS[key] ?? 0)) };
    const svc = new ReturnService(
      prisma as unknown as PrismaService,
      orders as unknown as OrderRepository,
      { write: auditWrite } as never,
      { publish: outboxPublish } as never,
      system as unknown as SystemQueryApi,
      {} as never,
      {} as never,
      { notify: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()), notifyMany: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) },
      { staffUserIdsWithPermission: jest.fn((_p: string): Promise<string[]> => Promise.resolve(['staff-1'])) } as never,
    );
    const EVIDENCE = [{ type: 'image', url: 'https://img/1.jpg', name: '1.jpg' }];
    const ask = (items: Array<{ orderItemId: string; quantity: number }>, evidence = EVIDENCE) => svc.create(actor, 'DH261001', { reason: 'Lỗi sản phẩm', items, evidence });
    return { svc, ask, create, prisma, auditWrite, outboxPublish, groupBy };
  }
  const refundOf = async (order: ROrder, items: Array<{ orderItemId: string; quantity: number }>) => {
    const r = buildReturn(order);
    const res = await r.ask(items);
    expect(r.create.mock.calls[0][0].data.refundAmount).toBe(res.refundAmount.amount); // DB lưu đúng số trả về
    return res.refundAmount.amount;
  };

  it('voucher FREESHIP: subtotal 100.000, ship 30.000, giảm 30.000 ⇒ total 100.000 ⇒ trả hết hàng hoàn đúng 100.000 (cách cũ chỉ hoàn 70.000)', async () => {
    const order: ROrder = { subtotal: 100_000, total: 100_000, items: [{ id: 'i1', qty: 2, unit: 50_000 }] };
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 2 }])).toBe('100000');
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 1 }])).toBe('50000');
  });

  it('voucher %: subtotal 200.000, giảm 20.000, ship 0 ⇒ total 180.000: trả nửa hàng hoàn 90.000, trả hết hoàn 180.000', async () => {
    const order: ROrder = { subtotal: 200_000, total: 180_000, items: [{ id: 'i1', qty: 1, unit: 100_000 }, { id: 'i2', qty: 1, unit: 100_000 }] };
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 1 }])).toBe('90000');
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 1 }, { orderItemId: 'i2', quantity: 1 }])).toBe('180000');
  });

  it('không voucher nhưng có phí ship (total = subtotal + ship): hoàn theo tỉ lệ, trả hết = total', async () => {
    const order: ROrder = { subtotal: 100_000, total: 130_000, items: [{ id: 'i1', qty: 2, unit: 50_000 }] };
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 2 }])).toBe('130000');
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 1 }])).toBe('65000');
  });

  it('nhiều dòng, nhiều số lượng: Σ(unitPrice × qty) × total / subtotal', async () => {
    const order: ROrder = { subtotal: 350_000, total: 300_000, items: [{ id: 'i1', qty: 2, unit: 100_000 }, { id: 'i2', qty: 3, unit: 50_000 }] };
    // trả 1×i1 + 2×i2 = 200.000 → 200.000 × 300.000 / 350.000 = 171.428,57… → 171.428
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 1 }, { orderItemId: 'i2', quantity: 2 }])).toBe('171428');
  });

  it('làm tròn XUỐNG đơn vị đồng; tổng các lần trả lẻ không bao giờ vượt total', async () => {
    const order: ROrder = { subtotal: 99_999, total: 80_000, items: [{ id: 'i1', qty: 1, unit: 33_333 }, { id: 'i2', qty: 1, unit: 33_333 }, { id: 'i3', qty: 1, unit: 33_333 }] };
    const parts = [await refundOf(order, [{ orderItemId: 'i1', quantity: 1 }]), await refundOf(order, [{ orderItemId: 'i2', quantity: 1 }]), await refundOf(order, [{ orderItemId: 'i3', quantity: 1 }])];
    expect(parts).toEqual(['26666', '26666', '26666']); // 33.333 × 80.000 / 99.999 = 26.666,93…
    expect(parts.reduce((s, p) => s + BigInt(p), 0n)).toBeLessThanOrEqual(80_000n);
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 1 }, { orderItemId: 'i2', quantity: 1 }, { orderItemId: 'i3', quantity: 1 }])).toBe('80000');
  });

  it('tối đa total: dữ liệu snapshot lệch (Σ dòng > subtotal) vẫn không hoàn quá total', async () => {
    const order: ROrder = { subtotal: 100_000, total: 80_000, items: [{ id: 'i1', qty: 1, unit: 120_000 }] };
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 1 }])).toBe('80000'); // 120.000 × 80.000 / 100.000 = 96.000 → cắt về 80.000
  });

  it('subtotal = 0 (không chia được) ⇒ hoàn = Σ dòng, vẫn bị chặn trên bởi total', async () => {
    const order: ROrder = { subtotal: 0, total: 30_000, items: [{ id: 'i1', qty: 1, unit: 50_000 }] };
    expect(await refundOf(order, [{ orderItemId: 'i1', quantity: 1 }])).toBe('30000');
  });

  it('ghi yêu cầu + audit (refund) + outbox RETURN_REQUESTED; trả về số tiền hoàn dạng Money', async () => {
    const r = buildReturn({ subtotal: 200_000, total: 180_000, items: [{ id: 'i1', qty: 1, unit: 100_000 }, { id: 'i2', qty: 1, unit: 100_000 }] });
    const res = await r.ask([{ orderItemId: 'i1', quantity: 1 }]);
    expect(res).toMatchObject({ orderCode: 'DH261001', status: 'requested', refundAmount: { amount: '90000', display: '90.000 ₫' } });
    expect(r.auditWrite.mock.calls[0][2]).toMatchObject({ action: ORDER_AUDIT.RETURN_REQUESTED, after: { refund: '90000' } });
    expect(r.outboxPublish.mock.calls[0][1].eventType).toBe(ORDER_EVENT.RETURN_REQUESTED);
  });

  describe('điều kiện tạo yêu cầu', () => {
    const one: ROrder = { subtotal: 100_000, total: 100_000, items: [{ id: 'i1', qty: 2, unit: 50_000 }] };

    it('không có minh chứng ⇒ EVIDENCE_REQUIRED, không mở transaction', async () => {
      const r = buildReturn(one);
      await expect(r.ask([{ orderItemId: 'i1', quantity: 1 }], [])).rejects.toMatchObject({ errorCode: ORDER_ERR.EVIDENCE_REQUIRED });
      expect(r.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('đơn của người khác / không tồn tại ⇒ NotFound', async () => {
      await expect(buildReturn({ ...one, userId: 'someone-else' }).ask([{ orderItemId: 'i1', quantity: 1 }])).rejects.toBeInstanceOf(NotFoundException);
      await expect(buildReturn(null).ask([{ orderItemId: 'i1', quantity: 1 }])).rejects.toBeInstanceOf(NotFoundException);
    });

    it('chỉ đổi trả đơn delivered/completed; đơn đang giao ⇒ RETURN_NOT_ALLOWED', async () => {
      await expect(buildReturn({ ...one, status: ORDER_STATUS.SHIPPING }).ask([{ orderItemId: 'i1', quantity: 1 }])).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_ALLOWED });
      await expect(buildReturn({ ...one, status: ORDER_STATUS.COMPLETED }).ask([{ orderItemId: 'i1', quantity: 1 }])).resolves.toMatchObject({ status: 'requested' });
    });

    it('quá hạn đổi trả (setting return.window_days = 7) ⇒ RETURN_WINDOW_CLOSED', async () => {
      await expect(buildReturn({ ...one, deliveredDaysAgo: 10 }).ask([{ orderItemId: 'i1', quantity: 1 }])).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_WINDOW_CLOSED });
    });

    it('vượt số lượng còn có thể trả (trừ yêu cầu đang mở/đã duyệt) ⇒ RETURN_NOT_ALLOWED; dòng không thuộc đơn ⇒ NotFound', async () => {
      const r = buildReturn(one, { open: [{ orderItemId: 'i1', _sum: { quantity: 1 } }] });
      await expect(r.ask([{ orderItemId: 'i1', quantity: 2 }])).rejects.toMatchObject({ errorCode: ORDER_ERR.RETURN_NOT_ALLOWED, message: 'SP i1: chỉ còn 1 có thể trả' });
      await expect(r.ask([{ orderItemId: 'i1', quantity: 1 }])).resolves.toMatchObject({ status: 'requested' });
      await expect(buildReturn(one).ask([{ orderItemId: 'khong-co', quantity: 1 }])).rejects.toBeInstanceOf(NotFoundException);
      expect(r.create).toHaveBeenCalledTimes(1);
    });
  });
});
