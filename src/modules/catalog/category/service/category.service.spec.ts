import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { CacheService } from '@common/cache/cache.service';
import { ConflictException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { StorageService } from '@common/storage/storage.service';
import type { CatalogAuditLogService } from '../../audit/catalog-audit-log.service';
import type { CatalogOutboxService } from '../../outbox/catalog-outbox.service';
import type { CatalogUsageRegistry } from '../../queryapi/catalog-usage.registry';
import type { CategoryRepository, CategoryRow } from '../repository/category.repository';
import { CreateCategoryRequest, UpdateCategoryRequest } from '../request/category.requests';
import { CategoryService } from './category.service';

function row(over: Partial<CategoryRow> = {}): CategoryRow {
  return { id: 'c1', slug: 'dien-thoai', name: 'Điện thoại', description: null, imageUrl: null, imagePublicId: null, parentId: null, sortOrder: 0, isActive: true, productCount: 0, attributeMode: 'dynamic', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...over };
}

const actor: AuthenticatedActor = { userId: 'u1', email: 'u1@vn', roleCode: 'admin', permissionVersion: 1, tokenId: 't1' };

describe('CategoryService — attributeMode (H8)', () => {
  const findById = jest.fn<ReturnType<CategoryRepository['findById']>, Parameters<CategoryRepository['findById']>>();
  const slugExists = jest.fn<ReturnType<CategoryRepository['slugExists']>, Parameters<CategoryRepository['slugExists']>>();
  const create = jest.fn<ReturnType<CategoryRepository['create']>, Parameters<CategoryRepository['create']>>();
  const update = jest.fn<ReturnType<CategoryRepository['update']>, Parameters<CategoryRepository['update']>>();
  const countProductsInCategory = jest.fn<ReturnType<CatalogUsageRegistry['countProductsInCategory']>, Parameters<CatalogUsageRegistry['countProductsInCategory']>>();
  const transaction = jest.fn<Promise<unknown>, [(t: Tx) => Promise<unknown>]>();
  const auditWrite = jest.fn<ReturnType<CatalogAuditLogService['write']>, Parameters<CatalogAuditLogService['write']>>();
  const outboxPublish = jest.fn<ReturnType<CatalogOutboxService['publish']>, Parameters<CatalogOutboxService['publish']>>();
  const tx = {} as Tx;
  let service: CategoryService;

  beforeEach(() => {
    jest.resetAllMocks();
    transaction.mockImplementation(async (cb) => cb(tx));
    slugExists.mockResolvedValue(false);
    service = new CategoryService(
      { $transaction: transaction } as unknown as PrismaService,
      { findById, slugExists, create, update } as unknown as CategoryRepository,
      { delByPrefix: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService,
      { write: auditWrite } as unknown as CatalogAuditLogService,
      { publish: outboxPublish } as unknown as CatalogOutboxService,
      {} as StorageService,
      { countProductsInCategory } as unknown as CatalogUsageRegistry,
    );
  });

  describe('tạo ngành', () => {
    it("nhận attributeMode từ request (tạo được 'legacy_fashion') và ghi vào DB + audit", async () => {
      create.mockResolvedValue(row({ attributeMode: 'legacy_fashion' }));

      const res = await service.create(actor, { name: 'Áo thun', attributeMode: 'legacy_fashion' });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ attributeMode: 'legacy_fashion' }), tx);
      expect(auditWrite).toHaveBeenCalledWith(tx, actor, expect.objectContaining({ after: expect.objectContaining({ attributeMode: 'legacy_fashion' }) as unknown }));
      expect(res.attributeMode).toBe('legacy_fashion'); // response trả attributeMode
    });

    it("bỏ trống → mặc định 'dynamic'", async () => {
      create.mockResolvedValue(row());

      await service.create(actor, { name: 'Điện thoại' });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ attributeMode: 'dynamic' }), tx);
    });
  });

  describe('đổi chế độ khi sửa ngành', () => {
    it('ngành chưa có sản phẩm → đổi được và ghi attributeMode vào update', async () => {
      findById.mockResolvedValue(row({ attributeMode: 'dynamic', productCount: 0 }));
      countProductsInCategory.mockResolvedValue(0);
      update.mockResolvedValue(row({ attributeMode: 'legacy_fashion' }));

      const res = await service.update(actor, 'c1', { attributeMode: 'legacy_fashion' });

      expect(update).toHaveBeenCalledWith('c1', expect.objectContaining({ attributeMode: 'legacy_fashion' }), tx);
      expect(res.attributeMode).toBe('legacy_fashion');
    });

    it('ngành có sản phẩm ĐANG BÁN (productCount > 0) → 409 CATALOG_CATEGORY_MODE_LOCKED, không ghi gì', async () => {
      findById.mockResolvedValue(row({ attributeMode: 'legacy_fashion', productCount: 3 }));
      countProductsInCategory.mockResolvedValue(0);

      const err = await service.update(actor, 'c1', { attributeMode: 'dynamic' }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err).toMatchObject({ errorCode: 'CATALOG_CATEGORY_MODE_LOCKED', httpStatus: 409 });
      expect(update).not.toHaveBeenCalled();
    });

    it('chỉ có sản phẩm NHÁP/ẨN (productCount = 0 nhưng product báo còn) vẫn bị khoá', async () => {
      findById.mockResolvedValue(row({ attributeMode: 'dynamic', productCount: 0 }));
      countProductsInCategory.mockResolvedValue(2);

      await expect(service.update(actor, 'c1', { attributeMode: 'legacy_fashion' })).rejects.toMatchObject({ errorCode: 'CATALOG_CATEGORY_MODE_LOCKED' });
      expect(update).not.toHaveBeenCalled();
    });

    it('gửi lại đúng mode hiện tại là no-op: không hỏi product, không update, không bị khoá', async () => {
      findById.mockResolvedValue(row({ attributeMode: 'legacy_fashion', productCount: 9 }));

      const res = await service.update(actor, 'c1', { attributeMode: 'legacy_fashion' });

      expect(countProductsInCategory).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(res.attributeMode).toBe('legacy_fashion');
    });

    it('sửa trường khác (đổi tên) không đụng tới chế độ', async () => {
      findById.mockResolvedValue(row({ productCount: 5 }));
      update.mockResolvedValue(row({ name: 'Mới', productCount: 5 }));

      await service.update(actor, 'c1', { name: 'Mới' });

      expect(update).toHaveBeenCalledWith('c1', expect.not.objectContaining({ attributeMode: expect.anything() as unknown }), tx);
    });
  });
});

