import { NotFoundException } from '@common/exception/business.exception';
import { Prisma } from '@common/prisma/types';
import type { PrismaService } from '@common/prisma/prisma.service';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { PRODUCT_ERR } from '../../foundation/product.constants';
import type { StockMovementResponse, StockReceiptResponse, StockRowResponse } from '../dto/inventory.responses';
import type { InventoryService } from './inventory.service';
import { ShopInventoryService } from './shop-inventory.service';

/* Dòng bảng tồn kho đủ trường; test chỉ ghi đè phần cần phân biệt. */
function makeStockRow(overrides: Partial<StockRowResponse> = {}): StockRowResponse {
  return { variantId: 'v1', productId: 'p1', productName: 'Product 1', productSlug: 'p1', productStatus: 'active', sku: 'SKU1', color: 'Red', size: 'M', stock: 10, reserved: 0, available: 10, isActive: true, isLow: false, ...overrides };
}

/* Dòng stock_receipt (kèm items) đúng hình dạng ShopInventoryService.toReceipt đọc từ Prisma. */
interface ReceiptRow {
  id: string;
  code: string;
  supplierName: string | null;
  note: string | null;
  status: string;
  totalCost: Prisma.Decimal;
  postedAt: Date | null;
  createdAt: Date;
  items: Array<{ variantId: string; sku: string; quantity: number; unitCost: Prisma.Decimal }>;
}

function makeReceiptRow(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    id: 'r1',
    code: 'PN250100001',
    supplierName: 'Supplier',
    note: null,
    status: 'draft',
    totalCost: new Prisma.Decimal('1000000'),
    postedAt: null,
    createdAt: new Date('2025-10-03T00:00:00.000Z'),
    items: [{ variantId: 'v1', sku: 'SKU1', quantity: 10, unitCost: new Prisma.Decimal('100000') }],
    ...overrides,
  };
}

/*
 * Test quy tắc ownership — variant/receipt phải thuộc shop, nếu không trả 404.
 * Lọc theo shop của bảng tồn nằm ở DB (InventoryRepository.listStock — xem inventory.repository.spec.ts); ở đây kiểm service
 * ĐẨY shopId xuống tầng dưới và KHÔNG lọc/cắt lại trong bộ nhớ. Phiếu nhập: shopId đi vào cùng transaction tạo phiếu.
 */
