import { ReportingService } from './reporting.service';

/* Test quy tắc THUẦN của reporting: kỳ báo cáo, ngày giờ VN. */
describe('reporting — kỳ & ngày VN', () => {
  it('liệt kê ngày/tháng liên tục kể cả kỳ trống', () => {
    expect(ReportingService.periods('2026-09-13', '2026-09-15', 'day')).toEqual(['2026-09-13', '2026-09-14', '2026-09-15']);
    expect(ReportingService.periods('2026-07-15', '2026-09-02', 'month')).toEqual(['2026-07', '2026-08', '2026-09']);
  });
  it('vnDay đổi UTC sang ngày giờ Việt Nam', () => {
    expect(ReportingService.vnDay(new Date('2026-09-15T16:59:00Z'))).toBe('2026-09-15');
    expect(ReportingService.vnDay(new Date('2026-09-15T17:01:00Z'))).toBe('2026-09-16');
  });
});
