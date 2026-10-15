import { Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ModuleRef } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BusinessException, ConflictException, ForbiddenException, NotFoundException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { PERMISSIONS_KEY } from '@common/security/decorators';
import { RATE_LIMIT_KEY } from '@common/security/rate-limit.guard';
import type { CategoryBrief } from '@modules/catalog/queryapi/catalog.queryapi';
import type { IdentityQueryApi, UserBrief } from '@modules/identity/queryapi/identity.queryapi';
import type { ShopAuditLogService } from '../audit/shop-audit-log.service';
import { SHOP_AUDIT, SHOP_ERR, SHOP_EVENT } from '../foundation/shop.constants';
import type { ShopMemberRepository, ShopMemberRow } from '../member/repository/shop-member.repository';
import type { ShopOutboxService } from '../outbox/shop-outbox.service';
import type { ShopRepository, ShopRow } from '../shop/repository/shop.repository';
import { ShopService } from '../shop/service/shop.service';
import { AdminShopRegistrationController } from './controller/admin-shop-registration.controller';
import { ShopRegistrationController } from './controller/shop-registration.controller';
import { toShopRegistrationResponse } from './mapper/shop-registration.mapper';
import type { ShopRegistrationRepository, ShopRegistrationRow } from './repository/shop-registration.repository';
import { SubmitShopRegistrationRequest } from './request/shop-registration.requests';
import { baseShopSlug, fallbackShopSlug, formatShopCode, nextShopCode, normalizeShopName, normalizeVnPhone, shopCodeNumber, shopSlugCandidate } from './rules/shop-registration.rules';
import { ShopRegistrationService } from './service/shop-registration.service';

/*
 * Tự đăng ký gian hàng (PLAN-0019) — test không DB: luật thuần (SĐT, slug, mã shop), validator của Request DTO, luồng nộp hồ sơ (từng nhánh lỗi +
 * thứ tự khoá/kiểm/ghi), đọc hồ sơ (người nộp/admin), và luồng DUYỆT/TỪ CHỐI qua ShopService.changeStatus (tạo chủ shop + ghi quyết định,
 * không đổi trạng thái khi không tạo được chủ). Phần chạy thật trên DB (khoá advisory, unique, migration) kiểm bằng smoke trên DB cô lập.
 */

const NOW = new Date('2026-10-15T08:00:00.000Z');
const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ROLE = { id: 'role-owner', code: 'shop_owner', name: 'Chủ gian hàng' };
const tx = { marker: 'tx' } as unknown as Tx;

