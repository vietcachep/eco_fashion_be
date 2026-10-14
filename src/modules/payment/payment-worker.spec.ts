import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { OutboxEventMessage } from '@common/outbox/outbox';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { ORDER_EVENT, ORDER_MODULE } from '@modules/order/enums/order-events';
import { type CodScanCursor, OrderQueryApi } from '@modules/order/queryapi/order.queryapi';
import { SHOP_EVENT, SHOP_MODULE } from '@modules/shop/enums/shop-events';
import { PAYMENT_EVENT, PAYMENT_MODULE } from './foundation/payment.constants';
import { PaymentEventListeners, PaymentJobs } from './payment-worker.module';
import type { PaymentService } from './payment/payment.service';
import type { ShopWalletService } from './shop-wallet/service/shop-wallet.service';

/*
 * Test listener + job của payment worker (tiền COD): hoa hồng COD khi đơn hoàn tất, đảo hoa hồng khi hoàn tiền đơn COD, tạo ví khi shop được duyệt,
 * job đối soát bù. OrderQueryApi và ShopWalletService là mock; logic tính tiền (codNetCommission) chạy THẬT qua listener.
 */

type Dec = Prisma.Decimal;
type CodPage = { codes: string[]; next: CodScanCursor | null };
const D = (v: string | number): Dec => new Prisma.Decimal(v);

const SHOP = '11111111-1111-4111-8111-111111111111';
const REFUND_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const REFUND_KEY = 'RF-f47ac10b58cc4372a5670e02b2';

type OrderBasis = { paymentMethodCode: string; total: Dec; platformDiscount: Dec; commissionRateSnapshot: Dec; shopId: string };
type ChargeInput = { shopId: string; orderCode: string; amount: Dec };
type RefundInput = { shopId: string; orderCode: string; refundKey: string; amount: string; commissionReversal: Dec };

/* Đơn cơ sở để tính hoa hồng: total = khách trả, pd = voucher sàn chịu, rate = % hoa hồng snapshot. */
const basis = (o: { total: number; pd?: number; rate?: string; method?: string; shopId?: string }): OrderBasis => ({
  paymentMethodCode: o.method ?? 'cod',
  total: D(o.total),
  platformDiscount: D(o.pd ?? 0),
  commissionRateSnapshot: D(o.rate ?? '10.00'),
  shopId: o.shopId ?? SHOP,
});

const msg = (payload: Record<string, unknown>, eventType = 'X'): OutboxEventMessage => ({ id: 'evt-1', module: 'x', eventType, eventVersion: '1', aggregateType: 'x', aggregateId: 'a-1', payload, requestId: null, createdAt: '2025-03-10T00:00:00.000Z' });

function buildListeners() {
  const orders = {
    commissionBasisOf: jest.fn((_code: string) => Promise.resolve<OrderBasis | null>(null)),
    completedCodOrderCodesSince: jest.fn((_days: number, _limit: number, _after?: CodScanCursor | null) => Promise.resolve<CodPage>({ codes: [], next: null })),
  };
  const wallet = {
    refundedTotalOfOrder: jest.fn((_code: string) => Promise.resolve(D(0))),
    chargeCodCommission: jest.fn((_input: ChargeInput) => Promise.resolve(true)),
    hasCodCommission: jest.fn((_shopId: string, _code: string) => Promise.resolve(false)),
    recordCodRefund: jest.fn((_input: RefundInput) => Promise.resolve(true)),
    ensureWallet: jest.fn((_shopId: string) => Promise.resolve()),
    chargedOrderCodes: jest.fn((_codes: string[]) => Promise.resolve(new Set<string>())),
  };
  const listeners = new PaymentEventListeners(orders as unknown as OrderQueryApi, wallet as unknown as ShopWalletService);
  return { orders, wallet, listeners, charged: () => wallet.chargeCodCommission.mock.calls[0][0] };
}

