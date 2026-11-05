import { Logger } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import type { NotifyCommand } from '@common/gateway/notification.gateway';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { carrierName, resolveShippingProof } from '../../foundation/delivery.rules';
import { CARRIERS, CARRIER_CODES, ORDER_AUDIT, ORDER_ERR, ORDER_EVENT, ORDER_STATUS, PAYMENT_STATUS } from '../../foundation/order.constants';
import { toOrderResponse } from '../mapper/order.mapper';
import type { OrderRow } from '../repository/order.repository';
import { OrderService } from './order.service';
import { ShopOrderService } from './shop-order.service';

/*
 * Giao hàng có bằng chứng (PLAN-0031, PLAN-0040 Tầng 3.6–3.7): hãng + mã vận đơn bắt buộc khi chuyển `shipping` (FUL-08), cờ dùng lại mã vận đơn (SHP-13), chặn "đã giao" khi khách đang
 * báo chưa nhận hàng (SHP-06), giao thất bại + "hàng đã về kho" nhập kho đúng một lần (SHP-09). OrderService chạy THẬT trên kho đơn trong bộ nhớ (có rollback khi transaction ném lỗi);
 * doCancel được thay bằng bản giả ghi lại tham số (logic huỷ đã có spec riêng) nên test không phụ thuộc phần huỷ/SLA.
 */

const USER = 'user-1';
const SHOP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SHOP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86_400_000;
const TX = { __tx: true } as unknown as Tx;
const actor: AuthenticatedActor = { userId: 'shop-user-1', email: 'shop@fitly.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti' };

interface State {
  id: string;
  code: string;
  userId: string;
  shopId: string;
  orderGroupId: string;
  status: string;
  paymentStatus: string;
  paymentMethodCode: string;
  total: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  shopDiscount: Prisma.Decimal;
  shopShippingDiscount: Prisma.Decimal;
  platformDiscount: Prisma.Decimal;
  commissionRateSnapshot: Prisma.Decimal;
  items: Array<{ id: string; productId: string; variantId: string; quantity: number }>;
  carrier: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  trackingReused: boolean;
  deliveryFailedAt: Date | null;
  deliveryFailedReason: string | null;
  goodsReturnedAt: Date | null;
}

const mk = (n: number, over: Partial<State> = {}): State => ({
  id: `o${n}`,
  code: `DH26100${n}`,
  userId: USER,
  shopId: SHOP,
  orderGroupId: 'grp-1',
  status: ORDER_STATUS.PACKING,
  paymentStatus: PAYMENT_STATUS.UNPAID,
  paymentMethodCode: 'cod',
  total: new Prisma.Decimal(430_000),
  subtotal: new Prisma.Decimal(400_000),
  shopDiscount: new Prisma.Decimal(0),
  shopShippingDiscount: new Prisma.Decimal(0),
  platformDiscount: new Prisma.Decimal(0),
  commissionRateSnapshot: new Prisma.Decimal('5.00'),
  items: [{ id: `i${n}`, productId: `prod-${n}`, variantId: `var-${n}`, quantity: 2 }],
  carrier: null,
  trackingCode: null,
  trackingUrl: null,
  trackingReused: false,
  deliveryFailedAt: null,
  deliveryFailedReason: null,
  goodsReturnedAt: null,
  ...over,
});