const applicant: AuthenticatedActor = { userId: 'u-applicant', email: 'nguoiban@gmail.com', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-a' };
const staff: AuthenticatedActor = { userId: 'staff-1', email: 'staff@fitly.vn', roleCode: 'admin', permissionVersion: 1, tokenId: 'jti-s' };

function shopRow(overrides: Partial<ShopRow> = {}): ShopRow {
  return {
    id: 'shop-new',
    code: 'SHOP-000019',
    slug: 'xuong-may-moc',
    name: 'Xưởng May Mộc',
    logoUrl: null,
    bannerUrl: null,
    description: null,
    status: 'pending',
    commissionRate: new Prisma.Decimal('10.00'),
    bankCode: null,
    bankAccountNumber: null,
    bankAccountName: null,
    ratingAvg: null,
    totalProducts: 0,
    ownerUserId: applicant.userId,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function regRow(overrides: Partial<ShopRegistrationRow> = {}): ShopRegistrationRow {
  return {
    id: 'reg-1',
    shopId: 'shop-new',
    applicantUserId: applicant.userId,
    representativeName: 'Nguyễn Văn An',
    phone: '0912345678',
    categoryId: CATEGORY_ID,
    categoryName: 'Thời trang nữ',
    description: 'Áo dài may đo',
    termsAcceptedAt: NOW,
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
    createdAt: NOW,
    ...overrides,
  };
}

function memberRow(overrides: Partial<ShopMemberRow> = {}): ShopMemberRow {
  return { id: 'm-new', shopId: 'shop-new', userId: applicant.userId, roleId: OWNER_ROLE.id, status: 'active', createdAt: NOW, updatedAt: NOW, ...overrides };
}

function userBrief(overrides: Partial<UserBrief> = {}): UserBrief {
  return { id: applicant.userId, email: applicant.email, fullName: 'Nguyễn Văn An', phone: null, roleCode: 'customer', status: 'active', emailVerified: true, ...overrides };
}

async function rejection(p: Promise<unknown>): Promise<BusinessException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessException) return e;
    throw e;
  }
  throw new Error('Kỳ vọng ném BusinessException nhưng thao tác lại thành công');
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => {
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------------ dựng service với mock */

function build() {
  const regs = {
    lockApplicant: jest.fn<Promise<void>, Parameters<ShopRegistrationRepository['lockApplicant']>>(),
    lockShopCode: jest.fn<Promise<void>, Parameters<ShopRegistrationRepository['lockShopCode']>>(),
    maxShopCodeNumber: jest.fn<Promise<number>, Parameters<ShopRegistrationRepository['maxShopCodeNumber']>>(),
    shopNameTaken: jest.fn<Promise<boolean>, Parameters<ShopRegistrationRepository['shopNameTaken']>>(),
    findByShopId: jest.fn<Promise<ShopRegistrationRow | null>, Parameters<ShopRegistrationRepository['findByShopId']>>(),
    findLatestByApplicant: jest.fn<Promise<ShopRegistrationRow | null>, Parameters<ShopRegistrationRepository['findLatestByApplicant']>>(),
    create: jest.fn<Promise<ShopRegistrationRow>, Parameters<ShopRegistrationRepository['create']>>(),
    update: jest.fn<Promise<ShopRegistrationRow>, Parameters<ShopRegistrationRepository['update']>>(),
  };
  const shops = {
    findById: jest.fn<Promise<ShopRow | null>, Parameters<ShopRepository['findById']>>(),
    findByIdForUpdate: jest.fn<Promise<ShopRow | null>, Parameters<ShopRepository['findByIdForUpdate']>>(),
    findByOwnerUserId: jest.fn<Promise<ShopRow[]>, Parameters<ShopRepository['findByOwnerUserId']>>(),
    slugExists: jest.fn<Promise<boolean>, Parameters<ShopRepository['slugExists']>>(),
    create: jest.fn<Promise<ShopRow>, Parameters<ShopRepository['create']>>(),
    update: jest.fn<Promise<ShopRow>, Parameters<ShopRepository['update']>>(),
  };
  const members = {
    findActiveByUserId: jest.fn<Promise<ShopMemberRow | null>, Parameters<ShopMemberRepository['findActiveByUserId']>>(),
    countActiveByRole: jest.fn<Promise<number>, Parameters<ShopMemberRepository['countActiveByRole']>>(),
    create: jest.fn<Promise<ShopMemberRow>, Parameters<ShopMemberRepository['create']>>(),
  };
  const identity = {
    findUserBrief: jest.fn<Promise<UserBrief | null>, [string]>(),
    findUserBriefs: jest.fn<Promise<Map<string, UserBrief>>, [string[]]>(),
    findShopRoleByCode: jest.fn<Promise<{ id: string; code: string; name: string } | null>, [string]>(),
  };
  const catalog = { findCategoryById: jest.fn<Promise<CategoryBrief | null>, [string]>() };
  const moduleRef = { get: jest.fn(() => catalog) };
  const auditWrite = jest.fn<Promise<void>, Parameters<ShopAuditLogService['write']>>();
  const publish = jest.fn<Promise<void>, Parameters<ShopOutboxService['publish']>>();

  // Mặc định = đường vui: tài khoản khách active, ngành hoạt động, chưa có shop nào, DB đã có SHOP-000001..000018.
  regs.lockApplicant.mockResolvedValue(undefined);
  regs.lockShopCode.mockResolvedValue(undefined);
  regs.maxShopCodeNumber.mockResolvedValue(18);
  regs.shopNameTaken.mockResolvedValue(false);
  regs.findByShopId.mockResolvedValue(null);
  regs.findLatestByApplicant.mockResolvedValue(null);
  regs.create.mockImplementation((data) => Promise.resolve(regRow({ ...(data as unknown as Partial<ShopRegistrationRow>) })));
  regs.update.mockImplementation((id, data) => Promise.resolve(regRow({ id, ...(data as unknown as Partial<ShopRegistrationRow>) })));
  shops.findById.mockResolvedValue(null);
  shops.findByOwnerUserId.mockResolvedValue([]);
  shops.slugExists.mockResolvedValue(false);
  shops.create.mockImplementation((data) => Promise.resolve(shopRow({ ...(data as unknown as Partial<ShopRow>) })));
  shops.update.mockImplementation((_id, data) => Promise.resolve(shopRow({ ...(data as unknown as Partial<ShopRow>) })));
  members.findActiveByUserId.mockResolvedValue(null);
  members.countActiveByRole.mockResolvedValue(0);
  members.create.mockImplementation((data) => Promise.resolve(memberRow({ ...(data as unknown as Partial<ShopMemberRow>) })));
  identity.findUserBrief.mockResolvedValue(userBrief());
  identity.findShopRoleByCode.mockResolvedValue(OWNER_ROLE);
  catalog.findCategoryById.mockResolvedValue({ id: CATEGORY_ID, slug: 'thoi-trang-nu', name: 'Thời trang nữ', isActive: true, attributeMode: 'legacy_fashion' });
  auditWrite.mockResolvedValue(undefined);
  publish.mockResolvedValue(undefined);

  const prisma = { $transaction: (fn: (t: Tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
  const registrationService = new ShopRegistrationService(
    prisma,
    regs as unknown as ShopRegistrationRepository,
    shops as unknown as ShopRepository,
    members as unknown as ShopMemberRepository,
    { write: auditWrite } as unknown as ShopAuditLogService,
    { publish } as unknown as ShopOutboxService,
    identity as unknown as IdentityQueryApi,
    moduleRef as unknown as ModuleRef,
  );
  const shopService = new ShopService(prisma, shops as unknown as ShopRepository, { write: auditWrite } as unknown as ShopAuditLogService, { publish } as unknown as ShopOutboxService, identity as unknown as IdentityQueryApi, registrationService);
  return { registrationService, shopService, regs, shops, members, identity, catalog, moduleRef, auditWrite, publish };
}

const submitInput = { shopName: 'Xưởng May Mộc', representativeName: 'Nguyễn Văn An', phone: '0912345678', categoryId: CATEGORY_ID, description: 'Áo dài may đo' };

/* ------------------------------------------------------------------ luật thuần */

describe('chuẩn hoá SĐT di động Việt Nam', () => {
  it.each([
    ['0912345678', '0912345678'],
    ['+84912345678', '0912345678'],
    ['84912345678', '0912345678'],
    ['0084912345678', '0912345678'],
    ['091 234 5678', '0912345678'],
    ['091.234.5678', '0912345678'],
    ['+84 (91) 234-5678', '0912345678'],
    ['  0352345678 ', '0352345678'],
    ['0712345678', '0712345678'],
    ['0812345678', '0812345678'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeVnPhone(raw)).toBe(expected);
  });

  it.each([
    ['số bàn 02x', '0281234567'],
    ['đầu số 04x không phải di động', '0412345678'],
    ['thiếu số', '091234567'],
    ['thừa số', '09123456789'],
    ['có chữ', '09123abc78'],
    ['mã quốc gia khác', '+15551234567'],
    ['84 nhưng không đủ 11 số', '8491234567'],
    ['rỗng', ''],
  ])('%s → từ chối (null)', (_label, raw) => {
    expect(normalizeVnPhone(raw)).toBeNull();
  });

  it('idempotent: chuẩn hoá hai lần ra cùng kết quả', () => {
    const once = normalizeVnPhone('+84 912 345 678') as string;
    expect(normalizeVnPhone(once)).toBe(once);
  });
});

describe('slug gian hàng', () => {
  it('bỏ dấu tiếng Việt, đ → d, chỉ a-z0-9 nối bằng gạch ngang', () => {
    expect(baseShopSlug('Xưởng May Mộc')).toBe('xuong-may-moc');
    expect(baseShopSlug('Đồ Đẹp Đà Lạt')).toBe('do-dep-da-lat');
    expect(baseShopSlug('  Shop   A & B!! ')).toBe('shop-a-b');
  });

  it('tên toàn ký tự đặc biệt → "shop"; slug dài bị cắt không để lại gạch ngang cuối', () => {
    expect(baseShopSlug('!!!')).toBe('shop');
    const long = `${'a'.repeat(119)} bbbb`; // ký tự thứ 120 là dấu cách → '-' nằm đúng vị trí cắt
    const slug = baseShopSlug(long);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(120);
  });

  it('hậu tố khi trùng: gốc, -2, -3… ; lùi về slug gắn mã shop khi hết lượt', () => {
    expect(shopSlugCandidate('xuong-may', 1)).toBe('xuong-may');
    expect(shopSlugCandidate('xuong-may', 2)).toBe('xuong-may-2');
    expect(shopSlugCandidate('xuong-may', 3)).toBe('xuong-may-3');
    expect(fallbackShopSlug('xuong-may', 'SHOP-000019')).toBe('xuong-may-shop-000019');
  });

  it('chuẩn hoá tên: cắt đầu/cuối, gộp khoảng trắng', () => {
    expect(normalizeShopName('  Shop   A \t B ')).toBe('Shop A B');
  });

  it('chuẩn hoá tên: chữ tiếng Việt tổ hợp (NFD) và dựng sẵn (NFC) ra cùng một chuỗi — không lách được kiểm trùng tên', () => {
    const nfd = 'Ngô Kế'; // "Ngô Kế" gõ dạng tổ hợp
    const nfc = 'Ngô Kế'; // "Ngô Kế" dựng sẵn

    expect(normalizeShopName(nfd)).toBe(nfc);
    expect(normalizeShopName(nfc)).toBe(nfc);
  });
});

describe('mã gian hàng SHOP-######', () => {
  it('định dạng và đọc lại số', () => {
    expect(formatShopCode(19)).toBe('SHOP-000019');
    expect(shopCodeNumber('SHOP-000018')).toBe(18);
    expect(shopCodeNumber('SHOP-OFFICIAL')).toBeNull();
    expect(shopCodeNumber('SHOP-1234567')).toBeNull();
  });

  it('mã tiếp theo = max + 1 (seed có SHOP-000001..000018 ⇒ SHOP-000019)', () => {
    expect(nextShopCode(18)).toBe('SHOP-000019');
  });

  it('DB chưa có mã nào khớp khuôn: KHÔNG cấp SHOP-000001 (mã cố định của FITLY Official) ⇒ bắt đầu từ SHOP-000002', () => {
    expect(nextShopCode(0)).toBe('SHOP-000002');
  });
});

/* ------------------------------------------------------------------ Request DTO */

describe('SubmitShopRegistrationRequest — validator', () => {
  const valid = { shopName: '  Xưởng   May Mộc ', representativeName: ' Nguyễn Văn An ', phone: '+84 912 345 678', categoryId: CATEGORY_ID, description: '  Áo dài may đo  ', acceptTerms: true };

  async function check(plain: Record<string, unknown>) {
    const dto = plainToInstance(SubmitShopRegistrationRequest, plain);
    const errors = await validate(dto, { whitelist: true });
    return { dto, fields: errors.map((e) => e.property) };
  }

  it('hợp lệ: chuẩn hoá tên (trim + gộp khoảng trắng), SĐT về 0xxxxxxxxx, mô tả trim', async () => {
    const { dto, fields } = await check(valid);

    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ shopName: 'Xưởng May Mộc', representativeName: 'Nguyễn Văn An', phone: '0912345678', description: 'Áo dài may đo', acceptTerms: true });
  });

  it('description tuỳ chọn', async () => {
    const { description: _omit, ...rest } = valid;
    expect((await check(rest)).fields).toEqual([]);
  });

  it.each([
    ['acceptTerms = false', { acceptTerms: false }],
    ['thiếu acceptTerms', { acceptTerms: undefined }],
    ['acceptTerms là chuỗi "true"', { acceptTerms: 'true' }],
  ])('%s ⇒ lỗi acceptTerms', async (_label, override) => {
    const { fields } = await check({ ...valid, ...override });

    expect(fields).toContain('acceptTerms');
  });

  it.each([
    ['tên shop quá ngắn', { shopName: 'ab' }, 'shopName'],
    ['tên shop quá dài', { shopName: 'a'.repeat(101) }, 'shopName'],
    ['tên shop chỉ toàn khoảng trắng', { shopName: '     ' }, 'shopName'],
    ['tên người đại diện quá ngắn', { representativeName: 'A' }, 'representativeName'],
    ['SĐT bàn', { phone: '02812345678' }, 'phone'],
    ['SĐT sai', { phone: 'abcdef' }, 'phone'],
    ['categoryId không phải uuid', { categoryId: 'thoi-trang' }, 'categoryId'],
    ['mô tả > 1000 ký tự', { description: 'x'.repeat(1001) }, 'description'],
  ])('%s ⇒ lỗi %s', async (_label, override, field) => {
    const { fields } = await check({ ...valid, ...override });

    expect(fields).toContain(field);
  });
});

/* ------------------------------------------------------------------ nộp hồ sơ */

describe('ShopRegistrationService.submit', () => {
  it('đường vui: khoá người nộp → kiểm → khoá mã → kiểm tên → mã/slug → Shop(pending) + hồ sơ → audit + outbox, cùng transaction', async () => {
    const h = build();

    const r = await h.registrationService.submit(applicant, { ...submitInput, shopName: '  Xưởng   May Mộc ', phone: '+84 912 345 678' });

    expect(h.regs.lockApplicant).toHaveBeenCalledWith('u-applicant', tx);
    expect(h.regs.lockShopCode).toHaveBeenCalledWith(tx);
    // Thứ tự: khoá người nộp < khoá mã toàn cục < kiểm tên < tạo shop < tạo hồ sơ.
    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    expect(order(h.regs.lockApplicant)).toBeLessThan(order(h.members.findActiveByUserId));
    expect(order(h.members.findActiveByUserId)).toBeLessThan(order(h.regs.lockShopCode));
    expect(order(h.regs.lockShopCode)).toBeLessThan(order(h.regs.shopNameTaken));
    expect(order(h.regs.shopNameTaken)).toBeLessThan(order(h.regs.maxShopCodeNumber));
    expect(order(h.regs.maxShopCodeNumber)).toBeLessThan(order(h.shops.create));
    expect(order(h.shops.create)).toBeLessThan(order(h.regs.create));

    expect(h.regs.shopNameTaken).toHaveBeenCalledWith('Xưởng May Mộc', tx);
    expect(h.shops.create).toHaveBeenCalledWith(
      { code: 'SHOP-000019', slug: 'xuong-may-moc', name: 'Xưởng May Mộc', description: 'Áo dài may đo', status: 'pending', ownerUserId: 'u-applicant', createdBy: 'u-applicant', updatedBy: 'u-applicant' },
      tx,
    );
    expect(h.regs.create).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-new', applicantUserId: 'u-applicant', representativeName: 'Nguyễn Văn An', phone: '0912345678', categoryId: CATEGORY_ID, categoryName: 'Thời trang nữ', description: 'Áo dài may đo', createdBy: 'u-applicant' }),
      tx,
    );
    expect(h.regs.create.mock.calls[0][0].termsAcceptedAt).toBeInstanceOf(Date);
    expect(h.auditWrite).toHaveBeenCalledWith(tx, applicant, expect.objectContaining({ action: SHOP_AUDIT.REGISTRATION_SUBMITTED, entityType: 'shop', entityId: 'shop-new', entityCode: 'SHOP-000019' }));
    expect(h.publish).toHaveBeenCalledWith(tx, expect.objectContaining({ eventType: SHOP_EVENT.REGISTRATION_SUBMITTED, aggregateType: 'shop', aggregateId: 'shop-new', payload: { shopId: 'shop-new', code: 'SHOP-000019', name: 'Xưởng May Mộc', applicantUserId: 'u-applicant' } }));
    // Chưa tạo ShopMember: người nộp CHƯA là thành viên cho tới khi sàn duyệt.
    expect(h.members.create).not.toHaveBeenCalled();

    expect(r).toEqual({
      id: 'reg-1',
      shopId: 'shop-new',
      shopCode: 'SHOP-000019',
      shopName: 'Xưởng May Mộc',
      status: 'pending',
      representativeName: 'Nguyễn Văn An',
      phone: '0912345678',
      category: { id: CATEGORY_ID, name: 'Thời trang nữ' },
      description: 'Áo dài may đo',
      submittedAt: NOW.toISOString(),
      decidedAt: null,
      rejectReason: null,
      canReapply: false,
    });
  });

  it('nội dung audit/outbox KHÔNG chứa SĐT hay tên người đại diện (email người nộp chỉ nằm ở cột actor_email chuẩn của audit)', async () => {
    const h = build();

    await h.registrationService.submit(applicant, submitInput);

    // Chỉ xét phần nội dung do service dựng (entry của audit + event của outbox); `actor` là cột actor_email/actor_user_id chuẩn của mọi dòng audit.
    const written = JSON.stringify([h.auditWrite.mock.calls[0][2], h.publish.mock.calls[0][1]]);
    expect(written).not.toContain('0912345678');
    expect(written).not.toContain('nguoiban@gmail.com');
    expect(written).not.toContain('Nguyễn Văn An');
  });

  it('slug trùng: thử -2, -3… cho tới khi trống', async () => {
    const h = build();
    h.shops.slugExists.mockImplementation((slug) => Promise.resolve(slug === 'xuong-may-moc' || slug === 'xuong-may-moc-2'));

    await h.registrationService.submit(applicant, submitInput);

    expect(h.shops.slugExists.mock.calls.map((c) => c[0])).toEqual(['xuong-may-moc', 'xuong-may-moc-2', 'xuong-may-moc-3']);
    expect(h.shops.create.mock.calls[0][0]).toMatchObject({ slug: 'xuong-may-moc-3' });
  });

  it('hết 50 lượt hậu tố ⇒ slug gắn mã shop', async () => {
    const h = build();
    h.shops.slugExists.mockResolvedValue(true);

    await h.registrationService.submit(applicant, submitInput);

    expect(h.shops.slugExists).toHaveBeenCalledTimes(50);
    expect(h.shops.create.mock.calls[0][0]).toMatchObject({ slug: 'xuong-may-moc-shop-000019' });
  });

  it('mã shop: max hiện có + 1; DB không có mã nào khớp khuôn ⇒ SHOP-000002 (không đụng FITLY Official)', async () => {
    const h = build();
    h.regs.maxShopCodeNumber.mockResolvedValue(0);

    await h.registrationService.submit(applicant, submitInput);

    expect(h.shops.create.mock.calls[0][0]).toMatchObject({ code: 'SHOP-000002' });
  });

  it('mô tả rỗng/toàn khoảng trắng ⇒ lưu null (cả shop lẫn hồ sơ)', async () => {
    const h = build();

    await h.registrationService.submit(applicant, { ...submitInput, description: '   ' });

    expect(h.shops.create.mock.calls[0][0]).toMatchObject({ description: null });
    expect(h.regs.create.mock.calls[0][0]).toMatchObject({ description: null });
  });

  describe('từng nhánh lỗi — không ghi gì', () => {
    function expectNothingWritten(h: ReturnType<typeof build>) {
      expect(h.shops.create).not.toHaveBeenCalled();
      expect(h.regs.create).not.toHaveBeenCalled();
      expect(h.auditWrite).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
    }

    it.each([
      ['nhân viên sàn (vai ≠ customer)', userBrief({ roleCode: 'admin' })],
      ['tài khoản bị khoá', userBrief({ status: 'locked' })],
      ['tài khoản chờ xác minh', userBrief({ status: 'pending_verification' })],
      ['tài khoản không còn tồn tại', null],
    ])('%s ⇒ 403 SHOP_REGISTRATION_NOT_ELIGIBLE, chưa mở transaction', async (_label, user) => {
      const h = build();
      h.identity.findUserBrief.mockResolvedValue(user);

      const e = await rejection(h.registrationService.submit(applicant, submitInput));

      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.errorCode).toBe(SHOP_ERR.REGISTRATION_NOT_ELIGIBLE);
      expect(e.httpStatus).toBe(403);
      expect(h.regs.lockApplicant).not.toHaveBeenCalled();
      expectNothingWritten(h);
    });

    it.each([
      ['ngành hàng không tồn tại', null],
      ['ngành hàng ngừng hoạt động', { id: CATEGORY_ID, slug: 'x', name: 'Ngành cũ', isActive: false, attributeMode: 'dynamic' }],
    ])('%s ⇒ 400 SHOP_REGISTRATION_CATEGORY_INVALID', async (_label, category) => {
      const h = build();
      h.catalog.findCategoryById.mockResolvedValue(category);

      const e = await rejection(h.registrationService.submit(applicant, submitInput));

      expect(e.errorCode).toBe(SHOP_ERR.REGISTRATION_CATEGORY_INVALID);
      expect(e.httpStatus).toBe(400);
      expect(h.catalog.findCategoryById).toHaveBeenCalledWith(CATEGORY_ID);
      expect(h.regs.lockApplicant).not.toHaveBeenCalled();
      expectNothingWritten(h);
    });

    it('đã là thành viên active của một gian hàng ⇒ 409 SHOP_REGISTRATION_ALREADY_MEMBER', async () => {
      const h = build();
      h.members.findActiveByUserId.mockResolvedValue(memberRow({ shopId: 'shop-khac' }));

      const e = await rejection(h.registrationService.submit(applicant, submitInput));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.errorCode).toBe(SHOP_ERR.REGISTRATION_ALREADY_MEMBER);
      expect(h.members.findActiveByUserId).toHaveBeenCalledWith('u-applicant', tx);
      expectNothingWritten(h);
    });

    it('đang có shop chờ duyệt ⇒ 409 SHOP_REGISTRATION_PENDING (shop approved/rejected cũ của họ không chặn)', async () => {
      const h = build();
      h.shops.findByOwnerUserId.mockResolvedValue([shopRow({ id: 'cu-1', status: 'rejected' }), shopRow({ id: 'cu-2', status: 'pending' })]);

      const e = await rejection(h.registrationService.submit(applicant, submitInput));

      expect(e.errorCode).toBe(SHOP_ERR.REGISTRATION_PENDING);
      expect(e.httpStatus).toBe(409);
      expectNothingWritten(h);
    });

    it('từng bị từ chối (chỉ có shop rejected) ⇒ nộp lại được', async () => {
      const h = build();
      h.shops.findByOwnerUserId.mockResolvedValue([shopRow({ id: 'cu-1', status: 'rejected' })]);

      await expect(h.registrationService.submit(applicant, submitInput)).resolves.toMatchObject({ status: 'pending' });
    });

    it('trùng tên với shop đang giữ tên ⇒ 409 SHOP_NAME_TAKEN, chưa sinh mã/slug', async () => {
      const h = build();
      h.regs.shopNameTaken.mockResolvedValue(true);

      const e = await rejection(h.registrationService.submit(applicant, submitInput));

      expect(e.errorCode).toBe(SHOP_ERR.NAME_TAKEN);
      expect(e.httpStatus).toBe(409);
      expect(h.regs.maxShopCodeNumber).not.toHaveBeenCalled();
      expectNothingWritten(h);
    });

    it('chốt unique của DB (P2002 ở shops.code/slug) ⇒ 409 SHOP_CODE_EXISTS để người dùng thử lại', async () => {
      const h = build();
      h.shops.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

      const e = await rejection(h.registrationService.submit(applicant, submitInput));

      expect(e.errorCode).toBe(SHOP_ERR.CODE_EXISTS);
      expect(e.httpStatus).toBe(409);
      expect(h.regs.create).not.toHaveBeenCalled();
    });

    it('lỗi hệ thống không phải unique thì nổi lên nguyên vẹn', async () => {
      const h = build();
      h.shops.create.mockRejectedValue(new Error('connection lost'));

      await expect(h.registrationService.submit(applicant, submitInput)).rejects.toThrow('connection lost');
    });

    it('SĐT không phải di động VN (lưới phòng thủ khi gọi không qua HTTP) ⇒ 400, không đụng DB', async () => {
      const h = build();

      const e = await rejection(h.registrationService.submit(applicant, { ...submitInput, phone: '0281234567' }));

      expect(e.errorCode).toBe(SHOP_ERR.REGISTRATION_PHONE_INVALID);
      expect(h.identity.findUserBrief).not.toHaveBeenCalled();
    });
  });
});

