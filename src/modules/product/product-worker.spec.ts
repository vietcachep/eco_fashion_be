import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import type { CacheService, CacheSpec } from '@common/cache/cache.service';
import { NotFoundException } from '@common/exception/business.exception';
import type { OutboxEventMessage } from '@common/outbox/outbox';
import type { CatalogQueryApi } from '../catalog/queryapi/catalog.queryapi';
import { SHOP_EVENT, SHOP_MODULE } from '../shop/enums/shop-events';
import type { ShopBrief, ShopQueryApi } from '../shop/queryapi/shop.queryapi';
import { ProductModule } from './product.module';
import { ProductShopStatusListeners, ProductWorkerModule } from './product-worker.module';
import type { ProductRepository } from './product/repository/product.repository';
import { ProductQueryService } from './product/service/product-query.service';

/*
 * Cache công khai của product (list 60s / chi tiết 120s / liên quan 300s / bộ lọc 600s) KHÔNG được để hàng của shop vừa bị khoá còn hiện
 * (và hàng của shop vừa được duyệt lại bị 404 vì chi tiết cache cả kết quả "không có"): shop phát outbox SHOP_APPROVED/SUSPENDED/REJECTED,
 * listener của worker product xoá cache ngay. Test nối dây THẬT qua EventEmitter2 (decorator @OnEvent), không chỉ gọi tay hàm xử lý.
 */

const msg = (eventType: string, payload: Record<string, unknown> = { shopId: 'shop-1' }): OutboxEventMessage => ({ id: 'evt-1', module: SHOP_MODULE, eventType, eventVersion: 'v1', aggregateType: 'shop', aggregateId: 'shop-1', payload, requestId: null, createdAt: '2026-10-04T00:00:00.000Z' });
const eventName = (type: string) => `outbox.${SHOP_MODULE}.${type}`;

type OnEventMeta = Array<{ event: string; options?: { suppressErrors?: boolean } }>;

