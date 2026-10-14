import { Logger } from '@nestjs/common';
import { DailySalesJob } from './reporting-worker.module';
import type { ReportingService } from './reporting.service';

/*
 * Chốt hàng đêm của DailySalesJob: tính lại 14 NGÀY gần nhất (không chỉ hôm qua) để đơn COD thu tiền muộn (tạo ngày 1, `paid` ngày 4)
 * vẫn được tính vào ngày 1; mỗi ngày bọc try/catch riêng.
 */
describe('DailySalesJob.closeRecentDays', () => {
  beforeAll(() => {
    Logger.overrideLogger(false); // bỏ log của job khỏi đầu ra test
  });
  beforeEach(() => {
    // 00:05 giờ VN ngày 16/09/2026 (= 17:05 UTC ngày 15) — đúng lúc cron chạy.
    jest.useFakeTimers({ now: new Date('2026-09-15T17:05:00Z'), doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const makeJob = (recomputeDay: jest.Mock<Promise<unknown>, [string]>): DailySalesJob => new DailySalesJob({ recomputeDay } as unknown as ReportingService);

  it('tính lại 14 ngày liên tiếp kết thúc ở hôm qua (VN), không gồm hôm nay', async () => {
    const recomputeDay = jest.fn<Promise<unknown>, [string]>().mockResolvedValue(undefined);
    await makeJob(recomputeDay).closeRecentDays();

    const days = recomputeDay.mock.calls.map(([d]) => d);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-09-02');
    expect(days[13]).toBe('2026-09-15');
    expect(days).not.toContain('2026-09-16');
  });

  it('một ngày lỗi không chặn các ngày còn lại', async () => {
    const recomputeDay = jest.fn<Promise<unknown>, [string]>().mockImplementation((d) => (d === '2026-09-10' ? Promise.reject(new Error('db lỗi')) : Promise.resolve(undefined)));
    await expect(makeJob(recomputeDay).closeRecentDays()).resolves.toBeUndefined();
    expect(recomputeDay).toHaveBeenCalledTimes(14);
  });
});
