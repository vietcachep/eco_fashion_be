import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { Prisma } from '@common/prisma/types';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ShopBrief, ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { ORDER_ERR, ORDER_STATUS, STAFF_TRANSITIONS } from '../../foundation/order.constants';
import type { OrderResponse } from '../dto/order.responses';
import type { OrderRepository, OrderRow } from '../repository/order.repository';
import type { OrderService } from './order.service';
import { ShopOrderService } from './shop-order.service';

/* Dòng đơn đủ trường theo OrderRow (Prisma); test chỉ ghi đè trạng thái/shop. */
function makeOrderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'order-id-1',
    code: 'DH2609150001',
    userId: 'customer-123',
    shopId: 'shop-123',
    orderGroupId: 'group-123',
    commissionRateSnapshot: new Prisma.Decimal('10.00'),
    status: ORDER_STATUS.PENDING,
    paymentMethodCode: 'cod',
    paymentStatus: 'unpaid',
    recipientName: 'Nguyễn Văn A',
    recipientPhone: '0901234567',
    provinceCode: null,
    provinceName: 'TP. Hồ Chí Minh',
    districtName: 'Q.1',
    wardName: null,
    street: '12 Nguyễn Huệ',
    shippingAddress: '12 Nguyễn Huệ, Q.1, TP.HCM',
    customerNote: 'Please deliver carefully',
    subtotal: new Prisma.Decimal(1000000),
    shippingFee: new Prisma.Decimal(30000),
    discount: new Prisma.Decimal(0),
    shopDiscount: new Prisma.Decimal(0),
    platformDiscount: new Prisma.Decimal(0),
    promotionCode: null,
    promotionName: null,
    shopPromotionCode: null,
    shopPromotionName: null,
    total: new Prisma.Decimal(1030000),
    itemCount: 2,
    cancelReason: null,
    cancelledBy: null,
    trackingUrl: null,
    paymentExpiresAt: null,
    confirmedAt: null,
    packedAt: null,
    shippedAt: null,
    deliveredAt: null,
    completedAt: null,
    cancelledAt: null,
    version: 1,
    createdAt: new Date('2026-09-15T00:00:00.000Z'),
    createdBy: null,
    updatedAt: new Date('2026-09-15T00:00:00.000Z'),
    updatedBy: null,
    isDeleted: false,
    items: [],
    histories: [],
    ...overrides,
  };
}

