import type { NotifyCommand } from '@common/gateway/notification.gateway';
import type { OutboxEventMessage } from '@common/outbox/outbox';
import type { PrismaService } from '@common/prisma/prisma.service';
import { type Tx } from '@common/prisma/types';
import type { ShopQueryApi } from '../../shop/queryapi/shop.queryapi';
import type { SystemQueryApi } from '../../system/queryapi/system.queryapi';
import { inferCancelSource, normalizeProvince, resolveCancelReason, shopCancelViolation } from '../foundation/cancel.rules';
import { VIOLATION_KIND } from '../foundation/order.constants';
import { OrderViolationListeners } from '../order-worker.module';
import { ShopViolationService } from './shop-violation.service';

/*
 * Điểm vi phạm của shop (PLAN-0027 §2.1) + luật huỷ thuần (cancel.rules). FUL-12: vượt ngưỡng ⇒ quản lý nhận việc xem xét khoá, MỘT lần / 7 ngày; điểm không cộng hai lần (UNIQUE order_code+kind).
 */
const SHOP = '11111111-1111-4111-8111-111111111111';

describe('cancel.rules — luật huỷ thuần', () => {
  it('resolveCancelReason: thiếu mã ⇒ other; có reason ⇒ nguyên văn; chỉ mã + ghi chú ⇒ "<nhãn>: <ghi chú>"; mã sai bên ⇒ 400; rỗng ⇒ 400; cắt ≤ 255', () => {
    expect(resolveCancelReason('customer', { reason: 'Đổi ý rồi' })).toEqual({ reasonCode: 'other', text: 'Đổi ý rồi' });
    expect(resolveCancelReason('customer', { reasonCode: 'found_cheaper', note: 'Shop khác rẻ hơn' })).toEqual({ reasonCode: 'found_cheaper', text: 'Tìm được nơi bán giá tốt hơn: Shop khác rẻ hơn' });
    expect(resolveCancelReason('shop', { reasonCode: 'out_of_stock' })).toEqual({ reasonCode: 'out_of_stock', text: 'Hết hàng' });
    expect(resolveCancelReason('platform', { reasonCode: 'dispute', reason: 'x'.repeat(400) }).text).toHaveLength(255);
    expect(() => resolveCancelReason('customer', { reasonCode: 'out_of_stock' })).toThrow('không hợp lệ');
    expect(() => resolveCancelReason('shop', { reasonCode: 'payment_expired' })).toThrow('không hợp lệ'); // mã hệ thống không nhận từ request
    expect(() => resolveCancelReason('customer', { reason: '   ' })).toThrow('Vui lòng chọn hoặc nhập lý do');
    expect(() => resolveCancelReason('shop', { note: 'chỉ có ghi chú' })).toThrow('Vui lòng chọn hoặc nhập lý do');
  });

  it('shopCancelViolation: hết hàng / sai giá / từ chối yêu cầu rồi huỷ / huỷ đơn đã đóng gói ⇒ 1 điểm (ưu tiên theo thứ tự); huỷ theo yêu cầu khách hoặc đơn chưa đóng gói ⇒ không điểm', () => {
    expect(shopCancelViolation({ reasonCode: 'out_of_stock', fromStatus: 'confirmed', hadRejectedRequest: false })).toBe(VIOLATION_KIND.CANCEL_OUT_OF_STOCK);
    expect(shopCancelViolation({ reasonCode: 'price_error', fromStatus: 'pending', hadRejectedRequest: false })).toBe(VIOLATION_KIND.CANCEL_PRICE_ERROR);
    expect(shopCancelViolation({ reasonCode: 'other', fromStatus: 'packing', hadRejectedRequest: true })).toBe(VIOLATION_KIND.REJECT_THEN_CANCEL);
    expect(shopCancelViolation({ reasonCode: 'cannot_contact', fromStatus: 'packing', hadRejectedRequest: false })).toBe(VIOLATION_KIND.CANCEL_PACKING);
    expect(shopCancelViolation({ reasonCode: 'out_of_stock', fromStatus: 'packing', hadRejectedRequest: true })).toBe(VIOLATION_KIND.CANCEL_OUT_OF_STOCK); // một đơn tối đa một điểm
    expect(shopCancelViolation({ reasonCode: 'customer_request', fromStatus: 'packing', hadRejectedRequest: false })).toBeNull();
    expect(shopCancelViolation({ reasonCode: 'cannot_contact', fromStatus: 'confirmed', hadRejectedRequest: false })).toBeNull();
    expect(shopCancelViolation({ reasonCode: null, fromStatus: 'shipping', hadRejectedRequest: false })).toBeNull(); // giao thất bại không phải huỷ chủ động
  });

  it('inferCancelSource: không người thao tác = system; chính chủ đơn = customer; còn lại = shop', () => {
    expect(inferCancelSource(null, 'u1')).toBe('system');
    expect(inferCancelSource('u1', 'u1')).toBe('customer');
    expect(inferCancelSource('shop-user', 'u1')).toBe('shop');
  });

  it('normalizeProvince: bỏ dấu, hoa/thường, tiền tố TP./Thành phố/Tỉnh', () => {
    expect(normalizeProvince('TP. Hồ Chí Minh')).toBe('ho chi minh');
    expect(normalizeProvince('Thành phố Hồ Chí Minh')).toBe('ho chi minh');
    expect(normalizeProvince('hồ chí minh')).toBe('ho chi minh');
    expect(normalizeProvince('Tỉnh Đồng Nai')).toBe('dong nai');
    expect(normalizeProvince('Hà Nội')).not.toBe(normalizeProvince('TP. Hồ Chí Minh'));
  });
});

