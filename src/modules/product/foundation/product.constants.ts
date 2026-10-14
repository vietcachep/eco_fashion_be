import type { CacheSpec } from '@common/cache/cache.service';
import { PRODUCT_MODULE } from '../enums/product-events';

export { PRODUCT_EVENT, PRODUCT_MODULE } from '../enums/product-events';

export const PRODUCT_ERR = {
  NOT_FOUND: 'PRODUCT_NOT_FOUND',
  SLUG_EXISTS: 'PRODUCT_SLUG_EXISTS',
  SKU_EXISTS: 'PRODUCT_SKU_EXISTS',
  CATEGORY_INVALID: 'PRODUCT_CATEGORY_INVALID',
  COLOR_INVALID: 'PRODUCT_COLOR_INVALID',
  SIZE_INVALID: 'PRODUCT_SIZE_INVALID',
  VARIANT_NOT_FOUND: 'PRODUCT_VARIANT_NOT_FOUND',
  VARIANT_REQUIRED: 'PRODUCT_VARIANT_REQUIRED',
  IMAGE_NOT_FOUND: 'PRODUCT_IMAGE_NOT_FOUND',
  IMAGE_LIMIT: 'PRODUCT_IMAGE_LIMIT',
  NOT_PUBLISHABLE: 'PRODUCT_NOT_PUBLISHABLE',
  RECEIPT_NOT_FOUND: 'PRODUCT_RECEIPT_NOT_FOUND',
  RECEIPT_NOT_DRAFT: 'PRODUCT_RECEIPT_NOT_DRAFT',
  INSUFFICIENT_STOCK: 'PRODUCT_INSUFFICIENT_STOCK',
  ADJUST_INVALID: 'PRODUCT_ADJUST_INVALID',
  /* Tồn kho sau khi nhập/điều chỉnh vượt trần (stock là int4) và tổng giá trị phiếu nhập vượt numeric(14,0). */
  STOCK_LIMIT_EXCEEDED: 'PRODUCT_STOCK_LIMIT_EXCEEDED',
  RECEIPT_TOTAL_TOO_LARGE: 'PRODUCT_RECEIPT_TOTAL_TOO_LARGE',
  /* PLAN-0014: seed shop chưa chạy, chưa có gian hàng chính chủ để gán cho sản phẩm tạo qua /admin/products. */
  SHOP_NOT_CONFIGURED: 'PRODUCT_SHOP_NOT_CONFIGURED',
  /* Biến thể đang giữ hàng cho đơn (reserved > 0) hoặc nằm trong phiếu nhập nháp → không được gỡ khỏi danh sách. */
  VARIANT_IN_USE: 'PRODUCT_VARIANT_IN_USE',
  /* Đã có biến thể → không đổi sang ngành có mẫu thuộc tính/chế độ khác (biến thể + thuộc tính cũ sẽ mồ côi). */
  CATEGORY_LOCKED: 'PRODUCT_CATEGORY_LOCKED',
  /* Thuộc tính cấp sản phẩm sai mẫu của ngành (ngoài mẫu, trùng, sai kiểu, giá trị không thuộc thuộc tính). */
  ATTRIBUTE_INVALID: 'PRODUCT_ATTRIBUTE_INVALID',
  /* Thiếu thuộc tính bắt buộc (required) của ngành khi đăng bán. */
  ATTRIBUTE_REQUIRED: 'PRODUCT_ATTRIBUTE_REQUIRED',
  IMAGE_INVALID: 'PRODUCT_IMAGE_INVALID',
  /* Không cho bỏ ảnh chính duy nhất / xoá ảnh cuối của sản phẩm đang bán. */
  IMAGE_PRIMARY_REQUIRED: 'PRODUCT_IMAGE_PRIMARY_REQUIRED',
  IMAGE_REQUIRED: 'PRODUCT_IMAGE_REQUIRED',
} as const;

export const PRODUCT_AUDIT = {
  CREATED: 'PRODUCT_CREATED',
  UPDATED: 'PRODUCT_UPDATED',
  PUBLISHED: 'PRODUCT_PUBLISHED',
  HIDDEN: 'PRODUCT_HIDDEN',
  DELETED: 'PRODUCT_DELETED',
  VARIANTS_SAVED: 'PRODUCT_VARIANTS_SAVED',
  ATTRIBUTES_SAVED: 'PRODUCT_ATTRIBUTES_SAVED',
  IMAGE_ADDED: 'PRODUCT_IMAGE_ADDED',
  IMAGE_REMOVED: 'PRODUCT_IMAGE_REMOVED',
  IMAGES_REORDERED: 'PRODUCT_IMAGES_REORDERED',
  RECEIPT_CREATED: 'STOCK_RECEIPT_CREATED',
  RECEIPT_POSTED: 'STOCK_RECEIPT_POSTED',
  STOCK_ADJUSTED: 'STOCK_ADJUSTED',
} as const;

export const PRODUCT_STATUS = { DRAFT: 'draft', ACTIVE: 'active', HIDDEN: 'hidden' } as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];

export const RECEIPT_STATUS = { DRAFT: 'draft', POSTED: 'posted', CANCELLED: 'cancelled' } as const;

/* Loại biến động sổ kho. */
export const STOCK_MOVE = { RECEIPT: 'RECEIPT', ADJUST: 'ADJUST', RESERVE: 'RESERVE', RELEASE: 'RELEASE', SALE: 'SALE', RETURN: 'RETURN' } as const;

export const PRODUCT_SORTS = ['featured', 'newest', 'bestselling', 'priceAsc', 'priceDesc'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

/* Nhãn góc thẻ: giảm giá > mới > bán chạy (ngưỡng). */
export const BESTSELLER_THRESHOLD = 500;
export const LOW_STOCK_THRESHOLD = 5;
export const MAX_IMAGES_PER_PRODUCT = 12;

/* Thứ tự size khi hiện (chữ trước số). */
export const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '26', '27', '28', '29', '30', '31', '32', '33', '34'];

export const PRODUCT_CACHE = {
  list: { module: PRODUCT_MODULE, purpose: 'list', ttlSeconds: 60 } satisfies CacheSpec,
  detail: { module: PRODUCT_MODULE, purpose: 'detail', ttlSeconds: 120 } satisfies CacheSpec,
  filters: { module: PRODUCT_MODULE, purpose: 'filters', ttlSeconds: 600 } satisfies CacheSpec,
  related: { module: PRODUCT_MODULE, purpose: 'related', ttlSeconds: 300 } satisfies CacheSpec,
};
