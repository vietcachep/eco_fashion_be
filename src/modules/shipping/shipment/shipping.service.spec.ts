import { ModuleRef } from '@nestjs/core';
import type { Tx } from '@common/prisma/types';
import { Prisma } from '@common/prisma/types';
import type { OrderShippingGateway, ShippingOrderSnapshot, ShippingSnapshot } from '@common/gateway/order-shipping.gateway';
import type { Shipment } from '../../../generated/prisma/client';
import { ShippingRepository } from '../repository/shipping.repository';
import { FakeCarrierGateway, FAKE_PROVINCES, FAKE_DISTRICTS, FAKE_WARDS } from '../carrier/fake-carrier.gateway';
import { GhnGateway } from '../carrier/ghn.gateway';
import type { CarrierState } from '../foundation/shipping.types';
import { ShippingService } from './shipping.service';

const address = { name: 'Khách thử', phone: '0900000000', street: '1 Đường A', provinceName: 'Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Phường Bến Nghé', provinceId: 202, districtId: 1442, wardCode: '20101', addressSystem: 'legacy_3level' as const };
const snapshot: ShippingSnapshot = { pickup: address, destination: address, parcel: { weightGram: 500, lengthCm: 20, widthCm: 15, heightCm: 10 }, quotedFee: '25000', quoteId: '11111111-1111-4111-8111-111111111111', provider: 'fake', environment: 'demo' };

function fixture() {
  let row: Shipment | null = null;
  let upstream: CarrierState | null = null;
  let timeoutAfterCreate = false;
  let failFinalize = false;
  const tx = {} as Tx;
  const order: ShippingOrderSnapshot = { id: '11111111-1111-4111-8111-111111111112', code: 'DH-DEMO', userId: '11111111-1111-4111-8111-111111111113', shopId: '11111111-1111-4111-8111-111111111114', status: 'packing', paymentStatus: 'pending', paymentMethodCode: 'cod', fulfilmentMode: 'carrier', collectionMode: 'carrier_cod', total: '530000', cancelRequestPending: false, shippingSnapshot: snapshot };
  const apply = jest.fn(() => { if (failFinalize) { failFinalize = false; throw new Error('DB finalize rollback'); } order.status = 'shipping'; return Promise.resolve(); });
  const gateway = { lockOrder: jest.fn(() => Promise.resolve(order)), applyCarrierUpdate: apply, recordShippingAction: jest.fn(() => Promise.resolve()), codReceipts: jest.fn(() => Promise.resolve(new Map())), confirmCodReceived: jest.fn() } as unknown as OrderShippingGateway;
  const create = jest.fn(() => {
    upstream ??= { carrierOrderCode: 'FAKE-DH-DEMO-S1', clientOrderCode: 'DH-DEMO-S1', rawStatus: 'ready_to_pick', eventTime: new Date(), fee: '25000', deliveryAttempts: 0 };
    if (timeoutAfterCreate) { timeoutAfterCreate = false; return Promise.reject(new Error('Mất phản hồi sau hãng nhận')); }
    return Promise.resolve(upstream);
  });
  const find = jest.fn(() => Promise.resolve(upstream));
  const track = jest.fn(() => Promise.resolve(upstream));
  const quote = jest.fn(() => Promise.resolve('25000'));
  const locations = jest.fn((kind: string, parentId?: number) => Promise.resolve(kind === 'provinces' ? FAKE_PROVINCES : kind === 'districts' ? FAKE_DISTRICTS.filter((v) => v.parentId === parentId) : FAKE_WARDS.filter((v) => v.parentId === parentId)));
  const fake = { create, findByClientCode: find, quote, locations, track } as unknown as FakeCarrierGateway;
  const repo = {
    transaction: async <T>(fn: (client: Tx) => Promise<T>) => { const before = row ? { ...row } : null; try { return await fn(tx); } catch (e) { row = before; throw e; } },
    active: jest.fn(() => Promise.resolve(row)), maxAttempt: jest.fn(() => Promise.resolve({ _max: { attemptNo: null } })),
    create: jest.fn((data: Record<string, unknown>) => {
      row = { id: '11111111-1111-4111-8111-111111111115', version: 0, createdAt: new Date(), updatedAt: new Date(), createdBy: null, updatedBy: null, isDeleted: false, orderId: order.id, orderCode: order.code, shopId: order.shopId, attemptNo: 1, provider: 'fake', environment: 'demo', accountScope: 'demo', clientOrderCode: 'DH-DEMO-S1', carrierOrderCode: null, active: true, createStatus: 'creating', cancelStatus: 'none', status: null, rawStatus: null, snapshot: {}, quotedFee: new Prisma.Decimal(25000), actualFee: null, codAmount: new Prisma.Decimal(530000), expectedDeliveryAt: null, pickedUpAt: null, deliveredAt: null, lastEventAt: null, deliveryAttempts: 0, trackingUrl: null, leaseToken: null, leaseUntil: null, retryAt: null, lastError: null, ...data };
      return Promise.resolve(row);
    }),
    update: jest.fn((_id: string, data: Record<string, unknown>) => { if (!row) throw new Error('missing row'); row = { ...row, ...data, version: typeof data.version === 'object' ? row.version + 1 : row.version }; return Promise.resolve(row); }),
    shipment: jest.fn(() => Promise.resolve(row)),
  };
  const modules = { get: () => gateway } as unknown as ModuleRef;
  const service = new ShippingService(repo as unknown as ShippingRepository, fake, {} as GhnGateway, modules);
  return { service, repo, order, apply, find, create, quote, track, row: () => row, failCreate: () => { timeoutAfterCreate = true; }, failFinalize: () => { failFinalize = true; }, setUpstreamStatus: (status: string) => { if (upstream) upstream.rawStatus = status; } };
}

