import type { Tx } from '../prisma/types';
import type { MoneyResponse } from '../response/money-response';

export interface LiveCartSource {
  id: string;
  sessionId: string;
  shopId: string;
  productId: string;
  quantity: number;
  eligibleUntil: string;
  recoveryEntitlementId?: string;
}

export const LIVE_COMMERCE_ORDER_GATEWAY = Symbol('LIVE_COMMERCE_ORDER_GATEWAY');
export interface CoveredLiveLine {
  variantId: string;
  productId: string;
  shopId: string;
  quantity: number;
  sessionId: string;
}
export interface LiveCommerceOrderGateway {
  coverage(
    orderCode: string,
    lines: CoveredLiveLine[],
  ): Promise<{ complete: boolean; partial: boolean; pendingRefund: boolean }>;
  report(
    sessionId: string,
  ): Promise<{ orders: number; paidOrders: number; revenue: MoneyResponse; refunded: MoneyResponse }>;
}

export const LIVE_RECOVERY_CHECKOUT_GATEWAY = Symbol('LIVE_RECOVERY_CHECKOUT_GATEWAY');
export interface LiveRecoveryCheckoutGateway {
  createRecovery(
    userId: string,
    entitlementId: string,
    lines: Array<CoveredLiveLine & { eligibleUntil: string }>,
  ): Promise<unknown>;
}

export interface CartPurchaseSnapshot {
  variantId: string;
  quantity: number;
  sourceLots: LiveCartSource[];
}

/* Cart cài: claim receipt bảo đảm một bằng chứng nguồn không sinh ra nhiều lượng eligible qua retry. */
export const LIVE_CART_GATEWAY = Symbol('LIVE_CART_GATEWAY');
export interface LiveCartGateway {
  claimIntentSources(
    userId: string,
    intentId: string,
    grants: Array<{ grantId: string; productId: string; quantity: number }>,
    tx: Tx,
  ): Promise<LiveCartSource[]>;
  consumeSnapshot(userId: string, lines: CartPurchaseSnapshot[], tx: Tx): Promise<void>;
}