function build(seed: State[]) {
  const state = new Map(seed.map((o) => [o.code, { ...o }]));
  const snapshot = () => new Map([...state].map(([k, v]) => [k, { ...v, items: [...v.items] }]));
  const openNotReceived = new Set<string>();
  const openReturn = new Set<string>();
  const view = (o: State | undefined) => (o ? ({ ...o } as unknown as OrderRow) : null);
  const repo = {
    findByCodeForUpdate: jest.fn((code: string, _tx: Tx) => Promise.resolve(view(state.get(code)))),
    update: jest.fn((id: string, data: Record<string, unknown>, _tx: Tx) => {
      const o = [...state.values()].find((x) => x.id === id);
      if (!o) return Promise.reject(new Error('không có đơn'));
      for (const [k, v] of Object.entries(data)) if (k !== 'version') (o as unknown as Record<string, unknown>)[k] = v;
      return Promise.resolve(view(o));
    }),
    addHistory: jest.fn((_orderId: string, _from: string | null, _to: string, _note: string | null, _actor: string | null, _tx: Tx) => Promise.resolve()),
    hasOpenNotReceived: jest.fn((orderId: string, _tx?: Tx | null) => Promise.resolve(openNotReceived.has(orderId))),
    hasOpenReturn: jest.fn((orderId: string, _tx?: Tx | null) => Promise.resolve(openReturn.has(orderId))),
    trackingCodeUsedByOther: jest.fn((shopId: string, code: string, excludeId: string, _tx: Tx) =>
      Promise.resolve([...state.values()].some((o) => o.shopId === shopId && o.id !== excludeId && o.status !== ORDER_STATUS.CANCELLED && o.trackingCode?.toUpperCase() === code.toUpperCase())),
    ),
  };
  const audits: Array<{ action: string; entityCode?: string | null; after?: Record<string, unknown> | null }> = [];
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const notes: NotifyCommand[] = [];
  const audit = { write: jest.fn((_tx: Tx, _actor: unknown, e: { action: string; entityCode?: string | null; after?: Record<string, unknown> | null }) => (audits.push(e), Promise.resolve())) };
  const outbox = { publish: jest.fn((_tx: Tx, e: { eventType: string; payload: Record<string, unknown> }) => (events.push(e), Promise.resolve())) };
  const notify = { notify: jest.fn((c: NotifyCommand, _tx?: Tx) => (notes.push(c), Promise.resolve())), notifyMany: jest.fn((c: NotifyCommand[], _tx?: Tx) => (notes.push(...c), Promise.resolve())) };
  const inventory = { commit: jest.fn(() => Promise.resolve()), restock: jest.fn((_l: unknown, _r: unknown, _tx: Tx) => Promise.resolve()), release: jest.fn(() => Promise.resolve()) };
  const payment = { markCodCollected: jest.fn((_c: string, _a: string | null, _tx: Tx, _sale: unknown) => Promise.resolve()) };
  const users = { staffUserIdsWithPermission: jest.fn((_perm: string) => Promise.resolve(['staff-1'])) };
  // Mô phỏng khoá dòng đơn (SELECT … FOR UPDATE) bằng cách xếp hàng các transaction: transaction sau chỉ đọc sau khi transaction trước commit/rollback.
  let queue: Promise<unknown> = Promise.resolve();
  const runTx = async (fn: (tx: Tx) => Promise<unknown>) => {
    const snap = snapshot();
    const counters = { a: audits.length, e: events.length, n: notes.length };
    try {
      return await fn(TX);
    } catch (err) {
      state.clear();
      for (const [k, v] of snap) state.set(k, v);
      audits.length = counters.a;
      events.length = counters.e;
      notes.length = counters.n;
      throw err;
    }
  };
  const prisma = {
    $transaction: jest.fn((fn: (tx: Tx) => Promise<unknown>) => {
      const run = queue.then(() => runTx(fn));
      queue = run.catch(() => undefined);
      return run;
    }),
  };
  // Không phụ thuộc thứ tự tham số constructor (agent khác đang mở rộng): gán thẳng các phụ thuộc mà đường giao hàng dùng.
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, { prisma, repo, audit, outbox, notify, inventory, payment, users, logger: new Logger('test') });
  const doCancel = jest.spyOn(service, 'doCancel').mockImplementation((o, _reason, _actor, _tx, opts) => {
    (state.get(o.code) as State).status = ORDER_STATUS.CANCELLED;
    void opts;
    return Promise.resolve();
  });
  jest.spyOn(service, 'getAdmin').mockResolvedValue({ code: 'X' } as never);
  return { service, state, repo, audits, events, notes, notify, inventory, payment, users, openNotReceived, openReturn, doCancel, prisma };
}
type Fx = ReturnType<typeof build>;
const row = (f: Fx, code = 'DH261001') => f.state.get(code) as State;
const ship = (f: Fx, opts: Parameters<OrderService['updateStatus']>[3], code = 'DH261001') => f.service.updateStatus(actor, code, ORDER_STATUS.SHIPPING, opts);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ====================================================================== FUL-08 / SHP-13 — hãng + mã vận đơn
describe('[FUL-08] chuyển `shipping` BẮT BUỘC hãng + mã vận đơn', () => {
  it('[FUL-08] thiếu hãng / thiếu mã / mã sai định dạng ⇒ 400 ORDER_TRACKING_REQUIRED, KHÔNG ghi gì (đơn vẫn packing, không khoá, không thông báo)', async () => {
    const bad: Array<Parameters<OrderService['updateStatus']>[3]> = [
      {},
      { trackingUrl: 'https://ghn.vn/t/AUDIT' }, // kiểu gọi cũ: chỉ có link
      { carrier: 'ghn' },
      { trackingCode: 'GHN123456' },
      { carrier: 'ghn', trackingCode: '   ' },
      { carrier: 'ghn', trackingCode: 'abc' }, // < 4 ký tự
      { carrier: 'ghn', trackingCode: 'A'.repeat(41) }, // > 40 ký tự
      { carrier: 'ghn', trackingCode: 'GHN 12345' }, // khoảng trắng
      { carrier: 'ghn', trackingCode: 'GHN<script>' },
      { carrier: 'dhl', trackingCode: 'GHN123456' }, // hãng ngoài danh mục
    ];
    for (const opts of bad) {
      const f = build([mk(1)]);
      await expect(ship(f, opts)).rejects.toMatchObject({ errorCode: ORDER_ERR.TRACKING_REQUIRED, httpStatus: 400 });
      expect(row(f).status).toBe(ORDER_STATUS.PACKING);
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expect(f.notes).toHaveLength(0);
    }
  });

  it('[FUL-08] đủ hãng + mã ⇒ shipping: lưu carrier/trackingCode, link tra cứu SINH THEO HÃNG (bỏ qua link shop gửi), lịch sử + audit + báo khách kèm hãng và mã', async () => {
    const f = build([mk(1)]);
    await ship(f, { carrier: 'ghn', trackingCode: 'GHN123456', trackingUrl: 'https://evil.example.com/phish', note: 'Giao trong ngày' });
    expect(row(f)).toMatchObject({ status: ORDER_STATUS.SHIPPING, carrier: 'ghn', trackingCode: 'GHN123456', trackingReused: false, trackingUrl: 'https://donhang.ghn.vn/?order_code=GHN123456' });
    const note = 'Giao Hàng Nhanh (GHN) · mã vận đơn GHN123456 — Giao trong ngày';
    expect(f.repo.addHistory).toHaveBeenCalledWith('o1', ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING, note, actor.userId, TX);
    expect(f.audits[0]).toMatchObject({ action: ORDER_AUDIT.STATUS_CHANGED, after: { status: 'shipping', note, carrier: 'ghn', trackingCode: 'GHN123456' } });
    expect(f.notes[0]).toMatchObject({ userId: USER, title: 'Đơn DH261001: Đang giao', content: note });
    expect(f.repo.update.mock.calls[0][1].shippedAt).toBeInstanceOf(Date);
  });

  it('[FUL-08] hãng `other` (hoặc không có mẫu link): dùng link https shop nhập; không nhập ⇒ không có link; link http/javascript ⇒ 400', async () => {
    const withUrl = build([mk(1)]);
    await ship(withUrl, { carrier: 'other', trackingCode: 'VD-998877', trackingUrl: 'https://tracking.example.com/?id=VD-998877' });
    expect(row(withUrl)).toMatchObject({ carrier: 'other', trackingCode: 'VD-998877', trackingUrl: 'https://tracking.example.com/?id=VD-998877' });
    const without = build([mk(1)]);
    await ship(without, { carrier: 'ahamove', trackingCode: 'AHA-1234' });
    expect(row(without).trackingUrl).toBeNull();
    for (const trackingUrl of ['http://tracking.example.com/x', 'javascript:alert(1)', 'https://user:pw@tracking.example.com/x']) {
      const bad = build([mk(1)]);
      await expect(ship(bad, { carrier: 'other', trackingCode: 'VD-998877', trackingUrl })).rejects.toMatchObject({ errorCode: ORDER_ERR.TRACKING_REQUIRED });
      expect(row(bad).status).toBe(ORDER_STATUS.PACKING);
    }
  });

  it('[FUL-08] mọi hãng trong danh mục dùng được; hãng có mẫu thì link chứa đúng mã đã encode, hãng không mẫu thì null', () => {
    expect(CARRIER_CODES).toEqual(['ghn', 'ghtk', 'viettel_post', 'jnt', 'spx', 'ahamove', 'ninja_van', 'vnpost', 'other']);
    for (const c of CARRIER_CODES) {
      const p = resolveShippingProof({ carrier: c, trackingCode: 'AB-12345' });
      expect(p).toMatchObject({ carrier: c, trackingCode: 'AB-12345' });
      expect(p.trackingUrl).toBe(CARRIERS[c].trackUrl ? CARRIERS[c].trackUrl.replace('{code}', 'AB-12345') : null);
      expect(carrierName(c)).toBe(CARRIERS[c].name);
    }
    expect(carrierName(null)).toBeNull();
    expect(carrierName('dhl')).toBeNull();
  });

  it('[FUL-08] chỉ áp cho bước → shipping: các bước khác không cần hãng/mã (confirmed→packing…) và không ghi cột hãng', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.CONFIRMED })]);
    await f.service.updateStatus(actor, 'DH261001', ORDER_STATUS.PACKING, {});
    expect(row(f)).toMatchObject({ status: ORDER_STATUS.PACKING, carrier: null, trackingCode: null });
  });

  it('[FUL-08] sai trạng thái nguồn vẫn là ORDER_INVALID_TRANSITION (đơn pending → shipping dù có mã)', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.PENDING })]);
    await expect(ship(f, { carrier: 'ghn', trackingCode: 'GHN123456' })).rejects.toMatchObject({ errorCode: ORDER_ERR.INVALID_TRANSITION });
    expect(row(f).trackingCode).toBeNull();
  });
});