describe('metadata route', () => {
  it('POST /shop/registrations: giới hạn 15 lần/ngày theo user; controller KHÔNG dùng ShopContextGuard (người nộp chưa là thành viên)', () => {
    const submit = Object.getOwnPropertyDescriptor(ShopRegistrationController.prototype, 'submit')?.value as object;

    expect(Reflect.getMetadata(RATE_LIMIT_KEY, submit)).toEqual({ name: 'shop-registration-submit', limit: 15, windowSeconds: 86400, by: 'user' });
    expect(Reflect.getMetadata(GUARDS_METADATA, ShopRegistrationController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, submit)).toBeUndefined();
    expect(Reflect.getMetadata(PERMISSIONS_KEY, submit)).toBeUndefined();
  });

  it('GET /admin/shops/:id/registration đòi quyền supplier.shop.read', () => {
    const get = Object.getOwnPropertyDescriptor(AdminShopRegistrationController.prototype, 'get')?.value as object;

    expect(Reflect.getMetadata(PERMISSIONS_KEY, get)).toEqual(['supplier.shop.read']);
  });
});

/* ------------------------------------------------------------------ đọc hồ sơ */

describe('ShopRegistrationService.getMine — hồ sơ của chính tôi', () => {
  it('chưa từng đăng ký ⇒ null', async () => {
    const h = build();

    await expect(h.registrationService.getMine(applicant)).resolves.toBeNull();
    expect(h.shops.findById).not.toHaveBeenCalled();
  });

  it('chỉ tra theo applicantUserId của người gọi (JWT) — không có đường nhận userId khác', async () => {
    const h = build();
    h.regs.findLatestByApplicant.mockResolvedValue(regRow());
    h.shops.findById.mockResolvedValue(shopRow());

    await h.registrationService.getMine(applicant);

    expect(h.regs.findLatestByApplicant).toHaveBeenCalledTimes(1);
    expect(h.regs.findLatestByApplicant).toHaveBeenCalledWith('u-applicant');
    expect(h.regs.findByShopId).not.toHaveBeenCalled();
  });

  it('chờ duyệt: status pending, chưa có quyết định, không được nộp lại', async () => {
    const h = build();
    h.regs.findLatestByApplicant.mockResolvedValue(regRow());
    h.shops.findById.mockResolvedValue(shopRow({ status: 'pending' }));

    await expect(h.registrationService.getMine(applicant)).resolves.toMatchObject({ status: 'pending', decidedAt: null, rejectReason: null, canReapply: false });
  });

  it('bị từ chối: kèm lý do + ngày quyết định + canReapply = true', async () => {
    const h = build();
    const decidedAt = new Date('2026-10-16T09:00:00.000Z');
    h.regs.findLatestByApplicant.mockResolvedValue(regRow({ decidedAt, decisionReason: 'Mô tả sản phẩm chưa rõ ràng' }));
    h.shops.findById.mockResolvedValue(shopRow({ status: 'rejected' }));

    await expect(h.registrationService.getMine(applicant)).resolves.toMatchObject({ status: 'rejected', decidedAt: decidedAt.toISOString(), rejectReason: 'Mô tả sản phẩm chưa rõ ràng', canReapply: true });
  });

  it('đã duyệt / đang bị khoá: không có rejectReason, không được nộp lại (lý do khoá không chép sang hồ sơ)', async () => {
    const h = build();
    h.regs.findLatestByApplicant.mockResolvedValue(regRow({ decidedAt: NOW, decisionReason: null }));

    h.shops.findById.mockResolvedValue(shopRow({ status: 'approved' }));
    await expect(h.registrationService.getMine(applicant)).resolves.toMatchObject({ status: 'approved', rejectReason: null, canReapply: false });

    h.shops.findById.mockResolvedValue(shopRow({ status: 'suspended' }));
    await expect(h.registrationService.getMine(applicant)).resolves.toMatchObject({ status: 'suspended', rejectReason: null, canReapply: false });
  });

  it('lý do từ chối của hồ sơ chỉ hiện khi shop THỰC SỰ đang rejected', () => {
    const reg = regRow({ decisionReason: 'Lý do cũ' });

    expect(toShopRegistrationResponse(reg, { id: 's', code: 'SHOP-000019', name: 'X', status: 'approved' }).rejectReason).toBeNull();
    expect(toShopRegistrationResponse(reg, { id: 's', code: 'SHOP-000019', name: 'X', status: 'rejected' }).rejectReason).toBe('Lý do cũ');
  });

  it('shop của hồ sơ không còn tra được ⇒ null (không lỗi)', async () => {
    const h = build();
    h.regs.findLatestByApplicant.mockResolvedValue(regRow());
    h.shops.findById.mockResolvedValue(null);

    await expect(h.registrationService.getMine(applicant)).resolves.toBeNull();
  });

  it('ngành hàng thiếu (null) ⇒ category null', () => {
    const r = toShopRegistrationResponse(regRow({ categoryId: null, categoryName: null }), { id: 's', code: 'SHOP-000019', name: 'X', status: 'pending' });

    expect(r.category).toBeNull();
  });
});

