import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { CatalogQueryApi } from '../../catalog/queryapi/catalog.queryapi';
import type { ShopQueryApi } from '../../shop/queryapi/shop.queryapi';
import { toProductAdmin, toProductDetail } from '../product/mapper/product.mapper';
import type { ProductDetailRow, ProductRepository } from '../product/repository/product.repository';
import { resolveAttributeLookup } from './attribute-lookup';
import { ProductQueryApi } from './product.queryapi';
import { dynamicColorSize } from './variant-label';

type AttrName = { id: string; code: string; name: string };
const ATTRS = new Map<string, AttrName>([
  ['a-color', { id: 'a-color', code: 'color2', name: 'Màu sắc' }],
  ['a-storage', { id: 'a-storage', code: 'storage', name: 'Dung lượng' }],
  ['a-origin', { id: 'a-origin', code: 'origin', name: 'Xuất xứ' }],
  ['a-note', { id: 'a-note', code: 'note', name: 'Ghi chú' }],
]);

describe('dynamicColorSize — quy ước màu/size cho biến thể ngành dynamic (H7)', () => {
  const codes = new Map(ATTRS);

  it('có trục "màu" → color là giá trị màu, size là trục còn lại ("Đen" / "128GB")', () => {
    // Thứ tự đầu vào không ảnh hưởng: màu luôn được chọn theo mã thuộc tính.
    expect(dynamicColorSize([{ attributeId: 'a-storage', displayValue: '128GB' }, { attributeId: 'a-color', displayValue: 'Đen' }], codes)).toEqual({ color: 'Đen', size: '128GB' });
    expect(dynamicColorSize([{ attributeId: 'a-color', displayValue: 'Đen' }, { attributeId: 'a-storage', displayValue: '128GB' }], codes)).toEqual({ color: 'Đen', size: '128GB' });
  });

  it('chỉ MỘT trục → color = giá trị đó, size rỗng', () => {
    expect(dynamicColorSize([{ attributeId: 'a-storage', displayValue: '256GB' }], codes)).toEqual({ color: '256GB', size: '' });
  });

  it('không trục nào là màu → color = trục đầu (cố định theo attributeId), size = trục còn lại', () => {
    const noColor = new Map<string, { code: string }>([['a-ram', { code: 'ram' }], ['a-storage', { code: 'storage' }]]);
    const options = [{ attributeId: 'a-storage', displayValue: '128GB' }, { attributeId: 'a-ram', displayValue: '8GB' }];

    expect(dynamicColorSize(options, noColor)).toEqual({ color: '8GB', size: '128GB' }); // 'a-ram' < 'a-storage'
    expect(dynamicColorSize([...options].reverse(), noColor)).toEqual({ color: '8GB', size: '128GB' }); // ổn định
  });

  it('mã thuộc tính tiếng Việt "mau_sac" cũng được coi là màu; không có option → rỗng', () => {
    expect(dynamicColorSize([{ attributeId: 'x', displayValue: 'Xanh' }, { attributeId: 'a', displayValue: 'L' }], new Map([['x', { code: 'mau_sac' }], ['a', { code: 'size_ao' }]]))).toEqual({ color: 'Xanh', size: 'L' });
    expect(dynamicColorSize([], codes)).toEqual({ color: '', size: '' });
  });
});

