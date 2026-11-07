/* Chia đồng nguyên có cap; tổng phân bổ đúng tuyệt đối, không trừ voucher live vào phần hàng thường. */
export function allocateCapped(amount: bigint, weights: bigint[], caps: bigint[]): bigint[] {
  const result = weights.map(() => 0n);
  let left = amount;
  while (left > 0n) {
    const active = weights.map((w, i) => (w > 0n && result[i] < caps[i] ? i : -1)).filter((i) => i >= 0);
    if (!active.length) break;
    const total = active.reduce((s, i) => s + weights[i], 0n);
    const before = left;
    for (const i of active) {
      const raw = (before * weights[i]) / total;
      const take = raw < caps[i] - result[i] ? raw : caps[i] - result[i];
      result[i] += take;
      left -= take;
    }
    if (left === before) {
      const i = active[active.length - 1];
      const take = left < caps[i] - result[i] ? left : caps[i] - result[i];
      result[i] += take;
      left -= take;
    }
  }
  return result;
}

export interface LiveLineAllocation {
  netAmount: string;
  netGoodsAmount: string;
  goodsDiscount: string;
  shippingShare: string;
}
export function allocateLiveLines(
  lines: Array<{ variantId: string; lineTotal: bigint }>,
  shopDiscount: bigint,
  platformDiscount: bigint,
  shippingFee: bigint,
  shopShippingDiscount: bigint,
  platformShippingDiscount: bigint,
  shopWeights?: Record<string, string>,
  platformWeights?: Record<string, string>,
) {
  const gross = lines.map((l) => l.lineTotal);
  const weights = (custom?: Record<string, string>) =>
    lines.map((l) => (custom ? BigInt(custom[l.variantId] ?? '0') : l.lineTotal));
  const shop = allocateCapped(shopDiscount - shopShippingDiscount, weights(shopWeights), gross);
  const platform = allocateCapped(
    platformDiscount - platformShippingDiscount,
    weights(platformWeights),
    gross.map((g, i) => g - shop[i]),
  );
  const shipping = allocateCapped(
    shippingFee - shopShippingDiscount - platformShippingDiscount,
    gross,
    gross.map(() => shippingFee),
  );
  const allocations = new Map<string, LiveLineAllocation>(
    lines.map((l, i) => [
      l.variantId,
      {
        netAmount: (gross[i] - shop[i] - platform[i] + shipping[i]).toString(),
        netGoodsAmount: (gross[i] - shop[i] - platform[i]).toString(),
        goodsDiscount: (shop[i] + platform[i]).toString(),
        shippingShare: shipping[i].toString(),
      },
    ]),
  );
  return {
    allocations,
    shopGoods: shop.reduce((a, b) => a + b, 0n),
    platformGoods: platform.reduce((a, b) => a + b, 0n),
  };
}

export function snapshotRefund(
  raw: unknown,
  quantity: number,
  returnedBefore: number,
  returnQuantity: number,
): bigint | null {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('netAmount' in raw) ||
    typeof raw.netAmount !== 'string' ||
    !/^\d+$/.test(raw.netAmount)
  )
    return null;
  const net = BigInt(raw.netAmount);
  return (
    (net * BigInt(returnedBefore + returnQuantity)) / BigInt(quantity) -
    (net * BigInt(returnedBefore)) / BigInt(quantity)
  );
}
