import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { InsufficientStockError } from '@common/gateway/inventory.gateway';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { CatalogQueryApi } from '../../../catalog/queryapi/catalog.queryapi';
import type { ProductAuditLogService } from '../../audit/product-audit-log.service';
import { InventoryGatewayImpl } from '../../gateway/inventory.gateway.impl';
import type { ProductOutboxService } from '../../outbox/product-outbox.service';
import type { ProductRepository } from '../../product/repository/product.repository';
import type { ProductQueryService } from '../../product/service/product-query.service';
import type { InventoryRepository, LockedVariant } from '../repository/inventory.repository';
import { InventoryService } from './inventory.service';

/* Biến thể đang khoá FOR UPDATE — test chỉ ghi đè phần cần phân biệt. */
function locked(over: Partial<LockedVariant> = {}): LockedVariant {
  return { id: 'v1', productId: 'p1', sku: 'SKU1', stock: 10, reserved: 3, isActive: true, isDeleted: false, shopId: 'shop-1', ...over };
}

const ref = { type: 'order', id: 'DH001' };
const actor: AuthenticatedActor = { userId: 'u1', email: 'u1@vn', roleCode: 'admin', permissionVersion: 1, tokenId: 't1' };

/*
 * Test tồn kho thuần (không DB): repository + Prisma mock, kiểm quy tắc nghiệp vụ.
 * Mỗi mock giữ trong BIẾN RIÊNG để assert không dính `unbound-method`; kiểu lấy thẳng từ production nên đổi chữ ký là test báo đỏ.
 */