describe('Request ngành hàng — attributeMode (H8, ValidationPipe whitelist không còn nuốt field)', () => {
  const errorsOf = (cls: new () => object, plain: object) => validateSync(plainToInstance(cls, plain), { whitelist: true, forbidNonWhitelisted: true });

  it("Create: chấp nhận 'dynamic' | 'legacy_fashion' và bỏ trống; từ chối giá trị lạ", () => {
    expect(errorsOf(CreateCategoryRequest, { name: 'Áo thun', attributeMode: 'legacy_fashion' })).toHaveLength(0);
    expect(errorsOf(CreateCategoryRequest, { name: 'Điện thoại', attributeMode: 'dynamic' })).toHaveLength(0);
    expect(errorsOf(CreateCategoryRequest, { name: 'Điện thoại' })).toHaveLength(0);
    expect(errorsOf(CreateCategoryRequest, { name: 'Điện thoại', attributeMode: 'fashion' }).length).toBeGreaterThan(0);
  });

  it('Update: chấp nhận mode hợp lệ, từ chối mode lạ', () => {
    expect(errorsOf(UpdateCategoryRequest, { attributeMode: 'legacy_fashion' })).toHaveLength(0);
    expect(errorsOf(UpdateCategoryRequest, { attributeMode: 'whatever' }).length).toBeGreaterThan(0);
  });
});
