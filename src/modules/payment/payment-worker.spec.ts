import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { PaymentJobs } from './payment-worker.module';
import type { PaymentService } from './payment/payment.service';

/*
 * Test job của payment worker. PLAN-0018 đã bỏ listener ví COD + job bù hoa hồng COD (sàn thu COD, hoa hồng trừ ở đối soát chi trả),
 * nên chỉ còn job phục hồi refund treo. Cron chi trả tự động có spec riêng: shop-payout/auto-payout.job.spec.ts.
 */

describe('PaymentJobs.recoverStuckRefunds — job phục hồi refund treo', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  type Recovered = { finalized: number; released: number; flagged: number };
  const build = () => {
    const payments = { recoverStuckRefunds: jest.fn((): Promise<Recovered> => Promise.resolve({ finalized: 0, released: 0, flagged: 0 })) };
    const jobs = new PaymentJobs(payments as unknown as PaymentService);
    return { payments, jobs };
  };

  it('gọi PaymentService.recoverStuckRefunds; không có gì để phục hồi ⇒ im lặng', async () => {
    const { payments, jobs } = build();
    await jobs.recoverStuckRefunds();
    expect(payments.recoverStuckRefunds).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('có refund được phục hồi ⇒ cảnh báo kèm số liệu', async () => {
    const { payments, jobs } = build();
    payments.recoverStuckRefunds.mockResolvedValue({ finalized: 2, released: 1, flagged: 1 });
    await jobs.recoverStuckRefunds();
    expect(warnSpy).toHaveBeenCalledWith({ finalized: 2, released: 1, flagged: 1 }, 'Đã phục hồi refund treo');
  });

  it('lỗi bị nuốt + log, cờ chạy được nhả nên lượt sau vẫn chạy; không chạy chồng', async () => {
    const { payments, jobs } = build();
    payments.recoverStuckRefunds.mockRejectedValueOnce(new Error('db chết'));
    await expect(jobs.recoverStuckRefunds()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    let release: () => void = () => undefined;
    payments.recoverStuckRefunds.mockImplementationOnce(
      () =>
        new Promise<Recovered>((resolve) => {
          release = () => resolve({ finalized: 0, released: 0, flagged: 0 });
        }),
    );
    const first = jobs.recoverStuckRefunds();
    await jobs.recoverStuckRefunds(); // chồng ⇒ bỏ qua
    expect(payments.recoverStuckRefunds).toHaveBeenCalledTimes(2);
    release();
    await first;
    await jobs.recoverStuckRefunds();
    expect(payments.recoverStuckRefunds).toHaveBeenCalledTimes(3);
  });

  it('chạy mỗi 5 phút (@Interval 300000 ms) — ngắn hơn ngưỡng treo 10 phút để refund treo được xử lý sớm', () => {
    const fn = (PaymentJobs.prototype as unknown as Record<string, object>).recoverStuckRefunds;
    expect(Reflect.getMetadata('SCHEDULE_INTERVAL_OPTIONS', fn)).toEqual({ timeout: 5 * 60_000 });
  });
});