describe('PLAN-0043 claim/recovery', () => {
  it('phường thuộc quận khác bị chặn trước báo giá, không fallback nhận địa chỉ sai', async () => {
    const f = fixture();
    await expect(f.service.quote({ userId: f.order.userId, shopId: f.order.shopId, pickup: address, destination: { ...address, wardCode: '10301' }, parcel: snapshot.parcel, codValue: '530000', fallbackFee: '30000' })).rejects.toMatchObject({ errorCode: 'SHIPPING_ADDRESS_INVALID' });
    expect(f.quote).not.toHaveBeenCalled();
  });
  it('production không dùng hãng giả lập hoặc simulator', async () => {
    const previous = process.env.NODE_ENV;
    const carrier = process.env.SHIPPING_CARRIER;
    try {
      process.env.NODE_ENV = 'production';
      process.env.SHIPPING_CARRIER = 'fake';
      const f = fixture();
      expect(() => f.service.provider()).toThrow();
      await expect(f.service.simulate('id', 'delivered')).rejects.toMatchObject({ httpStatus: 404 });
    } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; if (carrier === undefined) delete process.env.SHIPPING_CARRIER; else process.env.SHIPPING_CARRIER = carrier; }
  });
  it('timeout sau hãng nhận giữ attempt unknown; retry tra mã cũ không tạo kiện thứ hai', async () => {
    const f = fixture(); f.failCreate();
    expect((await f.service.ship(null, f.order.shopId, f.order.code))?.createStatus).toBe('unknown');
    expect((await f.service.ship(null, f.order.shopId, f.order.code))?.createStatus).toBe('created');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.repo.create).toHaveBeenCalledTimes(1);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it('T2 rollback không mất mã hãng: retry nhận lại, một lần create', async () => {
    const f = fixture(); f.failFinalize();
    expect((await f.service.ship(null, f.order.shopId, f.order.code))?.createStatus).toBe('unknown');
    expect((await f.service.ship(null, f.order.shopId, f.order.code))?.createStatus).toBe('created');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.repo.create).toHaveBeenCalledTimes(1);
  });
  it('bấm lại sau tạo thành công không gọi mạng hoặc ghi lịch sử lần hai', async () => {
    const f = fixture(); await f.service.ship(null, f.order.shopId, f.order.code); await f.service.ship(null, f.order.shopId, f.order.code);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it('đơn shop khác luôn 404 trước khi tạo vận đơn', async () => {
    const f = fixture(); await expect(f.service.ship(null, 'shop-khac', f.order.code)).rejects.toMatchObject({ httpStatus: 404 }); expect(f.create).not.toHaveBeenCalled();
  });
  it('online chưa trả hoặc đang chờ khách huỷ không tạo vận đơn', async () => {
    const f = fixture(); f.order.paymentMethodCode = 'payos';
    await expect(f.service.ship(null, f.order.shopId, f.order.code)).rejects.toMatchObject({ errorCode: 'SHIPMENT_CANNOT_CREATE' });
    f.order.paymentMethodCode = 'cod'; f.order.cancelRequestPending = true;
    await expect(f.service.ship(null, f.order.shopId, f.order.code)).rejects.toMatchObject({ errorCode: 'SHIPMENT_CANNOT_CREATE' });
  });
  it('không tạo mù nếu truy vấn mã client đang lỗi', async () => {
    const f = fixture(); f.find.mockRejectedValueOnce(new Error('503'));
    expect((await f.service.ship(null, f.order.shopId, f.order.code))?.createStatus).toBe('unknown');
    expect(f.create).not.toHaveBeenCalled();
  });
  it('returned trong lúc chờ phân xử giữ event/attempt; giải quyết xong tự tiếp tục đóng', async () => {
    const f = fixture();
    await f.service.ship(null, f.order.shopId, f.order.code);
    const row = f.row(); if (!row) throw new Error('Thiếu vận đơn');
    row.status = 'returning'; row.active = true; f.setUpstreamStatus('returned');
    const event = { id: 'event-returned', shipmentId: row.id, status: 'pending', leaseToken: null as string | null, retryCount: 0, provider: 'fake', environment: 'demo', rawStatus: 'returned' };
    Object.assign(f.repo, {
      pendingEvents: jest.fn(() => Promise.resolve([event])),
      claimEvent: jest.fn((_id: string, token: string) => { event.leaseToken = token; return Promise.resolve({ count: 1 }); }),
      eventForUpdate: jest.fn(() => Promise.resolve(event)),
      eventUpdate: jest.fn((_id: string, data: Record<string, unknown>) => { Object.assign(event, data); return Promise.resolve(event); }),
    });
    f.apply.mockImplementation(() => Promise.resolve());
    await f.service.processEvents();
    expect(f.row()?.status).toBe('returned');
    expect(f.row()?.active).toBe(true);
    expect(event.status).toBe('failed');
    f.order.status = 'returned'; // CSKH/return core đã kết thúc yêu cầu.
    await f.service.processEvents();
    expect(f.row()?.active).toBe(false);
    expect(event.status).toBe('processed');
    expect(f.apply).toHaveBeenCalledTimes(3); // tạo + hai lần returned, không bỏ event cuối.
  });
  it('tìm theo mã vận đơn/client vẫn giữ AND trạng thái và shop', async () => {
    const f = fixture();
    const list = jest.fn<Promise<[Shipment[], number]>, [Prisma.ShipmentWhereInput, number, number]>(() => Promise.resolve([[], 0]));
    Object.assign(f.repo, { list });
    await f.service.list({ q: ' ghn-test ', status: 'awaiting_pickup', shopId: f.order.shopId }, 2, 20);
    expect(list).toHaveBeenCalledWith({ shopId: f.order.shopId, AND: [{ OR: [{ status: 'awaiting_pickup' }, { createStatus: 'awaiting_pickup' }, { cancelStatus: 'awaiting_pickup' }] }, { OR: [{ orderCode: { contains: 'ghn-test', mode: 'insensitive' } }, { carrierOrderCode: { contains: 'ghn-test', mode: 'insensitive' } }, { clientOrderCode: { contains: 'ghn-test', mode: 'insensitive' } }] }] }, 20, 20);
  });
});
