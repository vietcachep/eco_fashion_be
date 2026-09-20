import { Injectable } from '@nestjs/common';
import type { ProductStatsGateway } from '@common/gateway/product-stats.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { ProductQueryService } from '../product/service/product-query.service';

/* Cài ProductStatsGateway: đếm sẵn sold/review/view trên products; xoá cache list/detail sau khi ghi. */
@Injectable()
export class ProductStatsGatewayImpl implements ProductStatsGateway {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: ProductQueryService,
  ) {}

  async addSold(items: Array<{ productId: string; quantity: number }>, tx?: Tx): Promise<void> {
    const db = tx ?? this.prisma;
    for (const i of items) await db.product.update({ where: { id: i.productId }, data: { soldCount: { increment: i.quantity } } });
    await this.query.invalidateAll();
  }

  async setRating(productId: string, avgRating: number, reviewCount: number, tx?: Tx): Promise<void> {
    await (tx ?? this.prisma).product.update({ where: { id: productId }, data: { avgRating: avgRating.toFixed(2), reviewCount } });
    await this.query.invalidateAll();
  }

  async addView(productId: string): Promise<void> {
    // Lượt xem không cần chính xác tuyệt đối và không xoá cache (đã có TTL).
    await this.prisma.product.update({ where: { id: productId }, data: { viewCount: { increment: 1 } } }).catch(() => undefined);
  }
}
