import type { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { CatalogAuditLogService } from '../../audit/catalog-audit-log.service';
import type { CategoryRepository, CategoryRow } from '../../category/repository/category.repository';
import type { DynamicAttributeRepository } from '../../dynamic-attribute/repository/dynamic-attribute.repository';
import type { CatalogUsageRegistry } from '../../queryapi/catalog-usage.registry';
import type { CategoryAttributeRepository, CategoryAttributeWithDetailsRow } from '../repository/category-attribute.repository';
import type { SetCategoryAttributeTemplateItemRequest } from '../request/category-attribute.requests';
import { CategoryAttributeService } from './category-attribute.service';

function category(over: Partial<CategoryRow> = {}): CategoryRow {
  return { id: 'c1', slug: 'dien-thoai', name: 'Điện thoại', description: null, imageUrl: null, imagePublicId: null, parentId: null, sortOrder: 0, isActive: true, productCount: 0, attributeMode: 'dynamic', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...over };
}

const actor: AuthenticatedActor = { userId: 'u1', email: 'u1@vn', roleCode: 'admin', permissionVersion: 1, tokenId: 't1' };
const ATTRS = [
  { id: 'a-color', code: 'color2', name: 'Màu sắc', inputType: 'select' },
  { id: 'a-storage', code: 'storage', name: 'Dung lượng', inputType: 'select' },
  { id: 'a-ram', code: 'ram', name: 'RAM', inputType: 'select' },
  { id: 'a-warranty', code: 'warranty', name: 'Bảo hành', inputType: 'text' },
];
const item = (attributeId: string, over: Partial<SetCategoryAttributeTemplateItemRequest> = {}): SetCategoryAttributeTemplateItemRequest => ({ attributeId, ...over });

describe('CategoryAttributeService.setTemplate — validate mẫu thuộc tính ngành (M8)', () => {
  const findCategory = jest.fn<ReturnType<CategoryRepository['findById']>, Parameters<CategoryRepository['findById']>>();
  const findByIdsWithType = jest.fn<ReturnType<DynamicAttributeRepository['findByIdsWithType']>, Parameters<DynamicAttributeRepository['findByIdsWithType']>>();
  const getByCategoryId = jest.fn<ReturnType<CategoryAttributeRepository['getByCategoryId']>, Parameters<CategoryAttributeRepository['getByCategoryId']>>();
  const deleteAllByCategory = jest.fn<ReturnType<CategoryAttributeRepository['deleteAllByCategory']>, Parameters<CategoryAttributeRepository['deleteAllByCategory']>>();
  const createRow = jest.fn<ReturnType<CategoryAttributeRepository['create']>, Parameters<CategoryAttributeRepository['create']>>();
  const countProductsInCategory = jest.fn<ReturnType<CatalogUsageRegistry['countProductsInCategory']>, Parameters<CatalogUsageRegistry['countProductsInCategory']>>();
  const auditWrite = jest.fn<ReturnType<CatalogAuditLogService['write']>, Parameters<CatalogAuditLogService['write']>>();
  const transaction = jest.fn<Promise<unknown>, [(t: Tx) => Promise<unknown>]>();
  const tx = {} as Tx;
  let service: CategoryAttributeService;

  beforeEach(() => {
    jest.resetAllMocks();
    transaction.mockImplementation(async (cb) => cb(tx));
    findCategory.mockResolvedValue(category());
    findByIdsWithType.mockImplementation((ids) => Promise.resolve(ATTRS.filter((a) => ids.includes(a.id))));
    getByCategoryId.mockResolvedValue([]);
    countProductsInCategory.mockResolvedValue(0);
    service = new CategoryAttributeService(
      { $transaction: transaction } as unknown as PrismaService,
      { getByCategoryId, deleteAllByCategory, create: createRow } as unknown as CategoryAttributeRepository,
      { findById: findCategory } as unknown as CategoryRepository,
      { findByIdsWithType } as unknown as DynamicAttributeRepository,
      { write: auditWrite } as unknown as CatalogAuditLogService,
      { countProductsInCategory } as unknown as CatalogUsageRegistry,
    );
  });

  /* Mọi nhánh lỗi: ném đúng mã và KHÔNG xoá/ghi gì (kiểm trước khi mở transaction). */
  async function expectRejected(items: SetCategoryAttributeTemplateItemRequest[], errorCode: string, httpStatus: number): Promise<void> {
    const err = await service.setTemplate(actor, 'c1', items).catch((e: unknown) => e);
    expect(err).toMatchObject({ errorCode, httpStatus });
    expect(deleteAllByCategory).not.toHaveBeenCalled();
  }

  it('ngành không tồn tại → 404 CATALOG_CATEGORY_NOT_FOUND', async () => {
    findCategory.mockResolvedValue(null);

    await expectRejected([item('a-color', { isVariantAxis: true })], 'CATALOG_CATEGORY_NOT_FOUND', 404);
  });

  it("ngành 'legacy_fashion' không có mẫu thuộc tính → 409 CATALOG_CATEGORY_NOT_DYNAMIC", async () => {
    findCategory.mockResolvedValue(category({ attributeMode: 'legacy_fashion' }));

    await expectRejected([item('a-color', { isVariantAxis: true })], 'CATALOG_CATEGORY_NOT_DYNAMIC', 409);
  });

  it('attributeId khai báo trùng → 400 CATALOG_TEMPLATE_ATTRIBUTE_DUPLICATED (không để unique DB báo lỗi chung)', async () => {
    await expectRejected([item('a-color', { isVariantAxis: true }), item('a-color')], 'CATALOG_TEMPLATE_ATTRIBUTE_DUPLICATED', 400);
  });

  it('attributeId không tồn tại → 404 CATALOG_DYNAMIC_ATTRIBUTE_NOT_FOUND kèm id', async () => {
    const err = await service.setTemplate(actor, 'c1', [item('a-color', { isVariantAxis: true }), item('khong-co')]).catch((e: unknown) => e);

    expect(err).toMatchObject({ errorCode: 'CATALOG_DYNAMIC_ATTRIBUTE_NOT_FOUND', httpStatus: 404 });
    expect((err as Error).message).toContain('khong-co');
    expect(deleteAllByCategory).not.toHaveBeenCalled();
  });

  it('quá 2 trục biến thể → 400 CATALOG_TOO_MANY_VARIANT_AXIS', async () => {
    await expectRejected([item('a-color', { isVariantAxis: true }), item('a-storage', { isVariantAxis: true }), item('a-ram', { isVariantAxis: true })], 'CATALOG_TOO_MANY_VARIANT_AXIS', 400);
  });

  it('có thuộc tính nhưng 0 trục → 400 CATALOG_VARIANT_AXIS_REQUIRED (ngành không tạo nổi biến thể)', async () => {
    await expectRejected([item('a-color'), item('a-warranty')], 'CATALOG_VARIANT_AXIS_REQUIRED', 400);
  });

  it('trục biến thể là thuộc tính text → 400 CATALOG_VARIANT_AXIS_NOT_SELECT', async () => {
    const err = await service.setTemplate(actor, 'c1', [item('a-warranty', { isVariantAxis: true })]).catch((e: unknown) => e);

    expect(err).toMatchObject({ errorCode: 'CATALOG_VARIANT_AXIS_NOT_SELECT', httpStatus: 400 });
    expect((err as Error).message).toContain('warranty');
    expect(deleteAllByCategory).not.toHaveBeenCalled();
  });

  it('thuộc tính text/number làm thuộc tính thường (không phải trục) thì hợp lệ', async () => {
    await expect(service.setTemplate(actor, 'c1', [item('a-color', { isVariantAxis: true, required: true }), item('a-warranty', { sortOrder: 1 })])).resolves.toBeDefined();
  });

  it('xoá sạch mẫu khi ngành đã có sản phẩm → 409 CATALOG_CATEGORY_HAS_PRODUCTS; ngành trống thì xoá được', async () => {
    countProductsInCategory.mockResolvedValue(4);
    await expectRejected([], 'CATALOG_CATEGORY_HAS_PRODUCTS', 409);

    countProductsInCategory.mockResolvedValue(0);
    await expect(service.setTemplate(actor, 'c1', [])).resolves.toEqual({ attributes: [] });
    expect(deleteAllByCategory).toHaveBeenCalledWith('c1', tx);
  });

  it('hợp lệ: thay thế toàn bộ trong MỘT transaction (xoá cũ → tạo mới → audit)', async () => {
    getByCategoryId.mockResolvedValue([] as CategoryAttributeWithDetailsRow[]);

    await service.setTemplate(actor, 'c1', [item('a-color', { isVariantAxis: true, required: true }), item('a-storage', { isVariantAxis: true, sortOrder: 1 }), item('a-warranty', { sortOrder: 2 })]);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleteAllByCategory).toHaveBeenCalledWith('c1', tx);
    expect(createRow).toHaveBeenCalledTimes(3);
    expect(createRow).toHaveBeenCalledWith({ categoryId: 'c1', attributeId: 'a-color', required: true, isVariantAxis: true, sortOrder: 0 }, tx);
    expect(auditWrite).toHaveBeenCalledWith(tx, actor, expect.objectContaining({ entityId: 'c1', after: { attributeCount: 3, variantAxisCount: 2 } }));
  });
});
