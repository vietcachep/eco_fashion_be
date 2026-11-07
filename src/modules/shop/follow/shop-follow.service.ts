import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { NotFoundException } from '@common/exception/business.exception';
import { ShopAuditLogService } from '../audit/shop-audit-log.service';

/* Quan hệ follow do shop sở hữu; không dùng wishlist làm follow. Cập nhật idempotent, audit cùng transaction. */
@Injectable()
export class ShopFollowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ShopAuditLogService,
  ) {}
  async following(shopId: string, userId?: string): Promise<boolean> {
    return (
      !!userId &&
      !!(await this.prisma.shopFollow.findUnique({ where: { userId_shopId: { userId, shopId } } }))?.following
    );
  }
  async set(actor: AuthenticatedActor, shopId: string, following: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findFirst({ where: { id: shopId, status: 'approved', isDeleted: false } });
      if (!shop) throw new NotFoundException('SHOP_NOT_FOUND', 'Gian hàng không tồn tại.');
      const old = await tx.shopFollow.findUnique({
        where: { userId_shopId: { userId: actor.userId, shopId } },
      });
      if (old?.following === following) return { following };
      await tx.shopFollow.upsert({
        where: { userId_shopId: { userId: actor.userId, shopId } },
        create: { userId: actor.userId, shopId, following, createdBy: actor.userId },
        update: { following, updatedBy: actor.userId, version: { increment: 1 } },
      });
      await this.audit.write(tx, actor, {
        action: 'SHOP_FOLLOW_CHANGED',
        entityType: 'shop',
        entityId: shopId,
        after: { following },
      });
      return { following };
    });
  }
  async followerIds(shopId: string, tx?: Tx) {
    return (
      await (tx ?? this.prisma).shopFollow.findMany({
        where: { shopId, following: true, notifyLive: true, isDeleted: false },
        select: { userId: true },
      })
    ).map((row) => row.userId);
  }
}
