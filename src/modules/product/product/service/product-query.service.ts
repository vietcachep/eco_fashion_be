import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CacheService } from '@common/cache/cache.service';
import { NotFoundException } from '@common/exception/business.exception';
import { PageResponse } from '@common/response/api-response';
import { money } from '@common/response/money-response';
import { vnd } from '@common/utils/money';
import { CatalogQueryApi } from '../../../catalog/queryapi/catalog.queryapi';
import { ShopBrief, ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { PRODUCT_CACHE, PRODUCT_ERR, ProductSort } from '../../foundation/product.constants';
import { ProductCardResponse, ProductDetailResponse, ProductFiltersResponse } from '../dto/product.responses';
import { resolveAttributeLookup } from '../../queryapi/attribute-lookup';
import { sortSizes, toProductCard, toProductDetail } from '../mapper/product.mapper';
import { ProductRepository, type ProductCardRow } from '../repository/product.repository';

export interface PublicListParams {
  page: number;
  size: number;
  q?: string;
  category?: string;
  /* Slug gian hàng. */
  shop?: string;
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
    private readonly shops: ShopQueryApi,
  ) {}

  /* Batch resolve shopId → ShopBrief MỘT lần cho cả trang — tránh N+1 (mọi kết quả ở đây đã được cache
     Redis nên chi phí này chỉ trả khi cache miss, không phải mỗi request). */
  private async withShops<T extends ProductCardRow>(rows: T[]): Promise<Array<[T, ShopBrief | undefined]>> {
    const briefs = await this.shops.findManyBrief(rows.map((r) => r.shopId));
    return rows.map((r) => [r, briefs.get(r.shopId)]);
  }

  /* Chỉ giữ hàng của shop ĐÃ DUYỆT — ẩn sản phẩm của shop bị khoá/chờ duyệt ở các đường không phân trang theo SQL. */
  private sellable<T extends ProductCardRow>(pairs: Array<[T, ShopBrief | undefined]>): Array<[T, ShopBrief | undefined]> {
    return pairs.filter(([, shop]) => shop?.status === 'approved');
  }

  async list(p: PublicListParams): Promise<PageResponse<ProductCardResponse>> {
    const key = createHash('sha1').update(JSON.stringify(p)).digest('hex').slice(0, 24);
    return this.cache.getOrSet(PRODUCT_CACHE.list, key, async () => {
      let shopId: string | undefined;
      if (p.shop) {
        const shop = await this.shops.findPublicBySlug(p.shop);
        if (!shop) return PageResponse.of<ProductCardResponse>([], p.page, p.size, 0);
        shopId = shop.id;
      }
      const { items, total } = await this.repo.list(
        {
          publicOnly: true,
          shopId,
          excludeShopIds: shopId ? undefined : await this.shops.nonApprovedShopIds(),
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
      const withShops = await this.withShops(items);
      return PageResponse.of(withShops.map(([r, shop]) => toProductCard(r, shop)), p.page, p.size, total);
    });
  }

  async detail(slug: string): Promise<ProductDetailResponse> {
    const cached = await this.cache.getOrSet<ProductDetailResponse | { missing: true }>(PRODUCT_CACHE.detail, slug, async () => {
      const row = await this.repo.findDetailBySlug(slug, true);
      if (!row) return { missing: true };
      const [shop, attrs] = await Promise.all([this.shops.findBrief(row.shopId), resolveAttributeLookup(this.catalog, row)]);
      if (shop?.status !== 'approved') return { missing: true };
      return toProductDetail(row, shop, attrs);
    });
    if ('missing' in cached) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    return cached;
  }

  async byIds(ids: string[]): Promise<ProductCardResponse[]> {
    const rows = await this.repo.findCardsByIds(ids, true);
    const rank = new Map(ids.map((id, i) => [id, i]));
    const sorted = rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const withShops = this.sellable(await this.withShops(sorted));
    return withShops.map(([r, shop]) => toProductCard(r, shop));
  }

  async suggest(q: string, limit: number): Promise<ProductCardResponse[]> {
    const withShops = this.sellable(await this.withShops(await this.repo.suggest(q, Math.min(limit, 20))));
    return withShops.map(([r, shop]) => toProductCard(r, shop));
  }

  async related(slug: string, limit = 8): Promise<ProductCardResponse[]> {
    return this.cache.getOrSet(PRODUCT_CACHE.related, `${slug}:${limit}`, async () => {
      const p = await this.repo.findDetailBySlug(slug, true);
      if (!p) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
      // Sản phẩm gốc của shop không được bán thì "liên quan" cũng 404 như `detail` — không lộ sự tồn tại của slug.
      if ((await this.shops.findBrief(p.shopId))?.status !== 'approved') throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
      const withShops = this.sellable(await this.withShops(await this.repo.related(p, limit)));
      return withShops.map(([r, shop]) => toProductCard(r, shop));
    });
  }

  private nonApproved(): Promise<string[]> {
    return this.shops.nonApprovedShopIds();
  }

  async filters(): Promise<ProductFiltersResponse> {
    return this.cache.getOrSet(PRODUCT_CACHE.filters, 'all', async () => {
      const [facets, colorMap] = await Promise.all([this.nonApproved().then((ids) => this.repo.filterFacets(ids)), this.catalog.colorMap()]);
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