function buildService(opts: { total: number; threshold?: number; created?: number; claimed?: number }) {
  const createMany = jest.fn((_a: unknown) => Promise.resolve({ count: opts.created ?? 1 }));
  const aggregate = jest.fn((_a: unknown) => Promise.resolve({ _sum: { points: opts.total } }));
  const executeRaw = jest.fn((..._a: unknown[]) => Promise.resolve(opts.claimed ?? 1));
  const tx = { shopViolation: { createMany, aggregate }, $executeRaw: executeRaw } as unknown as Tx;
  const notifyMany = jest.fn((_c: NotifyCommand[], _tx?: Tx): Promise<void> => Promise.resolve());
  const staffIds = jest.fn((_p: string): Promise<string[]> => Promise.resolve(['qlA', 'qlB']));
  const system = { settingNumber: jest.fn((_k: string) => Promise.resolve(opts.threshold ?? 10)) } as unknown as SystemQueryApi;
  const shops = { findBrief: jest.fn((_id: string) => Promise.resolve({ id: SHOP, name: 'Shop A' })) } as unknown as ShopQueryApi;
  const service = new ShopViolationService({} as PrismaService, system, shops, { staffUserIdsWithPermission: staffIds } as never, { notify: jest.fn(), notifyMany });
  return { service, tx, createMany, executeRaw, notifyMany, staffIds };
}

describe('ShopViolationService.record — điểm vi phạm + nhắc quản lý', () => {
  const v = { shopId: SHOP, orderCode: 'DH261001', kind: VIOLATION_KIND.CONFIRM_TIMEOUT };

  it('ghi 1 điểm (skipDuplicates ⇒ UNIQUE order_code+kind chặn cộng đôi); dưới ngưỡng ⇒ không nhắc', async () => {
    const f = buildService({ total: 3 });
    expect(await f.service.record(f.tx, v)).toBe(true);
    expect(f.createMany).toHaveBeenCalledWith({ data: [{ shopId: SHOP, orderCode: 'DH261001', kind: 'confirm_timeout', points: 1 }], skipDuplicates: true });
    expect(f.executeRaw).not.toHaveBeenCalled();
    expect(f.notifyMany).not.toHaveBeenCalled();
  });

  it('điểm đã tồn tại (job chạy lại) ⇒ trả false, KHÔNG kiểm ngưỡng, không nhắc', async () => {
    const f = buildService({ total: 99, created: 0 });
    expect(await f.service.record(f.tx, v)).toBe(false);
    expect(f.executeRaw).not.toHaveBeenCalled();
    expect(f.notifyMany).not.toHaveBeenCalled();
  });

  it('[FUL-12] đạt ngưỡng (≥ shop.violation_suspend_points trong 30 ngày) ⇒ báo mọi người có supplier.shop.suspend, MỘT thông báo mỗi người, cùng tx', async () => {
    const f = buildService({ total: 10 });
    await f.service.record(f.tx, v);
    expect(f.staffIds).toHaveBeenCalledWith('supplier.shop.suspend');
    const notes = f.notifyMany.mock.calls[0][0];
    expect(notes.map((n) => n.userId)).toEqual(['qlA', 'qlB']);
    expect(notes[0]).toMatchObject({ title: 'Gian hàng Shop A vi phạm 10 điểm trong 30 ngày', link: `/shop/shops/${SHOP}`, type: 'system' });
    expect(f.notifyMany.mock.calls[0][1]).toBe(f.tx);
  });

  it('[FUL-12] đã nhắc trong 7 ngày (claim upsert không ghi được dòng) ⇒ không nhắc lại', async () => {
    const f = buildService({ total: 15, claimed: 0 });
    await f.service.record(f.tx, v);
    expect(f.executeRaw).toHaveBeenCalledTimes(1);
    expect(f.staffIds).not.toHaveBeenCalled();
    expect(f.notifyMany).not.toHaveBeenCalled();
  });
});

