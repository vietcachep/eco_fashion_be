import type { Tx } from '../prisma/types';

export const PROMOTION_GATEWAY = Symbol('PROMOTION_GATEWAY');

export interface BasketForPromotion {
  userId: string;
  subtotal: bigint;
  shippingFee: bigint;
  lines: Array<{ productId: string; categorySlug: string; lineTotal: bigint }>;
}

export interface PromotionQuote {
  ok: boolean;
  code: string;
  name: string | null;
  type: string;
  discount: bigint;
  /* Lý do không áp dụng được (tiếng Việt, hiện dưới ô nhập mã) */
  error: string | null;
  /* Còn thiếu bao nhiêu để đủ điều kiện đơn tối thiểu */
  missingAmount: bigint | null;
}

/*
 * Cổng khuyến mãi — promotion cài; order gọi: quote (tính giảm cho giỏ, KHÔNG ghi), consume (chốt lượt trong tx tạo đơn,
 * khoá dòng, kiểm hạn mức lần cuối), release (huỷ đơn → nhả lượt). Tiền bigint VND.
 */
export interface PromotionGateway {
  quote(code: string, basket: BasketForPromotion): Promise<PromotionQuote>;
  consume(code: string, basket: BasketForPromotion, orderCode: string, tx: Tx): Promise<PromotionQuote>;
  release(orderCode: string, tx: Tx): Promise<void>;
}
