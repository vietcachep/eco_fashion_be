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
  // PLAN-0016 — ngành hàng dynamic + thuộc tính động
  /* Ngành đã có sản phẩm → không đổi chế độ thuộc tính (legacy_fashion ↔ dynamic) — sản phẩm/biến thể cũ sẽ mồ côi. */
  CATEGORY_MODE_LOCKED: 'CATALOG_CATEGORY_MODE_LOCKED',
  /* Mẫu thuộc tính chỉ áp cho ngành dynamic. */
  CATEGORY_NOT_DYNAMIC: 'CATALOG_CATEGORY_NOT_DYNAMIC',
  DYNAMIC_ATTRIBUTE_NOT_FOUND: 'CATALOG_DYNAMIC_ATTRIBUTE_NOT_FOUND',
  CODE_EXISTS: 'CATALOG_CODE_EXISTS',
  VALUE_EXISTS: 'CATALOG_VALUE_EXISTS',
  VALUE_NOT_FOUND: 'CATALOG_VALUE_NOT_FOUND',
  /* Giá trị đang được sản phẩm/biến thể dùng → không xoá (để lại id mồ côi). */
  ATTRIBUTE_VALUE_IN_USE: 'CATALOG_ATTRIBUTE_VALUE_IN_USE',
  TOO_MANY_VARIANT_AXIS: 'CATALOG_TOO_MANY_VARIANT_AXIS',
  /* Ngành dynamic cần ít nhất một trục biến thể, nếu không không tạo nổi biến thể nào. */
  VARIANT_AXIS_REQUIRED: 'CATALOG_VARIANT_AXIS_REQUIRED',
  /* Trục biến thể phải là thuộc tính chọn từ danh sách (select) — text/number không có giá trị cố định để làm biến thể. */
  VARIANT_AXIS_NOT_SELECT: 'CATALOG_VARIANT_AXIS_NOT_SELECT',
  TEMPLATE_ATTRIBUTE_DUPLICATED: 'CATALOG_TEMPLATE_ATTRIBUTE_DUPLICATED',
} as const;

/* PLAN-0016 — chế độ thuộc tính của ngành hàng (cột categories.attribute_mode). */
export const ATTRIBUTE_MODE = { DYNAMIC: 'dynamic', LEGACY_FASHION: 'legacy_fashion' } as const;
export type AttributeMode = (typeof ATTRIBUTE_MODE)[keyof typeof ATTRIBUTE_MODE];
export const ATTRIBUTE_MODES = Object.values(ATTRIBUTE_MODE);

/* Kiểu nhập của thuộc tính động: select = chọn từ giá trị có sẵn; text/number = nhập tay. */
export const DYNAMIC_INPUT_TYPES = ['select', 'text', 'number'] as const;
export type DynamicInputType = (typeof DYNAMIC_INPUT_TYPES)[number];

export const CATALOG_AUDIT = {
  CATEGORY_CREATED: 'CATEGORY_CREATED',
  CATEGORY_UPDATED: 'CATEGORY_UPDATED',
  CATEGORY_DELETED: 'CATEGORY_DELETED',
  COLLECTION_CREATED: 'COLLECTION_CREATED',
  COLLECTION_UPDATED: 'COLLECTION_UPDATED',
  COLLECTION_DELETED: 'COLLECTION_DELETED',
  ATTRIBUTE_VALUE_SAVED: 'ATTRIBUTE_VALUE_SAVED',
  ATTRIBUTE_VALUE_DELETED: 'ATTRIBUTE_VALUE_DELETED',
  // PLAN-0016 — dynamic attributes
  DYNAMIC_ATTRIBUTE_CREATED: 'DYNAMIC_ATTRIBUTE_CREATED',
  DYNAMIC_ATTRIBUTE_VALUE_CREATED: 'DYNAMIC_ATTRIBUTE_VALUE_CREATED',
  DYNAMIC_ATTRIBUTE_VALUE_UPDATED: 'DYNAMIC_ATTRIBUTE_VALUE_UPDATED',
  DYNAMIC_ATTRIBUTE_VALUE_DELETED: 'DYNAMIC_ATTRIBUTE_VALUE_DELETED',
  CATEGORY_ATTRIBUTE_TEMPLATE_SET: 'CATEGORY_ATTRIBUTE_TEMPLATE_SET',
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
