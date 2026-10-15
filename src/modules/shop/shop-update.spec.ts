import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import type { ShopAuditLogService } from './audit/shop-audit-log.service';
import { SHOP_AUDIT, SHOP_ERR, SHOP_EVENT } from './foundation/shop.constants';
import type { ShopOutboxService } from './outbox/shop-outbox.service';
import type { ShopRegistrationService } from './registration/service/shop-registration.service';
import type { ShopRepository, ShopRow } from './shop/repository/shop.repository';
import { ShopService } from './shop/service/shop.service';
import { VN_BANK_BINS, isKnownBankBin } from './shop/service/vn-bank-bins';

/*
 * PATCH /shop/me (vendor sửa hồ sơ + ngân hàng): quy tắc thuần (planUpdate) + luồng transaction với mock
 * (audit CẢ HAI khi đổi cùng lúc, outbox SHOP_BANK_CHANGED không lộ số tài khoản đầy đủ, no-op, BIN lạ).
 */

function makeShopRow(overrides: Partial<ShopRow> = {}): ShopRow {
  return {
    id: 'shop-123',
    code: 'SHOP-001',
    slug: 'test-shop',
    name: 'Test Shop',
    logoUrl: null,
    bannerUrl: null,
    description: null,
    status: 'approved',
    commissionRate: new Prisma.Decimal('10.00'),
    bankCode: '970436',
    bankAccountNumber: '123456789012',
    bankAccountName: 'NGUYEN VAN A',
    ratingAvg: null,
    totalProducts: 0,
    ownerUserId: 'user-123',
    version: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/* Bắt BusinessException và trả mã lỗi (undefined nếu không ném). */
function errorCodeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof BusinessException ? e.errorCode : 'NOT_BUSINESS_EXCEPTION';
  }
  return undefined;
}

describe('ShopService.planUpdate — quy tắc PATCH /shop/me', () => {
  it('chỉ sửa hồ sơ: không đụng ngân hàng', () => {
    const plan = ShopService.planUpdate(makeShopRow(), { name: 'Tên mới', description: 'Mô tả' });

    expect(plan.profile).toEqual({ name: 'Tên mới', description: 'Mô tả' });
    expect(plan.bank).toEqual({});
  });

  it('gửi lại đúng giá trị cũ = không đổi (no-op, không báo thành viên)', () => {
    const plan = ShopService.planUpdate(makeShopRow(), { name: 'Test Shop', bankCode: '970436', bankAccountNumber: '123456789012', bankAccountName: 'NGUYEN VAN A' });

    expect(plan.profile).toEqual({});
    expect(plan.bank).toEqual({});
    expect(plan.unknownBin).toBe(false);
  });

  it('null xoá được logo/banner/mô tả; null trùng giá trị cũ thì bỏ', () => {
    const plan = ShopService.planUpdate(makeShopRow({ logoUrl: 'https://cdn/x.png' }), { logoUrl: null, bannerUrl: null });

    expect(plan.profile).toEqual({ logoUrl: null });
  });

  describe('đổi tài khoản ngân hàng đã khai đủ', () => {
    it('đổi SỐ TÀI KHOẢN mà không gửi tên chủ TK → SHOP_BANK_FIELD_INCOMPLETE', () => {
      expect(errorCodeOf(() => ShopService.planUpdate(makeShopRow(), { bankAccountNumber: '999999999999' }))).toBe(SHOP_ERR.BANK_FIELD_INCOMPLETE);
      expect(SHOP_ERR.BANK_FIELD_INCOMPLETE).toBe('SHOP_BANK_FIELD_INCOMPLETE');
    });

    it('đổi BIN mà không gửi tên chủ TK → SHOP_BANK_FIELD_INCOMPLETE', () => {
      expect(errorCodeOf(() => ShopService.planUpdate(makeShopRow(), { bankCode: '970422' }))).toBe(SHOP_ERR.BANK_FIELD_INCOMPLETE);
    });

    it('đổi số tài khoản + gửi lại tên (dù trùng tên cũ) → hợp lệ, chỉ trường thật sự đổi', () => {
      const plan = ShopService.planUpdate(makeShopRow(), { bankAccountNumber: '999999999999', bankAccountName: 'NGUYEN VAN A' });

      expect(plan.bank).toEqual({ bankAccountNumber: '999999999999' });
    });

    it('đổi tên chủ TK riêng lẻ (số TK/BIN giữ nguyên) → hợp lệ', () => {
      const plan = ShopService.planUpdate(makeShopRow(), { bankAccountName: '  TRAN THI B  ' });

      expect(plan.bank).toEqual({ bankAccountName: 'TRAN THI B' });
    });

    it('tên chủ TK chỉ có khoảng trắng → từ chối', () => {
      expect(errorCodeOf(() => ShopService.planUpdate(makeShopRow(), { bankAccountNumber: '999999999999', bankAccountName: '   ' }))).toBe(SHOP_ERR.BANK_FIELD_INCOMPLETE);
    });
  });

  describe('khai lần đầu / chưa đủ', () => {
    const empty = { bankCode: null, bankAccountNumber: null, bankAccountName: null };

    it('chưa khai gì: gửi thiếu trường → SHOP_BANK_FIELD_INCOMPLETE', () => {
      expect(errorCodeOf(() => ShopService.planUpdate(makeShopRow(empty), { bankCode: '970422', bankAccountNumber: '123456789' }))).toBe(SHOP_ERR.BANK_FIELD_INCOMPLETE);
    });

    it('chưa khai gì: gửi đủ 3 trường → hợp lệ', () => {
      const plan = ShopService.planUpdate(makeShopRow(empty), { bankCode: '970422', bankAccountNumber: '123456789', bankAccountName: 'LE VAN C' });

      expect(plan.bank).toEqual({ bankCode: '970422', bankAccountNumber: '123456789', bankAccountName: 'LE VAN C' });
    });

    it('chưa khai gì và không gửi trường ngân hàng nào → bình thường (sửa hồ sơ)', () => {
      expect(errorCodeOf(() => ShopService.planUpdate(makeShopRow(empty), { name: 'Tên khác' }))).toBeUndefined();
    });
  });

  describe('BIN lạ chỉ là khuyến cáo', () => {
    it('BIN trong danh sách → unknownBin=false', () => {
      expect(ShopService.planUpdate(makeShopRow(), { bankCode: '970422', bankAccountName: 'NGUYEN VAN A' }).unknownBin).toBe(false);
    });

    it('BIN lạ vẫn nhận (không ném) nhưng unknownBin=true', () => {
      const plan = ShopService.planUpdate(makeShopRow(), { bankCode: '123456', bankAccountName: 'NGUYEN VAN A' });

      expect(plan.bank.bankCode).toBe('123456');
      expect(plan.unknownBin).toBe(true);
    });

    it('BIN lạ nhưng KHÔNG đổi (đã có sẵn) → không cờ', () => {
      expect(ShopService.planUpdate(makeShopRow({ bankCode: '123456' }), { name: 'X', bankCode: '123456' }).unknownBin).toBe(false);
    });
  });
});

