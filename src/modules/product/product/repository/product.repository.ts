import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { unaccent } from '@common/utils/slug';
import { Prisma } from '@common/prisma/types';
import { PRODUCT_STATUS, ProductSort } from '../../foundation/product.constants';

/* Phần dữ liệu để dựng THẺ sản phẩm (list) — biến thể + ảnh gộp trong một query, không N+1. */
/* Số ứng viên lấy dư khi gợi ý phải loại hàng của shop bị khoá (searchIds tối đa 500). */
const SUGGEST_OVERFETCH = 100;

export const PRODUCT_CARD_SELECT = {
  id: true,
  shopId: true,
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
  variants: { where: { isDeleted: false }, select: { id: true, sku: true, colorCode: true, colorName: true, colorHex: true, sizeCode: true, price: true, stock: true, reserved: true, isActive: true, options: { select: { id: true, attributeId: true, attributeValueId: true, displayValue: true } } } },
  images: { orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }], select: { id: true, url: true, publicId: true, colorCode: true, alt: true, sortOrder: true, isPrimary: true } },
} satisfies Prisma.ProductSelect;

export const PRODUCT_DETAIL_SELECT = {
  ...PRODUCT_CARD_SELECT,
  shortDescription: true,
  description: true,
  material: true,
  care: true,
  viewCount: true,
  attributeValues: { select: { id: true, attributeId: true, attributeValueId: true, customValue: true } },
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
  /* PLAN-0014: lọc theo shopId (vendor quản lý riêng shop mình) */
  shopId?: string;
  /* Công khai: bỏ hàng của các shop không được bán (chờ duyệt/khoá). Bị `shopId` ghi đè khi đã chọn một shop cụ thể. */
  excludeShopIds?: string[];
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

  /* `excludeShopIds`: shop không được bán công khai (chờ duyệt/khoá) — chỉ truyền khi `publicOnly`. */
  async findCardsByIds(ids: string[], publicOnly: boolean, excludeShopIds: string[] = []): Promise<ProductCardRow[]> {
    if (ids.length === 0) return [];
    return this.prisma.product.findMany({
      where: { id: { in: ids }, isDeleted: false, ...(publicOnly ? { status: PRODUCT_STATUS.ACTIVE } : {}), ...(excludeShopIds.length > 0 ? { shopId: { notIn: excludeShopIds } } : {}) },
      select: PRODUCT_CARD_SELECT,
    });
  }

  async slugExists(slug: string, exceptId?: string, tx?: Tx | null): Promise<boolean> {
    return (await this.db(tx).product.count({ where: { slug, isDeleted: false, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
  }

  async create(data: Prisma.ProductUncheckedCreateInput & { shopId: string }, tx?: Tx | null): Promise<ProductDetailRow> {
    return this.db(tx).product.create({ data, select: PRODUCT_DETAIL_SELECT });
  }

  async update(id: string, data: Prisma.ProductUncheckedUpdateInput, tx?: Tx | null): Promise<ProductDetailRow> {
    return this.db(tx).product.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: PRODUCT_DETAIL_SELECT });
  }

  /* Id sản phẩm khớp từ khoá: tsvector (tiền tố từng từ) ưu tiên; `word_similarity` pg_trgm bù cho gõ sai/dính chữ (aothun, quan jen). Giới hạn 500.
     `scope` (shop/trạng thái/ngành) PHẢI đi vào chính câu SQL này: lọc sau khi đã cắt 500 id toàn sàn thì từ khoá chung chung
     ("áo") làm sản phẩm của một shop nhỏ rơi khỏi top 500 và biến mất khỏi danh sách của chính vendor. */
  async searchIds(q: string, publicOnly: boolean, scope: { shopId?: string; status?: string; categorySlug?: string } = {}): Promise<string[]> {
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
        ${scope.shopId ? Prisma.sql`AND shop_id = ${scope.shopId}::uuid` : Prisma.empty}
        ${!publicOnly && scope.status ? Prisma.sql`AND status = ${scope.status}` : Prisma.empty}
        ${scope.categorySlug ? Prisma.sql`AND category_slug = ${scope.categorySlug}` : Prisma.empty}
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
      // minPrice và maxPrice cùng một khoá `basePrice` — phải gộp, spread riêng sẽ để maxPrice đè mất minPrice.
      ...(f.minPrice !== undefined || f.maxPrice !== undefined
        ? { basePrice: { ...(f.minPrice !== undefined ? { gte: new Prisma.Decimal(f.minPrice.toString()) } : {}), ...(f.maxPrice !== undefined ? { lte: new Prisma.Decimal(f.maxPrice.toString()) } : {}) } }
        : {}),
      ...(f.sale ? { listPrice: { not: null } } : {}),
      ...(f.tag ? { tags: { array_contains: [f.tag] } } : {}),
      ...(f.size || f.color
        ? { variants: { some: { isDeleted: false, isActive: true, ...(f.size ? { sizeCode: f.size } : {}), ...(f.color ? { colorCode: f.color } : {}) } } }
        : {}),
      ...(f.excludeShopIds && f.excludeShopIds.length > 0 ? { shopId: { notIn: f.excludeShopIds } } : {}),
      ...(f.shopId ? { shopId: f.shopId } : {}),
    };
  }

  /* Số sản phẩm đang bán + tổng lượt đánh giá (cộng reviewCount đã đếm sẵn trên từng sản phẩm) theo shop — cho trang gian hàng công khai. */
  async shopStats(shopIds: string[]): Promise<Map<string, { productCount: number; reviewCount: number }>> {
    if (shopIds.length === 0) return new Map();
    const rows = await this.prisma.product.groupBy({
      by: ['shopId'],
      where: { shopId: { in: shopIds }, isDeleted: false, status: PRODUCT_STATUS.ACTIVE },
      _count: { _all: true },
      _sum: { reviewCount: true },
    });
    return new Map(rows.map((r) => [r.shopId, { productCount: r._count._all, reviewCount: r._sum.reviewCount ?? 0 }]));
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
      searchIds = await this.searchIds(f.q, f.publicOnly, { shopId: f.shopId, status: f.status, categorySlug: f.categorySlug });
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

  /* Có `excludeShopIds` thì lấy dư theo độ khớp rồi mới cắt `limit` — loại hàng shop bị khoá không làm hụt kết quả. */
  async suggest(q: string, limit: number, excludeShopIds: string[] = []): Promise<ProductCardRow[]> {
    const ids = (await this.searchIds(q, true)).slice(0, excludeShopIds.length > 0 ? SUGGEST_OVERFETCH : limit);
    const rows = await this.findCardsByIds(ids, true, excludeShopIds);
    const rank = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)).slice(0, limit);
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
  /* `excludeShopIds`: shop không được bán công khai (chờ duyệt/khoá) — màu/size/khoảng giá không được lẫn hàng của họ. */
  async filterFacets(excludeShopIds: string[] = []): Promise<{ min: string; max: string; colors: string[]; sizes: string[] }> {
    const shopFilter = excludeShopIds.length > 0 ? { shopId: { notIn: excludeShopIds } } : {};
    const [agg, colors, sizes] = await Promise.all([
      this.prisma.product.aggregate({ where: { isDeleted: false, status: PRODUCT_STATUS.ACTIVE, ...shopFilter }, _min: { basePrice: true }, _max: { basePrice: true } }),
      this.prisma.productVariant.findMany({ where: { isDeleted: false, isActive: true, product: { isDeleted: false, status: PRODUCT_STATUS.ACTIVE, ...shopFilter } }, distinct: ['colorCode'], select: { colorCode: true } }),
      this.prisma.productVariant.findMany({ where: { isDeleted: false, isActive: true, product: { isDeleted: false, status: PRODUCT_STATUS.ACTIVE, ...shopFilter } }, distinct: ['sizeCode'], select: { sizeCode: true } }),
    ]);
    return {
      min: agg._min.basePrice?.toString() ?? '0',
      max: agg._max.basePrice?.toString() ?? '0',
      colors: colors.map((c) => c.colorCode).filter((c): c is string => !!c),
      sizes: sizes.map((s) => s.sizeCode).filter((s): s is string => !!s),
    };
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
    return this.db(tx).productVariant.findFirst({ where: { id, isDeleted: false }, select: { id: true, productId: true, sku: true, colorCode: true, colorName: true, colorHex: true, sizeCode: true, price: true, stock: true, reserved: true, isActive: true, options: { select: { id: true, attributeId: true, attributeValueId: true, displayValue: true } } } });
  }

  /* SKU đã có trong CÙNG gian hàng chưa (chỉ biến thể sống) — khớp index partial uq_product_variants_shop_sku_active.
     Hai shop được trùng SKU nên KHÔNG kiểm toàn sàn. */
  async skuExists(shopId: string, sku: string, exceptId?: string, tx?: Tx | null): Promise<boolean> {
    return (await this.db(tx).productVariant.count({ where: { shopId, sku, isDeleted: false, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
  }

  /* Biến thể sống của gian hàng có SKU nằm trong `exact` hoặc bắt đầu bằng `prefix` — một query cho cả kiểm trùng SKU vendor
     nhập lẫn dò chỗ trống để sinh SKU (không hỏi DB từng SKU). */
  async findShopSkus(shopId: string, q: { exact?: string[]; prefix?: string }, tx?: Tx | null): Promise<Array<{ id: string; sku: string; productId: string }>> {
    const or: Prisma.ProductVariantWhereInput[] = [];
    if (q.exact && q.exact.length > 0) or.push({ sku: { in: q.exact } });
    if (q.prefix) or.push({ sku: { startsWith: q.prefix } });
    if (or.length === 0) return [];
    return this.db(tx).productVariant.findMany({ where: { shopId, isDeleted: false, OR: or }, select: { id: true, sku: true, productId: true } });
  }

  /* Trong các slug ứng viên, những slug ĐÃ có sản phẩm chưa xoá — dựng hậu tố -2, -3… khi trùng tên chung (slug unique toàn sàn). */
  async findExistingSlugs(slugs: string[], tx?: Tx | null): Promise<string[]> {
    if (slugs.length === 0) return [];
    const rows = await this.db(tx).product.findMany({ where: { slug: { in: slugs }, isDeleted: false }, select: { slug: true } });
    return rows.map((r) => r.slug);
  }

  /* Khoá hàng sản phẩm (FOR UPDATE) — tuần tự hoá hai lần lưu biến thể/thuộc tính đồng thời của CÙNG sản phẩm: kế hoạch
     (khớp biến thể cũ ↔ mới) dựng từ trạng thái đã khoá nên không ghi chồng lên nhau. */
  async lockProduct(productId: string, tx: Tx): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "product"."products" WHERE id = ${productId}::uuid FOR UPDATE`;
  }

  /* Khoá các biến thể sắp gỡ rồi đọc tồn/giữ hàng MỚI NHẤT: đơn đang giữ hàng (reserve) cũng khoá dòng này nên không có
     chuyện kiểm reserved = 0 xong mà đơn chen vào giữ hàng trước khi xoá mềm. */
  async lockVariants(ids: string[], tx: Tx): Promise<Array<{ id: string; sku: string; stock: number; reserved: number }>> {
    if (ids.length === 0) return [];
    return tx.$queryRaw<Array<{ id: string; sku: string; stock: number; reserved: number }>>`
      SELECT id, sku, stock, reserved FROM "product"."product_variants"
      WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) AND is_deleted = false
      FOR UPDATE`;
  }

  /* Phiếu nhập NHÁP đang trỏ tới các biến thể — gỡ biến thể thì phiếu không duyệt được nữa. */
  async findDraftReceiptRefs(variantIds: string[], tx: Tx): Promise<Array<{ variantId: string; receiptCode: string }>> {
    if (variantIds.length === 0) return [];
    const rows = await tx.stockReceiptItem.findMany({
      where: { variantId: { in: variantIds }, receipt: { status: 'draft', isDeleted: false } },
      select: { variantId: true, receipt: { select: { code: true } } },
    });
    return rows.map((r) => ({ variantId: r.variantId, receiptCode: r.receipt.code }));
  }

  async upsertVariant(productId: string, shopId: string, v: { sku: string; colorCode: string; colorName: string; colorHex: string | null; sizeCode: string; price: bigint | null; isActive: boolean }, actorId: string | null, tx: Tx): Promise<VariantRow> {
    return tx.productVariant.upsert({
      where: { productId_colorCode_sizeCode: { productId, colorCode: v.colorCode, sizeCode: v.sizeCode } },
      create: { productId, shopId, sku: v.sku, colorCode: v.colorCode, colorName: v.colorName, colorHex: v.colorHex, sizeCode: v.sizeCode, price: v.price === null ? null : new Prisma.Decimal(v.price.toString()), isActive: v.isActive, createdBy: actorId, updatedBy: actorId },
      update: { sku: v.sku, colorName: v.colorName, colorHex: v.colorHex, price: v.price === null ? null : new Prisma.Decimal(v.price.toString()), isActive: v.isActive, isDeleted: false, updatedBy: actorId, version: { increment: 1 } },
      select: { id: true, sku: true, colorCode: true, colorName: true, colorHex: true, sizeCode: true, price: true, stock: true, reserved: true, isActive: true, options: { select: { id: true, attributeId: true, attributeValueId: true, displayValue: true } } },
    });
  }

  /* PLAN-0016: tạo biến thể MỚI cho category.attributeMode="dynamic" (không dùng color/size, thay vào là options) —
     chỉ gọi cho tổ hợp trục CHƯA có; tổ hợp đã có đi qua updateVariantDynamic để giữ id/tồn kho/giữ hàng.
     displayValue đã được service lớp trên snapshot sẵn (qua CatalogQueryApi) — repository chỉ ghi, không tự
     đọc bảng DynamicAttributeValue (giữ đúng ranh giới schema catalog/product). Tồn đầu = 0 (nhập kho qua phiếu). */
  async createVariantDynamic(productId: string, shopId: string, v: { sku: string; options: Array<{ attributeId: string; attributeValueId: string; displayValue: string }>; price: bigint | null; isActive: boolean }, actorId: string | null, tx: Tx): Promise<VariantRow> {
    return tx.productVariant.create({
      data: {
        productId,
        shopId,
        sku: v.sku,
        colorCode: null,
        colorName: null,
        colorHex: null,
        sizeCode: null,
        price: v.price === null ? null : new Prisma.Decimal(v.price.toString()),
        isActive: v.isActive,
        createdBy: actorId,
        updatedBy: actorId,
        // Tối đa 2 dòng option/biến thể (service đã kiểm) — tạo lồng nhau, một câu lệnh.
        options: { create: v.options.map((o) => ({ attributeId: o.attributeId, attributeValueId: o.attributeValueId, displayValue: o.displayValue })) },
      },
      select: { id: true, sku: true, colorCode: true, colorName: true, colorHex: true, sizeCode: true, price: true, stock: true, reserved: true, isActive: true, options: { select: { id: true, attributeId: true, attributeValueId: true, displayValue: true } } },
    });
  }

  /* Cập nhật biến thể dynamic ĐÃ CÓ (khớp theo tổ hợp trục): chỉ đổi SKU/giá/bật-tắt — KHÔNG đụng stock/reserved/options. */
  async updateVariantDynamic(id: string, v: { sku: string; price: bigint | null; isActive: boolean }, actorId: string | null, tx: Tx): Promise<VariantRow> {
    return tx.productVariant.update({
      where: { id },
      data: { sku: v.sku, price: v.price === null ? null : new Prisma.Decimal(v.price.toString()), isActive: v.isActive, updatedBy: actorId, version: { increment: 1 } },
      select: { id: true, sku: true, colorCode: true, colorName: true, colorHex: true, sizeCode: true, price: true, stock: true, reserved: true, isActive: true, options: { select: { id: true, attributeId: true, attributeValueId: true, displayValue: true } } },
    });
  }

  /* Xoá mềm đúng các biến thể được chỉ định (đã khoá + kiểm reserved/phiếu nháp ở service). */
  async softDeleteVariants(ids: string[], actorId: string | null, tx: Tx): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await tx.productVariant.updateMany({ where: { id: { in: ids }, isDeleted: false }, data: { isDeleted: true, isActive: false, updatedBy: actorId } });
    return r.count;
  }

  /* Xoá mềm MỌI biến thể không nằm trong keepIds — dùng khi xoá cả sản phẩm (keepIds = []). */
  async softDeleteVariantsNotIn(productId: string, keepIds: string[], actorId: string, tx: Tx): Promise<number> {
    const r = await tx.productVariant.updateMany({ where: { productId, isDeleted: false, id: { notIn: keepIds } }, data: { isDeleted: true, isActive: false, updatedBy: actorId } });
    return r.count;
  }

  // -------------------------------------------------------------- thuộc tính cấp sản phẩm (PLAN-0016)

  /* Thay TOÀN BỘ giá trị thuộc tính cấp sản phẩm (service đã validate theo mẫu ngành, không trùng attributeId). */
  async replaceAttributeValues(productId: string, rows: Array<{ attributeId: string; attributeValueId: string | null; customValue: string | null }>, tx: Tx): Promise<void> {
    await tx.productAttributeValue.deleteMany({ where: { productId } });
    if (rows.length > 0) await tx.productAttributeValue.createMany({ data: rows.map((r) => ({ productId, attributeId: r.attributeId, attributeValueId: r.attributeValueId, customValue: r.customValue })) });
  }

  /* Gỡ giá trị thuộc tính không còn thuộc mẫu của ngành mới (khi đổi ngành lúc chưa có biến thể). */
  async deleteAttributeValuesNotIn(productId: string, keepAttributeIds: string[], tx: Tx): Promise<number> {
    const r = await tx.productAttributeValue.deleteMany({ where: { productId, attributeId: { notIn: keepAttributeIds } } });
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
