import type { Tx } from '../prisma/types';

export const CATEGORY_STATS_GATEWAY = Symbol('CATEGORY_STATS_GATEWAY');

/* catalog cài; product gọi khi đăng bán / ẩn / đổi ngành hàng để `product_count` trên ngành hàng luôn đúng. */
export interface CategoryStatsGateway {
  adjustProductCount(categoryId: string, delta: number, tx?: Tx): Promise<void>;
}