describe('ProductShopStatusListeners — xoá cache công khai khi shop đổi trạng thái', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  async function boot(invalidateAll: () => Promise<void>) {
    const query = { invalidateAll: jest.fn(invalidateAll) };
    const mod = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [ProductShopStatusListeners, { provide: ProductQueryService, useValue: query }],
    }).compile();
    await mod.init();
    return { query, emitter: mod.get(EventEmitter2), close: () => mod.close() };
  }

  it.each([SHOP_EVENT.APPROVED, SHOP_EVENT.SUSPENDED, SHOP_EVENT.REJECTED])('%s (qua EventEmitter như relay outbox) ⇒ invalidateAll đúng một lần', async (type) => {
    const { query, emitter, close } = await boot(() => Promise.resolve());

    await emitter.emitAsync(eventName(type), msg(type));

    expect(query.invalidateAll).toHaveBeenCalledTimes(1);
    await close();
  });

  it('sự kiện shop KHÁC (đổi ngân hàng, thành viên rời/vào, lời mời) KHÔNG xoá cache sản phẩm', async () => {
    const { query, emitter, close } = await boot(() => Promise.resolve());

    for (const type of [SHOP_EVENT.BANK_CHANGED, SHOP_EVENT.MEMBER_LEFT, SHOP_EVENT.MEMBER_JOINED]) await emitter.emitAsync(eventName(type), msg(type));

    expect(query.invalidateAll).not.toHaveBeenCalled();
    await close();
  });

  it('idempotent: cùng sự kiện giao lại (relay retry / at-least-once) ⇒ chạy lại không lỗi', async () => {
    const { query, emitter, close } = await boot(() => Promise.resolve());

    await emitter.emitAsync(eventName(SHOP_EVENT.SUSPENDED), msg(SHOP_EVENT.SUSPENDED));
    await expect(emitter.emitAsync(eventName(SHOP_EVENT.SUSPENDED), msg(SHOP_EVENT.SUSPENDED))).resolves.toBeDefined();

    expect(query.invalidateAll).toHaveBeenCalledTimes(2);
    await close();
  });

  it('payload thiếu shopId vẫn xoá cache (không phụ thuộc payload)', async () => {
    const { query, emitter, close } = await boot(() => Promise.resolve());

    await emitter.emitAsync(eventName(SHOP_EVENT.APPROVED), msg(SHOP_EVENT.APPROVED, {}));

    expect(query.invalidateAll).toHaveBeenCalledTimes(1);
    await close();
  });

  it('lỗi KHÔNG bị nuốt: invalidateAll ném ⇒ emitAsync ném lên để relay đánh FAILED + retry', async () => {
    const { emitter, close } = await boot(() => Promise.reject(new Error('Redis down')));

    await expect(emitter.emitAsync(eventName(SHOP_EVENT.SUSPENDED), msg(SHOP_EVENT.SUSPENDED))).rejects.toThrow('Redis down');
    await close();
  });

  it('nối dây Nest: ProductModule export ProductQueryService và ProductWorkerModule khai listener (thiếu một trong hai: worker không boot được hoặc không nghe gì)', () => {
    expect(Reflect.getMetadata('exports', ProductModule) as unknown[]).toContain(ProductQueryService);
    expect(Reflect.getMetadata('providers', ProductWorkerModule) as unknown[]).toContain(ProductShopStatusListeners);
  });

  it('đăng ký đúng ba sự kiện outbox của shop, mỗi cái suppressErrors=false', () => {
    const handler: unknown = Object.getOwnPropertyDescriptor(ProductShopStatusListeners.prototype, 'onShopStatusChanged')?.value;
    const meta = Reflect.getMetadata('EVENT_LISTENER_METADATA', handler as object) as OnEventMeta;

    expect(meta.map((m) => m.event).sort()).toEqual([eventName(SHOP_EVENT.APPROVED), eventName(SHOP_EVENT.REJECTED), eventName(SHOP_EVENT.SUSPENDED)]);
    for (const m of meta) expect(m.options?.suppressErrors).toBe(false);
  });
});

/*
 * Đầu-cuối trên ProductQueryService THẬT + cache bộ nhớ (mô phỏng getOrSet/delByPrefix của Redis): trước khi có listener, chi tiết/danh sách
 * cache vẫn trả hàng của shop vừa khoá tới hết TTL; sau sự kiện thì 404 / loại ngay, và duyệt lại thì hiện lại ngay.
 */