describe('ShopRegistrationService.getForShop — nhân viên sàn xem hồ sơ', () => {
  it('kèm người nộp {userId, fullName, email} + SĐT', async () => {
    const h = build();
    h.shops.findById.mockResolvedValue(shopRow());
    h.regs.findByShopId.mockResolvedValue(regRow());
    h.identity.findUserBrief.mockResolvedValue(userBrief({ fullName: 'Nguyễn Văn An', email: 'nguoiban@gmail.com' }));

    const r = await h.registrationService.getForShop('shop-new');

    expect(r).toMatchObject({ shopCode: 'SHOP-000019', phone: '0912345678', applicant: { userId: 'u-applicant', fullName: 'Nguyễn Văn An', email: 'nguoiban@gmail.com' } });
    expect(h.identity.findUserBrief).toHaveBeenCalledWith('u-applicant');
  });

  it('shop không có hồ sơ (seed/admin tạo) ⇒ null, không tra người nộp', async () => {
    const h = build();
    h.shops.findById.mockResolvedValue(shopRow());

    await expect(h.registrationService.getForShop('shop-new')).resolves.toBeNull();
    expect(h.identity.findUserBrief).not.toHaveBeenCalled();
  });

  it('người nộp không còn tra được ⇒ applicant null, vẫn trả hồ sơ', async () => {
    const h = build();
    h.shops.findById.mockResolvedValue(shopRow());
    h.regs.findByShopId.mockResolvedValue(regRow());
    h.identity.findUserBrief.mockResolvedValue(null);

    await expect(h.registrationService.getForShop('shop-new')).resolves.toMatchObject({ applicant: null, representativeName: 'Nguyễn Văn An' });
  });

  it('shop không tồn tại ⇒ 404 SHOP_NOT_FOUND', async () => {
    const h = build();

    const e = await rejection(h.registrationService.getForShop('khong-co'));

    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.errorCode).toBe(SHOP_ERR.NOT_FOUND);
  });
});