describe('ProductQueryApi.variantSnapshots — snapshot biến thể dynamic (H7)', () => {
  const findMany = jest.fn<Promise<unknown[]>, [unknown]>();
  const findNames = jest.fn<ReturnType<CatalogQueryApi['findDynamicAttributeNamesByIds']>, Parameters<CatalogQueryApi['findDynamicAttributeNamesByIds']>>();
  let api: ProductQueryApi;

  const product = { id: 'p1', slug: 'dien-thoai-x', name: 'Điện thoại X', categorySlug: 'dien-thoai', basePrice: new Prisma.Decimal('9000000'), status: 'active', isDeleted: false, images: [{ url: 'img.jpg', colorCode: null, isPrimary: true }] };
  const legacy = { id: 'v-legacy', sku: 'AO-DEN-M', shopId: 'shop-1', colorCode: 'den', colorName: 'Đen', sizeCode: 'M', price: null, stock: 5, reserved: 1, isActive: true, options: [], product };
  const dynamic = { id: 'v-dyn', sku: 'DT-128-DEN', shopId: 'shop-1', colorCode: null, colorName: null, sizeCode: null, price: new Prisma.Decimal('9500000'), stock: 3, reserved: 0, isActive: true, options: [{ attributeId: 'a-storage', displayValue: '128GB' }, { attributeId: 'a-color', displayValue: 'Đen' }], product };

  beforeEach(() => {
    jest.resetAllMocks();
    findNames.mockResolvedValue(ATTRS);
    api = new ProductQueryApi({ productVariant: { findMany } } as unknown as PrismaService, {} as ProductRepository, { findDynamicAttributeNamesByIds: findNames } as unknown as CatalogQueryApi, {} as ShopQueryApi);
  });

  it('biến thể dynamic: color/size dựng từ options (không rỗng); biến thể thời trang giữ nguyên colorName/sizeCode', async () => {
    findMany.mockResolvedValue([legacy, dynamic]);

    const snaps = await api.variantSnapshots(['v-legacy', 'v-dyn']);

    expect(snaps.get('v-dyn')).toMatchObject({ color: 'Đen', size: '128GB', colorCode: '', sku: 'DT-128-DEN', unitPrice: '9500000', available: 3, isSellable: true, shopId: 'shop-1', imageUrl: 'img.jpg' });
    expect(snaps.get('v-legacy')).toMatchObject({ color: 'Đen', size: 'M', colorCode: 'den', unitPrice: '9000000', available: 4 });
  });

  it('tra tên thuộc tính MỘT lần cho cả lô (không N+1) với danh sách attributeId duy nhất', async () => {
    findMany.mockResolvedValue([dynamic, { ...dynamic, id: 'v-dyn2' }, legacy]);

    await api.variantSnapshots(['v-dyn', 'v-dyn2', 'v-legacy']);

    expect(findNames).toHaveBeenCalledTimes(1);
    expect([...(findNames.mock.calls[0][0])].sort()).toEqual(['a-color', 'a-storage']);
  });

  it('chỉ có biến thể thời trang → không gọi catalog', async () => {
    findMany.mockResolvedValue([legacy]);

    await api.variantSnapshots(['v-legacy']);

    expect(findNames).not.toHaveBeenCalled();
  });

  it('snapshot đúng hình dạng cho cart/order/promotion (đủ trường, color/size/colorCode luôn là chuỗi)', async () => {
    findMany.mockResolvedValue([dynamic]);

    const snap = (await api.variantSnapshots(['v-dyn'])).get('v-dyn');

    expect(Object.keys(snap ?? {}).sort()).toEqual(['available', 'categorySlug', 'color', 'colorCode', 'imageUrl', 'isSellable', 'name', 'productId', 'shopId', 'size', 'sku', 'slug', 'unitPrice', 'variantId']);
    expect(typeof snap?.color).toBe('string');
    expect(typeof snap?.size).toBe('string');
  });
});

describe('thuộc tính cấp sản phẩm — tên thuộc tính + giá trị select (H7, mapper)', () => {
  const findNames = jest.fn<ReturnType<CatalogQueryApi['findDynamicAttributeNamesByIds']>, Parameters<CatalogQueryApi['findDynamicAttributeNamesByIds']>>();
  const findValues = jest.fn<ReturnType<CatalogQueryApi['findDynamicAttributeValuesByIds']>, Parameters<CatalogQueryApi['findDynamicAttributeValuesByIds']>>();
  const catalog = { findDynamicAttributeNamesByIds: findNames, findDynamicAttributeValuesByIds: findValues } as unknown as CatalogQueryApi;

  function detailRow(over: Partial<ProductDetailRow> = {}): ProductDetailRow {
    return {
      id: 'p1', shopId: 'shop-1', slug: 'dien-thoai-x', name: 'Điện thoại X', categoryId: 'c1', categorySlug: 'dien-thoai', gender: 'unisex',
      basePrice: new Prisma.Decimal('9000000'), listPrice: null, status: 'active', isNew: false, isFeatured: false, tags: [], soldCount: 0, reviewCount: 0, avgRating: new Prisma.Decimal('0'),
      publishedAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), variants: [], images: [],
      shortDescription: null, description: null, material: null, care: [], viewCount: 0,
      attributeValues: [
        { id: 'pa1', attributeId: 'a-origin', attributeValueId: 'val-vn', customValue: null }, // select
        { id: 'pa2', attributeId: 'a-note', attributeValueId: null, customValue: 'Hàng chính hãng' }, // text nhập tay
      ],
      ...over,
    };
  }

  beforeEach(() => {
    jest.resetAllMocks();
    findNames.mockResolvedValue(ATTRS);
    findValues.mockResolvedValue(new Map([['val-vn', { id: 'val-vn', value: 'Việt Nam', attributeId: 'a-origin' }]]));
  });

  it('resolve tên thuộc tính + giá trị select; giá trị nhập tay giữ nguyên', async () => {
    const row = detailRow();
    const attrs = await resolveAttributeLookup(catalog, row);

    const detail = toProductDetail(row, undefined, attrs);

    expect(detail.attributeValues).toEqual([
      { attributeId: 'a-origin', attributeName: 'Xuất xứ', attributeValueId: 'val-vn', value: 'Việt Nam' },
      { attributeId: 'a-note', attributeName: 'Ghi chú', attributeValueId: null, value: 'Hàng chính hãng' },
    ]);
    expect(findNames).toHaveBeenCalledTimes(1);
    expect(findValues).toHaveBeenCalledWith(['val-vn']); // chỉ giá trị select, bỏ id null
  });

  it('đường quản trị (toProductAdmin) cũng nhận lookup', async () => {
    const row = detailRow();

    const admin = toProductAdmin(row, await resolveAttributeLookup(catalog, row));

    expect(admin.attributeValues?.[0]).toMatchObject({ attributeName: 'Xuất xứ', value: 'Việt Nam' });
  });

  it('chỉ có giá trị nhập tay → không gọi tra giá trị select; sản phẩm không có thuộc tính động → không gọi catalog', async () => {
    const onlyText = detailRow({ attributeValues: [{ id: 'pa2', attributeId: 'a-note', attributeValueId: null, customValue: 'x' }] });
    await resolveAttributeLookup(catalog, onlyText);
    expect(findValues).not.toHaveBeenCalled();

    jest.clearAllMocks();
    expect(await resolveAttributeLookup(catalog, detailRow({ attributeValues: [] }))).toBeUndefined();
    expect(findNames).not.toHaveBeenCalled();
  });

  it('không truyền lookup → giữ hành vi cũ (tên rỗng, value null cho select) và KHÔNG ném', () => {
    const detail = toProductDetail(detailRow());

    expect(detail.attributeValues?.[0]).toMatchObject({ attributeName: '', value: null });
    expect(detail.attributeValues?.[1]).toMatchObject({ value: 'Hàng chính hãng' });
  });
});

