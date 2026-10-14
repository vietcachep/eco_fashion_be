import type { NotificationGateway, NotifyCommand } from '@common/gateway/notification.gateway';
import type { OutboxEventMessage } from '@common/outbox/outbox';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { OrderQueryApi } from '../order/queryapi/order.queryapi';
import type { ProductQueryApi } from '../product/queryapi/product.queryapi';
import type { ShopQueryApi } from '../shop/queryapi/shop.queryapi';
import { ShopNotificationListeners, startOfVnDay } from './system-worker.module';

type ProductBrief = Awaited<ReturnType<ProductQueryApi['findProductBrief']>>;
type OrderTotals = Awaited<ReturnType<OrderQueryApi['orderTotalsOf']>>;

const EVENT_ID = 'evt-1';

/* Thông điệp outbox ORDER_CREATED — payload khớp đúng những gì OrderService.publish (order.service.ts) ghi vào outbox. */
function orderCreatedEvent(payload: Record<string, unknown>): OutboxEventMessage {
  return {
    id: EVENT_ID,
    module: 'order',
    eventType: 'ORDER_CREATED',
    eventVersion: 'v1',
    aggregateType: 'order',
    aggregateId: 'ord-id',
    payload: { orderGroupCode: 'GRP-001', userId: 'cust-1', methodCode: 'cod', ...payload },
    requestId: null,
    createdAt: new Date().toISOString(),
  };
}

/* ORDER_PAID: payload của OrderService.onPaid — KHÔNG có shopId/total (listener tự tra qua OrderQueryApi). */
function orderPaidEvent(payload: Record<string, unknown>): OutboxEventMessage {
  return { ...orderCreatedEvent({}), eventType: 'ORDER_PAID', payload: { userId: 'cust-1', ...payload } };
}

function stockLowEvent(payload: { variantId: string; productId: string; sku: string; available: number }): OutboxEventMessage {
  return {
    id: 'evt-2',
    module: 'product',
    eventType: 'PRODUCT_STOCK_LOW',
    eventVersion: 'v1',
    aggregateType: 'product_variant',
    aggregateId: payload.variantId,
    payload,
    requestId: null,
    createdAt: new Date().toISOString(),
  };
}

function bankChangedEvent(payload: Record<string, unknown>): OutboxEventMessage {
  return {
    id: 'evt-3',
    module: 'shop',
    eventType: 'SHOP_BANK_CHANGED',
    eventVersion: 'v1',
    aggregateType: 'shop',
    aggregateId: 'shop-123',
    payload,
    requestId: null,
    createdAt: new Date().toISOString(),
  };
}

function productBrief(overrides: Partial<NonNullable<ProductBrief>> = {}): NonNullable<ProductBrief> {
  return { id: 'prod-1', slug: 'san-pham', name: 'Sản phẩm', status: 'active', shopId: 'shop-123', ...overrides };
}

/* Mọi thông báo đã gửi (gộp các lần notifyMany) — dễ assert theo người nhận. */
function sentCommands(notifyMany: jest.Mock<Promise<void>, [NotifyCommand[]]>): NotifyCommand[] {
  return notifyMany.mock.calls.flatMap((c) => c[0]);
}