/* ------------------------------------------------------------------ duyệt / từ chối (ShopService.changeStatus) */

describe('ShopService.changeStatus — shop do người bán tự đăng ký', () => {
  /* Payload của sự kiện outbox đã phát theo loại (undefined nếu không có). */
  function eventPayload(h: ReturnType<typeof build>, eventType: string) {
    return h.publish.mock.calls.map((c) => c[1]).find((e) => e.eventType === eventType)?.payload;
  }

  function withPendingRegistration(h: ReturnType<typeof build>, shop: Partial<ShopRow> = {}, reg: Partial<ShopRegistrationRow> = {}) {
    h.shops.findByIdForUpdate.mockResolvedValue(shopRow({ status: 'pending', ...shop }));
    h.regs.findByShopId.mockResolvedValue(regRow(reg));
    h.identity.findUserBriefs.mockResolvedValue(new Map([[applicant.userId, userBrief()]]));
  }

  it('DUYỆT: tạo ShopMember shop_owner (active) cho người đăng ký + audit/outbox + ghi quyết định, TRƯỚC khi đổi trạng thái, cùng transaction', async () => {
    const h = build();
    withPendingRegistration(h);

    const r = await h.shopService.changeStatus(staff, 'shop-new', 'approved', null);

    expect(r).toMatchObject({ status: 'approved' });
    expect(h.members.create).toHaveBeenCalledWith({ shopId: 'shop-new', userId: 'u-applicant', roleId: 'role-owner', status: 'active', createdBy: 'staff-1', updatedBy: 'staff-1' }, tx);
    expect(h.regs.lockApplicant).toHaveBeenCalledWith('u-applicant', tx);
    expect(h.identity.findShopRoleByCode).toHaveBeenCalledWith('shop_owner');
    expect(h.auditWrite).toHaveBeenCalledWith(tx, staff, expect.objectContaining({ action: SHOP_AUDIT.MEMBER_ADDED, entityType: 'shop_member', entityId: 'm-new', after: { roleCode: 'shop_owner', restored: false, via: 'registration_approved' } }));
    expect(h.publish).toHaveBeenCalledWith(tx, expect.objectContaining({ eventType: SHOP_EVENT.MEMBER_JOINED, aggregateId: 'shop-new', payload: { shopId: 'shop-new', memberId: 'm-new', roleId: 'role-owner' } }));
    // Thứ tự khoá khi DUYỆT (chống deadlock với submit — plan §6/§7): FOR UPDATE dòng shop → khoá advisory người nộp → kiểm điều kiện → tạo chủ shop.
    const at = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    expect(at(h.shops.findByIdForUpdate)).toBeLessThan(at(h.regs.lockApplicant));
    expect(at(h.regs.lockApplicant)).toBeLessThan(at(h.members.countActiveByRole));
    expect(at(h.regs.lockApplicant)).toBeLessThan(at(h.members.findActiveByUserId));
    expect(at(h.members.findActiveByUserId)).toBeLessThan(at(h.members.create));
    // Chủ shop được tạo TRƯỚC khi trạng thái đổi: lỗi ở bước tạo chủ thì chưa chạm vào shop.
    expect(h.members.create.mock.invocationCallOrder[0]).toBeLessThan(h.shops.update.mock.invocationCallOrder[0]);
    expect(h.shops.update).toHaveBeenCalledWith('shop-new', { status: 'approved', updatedBy: 'staff-1' }, tx);
    // Quyết định đầu tiên được ghi vào hồ sơ (duyệt ⇒ không có lý do).
    expect(h.regs.update).toHaveBeenCalledWith('reg-1', expect.objectContaining({ decisionReason: null, decidedBy: 'staff-1', updatedBy: 'staff-1' }), tx);
    expect(h.regs.update.mock.calls[0][1].decidedAt).toBeInstanceOf(Date);
    // Audit SHOP_APPROVED + outbox SHOP_APPROVED của shop vẫn phát như cũ (kèm ownerUserId để listener thông báo sau này).
    expect(h.auditWrite).toHaveBeenCalledWith(tx, staff, expect.objectContaining({ action: SHOP_AUDIT.APPROVED }));
    expect(eventPayload(h, SHOP_EVENT.APPROVED)).toMatchObject({ shopId: 'shop-new', ownerUserId: 'u-applicant', viaRegistration: true });
  });

  it.each([
    ['đã thuộc shop KHÁC', userBrief(), memberRow({ shopId: 'shop-khac' })],
    ['tài khoản bị khoá', userBrief({ status: 'locked' }), null],
    ['không còn là tài khoản khách hàng', userBrief({ roleCode: 'sales' }), null],
    ['tài khoản không còn tồn tại', null, null],
  ])('DUYỆT khi người đăng ký %s ⇒ 409 SHOP_OWNER_UNAVAILABLE, KHÔNG đổi trạng thái/không ghi gì', async (_label, user, activeElsewhere) => {
    const h = build();
    withPendingRegistration(h);
    h.identity.findUserBrief.mockResolvedValue(user);
    h.members.findActiveByUserId.mockResolvedValue(activeElsewhere);

    const e = await rejection(h.shopService.changeStatus(staff, 'shop-new', 'approved', null));

    expect(e).toBeInstanceOf(ConflictException);
    expect(e.errorCode).toBe(SHOP_ERR.OWNER_UNAVAILABLE);
    expect(e.httpStatus).toBe(409);
    expect(h.members.create).not.toHaveBeenCalled();
    expect(h.shops.update).not.toHaveBeenCalled();
    expect(h.regs.update).not.toHaveBeenCalled();
    expect(h.auditWrite).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('DUYỆT đua với shop khác ở chốt unique uq_shop_members_one_active_per_user (P2002) ⇒ cũng 409 SHOP_OWNER_UNAVAILABLE, không đổi trạng thái', async () => {
    const h = build();
    withPendingRegistration(h);
    h.members.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    const e = await rejection(h.shopService.changeStatus(staff, 'shop-new', 'approved', null));

    expect(e.errorCode).toBe(SHOP_ERR.OWNER_UNAVAILABLE);
    expect(h.shops.update).not.toHaveBeenCalled();
    expect(h.regs.update).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('lỗi hệ thống khi tạo chủ shop (không phải unique) nổi lên nguyên vẹn', async () => {
    const h = build();
    withPendingRegistration(h);
    h.members.create.mockRejectedValue(new Error('connection lost'));

    await expect(h.shopService.changeStatus(staff, 'shop-new', 'approved', null)).rejects.toThrow('connection lost');
    expect(h.shops.update).not.toHaveBeenCalled();
  });

  it('thiếu vai shop_owner trong catalog ⇒ 409 SHOP_OWNER_UNAVAILABLE (không duyệt shop không có chủ)', async () => {
    const h = build();
    withPendingRegistration(h);
    h.identity.findShopRoleByCode.mockResolvedValue(null);

    const e = await rejection(h.shopService.changeStatus(staff, 'shop-new', 'approved', null));

    expect(e.errorCode).toBe(SHOP_ERR.OWNER_UNAVAILABLE);
    expect(h.shops.update).not.toHaveBeenCalled();
  });

  it('shop đã có chủ active (dữ liệu dựng tay) ⇒ không tạo thêm thành viên, vẫn duyệt + ghi quyết định', async () => {
    const h = build();
    withPendingRegistration(h);
    h.members.countActiveByRole.mockResolvedValue(1);

    const r = await h.shopService.changeStatus(staff, 'shop-new', 'approved', null);

    expect(r).toMatchObject({ status: 'approved' });
    expect(h.members.create).not.toHaveBeenCalled();
    expect(h.regs.update).toHaveBeenCalledTimes(1);
  });

  it('TỪ CHỐI: chép lý do vào hồ sơ, KHÔNG tạo thành viên, không tra tài khoản người đăng ký', async () => {
    const h = build();
    withPendingRegistration(h);

    const r = await h.shopService.changeStatus(staff, 'shop-new', 'rejected', 'Hồ sơ chưa rõ nguồn hàng');

    expect(r).toMatchObject({ status: 'rejected' });
    expect(h.regs.update).toHaveBeenCalledWith('reg-1', expect.objectContaining({ decisionReason: 'Hồ sơ chưa rõ nguồn hàng', decidedBy: 'staff-1' }), tx);
    expect(h.members.create).not.toHaveBeenCalled();
    expect(h.members.findActiveByUserId).not.toHaveBeenCalled();
    expect(h.identity.findShopRoleByCode).not.toHaveBeenCalled();
    expect(h.shops.update).toHaveBeenCalledWith('shop-new', { status: 'rejected', updatedBy: 'staff-1' }, tx);
    expect(eventPayload(h, SHOP_EVENT.REJECTED)).toMatchObject({ reason: 'Hồ sơ chưa rõ nguồn hàng', ownerUserId: 'u-applicant' });
  });

  it('MỞ KHOÁ (suspended → approved) shop có hồ sơ: KHÔNG tạo thành viên, KHÔNG ghi đè quyết định đầu tiên', async () => {
    const h = build();
    h.shops.findByIdForUpdate.mockResolvedValue(shopRow({ status: 'suspended' }));
    h.regs.findByShopId.mockResolvedValue(regRow({ decidedAt: NOW, decidedBy: 'staff-0' }));
    h.identity.findUserBriefs.mockResolvedValue(new Map());

    const r = await h.shopService.changeStatus(staff, 'shop-new', 'approved', null);

    expect(r).toMatchObject({ status: 'approved' });
    expect(h.members.create).not.toHaveBeenCalled();
    expect(h.identity.findShopRoleByCode).not.toHaveBeenCalled();
    expect(h.regs.update).not.toHaveBeenCalled();
  });

  it('KHOÁ (approved → suspended) không ghi đè quyết định đầu tiên của hồ sơ', async () => {
    const h = build();
    h.shops.findByIdForUpdate.mockResolvedValue(shopRow({ status: 'approved' }));
    h.regs.findByShopId.mockResolvedValue(regRow({ decidedAt: NOW, decidedBy: 'staff-0' }));
    h.identity.findUserBriefs.mockResolvedValue(new Map());

    await h.shopService.changeStatus(staff, 'shop-new', 'suspended', 'Bán hàng giả');

    expect(h.regs.update).not.toHaveBeenCalled();
    expect(h.members.create).not.toHaveBeenCalled();
  });

  it('shop seed/admin tạo (KHÔNG có hồ sơ): duyệt/từ chối giữ hành vi cũ — không tạo thành viên, không ghi hồ sơ', async () => {
    const h = build();
    h.shops.findByIdForUpdate.mockResolvedValue(shopRow({ status: 'pending', ownerUserId: 'u-seed-owner' }));
    h.regs.findByShopId.mockResolvedValue(null);
    h.identity.findUserBriefs.mockResolvedValue(new Map());

    await h.shopService.changeStatus(staff, 'shop-new', 'approved', null);

    expect(h.members.create).not.toHaveBeenCalled();
    expect(h.members.findActiveByUserId).not.toHaveBeenCalled();
    expect(h.identity.findShopRoleByCode).not.toHaveBeenCalled();
    expect(h.regs.update).not.toHaveBeenCalled();
    expect(eventPayload(h, SHOP_EVENT.APPROVED)).toMatchObject({ viaRegistration: false });
  });

  it('chuyển trạng thái không hợp lệ ⇒ lỗi trước khi đụng tới hồ sơ/thành viên', async () => {
    const h = build();
    h.shops.findByIdForUpdate.mockResolvedValue(shopRow({ status: 'rejected' }));

    const e = await rejection(h.shopService.changeStatus(staff, 'shop-new', 'approved', null));

    expect(e.errorCode).toBe(SHOP_ERR.INVALID_TRANSITION);
    expect(h.regs.findByShopId).not.toHaveBeenCalled();
    expect(h.members.create).not.toHaveBeenCalled();
  });
});