describe('ShopInventoryService', () => {
  let service: ShopInventoryService;

  /*
   * Mỗi mock giữ trong BIẾN RIÊNG (không đọc lại qua `obj.method`) để assert không dính `unbound-method`;
   * kiểu tham số/giá trị trả lấy thẳng từ InventoryService nên đổi chữ ký production là test báo đỏ ngay.
   */
  const listStock = jest.fn<ReturnType<InventoryService['listStock']>, Parameters<InventoryService['listStock']>>();
  const movements = jest.fn<ReturnType<InventoryService['movements']>, Parameters<InventoryService['movements']>>();
  const createReceipt = jest.fn<ReturnType<InventoryService['createReceipt']>, Parameters<InventoryService['createReceipt']>>();
  const adjust = jest.fn<ReturnType<InventoryService['adjust']>, Parameters<InventoryService['adjust']>>();

  const variantFindFirst = jest.fn<Promise<{ id: string } | null>, [unknown]>();
  const receiptFindFirst = jest.fn<Promise<ReceiptRow | null>, [unknown]>();

  const actor: AuthenticatedActor = { userId: 'u1', email: 'u1@vn', roleCode: 'admin', permissionVersion: 1, tokenId: 't1' };
  const shopId = 'shop-1';

  beforeEach(() => {
    jest.resetAllMocks();

    const prisma = {
      productVariant: { findFirst: variantFindFirst },
      stockReceipt: { findFirst: receiptFindFirst },
    } as unknown as PrismaService;
    const inventory = { listStock, movements, createReceipt, adjust } as unknown as InventoryService;

    service = new ShopInventoryService(inventory, prisma);
  });

  describe('listStockShop', () => {
    it('đẩy shopId xuống inventory.listStock (lọc ở DB), trả nguyên trang — không lọc lại trong bộ nhớ', async () => {
      const page2 = PageResponse.of([makeStockRow({ variantId: 'v21', sku: 'SKU21' }), makeStockRow({ variantId: 'v22', sku: 'SKU22' })], 2, 20, 22);
      listStock.mockResolvedValue(page2);

      const result = await service.listStockShop(shopId, { page: 2, size: 20, q: 'SKU', lowStockOnly: true });

      expect(listStock).toHaveBeenCalledWith({ page: 2, size: 20, q: 'SKU', lowStockOnly: true, shopId });
      expect(result).toBe(page2); // trang 2 giữ nguyên nội dung + total do DB tính (không bị thay bằng filtered.length)
      expect(variantFindFirst).not.toHaveBeenCalled(); // không còn nạp danh sách biến thể của shop vào bộ nhớ
    });
  });

  describe('movementsShop', () => {
    const variantId = 'v1';

    it('throw 404 nếu variant không thuộc shop', async () => {
      variantFindFirst.mockResolvedValue(null);

      await expect(service.movementsShop(shopId, variantId)).rejects.toThrow(NotFoundException);
      expect(variantFindFirst).toHaveBeenCalledWith({
        where: { id: variantId, shopId, isDeleted: false },
        select: { id: true },
      });
      expect(movements).not.toHaveBeenCalled();
    });

    it('trả movements nếu variant thuộc shop', async () => {
      const mockMovements: StockMovementResponse[] = [{ id: 'm1', type: 'RECEIPT', quantity: 10, stockAfter: 10, refType: 'stock_receipt', refId: 'r1', note: null, createdAt: '2025-10-03T00:00:00Z' }];

      variantFindFirst.mockResolvedValue({ id: variantId });
      movements.mockResolvedValue(mockMovements);

      const result = await service.movementsShop(shopId, variantId);

      expect(result).toEqual(mockMovements);
    });
  });

  describe('getReceiptShop', () => {
    const receiptId = 'r1';

    it('throw 404 nếu receipt không thuộc shop', async () => {
      receiptFindFirst.mockResolvedValue(null);

      await expect(service.getReceiptShop(shopId, receiptId)).rejects.toThrow(NotFoundException);
    });

    it('trả receipt nếu thuộc shop', async () => {
      receiptFindFirst.mockResolvedValue(makeReceiptRow({ id: receiptId }));

      const result = await service.getReceiptShop(shopId, receiptId);

      expect(result.id).toBe(receiptId);
      expect(receiptFindFirst).toHaveBeenCalledWith({
        where: { id: receiptId, isDeleted: false, shopId },
        include: { items: true },
      });
    });
  });

  describe('createReceiptShop', () => {
    const input = { items: [{ variantId: 'v1', quantity: 10, unitCost: '100000' }] };

    it('uỷ quyền cho inventory.createReceipt kèm shopId (một transaction) và trả nguyên kết quả — không update shopId riêng', async () => {
      const created = { id: 'r1' } as StockReceiptResponse;
      createReceipt.mockResolvedValue(created);

      const result = await service.createReceiptShop(actor, shopId, input);

      expect(createReceipt).toHaveBeenCalledWith(actor, input, { shopId });
      expect(result).toBe(created);
    });

    it('biến thể không thuộc shop → lỗi 404 từ tầng kiểm trong transaction được truyền nguyên', async () => {
      createReceipt.mockRejectedValue(new NotFoundException(PRODUCT_ERR.VARIANT_NOT_FOUND, 'Biến thể không tồn tại hoặc không thuộc gian hàng của bạn: v1'));

      await expect(service.createReceiptShop(actor, shopId, input)).rejects.toThrow(NotFoundException);
    });
  });

  describe('adjustStockShop', () => {
    const input = { variantId: 'v1', delta: -2, reason: 'Damaged' };

    it('throw 404 nếu variant không thuộc shop', async () => {
      variantFindFirst.mockResolvedValue(null);

      await expect(service.adjustStockShop(actor, shopId, input)).rejects.toThrow(NotFoundException);
      expect(adjust).not.toHaveBeenCalled();
    });

    it('gọi inventory.adjust nếu variant thuộc shop', async () => {
      const mockResult = makeStockRow({ stock: 8, available: 8 });

      variantFindFirst.mockResolvedValue({ id: 'v1' });
      adjust.mockResolvedValue(mockResult);

      const result = await service.adjustStockShop(actor, shopId, input);

      expect(result).toEqual(mockResult);
      expect(adjust).toHaveBeenCalledWith(actor, input);
    });
  });
});
