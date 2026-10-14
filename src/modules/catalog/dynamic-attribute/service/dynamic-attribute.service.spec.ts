import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { CatalogAuditLogService } from '../../audit/catalog-audit-log.service';
import { CatalogUsageRegistry, type CatalogUsageProvider } from '../../queryapi/catalog-usage.registry';
import type { DynamicAttributeRepository, DynamicAttributeWithValuesRow } from '../repository/dynamic-attribute.repository';
import { CreateDynamicAttributeRequest } from '../request/dynamic-attribute.requests';
import { DynamicAttributeService } from './dynamic-attribute.service';

const actor: AuthenticatedActor = { userId: 'u1', email: 'u1@vn', roleCode: 'admin', permissionVersion: 1, tokenId: 't1' };

function attribute(): DynamicAttributeWithValuesRow {
  return { id: 'a1', code: 'storage', name: 'Dung lượng', inputType: 'select', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), values: [{ id: 'val-128', value: '128GB', extra: null, sortOrder: 0 }] };
}

describe('DynamicAttributeService.deleteValue — chặn xoá giá trị đang dùng (M9)', () => {
  const findById = jest.fn<ReturnType<DynamicAttributeRepository['findById']>, Parameters<DynamicAttributeRepository['findById']>>();
  const deleteValue = jest.fn<ReturnType<DynamicAttributeRepository['deleteValue']>, Parameters<DynamicAttributeRepository['deleteValue']>>();
  const auditWrite = jest.fn<ReturnType<CatalogAuditLogService['write']>, Parameters<CatalogAuditLogService['write']>>();
  const transaction = jest.fn<Promise<unknown>, [(t: Tx) => Promise<unknown>]>();
  const inUse = jest.fn<Promise<boolean>, [string]>();
  const tx = {} as Tx;
  let service: DynamicAttributeService;

  beforeEach(() => {
    jest.resetAllMocks();
    transaction.mockImplementation(async (cb) => cb(tx));
    findById.mockResolvedValue(attribute());
    // Registry thật + một provider giả (đúng đường product đăng ký), để kiểm cả cơ chế đăng ký.
    const registry = new CatalogUsageRegistry();
    const provider: CatalogUsageProvider = { countProductsInCategory: () => Promise.resolve(0), isAttributeValueInUse: inUse };
    registry.register(provider);
    service = new DynamicAttributeService({ $transaction: transaction } as unknown as PrismaService, { findById, deleteValue } as unknown as DynamicAttributeRepository, { write: auditWrite } as unknown as CatalogAuditLogService, registry);
  });

  it('giá trị đang được sản phẩm/biến thể dùng → 409 CATALOG_ATTRIBUTE_VALUE_IN_USE, KHÔNG xoá', async () => {
    inUse.mockResolvedValue(true);

    const err = await service.deleteValue(actor, 'a1', 'val-128').catch((e: unknown) => e);

    expect(err).toMatchObject({ errorCode: 'CATALOG_ATTRIBUTE_VALUE_IN_USE', httpStatus: 409 });
    expect(inUse).toHaveBeenCalledWith('val-128');
    expect(deleteValue).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('không ai dùng → xoá trong transaction + audit', async () => {
    inUse.mockResolvedValue(false);

    await service.deleteValue(actor, 'a1', 'val-128');

    expect(deleteValue).toHaveBeenCalledWith('val-128', tx);
    expect(auditWrite).toHaveBeenCalledTimes(1);
  });

  it('giá trị không thuộc thuộc tính → 404 trước cả khi hỏi product', async () => {
    await expect(service.deleteValue(actor, 'a1', 'khong-co')).rejects.toMatchObject({ errorCode: 'CATALOG_VALUE_NOT_FOUND' });
    expect(inUse).not.toHaveBeenCalled();
  });
});

describe('DynamicAttributeService.addValue/updateValue — `extra` null (cột Json của Prisma)', () => {
  const findById = jest.fn<ReturnType<DynamicAttributeRepository['findById']>, Parameters<DynamicAttributeRepository['findById']>>();
  const createValue = jest.fn<Promise<unknown>, [Record<string, unknown>]>().mockResolvedValue({});
  const updateValue = jest.fn<Promise<unknown>, [string, Record<string, unknown>]>().mockResolvedValue({});
  const auditWrite = jest.fn<ReturnType<CatalogAuditLogService['write']>, Parameters<CatalogAuditLogService['write']>>();
  const tx = {} as Tx;
  let service: DynamicAttributeService;

  beforeEach(() => {
    jest.resetAllMocks();
    createValue.mockResolvedValue({});
    updateValue.mockResolvedValue({});
    findById.mockResolvedValue(attribute());
    const transaction = (cb: (t: Tx) => Promise<unknown>) => cb(tx);
    service = new DynamicAttributeService({ $transaction: transaction } as unknown as PrismaService, { findById, createValue, updateValue } as unknown as DynamicAttributeRepository, { write: auditWrite } as unknown as CatalogAuditLogService, new CatalogUsageRegistry());
  });

  it('thêm giá trị với extra:null ⇒ ghi Prisma.DbNull (null trần làm Prisma ném lỗi runtime)', async () => {
    await service.addValue(actor, 'a1', { value: 'Mới', extra: null });

    expect(createValue.mock.calls[0][0]).toMatchObject({ attributeId: 'a1', value: 'Mới', extra: Prisma.DbNull });
  });

  it('thêm giá trị với extra là object ⇒ giữ nguyên object; bỏ trống ⇒ không đưa extra vào dữ liệu', async () => {
    await service.addValue(actor, 'a1', { value: 'Đỏ', extra: { hex: '#ff0000' } });
    await service.addValue(actor, 'a1', { value: 'Tím' });

    expect(createValue.mock.calls[0][0]).toMatchObject({ extra: { hex: '#ff0000' } });
    expect(createValue.mock.calls[1][0]).not.toHaveProperty('extra');
  });

  it('sửa giá trị với extra:null ⇒ DbNull ở DB nhưng nhật ký ghi null thật', async () => {
    await service.updateValue(actor, 'a1', 'val-128', { extra: null });

    expect(updateValue.mock.calls[0][1]).toMatchObject({ extra: Prisma.DbNull });
    expect(auditWrite.mock.calls[0][2].after).toEqual({ extra: null });
  });
});

describe('CatalogUsageRegistry', () => {
  it('chưa provider nào đăng ký → coi như chưa ai dùng (không chặn)', async () => {
    const registry = new CatalogUsageRegistry();

    expect(await registry.countProductsInCategory('c1')).toBe(0);
    expect(await registry.isAttributeValueInUse('v1')).toBe(false);
  });

  it('cộng dồn số sản phẩm và OR kết quả "đang dùng" từ mọi provider', async () => {
    const registry = new CatalogUsageRegistry();
    registry.register({ countProductsInCategory: () => Promise.resolve(2), isAttributeValueInUse: () => Promise.resolve(false) });
    registry.register({ countProductsInCategory: () => Promise.resolve(3), isAttributeValueInUse: () => Promise.resolve(true) });

    expect(await registry.countProductsInCategory('c1')).toBe(5);
    expect(await registry.isAttributeValueInUse('v1')).toBe(true);
  });
});

describe('CreateDynamicAttributeRequest.inputType (M9)', () => {
  const errorsOf = (plain: object) => validateSync(plainToInstance(CreateDynamicAttributeRequest, plain), { whitelist: true, forbidNonWhitelisted: true });

  it('chỉ nhận select | text | number (hoặc bỏ trống → mặc định select)', () => {
    for (const inputType of ['select', 'text', 'number']) expect(errorsOf({ code: 'storage', name: 'Dung lượng', inputType })).toHaveLength(0);
    expect(errorsOf({ code: 'storage', name: 'Dung lượng' })).toHaveLength(0);
  });

  it('từ chối kiểu lạ (trước đây chuỗi bất kỳ ≤ 20 ký tự lọt vào DB)', () => {
    expect(errorsOf({ code: 'storage', name: 'Dung lượng', inputType: 'checkbox' }).length).toBeGreaterThan(0);
    expect(errorsOf({ code: 'storage', name: 'Dung lượng', inputType: 'SELECT' }).length).toBeGreaterThan(0);
  });
});
