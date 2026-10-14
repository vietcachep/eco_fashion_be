import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import { PageResponse } from '@common/response/api-response';
import { ShopPublicProfile, ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { PRODUCT_ERR } from '../../foundation/product.constants';
import { ProductRepository } from '../../product/repository/product.repository';
import { ShopStorefrontResponse } from '../dto/shop-storefront.responses';

/*
 * Trang gian hàng công khai. Đặt ở module product (không phải shop) vì cần số sản phẩm + lượt đánh giá đếm sẵn trên bảng products —
 * shop không được import product (product đã phụ thuộc shop; ngược lại là vòng). Hồ sơ shop vẫn lấy qua ShopQueryApi.
 */
@Injectable()
export class ShopStorefrontService {
  constructor(
    private readonly shops: ShopQueryApi,
    private readonly products: ProductRepository,
  ) {}

  async detail(slug: string): Promise<ShopStorefrontResponse> {
    const shop = await this.shops.findPublicBySlug(slug);
    if (!shop) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
    const stats = await this.products.shopStats([shop.id]);
    return this.toResponse(shop, stats.get(shop.id));
  }

  async list(q: string | undefined, page: number, size: number): Promise<PageResponse<ShopStorefrontResponse>> {
    const { items, total } = await this.shops.listPublic(q, (page - 1) * size, size);
    const stats = await this.products.shopStats(items.map((s) => s.id));
    return PageResponse.of(
      items.map((s) => this.toResponse(s, stats.get(s.id))),
      page,
      size,
      total,
    );
  }

  private toResponse(s: ShopPublicProfile, stats: { productCount: number; reviewCount: number } | undefined): ShopStorefrontResponse {
    return { slug: s.slug, name: s.name, logoUrl: s.logoUrl, bannerUrl: s.bannerUrl, description: s.description, ratingAvg: s.ratingAvg, reviewCount: stats?.reviewCount ?? 0, productCount: stats?.productCount ?? 0 };
  }
}