describe('ProductQueryApi — đường đọc dành cho khách (AI, wishlist…) không lộ hàng của shop bị khoá/chờ duyệt', () => {
  const HIDDEN = ['s-pending', 's-banned'];
  const findFirst = jest.fn<Promise<unknown>, [{ where: Record<string, unknown> }]>();
  const findMany = jest.fn();
  const repo = { findCardsByIds: jest.fn(), suggest: jest.fn(), findCardsWhere: jest.fn<Promise<unknown[]>, [Record<string, unknown>, number]>() };
  const catalog = { findCategoryById: jest.fn(), findDynamicAttributeNamesByIds: jest.fn(), findDynamicAttributeValuesByIds: jest.fn() };
  const shops = { nonApprovedShopIds: jest.fn() };
  let api: ProductQueryApi;

  beforeEach(() => {
    // Khối trên gọi resetAllMocks (xoá cả mock khai ở khối này) nên phải dựng lại giá trị trả về mỗi lần.
    jest.resetAllMocks();
    findMany.mockResolvedValue([]);
    repo.findCardsByIds.mockResolvedValue([]);
    repo.suggest.mockResolvedValue([]);
    repo.findCardsWhere.mockResolvedValue([]);
    catalog.findCategoryById.mockResolvedValue(null);
    catalog.findDynamicAttributeNamesByIds.mockResolvedValue(new Map());
    catalog.findDynamicAttributeValuesByIds.mockResolvedValue(new Map());
    shops.nonApprovedShopIds.mockResolvedValue(HIDDEN);
    api = new ProductQueryApi({ product: { findFirst, findMany } } as unknown as PrismaService, repo as unknown as ProductRepository, catalog as unknown as CatalogQueryApi, shops as unknown as ShopQueryApi);
  });

  it('cardsByIds / searchCards truyền danh sách shop bị ẩn xuống repo', async () => {
    await api.cardsByIds(['p1']);
    await api.searchCards('giày', 6);

    expect(repo.findCardsByIds).toHaveBeenCalledWith(['p1'], true, HIDDEN);
    expect(repo.suggest).toHaveBeenCalledWith('giày', 6, HIDDEN);
  });

  it('recommend loại shopId bị ẩn khỏi điều kiện tìm; không có shop bị ẩn thì không thêm điều kiện', async () => {
    await api.recommend({ limit: 3 });
    expect(repo.findCardsWhere.mock.calls[0][0]).toMatchObject({ isDeleted: false, status: 'active', shopId: { notIn: HIDDEN } });

    shops.nonApprovedShopIds.mockResolvedValue([]);
    await api.recommend({ limit: 3 });
    expect(repo.findCardsWhere.mock.calls[1][0]).not.toHaveProperty('shopId');
  });

  it('thử đồ & chi tiết cho AI của khách: loại shop bị ẩn; nhân viên (anyStatus) không bị lọc shop', async () => {
    findFirst.mockResolvedValue(null);

    await api.garmentForTryOn('p1');
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: 'p1', status: 'active', shopId: { notIn: HIDDEN } });

    await api.detailForAi('sp-1');
    expect(findFirst.mock.calls[1][0].where).toMatchObject({ slug: 'sp-1', status: 'active', shopId: { notIn: HIDDEN } });

    await api.detailForAi('sp-1', true);
    expect(findFirst.mock.calls[2][0].where).toEqual({ slug: 'sp-1', isDeleted: false });
    expect(shops.nonApprovedShopIds).toHaveBeenCalledTimes(2);
  });
});
