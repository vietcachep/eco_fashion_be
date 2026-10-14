import { NotFoundException } from '@common/exception/business.exception';
import type { CacheService } from '@common/cache/cache.service';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { CatalogQueryApi } from '../../../catalog/queryapi/catalog.queryapi';
import type { ShopBrief, ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { ProductRepository, type ProductCardRow } from '../repository/product.repository';
import { ProductQueryService } from './product-query.service';

/*
 * Đường ĐỌC công khai: lọc theo shop (slug), ẩn hàng của shop chưa duyệt/bị khoá, và bộ lọc giá min+max cùng áp dụng.
 * Repo/ShopQueryApi dựng giả; cache chạy thẳng (getOrSet gọi factory) để kiểm logic, không kiểm Redis.
 */

const brief = (over: Partial<ShopBrief> = {}): ShopBrief => ({ id: 's-ok', code: 'S1', slug: 'shop-ok', name: 'Shop OK', logoUrl: null, ratingAvg: 4.5, status: 'approved', commissionRate: '10.00', codEnabled: true, ...over });
const card = (id: string, shopId: string) =>
  ({ id, shopId, slug: `sp-${id}`, name: `Sản phẩm ${id}`, categorySlug: 'ao-thun', gender: 'unisex', basePrice: { toString: () => '100000' }, listPrice: null, avgRating: { toString: () => '4.5' }, reviewCount: 3, soldCount: 5, isNew: false, isFeatured: false, publishedAt: null, tags: [], images: [], variants: [] }) as unknown as ProductCardRow;

function build() {
  const catalogMock = {
    findDynamicAttributeNamesByIds: jest.fn((ids: string[]) => Promise.resolve(new Map(ids.filter((i) => i === 'axis-color').map((i) => [i, { id: i, code: 'mau', name: 'Màu sắc' }])))),
    findDynamicAttributeValuesByIds: jest.fn().mockResolvedValue(new Map()),
  };
  const repo = {
    list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    findDetailBySlug: jest.fn(),
    findCardsByIds: jest.fn().mockResolvedValue([]),
    suggest: jest.fn().mockResolvedValue([]),
    related: jest.fn().mockResolvedValue([]),
  };
  const cache = { getOrSet: jest.fn((_spec: unknown, _key: string, factory: () => Promise<unknown>) => factory()) };
  const shops = {
    findPublicBySlug: jest.fn(),
    nonApprovedShopIds: jest.fn().mockResolvedValue(['s-pending', 's-banned']),
    findManyBrief: jest.fn().mockResolvedValue(new Map<string, ShopBrief>()),
    findBrief: jest.fn(),
  };
  const service = new ProductQueryService(repo as unknown as ProductRepository, cache as unknown as CacheService, catalogMock as unknown as CatalogQueryApi, shops as unknown as ShopQueryApi);
  return { service, repo, shops, catalogMock };
}

describe('ProductQueryService.list — lọc theo shop & ẩn shop không được bán', () => {
  it('có `shop` (slug) ⇒ chỉ hàng của shop đó (shopId), không cần loại shop khác', async () => {
    const { service, repo, shops } = build();
    shops.findPublicBySlug.mockResolvedValue({ id: 's-ok', slug: 'shop-ok', name: 'Shop OK', logoUrl: null, bannerUrl: null, description: null, ratingAvg: null });

    await service.list({ page: 1, size: 12, shop: 'shop-ok' });

    expect(shops.findPublicBySlug).toHaveBeenCalledWith('shop-ok');
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ publicOnly: true, shopId: 's-ok', excludeShopIds: undefined }), 0, 12);
    expect(shops.nonApprovedShopIds).not.toHaveBeenCalled();
  });

  it('slug không tồn tại / shop chưa duyệt / bị khoá ⇒ trang rỗng, KHÔNG truy vấn sản phẩm', async () => {
    const { service, repo, shops } = build();
    shops.findPublicBySlug.mockResolvedValue(null);

    const page = await service.list({ page: 2, size: 12, shop: 'khong-co' });

    expect(page.content).toEqual([]);
    expect(page.totalElements).toBe(0);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('không chọn shop ⇒ loại hàng của MỌI shop không được bán (chờ duyệt/khoá)', async () => {
    const { service, repo } = build();

    await service.list({ page: 1, size: 12 });

    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ shopId: undefined, excludeShopIds: ['s-pending', 's-banned'] }), 0, 12);
  });
});

