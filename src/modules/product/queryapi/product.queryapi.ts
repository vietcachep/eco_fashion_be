import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { ProductCardResponse } from '../product/dto/product.responses';
import { toProductCard } from '../product/mapper/product.mapper';
import { ProductRepository } from '../product/repository/product.repository';

export type { ProductCardResponse } from '../product/dto/product.responses';

/* Snapshot biến thể cho giỏ/đơn — module khác chép vào chứng từ, không giữ tham chiếu sống. */
export interface VariantSnapshot {
  variantId: string;
  productId: string;
  slug: string;
  name: string;
  categorySlug: string;
  imageUrl: string | null;
  color: string;
  colorCode: string;
  size: string;
  sku: string;
  /* Giá bán hiện tại (VND, chuỗi số nguyên) — order chốt vào dòng đơn lúc đặt. */
  unitPrice: string;
  available: number;
  isSellable: boolean;
}

/*
 * QueryAPI của product — cổng ĐỌC cho cart, order, review, ai, reporting. Thứ DUY NHẤT module khác được import từ product
 * (cùng các gateway ở common). Trả kiểu phẳng, không trả model Prisma.
 */
@Injectable()
export class ProductQueryApi {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ProductRepository,
  ) {}

  async variantSnapshots(variantIds: string[]): Promise<Map<string, VariantSnapshot>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.prisma.productVariant.findMany({
      where: { id: { in: [...new Set(variantIds)] }, isDeleted: false },
      select: {
        id: true,
        sku: true,
        colorCode: true,
        colorName: true,
        sizeCode: true,
        price: true,
        stock: true,
        reserved: true,
        isActive: true,
        product: { select: { id: true, slug: true, name: true, categorySlug: true, basePrice: true, status: true, isDeleted: true, images: { orderBy: [{ sortOrder: 'asc' }], select: { url: true, colorCode: true, isPrimary: true } } } },
      },
    });
    return new Map(
      rows.map((v) => {
        const imgs = v.product.images;
        const img = imgs.find((i) => i.colorCode === v.colorCode) ?? imgs.find((i) => i.isPrimary) ?? imgs[0] ?? null;
        return [
          v.id,
          {
            variantId: v.id,
            productId: v.product.id,
            slug: v.product.slug,
            name: v.product.name,
            categorySlug: v.product.categorySlug,
            imageUrl: img?.url ?? null,
            color: v.colorName,
            colorCode: v.colorCode,
            size: v.sizeCode,
            sku: v.sku,
            unitPrice: (v.price ?? v.product.basePrice).toString(),
            available: Math.max(0, v.stock - v.reserved),
            isSellable: v.isActive && !v.product.isDeleted && v.product.status === 'active',
          },
        ];
      }),
    );
  }

  async cardsByIds(productIds: string[]): Promise<ProductCardResponse[]> {
    const rows = await this.repo.findCardsByIds(productIds, true);
    const rank = new Map(productIds.map((id, i) => [id, i]));
    return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)).map(toProductCard);
  }

  async findProductBrief(productId: string): Promise<{ id: string; slug: string; name: string; status: string } | null> {
    const p = await this.prisma.product.findFirst({ where: { id: productId, isDeleted: false }, select: { id: true, slug: true, name: true, status: true } });
    return p;
  }

  async findProductBriefBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null> {
    return this.prisma.product.findFirst({ where: { slug, isDeleted: false }, select: { id: true, slug: true, name: true, status: true } });
  }

  /* Tìm theo từ khoá (tsvector + trigram) — cho chatbot đường lùi. */
  async searchCards(q: string, limit = 6): Promise<ProductCardResponse[]> {
    return (await this.repo.suggest(q, limit)).map(toProductCard);
  }

  /* Gợi ý theo tiêu chí (AI style-analysis / chatbot): giới, ngành hàng, màu, giá tối đa, mới — chỉ sản phẩm đang bán. */
  async recommend(f: { gender?: string | null; categorySlugs?: string[]; colorCodes?: string[]; maxPrice?: bigint; isNew?: boolean; excludeIds?: string[]; limit?: number }): Promise<ProductCardResponse[]> {
    const where: Prisma.ProductWhereInput = {
      isDeleted: false,
      status: 'active',
      ...(f.gender ? { gender: { in: [f.gender, 'unisex'] } } : {}),
      ...(f.categorySlugs && f.categorySlugs.length > 0 ? { categorySlug: { in: f.categorySlugs } } : {}),
      ...(f.maxPrice !== undefined ? { basePrice: { lte: new Prisma.Decimal(f.maxPrice.toString()) } } : {}),
      ...(f.isNew ? { isNew: true } : {}),
      ...(f.excludeIds && f.excludeIds.length > 0 ? { id: { notIn: f.excludeIds } } : {}),
      ...(f.colorCodes && f.colorCodes.length > 0 ? { variants: { some: { isDeleted: false, isActive: true, colorCode: { in: f.colorCodes } } } } : {}),
    };
    const rows = await this.repo.findCardsWhere(where, f.limit ?? 8);
    return rows.map(toProductCard);
  }

  /* Ảnh sản phẩm cho thử đồ 2D: ảnh theo màu (nếu có) hoặc ảnh chính; kèm ngành hàng để chọn vùng (áo/quần/váy). */
  async garmentForTryOn(productId: string, colorCode?: string | null): Promise<{ id: string; name: string; slug: string; categorySlug: string; gender: string; imageUrl: string } | null> {
    const p = await this.prisma.product.findFirst({ where: { id: productId, isDeleted: false, status: 'active' }, select: { id: true, name: true, slug: true, categorySlug: true, gender: true, images: { orderBy: [{ sortOrder: 'asc' }], select: { url: true, colorCode: true, isPrimary: true } } } });
    if (!p) return null;
    const img = (colorCode ? p.images.find((i) => i.colorCode === colorCode) : null) ?? p.images.find((i) => i.isPrimary) ?? p.images[0];
    if (!img) return null;
    return { id: p.id, name: p.name, slug: p.slug, categorySlug: p.categorySlug, gender: p.gender, imageUrl: img.url };
  }

  /* Chi tiết cho chatbot/so sánh/FAQ: mô tả + biến thể còn hàng — chỉ sản phẩm đang bán, không lộ tồn số. */
  async detailForAi(slug: string, anyStatus = false): Promise<{ id: string; slug: string; name: string; status: string; categorySlug: string; gender: string; price: string; listPrice: string | null; shortDescription: string | null; description: string | null; material: string | null; care: string[]; tags: string[]; avgRating: number; reviewCount: number; soldCount: number; imageCount: number; variants: Array<{ id: string; colorCode: string; colorName: string; sizeCode: string; price: string; inStock: boolean }>; updatedAt: Date } | null> {
    const p = await this.prisma.product.findFirst({
      where: { slug, isDeleted: false, ...(anyStatus ? {} : { status: 'active' }) },
      select: { id: true, slug: true, name: true, status: true, categorySlug: true, gender: true, basePrice: true, listPrice: true, shortDescription: true, description: true, material: true, care: true, tags: true, avgRating: true, reviewCount: true, soldCount: true, updatedAt: true, _count: { select: { images: true } }, variants: { where: { isDeleted: false, isActive: true }, select: { id: true, colorCode: true, colorName: true, sizeCode: true, price: true, stock: true, reserved: true } } },
    });
    if (!p) return null;
    return {
      id: p.id, slug: p.slug, name: p.name, status: p.status, categorySlug: p.categorySlug, gender: p.gender, price: p.basePrice.toString(), listPrice: p.listPrice?.toString() ?? null,
      shortDescription: p.shortDescription, description: p.description, material: p.material, care: Array.isArray(p.care) ? (p.care as string[]) : [], tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
      avgRating: Number(p.avgRating), reviewCount: p.reviewCount, soldCount: p.soldCount, imageCount: p._count.images, updatedAt: p.updatedAt,
      variants: p.variants.map((v) => ({ id: v.id, colorCode: v.colorCode, colorName: v.colorName, sizeCode: v.sizeCode, price: (v.price ?? p.basePrice).toString(), inStock: v.stock - v.reserved > 0 })),
    };
  }

  async detailForAiById(productId: string, anyStatus = false) {
    const p = await this.prisma.product.findFirst({ where: { id: productId, isDeleted: false }, select: { slug: true } });
    return p ? this.detailForAi(p.slug, anyStatus) : null;
  }

  /* Tồn khả dụng theo biến thể của mọi sản phẩm đang bán — ai nhận xét tồn kho. */
  async variantStockSnapshot(): Promise<Array<{ variantId: string; productId: string; productName: string; slug: string; sku: string; label: string; available: number }>> {
    const rows = await this.prisma.productVariant.findMany({ where: { isDeleted: false, isActive: true, product: { isDeleted: false, status: 'active' } }, select: { id: true, productId: true, sku: true, colorName: true, sizeCode: true, stock: true, reserved: true, product: { select: { name: true, slug: true } } } });
    return rows.map((v) => ({ variantId: v.id, productId: v.productId, productName: v.product.name, slug: v.product.slug, sku: v.sku, label: `${v.colorName} / ${v.sizeCode}`, available: Math.max(0, v.stock - v.reserved) }));
  }

  /* Text nhúng của MỘT sản phẩm (worker nhúng lại khi có PRODUCT_PUBLISHED/UPDATED). */
  async embeddingSource(productId: string): Promise<{ id: string; slug: string; name: string; categorySlug: string; gender: string; text: string; updatedAt: Date } | null> {
    const rows = await this.listForEmbedding(1, productId);
    return rows[0] ?? null;
  }

  /* Cho AI: text mô tả để nhúng + gợi ý — không lộ tồn/kho. */
  async listForEmbedding(limit = 500, productId?: string): Promise<Array<{ id: string; slug: string; name: string; categorySlug: string; gender: string; text: string; updatedAt: Date }>> {
    const rows = await this.prisma.product.findMany({
      where: { isDeleted: false, status: 'active', ...(productId ? { id: productId } : {}) },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      select: { id: true, slug: true, name: true, categorySlug: true, gender: true, shortDescription: true, description: true, material: true, tags: true, updatedAt: true, variants: { where: { isDeleted: false, isActive: true }, select: { colorName: true, sizeCode: true } } },
    });
    return rows.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      categorySlug: p.categorySlug,
      gender: p.gender,
      updatedAt: p.updatedAt,
      text: [p.name, p.shortDescription, p.description, p.material ? `Chất liệu: ${p.material}` : null, `Màu: ${[...new Set(p.variants.map((v) => v.colorName))].join(', ')}`, `Size: ${[...new Set(p.variants.map((v) => v.sizeCode))].join(', ')}`].filter(Boolean).join('\n'),
    }));
  }
}