describe('PaymentEventListeners — hoa hồng COD, hoàn tiền COD, tạo ví', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /* ============================================================ */
  describe('chargeCodOrder', () => {
    it('đơn không tồn tại ⇒ false, cảnh báo, KHÔNG đụng ví', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(null);

      expect(await listeners.chargeCodOrder('DH-X')).toBe(false);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(wallet.refundedTotalOfOrder).not.toHaveBeenCalled();
      expect(wallet.chargeCodCommission).not.toHaveBeenCalled();
    });

    it.each(['payos', 'vnpay', 'bank_transfer'])('đơn %s (không phải COD) ⇒ false: sàn đã giữ tiền, hoa hồng trừ ở đối soát, không đụng ví', async (method) => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000, method }));
      expect(await listeners.chargeCodOrder('DH-1')).toBe(false);
      expect(wallet.refundedTotalOfOrder).not.toHaveBeenCalled();
      expect(wallet.chargeCodCommission).not.toHaveBeenCalled();
    });

    it('COD: gọi chargeCodCommission với đúng shop của đơn, mã đơn và trả kết quả của ví (true)', async () => {
      const { orders, wallet, listeners, charged } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000, shopId: SHOP }));

      expect(await listeners.chargeCodOrder('DH-1')).toBe(true);

      expect(orders.commissionBasisOf).toHaveBeenCalledWith('DH-1');
      expect(wallet.chargeCodCommission).toHaveBeenCalledTimes(1);
      expect(charged()).toMatchObject({ shopId: SHOP, orderCode: 'DH-1' });
    });

    it('ví báo đã ghi trước đó (false) ⇒ chargeCodOrder trả false', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000 }));
      wallet.chargeCodCommission.mockResolvedValue(false);
      expect(await listeners.chargeCodOrder('DH-1')).toBe(false);
    });

    it.each([
      ['không voucher: 1.000.000 × 10% = 100.000', { total: 1_000_000, rate: '10.00' }, '100000'],
      ['làm tròn nửa LÊN: 15 × 10% = 1.5 ⇒ 2', { total: 15, rate: '10.00' }, '2'],
      ['làm tròn nửa lên: 1000 × 12.35% = 123.5 ⇒ 124', { total: 1000, rate: '12.35' }, '124'],
      ['làm tròn xuống: 10001 × 7.50% = 750.075 ⇒ 750', { total: 10_001, rate: '7.50' }, '750'],
      ['voucher sàn: (100 + 5) × 10% = 10.5 ⇒ 11, trừ voucher 5 ⇒ 6', { total: 100, pd: 5, rate: '10.00' }, '6'],
      ['voucher sàn BẰNG hoa hồng ⇒ net 0 (sàn không nợ shop, shop không nợ sàn)', { total: 90_000, pd: 10_000, rate: '10.00' }, '0'],
      ['voucher sàn LỚN hơn hoa hồng ⇒ net ÂM (sàn hoàn phần chênh vào ví)', { total: 50_000, pd: 50_000, rate: '10.00' }, '-40000'],
      ['rate 0% ⇒ net = −voucher', { total: 100_000, pd: 20_000, rate: '0.00' }, '-20000'],
    ])('net hoa hồng COD: %s', async (_label, o, expected) => {
      const { orders, listeners, charged } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis(o));
      await listeners.chargeCodOrder('DH-1');
      expect(charged().amount.toString()).toBe(expected);
    });

    it('net = 0 vẫn gọi ví (ví tự bỏ qua khoản 0) và trả false khi ví trả false', async () => {
      const { orders, wallet, listeners, charged } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 90_000, pd: 10_000 }));
      wallet.chargeCodCommission.mockResolvedValue(false);
      expect(await listeners.chargeCodOrder('DH-1')).toBe(false);
      expect(charged().amount.isZero()).toBe(true);
    });

    it('đã hoàn tiền TRƯỚC khi hoàn tất: net × (total − đã hoàn) / total, làm tròn nửa lên', async () => {
      const { orders, wallet, listeners, charged } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000, rate: '10.00' })); // net gốc 100.000
      wallet.refundedTotalOfOrder.mockResolvedValue(D(250_000));

      await listeners.chargeCodOrder('DH-1');

      expect(wallet.refundedTotalOfOrder).toHaveBeenCalledWith('DH-1');
      expect(charged().amount.toString()).toBe('75000'); // 100.000 × 750.000 / 1.000.000
    });

    it.each([
      ['100 × 667/1000 = 66.7 ⇒ 67', { total: 1000, rate: '10.00' }, 333, '67'],
      ['5 × 50/100 = 2.5 ⇒ 3 (nửa lên)', { total: 100, rate: '5.00' }, 50, '3'],
      ['net âm cũng co theo phần còn lại: −40.000 × 25.000/50.000 = −20.000', { total: 50_000, pd: 50_000, rate: '10.00' }, 25_000, '-20000'],
      ['net 0 (voucher = hoa hồng) ⇒ vẫn 0', { total: 90_000, pd: 10_000, rate: '10.00' }, 45_000, '0'],
    ])('hoàn một phần trước khi hoàn tất: %s', async (_label, o, refunded, expected) => {
      const { orders, wallet, listeners, charged } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis(o));
      wallet.refundedTotalOfOrder.mockResolvedValue(D(refunded));
      await listeners.chargeCodOrder('DH-1');
      expect(charged().amount.toString()).toBe(expected);
    });

    it.each([
      ['hoàn HẾT (đã hoàn = total)', 1_000_000],
      ['hoàn vượt total (dữ liệu lệch)', 1_200_000],
    ])('%s ⇒ net = 0 (không còn doanh thu để tính hoa hồng)', async (_label, refunded) => {
      const { orders, wallet, listeners, charged } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000, rate: '10.00' }));
      wallet.refundedTotalOfOrder.mockResolvedValue(D(refunded));
      await listeners.chargeCodOrder('DH-1');
      expect(charged().amount.toString()).toBe('0');
    });

    it('total = 0 mà có hoàn tiền ⇒ không chia cho 0, giữ nguyên net (−voucher)', async () => {
      const { orders, wallet, listeners, charged } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 0, pd: 100, rate: '10.00' })); // hoa hồng 10 − voucher 100 = −90
      wallet.refundedTotalOfOrder.mockResolvedValue(D(5));
      await listeners.chargeCodOrder('DH-1');
      expect(charged().amount.toString()).toBe('-90');
    });

    it('lỗi từ ví được ném lên (không nuốt) để relay đánh dấu FAILED + thử lại', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000 }));
      wallet.chargeCodCommission.mockRejectedValue(new Error('ví chết'));
      await expect(listeners.chargeCodOrder('DH-1')).rejects.toThrow('ví chết');
    });
  });

  /* ============================================================ */
  describe('onOrderStatusChanged', () => {
    it('to = completed ⇒ xử lý hoa hồng COD của đơn', async () => {
      const { orders, wallet, listeners, charged } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000 }));

      await listeners.onOrderStatusChanged(msg({ orderCode: 'DH-1', from: 'delivered', to: 'completed' }));

      expect(orders.commissionBasisOf).toHaveBeenCalledWith('DH-1');
      expect(wallet.chargeCodCommission).toHaveBeenCalledTimes(1);
      expect(charged().amount.toString()).toBe('100000');
    });

    it.each(['pending', 'confirmed', 'shipping', 'delivered', 'cancelled', 'returned', 'COMPLETED', ''])('to = "%s" ⇒ BỎ QUA hoàn toàn (không đọc đơn, không đụng ví)', async (to) => {
      const { orders, wallet, listeners } = buildListeners();
      await listeners.onOrderStatusChanged(msg({ orderCode: 'DH-1', to }));
      expect(orders.commissionBasisOf).not.toHaveBeenCalled();
      expect(wallet.chargeCodCommission).not.toHaveBeenCalled();
    });

    it('completed nhưng đơn online ⇒ không ghi hoa hồng ví COD', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000, method: 'payos' }));
      await listeners.onOrderStatusChanged(msg({ orderCode: 'DH-1', to: 'completed' }));
      expect(wallet.chargeCodCommission).not.toHaveBeenCalled();
    });

    it('sự kiện lặp: ví trả false lần hai ⇒ không lỗi, không ghi thêm gì ngoài lời gọi idempotent', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000 }));
      wallet.chargeCodCommission.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await listeners.onOrderStatusChanged(msg({ orderCode: 'DH-1', to: 'completed' }));
      await expect(listeners.onOrderStatusChanged(msg({ orderCode: 'DH-1', to: 'completed' }))).resolves.toBeUndefined();
      expect(wallet.chargeCodCommission).toHaveBeenCalledTimes(2);
    });

    it('lỗi từ ví được ném lên (không nuốt)', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000 }));
      wallet.chargeCodCommission.mockRejectedValue(new Error('ví chết'));
      await expect(listeners.onOrderStatusChanged(msg({ orderCode: 'DH-1', to: 'completed' }))).rejects.toThrow('ví chết');
    });

    it('lỗi khi đọc đơn được ném lên (không nuốt)', async () => {
      const { orders, listeners } = buildListeners();
      orders.commissionBasisOf.mockRejectedValue(new Error('db chết'));
      await expect(listeners.onOrderStatusChanged(msg({ orderCode: 'DH-1', to: 'completed' }))).rejects.toThrow('db chết');
    });
  });

  /* ============================================================ */
  describe('onPaymentRefunded', () => {
    const payload = (over: Record<string, unknown> = {}) => ({ refundId: REFUND_ID, orderCode: 'DH-1', amount: '250000', methodCode: 'cod', shopId: SHOP, userId: 'u-1', ...over });
    const refundArg = (w: ReturnType<typeof buildListeners>['wallet']) => w.recordCodRefund.mock.calls[0][0];

    it.each([
      ['phương thức payos', { methodCode: 'payos' }],
      ['phương thức vnpay', { methodCode: 'vnpay' }],
      ['phương thức bank_transfer', { methodCode: 'bank_transfer' }],
      ['thiếu methodCode', { methodCode: undefined }],
      ['COD viết hoa (không khớp)', { methodCode: 'COD' }],
      ['shopId null (đơn cũ)', { shopId: null }],
      ['thiếu shopId', { shopId: undefined }],
      ['shopId rỗng', { shopId: '' }],
      ['thiếu refundId', { refundId: undefined }],
      ['thiếu orderCode', { orderCode: undefined }],
      ['thiếu amount', { amount: undefined }],
      ['amount rỗng', { amount: '' }],
    ])('BỎ QUA khi %s: không đọc đơn, không đụng ví', async (_label, over) => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000 }));
      await listeners.onPaymentRefunded(msg(payload(over)));
      expect(orders.commissionBasisOf).not.toHaveBeenCalled();
      expect(wallet.hasCodCommission).not.toHaveBeenCalled();
      expect(wallet.recordCodRefund).not.toHaveBeenCalled();
    });

    it('đơn không tồn tại ⇒ bỏ qua, không ghi nợ', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(null);
      await listeners.onPaymentRefunded(msg(payload()));
      expect(wallet.recordCodRefund).not.toHaveBeenCalled();
    });

    it('COD + hoa hồng ĐÃ được trừ ⇒ recordCodRefund(amount, commissionReversal = net × amount / total)', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000, rate: '10.00' })); // net 100.000
      wallet.hasCodCommission.mockResolvedValue(true);

      await listeners.onPaymentRefunded(msg(payload()));

      expect(wallet.hasCodCommission).toHaveBeenCalledWith(SHOP, 'DH-1');
      expect(wallet.recordCodRefund).toHaveBeenCalledTimes(1);
      const arg = refundArg(wallet);
      expect(arg).toMatchObject({ shopId: SHOP, orderCode: 'DH-1', refundKey: REFUND_KEY, amount: '250000' });
      expect(arg.commissionReversal.toString()).toBe('25000'); // 100.000 × 250.000 / 1.000.000
    });

    it('hoàn đủ đơn đã trừ hoa hồng ⇒ đảo ĐÚNG toàn bộ hoa hồng', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000, rate: '10.00' }));
      wallet.hasCodCommission.mockResolvedValue(true);
      await listeners.onPaymentRefunded(msg(payload({ amount: '1000000' })));
      expect(refundArg(wallet).commissionReversal.toString()).toBe('100000');
    });

    it('reversal truyền xuống KHÔNG làm tròn (ví tự làm tròn nửa lên): net 100 × 333 / 1001', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1001, rate: '10.00' })); // 1001 × 10% = 100.1 ⇒ net 100
      wallet.hasCodCommission.mockResolvedValue(true);
      await listeners.onPaymentRefunded(msg(payload({ amount: '333' })));
      const reversal = refundArg(wallet).commissionReversal;
      expect(reversal.toString()).toBe(D(100).mul(333).div(1001).toString());
      expect(reversal.isInteger()).toBe(false);
      expect(reversal.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toString()).toBe('33');
    });

    it('voucher sàn = hoa hồng (net 0) ⇒ reversal 0, vẫn ghi nợ số hoàn', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 90_000, pd: 10_000, rate: '10.00' }));
      wallet.hasCodCommission.mockResolvedValue(true);
      await listeners.onPaymentRefunded(msg(payload({ amount: '90000' })));
      expect(refundArg(wallet).commissionReversal.isZero()).toBe(true);
      expect(refundArg(wallet).amount).toBe('90000');
    });

    it('net ÂM (voucher sàn > hoa hồng): reversal ÂM tỉ lệ — sàn đòi lại phần đã hoàn thêm cho shop', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 50_000, pd: 50_000, rate: '10.00' })); // net −40.000
      wallet.hasCodCommission.mockResolvedValue(true);
      await listeners.onPaymentRefunded(msg(payload({ amount: '25000' })));
      expect(refundArg(wallet).commissionReversal.toString()).toBe('-20000');
    });

    it('hoa hồng CHƯA được trừ (đơn chưa hoàn tất) ⇒ reversal = 0 nhưng vẫn ghi nợ số hoàn', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000, rate: '10.00' }));
      wallet.hasCodCommission.mockResolvedValue(false);

      await listeners.onPaymentRefunded(msg(payload()));

      expect(wallet.recordCodRefund).toHaveBeenCalledTimes(1);
      expect(refundArg(wallet).commissionReversal.isZero()).toBe(true);
      expect(refundArg(wallet).amount).toBe('250000');
    });

    it('total = 0 ⇒ reversal 0 và KHÔNG hỏi hasCodCommission (tránh chia cho 0)', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 0, pd: 100 }));
      await listeners.onPaymentRefunded(msg(payload({ amount: '10' })));
      expect(wallet.hasCodCommission).not.toHaveBeenCalled();
      expect(refundArg(wallet).commissionReversal.isZero()).toBe(true);
    });

    it.each([
      [REFUND_ID, REFUND_KEY],
      ['9B2E5C1A-7D3F-4E8A-B6C4-1A2B3C4D5E6F', 'RF-9B2E5C1A7D3F4E8AB6C41A2B3C'], // giữ nguyên hoa/thường
      ['abcdef', 'RF-abcdef'], // id ngắn hơn 26 ký tự thì lấy hết
    ])('refundKey = "RF-" + 26 ký tự đầu của refundId (bỏ dấu "-"): %s ⇒ %s', async (refundId, key) => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000 }));
      await listeners.onPaymentRefunded(msg(payload({ refundId })));
      expect(refundArg(wallet).refundKey).toBe(key);
      expect(refundArg(wallet).refundKey.length).toBeLessThanOrEqual(29); // vừa VarChar(30) của cột order_code
    });

    it('shopId lấy từ payload hoàn tiền (snapshot lúc tạo refund), không lấy từ đơn', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000, shopId: 'shop-khac' }));
      await listeners.onPaymentRefunded(msg(payload({ shopId: SHOP })));
      expect(refundArg(wallet).shopId).toBe(SHOP);
      expect(wallet.hasCodCommission).toHaveBeenCalledWith(SHOP, 'DH-1');
    });

    it('lỗi từ ví được ném lên (không nuốt)', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000 }));
      wallet.recordCodRefund.mockRejectedValue(new Error('ví chết'));
      await expect(listeners.onPaymentRefunded(msg(payload()))).rejects.toThrow('ví chết');
    });

    it('lỗi khi kiểm hoa hồng được ném lên (không nuốt)', async () => {
      const { orders, wallet, listeners } = buildListeners();
      orders.commissionBasisOf.mockResolvedValue(basis({ total: 1_000_000 }));
      wallet.hasCodCommission.mockRejectedValue(new Error('db chết'));
      await expect(listeners.onPaymentRefunded(msg(payload()))).rejects.toThrow('db chết');
      expect(wallet.recordCodRefund).not.toHaveBeenCalled();
    });
  });

  /* ============================================================ */
  describe('onShopApproved', () => {
    it('shop được duyệt ⇒ ensureWallet(shopId)', async () => {
      const { wallet, listeners } = buildListeners();
      await listeners.onShopApproved(msg({ shopId: SHOP }));
      expect(wallet.ensureWallet).toHaveBeenCalledTimes(1);
      expect(wallet.ensureWallet).toHaveBeenCalledWith(SHOP);
    });

    it('lỗi từ ví được ném lên (không nuốt)', async () => {
      const { wallet, listeners } = buildListeners();
      wallet.ensureWallet.mockRejectedValue(new Error('ví chết'));
      await expect(listeners.onShopApproved(msg({ shopId: SHOP }))).rejects.toThrow('ví chết');
    });
  });

  /* ============================================================ */
  describe('metadata @OnEvent — lỗi KHÔNG bị nuốt', () => {
    type OnEventMeta = Array<{ event: string; options?: { suppressErrors?: boolean } }>;
    const metaOf = (method: string): OnEventMeta | undefined => {
      const fn = (PaymentEventListeners.prototype as unknown as Record<string, object>)[method];
      return Reflect.getMetadata('EVENT_LISTENER_METADATA', fn) as OnEventMeta | undefined;
    };

    it.each([
      ['onOrderStatusChanged', `outbox.${ORDER_MODULE}.${ORDER_EVENT.STATUS_CHANGED}`],
      ['onPaymentRefunded', `outbox.${PAYMENT_MODULE}.${PAYMENT_EVENT.REFUNDED}`],
      ['onShopApproved', `outbox.${SHOP_MODULE}.${SHOP_EVENT.APPROVED}`],
    ])('%s nghe đúng sự kiện outbox (%s) với { suppressErrors: false }', (method, event) => {
      const meta = metaOf(method);
      expect(meta).toHaveLength(1);
      expect(meta![0].event).toBe(event);
      // mặc định của @nestjs/event-emitter là nuốt + log ⇒ relay đánh DONE và sự kiện (tiền) mất vĩnh viễn
      expect(meta![0].options?.suppressErrors).toBe(false);
    });

    it('MỌI method @OnEvent của PaymentEventListeners đều có suppressErrors: false (thêm listener mới mà quên là đỏ)', () => {
      const methods = Object.getOwnPropertyNames(PaymentEventListeners.prototype).filter((n) => n !== 'constructor' && metaOf(n));
      expect(methods.sort()).toEqual(['onOrderStatusChanged', 'onPaymentRefunded', 'onShopApproved']);
      for (const m of methods) for (const entry of metaOf(m)!) expect(entry.options?.suppressErrors).toBe(false);
    });
  });
});

