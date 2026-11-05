import { Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ModuleRef } from '@nestjs/core';
import type { IdentityQueryApi, UserBrief } from '@modules/identity/queryapi/identity.queryapi';
import type { ShopAuditLogService } from './audit/shop-audit-log.service';
import { SHOP_AUDIT, SHOP_BANK_STATUS, SHOP_ERR, SHOP_EVENT } from './foundation/shop.constants';
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
    shippingCarrierEnabled: false,
    shippingPickup: null,
    shippingReturn: null,
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
    bankStatus: 'verified',
    bankVerifiedAt: null,
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
  const findById = jest.fn<Promise<ShopRow | null>, Parameters<ShopRepository['findById']>>();
  const findByIdForUpdate = jest.fn<Promise<ShopRow | null>, Parameters<ShopRepository['findByIdForUpdate']>>();
  const verifyPassword = jest.fn<Promise<boolean>, [string, string]>();
  const isGoogleLinked = jest.fn<Promise<boolean>, [string]>();
  const findUserBriefs = jest.fn<Promise<Map<string, UserBrief>>, [string[]]>();
  const settingNumber = jest.fn<Promise<number>, [string]>();
  const moduleRefGet = jest.fn<{ settingNumber: typeof settingNumber }, [unknown, unknown?]>();
  const update = jest.fn<Promise<ShopRow>, Parameters<ShopRepository['update']>>();
  const auditWrite = jest.fn<Promise<void>, Parameters<ShopAuditLogService['write']>>();
  const publish = jest.fn<Promise<void>, Parameters<ShopOutboxService['publish']>>();

  const actor: AuthenticatedActor = { userId: 'user-9', email: 'quanly@shop.vn', roleCode: 'shop_owner', permissionVersion: 1, tokenId: 'jti-1' };
  let service: ShopService;
  let current: ShopRow;
  const PASSWORD = 'MatKhau-Hien-Tai-1';
  /* Chủ shop (ownerUserId của makeShopRow = 'user-123') — tên có dấu, khớp 'NGUYEN VAN A' sau chuẩn hoá. */
  const ownerBrief: UserBrief = { id: 'user-123', email: 'chu.shop@fitly.vn', fullName: 'Nguyễn Văn A', phone: null, roleCode: 'customer', status: 'active', emailVerified: true };

  beforeEach(() => {
    jest.resetAllMocks();
    current = makeShopRow();
    findById.mockImplementation(() => Promise.resolve(current));
    findByIdForUpdate.mockImplementation(() => Promise.resolve(current));
    verifyPassword.mockResolvedValue(true);
    isGoogleLinked.mockResolvedValue(false);
    findUserBriefs.mockImplementation((ids) => Promise.resolve(new Map(ids.filter((id) => id === ownerBrief.id).map((id) => [id, ownerBrief]))));
    settingNumber.mockResolvedValue(72);
    moduleRefGet.mockReturnValue({ settingNumber });
    // update trả bản ghi đã áp dữ liệu — giống Prisma trả lại dòng sau update.
    update.mockImplementation((_id, data) => Promise.resolve({ ...current, ...(data as unknown as Partial<ShopRow>) }));
    auditWrite.mockResolvedValue(undefined);
    publish.mockResolvedValue(undefined);

    const prisma = { $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as unknown as PrismaService;
    const repo = { findById, findByIdForUpdate, update } as unknown as ShopRepository;
    const audit = { write: auditWrite } as unknown as ShopAuditLogService;
    const outbox = { publish } as unknown as ShopOutboxService;
    // updateMe không tra chủ shop cho response vendor; identity dùng để xác thực lại mật khẩu (AUD-03), nhận ra tài khoản Google (5.3) và lấy tên chủ shop để so khớp tên chủ TK (5.2).
    // SystemQueryApi lấy lười qua ModuleRef (số giờ giữ chi trả sau đổi TK, 5.4).
    service = new ShopService(prisma, repo, audit, outbox, { verifyPassword, isGoogleLinked, findUserBriefs } as unknown as IdentityQueryApi, {} as unknown as ShopRegistrationService, { get: moduleRefGet } as unknown as ModuleRef);
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
    await service.updateMe(actor, 'shop-123', { name: 'Tên mới', bankAccountNumber: '999999990001', bankAccountName: 'NGUYEN VAN A', currentPassword: PASSWORD });

    expect(auditActions()).toEqual([SHOP_AUDIT.PROFILE_UPDATED, SHOP_AUDIT.BANK_UPDATED]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][1]).toMatchObject({ eventType: SHOP_EVENT.BANK_CHANGED, aggregateId: 'shop-123' });
  });

  it('SHOP_BANK_CHANGED mang ai đổi + 4 số cuối; số tài khoản đầy đủ KHÔNG nằm trong audit lẫn outbox', async () => {
    await service.updateMe(actor, 'shop-123', { bankAccountNumber: '999999990001', bankAccountName: 'NGUYEN VAN A', currentPassword: PASSWORD });

    const payload = publish.mock.calls[0][1].payload;
    expect(payload).toMatchObject({ shopId: 'shop-123', bankAccountLast4: '0001', changedByUserId: 'user-9', changedByEmail: 'quanly@shop.vn', changedFields: ['bankAccountNumber'] });
    const leaked = JSON.stringify([payload, auditWrite.mock.calls.map((c) => [c[2].before, c[2].after])]);
    expect(leaked).not.toContain('999999990001');
    expect(leaked).not.toContain('123456789012');
  });

  it('BIN lạ: vẫn lưu, audit BANK_UPDATED có unknownBin=true', async () => {
    await service.updateMe(actor, 'shop-123', { bankCode: '123456', bankAccountName: 'NGUYEN VAN A', currentPassword: PASSWORD });

    const bankAudit = auditWrite.mock.calls.map((c) => c[2]).find((e) => e.action === SHOP_AUDIT.BANK_UPDATED);
    expect(bankAudit?.after).toMatchObject({ bankCode: '123456', unknownBin: true });
    expect(update).toHaveBeenCalled();
  });

  it('BIN quen thuộc: audit KHÔNG có cờ unknownBin', async () => {
    await service.updateMe(actor, 'shop-123', { bankCode: '970422', bankAccountName: 'NGUYEN VAN A', currentPassword: PASSWORD });

    const bankAudit = auditWrite.mock.calls.map((c) => c[2]).find((e) => e.action === SHOP_AUDIT.BANK_UPDATED);
    expect(bankAudit?.after).not.toHaveProperty('unknownBin');
  });

  it('đổi số tài khoản thiếu tên chủ TK → SHOP_BANK_FIELD_INCOMPLETE, không ghi gì', async () => {
    await expect(service.updateMe(actor, 'shop-123', { bankAccountNumber: '999999990001' })).rejects.toMatchObject({ errorCode: 'SHOP_BANK_FIELD_INCOMPLETE' });
    expect(update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  describe('AUD-03 — đổi tài khoản ngân hàng phải nhập lại mật khẩu', () => {
    const newBank = { bankAccountNumber: '999999990001', bankAccountName: 'NGUYEN VAN A' };

    it('thiếu mật khẩu → SHOP_BANK_PASSWORD_REQUIRED (400), không kiểm mật khẩu, không ghi/audit/phát sự kiện', async () => {
      await expect(service.updateMe(actor, 'shop-123', newBank)).rejects.toMatchObject({ errorCode: 'SHOP_BANK_PASSWORD_REQUIRED', httpStatus: 400 });
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(auditWrite).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });

    it('sai mật khẩu → SHOP_BANK_PASSWORD_INVALID (400), không ghi/audit/phát sự kiện', async () => {
      verifyPassword.mockResolvedValue(false);

      await expect(service.updateMe(actor, 'shop-123', { ...newBank, currentPassword: 'sai-mat-khau' })).rejects.toMatchObject({ errorCode: 'SHOP_BANK_PASSWORD_INVALID', httpStatus: 400 });
      expect(verifyPassword).toHaveBeenCalledWith('user-9', 'sai-mat-khau'); // kiểm đúng mật khẩu CỦA NGƯỜI THAO TÁC, không phải của chủ shop
      expect(update).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });

    it('đúng mật khẩu → đổi được; audit BANK_UPDATED ghi reauthenticated và KHÔNG chứa mật khẩu', async () => {
      await service.updateMe(actor, 'shop-123', { ...newBank, currentPassword: PASSWORD });

      const bankAudit = auditWrite.mock.calls.map((c) => c[2]).find((e) => e.action === SHOP_AUDIT.BANK_UPDATED);
      expect(bankAudit?.after).toMatchObject({ reauthenticated: true });
      expect(JSON.stringify([update.mock.calls, auditWrite.mock.calls, publish.mock.calls])).not.toContain(PASSWORD);
    });

    it('chỉ sửa hồ sơ (không đổi bank) → KHÔNG cần mật khẩu', async () => {
      await service.updateMe(actor, 'shop-123', { name: 'Tên mới' });

      expect(verifyPassword).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('gửi lại đúng tài khoản cũ (không đổi) → KHÔNG cần mật khẩu', async () => {
      await service.updateMe(actor, 'shop-123', { bankCode: '970436', bankAccountNumber: '123456789012', bankAccountName: 'NGUYEN VAN A' });

      expect(verifyPassword).not.toHaveBeenCalled();
    });

    it('race: lúc kiểm trước bank chưa đổi nhưng bản ghi đã khoá cho thấy bank vừa bị người khác đổi → vẫn đòi mật khẩu, không ghi', async () => {
      findById.mockResolvedValue(makeShopRow({ bankAccountNumber: '999999990001' })); // bản đọc không khoá: đã trùng giá trị gửi lên ⇒ "không đổi"
      findByIdForUpdate.mockResolvedValue(current); // bản khoá: bank khác ⇒ thực sự đổi

      await expect(service.updateMe(actor, 'shop-123', newBank)).rejects.toMatchObject({ errorCode: 'SHOP_BANK_PASSWORD_REQUIRED' });
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('PLAN-0040 5.3 — tài khoản đăng nhập Google (mật khẩu ngẫu nhiên, không ai biết)', () => {
    const newBank = { bankAccountNumber: '999999990001', bankAccountName: 'NGUYEN VAN A' };

    it('[STL-11h] sai mật khẩu + tài khoản gắn Google ⇒ vẫn 400 SHOP_BANK_PASSWORD_INVALID nhưng kèm details.googleLinked="true" và gợi ý Quên mật khẩu', async () => {
      verifyPassword.mockResolvedValue(false);
      isGoogleLinked.mockResolvedValue(true);

      const err = await service.updateMe(actor, 'shop-123', { ...newBank, currentPassword: 'khong-biet' }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BusinessException);
      expect(err).toMatchObject({ errorCode: 'SHOP_BANK_PASSWORD_INVALID', httpStatus: 400, details: { googleLinked: 'true' } });
      expect((err as BusinessException).message).toContain('Quên mật khẩu');
      expect(isGoogleLinked).toHaveBeenCalledWith('user-9'); // đúng người đang thao tác
      expect(update).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });

    it('sai mật khẩu + KHÔNG gắn Google ⇒ lỗi mật khẩu thường, không có details.googleLinked', async () => {
      verifyPassword.mockResolvedValue(false);

      const err = await service.updateMe(actor, 'shop-123', { ...newBank, currentPassword: 'sai' }).catch((e: unknown) => e);

      expect(err).toMatchObject({ errorCode: 'SHOP_BANK_PASSWORD_INVALID', httpStatus: 400, details: {} });
      expect((err as BusinessException).message).not.toContain('Google');
    });

    it('tra cờ Google lỗi ⇒ vẫn trả 400 SHOP_BANK_PASSWORD_INVALID (lỗi tra cứu không che lỗi mật khẩu)', async () => {
      verifyPassword.mockResolvedValue(false);
      isGoogleLinked.mockRejectedValue(new Error('db down'));

      await expect(service.updateMe(actor, 'shop-123', { ...newBank, currentPassword: 'sai' })).rejects.toMatchObject({ errorCode: 'SHOP_BANK_PASSWORD_INVALID', httpStatus: 400 });
    });

    it('nhập đúng mật khẩu ⇒ không cần tra cờ Google', async () => {
      await service.updateMe(actor, 'shop-123', { ...newBank, currentPassword: PASSWORD });

      expect(isGoogleLinked).not.toHaveBeenCalled();
    });
  });

  describe('PLAN-0040 5.2 — so khớp tên chủ TK với tên chủ shop', () => {
    const patchWithName = (name: string) => ({ bankAccountNumber: '999999990001', bankAccountName: name, currentPassword: PASSWORD });
    const updateData = () => update.mock.calls[0][1] as Record<string, unknown>;
    const eventPayload = () => publish.mock.calls[0][1].payload;

    it.each([
      ['NGUYEN VAN A', 'đúng tên IN HOA không dấu'],
      ['  Nguyen   Van A ', 'khác hoa/thường + dư khoảng trắng'],
      ['NGUYỄN VĂN A', 'còn dấu'],
    ])('[STL-11f] tên chủ TK "%s" (%s) KHỚP tên chủ shop "Nguyễn Văn A" ⇒ verified, không chờ xác minh', async (name) => {
      const r = await service.updateMe(actor, 'shop-123', patchWithName(name));

      expect(updateData()).toMatchObject({ bankStatus: SHOP_BANK_STATUS.VERIFIED, bankVerifiedAt: null });
      expect(r.bankStatus).toBe('verified');
      expect(eventPayload()).toMatchObject({ bankPendingVerification: false });
      const bankAudit = auditWrite.mock.calls.map((c) => c[2]).find((e) => e.action === SHOP_AUDIT.BANK_UPDATED);
      expect(bankAudit?.after).toMatchObject({ bankStatus: 'verified', nameMatchesOwner: true });
    });

    it('[STL-11d] tên chủ TK LỆCH tên chủ shop ⇒ pending_verification (kỳ chi sẽ held), audit + sự kiện báo rõ để báo quản lý', async () => {
      const r = await service.updateMe(actor, 'shop-123', patchWithName('KE GIAN LAN'));

      expect(updateData()).toMatchObject({ bankStatus: SHOP_BANK_STATUS.PENDING, bankVerifiedAt: null });
      expect(r.bankStatus).toBe('pending_verification');
      expect(eventPayload()).toMatchObject({ bankPendingVerification: true, ownerUserId: 'user-123', holdHours: 72 });
      expect(typeof eventPayload().changedAt).toBe('string');
      const bankAudit = auditWrite.mock.calls.map((c) => c[2]).find((e) => e.action === SHOP_AUDIT.BANK_UPDATED);
      expect(bankAudit?.after).toMatchObject({ bankStatus: 'pending_verification', nameMatchesOwner: false, reauthenticated: true });
      expect(findUserBriefs).toHaveBeenCalledWith(['user-123']); // so với fullName của CHỦ SHOP, không phải tên shop
    });

    it('tên chủ TK trùng TÊN SHOP nhưng không phải tên chủ shop ⇒ vẫn lệch (so với người, không so với tên cửa hàng)', async () => {
      await service.updateMe(actor, 'shop-123', patchWithName('TEST SHOP'));

      expect(updateData()).toMatchObject({ bankStatus: 'pending_verification' });
    });

    it('chủ shop không tra được (tài khoản bị xoá) ⇒ không đủ căn cứ ⇒ chờ xác minh', async () => {
      findUserBriefs.mockResolvedValue(new Map());

      await service.updateMe(actor, 'shop-123', patchWithName('NGUYEN VAN A'));

      expect(updateData()).toMatchObject({ bankStatus: 'pending_verification' });
    });

    it('chỉ đổi số TK (tên chủ TK gửi lại y nguyên và khớp) ⇒ verified', async () => {
      await service.updateMe(actor, 'shop-123', patchWithName('NGUYEN VAN A'));

      expect(updateData()).toMatchObject({ bankAccountNumber: '999999990001', bankStatus: 'verified' });
    });

    it('TK đang chờ xác minh, chủ shop đổi sang TK khớp tên ⇒ về verified và xoá mốc xác minh cũ', async () => {
      current = makeShopRow({ bankAccountName: 'KE GIAN LAN', bankStatus: 'pending_verification', bankVerifiedAt: null });

      await service.updateMe(actor, 'shop-123', patchWithName('NGUYEN VAN A'));

      expect(updateData()).toMatchObject({ bankStatus: 'verified', bankVerifiedAt: null });
    });

    it('TK đã được quản lý xác minh, chủ shop đổi tiếp sang TK lệch ⇒ chờ xác minh lại (xác minh của TK cũ không áp cho TK mới)', async () => {
      current = makeShopRow({ bankAccountName: 'KE GIAN LAN', bankStatus: 'verified', bankVerifiedAt: new Date('2026-10-01T00:00:00.000Z') });

      await service.updateMe(actor, 'shop-123', patchWithName('NGUOI KHAC'));

      expect(updateData()).toMatchObject({ bankStatus: 'pending_verification', bankVerifiedAt: null });
    });

    it('chỉ sửa hồ sơ ⇒ KHÔNG tra chủ shop, KHÔNG đụng trạng thái xác minh TK', async () => {
      current = makeShopRow({ bankStatus: 'pending_verification' });

      await service.updateMe(actor, 'shop-123', { name: 'Tên mới' });

      expect(findUserBriefs).not.toHaveBeenCalled();
      expect(updateData()).not.toHaveProperty('bankStatus');
      expect(updateData()).not.toHaveProperty('bankVerifiedAt');
    });
  });

  describe('PLAN-0040 5.4 — số giờ giữ chi trả hiển thị đúng (setting, không ghi cứng)', () => {
    it('[STL-11i] GET /shop/me (getMe) trả bankChangeHoldHours = setting payout.bank_change_hold_hours', async () => {
      settingNumber.mockResolvedValue(48);

      const me = await service.getMe('shop-123');

      expect(me.bankChangeHoldHours).toBe(48);
      expect(settingNumber).toHaveBeenCalledWith('payout.bank_change_hold_hours');
    });

    it('mặc định 72 (không phải 24 như FE từng ghi cứng)', async () => {
      const me = await service.getMe('shop-123');

      expect(me.bankChangeHoldHours).toBe(72);
    });

    it('PATCH /shop/me trả cùng giá trị trong response (FE hiện đúng số giờ ngay sau khi đổi)', async () => {
      settingNumber.mockResolvedValue(48);

      const r = await service.updateMe(actor, 'shop-123', { name: 'Tên mới' });

      expect(r.bankChangeHoldHours).toBe(48);
    });

    it.each([
      ['setting lỗi', () => settingNumber.mockRejectedValue(new Error('redis down'))],
      ['setting không phải số dương', () => settingNumber.mockResolvedValue(0)],
      ['không lấy được SystemQueryApi', () => moduleRefGet.mockImplementation(() => { throw new Error('not found'); })],
    ])('%s ⇒ dùng mặc định 72, KHÔNG làm hỏng phiên vendor', async (_label, arrange) => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      arrange();

      const me = await service.getMe('shop-123');

      expect(me.bankChangeHoldHours).toBe(72);
      expect(me.code).toBe('SHOP-001');
    });

    it('trạng thái + mốc xác minh TK có trong response vendor', async () => {
      current = makeShopRow({ bankStatus: 'pending_verification', bankVerifiedAt: new Date('2026-10-20T03:00:00.000Z') });

      const me = await service.getMe('shop-123');

      expect(me).toMatchObject({ bankStatus: 'pending_verification', bankVerifiedAt: '2026-10-20T03:00:00.000Z' });
    });
  });

  describe('PLAN-0040 5.2 — ShopService.verifyBank (quản lý sàn xác minh TK chờ xác minh)', () => {
    const manager: AuthenticatedActor = { userId: 'mgr-1', email: 'quanly@fitly.vn', roleCode: 'manager', permissionVersion: 1, tokenId: 'jti-m' };
    const pending = () => makeShopRow({ bankAccountName: 'KE GIAN LAN', bankStatus: 'pending_verification', bankVerifiedAt: null });

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      current = pending();
      findUserBriefs.mockImplementation((ids) => Promise.resolve(new Map(ids.filter((id) => id === ownerBrief.id).map((id) => [id, ownerBrief]))));
    });

    it('[STL-11e] xác minh ⇒ bankStatus=verified + bankVerifiedAt=bây giờ (từ đây mới đếm giờ giữ); audit + sự kiện, response có tên chủ shop', async () => {
      const before = Date.now();
      const r = await service.verifyBank(manager, 'shop-123', '123456789012');

      const data = update.mock.calls[0][1] as { bankStatus: string; bankVerifiedAt: Date; updatedBy: string };
      expect(data.bankStatus).toBe('verified');
      expect(data.bankVerifiedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(data.updatedBy).toBe('mgr-1');
      expect(findByIdForUpdate).toHaveBeenCalledWith('shop-123', expect.anything()); // khoá dòng shop
      const verifyAudit = auditWrite.mock.calls.map((c) => c[2]).find((e) => e.action === SHOP_AUDIT.BANK_VERIFIED);
      expect(verifyAudit).toMatchObject({ entityId: 'shop-123', before: { bankStatus: 'pending_verification' }, after: { bankStatus: 'verified' } });
      expect(publish.mock.calls[0][1]).toMatchObject({ eventType: SHOP_EVENT.BANK_VERIFIED, aggregateId: 'shop-123' });
      expect(publish.mock.calls[0][1].payload).toMatchObject({ shopId: 'shop-123', bankAccountLast4: '9012', verifiedByUserId: 'mgr-1', holdHours: 72 });
      expect(r).toMatchObject({ bankStatus: 'verified', ownerName: 'Nguyễn Văn A', bankAccountNumber: '123456789012', bankChangeHoldHours: 72 });
    });

    it('số TK đầy đủ KHÔNG nằm trong audit lẫn sự kiện outbox', async () => {
      await service.verifyBank(manager, 'shop-123', '123456789012');

      expect(JSON.stringify([auditWrite.mock.calls.map((c) => [c[2].before, c[2].after]), publish.mock.calls.map((c) => c[1].payload)])).not.toContain('123456789012');
    });

    it('bỏ trống số TK đang xem ⇒ không kiểm (tương thích), vẫn xác minh được', async () => {
      await expect(service.verifyBank(manager, 'shop-123')).resolves.toMatchObject({ bankStatus: 'verified' });
    });

    it('chủ shop vừa đổi sang TK khác trước khi quản lý bấm ⇒ 409 SHOP_BANK_CHANGED_SINCE, không xác minh nhầm', async () => {
      await expect(service.verifyBank(manager, 'shop-123', '555555555555')).rejects.toMatchObject({ errorCode: 'SHOP_BANK_CHANGED_SINCE', httpStatus: 409 });
      expect(update).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });

    it('TK không ở trạng thái chờ xác minh (đã verified / bấm hai lần) ⇒ 409 SHOP_BANK_NOT_PENDING, không ghi gì', async () => {
      current = makeShopRow({ bankStatus: 'verified' });

      await expect(service.verifyBank(manager, 'shop-123', '123456789012')).rejects.toMatchObject({ errorCode: 'SHOP_BANK_NOT_PENDING', httpStatus: 409 });
      expect(update).not.toHaveBeenCalled();
      expect(auditWrite).not.toHaveBeenCalled();
    });

    it('shop không tồn tại ⇒ NotFound', async () => {
      findByIdForUpdate.mockResolvedValue(null);

      await expect(service.verifyBank(manager, 'shop-x')).rejects.toThrow(NotFoundException);
    });
  });

  it('no-op (gửi lại giá trị cũ): không update/audit/outbox, trả bản ghi hiện có', async () => {
    const r = await service.updateMe(actor, 'shop-123', { name: 'Test Shop', bankCode: '970436', bankAccountNumber: '123456789012', bankAccountName: 'NGUYEN VAN A' });

    expect(r.name).toBe('Test Shop');
    expect(update).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
