import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { CatalogQueryApi } from '../../catalog/queryapi/catalog.queryapi';
import { ShopQueryApi } from '../../shop/queryapi/shop.queryapi';
import { ProductCardResponse } from '../product/dto/product.responses';
import { toProductCard } from '../product/mapper/product.mapper';
import { ProductRepository } from '../product/repository/product.repository';
import { dynamicColorSize } from './variant-label';

export type { ProductCardResponse } from '../product/dto/product.responses';

/* Snapshot biến thể cho giỏ/đơn — module khác chép vào chứng từ, không giữ tham chiếu sống. */
export interface VariantSnapshot {
  variantId: string;
  productId: string;
  slug: string;
  name: string;
  categorySlug: string;
  imageUrl: string | null;
  /* Legacy_fashion: tên màu / mã size. Dynamic (không có color/size): quy ước ở queryapi/variant-label.ts — color = giá trị trục
     "màu" (hoặc trục đầu), size = các trục còn lại nối " / " — để dòng giỏ/đơn KHÔNG bao giờ hiện trống. */
  color: string;
  colorCode: string;
  size: string;
  sku: string;
  /* Giá bán hiện tại (VND, chuỗi số nguyên) — order chốt vào dòng đơn lúc đặt. */
  unitPrice: string;
  available: number;
  isSellable: boolean;
  shopId: string;
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
    private readonly catalog: CatalogQueryApi,
    private readonly shops: ShopQueryApi,
  ) {}

  /*
   * Mọi đường ĐỌC dành cho khách (AI chatbot/gợi ý/tìm ảnh/thử đồ, wishlist, đánh giá của tôi) chỉ trả hàng của shop đã duyệt:
   * shop bị khoá/chờ duyệt phải biến mất khỏi mọi nơi, không chỉ ở danh sách công khai. Biến thể/giỏ/đơn KHÔNG qua đây
   * (đơn cũ vẫn phải đọc được).
   */
  private hiddenShopIds(): Promise<string[]> {
    return this.shops.nonApprovedShopIds();
  }

  /*
   * Snapshot biến thể cho cart/order/promotion. Biến thể ngành dynamic không có colorName/sizeCode → color/size dựng từ
   * ProductVariantOption (tên thuộc tính tra MỘT lần theo lô, không N+1): color "Đen", size "128GB" → giỏ/đơn hiện
   * "Đen / 128GB" cho vendor đóng gói, thay vì chuỗi rỗng ("()", "/").
   */
  async variantSnapshots(variantIds: string[]): Promise<Map<string, VariantSnapshot>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.prisma.productVariant.findMany({
      where: { id: { in: [...new Set(variantIds)] }, isDeleted: false },
      select: {
        id: true,
        sku: true,
        shopId: true,
        colorCode: true,
        colorName: true,
        sizeCode: true,
        price: true,
        stock: true,
        reserved: true,
        isActive: true,
        options: { select: { attributeId: true, displayValue: true } },
        product: { select: { id: true, slug: true, name: true, categorySlug: true, basePrice: true, status: true, isDeleted: true, images: { orderBy: [{ sortOrder: 'asc' }], select: { url: true, colorCode: true, isPrimary: true } } } },
      },
    });
    const attrIds = [...new Set(rows.flatMap((v) => v.options.map((o) => o.attributeId)))];
    const attrCodes = attrIds.length > 0 ? await this.catalog.findDynamicAttributeNamesByIds(attrIds) : new Map<string, { id: string; code: string; name: string }>();
    return new Map(
      rows.map((v) => {
        const dyn = v.options.length > 0 ? dynamicColorSize(v.options, attrCodes) : null;
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
            color: dyn ? dyn.color : (v.colorName ?? ''),
            colorCode: v.colorCode ?? '',
            size: dyn ? dyn.size : (v.sizeCode ?? ''),
            sku: v.sku,
            unitPrice: (v.price ?? v.product.basePrice).toString(),
            available: Math.max(0, v.stock - v.reserved),
            isSellable: v.isActive && !v.product.isDeleted && v.product.status === 'active',
            shopId: v.shopId,
          },
        ];
      }),
    );
  }

  async cardsByIds(productIds: string[]): Promise<ProductCardResponse[]> {
    const rows = await this.repo.findCardsByIds(productIds, true, await this.hiddenShopIds());
    const rank = new Map(productIds.map((id, i) => [id, i]));
    return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)).map((p) => toProductCard(p));
  }

  async findProductBrief(productId: string): Promise<{ id: string; slug: string; name: string; status: string; shopId: string } | null> {
    const p = await this.prisma.product.findFirst({ where: { id: productId, isDeleted: false }, select: { id: true, slug: true, name: true, status: true, shopId: true } });
    return p;
  }

  async findProductBriefBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string; shopId: string } | null> {
    return this.prisma.product.findFirst({ where: { slug, isDeleted: false }, select: { id: true, slug: true, name: true, status: true, shopId: true } });
  }

  /* Tìm theo từ khoá (tsvector + trigram) — cho chatbot đường lùi. */
  async searchCards(q: string, limit = 6): Promise<ProductCardResponse[]> {
    return (await this.repo.suggest(q, limit, await this.hiddenShopIds())).map((p) => toProductCard(p));
  }

  /* Gợi ý theo tiêu chí (AI style-analysis / chatbot): giới, ngành hàng, màu, giá tối đa, mới — chỉ sản phẩm đang bán. */
  async recommend(f: { gender?: string | null; categorySlugs?: string[]; colorCodes?: string[]; maxPrice?: bigint; isNew?: boolean; excludeIds?: string[]; limit?: number }): Promise<ProductCardResponse[]> {
    const hidden = await this.hiddenShopIds();
    const where: Prisma.ProductWhereInput = {
      isDeleted: false,
      status: 'active',
      ...(hidden.length > 0 ? { shopId: { notIn: hidden } } : {}),
      ...(f.gender ? { gender: { in: [f.gender, 'unisex'] } } : {}),
      ...(f.categorySlugs && f.categorySlugs.length > 0 ? { categorySlug: { in: f.categorySlugs } } : {}),
      ...(f.maxPrice !== undefined ? { basePrice: { lte: new Prisma.Decimal(f.maxPrice.toString()) } } : {}),
      ...(f.isNew ? { isNew: true } : {}),
      ...(f.excludeIds && f.excludeIds.length > 0 ? { id: { notIn: f.excludeIds } } : {}),
      ...(f.colorCodes && f.colorCodes.length > 0 ? { variants: { some: { isDeleted: false, isActive: true, colorCode: { in: f.colorCodes } } } } : {}),
    };
    const rows = await this.repo.findCardsWhere(where, f.limit ?? 8);
    return rows.map((p) => toProductCard(p));
  }

  /* Ảnh sản phẩm cho thử đồ 2D: ảnh theo màu (nếu có) hoặc ảnh chính; kèm ngành hàng để chọn vùng (áo/quần/váy). */
  async garmentForTryOn(productId: string, colorCode?: string | null): Promise<{ id: string; name: string; slug: string; categorySlug: string; gender: string; imageUrl: string } | null> {
    const hidden = await this.hiddenShopIds();
    const p = await this.prisma.product.findFirst({ where: { id: productId, isDeleted: false, status: 'active', ...(hidden.length > 0 ? { shopId: { notIn: hidden } } : {}) }, select: { id: true, name: true, slug: true, categorySlug: true, gender: true, images: { orderBy: [{ sortOrder: 'asc' }], select: { url: true, colorCode: true, isPrimary: true } } } });
    if (!p) return null;
    const img = (colorCode ? p.images.find((i) => i.colorCode === colorCode) : null) ?? p.images.find((i) => i.isPrimary) ?? p.images[0];
    if (!img) return null;
    return { id: p.id, name: p.name, slug: p.slug, categorySlug: p.categorySlug, gender: p.gender, imageUrl: img.url };
  }

  /* PLAN-0014 bước 5: đọc shopId từ productId (module cart/review gọi khi thêm giỏ/tạo review). */
  async getShopId(productId: string): Promise<string | null> {
    const p = await this.prisma.product.findFirst({
      where: { id: productId, isDeleted: false },
      select: { shopId: true },
    });
    return p?.shopId ?? null;
  }

  /* Chi tiết cho chatbot/so sánh/FAQ: mô tả + biến thể còn hàng — chỉ sản phẩm đang bán, không lộ tồn số.
     PLAN-0016: category.attributeMode="dynamic" không có gender/material/care/colorName/sizeCode — trả thêm
     attributesText/optionsText (chép từ ProductAttributeValue/ProductVariantOption) để AI vẫn mô tả được sản
     phẩm ngoài thời trang (điện thoại, đồ gia dụng, mỹ phẩm…) thay vì thấy chuỗi rỗng. */
  async detailForAi(slug: string, anyStatus = false): Promise<{ id: string; slug: string; name: string; status: string; categorySlug: string; attributeMode: string; gender: string; price: string; listPrice: string | null; shortDescription: string | null; description: string | null; material: string | null; care: string[]; tags: string[]; avgRating: number; reviewCount: number; soldCount: number; imageCount: number; attributesText: string; variants: Array<{ id: string; colorCode: string; colorName: string; sizeCode: string; optionsText: string; price: string; inStock: boolean }>; updatedAt: Date } | null> {
    // `anyStatus` = nhân viên sàn xem mọi trạng thái; khách chỉ thấy hàng đang bán của shop đã duyệt.
    const hidden = anyStatus ? [] : await this.hiddenShopIds();
    const p = await this.prisma.product.findFirst({
      where: { slug, isDeleted: false, ...(anyStatus ? {} : { status: 'active', ...(hidden.length > 0 ? { shopId: { notIn: hidden } } : {}) }) },
      select: {
        id: true, slug: true, name: true, status: true, categoryId: true, categorySlug: true, gender: true, basePrice: true, listPrice: true, shortDescription: true, description: true, material: true, care: true, tags: true, avgRating: true, reviewCount: true, soldCount: true, updatedAt: true, _count: { select: { images: true } },
        variants: { where: { isDeleted: false, isActive: true }, select: { id: true, colorCode: true, colorName: true, sizeCode: true, price: true, stock: true, reserved: true, options: { select: { attributeId: true, displayValue: true } } } },
        attributeValues: { select: { attributeId: true, attributeValueId: true, customValue: true } },
      },
    });
    if (!p) return null;

    const attrIds = [...new Set([...p.attributeValues.map((a) => a.attributeId), ...p.variants.flatMap((v) => v.options.map((o) => o.attributeId))])];
    const valueIds = [...new Set(p.attributeValues.map((a) => a.attributeValueId).filter((id): id is string => Boolean(id)))];
    const [category, names, values] = await Promise.all([
      this.catalog.findCategoryById(p.categoryId),
      attrIds.length > 0 ? this.catalog.findDynamicAttributeNamesByIds(attrIds) : Promise.resolve(new Map<string, { id: string; code: string; name: string }>()),
      valueIds.length > 0 ? this.catalog.findDynamicAttributeValuesByIds(valueIds) : Promise.resolve(new Map<string, { id: string; value: string; attributeId: string }>()),
    ]);
    const attributesText = p.attributeValues.map((a) => `${names.get(a.attributeId)?.name ?? a.attributeId}: ${a.customValue ?? (a.attributeValueId ? (values.get(a.attributeValueId)?.value ?? '') : '')}`).filter((s) => !s.endsWith(': ')).join('; ');

    return {
      id: p.id, slug: p.slug, name: p.name, status: p.status, categorySlug: p.categorySlug, attributeMode: category?.attributeMode ?? 'legacy_fashion', gender: p.gender, price: p.basePrice.toString(), listPrice: p.listPrice?.toString() ?? null,
      shortDescription: p.shortDescription, description: p.description, material: p.material, care: Array.isArray(p.care) ? (p.care as string[]) : [], tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
      avgRating: Number(p.avgRating), reviewCount: p.reviewCount, soldCount: p.soldCount, imageCount: p._count.images, attributesText, updatedAt: p.updatedAt,
      variants: p.variants.map((v) => ({ id: v.id, colorCode: v.colorCode ?? '', colorName: v.colorName ?? '', sizeCode: v.sizeCode ?? '', optionsText: v.options.map((o) => `${names.get(o.attributeId)?.name ?? o.attributeId}: ${o.displayValue}`).join(', '), price: (v.price ?? p.basePrice).toString(), inStock: v.stock - v.reserved > 0 })),
    };
  }

  async detailForAiById(productId: string, anyStatus = false) {
    const p = await this.prisma.product.findFirst({ where: { id: productId, isDeleted: false }, select: { slug: true } });
    return p ? this.detailForAi(p.slug, anyStatus) : null;
  }

  /* Tồn khả dụng theo biến thể của mọi sản phẩm đang bán — ai nhận xét tồn kho. */
  async variantStockSnapshot(): Promise<Array<{ variantId: string; productId: string; productName: string; slug: string; sku: string; label: string; available: number }>> {
    const rows = await this.prisma.productVariant.findMany({ where: { isDeleted: false, isActive: true, product: { isDeleted: false, status: 'active' } }, select: { id: true, productId: true, sku: true, colorName: true, sizeCode: true, stock: true, reserved: true, product: { select: { name: true, slug: true } }, options: { select: { attributeId: true, displayValue: true } } } });
    const attrIds = [...new Set(rows.flatMap((v) => v.options.map((o) => o.attributeId)))];
    const attrCodes = attrIds.length > 0 ? await this.catalog.findDynamicAttributeNamesByIds(attrIds) : new Map<string, { id: string; code: string; name: string }>();
    return rows.map((v) => {
      // Biến thể dynamic không có color/size: nhãn dựng từ các trục (không in "null / null" cho AI).
      const dyn = v.options.length > 0 ? dynamicColorSize(v.options, attrCodes) : null;
      const label = dyn ? [dyn.color, dyn.size].filter(Boolean).join(' / ') : `${v.colorName} / ${v.sizeCode}`;
      return { variantId: v.id, productId: v.productId, productName: v.product.name, slug: v.product.slug, sku: v.sku, label, available: Math.max(0, v.stock - v.reserved) };
    });
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
      select: { id: true, slug: true, name: true, categorySlug: true, gender: true, shortDescription: true, description: true, material: true, tags: true, updatedAt: true, variants: { where: { isDeleted: false, isActive: true }, select: { colorName: true, sizeCode: true, options: { select: { displayValue: true } } } } },
    });
    return rows.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      categorySlug: p.categorySlug,
      gender: p.gender,
      updatedAt: p.updatedAt,
      text: [p.name, p.shortDescription, p.description, p.material ? `Chất liệu: ${p.material}` : null, ...embeddingVariantLines(p.variants)].filter(Boolean).join('\n'),
    }));
  }
}

/*
 * Dòng mô tả biến thể cho text nhúng: thời trang giữ "Màu: … / Size: …"; biến thể ngành dynamic (colorName/sizeCode null)
 * dùng giá trị các trục ("Tuỳ chọn: 128GB, Đen") thay vì in chuỗi rỗng.
 */
function embeddingVariantLines(variants: Array<{ colorName: string | null; sizeCode: string | null; options: Array<{ displayValue: string }> }>): string[] {
  const colors = [...new Set(variants.map((v) => v.colorName).filter(Boolean))];
  const sizes = [...new Set(variants.map((v) => v.sizeCode).filter(Boolean))];
  const options = [...new Set(variants.flatMap((v) => v.options.map((o) => o.displayValue)))];
  return [colors.length > 0 ? `Màu: ${colors.join(', ')}` : '', sizes.length > 0 ? `Size: ${sizes.join(', ')}` : '', options.length > 0 ? `Tuỳ chọn: ${options.join(', ')}` : ''];
}
