import { Injectable } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import type { CategoryStatsGateway } from '@common/gateway/category-stats.gateway';
import type { Tx } from '@common/prisma/types';
import { CategoryRepository } from '../category/repository/category.repository';
import { CATALOG_CACHE } from '../foundation/catalog.constants';

/* product gọi khi đăng/ẩn/đổi ngành hàng — cộng/trừ product_count trong CÙNG transaction của product, rồi xoá cache menu. */
@Injectable()
export class CategoryStatsGatewayImpl implements CategoryStatsGateway {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly cache: CacheService,
  ) {}

  async adjustProductCount(categoryId: string, delta: number, tx?: Tx): Promise<void> {
    if (delta === 0) return;
    await this.categories.adjustProductCount(categoryId, delta, tx);
    await this.cache.delByPrefix(CATALOG_CACHE.categories);
  }
}
