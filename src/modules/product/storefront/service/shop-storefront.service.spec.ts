import { NotFoundException } from '@common/exception/business.exception';
import type { ShopPublicProfile, ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import type { ProductRepository } from '../../product/repository/product.repository';
import { ShopStorefrontService } from './shop-storefront.service';

const profile = (over: Partial<ShopPublicProfile> = {}): ShopPublicProfile => ({ id: 's1', slug: 'techzone', name: 'TechZone', logoUrl: 'l.png', bannerUrl: 'b.png', description: 'Điện tử chính hãng', ratingAvg: 4.7, ...over });

function build() {
  const shops = { findPublicBySlug: jest.fn(), listPublic: jest.fn() };
  const products = { shopStats: jest.fn().mockResolvedValue(new Map()) };
  const service = new ShopStorefrontService(shops as unknown as ShopQueryApi, products as unknown as ProductRepository);
  return { service, shops, products };
}

describe('ShopStorefrontService — trang gian hàng công khai', () => {
  it('detail: ghép hồ sơ + số sản phẩm đang bán + tổng lượt đánh giá; chỉ trả trường công khai', async () => {
    const { service, shops, products } = build();
    shops.findPublicBySlug.mockResolvedValue(profile());
    products.shopStats.mockResolvedValue(new Map([['s1', { productCount: 56, reviewCount: 128 }]]));

    const res = await service.detail('techzone');

    expect(res).toEqual({ slug: 'techzone', name: 'TechZone', logoUrl: 'l.png', bannerUrl: 'b.png', description: 'Điện tử chính hãng', ratingAvg: 4.7, reviewCount: 128, productCount: 56 });
    expect(Object.keys(res)).not.toEqual(expect.arrayContaining(['id', 'commissionRate', 'bankCode']));
  });

  it('detail: shop chưa duyệt / bị khoá / không có (queryapi trả null) ⇒ 404', async () => {
    const { service, shops } = build();
    shops.findPublicBySlug.mockResolvedValue(null);
    await expect(service.detail('ma')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('shop chưa có sản phẩm nào ⇒ productCount/reviewCount = 0 (không undefined)', async () => {
    const { service, shops } = build();
    shops.findPublicBySlug.mockResolvedValue(profile({ ratingAvg: null }));

    const res = await service.detail('techzone');

    expect(res.productCount).toBe(0);
    expect(res.reviewCount).toBe(0);
    expect(res.ratingAvg).toBeNull();
  });

  it('list: phân trang theo (page-1)*size, đếm thống kê MỘT lần cho cả trang', async () => {
    const { service, shops, products } = build();
    shops.listPublic.mockResolvedValue({ items: [profile(), profile({ id: 's2', slug: 'beauty-box', name: 'Beauty Box' })], total: 14 });
    products.shopStats.mockResolvedValue(new Map([['s2', { productCount: 9, reviewCount: 30 }]]));

    const page = await service.list('tech', 2, 12);

    expect(shops.listPublic).toHaveBeenCalledWith('tech', 12, 12);
    expect(products.shopStats).toHaveBeenCalledTimes(1);
    expect(products.shopStats).toHaveBeenCalledWith(['s1', 's2']);
    expect(page.totalElements).toBe(14);
    expect(page.content.map((s) => [s.slug, s.productCount])).toEqual([
      ['techzone', 0],
      ['beauty-box', 9],
    ]);
  });
});
