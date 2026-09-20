import type { Tx } from '../prisma/types';

export const PRODUCT_STATS_GATEWAY = Symbol('PRODUCT_STATS_GATEWAY');

/*
 * Cổng ghi thống kê sản phẩm — product cài; order (đã bán), review (điểm), ai/analytics (lượt xem) gọi.
 * Đếm sẵn trên bảng products để list/card không JOIN; sai lệch nhỏ chấp nhận được (không phải tiền).
 */
export interface ProductStatsGateway {
  addSold(items: Array<{ productId: string; quantity: number }>, tx?: Tx): Promise<void>;
  setRating(productId: string, avgRating: number, reviewCount: number, tx?: Tx): Promise<void>;
  addView(productId: string): Promise<void>;
}