describe('OrderViolationListeners — điểm từ sự kiện ORDER_CANCELLED', () => {
  const build = () => {
    const record = jest.fn((_tx: Tx, _v: { shopId: string; orderCode: string; kind: string }) => Promise.resolve(true));
    const tx = { __tx: true } as unknown as Tx;
    const prisma = { $transaction: jest.fn((fn: (t: Tx) => Promise<unknown>) => fn(tx)) } as unknown as PrismaService;
    const listener = new OrderViolationListeners(prisma, { record } as unknown as ShopViolationService);
    const msg = (payload: Record<string, unknown>) => ({ id: 'e1', eventType: 'ORDER_CANCELLED', payload }) as unknown as OutboxEventMessage;
    return { listener, record, msg };
  };

  it('[CAN-06] shop huỷ vì hết hàng / sai giá ⇒ 1 điểm tương ứng; huỷ đơn đã đóng gói ⇒ cancel_packing; từ chối yêu cầu rồi huỷ ⇒ reject_then_cancel', async () => {
    const f = build();
    await f.listener.onCancelled(f.msg({ orderCode: 'DH1', shopId: SHOP, cancelSource: 'shop', reasonCode: 'out_of_stock', fromStatus: 'confirmed' }));
    await f.listener.onCancelled(f.msg({ orderCode: 'DH2', shopId: SHOP, cancelSource: 'shop', reasonCode: 'price_error', fromStatus: 'pending' }));
    await f.listener.onCancelled(f.msg({ orderCode: 'DH3', shopId: SHOP, cancelSource: 'shop', reasonCode: 'cannot_contact', fromStatus: 'packing' }));
    await f.listener.onCancelled(f.msg({ orderCode: 'DH4', shopId: SHOP, cancelSource: 'shop', reasonCode: 'other', fromStatus: 'packing', hadRejectedRequest: true }));
    expect(f.record.mock.calls.map((c) => [c[1].orderCode, c[1].kind])).toEqual([
      ['DH1', 'cancel_out_of_stock'],
      ['DH2', 'cancel_price_error'],
      ['DH3', 'cancel_packing'],
      ['DH4', 'reject_then_cancel'],
    ]);
  });

  it('khách / sàn / hệ thống huỷ, hoặc shop huỷ không vi phạm ⇒ không điểm', async () => {
    const f = build();
    for (const cancelSource of ['customer', 'platform', 'system']) await f.listener.onCancelled(f.msg({ orderCode: 'DH1', shopId: SHOP, cancelSource, reasonCode: 'out_of_stock', fromStatus: 'confirmed' }));
    await f.listener.onCancelled(f.msg({ orderCode: 'DH2', shopId: SHOP, cancelSource: 'shop', reasonCode: 'customer_request', fromStatus: 'packing' }));
    await f.listener.onCancelled(f.msg({ orderCode: 'DH3', cancelSource: 'shop', reasonCode: 'out_of_stock', fromStatus: 'pending' })); // sự kiện cũ thiếu shopId
    expect(f.record).not.toHaveBeenCalled();
  });
});
