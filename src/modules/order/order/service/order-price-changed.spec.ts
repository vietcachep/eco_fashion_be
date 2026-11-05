import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BusinessException } from '@common/exception/business.exception';
import { GlobalExceptionFilter } from '@common/exception/global-exception.filter';
import type { InventoryGateway } from '@common/gateway/inventory.gateway';
import type { PaymentGateway } from '@common/gateway/payment.gateway';
import type { BasketForPromotion, PromotionGateway, PromotionQuote } from '@common/gateway/promotion.gateway';
import { IdempotencyService, type IdempotencyRow } from '@common/idempotency/idempotency.service';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { Prisma, Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { Basket, CartQueryApi } from '../../../cart/queryapi/cart.queryapi';
import type { ShopBrief, ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import type { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { ORDER_ERR } from '../../foundation/order.constants';
import type { CheckoutSummaryResponse, OrderGroupResponse } from '../dto/order.responses';
import { CreateOrderRequest } from '../request/order.requests';
import type { OrderRepository, OrderRow } from '../repository/order.repository';
import { OrderService, type PlaceOrderInput } from './order.service';

/*
 * [CK-05] (PLAN-0032 §2.1) — `expectedTotal`: khách chỉ được tính đúng số đã thấy. OrderService chạy THẬT; mọi phụ thuộc là mock có kiểu.
 * "Thế giới" (giỏ, phí ship, trạng thái voucher) là biến đổi được giữa hai lần gọi để mô phỏng việc giá đổi GIỮA lúc xem bảng tiền và lúc bấm đặt.
 * `$transaction` giả có ROLLBACK thật cho bảng idempotency (sao lưu rồi khôi phục khi fn ném lỗi) để kiểm Idempotency-Key không bị tiêu bởi 409.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'user-1';
const actor: AuthenticatedActor = { userId: USER, email: 'khach@fitly.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-1' };
const ADDRESS = { recipientName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '79', provinceName: 'TP. Hồ Chí Minh', districtName: 'Q.1', wardName: null, street: '12 Nguyễn Huệ' };
const VOUCHER = 'GIAM50K';

function bline(shopId: string, variantId: string, unitPrice: bigint, quantity = 1): Basket['lines'][number] {
  return { variantId, productId: `prod-${variantId}`, slug: variantId, name: `SP ${variantId}`, categorySlug: 'ao', imageUrl: null, color: 'Đen', size: 'M', sku: `SKU-${variantId}`, quantity, unitPrice, lineTotal: unitPrice * BigInt(quantity), available: 100, isSellable: true, shopId };
}

/* Trạng thái voucher tại từng thời điểm: ok · hết lượt ngay từ lúc báo giá · báo giá còn ok nhưng hết lượt đúng lúc chốt (đơn khác chốt trước) · báo giá ok, chốt lệch số. */
type VoucherState = 'ok' | 'exhausted' | 'exhausted-at-consume' | 'discount-differs-at-consume';

interface World {
  lines: Basket['lines'];
  shipFee: bigint;
  voucher: VoucherState;
}

/* Mặc định: shop A 400.000 · shop B 2 × 250.000 = 500.000 · ship 30.000/gói ⇒ A 430.000 + B 530.000 = 960.000. */
const freshWorld = (): World => ({ lines: [bline(A, 'a1', 400_000n), bline(B, 'b1', 250_000n, 2)], shipFee: 30_000n, voucher: 'ok' });

const SHOP_NAMES: Record<string, string> = { [A]: 'Shop A', [B]: 'Shop B' };
const brief = (id: string): ShopBrief => ({ id, code: `S-${id.slice(0, 1)}`, slug: `shop-${id.slice(0, 1)}`, name: SHOP_NAMES[id], logoUrl: null, ratingAvg: null, status: 'approved', commissionRate: '5.00' });

function buildFixture(world: World = freshWorld()) {
  const cart = {
    basketOf: jest.fn((_userId: string, _onlySelected: boolean): Promise<Basket> => {
      const subtotal = world.lines.reduce((s, l) => s + l.lineTotal, 0n);
      return Promise.resolve({ userId: USER, lines: world.lines, subtotal, itemCount: world.lines.reduce((n, l) => n + l.quantity, 0) });
    }),
  };
  const system = {
    shippingFeeFor: jest.fn((_subtotal: bigint, _hint: string | null | undefined) => Promise.resolve({ fee: world.shipFee, province: { code: '79', name: 'TP. Hồ Chí Minh' } })),
    settingNumber: jest.fn((_key: string): Promise<number> => Promise.resolve(0)),
  };
  const shops = {
    findBrief: jest.fn((id: string): Promise<ShopBrief | null> => Promise.resolve(SHOP_NAMES[id] ? brief(id) : null)),
    activeMemberUserIds: jest.fn((_shopId: string): Promise<string[]> => Promise.resolve([])),
  };

  /* Mã sàn cố định 50.000đ. Chỉ `VOUCHER` tồn tại; trạng thái do `world.voucher` quyết định. */
  const quoteOf = (code: string): PromotionQuote => {
    const key = code.trim().toUpperCase();
    const base = { code: key, name: `Mã ${key}`, type: 'fixed_amount', scope: 'platform' as const, shopId: null };
    if (key !== VOUCHER) return { ...base, name: null, type: 'unknown', ok: false, discount: 0n, error: 'Mã không tồn tại hoặc đã hết hạn', missingAmount: null };
    if (world.voucher === 'exhausted') return { ...base, ok: false, discount: 0n, error: 'Mã đã hết lượt sử dụng', missingAmount: null };
    return { ...base, ok: true, discount: 50_000n, error: null, missingAmount: null };
  };
  const scopeOf = jest.fn((code: string) => Promise.resolve(code.trim().toUpperCase() === VOUCHER ? { scope: 'platform' as const, shopId: null } : null));
  const quote = jest.fn((code: string, _basket: BasketForPromotion): Promise<PromotionQuote> => Promise.resolve(quoteOf(code)));
  const consume = jest.fn((code: string, _basket: BasketForPromotion, _orderRef: string, _tx: Tx): Promise<PromotionQuote> => {
    const q = quoteOf(code);
    if (world.voucher === 'exhausted-at-consume') return Promise.resolve({ ...q, ok: false, discount: 0n, error: 'Mã đã hết lượt sử dụng' });
    if (world.voucher === 'discount-differs-at-consume') return Promise.resolve({ ...q, discount: 40_000n });
    return Promise.resolve(q);
  });
  const promotion: PromotionGateway = { scopeOf, quote, consume, release: jest.fn((_orderCode: string, _tx: Tx): Promise<void> => Promise.resolve()) };

  let groupSeq = 0;
  let childSeq = 0;
  const nextGroupCode = jest.fn((_tx: Tx): Promise<string> => Promise.resolve(`DHN26100${(groupSeq += 1)}`));
  const nextCode = jest.fn((_tx: Tx): Promise<string> => Promise.resolve(`DH26100${(childSeq += 1)}`));
  const createGroup = jest.fn((data: Prisma.OrderGroupUncheckedCreateInput, _tx: Tx): Promise<{ id: string; code: string }> => Promise.resolve({ id: `grp-${data.code}`, code: data.code }));
  const create = jest.fn((data: Prisma.OrderUncheckedCreateInput, _tx: Tx): Promise<OrderRow> => Promise.resolve({ id: `ord-${data.code}`, code: data.code } as unknown as OrderRow));
  const addHistory = jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
  const repo = { nextGroupCode, nextCode, createGroup, create, addHistory };

  const reserve = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const inventory = { reserve, release: jest.fn(), restock: jest.fn(), commit: jest.fn(), availableOf: jest.fn() } as unknown as InventoryGateway;
  const initiate = jest.fn((_input: { orderCode: string; amount: bigint }, _tx: Tx): Promise<unknown> => Promise.resolve({}));
  const createCheckoutLinks = jest.fn((_codes: string[]): Promise<Map<string, unknown>> => Promise.resolve(new Map()));
  const payment = { isMethodActive: jest.fn((_m: string): Promise<boolean> => Promise.resolve(true)), initiate, createCheckoutLinks, codAvailability: jest.fn((ids: string[]) => Promise.resolve(new Map(ids.map((i) => [i, true])))) } as unknown as PaymentGateway;

  const audit = { write: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) };
  const outbox = { publish: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) };
  const notify = { notify: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()), notifyMany: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) };
  const cartWrite = { removeLines: jest.fn((_userId: string, _variantIds: string[], _tx: Tx): Promise<void> => Promise.resolve()) };
  const users = { staffUserIdsWithPermission: jest.fn((_perm: string): Promise<string[]> => Promise.resolve([])) };

  /* Bảng idempotency giả: Map + ROLLBACK khi transaction ném lỗi (như Postgres) — đây là cách kiểm "409 không tiêu Idempotency-Key". */
  const idemRows = new Map<string, IdempotencyRow>();
  const idemKey = (where: { scope: string; actorKey: string; idempotencyKey: string }) => `${where.scope}|${where.actorKey}|${where.idempotencyKey}`;
  const idemFind = jest.fn((args: { where: { scope_actorKey_idempotencyKey: { scope: string; actorKey: string; idempotencyKey: string } } }): Promise<IdempotencyRow | null> => Promise.resolve(idemRows.get(idemKey(args.where.scope_actorKey_idempotencyKey)) ?? null));
  const idemCreate = jest.fn((args: { data: { scope: string; actorKey: string; idempotencyKey: string; requestHash: string; status: string; expiresAt: Date } }): Promise<IdempotencyRow> => {
    const row: IdempotencyRow = { id: `idem-${idemRows.size + 1}`, ...args.data, responseStatus: null, responseBody: null, resultRef: null };
    idemRows.set(idemKey(args.data), row);
    return Promise.resolve(row);
  });
  const idemUpdate = jest.fn((args: { where: { id: string }; data: { status: string; responseStatus: number; responseBody: unknown; resultRef: string | null } }): Promise<unknown> => {
    for (const row of idemRows.values()) if (row.id === args.where.id) Object.assign(row, args.data);
    return Promise.resolve({});
  });
  const TX = { orderIdempotencyKey: { findUnique: idemFind, create: idemCreate, update: idemUpdate } } as unknown as Tx;
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: Tx) => Promise<unknown>, _opts?: unknown): Promise<unknown> => {
      const snapshot = new Map([...idemRows].map(([k, v]) => [k, { ...v }]));
      try {
        return await fn(TX);
      } catch (err) {
        idemRows.clear();
        snapshot.forEach((v, k) => idemRows.set(k, v));
        throw err;
      }
    }),
  };

  const service = new OrderService(prisma as unknown as PrismaService, repo as unknown as OrderRepository, audit as never, outbox as never, cart as unknown as CartQueryApi, {} as never, system as unknown as SystemQueryApi, {} as never, shops as unknown as ShopQueryApi, inventory, promotion, payment, cartWrite as never, notify, {} as never, users as never);
  const myOrderGroup = jest.spyOn(service, 'myOrderGroup').mockResolvedValue({ code: 'DHN261001' } as unknown as OrderGroupResponse);

  return { service, world, consume, quote, nextGroupCode, nextCode, createGroup, create, reserve, initiate, createCheckoutLinks, cartWrite, audit, outbox, idemRows, idemUpdate, myOrderGroup, cart, system };
}

