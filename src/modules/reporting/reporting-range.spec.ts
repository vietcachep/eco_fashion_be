import { BusinessException } from '@common/exception/business.exception';
import { assertReportRange, isRealDay, MAX_REPORT_DAYS, REPORTING_INVALID_RANGE } from './reporting-range';

/* Khoảng ngày báo cáo (dùng chung báo cáo sàn + shop): ngày thật, from ≤ to, trần 400 ngày / 60 tháng. */
describe('reporting-range', () => {
  describe('isRealDay', () => {
    it.each(['2026-09-15', '2024-02-29', '0001-01-01', '9999-12-31'])('%s hợp lệ', (d) => {
      expect(isRealDay(d)).toBe(true);
    });
    it.each(['2026-13-45', '2026-02-30', '2025-02-29', '2026-00-10', '2026-9-5', '20260915', 'abcd-ef-gh', ''])('"%s" không hợp lệ', (d) => {
      expect(isRealDay(d)).toBe(false);
    });
  });

  describe('assertReportRange', () => {
    const fail = (from: string, to: string, g?: 'day' | 'month'): BusinessException => {
      try {
        assertReportRange(from, to, g);
      } catch (e) {
        expect(e).toBeInstanceOf(BusinessException);
        return e as BusinessException;
      }
      throw new Error('Phải ném BusinessException');
    };

    it('chấp nhận khoảng hợp lệ, kể cả from = to', () => {
      expect(() => assertReportRange('2026-09-15', '2026-09-15')).not.toThrow();
      expect(() => assertReportRange('2026-09-01', '2026-09-30', 'month')).not.toThrow();
    });

    it('từ chối ngày không thật / from > to bằng 400 REPORTING_INVALID_RANGE', () => {
      for (const [from, to] of [
        ['2026-13-45', '2026-09-15'],
        ['2026-09-01', '2026-02-30'],
        ['2026-09-15', '2026-09-14'],
      ] as const) {
        const e = fail(from, to);
        expect(e.errorCode).toBe(REPORTING_INVALID_RANGE);
        expect(e.httpStatus).toBe(400);
      }
    });

    it(`trần ${MAX_REPORT_DAYS} ngày: 400 qua, 401 bị chặn`, () => {
      expect(() => assertReportRange('2026-01-01', '2027-02-04', 'day')).not.toThrow(); // đúng 400 ngày
      expect(fail('2026-01-01', '2027-02-05', 'day').errorCode).toBe(REPORTING_INVALID_RANGE); // 401 ngày
    });

    it('trần 60 tháng cho granularity=month', () => {
      expect(() => assertReportRange('2022-01-01', '2026-12-31', 'month')).not.toThrow(); // 60 tháng
      expect(fail('2021-12-31', '2026-12-31', 'month').errorCode).toBe(REPORTING_INVALID_RANGE); // 61 tháng
    });

    it('0001-01-01 → 9999-12-31 bị chặn ở cả hai granularity', () => {
      expect(fail('0001-01-01', '9999-12-31', 'day').errorCode).toBe(REPORTING_INVALID_RANGE);
      expect(fail('0001-01-01', '9999-12-31', 'month').errorCode).toBe(REPORTING_INVALID_RANGE);
    });
  });
});
