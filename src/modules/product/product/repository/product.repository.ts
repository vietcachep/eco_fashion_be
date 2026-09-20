import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { unaccent } from '@common/utils/slug';
import { Prisma } from '@common/prisma/types';
import { PRODUCT_STATUS, ProductSort } from '../../foundation/product.constants';

/* Phần dữ liệu để dựng THẺ sản phẩm (list) — biến thể + ảnh gộp trong một query, không N+1. */
export const PRODUCT_CARD_SELECT = {
  id: true,
  slug: true,
  name: true,
  categoryId: true,
  categorySlug: true,
  gender: true,
  basePrice: true,
  listPrice: true,
  status: true,
  isNew: true,
  isFeatured: true,
  tags: true,
  soldCount: true,
  reviewCount: true,
  avgRating: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  variants: { where: { isDeleted: false }, select: { id: true, sku: true, colorCode: true, colorName: true, colorHex: true, sizeCode: true, price: true, stock: true, reserved: true, isActive: true } },
  images: { orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }], select: { id: true, url: true, publicId: true, colorCode: true, alt: true, sortOrder: true, isPrimary: true } },
} satisfies Prisma.ProductSelect;

export const PRODUCT_DETAIL_SELECT = {
  ...PRODUCT_CARD_SELECT,
  shortDescription: true,
  description: true,
  material: true,
  care: true,
  viewCount: true,
} satisfies Prisma.ProductSelect;

export type ProductCardRow = Prisma.ProductGetPayload<{ select: typeof PRODUCT_CARD_SELECT }>;
export type ProductDetailRow = Prisma.ProductGetPayload<{ select: typeof PRODUCT_DETAIL_SELECT }>;
export type VariantRow = ProductCardRow['variants'][number];
export type ImageRow = ProductCardRow['images'][number];

export interface ProductListFilter {
  q?: string;
  categorySlug?: string;
  categorySlugs?: string[];
  gender?: string;
  size?: string;
  color?: string;
  minPrice?: bigint;
  maxPrice?: bigint;
  sale?: boolean;
  tag?: string;
  sort?: ProductSort;
  /* Quản trị: mọi trạng thái; công khai: chỉ active. */
  status?: string;
  publicOnly: boolean;
}

/*
 * Bảng product.products (+variants, images). Tìm kiếm: `q` → tsvector (unaccent, simple) HOẶC trigram trên tên
 * (gõ sai) — lấy id bằng SQL thô rồi lọc/sắp bằng Prisma để giữ một đường truy vấn; list công khai chỉ `active`.
 */
