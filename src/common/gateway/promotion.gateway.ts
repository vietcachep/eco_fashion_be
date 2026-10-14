import type { Tx } from '../prisma/types';

export const PROMOTION_GATEWAY = Symbol('PROMOTION_GATEWAY');

export interface BasketForPromotion {
  userId: string;
  /* Voucher GIAN HÀNG: giỏ CHỈ gồm hàng của shop này (subtotal/shippingFee/lines của riêng shop). Voucher SÀN: bỏ trống = giỏ cả đơn. */
  shopId?: string | null;
  subtotal: bigint;
  shippingFee: bigint;
  lines: Array<{ productId: string; categorySlug: string; lineTotal: bigint }>;
}

export interface PromotionQuote {
  ok: boolean;
  code: string;
  name: string | null;
  type: string;
  /* platform = sàn chịu chi phí, áp trên cả giỏ · shop = gian hàng chịu, chỉ áp cho đơn con của shop đó */
  scope: 'platform' | 'shop';
  shopId: string | null;
  discount: bigint;
  /* Lý do không áp dụng được (tiếng Việt, hiện dưới ô nhập mã) */
  error: string | null;
  /* Còn thiếu bao nhiêu để đủ điều kiện đơn tối thiểu */
  missingAmount: bigint | null;
}

/*
 * Cổng khuyến mãi — promotion cài; order gọi: scopeOf (mã thuộc sàn hay shop nào → đưa đúng giỏ vào quote), quote (tính giảm
 * cho giỏ, KHÔNG ghi), consume (chốt lượt trong tx tạo đơn, khoá dòng, kiểm hạn mức lần cuối), release (huỷ đơn → nhả lượt).
 * Voucher sàn consume theo mã đơn CHA, voucher shop consume theo mã đơn CON. Tiền bigint VND.
 */
export interface PromotionGateway {
  /* Tra phạm vi mã (không kiểm điều kiện). null = mã không tồn tại / đã xoá. */
  scopeOf(code: string): Promise<{ scope: 'platform' | 'shop'; shopId: string | null } | null>;
  quote(code: string, basket: BasketForPromotion): Promise<PromotionQuote>;
  consume(code: string, basket: BasketForPromotion, orderCode: string, tx: Tx): Promise<PromotionQuote>;
  release(orderCode: string, tx: Tx): Promise<void>;
}
