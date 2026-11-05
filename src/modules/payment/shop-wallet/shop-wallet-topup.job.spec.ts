import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ShopWalletTopupSettleService } from './shop-wallet-topup-settle.service';
import { WalletTopupJobs } from './shop-wallet-topup.job';

/*
 * Job dò nạp cọc PayOS (PLAN-0041 §6.4 G, WP-3): mỗi 2 phút gọi settle.reconcilePending; cờ chống chạy chồng; lỗi bị nuốt, cờ luôn nhả.
 * Đây là test đơn vị của lớp bọc job (không DB): settle được thay bằng jest.fn có kiểu.
 */

type Summary = { checked: number; credited: number; closed: number };

describe('WalletTopupJobs — job dò nạp cọc PayOS', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const build = () => {
    const settle = { reconcilePending: jest.fn((): Promise<Summary> => Promise.resolve({ checked: 0, credited: 0, closed: 0 })) };
    const jobs = new WalletTopupJobs(settle as unknown as ShopWalletTopupSettleService);
    return { settle, jobs };
  };

  it('[WTJ-01] gọi settle.reconcilePending; không có gì ⇒ im lặng; có ghi có/đóng ⇒ cảnh báo kèm số liệu', async () => {
    const { settle, jobs } = build();
    await expect(jobs.reconcileWalletTopups()).resolves.toEqual({ checked: 0, credited: 0, closed: 0 });
    expect(settle.reconcilePending).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    settle.reconcilePending.mockResolvedValueOnce({ checked: 3, credited: 2, closed: 1 });
    await jobs.reconcileWalletTopups();
    expect(warnSpy).toHaveBeenCalledWith({ checked: 3, credited: 2, closed: 1 }, expect.any(String));
  });

  it('[WTJ-02] lỗi bị nuốt + log (job không làm chết worker); cờ được nhả nên lượt sau vẫn chạy; hai lượt chồng nhau ⇒ chỉ một lượt thật sự chạy', async () => {
    const { settle, jobs } = build();
    settle.reconcilePending.mockRejectedValueOnce(new Error('boom'));
    await expect(jobs.reconcileWalletTopups()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    await jobs.reconcileWalletTopups();
    expect(settle.reconcilePending).toHaveBeenCalledTimes(2);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    settle.reconcilePending.mockImplementationOnce(async (): Promise<Summary> => {
      await gate;
      return { checked: 0, credited: 0, closed: 0 };
    });
    const first = jobs.reconcileWalletTopups();
    const overlapped = await jobs.reconcileWalletTopups();
    expect(overlapped).toBeNull();
    expect(settle.reconcilePending).toHaveBeenCalledTimes(3);
    release();
    await expect(first).resolves.toEqual({ checked: 0, credited: 0, closed: 0 });
  });

  it('[WTJ-03] @Interval = 120000 ms (2 phút) trên reconcileWalletTopups', () => {
    const method = Object.getOwnPropertyDescriptor(WalletTopupJobs.prototype, 'reconcileWalletTopups')?.value as object;
    expect(Reflect.getMetadata('SCHEDULE_INTERVAL_OPTIONS', method)).toEqual({ timeout: 120_000 });
  });
});
