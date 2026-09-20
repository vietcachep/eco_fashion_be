import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CacheService } from '@common/cache/cache.service';
import { NotFoundException } from '@common/exception/business.exception';
import { PageResponse } from '@common/response/api-response';
import { money } from '@common/response/money-response';
import { vnd } from '@common/utils/money';
import { CatalogQueryApi } from '../../../catalog/queryapi/catalog.queryapi';
import { PRODUCT_CACHE, PRODUCT_ERR, ProductSort } from '../../foundation/product.constants';
import { ProductCardResponse, ProductDetailResponse, ProductFiltersResponse } from '../dto/product.responses';
import { sortSizes, toProductCard, toProductDetail } from '../mapper/product.mapper';
import { ProductRepository } from '../repository/product.repository';

export interface PublicListParams {
  page: number;
  size: number;
  q?: string;
  category?: string;
  gender?: string;
  sizeCode?: string;
  color?: string;
  minPrice?: string;
  maxPrice?: string;
  sale?: boolean;
  tag?: string;
  sort?: string;
}

/*
 * Đường ĐỌC công khai của product (web bán hàng) — mọi hàm đi qua cache Redis (AGENTS — Cache Strategy):
 * list 60s theo hash tham số, chi tiết 120s theo slug, bộ lọc 10', liên quan 5'. Ghi ở ProductService/Inventory xoá theo prefix.
 * Tồn kho trong chi tiết là "có thể bán" (stock − reserved) tại thời điểm cache — quyết định bán thật nằm ở InventoryGateway.
 */
@Injectable()
export class ProductQueryService {
  constructor(
    private readonly repo: ProductRepository,
    private readonly cache: CacheService,
    private readonly catalog: CatalogQueryApi,
  ) {}

  async list(p: PublicListParams): Promise<PageResponse<ProductCardResponse>> {
    const key = createHash('sha1').update(JSON.stringify(p)).digest('hex').slice(0, 24);
    return this.cache.getOrSet(PRODUCT_CACHE.list, key, async () => {
      const { items, total } = await this.repo.list(
        {
          publicOnly: true,
          q: p.q,
          categorySlug: p.category,
          gender: p.gender,
          size: p.sizeCode,
          color: p.color,
          minPrice: p.minPrice ? vnd(p.minPrice) : undefined,
          maxPrice: p.maxPrice ? vnd(p.maxPrice) : undefined,
          sale: p.sale,
          tag: p.tag,
          sort: p.sort as ProductSort | undefined,
        },
        (p.page - 1) * p.size,
        p.size,
      );
      return PageResponse.of(items.map(toProductCard), p.page, p.size, total);
    });
  }

  async detail(slug: string): Promise<ProductDetailResponse> {
    const cached = await this.cache.getOrSet<ProductDetailResponse | { missing: true }>(PRODUCT_CACHE.detail, slug, async () => {
      const row = await this.repo.findDetailBySlug(slug, true);
      return row ? toProductDetail(row) : { missing: true };
    });
    if ('missing' in cached) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    return cached;
  }

  async byIds(ids: string[]): Promise<ProductCardResponse[]> {
    const rows = await this.repo.findCardsByIds(ids, true);
    const rank = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)).map(toProductCard);
  }

  async suggest(q: string, limit: number): Promise<ProductCardResponse[]> {
    return (await this.repo.suggest(q, Math.min(limit, 20))).map(toProductCard);
  }

  async related(slug: string, limit = 8): Promise<ProductCardResponse[]> {
    return this.cache.getOrSet(PRODUCT_CACHE.related, `${slug}:${limit}`, async () => {
      const p = await this.repo.findDetailBySlug(slug, true);
      if (!p) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
      return (await this.repo.related(p, limit)).map(toProductCard);
    });
  }

  async filters(): Promise<ProductFiltersResponse> {
    return this.cache.getOrSet(PRODUCT_CACHE.filters, 'all', async () => {
      const [facets, colorMap] = await Promise.all([this.repo.filterFacets(), this.catalog.colorMap()]);
      const colors = facets.colors.map((code) => colorMap.get(code) ?? { code, name: code, hex: null }).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
      return {
        colors: colors.map((c) => ({ code: c.code, name: c.name, hex: c.hex, imageUrl: null })),
        sizes: sortSizes(facets.sizes),
        priceRange: { min: money(facets.min), max: money(facets.max) },
      };
    });
  }

  /* Ghi sau commit của mọi thay đổi sản phẩm/biến thể/ảnh; tồn kho chỉ cần xoá chi tiết. */
  async invalidateAll(): Promise<void> {
    await Promise.all([this.cache.delByPrefix(PRODUCT_CACHE.list), this.cache.delByPrefix(PRODUCT_CACHE.detail), this.cache.delByPrefix(PRODUCT_CACHE.filters), this.cache.delByPrefix(PRODUCT_CACHE.related)]);
  }

  async invalidateDetail(slug: string): Promise<void> {
    await this.cache.del(PRODUCT_CACHE.detail, slug);
  }
}
