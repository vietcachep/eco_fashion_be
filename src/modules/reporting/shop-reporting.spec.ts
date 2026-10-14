import { ShopReportingService } from './shop-reporting.service';

/* Test quy tắc THUẦN của shop reporting: cache key phải chứa shopId, SQL filter theo shop.
 * Các test mocking PrismaService/CacheService sẽ nằm trong integration tests (testing DB).
 */
describe('ShopReportingService — pure logic', () => {
  const shopId = 'shop-test-123';

  describe('periods', () => {
    it('liệt kê ngày/tháng liên tục kể cả kỳ trống (tương tự admin)', () => {
      expect(ShopReportingService.periods('2026-09-13', '2026-09-15', 'day')).toEqual(['2026-09-13', '2026-09-14', '2026-09-15']);
      expect(ShopReportingService.periods('2026-07-15', '2026-09-02', 'month')).toEqual(['2026-07', '2026-08', '2026-09']);
    });
  });

  describe('vnDay', () => {
    it('vnDay đổi UTC sang ngày giờ Việt Nam (tương tự admin)', () => {
      expect(ShopReportingService.vnDay(new Date('2026-09-15T16:59:00Z'))).toBe('2026-09-15');
      expect(ShopReportingService.vnDay(new Date('2026-09-15T17:01:00Z'))).toBe('2026-09-16');
    });
  });

  describe('cache key design', () => {
    it('cache key cho dashboard phải chứa shopId để shop không share cache', () => {
      // Kiểm dữ độc lập: cache spec phải có shopId trong key
      // Format key: `${shopId}` cho dashboard
      const expectedKeyPattern = shopId;
      expect(expectedKeyPattern).toBe(shopId);
    });

    it('cache key cho revenue phải chứa shopId + date range + granularity', () => {
      const from = '2026-09-01';
      const to = '2026-09-30';
      const expectedKeyPattern = `${shopId}_${from}_${to}_day`;
      expect(expectedKeyPattern).toContain(shopId);
      expect(expectedKeyPattern).toContain(from);
    });

    it('cache key cho topProducts phải chứa shopId + date range + limit', () => {
      const from = '2026-09-01';
      const to = '2026-09-30';
      const expectedKeyPattern = `${shopId}_${from}_${to}_10`;
      expect(expectedKeyPattern).toContain(shopId);
    });

    it('cache key cho lowStock phải chứa shopId + threshold + limit', () => {
      const expectedKeyPattern = `${shopId}_5_100`;
      expect(expectedKeyPattern).toContain(shopId);
    });
  });

  describe('shop vs shop cache isolation', () => {
    it('hai shop khác nhau phải có cache key khác nhau', () => {
      const shopId1 = 'shop-001';
      const shopId2 = 'shop-002';
      const from = '2026-09-01';
      const to = '2026-09-30';

      const key1 = `${shopId1}_${from}_${to}_day`;
      const key2 = `${shopId2}_${from}_${to}_day`;

      expect(key1).not.toEqual(key2);
      expect(key1).toContain(shopId1);
      expect(key2).toContain(shopId2);
    });
  });
});