describe('[SHP-13] một mã vận đơn dùng cho nhiều đơn của cùng shop', () => {
  it('[SHP-13] mã đã dùng cho đơn KHÁC (chưa huỷ) của shop (không phân biệt hoa thường) ⇒ vẫn cho qua nhưng gắn cờ tracking_reused + audit + báo CSKH', async () => {
    const f = build([mk(1), mk(2, { status: ORDER_STATUS.SHIPPING, carrier: 'ghn', trackingCode: 'GHN123456' })]);
    await ship(f, { carrier: 'jnt', trackingCode: 'ghn123456' });
    expect(row(f)).toMatchObject({ status: ORDER_STATUS.SHIPPING, trackingReused: true });
    expect(f.audits.map((a) => a.action)).toEqual([ORDER_AUDIT.STATUS_CHANGED, ORDER_AUDIT.TRACKING_REUSED]);
    expect(f.users.staffUserIdsWithPermission).toHaveBeenCalledWith('order.return.process');
    const cs = f.notes.filter((n) => n.userId === 'staff-1');
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ title: 'Mã vận đơn dùng lại — đơn DH261001', link: '/order/orders/DH261001' });
  });

  it('[SHP-13] mã chỉ trùng với đơn đã HUỶ, hoặc đơn của shop KHÁC ⇒ không gắn cờ, không báo CSKH', async () => {
    const f = build([mk(1), mk(2, { status: ORDER_STATUS.CANCELLED, trackingCode: 'GHN123456' }), mk(3, { shopId: OTHER_SHOP, status: ORDER_STATUS.SHIPPING, trackingCode: 'GHN123456' })]);
    await ship(f, { carrier: 'ghn', trackingCode: 'GHN123456' });
    expect(row(f).trackingReused).toBe(false);
    expect(f.audits.map((a) => a.action)).toEqual([ORDER_AUDIT.STATUS_CHANGED]);
    expect(f.users.staffUserIdsWithPermission).not.toHaveBeenCalled();
  });
});

