/* Khoá tham số vận hành — phần CÔNG KHAI của module system (module khác đọc qua SystemQueryApi.setting(key)); mặc định ở foundation. */
export const SETTING_KEY = {
  SHOP_NAME: 'shop.name',
  SHOP_HOTLINE: 'shop.hotline',
  SHOP_EMAIL: 'shop.email',
  SHOP_ADDRESS: 'shop.address',
  SHIPPING_FREE_THRESHOLD: 'shipping.free_threshold',
  SHIPPING_DEFAULT_FEE: 'shipping.default_fee',
  /* Hạn thanh toán đơn online (PayOS). Khoá DB giữ nguyên tên lịch sử `order.vnpay_timeout_minutes` để không phải đổi dữ liệu đang chạy. */
  ORDER_ONLINE_PAYMENT_TIMEOUT_MINUTES: 'order.vnpay_timeout_minutes',
  ORDER_COD_MAX_AMOUNT: 'order.cod_max_amount',
  ORDER_AUTO_COMPLETE_DAYS: 'order.auto_complete_days',
  RETURN_WINDOW_DAYS: 'return.window_days',
  CART_MAX_QTY_PER_LINE: 'cart.max_qty_per_line',
  /* PLAN-0018: bật/tắt cron chi trả tự động hằng ngày (02:00 Asia/Ho_Chi_Minh). */
  PAYOUT_AUTO_ENABLED: 'payout.auto_enabled',
  /* PLAN-0020: ví đặt cọc COD — số tiền nộp tối thiểu mỗi lần và hướng dẫn chuyển khoản cho shop. */
  WALLET_MIN_DEPOSIT: 'wallet.min_deposit',
  WALLET_DEPOSIT_INSTRUCTIONS: 'wallet.deposit_instructions',
} as const;