describe('ShopOrderService', () => {
  let service: ShopOrderService;

  /*
   * Mỗi mock giữ trong BIẾN RIÊNG (không đọc lại qua `obj.method`) để assert không dính `unbound-method`;
   * kiểu lấy thẳng từ service/repository thật nên đổi chữ ký production là test báo đỏ ngay.
   */
  const findByCode = jest.fn<Promise<OrderRow | null>, [string]>();
  const updateStatus = jest.fn<Promise<OrderResponse>, Parameters<OrderService['updateStatus']>>();
  const cancelByStaff = jest.fn<Promise<OrderResponse>, Parameters<OrderService['cancelByStaff']>>();
  const findBrief = jest.fn<Promise<ShopBrief | null>, [string]>();
  const settingNumber = jest.fn<Promise<number>, [string]>();
  const groupBy = jest.fn<Promise<Array<{ status: string; _count: { _all: number } }>>, [unknown]>();

  const CODE = 'DH2609150001';
  const SHOP_ID = 'shop-123';

  const mockActor: AuthenticatedActor = {
    userId: 'user-123',
    email: 'vendor@test.com',
    roleCode: 'shop_staff',
    permissionVersion: 1,
    tokenId: 'token-1',
  };

  /*
   * Kết quả "rò" của OrderService (kết thúc bằng getAdmin() có extras thanh toán): service vendor KHÔNG được trả nó ra,
   * mà phải đọc lại đơn và dựng response với extras = null.
   */
  const orderResponse = { code: CODE, paymentUrl: 'https://pay.payos.vn/leak', transactionCode: 'TXN-LEAK', cardBrand: 'VISA', cardLast4: '4242' } as unknown as OrderResponse;

  /* Response vendor không được chứa thông tin thanh toán của khách. */
  function expectNoPaymentLeak(r: OrderResponse): void {
    expect(r.paymentUrl).toBeNull();
    expect(r.transactionCode).toBeNull();
    expect(r.cardBrand).toBeNull();
    expect(r.cardLast4).toBeNull();
  }

  /* Đơn hiện có trong DB ở trạng thái `status` (mặc định thuộc đúng shop đang thao tác). */
  function givenOrder(overrides: Partial<OrderRow> = {}): OrderRow {
    const order = makeOrderRow(overrides);
    findByCode.mockResolvedValue(order);
    return order;
  }

  beforeEach(() => {
    jest.resetAllMocks();

    // Chỉ `summary` dùng prisma (một câu groupBy).
    const prisma = { order: { groupBy } } as unknown as PrismaService;
    const repo = { findByCode } as unknown as OrderRepository;
    const orders = { updateStatus, cancelByStaff } as unknown as OrderService;
    const shops = { findBrief } as unknown as ShopQueryApi;
    const system = { settingNumber } as unknown as SystemQueryApi;

    service = new ShopOrderService(prisma, repo, orders, shops, system);

    findBrief.mockResolvedValue({ id: SHOP_ID, code: 'SHOP-1', slug: 'test-shop', name: 'Test Shop', logoUrl: null, ratingAvg: null, status: 'approved', commissionRate: '10.00'  });
    settingNumber.mockResolvedValue(7);
  });

  describe('vendor transition rules', () => {
    it('should allow pending → confirmed', async () => {
      givenOrder({ status: ORDER_STATUS.PENDING });
      updateStatus.mockResolvedValue(orderResponse);

      const result = await service.updateStatus(mockActor, SHOP_ID, CODE, 'confirmed', {});

      expect(updateStatus).toHaveBeenCalledWith(mockActor, CODE, 'confirmed', {});
      expect(result.code).toBe(CODE);
    });

    it('should allow confirmed → packing', async () => {
      givenOrder({ status: ORDER_STATUS.CONFIRMED });
      updateStatus.mockResolvedValue(orderResponse);

      await service.updateStatus(mockActor, SHOP_ID, CODE, 'packing', {});

      expect(updateStatus).toHaveBeenCalledWith(mockActor, CODE, 'packing', {});
    });

    it('should allow packing → shipping', async () => {
      givenOrder({ status: ORDER_STATUS.PACKING });
      updateStatus.mockResolvedValue(orderResponse);

      await service.updateStatus(mockActor, SHOP_ID, CODE, 'shipping', {});

      expect(updateStatus).toHaveBeenCalledWith(mockActor, CODE, 'shipping', {});
    });

    it('should allow shipping → delivered', async () => {
      givenOrder({ status: ORDER_STATUS.SHIPPING });
      updateStatus.mockResolvedValue(orderResponse);

      await service.updateStatus(mockActor, SHOP_ID, CODE, 'delivered', {});

      expect(updateStatus).toHaveBeenCalledWith(mockActor, CODE, 'delivered', {});
    });

    it('should reject pending → packing (skip confirmed)', async () => {
      givenOrder({ status: ORDER_STATUS.PENDING });

      await expect(service.updateStatus(mockActor, SHOP_ID, CODE, 'packing', {})).rejects.toMatchObject({ errorCode: ORDER_ERR.INVALID_TRANSITION });
      expect(updateStatus).not.toHaveBeenCalled();
    });

    it('should reject confirmed → shipping (skip packing)', async () => {
      givenOrder({ status: ORDER_STATUS.CONFIRMED });

      await expect(service.updateStatus(mockActor, SHOP_ID, CODE, 'shipping', {})).rejects.toThrow(BusinessException);
      expect(updateStatus).not.toHaveBeenCalled();
    });

    it('should reject shipping → completed (vendor cannot)', async () => {
      givenOrder({ status: ORDER_STATUS.SHIPPING });

      await expect(service.updateStatus(mockActor, SHOP_ID, CODE, 'completed', {})).rejects.toMatchObject({ errorCode: ORDER_ERR.INVALID_TRANSITION });
      expect(updateStatus).not.toHaveBeenCalled();
    });

    it('should reject delivered → * (only admin can)', async () => {
      givenOrder({ status: ORDER_STATUS.DELIVERED });

      await expect(service.updateStatus(mockActor, SHOP_ID, CODE, 'completed', {})).rejects.toMatchObject({ errorCode: ORDER_ERR.INVALID_TRANSITION });
      expect(updateStatus).not.toHaveBeenCalled();
    });

    it('chuyển tiếp trackingUrl + note nguyên vẹn xuống OrderService', async () => {
      givenOrder({ status: ORDER_STATUS.PACKING });
      updateStatus.mockResolvedValue(orderResponse);

      await service.updateStatus(mockActor, SHOP_ID, CODE.toLowerCase(), 'shipping', { trackingUrl: 'https://tracking.ghn.vn/?order=GHN1', note: 'Giao GHN' });

      expect(updateStatus).toHaveBeenCalledWith(mockActor, CODE, 'shipping', { trackingUrl: 'https://tracking.ghn.vn/?order=GHN1', note: 'Giao GHN' });
    });
  });

  /*
   * M-1: OrderService.updateStatus/cancelByStaff trả OrderResponse CÓ extras thanh toán (getAdmin). Vendor chỉ được thấy
   * dạng không extras — như GET /shop/orders/:code — nên kết quả của OrderService phải bị bỏ và đơn được đọc lại.
   */
  describe('response không lộ thông tin thanh toán (cả 3 route cùng dạng)', () => {
    it('GET chi tiết: extras = null', async () => {
      givenOrder({ status: ORDER_STATUS.PENDING, paymentMethodCode: 'payos' });

      expectNoPaymentLeak(await service.get(SHOP_ID, CODE));
    });

    it('PUT status: trả đơn đọc lại, KHÔNG trả kết quả (có paymentUrl/cardLast4) của OrderService', async () => {
      givenOrder({ status: ORDER_STATUS.PENDING, paymentMethodCode: 'payos' });
      updateStatus.mockResolvedValue(orderResponse);

      const result = await service.updateStatus(mockActor, SHOP_ID, CODE, 'confirmed', {});

      expect(result).not.toBe(orderResponse);
      expectNoPaymentLeak(result);
      expect(result.shopName).toBe('Test Shop');
      // đọc lại SAU khi ghi: lần 1 kiểm sở hữu, lần 2 dựng response
      expect(findByCode).toHaveBeenCalledTimes(2);
    });

    it('POST cancel: trả đơn đọc lại, KHÔNG trả kết quả của OrderService', async () => {
      givenOrder({ status: ORDER_STATUS.CONFIRMED, paymentMethodCode: 'payos', paymentStatus: 'paid' });
      cancelByStaff.mockResolvedValue(orderResponse);

      const result = await service.cancel(mockActor, SHOP_ID, CODE, 'Hết hàng');

      expect(result).not.toBe(orderResponse);
      expectNoPaymentLeak(result);
      expect(findByCode).toHaveBeenCalledTimes(2);
    });
  });

  describe('thông tin hiển thị cho vendor', () => {
    it('canCancel theo quyền huỷ của vendor: true ở pending/confirmed, false từ packing trở đi', async () => {
      const results: Record<string, boolean> = {};
      for (const status of [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING, ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED]) {
        givenOrder({ status });
        results[status] = (await service.get(SHOP_ID, CODE)).canCancel;
      }

      expect(results).toEqual({ pending: true, confirmed: true, packing: false, shipping: false, delivered: false, cancelled: false });
    });

    it('cửa sổ đổi trả đọc từ setting return.window_days (không hard-code 30 ngày)', async () => {
      const deliveredAt = new Date(Date.now() - 10 * 86_400_000);
      givenOrder({ status: ORDER_STATUS.DELIVERED, deliveredAt });

      settingNumber.mockResolvedValue(7);
      expect((await service.get(SHOP_ID, CODE)).canReturn).toBe(false); // 10 ngày > 7 (30 ngày cũ sẽ báo true sai)

      settingNumber.mockResolvedValue(14);
      expect((await service.get(SHOP_ID, CODE)).canReturn).toBe(true);
      expect(settingNumber).toHaveBeenCalledWith(SETTING_KEY.RETURN_WINDOW_DAYS);
    });

    it('thiếu shop thì tên hiển thị dự phòng "Gian hàng"', async () => {
      givenOrder();
      findBrief.mockResolvedValue(null);

      expect((await service.get(SHOP_ID, CODE)).shopName).toBe('Gian hàng');
    });
  });

  describe('summary', () => {
    it('một câu groupBy theo shop; trạng thái không có đơn trả 0', async () => {
      groupBy.mockResolvedValue([
        { status: 'pending', _count: { _all: 3 } },
        { status: 'shipping', _count: { _all: 2 } },
      ]);

      const r = await service.summary(SHOP_ID);

      expect(groupBy).toHaveBeenCalledTimes(1);
      expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ['status'], where: { shopId: SHOP_ID, isDeleted: false } }));
      expect(r).toEqual({ pending: 3, confirmed: 0, packing: 0, shipping: 2, delivered: 0, completed: 0, cancelled: 0, returned: 0 });
    });
  });

  describe('ownership check', () => {
    it('should throw NotFoundException when order not found', async () => {
      findByCode.mockResolvedValue(null);

      await expect(service.get(SHOP_ID, CODE)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when order belongs to different shop', async () => {
      givenOrder({ shopId: 'different-shop-id' });

      await expect(service.get(SHOP_ID, CODE)).rejects.toThrow(NotFoundException);
    });

    it('should return order when it belongs to the shop', async () => {
      givenOrder();

      const result = await service.get(SHOP_ID, CODE);

      expect(result).toBeDefined();
      expect(result.code).toBe(CODE);
      expect(result.shopName).toBe('Test Shop');
      expect(findBrief).toHaveBeenCalledWith(SHOP_ID);
    });

    it('should reject updateStatus when order belongs to different shop', async () => {
      givenOrder({ shopId: 'different-shop-id' });

      await expect(service.updateStatus(mockActor, SHOP_ID, CODE, 'confirmed', {})).rejects.toMatchObject({ errorCode: ORDER_ERR.NOT_FOUND });
      await expect(service.updateStatus(mockActor, SHOP_ID, CODE, 'confirmed', {})).rejects.toThrow(NotFoundException);
      expect(updateStatus).not.toHaveBeenCalled();
    });

    it('should reject cancel when order belongs to different shop', async () => {
      givenOrder({ shopId: 'different-shop-id' });

      await expect(service.cancel(mockActor, SHOP_ID, CODE, 'Out of stock')).rejects.toMatchObject({ errorCode: ORDER_ERR.NOT_FOUND });
      await expect(service.cancel(mockActor, SHOP_ID, CODE, 'Out of stock')).rejects.toThrow(NotFoundException);
      expect(cancelByStaff).not.toHaveBeenCalled();
    });
  });

  describe('cancel operation', () => {
    it('should allow cancel when order is pending', async () => {
      givenOrder({ status: ORDER_STATUS.PENDING });
      cancelByStaff.mockResolvedValue(orderResponse);

      const result = await service.cancel(mockActor, SHOP_ID, CODE, 'Out of stock');

      expect(result.code).toBe(CODE);
      expect(cancelByStaff).toHaveBeenCalledWith(mockActor, CODE, 'Out of stock');
    });

    it('should allow cancel when order is confirmed', async () => {
      givenOrder({ status: ORDER_STATUS.CONFIRMED });
      cancelByStaff.mockResolvedValue(orderResponse);

      await service.cancel(mockActor, SHOP_ID, CODE, 'Out of stock');

      expect(cancelByStaff).toHaveBeenCalledWith(mockActor, CODE, 'Out of stock');
    });

    /*
     * M1: STAFF_TRANSITIONS.packing = ['shipping'] (không có cancelled) nên OrderService.cancelByStaff luôn ném
     * ORDER_CANNOT_CANCEL cho đơn packing. Service vendor chặn sớm — KHÔNG gọi OrderService.
     */
    it('should reject cancel when order is packing (không gọi OrderService)', async () => {
      givenOrder({ status: ORDER_STATUS.PACKING });

      await expect(service.cancel(mockActor, SHOP_ID, CODE, 'Found damaged items')).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
      expect(cancelByStaff).not.toHaveBeenCalled();
    });

    it('đồng bộ với lưới của OrderService: mọi trạng thái vendor được huỷ đều có `cancelled` trong STAFF_TRANSITIONS', async () => {
      for (const status of Object.values(ORDER_STATUS)) {
        cancelByStaff.mockReset();
        cancelByStaff.mockResolvedValue(orderResponse);
        givenOrder({ status });

        const passed = await service.cancel(mockActor, SHOP_ID, CODE, 'Out of stock').then(
          () => true,
          () => false,
        );

        if (passed) expect(STAFF_TRANSITIONS[status] ?? []).toContain(ORDER_STATUS.CANCELLED);
      }
    });

    it('should reject cancel when order is shipping', async () => {
      givenOrder({ status: ORDER_STATUS.SHIPPING });

      await expect(service.cancel(mockActor, SHOP_ID, CODE, 'Out of stock')).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
      expect(cancelByStaff).not.toHaveBeenCalled();
    });

    it('should reject cancel when order is delivered', async () => {
      givenOrder({ status: ORDER_STATUS.DELIVERED });

      await expect(service.cancel(mockActor, SHOP_ID, CODE, 'Out of stock')).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
      expect(cancelByStaff).not.toHaveBeenCalled();
    });

    it('should reject cancel when order is completed', async () => {
      givenOrder({ status: ORDER_STATUS.COMPLETED });

      await expect(service.cancel(mockActor, SHOP_ID, CODE, 'Out of stock')).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
      expect(cancelByStaff).not.toHaveBeenCalled();
    });

    it('should reject cancel when order is already cancelled', async () => {
      givenOrder({ status: ORDER_STATUS.CANCELLED });

      await expect(service.cancel(mockActor, SHOP_ID, CODE, 'Out of stock')).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
      expect(cancelByStaff).not.toHaveBeenCalled();
    });
  });
});
