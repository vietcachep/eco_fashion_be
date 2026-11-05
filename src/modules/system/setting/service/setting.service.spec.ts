import type { CacheService } from '@common/cache/cache.service';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { SystemAuditLogService } from '../../audit/system-audit-log.service';
import { SETTING_KEY } from '../../enums/setting-keys';
import { SettingService } from './setting.service';

/*
 * Ghi tham số có khoảng cho phép (PLAN-0022): hạn chót đổi trả không được 0/âm/quá lớn — chặn ngay lúc ghi (400) để không tạo ngày sai hoặc chuyển bước tức thì.
 * Tham số cũ không khai min/max vẫn như trước (chỉ cần là số không âm).
 */
describe('SettingService.update — min/max theo khoá', () => {
  const actor: AuthenticatedActor = { userId: 'admin-1', email: 'a@fitly.vn', roleCode: 'admin', permissionVersion: 1, tokenId: 'j' };

  function build() {
    const upsert = jest.fn((args: { create: { value: unknown } }) => Promise.resolve({ value: args.create.value, updatedAt: new Date() }));
    const tx = { setting: { upsert } };
    const prisma = {
      setting: { findMany: jest.fn(() => Promise.resolve([])) },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    const cache = {
      getOrSet: jest.fn((_spec: unknown, _id: string, loader: () => Promise<unknown>) => loader()),
      delByPrefix: jest.fn(() => Promise.resolve()),
    };
    const audit = { write: jest.fn(() => Promise.resolve()) };
    const svc = new SettingService(prisma as unknown as PrismaService, cache as unknown as CacheService, audit as unknown as SystemAuditLogService);
    return { svc, upsert };
  }

  it.each([
    [SETTING_KEY.RETURN_SHOP_RESPOND_HOURS, 0],
    [SETTING_KEY.RETURN_SHOP_RESPOND_HOURS, 8761],
    [SETTING_KEY.RETURN_SHIP_BACK_DAYS, 0],
    [SETTING_KEY.RETURN_SHIP_BACK_DAYS, 366],
    [SETTING_KEY.RETURN_SHOP_RECEIVE_DAYS, 0],
    [SETTING_KEY.RETURN_ESCALATE_DAYS, 1000],
    [SETTING_KEY.RETURN_NOT_RECEIVED_DAYS, 0],
    [SETTING_KEY.ORDER_SHIPPING_ALERT_DAYS, 0],
    [SETTING_KEY.ORDER_SHIPPING_ALERT_DAYS, 99999],
  ])('%s = %d ⇒ 400 COMMON_VALIDATION_ERROR, không ghi', async (key, value) => {
    const { svc, upsert } = build();
    await expect(svc.update(actor, key, value)).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    [SETTING_KEY.RETURN_SHOP_RESPOND_HOURS, 1],
    [SETTING_KEY.RETURN_SHOP_RESPOND_HOURS, 8760],
    [SETTING_KEY.RETURN_SHIP_BACK_DAYS, 365],
    [SETTING_KEY.ORDER_SHIPPING_ALERT_DAYS, 10],
  ])('%s = %d (trong khoảng) ⇒ ghi được', async (key, value) => {
    const { svc, upsert } = build();
    await expect(svc.update(actor, key, value)).resolves.toMatchObject({ key, value });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('tham số cũ không khai khoảng: 0 vẫn hợp lệ (vd return.window_days = 0 tắt đổi trả); âm bị chặn như trước', async () => {
    const { svc } = build();
    await expect(svc.update(actor, SETTING_KEY.RETURN_WINDOW_DAYS, 0)).resolves.toMatchObject({ value: 0 });
    await expect(svc.update(actor, SETTING_KEY.RETURN_WINDOW_DAYS, -1)).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
  });
});
