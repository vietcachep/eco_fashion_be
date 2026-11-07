import type { Tx } from '@common/prisma/types';

export const LIVE_SOURCE_GATEWAY = Symbol('LIVE_SOURCE_GATEWAY');

export interface LiveSourceSnapshot {
  sourceGrantId: string;
  sessionId: string;
  shopId: string;
  productId: string;
  eligibleUntil: Date;
}

/* Livestream xác minh bằng chứng nguồn; commerce không tin sourceSessionId do client tự khai. */
export interface LiveSourceGateway {
  canClaim(userId: string, sessionId: string, tx?: Tx): Promise<boolean>;
  verifySource(
    userId: string,
    grantId: string,
    productId: string,
    quantity: number,
  ): Promise<LiveSourceSnapshot>;
  session(
    sessionId: string,
  ): Promise<{ id: string; shopId: string; state: string; startedAt: Date | null } | null>;
}