describe('ShopNotificationListeners', () => {
  let listeners: ShopNotificationListeners;

  /*
   * Mỗi phương thức mock giữ trong BIẾN RIÊNG (không đọc lại qua `obj.method`) để assert không dính
   * `unbound-method`; object giả chỉ có đúng phương thức listener gọi, ép kiểu một lần khi tạo.
   */
  const notifyMany = jest.fn<Promise<void>, [NotifyCommand[]]>();
  const activeMemberUserIds = jest.fn<Promise<string[]>, [string]>();
  const findProductBrief = jest.fn<Promise<ProductBrief>, [string]>();
  const shopIdOfOrder = jest.fn<Promise<string | null>, [string]>();
  const orderTotalsOf = jest.fn<Promise<OrderTotals>, [string[]]>();
  const notificationFindMany = jest.fn<Promise<Array<{ userId: string }>>, [{ where: Record<string, unknown> }]>();

  beforeEach(() => {
    jest.resetAllMocks();
    notifyMany.mockResolvedValue(undefined);
    notificationFindMany.mockResolvedValue([]); // chưa ai nhận thông báo của event này

    const prisma = { notification: { findMany: notificationFindMany } } as unknown as PrismaService;
    const notify = { notifyMany } as unknown as NotificationGateway;
    const shops = { activeMemberUserIds } as unknown as ShopQueryApi;
    const products = { findProductBrief } as unknown as ProductQueryApi;
    const orders = { shopIdOfOrder, orderTotalsOf } as unknown as OrderQueryApi;

    listeners = new ShopNotificationListeners(prisma, notify, shops, products, orders);
  });

  describe('cấu hình listener', () => {
    /* Nuốt lỗi (suppressErrors mặc định true) khiến relay đánh DONE và MẤT thông báo → mọi listener phải để lỗi nổi lên. */
    it.each(['onOrderCreated', 'onOrderPaid', 'onStockLow', 'onShopBankChanged'] as const)('%s đăng ký với suppressErrors=false', (name) => {
      const handler = Object.getOwnPropertyDescriptor(ShopNotificationListeners.prototype, name)?.value as object;
      const meta = Reflect.getMetadata('EVENT_LISTENER_METADATA', handler) as Array<{ event: string; options?: { suppressErrors?: boolean } }> | undefined;

      expect(meta).toHaveLength(1);
      expect(meta?.[0].options?.suppressErrors).toBe(false);
    });

    it('đăng ký đúng tên sự kiện outbox', () => {
      const eventOf = (name: 'onOrderCreated' | 'onOrderPaid' | 'onStockLow' | 'onShopBankChanged') => {
        const handler = Object.getOwnPropertyDescriptor(ShopNotificationListeners.prototype, name)?.value as object;
        return (Reflect.getMetadata('EVENT_LISTENER_METADATA', handler) as Array<{ event: string }>)[0].event;
      };

      expect(eventOf('onOrderCreated')).toBe('outbox.order.ORDER_CREATED');
      expect(eventOf('onOrderPaid')).toBe('outbox.order.ORDER_PAID');
      expect(eventOf('onStockLow')).toBe('outbox.product.PRODUCT_STOCK_LOW');
      expect(eventOf('onShopBankChanged')).toBe('outbox.shop.SHOP_BANK_CHANGED');
    });
  });

  describe('onOrderCreated', () => {
    it('Định dạng tiêu đề đơn "Đơn mới #CODE" + tiền VND đúng (1.500.000 ₫)', async () => {
      const orderCode = 'ORD-2026001';
      activeMemberUserIds.mockResolvedValue(['user-1', 'user-2']);

      // itemCount do OrderService ghi sẵn vào payload outbox (tổng quantity của các dòng) — listener không tra DB lại.
      await listeners.onOrderCreated(orderCreatedEvent({ orderCode, shopId: 'shop-123', total: '1500000', itemCount: 3 }));

      expect(notifyMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'order',
            title: `Đơn mới #${orderCode}`,
            content: '3 sản phẩm · 1.500.000 ₫',
            link: `/vendor/orders/${orderCode}`,
          }),
        ]),
      );
    });

    it('tổng nhỏ hơn 1000 không bị làm tròn về "0k" (500 ₫)', async () => {
      activeMemberUserIds.mockResolvedValue(['user-1']);

      await listeners.onOrderCreated(orderCreatedEvent({ orderCode: 'ORD-1', shopId: 'shop-123', total: '500', itemCount: 1 }));

      expect(sentCommands(notifyMany)[0].content).toBe('1 sản phẩm · 500 ₫');
    });

    it('Gửi thông báo tới TẤT CẢ thành viên active của shop', async () => {
      activeMemberUserIds.mockResolvedValue(['user-1', 'user-2', 'user-3']);

      await listeners.onOrderCreated(orderCreatedEvent({ orderCode: 'ORD-001', shopId: 'shop-123', total: '500000', itemCount: 2 }));

      expect(activeMemberUserIds).toHaveBeenCalledWith('shop-123');
      expect(sentCommands(notifyMany).map((c) => c.userId)).toEqual(['user-1', 'user-2', 'user-3']);
    });

    it('Bỏ qua khi shop không có thành viên active', async () => {
      activeMemberUserIds.mockResolvedValue([]);

      await listeners.onOrderCreated(orderCreatedEvent({ orderCode: 'ORD-001', shopId: 'shop-empty', total: '500000' }));

      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('Payload chứa shopId + orderCode (deep-link) + eventId (khoá dedupe)', async () => {
      activeMemberUserIds.mockResolvedValue(['user-1']);

      await listeners.onOrderCreated(orderCreatedEvent({ orderCode: 'ORD-2026001', shopId: 'shop-123', total: '250000', itemCount: 1 }));

      expect(sentCommands(notifyMany)[0].payload).toEqual({ shopId: 'shop-123', orderCode: 'ORD-2026001', eventId: EVENT_ID });
    });

    it('payload thiếu orderCode/shopId: không ném, không gửi (retry không chữa được)', async () => {
      await expect(listeners.onOrderCreated(orderCreatedEvent({ total: '1000' }))).resolves.toBeUndefined();

      expect(notifyMany).not.toHaveBeenCalled();
    });

    describe('idempotent (relay claim lại event PROCESSING quá 10 phút / retry)', () => {
      it('kiểm tồn tại theo (userId, payload.eventId)', async () => {
        activeMemberUserIds.mockResolvedValue(['user-1', 'user-2']);

        await listeners.onOrderCreated(orderCreatedEvent({ orderCode: 'ORD-001', shopId: 'shop-123', total: '1000' }));

        const where = notificationFindMany.mock.calls[0][0].where;
        expect(where.userId).toEqual({ in: ['user-1', 'user-2'] });
        expect(JSON.stringify(where.OR)).toContain(JSON.stringify({ payload: { path: ['eventId'], equals: EVENT_ID } }));
      });

      it('chỉ gửi cho người CHƯA nhận (xử lý lại sau khi đã gửi một phần)', async () => {
        activeMemberUserIds.mockResolvedValue(['user-1', 'user-2', 'user-3']);
        notificationFindMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-3' }]);

        await listeners.onOrderCreated(orderCreatedEvent({ orderCode: 'ORD-001', shopId: 'shop-123', total: '1000' }));

        expect(sentCommands(notifyMany).map((c) => c.userId)).toEqual(['user-2']);
      });

      it('mọi người đã nhận → KHÔNG gửi lại', async () => {
        activeMemberUserIds.mockResolvedValue(['user-1', 'user-2']);
        notificationFindMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]);

        await listeners.onOrderCreated(orderCreatedEvent({ orderCode: 'ORD-001', shopId: 'shop-123', total: '1000' }));

        expect(notifyMany).not.toHaveBeenCalled();
      });
    });

    describe('KHÔNG nuốt lỗi (để relay retry thay vì đánh DONE)', () => {
      it('gateway lỗi → listener ném lỗi lên', async () => {
        activeMemberUserIds.mockResolvedValue(['user-1']);
        notifyMany.mockRejectedValue(new Error('db down'));

        await expect(listeners.onOrderCreated(orderCreatedEvent({ orderCode: 'ORD-001', shopId: 'shop-123', total: '1000' }))).rejects.toThrow('db down');
      });

      it('tra thành viên shop lỗi → ném lỗi lên', async () => {
        activeMemberUserIds.mockRejectedValue(new Error('timeout'));

        await expect(listeners.onOrderCreated(orderCreatedEvent({ orderCode: 'ORD-001', shopId: 'shop-123', total: '1000' }))).rejects.toThrow('timeout');
      });
    });
  });

  describe('onOrderPaid', () => {
    function givenPaidOrder(): void {
      shopIdOfOrder.mockResolvedValue('shop-123');
      activeMemberUserIds.mockResolvedValue(['user-1', 'user-2']);
      orderTotalsOf.mockResolvedValue(new Map([['ORD-001', { total: { toString: () => '1030000' }, platformDiscount: { toString: () => '0' } }]]) as unknown as OrderTotals);
    }

    it('đơn VNPay đã thanh toán → báo mọi thành viên shop (type payment, link tới đơn, tiền + phương thức)', async () => {
      givenPaidOrder();

      await listeners.onOrderPaid(orderPaidEvent({ orderCode: 'ORD-001', methodCode: 'vnpay' }));

      expect(shopIdOfOrder).toHaveBeenCalledWith('ORD-001');
      expect(activeMemberUserIds).toHaveBeenCalledWith('shop-123');
      const cmds = sentCommands(notifyMany);
      expect(cmds.map((c) => c.userId)).toEqual(['user-1', 'user-2']);
      expect(cmds[0]).toMatchObject({
        type: 'payment',
        title: 'Đơn #ORD-001 đã thanh toán',
        link: '/vendor/orders/ORD-001',
        payload: { shopId: 'shop-123', orderCode: 'ORD-001', eventId: EVENT_ID },
      });
      expect(cmds[0].content).toContain('1.030.000 ₫');
      expect(cmds[0].content).toContain('VNPay');
    });

    it('chuyển khoản cũng được báo', async () => {
      givenPaidOrder();

      await listeners.onOrderPaid(orderPaidEvent({ orderCode: 'ORD-001', methodCode: 'bank_transfer' }));

      expect(sentCommands(notifyMany)[0].content).toContain('chuyển khoản');
    });

    it('đơn COD KHÔNG báo (tiền thu lúc giao) và không tra DB', async () => {
      await listeners.onOrderPaid(orderPaidEvent({ orderCode: 'ORD-001', methodCode: 'cod' }));

      expect(shopIdOfOrder).not.toHaveBeenCalled();
      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('không tìm thấy shop của đơn → bỏ qua, không ném', async () => {
      shopIdOfOrder.mockResolvedValue(null);

      await expect(listeners.onOrderPaid(orderPaidEvent({ orderCode: 'ORD-404', methodCode: 'vnpay' }))).resolves.toBeUndefined();
      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('idempotent: người đã nhận thông báo của event này không nhận lại', async () => {
      givenPaidOrder();
      notificationFindMany.mockResolvedValue([{ userId: 'user-1' }]);

      await listeners.onOrderPaid(orderPaidEvent({ orderCode: 'ORD-001', methodCode: 'vnpay' }));

      expect(sentCommands(notifyMany).map((c) => c.userId)).toEqual(['user-2']);
    });

    it('lỗi hạ tầng → ném lên để relay retry', async () => {
      shopIdOfOrder.mockRejectedValue(new Error('db down'));

      await expect(listeners.onOrderPaid(orderPaidEvent({ orderCode: 'ORD-001', methodCode: 'vnpay' }))).rejects.toThrow('db down');
    });
  });

  describe('onStockLow', () => {
    it('Định dạng: "Sắp hết hàng: <tên sản phẩm>" + "SKU … · Còn N"', async () => {
      findProductBrief.mockResolvedValue(productBrief({ name: 'Áo thun unisex' }));
      activeMemberUserIds.mockResolvedValue(['user-1']);

      await listeners.onStockLow(stockLowEvent({ variantId: 'var-1', productId: 'prod-1', sku: 'SKU-001', available: 3 }));

      expect(notifyMany).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: 'inventory', title: 'Sắp hết hàng: Áo thun unisex', content: 'SKU SKU-001 · Còn 3' })]));
    });

    it('Link tới /vendor/inventory', async () => {
      findProductBrief.mockResolvedValue(productBrief());
      activeMemberUserIds.mockResolvedValue(['user-1']);

      await listeners.onStockLow(stockLowEvent({ variantId: 'var-1', productId: 'prod-1', sku: 'SKU-001', available: 2 }));

      expect(sentCommands(notifyMany)[0].link).toBe('/vendor/inventory');
    });

    it('Dedupe theo variantId + ngày (KHÔNG theo `content contains sku` — `AO-1` từng khớp nhầm `AO-10`)', async () => {
      findProductBrief.mockResolvedValue(productBrief());
      activeMemberUserIds.mockResolvedValue(['user-1']);

      await listeners.onStockLow(stockLowEvent({ variantId: 'var-1', productId: 'prod-1', sku: 'AO-1', available: 2 }));

      const where = notificationFindMany.mock.calls[0][0].where;
      const skipRule = (where.OR as Array<Record<string, unknown>>)[1];
      expect(skipRule).toMatchObject({ type: 'inventory', payload: { path: ['variantId'], equals: 'var-1' } });
      expect(skipRule).not.toHaveProperty('content');
      expect((skipRule.createdAt as { gte: Date }).gte.getTime()).toBe(startOfVnDay().getTime());
    });

    it('người đã nhận thông báo biến thể này hôm nay thì bỏ qua; người còn lại vẫn nhận', async () => {
      findProductBrief.mockResolvedValue(productBrief());
      activeMemberUserIds.mockResolvedValue(['user-1', 'user-2']);
      notificationFindMany.mockResolvedValue([{ userId: 'user-1' }]);

      await listeners.onStockLow(stockLowEvent({ variantId: 'var-1', productId: 'prod-1', sku: 'SKU-001', available: 1 }));

      expect(sentCommands(notifyMany).map((c) => c.userId)).toEqual(['user-2']);
    });

    it('mọi người đã nhận → không gửi', async () => {
      findProductBrief.mockResolvedValue(productBrief());
      activeMemberUserIds.mockResolvedValue(['user-1']);
      notificationFindMany.mockResolvedValue([{ userId: 'user-1' }]);

      await listeners.onStockLow(stockLowEvent({ variantId: 'var-1', productId: 'prod-1', sku: 'SKU-001', available: 1 }));

      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('Payload chứa shopId + variantId + productId để deep-link, kèm eventId', async () => {
      findProductBrief.mockResolvedValue(productBrief({ id: 'prod-1', shopId: 'shop-123' }));
      activeMemberUserIds.mockResolvedValue(['user-1']);

      await listeners.onStockLow(stockLowEvent({ variantId: 'var-1', productId: 'prod-1', sku: 'SKU-001', available: 5 }));

      expect(sentCommands(notifyMany)[0].payload).toEqual({ shopId: 'shop-123', variantId: 'var-1', productId: 'prod-1', eventId: 'evt-2' });
    });

    it('Bỏ qua khi sản phẩm không tìm thấy', async () => {
      findProductBrief.mockResolvedValue(null);

      await listeners.onStockLow(stockLowEvent({ variantId: 'var-1', productId: 'prod-missing', sku: 'SKU-001', available: 0 }));

      expect(notifyMany).not.toHaveBeenCalled();
      expect(activeMemberUserIds).not.toHaveBeenCalled();
    });

    it('lỗi gateway → ném lên để relay retry', async () => {
      findProductBrief.mockResolvedValue(productBrief());
      activeMemberUserIds.mockResolvedValue(['user-1']);
      notifyMany.mockRejectedValue(new Error('db down'));

      await expect(listeners.onStockLow(stockLowEvent({ variantId: 'var-1', productId: 'prod-1', sku: 'SKU-001', available: 1 }))).rejects.toThrow('db down');
    });
  });

  describe('onShopBankChanged', () => {
    const payload = { shopId: 'shop-123', code: 'SHOP-001', name: 'Test Shop', bankCode: '970436', bankAccountName: 'NGUYEN VAN A', bankAccountNumberMasked: '••••••••9012', bankAccountLast4: '9012', changedByUserId: 'user-9', changedByEmail: 'quanly@shop.vn' };

    it('báo TẤT CẢ thành viên active; nêu ai đổi + 4 số cuối; không lộ số tài khoản đầy đủ', async () => {
      activeMemberUserIds.mockResolvedValue(['user-1', 'user-9']);

      await listeners.onShopBankChanged(bankChangedEvent(payload));

      expect(activeMemberUserIds).toHaveBeenCalledWith('shop-123');
      const cmds = sentCommands(notifyMany);
      expect(cmds.map((c) => c.userId)).toEqual(['user-1', 'user-9']);
      expect(cmds[0]).toMatchObject({ type: 'system', link: '/vendor/shop', payload: { shopId: 'shop-123', eventId: 'evt-3' } });
      expect(cmds[0].content).toContain('quanly@shop.vn');
      expect(cmds[0].content).toContain('9012');
      expect(cmds[0].content).toContain('liên hệ sàn');
      expect(JSON.stringify(cmds)).not.toContain('123456789012');
    });

    it('thiếu bankAccountLast4 thì lấy 4 số cuối từ bản che', async () => {
      activeMemberUserIds.mockResolvedValue(['user-1']);

      await listeners.onShopBankChanged(bankChangedEvent({ shopId: 'shop-123', bankAccountNumberMasked: '••••••••9012', changedByEmail: 'a@b.vn' }));

      expect(sentCommands(notifyMany)[0].content).toContain('••••9012');
    });

    it('idempotent: người đã nhận không nhận lại', async () => {
      activeMemberUserIds.mockResolvedValue(['user-1', 'user-2']);
      notificationFindMany.mockResolvedValue([{ userId: 'user-2' }]);

      await listeners.onShopBankChanged(bankChangedEvent(payload));

      expect(sentCommands(notifyMany).map((c) => c.userId)).toEqual(['user-1']);
    });

    it('thiếu shopId: không ném, không gửi', async () => {
      await expect(listeners.onShopBankChanged(bankChangedEvent({}))).resolves.toBeUndefined();

      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('lỗi gateway → ném lên để relay retry', async () => {
      activeMemberUserIds.mockResolvedValue(['user-1']);
      notifyMany.mockRejectedValue(new Error('db down'));

      await expect(listeners.onShopBankChanged(bankChangedEvent(payload))).rejects.toThrow('db down');
    });
  });
});

describe('startOfVnDay — "hôm nay" theo giờ Việt Nam (UTC+7), không theo TZ máy chủ', () => {
  it('03:00 sáng 04/10 VN (= 20:00Z ngày 03/10) → 00:00 VN ngày 04/10 = 17:00Z ngày 03/10', () => {
    expect(startOfVnDay(new Date('2026-10-03T20:00:00.000Z')).toISOString()).toBe('2026-10-03T17:00:00.000Z');
  });

  it('17:00 chiều 03/10 VN (= 10:00Z) → 00:00 VN ngày 03/10 = 17:00Z ngày 02/10', () => {
    expect(startOfVnDay(new Date('2026-10-03T10:00:00.000Z')).toISOString()).toBe('2026-10-02T17:00:00.000Z');
  });

  it('đúng 00:00 VN thì giữ nguyên', () => {
    expect(startOfVnDay(new Date('2026-10-02T17:00:00.000Z')).toISOString()).toBe('2026-10-02T17:00:00.000Z');
  });
});