type Fixture = ReturnType<typeof buildFixture>;

/* Bảng tiền khách "đang thấy" — đúng đường GET /checkout/summary. */
const summaryOf = (f: Fixture, voucherCodes: string[] = []) => f.service.checkoutSummary(actor, { voucherCodes, province: 'Hồ Chí Minh' });
const place = (f: Fixture, over: Partial<PlaceOrderInput> = {}, key: string | null = null) => f.service.placeOrder(actor, { address: ADDRESS, paymentMethodCode: 'cod', ...over }, key);
const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

/* Không một thao tác GHI nào được xảy ra (đơn, nhóm, giữ kho, thanh toán, xoá giỏ, voucher, mã đơn, link PayOS, audit/outbox). */
function expectNothingWritten(f: Fixture): void {
  expect(f.consume).not.toHaveBeenCalled();
  expect(f.nextGroupCode).not.toHaveBeenCalled();
  expect(f.nextCode).not.toHaveBeenCalled();
  expect(f.createGroup).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.initiate).not.toHaveBeenCalled();
  expect(f.cartWrite.removeLines).not.toHaveBeenCalled();
  expect(f.createCheckoutLinks).not.toHaveBeenCalled();
  expect(f.audit.write).not.toHaveBeenCalled();
  expect(f.outbox.publish).not.toHaveBeenCalled();
}

