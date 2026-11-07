import type { LiveCartSource } from '@common/gateway/live-commerce.gateway';
import { randomUUID } from 'node:crypto';

export function cartSources(value: unknown): LiveCartSource[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((item): item is LiveCartSource => {
    if (!item || typeof item !== 'object') return false;
    const s = item as Partial<LiveCartSource>;
    return (
      typeof s.id === 'string' &&
      typeof s.sessionId === 'string' &&
      typeof s.productId === 'string' &&
      typeof s.shopId === 'string' &&
      typeof s.quantity === 'number' &&
      Number.isSafeInteger(s.quantity) &&
      s.quantity > 0 &&
      typeof s.eligibleUntil === 'string'
    );
  });
}

export function ordinarySource(quantity: number, productId: string, shopId: string): LiveCartSource {
  return { id: randomUUID(), sessionId: '', shopId, productId, quantity, eligibleUntil: '' };
}
export function completeCartSources(
  value: unknown,
  quantity: number,
  productId: string,
  shopId: string,
  legacyId?: string,
): LiveCartSource[] {
  const sources = cartSources(value);
  const missing = quantity - sources.reduce((n, s) => n + s.quantity, 0);
  const ordinary = ordinarySource(missing, productId, shopId);
  if (legacyId) ordinary.id = 'legacy:' + legacyId;
  return missing > 0 ? [ordinary, ...sources] : sources;
}

/* Giảm LIFO: quantity tăng trong giỏ không được biến thành lượng live. Không sửa snapshot nguồn cũ. */
export function reduceSources(sources: LiveCartSource[], remove: number): LiveCartSource[] {
  const next = sources.map((s) => ({ ...s }));
  for (let i = next.length - 1; i >= 0 && remove > 0; i--) {
    const amount = Math.min(remove, next[i].quantity);
    next[i].quantity -= amount;
    remove -= amount;
  }
  return next.filter((s) => s.quantity > 0);
}
