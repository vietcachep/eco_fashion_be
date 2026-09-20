/* Phần CÔNG KHAI của product cho module khác (ai nhúng lại khi sản phẩm đổi, reporting…). */
export const PRODUCT_MODULE = 'product';

export const PRODUCT_EVENT = {
  PUBLISHED: 'PRODUCT_PUBLISHED',
  UPDATED: 'PRODUCT_UPDATED',
  HIDDEN: 'PRODUCT_HIDDEN',
  STOCK_LOW: 'PRODUCT_STOCK_LOW',
} as const;