describe('danh sách BIN ngân hàng VN', () => {
  it('có ít nhất 25 ngân hàng, mọi BIN đúng 6 chữ số', () => {
    const bins = Object.keys(VN_BANK_BINS);
    expect(bins.length).toBeGreaterThanOrEqual(25);
    for (const bin of bins) expect(bin).toMatch(/^\d{6}$/);
  });

  it('nhận ra Vietcombank/MB/Techcombank; BIN lạ và key thừa kế của Object không lọt', () => {
    expect(isKnownBankBin('970436')).toBe(true);
    expect(isKnownBankBin('970422')).toBe(true);
    expect(isKnownBankBin('970407')).toBe(true);
    expect(isKnownBankBin('000000')).toBe(false);
    expect(isKnownBankBin('constructor')).toBe(false);
  });
});

describe('ShopService.updateMe — transaction / audit / outbox', () => {
  const findByIdForUpdate = jest.fn<Promise<ShopRow | null>, Parameters<ShopRepository['findByIdForUpdate']>>();
  const update = jest.fn<Promise<ShopRow>, Parameters<ShopRepository['update']>>();
  const auditWrite = jest.fn<Promise<void>, Parameters<ShopAuditLogService['write']>>();
  const publish = jest.fn<Promise<void>, Parameters<ShopOutboxService['publish']>>();

  const actor: AuthenticatedActor = { userId: 'user-9', email: 'quanly@shop.vn', roleCode: 'shop_owner', permissionVersion: 1, tokenId: 'jti-1' };
  let service: ShopService;
  let current: ShopRow;

  beforeEach(() => {
    jest.resetAllMocks();
    current = makeShopRow();
    findByIdForUpdate.mockImplementation(() => Promise.resolve(current));
    // update trả bản ghi đã áp dữ liệu — giống Prisma trả lại dòng sau update.
    update.mockImplementation((_id, data) => Promise.resolve({ ...current, ...(data as unknown as Partial<ShopRow>) }));
    auditWrite.mockResolvedValue(undefined);
    publish.mockResolvedValue(undefined);

    const prisma = { $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as unknown as PrismaService;
    const repo = { findByIdForUpdate, update } as unknown as ShopRepository;
    const audit = { write: auditWrite } as unknown as ShopAuditLogService;
    const outbox = { publish } as unknown as ShopOutboxService;
    // updateMe không tra chủ shop (response vendor) nên identity chỉ là stub trống.
    service = new ShopService(prisma, repo, audit, outbox, {} as unknown as IdentityQueryApi, {} as unknown as ShopRegistrationService);
  });

  const auditActions = (): string[] => auditWrite.mock.calls.map((c) => c[2].action);

  it('khoá dòng shop (FOR UPDATE) rồi mới kiểm/ghi', async () => {
    await service.updateMe(actor, 'shop-123', { name: 'Tên mới' });

    expect(findByIdForUpdate).toHaveBeenCalledWith('shop-123', expect.anything());
  });

  it('shop không tồn tại → NotFoundException, không ghi gì', async () => {
    findByIdForUpdate.mockResolvedValue(null);

    await expect(service.updateMe(actor, 'shop-x', { name: 'A B' })).rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('chỉ sửa hồ sơ: audit PROFILE_UPDATED, KHÔNG phát SHOP_BANK_CHANGED', async () => {
    await service.updateMe(actor, 'shop-123', { name: 'Tên mới' });

    expect(auditActions()).toEqual([SHOP_AUDIT.PROFILE_UPDATED]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('đổi CẢ hồ sơ và ngân hàng trong một PATCH → audit ghi CẢ HAI, outbox một lần', async () => {
    await service.updateMe(actor, 'shop-123', { name: 'Tên mới', bankAccountNumber: '999999990001', bankAccountName: 'NGUYEN VAN A' });

    expect(auditActions()).toEqual([SHOP_AUDIT.PROFILE_UPDATED, SHOP_AUDIT.BANK_UPDATED]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][1]).toMatchObject({ eventType: SHOP_EVENT.BANK_CHANGED, aggregateId: 'shop-123' });
  });

  it('SHOP_BANK_CHANGED mang ai đổi + 4 số cuối; số tài khoản đầy đủ KHÔNG nằm trong audit lẫn outbox', async () => {
    await service.updateMe(actor, 'shop-123', { bankAccountNumber: '999999990001', bankAccountName: 'NGUYEN VAN A' });

    const payload = publish.mock.calls[0][1].payload;
    expect(payload).toMatchObject({ shopId: 'shop-123', bankAccountLast4: '0001', changedByUserId: 'user-9', changedByEmail: 'quanly@shop.vn', changedFields: ['bankAccountNumber'] });
    const leaked = JSON.stringify([payload, auditWrite.mock.calls.map((c) => [c[2].before, c[2].after])]);
    expect(leaked).not.toContain('999999990001');
    expect(leaked).not.toContain('123456789012');
  });

  it('BIN lạ: vẫn lưu, audit BANK_UPDATED có unknownBin=true', async () => {
    await service.updateMe(actor, 'shop-123', { bankCode: '123456', bankAccountName: 'NGUYEN VAN A' });

    const bankAudit = auditWrite.mock.calls.map((c) => c[2]).find((e) => e.action === SHOP_AUDIT.BANK_UPDATED);
    expect(bankAudit?.after).toMatchObject({ bankCode: '123456', unknownBin: true });
    expect(update).toHaveBeenCalled();
  });

  it('BIN quen thuộc: audit KHÔNG có cờ unknownBin', async () => {
    await service.updateMe(actor, 'shop-123', { bankCode: '970422', bankAccountName: 'NGUYEN VAN A' });

    const bankAudit = auditWrite.mock.calls.map((c) => c[2]).find((e) => e.action === SHOP_AUDIT.BANK_UPDATED);
    expect(bankAudit?.after).not.toHaveProperty('unknownBin');
  });

  it('đổi số tài khoản thiếu tên chủ TK → SHOP_BANK_FIELD_INCOMPLETE, không ghi gì', async () => {
    await expect(service.updateMe(actor, 'shop-123', { bankAccountNumber: '999999990001' })).rejects.toMatchObject({ errorCode: 'SHOP_BANK_FIELD_INCOMPLETE' });
    expect(update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('no-op (gửi lại giá trị cũ): không update/audit/outbox, trả bản ghi hiện có', async () => {
    const r = await service.updateMe(actor, 'shop-123', { name: 'Test Shop', bankCode: '970436', bankAccountNumber: '123456789012', bankAccountName: 'NGUYEN VAN A' });

    expect(r.name).toBe('Test Shop');
    expect(update).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
