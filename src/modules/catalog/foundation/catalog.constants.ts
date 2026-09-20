import type { CacheSpec } from '@common/cache/cache.service';

export { CATALOG_MODULE, CATALOG_EVENT } from '../enums/catalog-events';
export { GENDERS } from '../enums/gender';
export type { Gender } from '../enums/gender';

export const CATALOG_ERR = {
  CATEGORY_NOT_FOUND: 'CATALOG_CATEGORY_NOT_FOUND',
  CATEGORY_SLUG_EXISTS: 'CATALOG_CATEGORY_SLUG_EXISTS',
  CATEGORY_HAS_PRODUCTS: 'CATALOG_CATEGORY_HAS_PRODUCTS',
  CATEGORY_PARENT_INVALID: 'CATALOG_CATEGORY_PARENT_INVALID',
  COLLECTION_NOT_FOUND: 'CATALOG_COLLECTION_NOT_FOUND',
  COLLECTION_SLUG_EXISTS: 'CATALOG_COLLECTION_SLUG_EXISTS',
  ATTRIBUTE_NOT_FOUND: 'CATALOG_ATTRIBUTE_NOT_FOUND',
  ATTRIBUTE_VALUE_EXISTS: 'CATALOG_ATTRIBUTE_VALUE_EXISTS',
  ATTRIBUTE_VALUE_NOT_FOUND: 'CATALOG_ATTRIBUTE_VALUE_NOT_FOUND',
} as const;

export const CATALOG_AUDIT = {
  CATEGORY_CREATED: 'CATEGORY_CREATED',
  CATEGORY_UPDATED: 'CATEGORY_UPDATED',
  CATEGORY_DELETED: 'CATEGORY_DELETED',
  COLLECTION_CREATED: 'COLLECTION_CREATED',
  COLLECTION_UPDATED: 'COLLECTION_UPDATED',
  COLLECTION_DELETED: 'COLLECTION_DELETED',
  ATTRIBUTE_VALUE_SAVED: 'ATTRIBUTE_VALUE_SAVED',
  ATTRIBUTE_VALUE_DELETED: 'ATTRIBUTE_VALUE_DELETED',
} as const;

/* Mã thuộc tính cố định — biến thể sản phẩm tham chiếu theo code, không theo id. */
export const ATTRIBUTE_CODE = { COLOR: 'color', SIZE: 'size', MATERIAL: 'material' } as const;

/* Cache đường đọc nhiều — xoá theo prefix sau mỗi lần ghi của module. */
const MODULE = 'catalog';

export const CATALOG_CACHE = {
  categories: { module: MODULE, purpose: 'categories', ttlSeconds: 600 } satisfies CacheSpec,
  collections: { module: MODULE, purpose: 'collections', ttlSeconds: 600 } satisfies CacheSpec,
  attributes: { module: MODULE, purpose: 'attributes', ttlSeconds: 600 } satisfies CacheSpec,
};
