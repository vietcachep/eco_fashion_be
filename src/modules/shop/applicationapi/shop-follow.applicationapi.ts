import { Injectable } from '@nestjs/common';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { Tx } from '@common/prisma/types';
import { ShopFollowService } from '../follow/shop-follow.service';

/* Cổng công khai follow cho livestream; không để module khác import service nội bộ shop. */
@Injectable()
export class ShopFollowApplicationApi {
  constructor(private readonly follows: ShopFollowService) {}
  following(shopId: string, userId?: string) {
    return this.follows.following(shopId, userId);
  }
  set(actor: AuthenticatedActor, shopId: string, following: boolean) {
    return this.follows.set(actor, shopId, following);
  }
  followerIds(shopId: string, tx?: Tx) {
    return this.follows.followerIds(shopId, tx);
  }
}