/* ====================================================================================================== */

describe('PaymentJobs.reconcileCodCommission — đối soát bù hoa hồng COD', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function buildJobs() {
    const orders = { completedCodOrderCodesSince: jest.fn((_days: number, _limit: number, _after: CodScanCursor | null) => Promise.resolve<CodPage>({ codes: [], next: null })) };
    const wallet = { chargedOrderCodes: jest.fn((_codes: string[]) => Promise.resolve(new Set<string>())) };
    const listeners = { chargeCodOrder: jest.fn((_code: string) => Promise.resolve(true)) };
    const payments = { recoverStuckRefunds: jest.fn(() => Promise.resolve({ finalized: 0, released: 0, flagged: 0 })) };
    const jobs = new PaymentJobs(orders as unknown as OrderQueryApi, wallet as unknown as ShopWalletService, listeners as unknown as PaymentEventListeners, payments as unknown as PaymentService);
    /* Mô phỏng nguồn đơn có con trỏ: `pages` là các lô lần lượt trả về; lô cuối (không còn `next`) báo hết. */
    const feed = (pages: string[][]) => {
      orders.completedCodOrderCodesSince.mockImplementation((_d, _l, after) => {
        const i = after ? Number(after.code.split('#')[1]) + 1 : 0;
        const codes = pages[i] ?? [];
        return Promise.resolve({ codes, next: i + 1 < pages.length ? { completedAt: new Date(2026, 0, 1), code: `cursor#${i}` } : null });
      });
    };
    return { orders, wallet, listeners, payments, jobs, feed };
  }
  const codesOf = (l: ReturnType<typeof buildJobs>['listeners']) => l.chargeCodOrder.mock.calls.map((c) => c[0]);

  it('quét đơn COD hoàn tất 45 ngày gần nhất (lô 1000, con trỏ đầu = null), bỏ mã đã có trong sổ cái, chỉ ghi nốt phần thiếu theo thứ tự quét', async () => {
    const { orders, wallet, listeners, jobs } = buildJobs();
    orders.completedCodOrderCodesSince.mockResolvedValue({ codes: ['DH-1', 'DH-2', 'DH-3', 'DH-4'], next: null });
    wallet.chargedOrderCodes.mockResolvedValue(new Set(['DH-1', 'DH-3']));

    await jobs.reconcileCodCommission();

    expect(orders.completedCodOrderCodesSince).toHaveBeenCalledTimes(1);
    expect(orders.completedCodOrderCodesSince).toHaveBeenCalledWith(45, 1000, null);
    expect(wallet.chargedOrderCodes).toHaveBeenCalledWith(['DH-1', 'DH-2', 'DH-3', 'DH-4']);
    expect(codesOf(listeners)).toEqual(['DH-2', 'DH-4']);
  });

  it('mọi đơn đã có hoa hồng ⇒ không ghi gì, không cảnh báo', async () => {
    const { orders, wallet, listeners, jobs } = buildJobs();
    orders.completedCodOrderCodesSince.mockResolvedValue({ codes: ['DH-1', 'DH-2'], next: null });
    wallet.chargedOrderCodes.mockResolvedValue(new Set(['DH-1', 'DH-2']));
    await jobs.reconcileCodCommission();
    expect(listeners.chargeCodOrder).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('không có đơn nào trong 45 ngày ⇒ không làm gì, không lỗi', async () => {
    const { listeners, jobs } = buildJobs();
    await jobs.reconcileCodCommission();
    expect(listeners.chargeCodOrder).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('có ghi bù ⇒ cảnh báo số đơn đã bù (chỉ đếm đơn chargeCodOrder trả true)', async () => {
    const { orders, listeners, jobs } = buildJobs();
    orders.completedCodOrderCodesSince.mockResolvedValue({ codes: ['DH-1', 'DH-2', 'DH-3'], next: null });
    listeners.chargeCodOrder.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await jobs.reconcileCodCommission();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith({ fixed: 2 }, 'Đã ghi bù hoa hồng COD bị sót');
  });

  it('thiếu nhưng chargeCodOrder đều trả false (đơn online/khoản 0) ⇒ không cảnh báo', async () => {
    const { orders, listeners, jobs } = buildJobs();
    orders.completedCodOrderCodesSince.mockResolvedValue({ codes: ['DH-1'], next: null });
    listeners.chargeCodOrder.mockResolvedValue(false);
    await jobs.reconcileCodCommission();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('KHÔNG chạy chồng: lượt thứ hai bị bỏ qua khi lượt đầu còn chạy; xong lượt đầu thì chạy lại được', async () => {
    const { orders, jobs } = buildJobs();
    let release: (page: CodPage) => void = () => undefined;
    orders.completedCodOrderCodesSince.mockImplementationOnce(
      () =>
        new Promise<CodPage>((resolve) => {
          release = resolve;
        }),
    );

    const first = jobs.reconcileCodCommission();
    await jobs.reconcileCodCommission(); // lượt chồng: trả về ngay
    await jobs.reconcileCodCommission();
    expect(orders.completedCodOrderCodesSince).toHaveBeenCalledTimes(1);

    release({ codes: ['DH-1'], next: null });
    await first;

    await jobs.reconcileCodCommission();
    expect(orders.completedCodOrderCodesSince).toHaveBeenCalledTimes(2);
  });

  it('lỗi (đọc đơn) bị NUỐT + log, KHÔNG ném; cờ chạy được nhả nên lượt sau vẫn chạy', async () => {
    const { orders, jobs } = buildJobs();
    orders.completedCodOrderCodesSince.mockRejectedValueOnce(new Error('db chết'));

    await expect(jobs.reconcileCodCommission()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0] as unknown[])[1]).toBe('Job đối soát bù hoa hồng COD lỗi');
    await jobs.reconcileCodCommission();
    expect(orders.completedCodOrderCodesSince).toHaveBeenCalledTimes(2);
  });

  it('lỗi ở chargedOrderCodes hoặc chargeCodOrder cũng bị nuốt + log, không ném', async () => {
    const a = buildJobs();
    a.orders.completedCodOrderCodesSince.mockResolvedValue({ codes: ['DH-1'], next: null });
    a.wallet.chargedOrderCodes.mockRejectedValueOnce(new Error('ví chết'));
    await expect(a.jobs.reconcileCodCommission()).resolves.toBeUndefined();

    const b = buildJobs();
    b.orders.completedCodOrderCodesSince.mockResolvedValue({ codes: ['DH-1'], next: null });
    b.listeners.chargeCodOrder.mockRejectedValueOnce(new Error('listener chết'));
    await expect(b.jobs.reconcileCodCommission()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  /* Đơn được xét theo thứ tự mới → cũ: một đơn luôn ném lỗi (dữ liệu lệch, ràng buộc DB…) không được làm đứt lượt — log đơn lỗi rồi đi tiếp. */
  it('một đơn lỗi không được chặn các đơn còn lại trong cùng lượt quét', async () => {
    const { orders, listeners, jobs } = buildJobs();
    orders.completedCodOrderCodesSince.mockResolvedValue({ codes: ['DH-LOI', 'DH-2', 'DH-3'], next: null });
    listeners.chargeCodOrder.mockImplementation((code: string) => (code === 'DH-LOI' ? Promise.reject(new Error('đơn lỗi')) : Promise.resolve(true)));

    await jobs.reconcileCodCommission();

    expect(codesOf(listeners)).toEqual(['DH-LOI', 'DH-2', 'DH-3']);
  });

  it('chạy mỗi 10 phút (@Interval 600000 ms)', () => {
    const fn = (PaymentJobs.prototype as unknown as Record<string, object>).reconcileCodCommission;
    expect(Reflect.getMetadata('SCHEDULE_INTERVAL_OPTIONS', fn)).toEqual({ timeout: 10 * 60_000 });
  });

  /* ------------------------------------------------ phân trang theo con trỏ: quét HẾT cửa sổ 45 ngày */
  describe('quét nhiều lô theo con trỏ (không bỏ sót đơn cũ khi lô đầu toàn đơn đã đủ hoa hồng)', () => {
    it('lô 1 toàn đơn ĐÃ có hoa hồng, đơn thiếu nằm ở lô 3 ⇒ vẫn được ghi bù (lỗi cũ: chỉ quét 1000 đơn mới nhất rồi dừng)', async () => {
      const { orders, wallet, listeners, jobs, feed } = buildJobs();
      feed([['DH-9', 'DH-8'], ['DH-7', 'DH-6'], ['DH-5', 'DH-4']]);
      wallet.chargedOrderCodes.mockImplementation((codes: string[]) => Promise.resolve(new Set(codes.filter((c) => c !== 'DH-4'))));

      await jobs.reconcileCodCommission();

      expect(orders.completedCodOrderCodesSince).toHaveBeenCalledTimes(3);
      expect(codesOf(listeners)).toEqual(['DH-4']);
    });

    it('con trỏ của lô trước được truyền cho lô sau (lô đầu null); mọi lần gọi dùng cửa sổ 45 ngày + lô 1000', async () => {
      const { orders, jobs, feed } = buildJobs();
      feed([['A'], ['B'], ['C']]);

      await jobs.reconcileCodCommission();

      const calls = orders.completedCodOrderCodesSince.mock.calls;
      expect(calls.map((c) => [c[0], c[1]])).toEqual([[45, 1000], [45, 1000], [45, 1000]]);
      expect(calls.map((c) => c[2]?.code ?? null)).toEqual([null, 'cursor#0', 'cursor#1']);
    });

    it('chargedOrderCodes được hỏi TỪNG lô (một truy vấn / lô), không gom cả cửa sổ vào một mảng', async () => {
      const { wallet, jobs, feed } = buildJobs();
      feed([['A', 'B'], ['C']]);
      await jobs.reconcileCodCommission();
      expect(wallet.chargedOrderCodes.mock.calls.map((c) => c[0])).toEqual([['A', 'B'], ['C']]);
    });

    it('ghi bù ở nhiều lô ⇒ cảnh báo tổng số đơn đã bù MỘT lần', async () => {
      const { jobs, feed } = buildJobs();
      feed([['A', 'B'], ['C']]);
      await jobs.reconcileCodCommission();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith({ fixed: 3 }, 'Đã ghi bù hoa hồng COD bị sót');
    });

    it('đơn lỗi ở lô 1 KHÔNG chặn các đơn của lô 2, lô 3 (per-order try/catch)', async () => {
      const { listeners, jobs, feed } = buildJobs();
      feed([['LOI', 'A'], ['B'], ['C']]);
      listeners.chargeCodOrder.mockImplementation((code: string) => (code === 'LOI' ? Promise.reject(new Error('đơn lỗi')) : Promise.resolve(true)));

      await jobs.reconcileCodCommission();

      expect(codesOf(listeners)).toEqual(['LOI', 'A', 'B', 'C']);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('lô rỗng giữa chừng (con trỏ còn nhưng không có mã) vẫn đi tiếp', async () => {
      const { orders, listeners, jobs } = buildJobs();
      orders.completedCodOrderCodesSince
        .mockResolvedValueOnce({ codes: [], next: { completedAt: new Date(), code: 'x' } })
        .mockResolvedValueOnce({ codes: ['A'], next: null });
      await jobs.reconcileCodCommission();
      expect(orders.completedCodOrderCodesSince).toHaveBeenCalledTimes(2);
      expect(codesOf(listeners)).toEqual(['A']);
    });

    it('TRẦN 20 lô/lượt: nguồn không bao giờ hết ⇒ dừng đúng ở lô 20 và cảnh báo còn đơn cũ chưa quét (không lặp vô hạn)', async () => {
      const { orders, jobs } = buildJobs();
      let n = 0;
      orders.completedCodOrderCodesSince.mockImplementation(() => {
        n += 1;
        return Promise.resolve({ codes: [`DH-${n}`], next: { completedAt: new Date(), code: `c${n}` } });
      });

      await jobs.reconcileCodCommission();

      expect(orders.completedCodOrderCodesSince).toHaveBeenCalledTimes(20);
      expect(warnSpy).toHaveBeenCalledWith({ scanned: 20, batches: 20 }, 'Job bù hoa hồng COD chạm trần số lô — các đơn cũ nhất trong cửa sổ chưa được quét');
    });

    it('hết dữ liệu TRƯỚC trần ⇒ không cảnh báo chạm trần', async () => {
      const { jobs, feed } = buildJobs();
      feed([['A'], ['B']]);
      await jobs.reconcileCodCommission();
      expect(warnSpy.mock.calls.some((c) => String((c as unknown[])[1]).includes('chạm trần'))).toBe(false);
    });

    it('lỗi khi đọc LÔ SAU (db chết) ⇒ nuốt + log, không ném; các đơn của lô trước vẫn đã được xử lý', async () => {
      const { orders, listeners, jobs } = buildJobs();
      orders.completedCodOrderCodesSince.mockResolvedValueOnce({ codes: ['A'], next: { completedAt: new Date(), code: 'x' } }).mockRejectedValueOnce(new Error('db chết'));

      await expect(jobs.reconcileCodCommission()).resolves.toBeUndefined();

      expect(codesOf(listeners)).toEqual(['A']);
      expect((errorSpy.mock.calls[0] as unknown[])[1]).toBe('Job đối soát bù hoa hồng COD lỗi');
    });

    it('KHÔNG chạy chồng ngay cả khi đang quét lô giữa chừng', async () => {
      const { orders, jobs } = buildJobs();
      let release: (page: CodPage) => void = () => undefined;
      orders.completedCodOrderCodesSince
        .mockResolvedValueOnce({ codes: ['A'], next: { completedAt: new Date(), code: 'x' } })
        .mockImplementationOnce(
          () =>
            new Promise<CodPage>((resolve) => {
              release = resolve;
            }),
        );

      const first = jobs.reconcileCodCommission();
      await new Promise((r) => setImmediate(r)); // lô 1 xong, đang chờ lô 2
      await jobs.reconcileCodCommission();
      expect(orders.completedCodOrderCodesSince).toHaveBeenCalledTimes(2);

      release({ codes: [], next: null });
      await first;
    });
  });
});

/* ====================================================================================================== */

describe('PaymentJobs.recoverStuckRefunds — job phục hồi refund treo', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  type Recovered = { finalized: number; released: number; flagged: number };
  const build = () => {
    const payments = { recoverStuckRefunds: jest.fn((): Promise<Recovered> => Promise.resolve({ finalized: 0, released: 0, flagged: 0 })) };
    const jobs = new PaymentJobs({} as unknown as OrderQueryApi, {} as unknown as ShopWalletService, {} as unknown as PaymentEventListeners, payments as unknown as PaymentService);
    return { payments, jobs };
  };

  it('gọi PaymentService.recoverStuckRefunds; không có gì để phục hồi ⇒ im lặng', async () => {
    const { payments, jobs } = build();
    await jobs.recoverStuckRefunds();
    expect(payments.recoverStuckRefunds).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('có refund được phục hồi ⇒ cảnh báo kèm số liệu', async () => {
    const { payments, jobs } = build();
    payments.recoverStuckRefunds.mockResolvedValue({ finalized: 2, released: 1, flagged: 1 });
    await jobs.recoverStuckRefunds();
    expect(warnSpy).toHaveBeenCalledWith({ finalized: 2, released: 1, flagged: 1 }, 'Đã phục hồi refund treo');
  });

  it('lỗi bị nuốt + log, cờ chạy được nhả nên lượt sau vẫn chạy; không chạy chồng', async () => {
    const { payments, jobs } = build();
    payments.recoverStuckRefunds.mockRejectedValueOnce(new Error('db chết'));
    await expect(jobs.recoverStuckRefunds()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    let release: () => void = () => undefined;
    payments.recoverStuckRefunds.mockImplementationOnce(
      () =>
        new Promise<Recovered>((resolve) => {
          release = () => resolve({ finalized: 0, released: 0, flagged: 0 });
        }),
    );
    const first = jobs.recoverStuckRefunds();
    await jobs.recoverStuckRefunds(); // chồng ⇒ bỏ qua
    expect(payments.recoverStuckRefunds).toHaveBeenCalledTimes(2);
    release();
    await first;
    await jobs.recoverStuckRefunds();
    expect(payments.recoverStuckRefunds).toHaveBeenCalledTimes(3);
  });

  it('chạy mỗi 5 phút (@Interval 300000 ms) — ngắn hơn ngưỡng treo 10 phút để refund treo được xử lý sớm', () => {
    const fn = (PaymentJobs.prototype as unknown as Record<string, object>).recoverStuckRefunds;
    expect(Reflect.getMetadata('SCHEDULE_INTERVAL_OPTIONS', fn)).toEqual({ timeout: 5 * 60_000 });
  });
});

/* ====================================================================================================== */

describe('OrderQueryApi.completedCodOrderCodesSince — nguồn đơn cho job bù (phân trang theo con trỏ)', () => {
  afterEach(() => jest.restoreAllMocks());

  const NOW = Date.UTC(2025, 5, 30);
  const build = () => {
    const prisma = { order: { findMany: jest.fn() } };
    const api = new OrderQueryApi(prisma as unknown as PrismaService, {} as unknown as ConstructorParameters<typeof OrderQueryApi>[1]);
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    return { prisma, api };
  };
  const row = (code: string, ms: number) => ({ code, completedAt: new Date(ms) });
  const BASE_WHERE = () => ({ isDeleted: false, status: 'completed', paymentMethodCode: 'cod', completedAt: { gte: new Date(NOW - 45 * 86_400_000) } });

  it('lô đầu (không con trỏ): đơn COD đã hoàn tất, chưa xoá, trong N ngày gần nhất, MỚI nhất trước (phá thế bằng mã đơn), tối đa `limit`; trả mã đơn', async () => {
    const { prisma, api } = build();
    prisma.order.findMany.mockResolvedValue([row('DH-2', NOW - 1000), row('DH-1', NOW - 2000)]);

    const page = await api.completedCodOrderCodesSince(45, 1000);

    expect(page.codes).toEqual(['DH-2', 'DH-1']);
    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: BASE_WHERE(),
      orderBy: [{ completedAt: 'desc' }, { code: 'desc' }],
      select: { code: true, completedAt: true },
      take: 1000,
    });
  });

  it('lô không đầy (< limit) ⇒ next = null (đã hết); lô rỗng ⇒ codes rỗng, next null', async () => {
    const { prisma, api } = build();
    prisma.order.findMany.mockResolvedValueOnce([row('DH-1', NOW - 1000)]).mockResolvedValueOnce([]);
    expect(await api.completedCodOrderCodesSince(45, 3)).toEqual({ codes: ['DH-1'], next: null });
    expect(await api.completedCodOrderCodesSince(45, 3)).toEqual({ codes: [], next: null });
  });

  it('lô ĐẦY (= limit) ⇒ next = (completedAt, mã) của dòng CUỐI lô', async () => {
    const { prisma, api } = build();
    prisma.order.findMany.mockResolvedValue([row('DH-3', NOW - 1000), row('DH-2', NOW - 2000), row('DH-1', NOW - 3000)]);

    const page = await api.completedCodOrderCodesSince(45, 3);

    expect(page.next).toEqual({ completedAt: new Date(NOW - 3000), code: 'DH-1' });
  });

  it('có con trỏ ⇒ chỉ lấy dòng "sau" con trỏ: completedAt nhỏ hơn, hoặc cùng completedAt mà mã nhỏ hơn (không bỏ sót / lặp khi nhiều đơn cùng mili-giây)', async () => {
    const { prisma, api } = build();
    prisma.order.findMany.mockResolvedValue([]);
    const cursor = { completedAt: new Date(NOW - 5000), code: 'DH-7' };

    await api.completedCodOrderCodesSince(45, 1000, cursor);

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: { ...BASE_WHERE(), OR: [{ completedAt: { lt: cursor.completedAt } }, { completedAt: cursor.completedAt, code: { lt: 'DH-7' } }] },
      orderBy: [{ completedAt: 'desc' }, { code: 'desc' }],
      select: { code: true, completedAt: true },
      take: 1000,
    });
  });

  it('con trỏ null / bỏ trống ⇒ KHÔNG có điều kiện OR (lô đầu)', async () => {
    const { prisma, api } = build();
    prisma.order.findMany.mockResolvedValue([]);
    await api.completedCodOrderCodesSince(45, 10, null);
    await api.completedCodOrderCodesSince(45, 10);
    for (const call of prisma.order.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>) expect(call[0].where).not.toHaveProperty('OR');
  });

  it('cửa sổ ngày theo tham số (7 ngày ⇒ since = now − 7 ngày)', async () => {
    const { prisma, api } = build();
    prisma.order.findMany.mockResolvedValue([]);
    await api.completedCodOrderCodesSince(7, 10);
    expect((prisma.order.findMany.mock.calls[0] as Array<{ where: { completedAt: { gte: Date } } }>)[0].where.completedAt.gte).toEqual(new Date(NOW - 7 * 86_400_000));
  });
});
