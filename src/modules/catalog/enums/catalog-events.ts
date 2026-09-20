/* Tên module + sự kiện outbox catalog phát — module khác (product worker) lắng nghe theo `outbox.catalog.<EVENT>`. */
export const CATALOG_MODULE = 'catalog';

export const CATALOG_EVENT = {
  CATEGORY_CHANGED: 'CATEGORY_CHANGED',
} as const;