@Injectable()
export class ProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async findDetailBySlug(slug: string, publicOnly: boolean, tx?: Tx | null): Promise<ProductDetailRow | null> {
    return this.db(tx).product.findFirst({ where: { slug, isDeleted: false, ...(publicOnly ? { status: PRODUCT_STATUS.ACTIVE } : {}) }, select: PRODUCT_DETAIL_SELECT });
  }

  async findDetailById(id: string, tx?: Tx | null): Promise<ProductDetailRow | null> {
    return this.db(tx).product.findFirst({ where: { id, isDeleted: false }, select: PRODUCT_DETAIL_SELECT });
  }

  /* Cho QueryApi.recommend: where đã dựng sẵn, sắp theo nổi bật/bán chạy. */
  async findCardsWhere(where: Prisma.ProductWhereInput, take: number): Promise<ProductCardRow[]> {
    return this.prisma.product.findMany({ where, orderBy: this.orderBy(undefined), take, select: PRODUCT_CARD_SELECT });
  }

  async findCardsByIds(ids: string[], publicOnly: boolean): Promise<ProductCardRow[]> {
    if (ids.length === 0) return [];
    return this.prisma.product.findMany({ where: { id: { in: ids }, isDeleted: false, ...(publicOnly ? { status: PRODUCT_STATUS.ACTIVE } : {}) }, select: PRODUCT_CARD_SELECT });
  }

  async slugExists(slug: string, exceptId?: string, tx?: Tx | null): Promise<boolean> {
    return (await this.db(tx).product.count({ where: { slug, isDeleted: false, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
  }

  async create(data: Prisma.ProductUncheckedCreateInput, tx?: Tx | null): Promise<ProductDetailRow> {
    return this.db(tx).product.create({ data, select: PRODUCT_DETAIL_SELECT });
  }

  async update(id: string, data: Prisma.ProductUncheckedUpdateInput, tx?: Tx | null): Promise<ProductDetailRow> {
    return this.db(tx).product.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: PRODUCT_DETAIL_SELECT });
  }

  /* Id sản phẩm khớp từ khoá: tsvector (tiền tố từng từ) ưu tiên; `word_similarity` pg_trgm bù cho gõ sai/dính chữ (aothun, quan jen). Giới hạn 500. */
  async searchIds(q: string, publicOnly: boolean): Promise<string[]> {
    const term = unaccent(q.trim().toLowerCase()).slice(0, 100);
    if (!term) return [];
    const tsq = term
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[^a-z0-9]/g, ''))
      .filter(Boolean)
      .map((w) => `${w}:*`)
      .join(' & ');
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "product"."products"
      WHERE is_deleted = false ${publicOnly ? Prisma.sql`AND status = 'active'` : Prisma.empty}
        AND (${tsq ? Prisma.sql`search_vector @@ to_tsquery('simple', ${tsq})` : Prisma.sql`false`}
             OR word_similarity(${term}, public.f_unaccent(lower(name))) > 0.45)
      ORDER BY ${tsq ? Prisma.sql`ts_rank(search_vector, to_tsquery('simple', ${tsq})) DESC,` : Prisma.empty}
               word_similarity(${term}, public.f_unaccent(lower(name))) DESC
      LIMIT 500`;
    return rows.map((r) => r.id);
  }

  buildWhere(f: ProductListFilter, searchIds?: string[]): Prisma.ProductWhereInput {
    return {
      isDeleted: false,
      ...(f.publicOnly ? { status: PRODUCT_STATUS.ACTIVE } : f.status ? { status: f.status } : {}),
      ...(searchIds ? { id: { in: searchIds } } : {}),
      ...(f.categorySlug ? { categorySlug: f.categorySlug } : {}),
      ...(f.categorySlugs && f.categorySlugs.length > 0 ? { categorySlug: { in: f.categorySlugs } } : {}),
      ...(f.gender ? { gender: f.gender } : {}),
      ...(f.minPrice !== undefined ? { basePrice: { gte: new Prisma.Decimal(f.minPrice.toString()) } } : {}),
      ...(f.maxPrice !== undefined ? { basePrice: { lte: new Prisma.Decimal(f.maxPrice.toString()) } } : {}),
      ...(f.sale ? { listPrice: { not: null } } : {}),
      ...(f.tag ? { tags: { array_contains: [f.tag] } } : {}),
      ...(f.size || f.color
        ? { variants: { some: { isDeleted: false, isActive: true, ...(f.size ? { sizeCode: f.size } : {}), ...(f.color ? { colorCode: f.color } : {}) } } }
        : {}),
    };
  }

  private orderBy(sort: ProductSort | undefined): Prisma.ProductOrderByWithRelationInput[] {
    switch (sort) {
      case 'newest':
        return [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
      case 'bestselling':
        return [{ soldCount: 'desc' }, { publishedAt: 'desc' }];
      case 'priceAsc':
        return [{ basePrice: 'asc' }, { name: 'asc' }];
      case 'priceDesc':
        return [{ basePrice: 'desc' }, { name: 'asc' }];
      default:
        return [{ isFeatured: 'desc' }, { soldCount: 'desc' }, { publishedAt: 'desc' }];
    }
  }

  async list(f: ProductListFilter, skip: number, take: number): Promise<{ items: ProductCardRow[]; total: number }> {
    let searchIds: string[] | undefined;
    if (f.q) {
      searchIds = await this.searchIds(f.q, f.publicOnly);
      if (searchIds.length === 0) return { items: [], total: 0 };
    }
    const where = this.buildWhere(f, searchIds);
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy: this.orderBy(f.sort), skip, take, select: PRODUCT_CARD_SELECT }),
      this.prisma.product.count({ where }),
    ]);
    if (searchIds && !f.sort) {
      // Có từ khoá mà không chọn sort → giữ thứ tự độ khớp
      const rank = new Map(searchIds.map((id, i) => [id, i]));
      items.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    }
    return { items, total };
  }

  async suggest(q: string, limit: number): Promise<ProductCardRow[]> {
    const ids = (await this.searchIds(q, true)).slice(0, limit);
    const rows = await this.findCardsByIds(ids, true);
    const rank = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }

  async related(product: { id: string; categorySlug: string; gender: string }, limit: number): Promise<ProductCardRow[]> {
    return this.prisma.product.findMany({
      where: { isDeleted: false, status: PRODUCT_STATUS.ACTIVE, id: { not: product.id }, categorySlug: product.categorySlug },
      orderBy: [{ soldCount: 'desc' }, { publishedAt: 'desc' }],
      take: limit,
      select: PRODUCT_CARD_SELECT,
    });
  }

  /* Khoảng giá + màu/size đang có hàng — cho bộ lọc. */
  async filterFacets(): Promise<{ min: string; max: string; colors: string[]; sizes: string[] }> {
    const [agg, colors, sizes] = await Promise.all([
      this.prisma.product.aggregate({ where: { isDeleted: false, status: PRODUCT_STATUS.ACTIVE }, _min: { basePrice: true }, _max: { basePrice: true } }),
      this.prisma.productVariant.findMany({ where: { isDeleted: false, isActive: true, product: { isDeleted: false, status: PRODUCT_STATUS.ACTIVE } }, distinct: ['colorCode'], select: { colorCode: true } }),
      this.prisma.productVariant.findMany({ where: { isDeleted: false, isActive: true, product: { isDeleted: false, status: PRODUCT_STATUS.ACTIVE } }, distinct: ['sizeCode'], select: { sizeCode: true } }),
    ]);
    return { min: agg._min.basePrice?.toString() ?? '0', max: agg._max.basePrice?.toString() ?? '0', colors: colors.map((c) => c.colorCode), sizes: sizes.map((s) => s.sizeCode) };
  }

  async countByCategory(categoryId: string, status: string): Promise<number> {
    return this.prisma.product.count({ where: { categoryId, status, isDeleted: false } });
  }

  async updateCategorySlug(categoryId: string, slug: string): Promise<number> {
    const r = await this.prisma.product.updateMany({ where: { categoryId, isDeleted: false }, data: { categorySlug: slug } });
    return r.count;
  }

  // -------------------------------------------------------------- variants

  async findVariant(id: string, tx?: Tx | null): Promise<(VariantRow & { productId: string }) | null> {
    return this.db(tx).productVariant.findFirst({ where: { id, isDeleted: false }, select: { id: true, productId: true, sku: true, colorCode: true, colorName: true, colorHex: true, sizeCode: true, price: true, stock: true, reserved: true, isActive: true } });
  }

  async skuExists(sku: string, exceptId?: string, tx?: Tx | null): Promise<boolean> {
    return (await this.db(tx).productVariant.count({ where: { sku, isDeleted: false, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
  }

  async upsertVariant(productId: string, v: { sku: string; colorCode: string; colorName: string; colorHex: string | null; sizeCode: string; price: bigint | null; isActive: boolean }, actorId: string | null, tx: Tx): Promise<VariantRow> {
    return tx.productVariant.upsert({
      where: { productId_colorCode_sizeCode: { productId, colorCode: v.colorCode, sizeCode: v.sizeCode } },
      create: { productId, sku: v.sku, colorCode: v.colorCode, colorName: v.colorName, colorHex: v.colorHex, sizeCode: v.sizeCode, price: v.price === null ? null : new Prisma.Decimal(v.price.toString()), isActive: v.isActive, createdBy: actorId, updatedBy: actorId },
      update: { sku: v.sku, colorName: v.colorName, colorHex: v.colorHex, price: v.price === null ? null : new Prisma.Decimal(v.price.toString()), isActive: v.isActive, isDeleted: false, updatedBy: actorId, version: { increment: 1 } },
      select: { id: true, sku: true, colorCode: true, colorName: true, colorHex: true, sizeCode: true, price: true, stock: true, reserved: true, isActive: true },
    });
  }

  async softDeleteVariantsNotIn(productId: string, keepIds: string[], actorId: string, tx: Tx): Promise<number> {
    const r = await tx.productVariant.updateMany({ where: { productId, isDeleted: false, id: { notIn: keepIds } }, data: { isDeleted: true, isActive: false, updatedBy: actorId } });
    return r.count;
  }

  // -------------------------------------------------------------- images

  async addImage(data: { productId: string; url: string; publicId: string | null; colorCode: string | null; alt: string | null; sortOrder: number; isPrimary: boolean; createdBy: string | null }, tx?: Tx | null): Promise<ImageRow> {
    return this.db(tx).productImage.create({ data, select: { id: true, url: true, publicId: true, colorCode: true, alt: true, sortOrder: true, isPrimary: true } });
  }

  async findImage(productId: string, imageId: string, tx?: Tx | null): Promise<ImageRow | null> {
    return this.db(tx).productImage.findFirst({ where: { id: imageId, productId }, select: { id: true, url: true, publicId: true, colorCode: true, alt: true, sortOrder: true, isPrimary: true } });
  }

  async deleteImage(imageId: string, tx?: Tx | null): Promise<void> {
    await this.db(tx).productImage.delete({ where: { id: imageId } });
  }

  async clearPrimary(productId: string, tx: Tx): Promise<void> {
    await tx.productImage.updateMany({ where: { productId, isPrimary: true }, data: { isPrimary: false } });
  }

  async updateImage(imageId: string, data: { sortOrder?: number; isPrimary?: boolean; colorCode?: string | null; alt?: string | null }, tx?: Tx | null): Promise<void> {
    await this.db(tx).productImage.update({ where: { id: imageId }, data });
  }

  async countImages(productId: string, tx?: Tx | null): Promise<number> {
    return this.db(tx).productImage.count({ where: { productId } });
  }
}
