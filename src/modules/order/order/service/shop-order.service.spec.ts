import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { Prisma } from '@common/prisma/types';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { PaymentGateway, RefundSummary } from '@common/gateway/payment.gateway';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ShopBrief, ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import type { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import type { ShippingQueryApi, ShipmentSummary } from '@modules/shipping/queryapi/shipping.queryapi';
import { ORDER_ERR, ORDER_STATUS } from '../../foundation/order.constants';
import type { OrderResponse } from '../dto/order.responses';
import type { OrderRepository, OrderRow } from '../repository/order.repository';
import type { OrderService } from './order.service';
import { ShopOrderService } from './shop-order.service';

/* Dòng đơn đủ trường theo OrderRow (Prisma); test chỉ ghi đè trạng thái/shop. */
function makeOrderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    fulfilmentMode: 'self',
    collectionMode: null,
    shippingProvider: null,
    shippingEnvironment: null,
    shippingQuoteId: null,
    shippingSnapshot: null,
    id: 'order-id-1',
    code: 'DH2609150001',
    userId: 'customer-123',
    shopId: 'shop-123',
    orderGroupId: 'group-123',
    commissionRateSnapshot: new Prisma.Decimal('10.00'),
    shopShippingDiscount: new Prisma.Decimal(0),
    platformShippingDiscount: new Prisma.Decimal(0),
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
    carrier: null,
    trackingCode: null,
    trackingReused: false,
    deliveryFailedAt: null,
    deliveryFailedReason: null,
    goodsReturnedAt: null,
    paymentExpiresAt: null,
    confirmedAt: null,
    packedAt: null,
    shippedAt: null,
    deliveredAt: null,
    completedAt: null,
    cancelledAt: null,
    shippingAlertedAt: null,
    // PLAN-0027
    confirmDueAt: null,
    shipDueAt: null,
    confirmRemindedAt: null,
    shipRemindedAt: null,
    shipExtendedAt: null,
    shipExtendReason: null,
    cancelReasonCode: null,
    cancelSource: null,
    cancelRequestStatus: null,
    cancelRequestedAt: null,
    cancelRequestReasonCode: null,
    cancelRequestNote: null,
    cancelRequestDueAt: null,
    cancelRequestResolvedBy: null,
    cancelRequestRejectReason: null,
    completedBy: null,
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
  const cancelByShop = jest.fn<Promise<void>, Parameters<OrderService['cancelByShop']>>();
  const deliveryFailed = jest.fn<Promise<void>, Parameters<OrderService['deliveryFailed']>>();
  const refundSummaries = jest.fn<Promise<Map<string, RefundSummary>>, [string[]]>();
  const list = jest.fn<Promise<{ items: OrderRow[]; total: number }>, [unknown, number, number]>();
  const findBrief = jest.fn<Promise<ShopBrief | null>, [string]>();
  const settingNumber = jest.fn<Promise<number>, [string]>();
  const groupBy = jest.fn<Promise<Array<{ status: string; _count: { _all: number } }>>, [unknown]>();
  const latestShipment = jest.fn<Promise<ShipmentSummary | null>, [string]>();

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
    const repo = { findByCode, list } as unknown as OrderRepository;
    const orders = { updateStatus, cancelByStaff, cancelByShop, deliveryFailed } as unknown as OrderService;
    const shops = { findBrief } as unknown as ShopQueryApi;
    const system = { settingNumber } as unknown as SystemQueryApi;

    const payment = { refundSummaries } as unknown as PaymentGateway;

    service = new ShopOrderService(prisma, repo, orders, shops, system, payment, { latest: latestShipment } as unknown as ShippingQueryApi);

    findBrief.mockResolvedValue({ id: SHOP_ID, code: 'SHOP-1', slug: 'test-shop', name: 'Test Shop', logoUrl: null, ratingAvg: null, status: 'approved', commissionRate: '10.00'  });
    settingNumber.mockResolvedValue(7);
    refundSummaries.mockResolvedValue(new Map());
    latestShipment.mockResolvedValue(null);
  });

  describe('PLAN-0043 — quyền huỷ theo trạng thái vận đơn', () => {
    function shipment(overrides: Partial<ShipmentSummary> = {}): ShipmentSummary {
      return { id: 'shipment-1', orderCode: CODE, shopId: SHOP_ID, provider: 'fake', environment: 'demo', createStatus: 'created', cancelStatus: 'none', status: 'awaiting_pickup', active: true, carrierOrderCode: 'FAKE-DH-1', clientOrderCode: 'DH-1-SA', trackingUrl: null, pickedUpAt: null, deliveredAt: null, attemptNo: 1, quotedFee: '30000', actualFee: '30000', codAmount: '1030000', expectedDeliveryAt: null, error: null, simulated: true, deliveryAttempts: 0, codCollectedAt: null, codRemittedAt: null, events: [], ...overrides };
    }
    it('đơn shipping chỉ chờ lấy được huỷ; đọc shipment đúng một lần', async () => {
      givenOrder({ fulfilmentMode: 'carrier', status: ORDER_STATUS.SHIPPING }); latestShipment.mockResolvedValue(shipment());
      const response = await service.get(SHOP_ID, CODE);
      expect(response.canCancel).toBe(true); expect(response.shipment?.status).toBe('awaiting_pickup');
      expect(latestShipment).toHaveBeenCalledTimes(1); expect(latestShipment).toHaveBeenCalledWith(CODE);
    });
    it.each(['creating', 'unknown'])('đang %s không hiện huỷ kể cả đơn còn packing', async (createStatus) => {
      givenOrder({ fulfilmentMode: 'carrier', status: ORDER_STATUS.PACKING }); latestShipment.mockResolvedValue(shipment({ createStatus, status: null }));
      expect((await service.get(SHOP_ID, CODE)).canCancel).toBe(false);
    });
    it.each(['requested', 'unknown'])('huỷ hãng %s không hiện nút huỷ thêm lần nữa', async (cancelStatus) => {
      givenOrder({ fulfilmentMode: 'carrier', status: ORDER_STATUS.SHIPPING }); latestShipment.mockResolvedValue(shipment({ cancelStatus }));
      expect((await service.get(SHOP_ID, CODE)).canCancel).toBe(false);
    });
    it.each(['picked', 'in_transit', 'delivering', 'returning', 'returned', 'lost'])('trạng thái %s không được huỷ trực tiếp, kể cả thiếu timestamp picked', async (status) => {
      givenOrder({ fulfilmentMode: 'carrier', status: ORDER_STATUS.SHIPPING }); latestShipment.mockResolvedValue(shipment({ status, pickedUpAt: null }));
      expect((await service.get(SHOP_ID, CODE)).canCancel).toBe(false);
    });
    it('carrier packing chưa tạo vận đơn vẫn được huỷ theo luật cũ', async () => {
      givenOrder({ fulfilmentMode: 'carrier', status: ORDER_STATUS.PACKING }); latestShipment.mockResolvedValue(null);
      expect((await service.get(SHOP_ID, CODE)).canCancel).toBe(true);
    });
    it('self shipping không mở quyền huỷ hãng và không query shipment', async () => {
      givenOrder({ fulfilmentMode: 'self', status: ORDER_STATUS.SHIPPING });
      expect((await service.get(SHOP_ID, CODE)).canCancel).toBe(false); expect(latestShipment).not.toHaveBeenCalled();
    });
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
      cancelByShop.mockResolvedValue(undefined);

      const result = await service.cancel(mockActor, SHOP_ID, CODE, { reason: 'Hết hàng' });

      expect(result).not.toBe(orderResponse);
      expectNoPaymentLeak(result);
      // PLAN-0027: kiểm sở hữu + trạng thái nằm trong tx khoá của OrderService.cancelByShop; service vendor chỉ đọc lại đơn SAU khi huỷ (1 lần)
      expect(findByCode).toHaveBeenCalledTimes(1);
    });
  });

  describe('thông tin hiển thị cho vendor', () => {
    it('canCancel theo quyền huỷ của vendor (PLAN-0027): true ở pending/confirmed/packing, false từ shipping trở đi', async () => {
      const results: Record<string, boolean> = {};
      for (const status of [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING, ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED]) {
        givenOrder({ status });
        results[status] = (await service.get(SHOP_ID, CODE)).canCancel;
      }

      expect(results).toEqual({ pending: true, confirmed: true, packing: true, shipping: false, delivered: false, cancelled: false });
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

  describe('khoản hoàn tiền trên đơn (PLAN-0022 §4.5)', () => {
    it('chi tiết đơn: refund = khoản hoàn mới nhất của payment (đang hoàn thay vì "đã thanh toán"); chưa có ⇒ null', async () => {
      givenOrder({ status: ORDER_STATUS.DELIVERED, paymentStatus: 'paid' });
      expect((await service.get(SHOP_ID, CODE)).refund).toBeNull();

      refundSummaries.mockResolvedValue(new Map([[CODE, { status: 'processing', amount: 250_000n }]]));
      const r = await service.get(SHOP_ID, CODE);
      expect(refundSummaries).toHaveBeenLastCalledWith([CODE]);
      expect(r.refund).toEqual({ status: 'processing', amount: { amount: '250000', display: '250.000 ₫', currency: 'VND', symbol: '₫' } });
    });

    it('danh sách: MỘT lần refundSummaries cho cả trang (không N+1) và gắn đúng khoản hoàn từng đơn', async () => {
      const a = makeOrderRow({ code: 'DH-A' });
      const b = makeOrderRow({ code: 'DH-B' });
      const c = makeOrderRow({ code: 'DH-C' });
      list.mockResolvedValue({ items: [a, b, c], total: 3 });
      refundSummaries.mockResolvedValue(new Map([['DH-B', { status: 'done', amount: 100_000n }]]));

      const page = await service.list(SHOP_ID, {}, 1, 20);

      expect(refundSummaries).toHaveBeenCalledTimes(1);
      expect(refundSummaries).toHaveBeenCalledWith(['DH-A', 'DH-B', 'DH-C']);
      expect(page.content.map((o) => o.refund?.status ?? null)).toEqual([null, 'done', null]);
    });
  });

  describe('báo giao không thành công (PLAN-0022)', () => {
    const input = { reasonCode: 'refused' as const, note: 'Khách từ chối nhận hàng', goodsReturned: false };

    it('uỷ quyền cho OrderService.deliveryFailed với shopId từ ngữ cảnh + mã đơn viết hoa, rồi đọc lại đơn (không lộ thông tin thanh toán)', async () => {
      givenOrder({ status: ORDER_STATUS.CANCELLED });
      deliveryFailed.mockResolvedValue(undefined);

      const r = await service.deliveryFailed(mockActor, SHOP_ID, CODE.toLowerCase(), input);

      expect(deliveryFailed).toHaveBeenCalledWith(mockActor, SHOP_ID, CODE, input);
      expectNoPaymentLeak(r);
      expect(r.code).toBe(CODE);
    });

    it('lỗi của OrderService được truyền nguyên sau kiểm tuyến self, không đọc response lần nữa', async () => {
      givenOrder({ status: ORDER_STATUS.SHIPPING, fulfilmentMode: 'self' });
      deliveryFailed.mockRejectedValue(new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng'));

      await expect(service.deliveryFailed(mockActor, SHOP_ID, CODE, input)).rejects.toMatchObject({ errorCode: ORDER_ERR.NOT_FOUND });
      expect(deliveryFailed).toHaveBeenCalledTimes(1);
      expect(findByCode).toHaveBeenCalledTimes(1); // chỉ preflight ownership/mode, không dựng response sau lỗi.
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

    it('should reject cancel when order belongs to different shop (404 từ OrderService.cancelByShop, KHÔNG rơi sang cancelByStaff)', async () => {
      cancelByShop.mockRejectedValue(new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng'));

      await expect(service.cancel(mockActor, SHOP_ID, CODE, { reason: 'Out of stock' })).rejects.toMatchObject({ errorCode: ORDER_ERR.NOT_FOUND });
      await expect(service.cancel(mockActor, SHOP_ID, CODE, { reason: 'Out of stock' })).rejects.toThrow(NotFoundException);
      expect(cancelByStaff).not.toHaveBeenCalled();
    });
  });

  /*
   * PLAN-0027: luật "shop huỷ được trạng thái nào" nằm TRONG tx khoá dòng của OrderService.cancelByShop (kiểm thử ở order-lifecycle.spec.ts: [CAN-06], [CAN-07], [CAN-12], [CAN-15]).
   * Service vendor chỉ chuyển tiếp (kèm shopId của phiên) rồi đọc lại đơn để trả response không lộ thanh toán.
   */
  describe('cancel operation', () => {
    it.each([ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING])('[CAN-07] chuyển tiếp huỷ đơn %s sang OrderService.cancelByShop kèm shopId phiên + mã lý do', async (status) => {
      givenOrder({ status });
      cancelByShop.mockResolvedValue(undefined);

      const result = await service.cancel(mockActor, SHOP_ID, CODE.toLowerCase(), { reasonCode: 'out_of_stock', note: 'Hết hàng' });

      expect(result.code).toBe(CODE);
      expect(cancelByShop).toHaveBeenCalledWith(mockActor, SHOP_ID, CODE, { reasonCode: 'out_of_stock', note: 'Hết hàng' });
      expect(cancelByStaff).not.toHaveBeenCalled();
    });

    it('lỗi của OrderService (đơn đang giao/đã giao/đã huỷ ⇒ 409 CANNOT_CANCEL) được giữ nguyên, không đọc lại đơn', async () => {
      cancelByShop.mockRejectedValue(new BusinessException(ORDER_ERR.CANNOT_CANCEL, 'Không huỷ được', 409));

      await expect(service.cancel(mockActor, SHOP_ID, CODE, { reason: 'Out of stock' })).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
      expect(findByCode).not.toHaveBeenCalled();
    });
  });
});
