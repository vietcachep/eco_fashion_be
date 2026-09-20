/* Khoá tham số vận hành — phần CÔNG KHAI của module system (module khác đọc qua SystemQueryApi.setting(key)); mặc định ở foundation. */
export const SETTING_KEY = {
  SHOP_NAME: 'shop.name',
  SHOP_HOTLINE: 'shop.hotline',
  SHOP_EMAIL: 'shop.email',
  SHOP_ADDRESS: 'shop.address',
  SHIPPING_FREE_THRESHOLD: 'shipping.free_threshold',
  SHIPPING_DEFAULT_FEE: 'shipping.default_fee',
  ORDER_VNPAY_TIMEOUT_MINUTES: 'order.vnpay_timeout_minutes',
  ORDER_BANK_TRANSFER_TIMEOUT_HOURS: 'order.bank_transfer_timeout_hours',
  ORDER_COD_MAX_AMOUNT: 'order.cod_max_amount',
  ORDER_AUTO_COMPLETE_DAYS: 'order.auto_complete_days',
  RETURN_WINDOW_DAYS: 'return.window_days',
  CART_MAX_QTY_PER_LINE: 'cart.max_qty_per_line',
} as const;
