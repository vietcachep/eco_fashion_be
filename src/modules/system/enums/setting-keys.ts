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
  /* PLAN-0025 — ân hạn sau hạn thanh toán trước khi huỷ đơn PayOS (và chỉ huỷ sau khi hỏi lại PayOS). */
  ORDER_PAYMENT_GRACE_MINUTES: 'order.payment_grace_minutes',
  ORDER_AUTO_COMPLETE_DAYS: 'order.auto_complete_days',
  /* PLAN-0027 — hạn chót xử lý đơn của shop. `order.sla_enabled` MẶC ĐỊNH TẮT (điểm an toàn G72): bật thì job SLA mới tự huỷ đơn quá hạn; đơn cũ (hạn NULL) không bao giờ bị động tới. */
  ORDER_SLA_ENABLED: 'order.sla_enabled',
  ORDER_SHOP_CONFIRM_HOURS: 'order.shop_confirm_hours',
  ORDER_SHOP_SHIP_HOURS: 'order.shop_ship_hours',
  ORDER_CANCEL_REQUEST_HOURS: 'order.cancel_request_hours',
  SHOP_VIOLATION_SUSPEND_POINTS: 'shop.violation_suspend_points',
  RETURN_WINDOW_DAYS: 'return.window_days',
  /* PLAN-0022 — hạn chót từng bước đổi trả (hết hạn thì job tự chuyển bước, không ai âm thầm làm thay ai). */
  RETURN_SHOP_RESPOND_HOURS: 'return.shop_respond_hours',
  RETURN_SHIP_BACK_DAYS: 'return.ship_back_days',
  RETURN_SHOP_RECEIVE_DAYS: 'return.shop_receive_days',
  RETURN_ESCALATE_DAYS: 'return.escalate_days',
  RETURN_NOT_RECEIVED_DAYS: 'return.not_received_days',
  /* PLAN-0022 — đơn `shipping` quá N ngày ⇒ cảnh báo shop + CSKH (1 lần). */
  ORDER_SHIPPING_ALERT_DAYS: 'order.shipping_alert_days',
  CART_MAX_QTY_PER_LINE: 'cart.max_qty_per_line',
  /* PLAN-0018: bật/tắt cron chi trả tự động hằng ngày (02:00 Asia/Ho_Chi_Minh). */
  PAYOUT_AUTO_ENABLED: 'payout.auto_enabled',
  /* PLAN-0020: ví đặt cọc COD — số tiền nộp tối thiểu mỗi lần và hướng dẫn chuyển khoản cho shop. */
  WALLET_MIN_DEPOSIT: 'wallet.min_deposit',
  WALLET_DEPOSIT_INSTRUCTIONS: 'wallet.deposit_instructions',
  /* PLAN-0041 — nạp cọc COD qua PayOS: cờ bật (mặc định TẮT), trần mỗi lần nạp, hạn link PayOS. */
  WALLET_PAYOS_DEPOSIT_ENABLED: 'wallet.payos_deposit_enabled',
  WALLET_MAX_TOPUP_AMOUNT: 'wallet.max_topup_amount',
  WALLET_PAYOS_TOPUP_EXPIRE_MINUTES: 'wallet.payos_topup_expire_minutes',
  /* PLAN-0026 — chi trả shop an toàn. */
  WALLET_MIN_BALANCE_FOR_COD: 'wallet.min_balance_for_cod',
  PAYOUT_MIN_AMOUNT: 'payout.min_amount',
  PAYOUT_AUTO_MAX_AMOUNT: 'payout.auto_max_amount',
  REFUND_AUTO_MAX_AMOUNT: 'refund.auto_max_amount',
  PAYOUT_BANK_CHANGE_HOLD_HOURS: 'payout.bank_change_hold_hours',
} as const;