// ====================================================================== SHP-06 — chặn "đã giao" khi khách đang báo chưa nhận hàng
describe('[SHP-06] shop báo `delivered` khi khách đang báo CHƯA NHẬN hàng', () => {
  const shipping = (over: Partial<State> = {}) => mk(1, { status: ORDER_STATUS.SHIPPING, carrier: 'ghn', trackingCode: 'GHN123456', ...over });

  it('[SHP-06] còn yêu cầu not_received đang MỞ ⇒ 409 ORDER_NOT_RECEIVED_OPEN; KHÔNG ghi thu COD, đơn vẫn shipping, không báo ai', async () => {
    const f = build([shipping()]);
    f.openNotReceived.add('o1');
    await expect(f.service.updateStatus(actor, 'DH261001', ORDER_STATUS.DELIVERED, {})).rejects.toMatchObject({ errorCode: ORDER_ERR.NOT_RECEIVED_OPEN, httpStatus: 409 });
    expect(row(f).status).toBe(ORDER_STATUS.SHIPPING);
    expect(f.payment.markCodCollected).not.toHaveBeenCalled();
    expect(f.notes).toHaveLength(0);
    expect(f.events).toHaveLength(0);
  });

  it('[SHP-06] không có yêu cầu mở ⇒ báo giao bình thường; COD thì ghi thu (markCodCollected) với số liệu hoa hồng đúng', async () => {
    const f = build([shipping()]);
    await f.service.updateStatus(actor, 'DH261001', ORDER_STATUS.DELIVERED, {});
    expect(row(f).status).toBe(ORDER_STATUS.DELIVERED);
    expect(f.payment.markCodCollected).toHaveBeenCalledTimes(1);
    expect(f.payment.markCodCollected.mock.calls[0][3]).toMatchObject({ shopId: SHOP, total: 430_000n, commissionBase: 400_000n, platformCredit: 0n, commissionRate: '5' });
    expect(f.events.map((e) => e.eventType)).toEqual([ORDER_EVENT.DELIVERED]);
  });

  it('[SHP-06] đơn `shipping` TRƯỚC khi có tính năng (không có mã vận đơn) vẫn báo giao được — không bị kẹt', async () => {
    const f = build([mk(1, { status: ORDER_STATUS.SHIPPING })]);
    await f.service.updateStatus(actor, 'DH261001', ORDER_STATUS.DELIVERED, {});
    expect(row(f).status).toBe(ORDER_STATUS.DELIVERED);
  });
});