describe('InventoryService', () => {
  const lockVariants = jest.fn<ReturnType<InventoryRepository['lockVariants']>, Parameters<InventoryRepository['lockVariants']>>();
  const setStock = jest.fn<ReturnType<InventoryRepository['setStock']>, Parameters<InventoryRepository['setStock']>>();
  const addMovement = jest.fn<ReturnType<InventoryRepository['addMovement']>, Parameters<InventoryRepository['addMovement']>>();
  const nextReceiptCode = jest.fn<ReturnType<InventoryRepository['nextReceiptCode']>, Parameters<InventoryRepository['nextReceiptCode']>>();
  const createReceiptRow = jest.fn<ReturnType<InventoryRepository['createReceipt']>, Parameters<InventoryRepository['createReceipt']>>();
  const findReceipt = jest.fn<ReturnType<InventoryRepository['findReceipt']>, Parameters<InventoryRepository['findReceipt']>>();
  const invalidateDetail = jest.fn<ReturnType<ProductQueryService['invalidateDetail']>, Parameters<ProductQueryService['invalidateDetail']>>();
  const auditWrite = jest.fn<ReturnType<ProductAuditLogService['write']>, Parameters<ProductAuditLogService['write']>>();
  const outboxPublish = jest.fn<ReturnType<ProductOutboxService['publish']>, Parameters<ProductOutboxService['publish']>>();
  const productFindMany = jest.fn<Promise<Array<{ slug: string }>>, [unknown]>();

  const transaction = jest.fn<Promise<unknown>, [(t: Tx) => Promise<unknown>]>();
  const tx = { product: { findMany: productFindMany } } as unknown as Tx;
  const prisma = { $transaction: transaction } as unknown as PrismaService;
  let service: InventoryService;

  beforeEach(() => {
    jest.resetAllMocks();
    productFindMany.mockResolvedValue([{ slug: 'p1' }]);
    invalidateDetail.mockResolvedValue(undefined);
    transaction.mockImplementation(async (cb) => cb(tx));
    const repo = { lockVariants, setStock, addMovement, nextReceiptCode, createReceipt: createReceiptRow, findReceipt } as unknown as InventoryRepository;
    service = new InventoryService(prisma, repo, {} as ProductRepository, { invalidateDetail } as unknown as ProductQueryService, { write: auditWrite } as unknown as ProductAuditLogService, { publish: outboxPublish } as unknown as ProductOutboxService, {} as CatalogQueryApi);
  });

  /* H1 — biến thể bị tắt / xoá mềm sau khi đơn đã giữ hàng KHÔNG được chặn huỷ/hoàn/xác nhận đơn. */
  describe('release / restock / commit với biến thể tắt hoặc xoá mềm', () => {
    const deleted = locked({ isActive: false, isDeleted: true, stock: 10, reserved: 3 });

    it('release: khoá cả biến thể xoá mềm, KHÔNG ném, nhả đúng số đã giữ', async () => {
      lockVariants.mockResolvedValue([deleted]);

      await expect(service.release([{ variantId: 'v1', quantity: 3 }], ref, tx)).resolves.toBeUndefined();

      expect(lockVariants).toHaveBeenCalledWith(['v1'], tx, { includeDeleted: true });
      expect(setStock).toHaveBeenCalledWith('v1', 10, 0, tx);
      expect(addMovement).toHaveBeenCalledWith(expect.objectContaining({ variantId: 'v1', type: 'RELEASE', quantity: 3, refId: 'DH001' }), tx);
    });

    it('restock: biến thể không-active vẫn nhận hàng hoàn, không ném', async () => {
      lockVariants.mockResolvedValue([locked({ isActive: false })]);

      await expect(service.restock([{ variantId: 'v1', quantity: 2 }], ref, tx)).resolves.toBeUndefined();

      expect(lockVariants).toHaveBeenCalledWith(['v1'], tx, { includeDeleted: true });
      expect(setStock).toHaveBeenCalledWith('v1', 12, 3, tx);
    });

    it('commit: biến thể xoá mềm vẫn trừ kho được khi đủ tồn (không coi là thiếu hàng)', async () => {
      lockVariants.mockResolvedValue([deleted]);

      await expect(service.commit([{ variantId: 'v1', quantity: 3 }], ref, tx)).resolves.toBeUndefined();

      expect(lockVariants).toHaveBeenCalledWith(['v1'], tx, { includeDeleted: true });
      expect(setStock).toHaveBeenCalledWith('v1', 7, 0, tx);
      expect(addMovement).toHaveBeenCalledWith(expect.objectContaining({ type: 'SALE', quantity: -3, stockAfter: 7 }), tx);
    });

    it('release/restock: dòng biến thể không còn trong DB bị bỏ qua (không kẹt việc huỷ đơn)', async () => {
      lockVariants.mockResolvedValue([]);

      await expect(service.release([{ variantId: 'ghost', quantity: 1 }], ref, tx)).resolves.toBeUndefined();
      await expect(service.restock([{ variantId: 'ghost', quantity: 1 }], ref, tx)).resolves.toBeUndefined();

      expect(setStock).not.toHaveBeenCalled();
    });

    it('commit: thiếu TỒN THẬT vẫn là InsufficientStockError (đúng lớp lỗi, kèm danh sách thiếu)', async () => {
      lockVariants.mockResolvedValue([locked({ stock: 1, reserved: 1 })]);

      const err = await service.commit([{ variantId: 'v1', quantity: 2 }], ref, tx).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InsufficientStockError);
      expect((err as InsufficientStockError).shortages).toEqual([{ variantId: 'v1', requested: 2, available: 0 }]);
      expect(setStock).not.toHaveBeenCalled();
    });

    it('không báo STOCK_LOW cho biến thể đã xoá mềm', async () => {
      lockVariants.mockResolvedValue([locked({ isActive: false, isDeleted: true, stock: 4, reserved: 4 })]);

      await service.commit([{ variantId: 'v1', quantity: 4 }], ref, tx);

      expect(outboxPublish).not.toHaveBeenCalled();
    });
  });

  describe('reserve: chỉ biến thể còn bán', () => {
    it('khoá KHÔNG gồm biến thể xoá mềm; biến thể tắt → InsufficientStockError (placeOrder bắt lớp này)', async () => {
      lockVariants.mockResolvedValue([locked({ isActive: false })]);

      const err = await service.reserve([{ variantId: 'v1', quantity: 1 }], ref, tx).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InsufficientStockError);
      expect(lockVariants).toHaveBeenCalledWith(['v1'], tx, { includeDeleted: false });
    });

    it('biến thể xoá mềm không được khoá → coi như hết hàng', async () => {
      lockVariants.mockResolvedValue([]);

      await expect(service.reserve([{ variantId: 'v1', quantity: 1 }], ref, tx)).rejects.toBeInstanceOf(InsufficientStockError);
    });

    it('đủ hàng → tăng reserved + ghi sổ RESERVE', async () => {
      lockVariants.mockResolvedValue([locked({ stock: 10, reserved: 3 })]);

      await service.reserve([{ variantId: 'v1', quantity: 2 }, { variantId: 'v1', quantity: 1 }], ref, tx);

      expect(setStock).toHaveBeenCalledWith('v1', 10, 6, tx);
      expect(addMovement).toHaveBeenCalledWith(expect.objectContaining({ type: 'RESERVE', quantity: -3 }), tx);
    });
  });

  /* H1 — tầng gateway: reserve giữ nguyên lỗi cũ, commit/release/restock đổi thành 409 nghiệp vụ. */
  describe('InventoryGatewayImpl', () => {
    const shortage = new InsufficientStockError([{ variantId: 'v1', requested: 5, available: 2 }]);
    const reserve = jest.fn<ReturnType<InventoryService['reserve']>, Parameters<InventoryService['reserve']>>();
    const release = jest.fn<ReturnType<InventoryService['release']>, Parameters<InventoryService['release']>>();
    const commit = jest.fn<ReturnType<InventoryService['commit']>, Parameters<InventoryService['commit']>>();
    const restock = jest.fn<ReturnType<InventoryService['restock']>, Parameters<InventoryService['restock']>>();
    let gateway: InventoryGatewayImpl;

    beforeEach(() => {
      gateway = new InventoryGatewayImpl({ reserve, release, commit, restock } as unknown as InventoryService);
    });

    it('reserve: giữ NGUYÊN InsufficientStockError — hợp đồng OrderService.placeOrder', async () => {
      reserve.mockRejectedValue(shortage);

      await expect(gateway.reserve([], ref, tx)).rejects.toBe(shortage);
    });

    const converted: Array<{ name: string; arrange: () => void; act: () => Promise<void> }> = [
      { name: 'commit', arrange: () => void commit.mockRejectedValue(shortage), act: () => gateway.commit([], ref, tx) },
      { name: 'release', arrange: () => void release.mockRejectedValue(shortage), act: () => gateway.release([], ref, tx) },
      { name: 'restock', arrange: () => void restock.mockRejectedValue(shortage), act: () => gateway.restock([], ref, tx) },
    ];
    for (const c of converted) {
      it(`${c.name}: InsufficientStockError → ConflictException 409 PRODUCT_INSUFFICIENT_STOCK (không lọt thành 500)`, async () => {
        c.arrange();

        const err = await c.act().catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ConflictException);
        expect(err).toMatchObject({ errorCode: 'PRODUCT_INSUFFICIENT_STOCK', httpStatus: 409, details: { v1: 'cần 5, còn 2' } });
      });
    }

    it('lỗi khác (DB, bug) đi tiếp nguyên vẹn — không bị nuốt thành 409', async () => {
      const boom = new Error('db down');
      commit.mockRejectedValue(boom);

      await expect(gateway.commit([], ref, tx)).rejects.toBe(boom);
    });

    it('thành công → resolve bình thường', async () => {
      release.mockResolvedValue(undefined);

      await expect(gateway.release([], ref, tx)).resolves.toBeUndefined();
    });
  });

  /* M3 — phiếu nhập của shop: shopId + mã phiếu + dòng phiếu cùng một transaction; vendor chỉ nhập biến thể của mình. */
  describe('createReceipt', () => {
    const input = { items: [{ variantId: 'v1', quantity: 10, unitCost: '100000' }] };

    beforeEach(() => {
      nextReceiptCode.mockResolvedValue('PN260900001');
      createReceiptRow.mockResolvedValue({ id: 'r1' });
      findReceipt.mockResolvedValue({ id: 'r1', code: 'PN260900001', supplierName: null, note: null, status: 'draft', totalCost: { toString: () => '1000000' }, postedAt: null, createdAt: new Date('2026-09-01T00:00:00Z'), items: [] } as unknown as Awaited<ReturnType<InventoryRepository['findReceipt']>>);
    });

    it('vendor: shopId ghi CÙNG lệnh tạo phiếu (không có bước update riêng), trong cùng transaction', async () => {
      lockVariants.mockResolvedValue([locked({ id: 'v1', shopId: 'shop-1' })]);

      await service.createReceipt(actor, input, { shopId: 'shop-1' });

      expect(createReceiptRow).toHaveBeenCalledTimes(1);
      expect(createReceiptRow).toHaveBeenCalledWith(expect.objectContaining({ code: 'PN260900001', shopId: 'shop-1', totalCost: 1_000_000n }), tx);
      expect(nextReceiptCode).toHaveBeenCalledWith(tx);
    });

    it('vendor: biến thể của shop khác → 404, KHÔNG tạo phiếu', async () => {
      lockVariants.mockResolvedValue([locked({ id: 'v1', shopId: 'shop-2' })]);

      await expect(service.createReceipt(actor, input, { shopId: 'shop-1' })).rejects.toBeInstanceOf(NotFoundException);

      expect(createReceiptRow).not.toHaveBeenCalled();
    });

    it('nhân viên sàn (không shopId): phiếu của sàn, shopId = null, không giới hạn shop', async () => {
      lockVariants.mockResolvedValue([locked({ id: 'v1', shopId: 'shop-2' })]);

      await service.createReceipt(actor, input);

      expect(createReceiptRow).toHaveBeenCalledWith(expect.objectContaining({ shopId: null }), tx);
    });

    it('tổng giá trị vượt numeric(14,0) → lỗi nghiệp vụ 400 thay vì 500 từ DB', async () => {
      lockVariants.mockResolvedValue([locked({ id: 'v1' })]);
      const huge = { items: [{ variantId: 'v1', quantity: 100000, unitCost: '999999999999' }] };

      const err = await service.createReceipt(actor, huge).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BusinessException);
      expect(err).toMatchObject({ errorCode: 'PRODUCT_RECEIPT_TOTAL_TOO_LARGE' });
      expect(createReceiptRow).not.toHaveBeenCalled();
    });
  });

  describe('adjust', () => {
    it('chặn tồn sau điều chỉnh vượt trần (tránh tràn int4)', async () => {
      lockVariants.mockResolvedValue([locked({ stock: 999_999_999, reserved: 0 })]);

      await expect(service.adjust(actor, { variantId: 'v1', delta: 100000, reason: 'Kiểm kê' })).rejects.toMatchObject({ errorCode: 'PRODUCT_STOCK_LIMIT_EXCEEDED' });
      expect(setStock).not.toHaveBeenCalled();
    });
  });
});