/* Cùng kiểm cho nhánh "voucher hụt lúc chốt": consume ĐÃ chạy (rollback trong DB thật) nhưng không đơn/kho/thanh toán nào được ghi. */
function expectNoOrderRows(f: Fixture): void {
  expect(f.createGroup).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.initiate).not.toHaveBeenCalled();
  expect(f.cartWrite.removeLines).not.toHaveBeenCalled();
  expect(f.createCheckoutLinks).not.toHaveBeenCalled();
}

function expectPriceChanged(err: unknown): BusinessException {
  expect(err).toBeInstanceOf(BusinessException);
  const e = err as BusinessException;
  expect(e.errorCode).toBe(ORDER_ERR.PRICE_CHANGED);
  expect(e.errorCode).toBe('ORDER_PRICE_CHANGED');
  expect(e.httpStatus).toBe(409);
  return e;
}

const dataOf = (e: BusinessException) => e.data as CheckoutSummaryResponse;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('[CK-05] POST /orders — expectedTotal (giá đổi giữa lúc xem và lúc đặt)', () => {
  describe('tổng khớp ⇒ tạo đơn bình thường', () => {
    it('[CK-05] expectedTotal = total của bảng tiền vừa xem (2 shop) ⇒ tạo nhóm + 2 đơn con, giữ kho, khởi tạo thanh toán, xoá giỏ', async () => {
      const f = buildFixture();
      const seen = await summaryOf(f);
      expect(seen.total.amount).toBe('960000');
      const out = await place(f, { expectedTotal: seen.total.amount });
      expect(out).toMatchObject({ code: 'DHN261001' });
      expect(f.createGroup).toHaveBeenCalledTimes(1);
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.reserve).toHaveBeenCalledTimes(2);
      expect(f.initiate.mock.calls.map((c) => c[0].amount)).toEqual([430_000n, 530_000n]);
      expect(f.cartWrite.removeLines).toHaveBeenCalledTimes(1);
    });

    it('[CK-05] khớp SAU GIẢM GIÁ: expectedTotal lấy từ bảng tiền có voucher (960.000 − 50.000 = 910.000) ⇒ đặt được và voucher được chốt', async () => {
      const f = buildFixture();
      const seen = await summaryOf(f, [VOUCHER]);
      expect(seen.total.amount).toBe('910000');
      await place(f, { voucherCodes: [VOUCHER], expectedTotal: seen.total.amount });
      expect(f.consume).toHaveBeenCalledTimes(1);
      expect(f.createGroup.mock.calls[0][0]).toMatchObject({ total: '910000', discount: '50000' });
    });

    it('[CK-05] nhận số tiền dạng "910000.00" và khoảng trắng thừa (cùng giá trị) — so bằng bigint, không float', async () => {
      const f = buildFixture();
      await place(f, { expectedTotal: ' 960000.00 ' });
      expect(f.createGroup).toHaveBeenCalledTimes(1);
    });

    it('[CK-05] PayOS cũng được kiểm giá như COD (cùng một đường code) — 409 thì không tạo link PayOS', async () => {
      const f = buildFixture();
      f.world.shipFee = 40_000n;
      const err = await caught(place(f, { paymentMethodCode: 'payos', expectedTotal: '960000' }));
      expectPriceChanged(err);
      expectNothingWritten(f);
    });
  });

  describe('không gửi expectedTotal ⇒ hành vi cũ (client cũ không vỡ)', () => {
    it.each([[undefined], [null], ['']])('[CK-05] expectedTotal = %p ⇒ không kiểm giá, vẫn tạo đơn dù giá đã đổi', async (value) => {
      const f = buildFixture();
      f.world.shipFee = 45_000n; // giá đổi, nhưng client không nói mình đã thấy giá nào
      await place(f, { expectedTotal: value });
      expect(f.createGroup).toHaveBeenCalledTimes(1);
      expect(f.createGroup.mock.calls[0][0]).toMatchObject({ total: '990000' });
    });
  });

  describe('lệch ⇒ 409 ORDER_PRICE_CHANGED + báo giá mới, KHÔNG ghi gì', () => {
    it('[CK-05] expectedTotal cũ lệch (audit gửi "1000") ⇒ 409, details.{expectedTotal,currentTotal}, data = bảng tiền mới, không đơn/không giữ kho/không voucher', async () => {
      const f = buildFixture();
      const err = expectPriceChanged(await caught(place(f, { expectedTotal: '1000' })));
      expect(err.details).toEqual({ expectedTotal: '1000', currentTotal: '960000' });
      expect(err.message).toContain('1.000 ₫');
      expect(err.message).toContain('960.000 ₫');
      expectNothingWritten(f);
      // báo giá mới CÙNG DẠNG và cùng số với GET /checkout/summary hiện tại
      expect(dataOf(err)).toEqual(await summaryOf(f));
      expect(dataOf(err).total.amount).toBe('960000');
      expect(dataOf(err).shopGroups.map((g) => g.shopId)).toEqual([A, B]);
    });

    it('[CK-05] báo giá mới KHÔNG lộ trường nội bộ (giá vốn, hoa hồng, id dòng giỏ…) — chỉ các khoá của CheckoutSummaryResponse', async () => {
      const f = buildFixture();
      const err = expectPriceChanged(await caught(place(f, { expectedTotal: '1' })));
      expect(Object.keys(dataOf(err)).sort()).toEqual(['discount', 'itemCount', 'promotionCode', 'promotionError', 'provinceName', 'shippingFee', 'shopGroups', 'subtotal', 'total', 'vouchers', 'warnings']);
      expect(Object.keys(dataOf(err).shopGroups[0]).sort()).toEqual(['codAvailable', 'discount', 'itemCount', 'shippingFee', 'shopId', 'shopName', 'subtotal', 'total']);
      expect(JSON.stringify(err.data)).not.toMatch(/commission/i);
    });

    it('[CK-05] đổi giá sản phẩm giữa lúc xem và lúc đặt ⇒ 409; bảng tiền mới có giá mới', async () => {
      const f = buildFixture();
      const seen = await summaryOf(f);
      f.world.lines = [bline(A, 'a1', 450_000n), bline(B, 'b1', 250_000n, 2)]; // shop A tăng giá 400k → 450k
      const err = expectPriceChanged(await caught(place(f, { expectedTotal: seen.total.amount })));
      expect(err.details).toEqual({ expectedTotal: '960000', currentTotal: '1010000' });
      expect(dataOf(err).subtotal.amount).toBe('950000');
      expect(dataOf(err).total.amount).toBe('1010000');
      expectNothingWritten(f);
    });

    it('[CK-05] đổi phí ship giữa lúc xem và lúc đặt ⇒ 409; bảng tiền mới có phí ship mới', async () => {
      const f = buildFixture();
      const seen = await summaryOf(f);
      f.world.shipFee = 50_000n; // 2 gói × 20.000 đắt hơn
      const err = expectPriceChanged(await caught(place(f, { expectedTotal: seen.total.amount })));
      expect(err.details).toEqual({ expectedTotal: '960000', currentTotal: '1000000' });
      expect(dataOf(err).shippingFee.amount).toBe('100000');
      expectNothingWritten(f);
    });

    it('[CK-05] voucher HẾT LƯỢT giữa lúc xem và lúc đặt ⇒ 409 giá đổi (không phải 400 lỗi mã chung); bảng tiền mới báo rõ mã bị từ chối + lý do', async () => {
      const f = buildFixture();
      const seen = await summaryOf(f, [VOUCHER]);
      expect(seen.total.amount).toBe('910000');
      f.world.voucher = 'exhausted';
      const err = expectPriceChanged(await caught(place(f, { voucherCodes: [VOUCHER], expectedTotal: seen.total.amount })));
      expect(err.details).toEqual({ expectedTotal: '910000', currentTotal: '960000' });
      expect(dataOf(err).total.amount).toBe('960000');
      expect(dataOf(err).vouchers).toEqual([expect.objectContaining({ code: VOUCHER, ok: false, error: 'Mã đã hết lượt sử dụng' })]);
      expect(dataOf(err).promotionError).toBe('Mã đã hết lượt sử dụng');
      expectNothingWritten(f);
    });

    it('[CK-05] cùng tình huống nhưng KHÔNG gửi expectedTotal ⇒ vẫn lỗi mã cũ ORDER_PROMOTION_INVALID (không đổi hành vi client cũ)', async () => {
      const f = buildFixture();
      f.world.voucher = 'exhausted';
      await expect(place(f, { voucherCodes: [VOUCHER] })).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID, message: `${VOUCHER}: Mã đã hết lượt sử dụng` });
      expectNothingWritten(f);
    });

    it('[CK-05] khách đã thấy mã bị từ chối và vẫn đặt với đúng tổng KHÔNG-giảm ⇒ tổng khớp nên không phải 409 giá đổi; mã lỗi vẫn chặn như cũ (PROMOTION_INVALID)', async () => {
      const f = buildFixture();
      f.world.voucher = 'exhausted';
      const seen = await summaryOf(f, [VOUCHER]);
      expect(seen.total.amount).toBe('960000');
      await expect(place(f, { voucherCodes: [VOUCHER], expectedTotal: seen.total.amount })).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID });
      expectNothingWritten(f);
    });

    it('[CK-05] đơn NHIỀU shop: chỉ một shop đổi giá cũng làm lệch tổng cả nhóm ⇒ 409; data.shopGroups cho thấy shop nào đổi', async () => {
      const f = buildFixture();
      const seen = await summaryOf(f);
      f.world.lines = [bline(A, 'a1', 400_000n), bline(B, 'b1', 200_000n, 2)]; // chỉ shop B giảm giá 250k → 200k
      const err = expectPriceChanged(await caught(place(f, { expectedTotal: seen.total.amount })));
      expect(dataOf(err).shopGroups.map((g) => [g.shopId, g.total.amount])).toEqual([[A, '430000'], [B, '430000']]);
      expect(err.details.currentTotal).toBe('860000');
      expectNothingWritten(f);
    });

    it('[CK-05] đủ cả 2 shop khớp ⇒ đặt được (so tổng CẢ NHÓM = Σ total các đơn con, đúng PLAN-0032 §2.1)', async () => {
      const f = buildFixture();
      const seen = await summaryOf(f);
      const sumOfKids = seen.shopGroups.reduce((s, g) => s + BigInt(g.total.amount), 0n);
      expect(sumOfKids.toString()).toBe(seen.total.amount);
      await place(f, { expectedTotal: seen.total.amount });
      expect(f.create).toHaveBeenCalledTimes(2);
    });

    it('[CK-05] lệch chỉ 1đ vẫn bị chặn (không làm tròn/dung sai)', async () => {
      const f = buildFixture();
      expectPriceChanged(await caught(place(f, { expectedTotal: '959999' })));
      expectPriceChanged(await caught(place(f, { expectedTotal: '960001' })));
      expectNothingWritten(f);
    });

    it('[CK-05] thứ tự kiểm: giỏ rỗng / giỏ đổi (hết hàng) vẫn báo lỗi riêng của chúng, không bị 409 giá đổi che', async () => {
      const empty = buildFixture();
      empty.world.lines = [];
      await expect(place(empty, { expectedTotal: '1' })).rejects.toMatchObject({ errorCode: ORDER_ERR.CART_EMPTY });
      const short = buildFixture();
      short.world.lines = [{ ...bline(A, 'a1', 400_000n), available: 0 }];
      await expect(place(short, { expectedTotal: '1' })).rejects.toMatchObject({ errorCode: ORDER_ERR.CART_CHANGED });
    });
  });

  describe('voucher hụt đúng lúc chốt (consume) khi khách có gửi expectedTotal', () => {
    it('[CK-05] báo giá còn ok nhưng consume báo hết lượt (đơn khác chốt trước) ⇒ 409 giá đổi với báo giá TÍNH LẠI; không ghi đơn/kho/thanh toán', async () => {
      const f = buildFixture();
      const seen = await summaryOf(f, [VOUCHER]);
      // Tại thời điểm chốt, đơn khác vừa lấy lượt cuối: báo giá lần sau (tính lại ngoài transaction) đã thấy mã hết lượt.
      f.consume.mockImplementationOnce(() => {
        f.world.voucher = 'exhausted';
        return Promise.resolve({ ok: false, code: VOUCHER, name: null, type: 'fixed_amount', scope: 'platform', shopId: null, discount: 0n, error: 'Mã đã hết lượt sử dụng', missingAmount: null } as PromotionQuote);
      });
      const err = expectPriceChanged(await caught(place(f, { voucherCodes: [VOUCHER], expectedTotal: seen.total.amount })));
      expect(err.details).toEqual({ expectedTotal: '910000', currentTotal: '960000' });
      expect(dataOf(err).vouchers).toEqual([expect.objectContaining({ code: VOUCHER, ok: false })]);
      expect(f.consume).toHaveBeenCalledTimes(1);
      expectNoOrderRows(f);
    });

    it('[CK-05] consume lệch số giảm so với báo giá (điều kiện mã vừa đổi) + có expectedTotal ⇒ cũng ra 409 giá đổi khi tính lại thực sự ra tổng khác', async () => {
      const f = buildFixture();
      const seen = await summaryOf(f, [VOUCHER]);
      f.consume.mockImplementationOnce(() => {
        f.world.voucher = 'exhausted';
        return Promise.resolve({ ok: true, code: VOUCHER, name: `Mã ${VOUCHER}`, type: 'fixed_amount', scope: 'platform', shopId: null, discount: 40_000n, error: null, missingAmount: null } as PromotionQuote);
      });
      expectPriceChanged(await caught(place(f, { voucherCodes: [VOUCHER], expectedTotal: seen.total.amount })));
      expectNoOrderRows(f);
    });

    it('[CK-05] tính lại mà tổng vẫn KHỚP expectedTotal (quote/consume lệch nhau, không phải giá đổi thật) ⇒ trả lỗi mã cũ, KHÔNG 409 giá-đổi vô nghĩa (tránh FE lặp vô hạn)', async () => {
      const f = buildFixture();
      f.world.voucher = 'exhausted-at-consume'; // quote ok (tổng 910.000) nhưng consume luôn từ chối
      const seen = await summaryOf(f, [VOUCHER]);
      expect(seen.total.amount).toBe('910000');
      const err = await caught(place(f, { voucherCodes: [VOUCHER], expectedTotal: seen.total.amount }));
      expect(err).toBeInstanceOf(BusinessException);
      expect((err as BusinessException).errorCode).toBe(ORDER_ERR.PROMOTION_INVALID);
      expectNoOrderRows(f);
    });

    it('[CK-05] không có expectedTotal: voucher hụt lúc chốt vẫn ném lỗi mã cũ (400/409 PROMOTION_INVALID) như trước', async () => {
      const f = buildFixture();
      f.world.voucher = 'exhausted-at-consume';
      await expect(place(f, { voucherCodes: [VOUCHER] })).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID, httpStatus: 400 });
      f.world.voucher = 'discount-differs-at-consume';
      await expect(place(f, { voucherCodes: [VOUCHER] })).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID, httpStatus: 409 });
      expectNoOrderRows(f);
    });
  });

  describe('Idempotency-Key không bị ảnh hưởng', () => {
    it('[CK-05] 409 giá đổi rollback cả dòng idempotency: không `complete`, không còn dòng IN_PROGRESS ⇒ retry cùng key với giá mới đặt được', async () => {
      const f = buildFixture();
      const key = 'idem-ck05-1';
      const err = expectPriceChanged(await caught(place(f, { expectedTotal: '1000' }, key)));
      expect(f.idemUpdate).not.toHaveBeenCalled();
      expect(f.idemRows.size).toBe(0);
      // khách xem báo giá mới (data) rồi xác nhận: gửi lại CÙNG Idempotency-Key với expectedTotal mới ⇒ thành công, key được chốt đúng một lần
      const out = await place(f, { expectedTotal: dataOf(err).total.amount }, key);
      expect(out).toMatchObject({ code: 'DHN261001' });
      expect(f.createGroup).toHaveBeenCalledTimes(1);
      expect(f.idemUpdate).toHaveBeenCalledTimes(1);
      expect([...f.idemRows.values()].map((r) => [r.status, r.resultRef])).toEqual([['DONE', 'DHN261001']]);
    });

    it('[CK-05] retry sau mất mạng: key đã DONE ⇒ replay đúng đơn cũ KHÔNG kiểm giá (expectedTotal cũ lệch cũng không bị 409 oan), không tạo/giữ kho lần hai', async () => {
      const f = buildFixture();
      const key = 'idem-ck05-2';
      await place(f, { expectedTotal: '960000' }, key);
      expect(f.createGroup).toHaveBeenCalledTimes(1);
      f.world.lines = [bline(A, 'a1', 999_000n)]; // sau đó giá đổi, giỏ cũng đã thay
      const again = await place(f, { expectedTotal: '960000' }, key);
      expect(again).toMatchObject({ code: 'DHN261001' });
      expect(f.createGroup).toHaveBeenCalledTimes(1);
      expect(f.reserve).toHaveBeenCalledTimes(2);
    });

    it('[CK-05] expectedTotal KHÔNG thuộc dấu vân tay của yêu cầu: cùng key, đổi expectedTotal ⇒ không bị COMMON_IDEMPOTENCY_KEY_REUSED', async () => {
      const f = buildFixture();
      const key = 'idem-ck05-3';
      await place(f, { expectedTotal: '960000' }, key);
      const hash = IdempotencyService.hashRequest({ userId: USER, address: ADDRESS, methodCode: 'cod', note: null, vouchers: [] });
      expect([...f.idemRows.values()][0].requestHash).toBe(hash);
      await expect(place(f, { expectedTotal: '1' }, key)).resolves.toMatchObject({ code: 'DHN261001' });
    });
  });

  describe('đầu vào không hợp lệ', () => {
    it.each([['12.5'], ['abc'], ['-1'], ['1e6'], ['1,000'], ['123456789012345']])('[CK-05] expectedTotal = %p ⇒ 400 COMMON_VALIDATION_ERROR, không ghi gì (lớp phòng thủ của service)', async (value) => {
      const f = buildFixture();
      const err = await caught(place(f, { expectedTotal: value }));
      expect(err).toBeInstanceOf(BusinessException);
      expect(err).toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR', httpStatus: 400 });
      expect(f.cart.basketOf).not.toHaveBeenCalled();
      expectNothingWritten(f);
    });
  });
});

