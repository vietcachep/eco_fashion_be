import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { AutoPayoutJob, startOfVnDay } from './auto-payout.job';
import type { ShopPayoutService } from './shop-payout.service';

/*
 * Cron chi trả tự động (PLAN-0018): bật/tắt bằng setting, bỏ qua khi PayOS chi chưa cấu hình, kỳ nối tiếp kỳ gần nhất, idempotent (chạy lại cùng ngày = kỳ rỗng),
 * không throw ra ngoài, không chạy chồng, lịch 02:00 Asia/Ho_Chi_Minh.
 */

const NOW = new Date('2026-10-15T19:30:00.000Z'); // 02:30 sáng 16/10 giờ VN
const TODAY_START = new Date('2026-10-15T17:00:00.000Z'); // 00:00 16/10 giờ VN
const DAY = 86_400_000;

function build(o: { enabled?: boolean; configured?: boolean; latest?: Date | null; created?: number } = {}) {
  const payouts = {
    payoutConfigured: o.configured ?? true,
    latestPeriodEnd: jest.fn((): Promise<Date | null> => Promise.resolve(o.latest ?? null)),
    run: jest.fn((_input: { periodStart: Date; periodEnd: Date }, _actor: unknown): Promise<unknown[]> => Promise.resolve(Array.from({ length: o.created ?? 2 }, () => ({})))),
  };
  const system = { settingBool: jest.fn((_key: string): Promise<boolean> => Promise.resolve(o.enabled ?? true)) };
  const job = new AutoPayoutJob(payouts as unknown as ShopPayoutService, system as unknown as SystemQueryApi);
  return { payouts, system, job };
}

describe('AutoPayoutJob', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('startOfVnDay: 00:00 giờ Việt Nam của ngày chứa mốc thời gian', () => {
    expect(startOfVnDay(NOW)).toEqual(TODAY_START);
    expect(startOfVnDay(new Date('2026-10-15T16:59:59.000Z'))).toEqual(new Date(TODAY_START.getTime() - DAY));
  });

  it('chưa có kỳ nào ⇒ kỳ đầu = [00:00 hôm qua, 00:00 hôm nay], chạy với actor hệ thống (null)', async () => {
    const { payouts, system, job } = build();
    const r = await job.runOnce(NOW);
    expect(system.settingBool).toHaveBeenCalledWith(SETTING_KEY.PAYOUT_AUTO_ENABLED);
    expect(r).toEqual({ status: 'ran', periodStart: new Date(TODAY_START.getTime() - DAY), periodEnd: TODAY_START, created: 2 });
    expect(payouts.run).toHaveBeenCalledWith({ periodStart: new Date(TODAY_START.getTime() - DAY), periodEnd: TODAY_START }, null);
  });

  it('đã có kỳ ⇒ kỳ mới nối ngay sau mốc kết thúc kỳ gần nhất', async () => {
    const latest = new Date(TODAY_START.getTime() - 3 * DAY);
    const { payouts, job } = build({ latest });
    await job.runOnce(NOW);
    expect(payouts.run).toHaveBeenCalledWith({ periodStart: latest, periodEnd: TODAY_START }, null);
  });

  it('IDEMPOTENT: kỳ gần nhất đã kết thúc đúng 00:00 hôm nay (lượt trước cùng ngày) ⇒ khoảng rỗng, không gọi run lần hai', async () => {
    const { payouts, job } = build({ latest: TODAY_START });
    expect(await job.runOnce(NOW)).toEqual({ status: 'empty_period' });
    expect(payouts.run).not.toHaveBeenCalled();
    const later = build({ latest: new Date(TODAY_START.getTime() + 3_600_000) });
    expect(await later.job.runOnce(NOW)).toEqual({ status: 'empty_period' });
  });

  it('setting payout.auto_enabled = false ⇒ bỏ qua, không đọc kỳ, không chạy', async () => {
    const { payouts, job } = build({ enabled: false });
    expect(await job.runOnce(NOW)).toEqual({ status: 'disabled' });
    expect(payouts.latestPeriodEnd).not.toHaveBeenCalled();
    expect(payouts.run).not.toHaveBeenCalled();
  });

  it('PayOS chi chưa cấu hình (khoá trống) ⇒ bỏ qua, không chạy', async () => {
    const { payouts, job } = build({ configured: false });
    expect(await job.runOnce(NOW)).toEqual({ status: 'payos_not_configured' });
    expect(payouts.run).not.toHaveBeenCalled();
  });

  it('tick() không bao giờ ném: lỗi chỉ log; cờ chạy được nhả nên lượt sau chạy lại', async () => {
    const { payouts, job } = build();
    payouts.run.mockRejectedValueOnce(new Error('db chết'));
    await expect(job.tick()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    await job.tick();
    expect(payouts.run).toHaveBeenCalledTimes(2);
  });

  it('tick() không chạy chồng khi lượt trước còn chạy', async () => {
    const { payouts, job } = build();
    let release: () => void = () => undefined;
    payouts.run.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const first = job.tick();
    await job.tick(); // chồng ⇒ bỏ qua
    await new Promise((r) => setImmediate(r)); // để lượt đầu tới được run()
    expect(payouts.run).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('lịch: @Cron 02:00 hằng ngày, múi giờ Asia/Ho_Chi_Minh', () => {
    const fn = (AutoPayoutJob.prototype as unknown as Record<string, object>).tick;
    const opts = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', fn) as Record<string, unknown>;
    expect(opts).toMatchObject({ timeZone: 'Asia/Ho_Chi_Minh', name: 'auto-payout' });
    expect(JSON.stringify(opts)).toContain('0 0 2 * * *');
  });
});