describe('cache công khai + SHOP_* — shop khoá / duyệt lại có hiệu lực ngay', () => {
  const card = (id: string, shopId: string) =>
    ({ id, shopId, slug: `sp-${id}`, name: `Sản phẩm ${id}`, categorySlug: 'ao-thun', gender: 'unisex', basePrice: { toString: () => '100000' }, listPrice: null, avgRating: { toString: () => '4.5' }, reviewCount: 3, soldCount: 5, isNew: false, isFeatured: false, publishedAt: null, tags: [], images: [], variants: [] }) as never;
  const detailRow = () => ({ ...(card('p1', 'shop-1') as object), shortDescription: null, description: null, material: null, care: [], attributeValues: [], images: [], variants: [] });
  const shopBrief = (status: string): ShopBrief => ({ id: 'shop-1', code: 'S1', slug: 'shop-1', name: 'Shop 1', logoUrl: null, ratingAvg: 4.5, status, commissionRate: '10.00', codEnabled: true });

  function build() {
    const shop = { status: 'approved' };
    const store = new Map<string, unknown>();
    const k = (spec: CacheSpec, id: string) => `${spec.purpose}:${id}`;
    const cache = {
      getOrSet: jest.fn(async (spec: CacheSpec, id: string, loader: () => Promise<unknown>) => {
        if (store.has(k(spec, id))) return store.get(k(spec, id));
        const v = await loader();
        store.set(k(spec, id), v);
        return v;
      }),
      delByPrefix: jest.fn((spec: CacheSpec) => {
        for (const key of [...store.keys()]) if (key.startsWith(`${spec.purpose}:`)) store.delete(key);
        return Promise.resolve();
      }),
    };
    const repo = {
      // Danh sách chỉ trả sản phẩm của shop KHÔNG nằm trong excludeShopIds — như SQL `shop_id NOT IN (...)` thật.
      list: jest.fn((f: { excludeShopIds?: string[] }) => Promise.resolve({ items: (f.excludeShopIds ?? []).includes('shop-1') ? [] : [card('p1', 'shop-1')], total: (f.excludeShopIds ?? []).includes('shop-1') ? 0 : 1 })),
      findDetailBySlug: jest.fn(() => Promise.resolve(detailRow())),
      related: jest.fn(() => Promise.resolve([card('p2', 'shop-1')])),
    };
    const shops = {
      findBrief: jest.fn(() => Promise.resolve(shopBrief(shop.status))),
      findManyBrief: jest.fn(() => Promise.resolve(new Map([['shop-1', shopBrief(shop.status)]]))),
      nonApprovedShopIds: jest.fn(() => Promise.resolve(shop.status === 'approved' ? [] : ['shop-1'])),
      findPublicBySlug: jest.fn(),
    };
    const catalog = { findDynamicAttributeNamesByIds: jest.fn(() => Promise.resolve(new Map())), findDynamicAttributeValuesByIds: jest.fn(() => Promise.resolve(new Map())) };
    const query = new ProductQueryService(repo as unknown as ProductRepository, cache as unknown as CacheService, catalog as unknown as CatalogQueryApi, shops as unknown as ShopQueryApi);
    const listener = new ProductShopStatusListeners(query);
    return { shop, query, listener };
  }

  it('shop approved → suspended: list + chi tiết còn trong cache cho tới khi nhận SHOP_SUSPENDED, rồi loại / 404 NGAY', async () => {
    const { shop, query, listener } = build();
    expect((await query.list({ page: 1, size: 12 })).content.map((c) => c.id)).toEqual(['p1']);
    expect((await query.detail('sp-p1')).id).toBe('p1');

    shop.status = 'suspended';
    // Chưa có sự kiện: cache còn hiệu lực — đây chính là độ trễ cần xoá.
    expect((await query.detail('sp-p1')).id).toBe('p1');
    expect((await query.list({ page: 1, size: 12 })).content).toHaveLength(1);

    await listener.onShopStatusChanged(msg(SHOP_EVENT.SUSPENDED));

    await expect(query.detail('sp-p1')).rejects.toBeInstanceOf(NotFoundException);
    expect((await query.list({ page: 1, size: 12 })).content).toEqual([]);
  });

  it('shop suspended → approved lại: chi tiết đã cache "không có" được xoá, sản phẩm hiện lại ngay', async () => {
    const { shop, query, listener } = build();
    shop.status = 'suspended';
    await expect(query.detail('sp-p1')).rejects.toBeInstanceOf(NotFoundException); // cache kết quả {missing:true}

    shop.status = 'approved';
    await expect(query.detail('sp-p1')).rejects.toBeInstanceOf(NotFoundException); // vẫn 404 vì cache chưa xoá

    await listener.onShopStatusChanged(msg(SHOP_EVENT.APPROVED));

    expect((await query.detail('sp-p1')).id).toBe('p1');
  });

  it('SHOP_REJECTED cũng xoá cache liên quan', async () => {
    const { shop, query, listener } = build();
    expect((await query.related('sp-p1')).map((c) => c.id)).toEqual(['p2']);

    shop.status = 'rejected';
    expect((await query.related('sp-p1')).map((c) => c.id)).toEqual(['p2']); // cache 300s còn hiệu lực

    await listener.onShopStatusChanged(msg(SHOP_EVENT.REJECTED));

    // Shop của sản phẩm gốc bị từ chối ⇒ related cũng 404 như chi tiết.
    await expect(query.related('sp-p1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