describe('[CK-05] CreateOrderRequest.expectedTotal — DTO', () => {
  const props = (body: Record<string, unknown>) => validateSync(plainToInstance(CreateOrderRequest, { paymentMethodCode: 'cod', ...body }), { whitelist: true }).map((e) => e.property);
  const parsed = (body: Record<string, unknown>) => plainToInstance(CreateOrderRequest, { paymentMethodCode: 'cod', ...body }).expectedTotal;

  it('tuỳ chọn: bỏ trống / null đều hợp lệ (client cũ)', () => {
    expect(props({})).toEqual([]);
    expect(props({ expectedTotal: null })).toEqual([]);
    expect(parsed({})).toBeUndefined();
  });

  it.each([['1250000'], ['0'], ['960000.00'], ['99999999999999']])('nhận chuỗi số nguyên VND %p', (value) => {
    expect(props({ expectedTotal: value })).toEqual([]);
  });

  it('nhận số nguyên JSON và chuẩn hoá về chuỗi (client dùng Number.parseInt)', () => {
    expect(props({ expectedTotal: 1_250_000 })).toEqual([]);
    expect(parsed({ expectedTotal: 1_250_000 })).toBe('1250000');
  });

  it.each([['abc'], ['12.5'], ['-5'], ['1e6'], ['1.250.000'], ['1250000₫'], [1250000.5], [-5], [true], [{}], ['123456789012345']])('từ chối %p', (value) => {
    expect(props({ expectedTotal: value })).toContain('expectedTotal');
  });
});