// ====================================================================== SHP-09 — giao thất bại + hàng đã về kho
describe('[SHP-09] giao thất bại → "hàng đã về kho"', () => {
  const shipping = (over: Partial<State> = {}) => mk(1, { status: ORDER_STATUS.SHIPPING, carrier: 'ghn', trackingCode: 'GHN123456', ...over });
  const failedInput = { reasonCode: 'refused' as const, note: 'Khách từ chối nhận, đã thử giao 3 lần', goodsReturned: false };

  it('[SHP-09] goodsReturned=false: huỷ KHÔNG nhập kho, ghi delivery_failed_at/reason, goods_returned_at còn NULL; sau đó "hàng đã về" nhập kho ĐÚNG số đã giao và đóng dấu goods_returned_at', async () => {
    const f = build([shipping()]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', failedInput);
    expect(f.doCancel).toHaveBeenCalledTimes(1);
    expect(f.doCancel.mock.calls[0][4]).toMatchObject({ restock: false });
    expect(row(f)).toMatchObject({ status: ORDER_STATUS.CANCELLED, deliveryFailedReason: 'refused', goodsReturnedAt: null });
    expect(row(f).deliveryFailedAt).toBeInstanceOf(Date);
    expect(f.inventory.restock).not.toHaveBeenCalled();

    await f.service.goodsReturned(actor, SHOP, 'DH261001');
    expect(f.inventory.restock).toHaveBeenCalledTimes(1);
    expect(f.inventory.restock.mock.calls[0][0]).toEqual([{ variantId: 'var-1', quantity: 2 }]);
    expect(f.inventory.restock.mock.calls[0][1]).toEqual({ type: 'order', id: 'DH261001' });
    expect(row(f).goodsReturnedAt).toBeInstanceOf(Date);
    expect(f.repo.addHistory).toHaveBeenLastCalledWith('o1', ORDER_STATUS.CANCELLED, ORDER_STATUS.CANCELLED, 'Shop xác nhận hàng đã về kho — đã nhập kho lại', actor.userId, TX);
    expect(f.audits.at(-1)).toMatchObject({ action: ORDER_AUDIT.GOODS_RETURNED, entityCode: 'DH261001', after: expect.objectContaining({ shopId: SHOP, reasonCode: 'refused' }) as unknown });
  });

  it('[SHP-09] nhập kho đúng MỘT lần: gọi lần hai (bấm đúp / hai thiết bị) ⇒ 409 ORDER_GOODS_ALREADY_RETURNED, không restock thêm', async () => {
    const f = build([shipping()]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', failedInput);
    await f.service.goodsReturned(actor, SHOP, 'DH261001');
    await expect(f.service.goodsReturned(actor, SHOP, 'DH261001')).rejects.toMatchObject({ errorCode: ORDER_ERR.GOODS_ALREADY_RETURNED, httpStatus: 409 });
    expect(f.inventory.restock).toHaveBeenCalledTimes(1);
  });

  it('[SHP-09] hai yêu cầu song song: cả hai đọc cùng đơn nhưng khoá đơn tuần tự hoá ⇒ chỉ một lần nhập kho', async () => {
    const f = build([shipping()]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', failedInput);
    const results = await Promise.allSettled([f.service.goodsReturned(actor, SHOP, 'DH261001'), f.service.goodsReturned(actor, SHOP, 'DH261001')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.inventory.restock).toHaveBeenCalledTimes(1);
  });

  it('[SHP-09] goodsReturned=true lúc báo thất bại: nhập kho ngay + đánh dấu goods_returned_at ⇒ route "hàng đã về" từ chối (không nhập kho hai lần)', async () => {
    const f = build([shipping()]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', { ...failedInput, goodsReturned: true });
    expect(f.doCancel.mock.calls[0][4]).toMatchObject({ restock: true });
    expect(row(f).goodsReturnedAt).toBeInstanceOf(Date);
    await expect(f.service.goodsReturned(actor, SHOP, 'DH261001')).rejects.toMatchObject({ errorCode: ORDER_ERR.GOODS_ALREADY_RETURNED });
    expect(f.inventory.restock).not.toHaveBeenCalled(); // doCancel (giả) là nơi nhập kho lúc báo; route này không nhập thêm
  });

  it('[SHP-09] đơn của shop KHÁC / không tồn tại ⇒ 404 (không lộ tồn tại); shopId chỉ từ ngữ cảnh', async () => {
    const f = build([shipping()]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', failedInput);
    await expect(f.service.goodsReturned(actor, OTHER_SHOP, 'DH261001')).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.goodsReturned(actor, SHOP, 'DH-NOPE')).rejects.toBeInstanceOf(NotFoundException);
    expect(f.inventory.restock).not.toHaveBeenCalled();
    expect(row(f).goodsReturnedAt).toBeNull();
  });

  it('[SHP-09] chỉ đơn huỷ VÌ giao thất bại: đơn đang giao / đã giao / huỷ bởi đường khác (không có delivery_failed_at) ⇒ 400 ORDER_GOODS_RETURN_NOT_ALLOWED', async () => {
    for (const over of [{ status: ORDER_STATUS.SHIPPING }, { status: ORDER_STATUS.DELIVERED }, { status: ORDER_STATUS.CANCELLED }, { status: ORDER_STATUS.CANCELLED, deliveryFailedAt: null, trackingCode: 'GHN123456' }]) {
      const f = build([shipping(over)]);
      await expect(f.service.goodsReturned(actor, SHOP, 'DH261001')).rejects.toMatchObject({ errorCode: ORDER_ERR.GOODS_RETURN_NOT_ALLOWED, httpStatus: 400 });
      expect(f.inventory.restock).not.toHaveBeenCalled();
    }
  });

  it('[SHP-09] quá 30 ngày kể từ lúc báo giao thất bại ⇒ 409 ORDER_GOODS_RETURN_NOT_ALLOWED (CSKH chỉnh kho tay); trong 30 ngày thì được', async () => {
    const late = build([shipping({ status: ORDER_STATUS.CANCELLED, deliveryFailedAt: new Date(Date.now() - 31 * DAY), deliveryFailedReason: 'lost' })]);
    await expect(late.service.goodsReturned(actor, SHOP, 'DH261001')).rejects.toMatchObject({ errorCode: ORDER_ERR.GOODS_RETURN_NOT_ALLOWED, httpStatus: 409 });
    const ok = build([shipping({ status: ORDER_STATUS.CANCELLED, deliveryFailedAt: new Date(Date.now() - 29 * DAY), deliveryFailedReason: 'lost' })]);
    await expect(ok.service.goodsReturned(actor, SHOP, 'DH261001')).resolves.toBeUndefined();
    expect(ok.inventory.restock).toHaveBeenCalledTimes(1);
  });

  it('[SHP-09] restock lỗi ⇒ hoàn tác: goods_returned_at vẫn NULL (thử lại được), không lịch sử/audit', async () => {
    const f = build([shipping({ status: ORDER_STATUS.CANCELLED, deliveryFailedAt: new Date(), deliveryFailedReason: 'lost' })]);
    f.inventory.restock.mockRejectedValueOnce(new Error('kho lỗi'));
    await expect(f.service.goodsReturned(actor, SHOP, 'DH261001')).rejects.toThrow('kho lỗi');
    expect(row(f).goodsReturnedAt).toBeNull();
    expect(f.audits).toHaveLength(0);
    await f.service.goodsReturned(actor, SHOP, 'DH261001');
    expect(row(f).goodsReturnedAt).toBeInstanceOf(Date);
  });

  it('[SHP-09] sự kiện outbox ORDER_DELIVERY_FAILED (cho WP-08): reasonCode, paymentMethod, userId, customerFault chỉ với refused/unreachable', async () => {
    const f = build([shipping(), shipping({ id: 'o2', code: 'DH261002' }), shipping({ id: 'o3', code: 'DH261003', paymentMethodCode: 'payos', paymentStatus: PAYMENT_STATUS.PAID })]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', failedInput);
    await f.service.deliveryFailed(actor, SHOP, 'DH261002', { ...failedInput, reasonCode: 'wrong_address' });
    await f.service.deliveryFailed(actor, SHOP, 'DH261003', { ...failedInput, reasonCode: 'unreachable' });
    const ev = f.events.filter((e) => e.eventType === ORDER_EVENT.DELIVERY_FAILED).map((e) => e.payload);
    expect(ev).toEqual([
      { orderCode: 'DH261001', userId: USER, shopId: SHOP, reasonCode: 'refused', paymentMethod: 'cod', customerFault: true },
      { orderCode: 'DH261002', userId: USER, shopId: SHOP, reasonCode: 'wrong_address', paymentMethod: 'cod', customerFault: false },
      { orderCode: 'DH261003', userId: USER, shopId: SHOP, reasonCode: 'unreachable', paymentMethod: 'payos', customerFault: true },
    ]);
  });

  it('[SHP-09] lý do mới (wrong_address, damaged) có nhãn tiếng Việt trong lý do huỷ gửi doCancel', async () => {
    const f = build([shipping(), shipping({ id: 'o2', code: 'DH261002' })]);
    await f.service.deliveryFailed(actor, SHOP, 'DH261001', { ...failedInput, reasonCode: 'wrong_address' });
    await f.service.deliveryFailed(actor, SHOP, 'DH261002', { ...failedInput, reasonCode: 'damaged' });
    expect(f.doCancel.mock.calls[0][1]).toBe('Sai địa chỉ / không tìm thấy địa chỉ giao: Khách từ chối nhận, đã thử giao 3 lần');
    expect(f.doCancel.mock.calls[1][1]).toContain('Hàng hư hỏng trong quá trình vận chuyển');
  });
});

// ====================================================================== response: hãng + mã vận đơn, cờ nghi gian lận chỉ cho shop/sàn
describe('[FUL-08] OrderResponse hiển thị hãng + mã vận đơn cho khách/shop/sàn', () => {
  const D0 = new Prisma.Decimal(0);
  const fullRow = (over: Record<string, unknown> = {}): OrderRow =>
    ({
      ...mk(1, { status: ORDER_STATUS.SHIPPING, carrier: 'ghn', trackingCode: 'GHN123456', trackingUrl: 'https://donhang.ghn.vn/?order_code=GHN123456', trackingReused: true }),
      recipientName: 'Nguyễn Văn A', recipientPhone: '0901234567', shippingAddress: '12 Nguyễn Huệ', customerNote: null,
      subtotal: D0, shippingFee: D0, discount: D0, shopDiscount: D0, platformDiscount: D0, promotionCode: null, promotionName: null, shopPromotionCode: null, shopPromotionName: null,
      paymentExpiresAt: null, cancelReason: null, createdAt: new Date(), deliveredAt: null, items: [], histories: [],
      ...over,
    }) as unknown as OrderRow;
  const extras = { paymentUrl: null, transactionCode: null, cardBrand: null, cardLast4: null };

  it('[FUL-08] khách thấy hãng + tên hãng + mã + link tra cứu; cờ trackingReused LUÔN false với khách', () => {
    const r = toOrderResponse(fullRow(), extras, 7, 'Shop A');
    expect(r).toMatchObject({ carrier: 'ghn', carrierName: 'Giao Hàng Nhanh (GHN)', trackingCode: 'GHN123456', trackingUrl: 'https://donhang.ghn.vn/?order_code=GHN123456', trackingReused: false });
  });

  it('[SHP-13] shop (extras = null) và nhân viên sàn (staffView) thấy cờ trackingReused', () => {
    expect(toOrderResponse(fullRow(), null, 7, 'Shop A').trackingReused).toBe(true);
    expect(toOrderResponse(fullRow(), extras, 7, 'Shop A', { staffView: true }).trackingReused).toBe(true);
    expect(toOrderResponse(fullRow({ trackingReused: false }), null, 7, 'Shop A').trackingReused).toBe(false);
  });

  it('[FUL-08] đơn cũ (chưa có hãng/mã) ⇒ null, không lỗi', () => {
    const r = toOrderResponse(fullRow({ carrier: null, trackingCode: null, trackingUrl: null, trackingReused: false }), extras, 7, 'Shop A');
    expect(r).toMatchObject({ carrier: null, carrierName: null, trackingCode: null, trackingUrl: null, trackingReused: false });
  });

  it('[SHP-09] canConfirmGoodsReturned: đơn huỷ vì giao thất bại, hàng chưa về, trong 30 ngày ⇒ true; đã nhập kho / quá hạn / huỷ đường khác ⇒ false', () => {
    const base = { status: ORDER_STATUS.CANCELLED, deliveryFailedAt: new Date(Date.now() - 2 * DAY), deliveryFailedReason: 'lost', goodsReturnedAt: null };
    expect(toOrderResponse(fullRow(base), null, 7, 'S').canConfirmGoodsReturned).toBe(true);
    expect(toOrderResponse(fullRow({ ...base, goodsReturnedAt: new Date() }), null, 7, 'S').canConfirmGoodsReturned).toBe(false);
    expect(toOrderResponse(fullRow({ ...base, deliveryFailedAt: new Date(Date.now() - 31 * DAY) }), null, 7, 'S').canConfirmGoodsReturned).toBe(false);
    expect(toOrderResponse(fullRow({ ...base, deliveryFailedAt: null }), null, 7, 'S').canConfirmGoodsReturned).toBe(false);
    expect(toOrderResponse(fullRow({ ...base, status: ORDER_STATUS.SHIPPING }), null, 7, 'S').canConfirmGoodsReturned).toBe(false);
  });
});

// ====================================================================== ShopOrderService — chuyển tiếp hãng/mã vận đơn + "hàng đã về kho"
describe('ShopOrderService — giao hàng có bằng chứng', () => {
  const code = 'DH261001';
  function shopService(row: State | null) {
    const orders = { updateStatus: jest.fn(() => Promise.resolve({} as never)), goodsReturned: jest.fn((_a: AuthenticatedActor, _s: string, _c: string) => Promise.resolve()) };
    const repo = { findByCode: jest.fn((_c: string) => Promise.resolve(row ? ({ ...row, items: [], histories: [] } as unknown as OrderRow) : null)) };
    const shops = { findBrief: jest.fn(() => Promise.resolve({ name: 'Shop A' })) };
    const system = { settingNumber: jest.fn(() => Promise.resolve(7)) };
    const payment = { refundSummaries: jest.fn(() => Promise.resolve(new Map())) };
    const svc = Object.create(ShopOrderService.prototype) as ShopOrderService;
    Object.assign(svc, { orders, repo, shops, system, payment });
    return { svc, orders };
  }
  const withMoney = (o: State): State => Object.assign(o, { shippingFee: new Prisma.Decimal(0), discount: new Prisma.Decimal(0), recipientName: 'A', recipientPhone: '0', shippingAddress: 'x', customerNote: null, promotionCode: null, promotionName: null, shopPromotionCode: null, shopPromotionName: null, paymentExpiresAt: null, cancelReason: null, createdAt: new Date(), deliveredAt: null });

  it('[FUL-08] PUT status → shipping chuyển NGUYÊN hãng + mã vận đơn xuống OrderService (shop-order không tự kiểm, một nơi duy nhất ép là OrderService.updateStatus)', async () => {
    const { svc, orders } = shopService(withMoney(mk(1, { status: ORDER_STATUS.PACKING })));
    await svc.updateStatus(actor, SHOP, code.toLowerCase(), ORDER_STATUS.SHIPPING, { carrier: 'ghn', trackingCode: 'GHN123456' });
    expect(orders.updateStatus).toHaveBeenCalledWith(actor, code, ORDER_STATUS.SHIPPING, { carrier: 'ghn', trackingCode: 'GHN123456' });
  });

  it('[SHP-09] POST goods-returned: mã đơn viết hoa, shopId từ ngữ cảnh, rồi đọc lại đơn (response vendor, không lộ thông tin thanh toán)', async () => {
    const { svc, orders } = shopService(withMoney(mk(1, { status: ORDER_STATUS.CANCELLED, deliveryFailedAt: new Date(), deliveryFailedReason: 'lost' })));
    const r = await svc.goodsReturned(actor, SHOP, code.toLowerCase());
    expect(orders.goodsReturned).toHaveBeenCalledWith(actor, SHOP, code);
    expect(r.code).toBe(code);
    expect(r.paymentUrl).toBeNull();
    expect(r.canConfirmGoodsReturned).toBe(true);
  });

  it('[SHP-09] OrderService báo lỗi (404 shop khác / 409 đã nhập kho) ⇒ lỗi đi nguyên xi, không đọc lại đơn', async () => {
    const { svc, orders } = shopService(null);
    orders.goodsReturned.mockRejectedValueOnce(new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng'));
    await expect(svc.goodsReturned(actor, SHOP, code)).rejects.toBeInstanceOf(NotFoundException);
  });
});