describe('ProductQueryService — ẩn sản phẩm của shop chưa duyệt ở chi tiết / byIds / suggest / related', () => {
  it('detail: shop bị khoá ⇒ 404 như sản phẩm không tồn tại', async () => {
    const { service, repo, shops } = build();
    repo.findDetailBySlug.mockResolvedValue({ id: 'p1', shopId: 's-banned', attributeValues: [] });
    shops.findBrief.mockResolvedValue(brief({ id: 's-banned', status: 'suspended' }));

    await expect(service.detail('ao-thun')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('byIds: bỏ sản phẩm của shop không được bán, giữ thứ tự còn lại', async () => {
    const { service, repo, shops } = build();
    repo.findCardsByIds.mockResolvedValue([card('p1', 's-ok'), card('p2', 's-banned'), card('p3', 's-ok')]);
    shops.findManyBrief.mockResolvedValue(
      new Map([
        ['s-ok', brief()],
        ['s-banned', brief({ id: 's-banned', status: 'suspended' })],
      ]),
    );

    const out = await service.byIds(['p3', 'p2', 'p1']);

    expect(out.map((c) => c.id)).toEqual(['p3', 'p1']);
  });

  it('suggest: shop không được bán không xuất hiện trong gợi ý', async () => {
    const { service, repo, shops } = build();
    repo.suggest.mockResolvedValue([card('p1', 's-banned')]);
    shops.findManyBrief.mockResolvedValue(new Map([['s-banned', brief({ id: 's-banned', status: 'pending' })]]));

    expect(await service.suggest('áo', 8)).toEqual([]);
  });
});

/*
 * Hồi quy: shop KHÔNG ở trạng thái approved (chờ duyệt / bị khoá / bị từ chối / không còn tồn tại) ⇒ hàng của shop đó biến mất khỏi MỌI đường đọc
 * công khai — list, chi tiết (404), byIds, suggest, related. Mỗi đường phải tự lọc: một chỗ quên là khách mua được hàng của shop đã khoá.
 */
describe('ProductQueryService — hàng của shop không approved bị ẩn ở mọi đường đọc công khai', () => {
  const HIDDEN = ['pending', 'suspended', 'rejected'] as const;
  const briefs = (status: string, ...others: Array<[string, string]>) => new Map<string, ShopBrief>([['s-x', brief({ id: 's-x', status })], ...others.map(([id, st]) => [id, brief({ id, status: st })] as [string, ShopBrief])]);

  describe('detail', () => {
    it.each(HIDDEN)('shop %s ⇒ NotFoundException PRODUCT_NOT_FOUND', async (status) => {
      const { service, repo, shops } = build();
      repo.findDetailBySlug.mockResolvedValue({ id: 'p1', shopId: 's-x', attributeValues: [] });
      shops.findBrief.mockResolvedValue(brief({ id: 's-x', status }));

      await expect(service.detail('ao-thun')).rejects.toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    });

    it('shop không còn tồn tại (findBrief = null) ⇒ 404, không lộ sản phẩm mồ côi', async () => {
      const { service, repo, shops } = build();
      repo.findDetailBySlug.mockResolvedValue({ id: 'p1', shopId: 's-gone', attributeValues: [] });
      shops.findBrief.mockResolvedValue(null);

      await expect(service.detail('ao-thun')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('chỉ đọc sản phẩm đang bán công khai (publicOnly=true) và shop approved thì trả chi tiết', async () => {
      const { service, repo, shops } = build();
      repo.findDetailBySlug.mockResolvedValue({ ...card('p1', 's-ok'), shortDescription: null, description: null, material: null, care: [], attributeValues: [], images: [], variants: [] });
      shops.findBrief.mockResolvedValue(brief());

      await expect(service.detail('sp-p1')).resolves.toMatchObject({ id: 'p1' });
      expect(repo.findDetailBySlug).toHaveBeenCalledWith('sp-p1', true);
    });
  });

  describe('list', () => {
    it('shop vừa bị khoá ⇒ lần list kế tiếp (cache miss) loại id của shop đó khỏi truy vấn', async () => {
      const { service, repo, shops } = build();
      shops.nonApprovedShopIds.mockResolvedValueOnce([]).mockResolvedValueOnce(['s-x']);

      await service.list({ page: 1, size: 12, q: 'ao' });
      await service.list({ page: 1, size: 12, q: 'quan' });

      expect(repo.list).toHaveBeenNthCalledWith(1, expect.objectContaining({ publicOnly: true, excludeShopIds: [] }), 0, 12);
      expect(repo.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ publicOnly: true, excludeShopIds: ['s-x'] }), 0, 12);
    });

    it.each(HIDDEN)('chọn shop (slug) %s ⇒ findPublicBySlug trả null ⇒ trang rỗng, không truy vấn sản phẩm', async () => {
      const { service, repo, shops } = build();
      shops.findPublicBySlug.mockResolvedValue(null); // ShopQueryApi.findPublicBySlug chỉ trả shop approved

      const page = await service.list({ page: 1, size: 12, shop: 'shop-x' });

      expect(page).toMatchObject({ content: [], totalElements: 0 });
      expect(repo.list).not.toHaveBeenCalled();
    });
  });

  describe('byIds', () => {
    it.each(HIDDEN)('shop %s ⇒ loại; shop approved giữ nguyên thứ tự yêu cầu', async (status) => {
      const { service, repo, shops } = build();
      repo.findCardsByIds.mockResolvedValue([card('p1', 's-ok'), card('p2', 's-x'), card('p3', 's-ok')]);
      shops.findManyBrief.mockResolvedValue(briefs(status, ['s-ok', 'approved']));

      const out = await service.byIds(['p3', 'p2', 'p1']);

      expect(out.map((c) => c.id)).toEqual(['p3', 'p1']);
      expect(repo.findCardsByIds).toHaveBeenCalledWith(['p3', 'p2', 'p1'], true);
    });

    it('shop không còn tồn tại (không có trong lô tra) ⇒ loại', async () => {
      const { service, repo, shops } = build();
      repo.findCardsByIds.mockResolvedValue([card('p1', 's-gone')]);
      shops.findManyBrief.mockResolvedValue(new Map());

      expect(await service.byIds(['p1'])).toEqual([]);
    });
  });

  describe('suggest', () => {
    it.each(HIDDEN)('shop %s ⇒ không xuất hiện; shop approved còn lại vẫn có', async (status) => {
      const { service, repo, shops } = build();
      repo.suggest.mockResolvedValue([card('p1', 's-x'), card('p2', 's-ok')]);
      shops.findManyBrief.mockResolvedValue(briefs(status, ['s-ok', 'approved']));

      expect((await service.suggest('áo', 8)).map((c) => c.id)).toEqual(['p2']);
    });

    it('một lần tra lô shop cho cả danh sách gợi ý (không N+1)', async () => {
      const { service, repo, shops } = build();
      repo.suggest.mockResolvedValue([card('p1', 's-ok'), card('p2', 's-ok'), card('p3', 's-x')]);
      shops.findManyBrief.mockResolvedValue(briefs('suspended', ['s-ok', 'approved']));

      await service.suggest('áo', 8);

      expect(shops.findManyBrief).toHaveBeenCalledTimes(1);
    });
  });

  describe('related', () => {
    it.each(HIDDEN)('shop %s ⇒ sản phẩm liên quan của shop đó bị loại', async (status) => {
      const { service, repo, shops } = build();
      repo.findDetailBySlug.mockResolvedValue({ ...card('base', 's-ok'), attributeValues: [] });
      repo.related.mockResolvedValue([card('r1', 's-x'), card('r2', 's-ok')]);
      shops.findBrief.mockResolvedValue(brief());
      shops.findManyBrief.mockResolvedValue(briefs(status, ['s-ok', 'approved']));

      expect((await service.related('sp-base')).map((c) => c.id)).toEqual(['r2']);
    });

    it('toàn bộ liên quan thuộc shop bị khoá ⇒ mảng rỗng (không lỗi)', async () => {
      const { service, repo, shops } = build();
      repo.findDetailBySlug.mockResolvedValue({ ...card('base', 's-ok'), attributeValues: [] });
      repo.related.mockResolvedValue([card('r1', 's-x'), card('r2', 's-x')]);
      shops.findBrief.mockResolvedValue(brief());
      shops.findManyBrief.mockResolvedValue(briefs('suspended'));

      expect(await service.related('sp-base')).toEqual([]);
    });

    it.each(HIDDEN)('shop của SẢN PHẨM GỐC là %s ⇒ related 404 như chi tiết (không lộ slug còn tồn tại)', async (status) => {
      const { service, repo, shops } = build();
      repo.findDetailBySlug.mockResolvedValue({ ...card('base', 's-ok'), attributeValues: [] });
      shops.findBrief.mockResolvedValue(brief({ status }));

      await expect(service.related('sp-base')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.related).not.toHaveBeenCalled();
    });

    it('bộ lọc (màu/size/khoảng giá) loại hàng của shop không được bán', async () => {
      const { service, repo, shops, catalogMock } = build();
      shops.nonApprovedShopIds.mockResolvedValue(['s-pending', 's-banned']);
      Object.assign(repo, { filterFacets: jest.fn().mockResolvedValue({ min: '0', max: '0', colors: [], sizes: [] }) });
      Object.assign(catalogMock, { colorMap: jest.fn().mockResolvedValue(new Map()) });

      await service.filters();

      expect((repo as unknown as { filterFacets: jest.Mock }).filterFacets).toHaveBeenCalledWith(['s-pending', 's-banned']);
    });

    it('sản phẩm gốc không tồn tại ⇒ 404', async () => {
      const { service, repo } = build();
      repo.findDetailBySlug.mockResolvedValue(null);

      await expect(service.related('khong-co')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('ProductRepository.buildWhere — bộ lọc giá & shop', () => {
  const repo = new ProductRepository({} as unknown as PrismaService);

  it('minPrice VÀ maxPrice cùng có ⇒ gộp thành một điều kiện basePrice (không để maxPrice đè minPrice)', () => {
    const where = repo.buildWhere({ publicOnly: true, minPrice: 100_000n, maxPrice: 500_000n });
    const price = where.basePrice as { gte?: { toString(): string }; lte?: { toString(): string } };
    expect(price.gte?.toString()).toBe('100000');
    expect(price.lte?.toString()).toBe('500000');
  });

  it('chỉ một đầu giá ⇒ chỉ đầu đó', () => {
    const only = repo.buildWhere({ publicOnly: true, maxPrice: 300_000n }).basePrice as { gte?: unknown; lte?: unknown };
    expect(only.gte).toBeUndefined();
    expect(only.lte).toBeDefined();
    expect(repo.buildWhere({ publicOnly: true }).basePrice).toBeUndefined();
  });

  it('excludeShopIds ⇒ notIn; chọn shop cụ thể thì shopId ghi đè', () => {
    expect(repo.buildWhere({ publicOnly: true, excludeShopIds: ['a', 'b'] }).shopId).toEqual({ notIn: ['a', 'b'] });
    expect(repo.buildWhere({ publicOnly: true, excludeShopIds: ['a'], shopId: 's1' }).shopId).toBe('s1');
    expect(repo.buildWhere({ publicOnly: true, excludeShopIds: [] }).shopId).toBeUndefined();
  });
});

describe('ProductQueryService.detail — tên trục biến thể ngành động', () => {
  it('variants[].options[] có attributeName (tra batch cùng lượt với thuộc tính sản phẩm)', async () => {
    const { service, repo, shops } = build();
    const row = {
      ...card('p1', 's-ok'),
      shortDescription: null,
      description: null,
      material: null,
      care: [],
      attributeValues: [],
      images: [],
      variants: [{ id: 'v1', isActive: true, colorName: null, colorCode: null, sizeCode: null, colorHex: null, sku: 'SKU-1', stock: 5, reserved: 1, price: null, options: [{ attributeId: 'axis-color', attributeValueId: 'val-den', displayValue: 'Đen' }] }],
    };
    repo.findDetailBySlug.mockResolvedValue(row);
    shops.findBrief.mockResolvedValue(brief());

    const detail = await service.detail('sp-p1');

    expect(detail.variants[0].options).toEqual([{ attributeId: 'axis-color', attributeValueId: 'val-den', displayValue: 'Đen', attributeName: 'Màu sắc' }]);
  });
});