describe('[CK-05] BusinessException.data → ApiResponse.data (filter chung)', () => {
  interface Body {
    success: boolean;
    message: string;
    data: unknown;
    error: { code: string; details: Record<string, string> };
  }
  function run(exception: unknown): { status: number; body: Body } {
    let status = 0;
    let body: Body | null = null;
    const res = {
      status: (s: number) => {
        status = s;
        return { json: (b: Body) => void (body = b) };
      },
    };
    const req = { originalUrl: '/api/v1/orders', url: '/orders' };
    const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as unknown as ArgumentsHost;
    new GlobalExceptionFilter().catch(exception, host);
    return { status, body: body as unknown as Body };
  }

  it('lỗi có data ⇒ response giữ nguyên status 409, mã lỗi, details (chuỗi) và data (đối tượng)', () => {
    const { status, body } = run(new BusinessException('ORDER_PRICE_CHANGED', 'Giá đã đổi', 409, { expectedTotal: '1', currentTotal: '2' }, { total: { amount: '2' } }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, message: 'Giá đã đổi', data: { total: { amount: '2' } }, error: { code: 'ORDER_PRICE_CHANGED', details: { expectedTotal: '1', currentTotal: '2' } } });
  });

  it('mọi lỗi khác (không data) vẫn data = null — không đổi hợp đồng cũ', () => {
    const { body } = run(new BusinessException('ORDER_CART_EMPTY', 'Giỏ trống'));
    expect(body.data).toBeNull();
    expect(body.error.details).toEqual({});
    expect(run(new Error('boom')).body.data).toBeNull();
  });
});
