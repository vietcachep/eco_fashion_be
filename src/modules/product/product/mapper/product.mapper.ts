import { money, moneyOrNull } from '@common/response/money-response';
import { vnd } from '@common/utils/money';
import type { ShopBrief } from '../../../shop/queryapi/shop.queryapi';
import { BESTSELLER_THRESHOLD, SIZE_ORDER } from '../../foundation/product.constants';
import type { AttributeLookup } from '../../queryapi/attribute-lookup';
import { ProductAdminResponse, ProductCardResponse, ProductDetailResponse } from '../dto/product.responses';
import type { ProductCardRow, ProductDetailRow } from '../repository/product.repository';

/* Sắp size theo thứ tự quen mắt (S M L XL rồi số); size lạ xếp cuối theo alphabet. */
export function sortSizes(sizes: Iterable<string>): string[] {
  const order = new Map(SIZE_ORDER.map((s, i) => [s, i]));
  return [...new Set(sizes)].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999) || a.localeCompare(b));
}

function badgeOf(p: ProductCardRow): string | null {
  const price = vnd(p.basePrice.toString());
  const list = p.listPrice ? vnd(p.listPrice.toString()) : null;
  if (list && list > price) return `-${Number(((list - price) * 100n) / list)}%`;
  if (p.isNew) return 'Mới';
  if (p.soldCount >= BESTSELLER_THRESHOLD) return 'Bán chạy';
  return null;
}

/* Ảnh chính = is_primary → ảnh đầu; ảnh hover = ảnh thứ hai cùng màu chính (nếu có) → ảnh thứ hai bất kỳ. */
function pickImages(p: ProductCardRow): { main: string | null; hover: string | null; byColor: Map<string, string> } {
  const imgs = p.images;
  const primary = imgs.find((i) => i.isPrimary) ?? imgs[0] ?? null;
  const rest = imgs.filter((i) => i !== primary);
  const hover = (primary?.colorCode ? rest.find((i) => i.colorCode === primary.colorCode) : null) ?? rest.find((i) => !i.colorCode) ?? rest[0] ?? null;
  const byColor = new Map<string, string>();
  for (const i of imgs) if (i.colorCode && !byColor.has(i.colorCode)) byColor.set(i.colorCode, i.url);
  return { main: primary?.url ?? null, hover: hover?.url ?? null, byColor };
}

/* `shop` = brief đã resolve sẵn (batch, tránh N+1 — xem ProductQueryService) — bỏ trống ở đường ADMIN (chưa
   cần hiện tên shop trên thẻ quản trị), luôn truyền ở đường CÔNG KHAI (khách phải thấy sản phẩm của shop nào). */
export function toProductCard(p: ProductCardRow, shop?: ShopBrief): ProductCardResponse {
  const active = p.variants.filter((v) => v.isActive);
  const { main, hover, byColor } = pickImages(p);
  const colors = new Map<string, { code: string; name: string; hex: string | null; imageUrl: string | null }>();
  for (const v of active) {
    const code = v.colorCode ?? '';
    if (code && !colors.has(code)) colors.set(code, { code, name: v.colorName ?? '', hex: v.colorHex, imageUrl: byColor.get(code) ?? null });
  }
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    categorySlug: p.categorySlug,
    shop: shop ? { id: shop.id, slug: shop.slug, name: shop.name, logoUrl: shop.logoUrl, ratingAvg: shop.ratingAvg } : null,
    gender: p.gender,
    price: money(p.basePrice.toString()),
    listPrice: p.listPrice && vnd(p.listPrice.toString()) > vnd(p.basePrice.toString()) ? money(p.listPrice.toString()) : null,
    imageUrl: main,
    hoverImageUrl: hover,
    colors: [...colors.values()],
    sizes: sortSizes(active.map((v) => v.sizeCode).filter((s): s is string => !!s)),
    avgRating: Number(p.avgRating.toString()),
    reviewCount: p.reviewCount,
    soldCount: p.soldCount,
    isNew: p.isNew,
    badge: badgeOf(p),
    inStock: active.some((v) => v.stock - v.reserved > 0),
  };
}

/* `attrs` = tên thuộc tính + giá trị select đã resolve qua CatalogQueryApi (xem queryapi/attribute-lookup.ts). Không truyền thì
   attributeName rỗng và thuộc tính chọn từ danh sách (không có customValue) hiện value=null — chỉ chấp nhận ở đường không hiển thị. */
export function toProductDetail(p: ProductDetailRow, shop?: ShopBrief, attrs?: AttributeLookup): ProductDetailResponse {
  const colorName = new Map(p.variants.map((v) => [v.colorCode, v.colorName]));
  return {
    ...toProductCard(p, shop),
    shortDescription: p.shortDescription,
    description: p.description,
    images: p.images.map((i) => ({ id: i.id, url: i.url, color: i.colorCode ? (colorName.get(i.colorCode) ?? null) : null, colorCode: i.colorCode, sortOrder: i.sortOrder, isPrimary: i.isPrimary })),
    variants: p.variants
      .filter((v) => v.isActive)
      .map((v) => ({
        id: v.id,
        color: v.colorName ?? null,
        colorCode: v.colorCode ?? null,
        size: v.sizeCode ?? null,
        sku: v.sku,
        stock: Math.max(0, v.stock - v.reserved),
        price: money((v.price ?? p.basePrice).toString()),
        ...(v.options && v.options.length > 0 ? { options: v.options.map((o) => ({ attributeId: o.attributeId, attributeValueId: o.attributeValueId, displayValue: o.displayValue, ...(attrs?.names.get(o.attributeId) ? { attributeName: attrs.names.get(o.attributeId) } : {}) })) } : {}),
      })),
    material: p.material,
    care: Array.isArray(p.care) ? (p.care as string[]) : [],
    ...(p.attributeValues && p.attributeValues.length > 0
      ? {
          attributeValues: p.attributeValues.map((av) => ({
            attributeId: av.attributeId,
            attributeName: attrs?.names.get(av.attributeId) ?? '',
            attributeValueId: av.attributeValueId,
            // text/number: giá trị nhập tay; select: tên giá trị tra theo attributeValueId.
            value: av.customValue ?? (av.attributeValueId ? (attrs?.values.get(av.attributeValueId) ?? null) : null),
          })),
        }
      : {}),
  };
}

export function toProductAdmin(p: ProductDetailRow, attrs?: AttributeLookup): ProductAdminResponse {
  const base = toProductDetail(p, undefined, attrs);
  return {
    ...base,
    // quản trị thấy cả biến thể đang tắt + tồn thô
    variants: p.variants.map((v) => ({
      id: v.id,
      color: v.colorName ?? null,
      colorCode: v.colorCode ?? null,
      size: v.sizeCode ?? null,
      sku: v.sku,
      stock: v.stock,
      price: money((v.price ?? p.basePrice).toString()),
      isActive: v.isActive,
      ...(v.options && v.options.length > 0 ? { options: v.options.map((o) => ({ attributeId: o.attributeId, attributeValueId: o.attributeValueId, displayValue: o.displayValue, ...(attrs?.names.get(o.attributeId) ? { attributeName: attrs.names.get(o.attributeId) } : {}) })) } : {}),
    })),
    listPrice: moneyOrNull(p.listPrice?.toString() ?? null),
    status: p.status,
    isFeatured: p.isFeatured,
    tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
    categoryId: p.categoryId,
    viewCount: p.viewCount,
    totalStock: p.variants.reduce((n, v) => n + v.stock, 0),
    totalReserved: p.variants.reduce((n, v) => n + v.reserved, 0),
    publishedAt: p.publishedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
