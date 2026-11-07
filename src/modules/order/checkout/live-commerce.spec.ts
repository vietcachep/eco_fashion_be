import { allocateCapped, allocateLiveLines, snapshotRefund } from './live-allocation';
import { returnedFromSession } from './live-order.gateway';
import {
  completeCartSources,
  ordinarySource,
  reduceSources,
} from '@modules/cart/queryapi/live-source-contract';

describe('LIVE commerce — phân bổ tiền và nguồn lượng hàng', () => {
  it('không phân bổ giảm giá live sang sản phẩm thường hoặc shop khác', () => {
    const a = allocateLiveLines(
      [
        { variantId: 'live', lineTotal: 100_000n },
        { variantId: 'regular', lineTotal: 300_000n },
      ],
      0n,
      50_000n,
      20_000n,
      0n,
      0n,
      undefined,
      { live: '100000' },
    );
    expect(a.allocations.get('live')?.goodsDiscount).toBe('50000');
    expect(a.allocations.get('regular')?.goodsDiscount).toBe('0');
    expect([...a.allocations.values()].reduce((n, l) => n + BigInt(l.netAmount), 0n)).toBe(370_000n);
  });
  it('hai mã ưu tiên shop, phần sàn không được làm dòng eligible âm', () => {
    const a = allocateLiveLines(
      [
        { variantId: 'a', lineTotal: 100n },
        { variantId: 'b', lineTotal: 500n },
      ],
      90n,
      100n,
      0n,
      0n,
      0n,
      { a: '100' },
      { a: '100' },
    );
    expect(a.shopGoods).toBe(90n);
    expect(a.platformGoods).toBe(10n);
    expect(a.allocations.get('a')?.netAmount).toBe('0');
    expect(a.allocations.get('b')?.netAmount).toBe('500');
  });
  it('phân bổ integer có cap, tổng không lệch dù nhiều phần dư', () => {
    for (let n = 1; n < 80; n++) {
      const caps = [BigInt(n), BigInt(n + 3), BigInt(n * 2)];
      const total = BigInt(n * 3);
      const a = allocateCapped(total, [1n, 3n, 5n], caps);
      expect(a.reduce((s, x) => s + x, 0n)).toBe(total);
      a.forEach((x, i) => expect(x <= caps[i] && x >= 0n).toBe(true));
    }
  });
  it('ba lần hoàn một SKU dùng snapshot và không mất đồng làm tròn', () => {
    const a = { netAmount: '100' };
    expect([snapshotRefund(a, 3, 0, 1), snapshotRefund(a, 3, 1, 1), snapshotRefund(a, 3, 2, 1)]).toEqual([
      33n,
      33n,
      34n,
    ]);
    expect(snapshotRefund(null, 3, 0, 1)).toBeNull();
  });
  it('nguồn thường cũ có ID ổn định khi dựng intent và commit', () => {
    const first = completeCartSources([], 2, 'p', 's', 'item-id');
    expect(completeCartSources([], 2, 'p', 's', 'item-id')).toEqual(first);
  });
  it('giảm LIFO trừ phần thường thêm sau trước, không tăng lượng live', () => {
    const live = {
      id: 'grant',
      sessionId: 'live',
      shopId: 's',
      productId: 'p',
      quantity: 1,
      eligibleUntil: '2030-01-01',
    };
    const lots = [ordinarySource(2, 'p', 's'), live, ordinarySource(1, 'p', 's')];
    expect(reduceSources(lots, 1).find((s) => s.id === 'grant')?.quantity).toBe(1);
    expect(reduceSources(lots, 2).find((s) => s.id === 'grant')).toBeUndefined();
    expect(live.quantity).toBe(1);
  });
  it('hoàn SKU cùng loại từ nhiều live không phục hồi mã cho nguồn chưa được trả', () => {
    const lots = [
      ordinarySource(2, 'p', 's'),
      { id: 'a', sessionId: 'A', shopId: 's', productId: 'p', quantity: 1, eligibleUntil: '2030-01-01' },
      { id: 'b', sessionId: 'B', shopId: 's', productId: 'p', quantity: 1, eligibleUntil: '2030-01-01' },
    ];
    expect(returnedFromSession(lots, 4, 1, 'A')).toBe(0);
    expect(returnedFromSession(lots, 4, 1, 'B')).toBe(1);
    expect(returnedFromSession(lots, 4, 2, 'A')).toBe(1);
  });
});
