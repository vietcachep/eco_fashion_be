import { money, moneyOrNull } from '@common/response/money-response';
import { vnd } from '@common/utils/money';
import { BESTSELLER_THRESHOLD, SIZE_ORDER } from '../../foundation/product.constants';
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

export function toProductCard(p: ProductCardRow): ProductCardResponse {
  const active = p.variants.filter((v) => v.isActive);
  const { main, hover, byColor } = pickImages(p);
  const colors = new Map<string, { code: string; name: string; hex: string | null; imageUrl: string | null }>();
  for (const v of active) if (!colors.has(v.colorCode)) colors.set(v.colorCode, { code: v.colorCode, name: v.colorName, hex: v.colorHex, imageUrl: byColor.get(v.colorCode) ?? null });
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    categorySlug: p.categorySlug,
    gender: p.gender,
    price: money(p.basePrice.toString()),
    listPrice: p.listPrice && vnd(p.listPrice.toString()) > vnd(p.basePrice.toString()) ? money(p.listPrice.toString()) : null,
    imageUrl: main,
    hoverImageUrl: hover,
    colors: [...colors.values()],
    sizes: sortSizes(active.map((v) => v.sizeCode)),
    avgRating: Number(p.avgRating.toString()),
    reviewCount: p.reviewCount,
    soldCount: p.soldCount,
    isNew: p.isNew,
    badge: badgeOf(p),
    inStock: active.some((v) => v.stock - v.reserved > 0),
  };
}

export function toProductDetail(p: ProductDetailRow): ProductDetailResponse {
  const colorName = new Map(p.variants.map((v) => [v.colorCode, v.colorName]));
  return {
    ...toProductCard(p),
    shortDescription: p.shortDescription,
    description: p.description,
    images: p.images.map((i) => ({ id: i.id, url: i.url, color: i.colorCode ? (colorName.get(i.colorCode) ?? null) : null, colorCode: i.colorCode, sortOrder: i.sortOrder, isPrimary: i.isPrimary })),
    variants: p.variants
      .filter((v) => v.isActive)
      .map((v) => ({ id: v.id, color: v.colorName, colorCode: v.colorCode, size: v.sizeCode, sku: v.sku, stock: Math.max(0, v.stock - v.reserved), price: money((v.price ?? p.basePrice).toString()) })),
    material: p.material,
    care: Array.isArray(p.care) ? (p.care as string[]) : [],
  };
}

export function toProductAdmin(p: ProductDetailRow): ProductAdminResponse {
  const base = toProductDetail(p);
  return {
    ...base,
    // quản trị thấy cả biến thể đang tắt + tồn thô
    variants: p.variants.map((v) => ({ id: v.id, color: v.colorName, colorCode: v.colorCode, size: v.sizeCode, sku: v.sku, stock: v.stock, price: money((v.price ?? p.basePrice).toString()) })),
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
