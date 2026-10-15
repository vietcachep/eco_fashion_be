import { Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { BasketForPromotion, PromotionGateway, PromotionQuote } from '@common/gateway/promotion.gateway';
import type { InventoryGateway } from '@common/gateway/inventory.gateway';
import type { PaymentGateway } from '@common/gateway/payment.gateway';
import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { Basket, CartQueryApi } from '../../../cart/queryapi/cart.queryapi';
import type { ShopBrief, ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import type { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { ORDER_ERR, ORDER_STATUS } from '../../foundation/order.constants';
import type { OrderGroupResponse } from '../dto/order.responses';
import type { OrderRepository, OrderRow } from '../repository/order.repository';
import { OrderService } from './order.service';

/*
 * PLAN-0017 — voucher SÀN + voucher GIAN HÀNG ở tầng order. OrderService chạy THẬT; mọi phụ thuộc (cart/system/shop/promotion/inventory/
 * payment/repo/prisma) là mock có kiểu. Cổng khuyến mãi giả (`fakeGateway`) mô phỏng đúng hợp đồng của PromotionService: voucher shop
 * chỉ áp cho giỏ có `shopId` trùng, free_shipping = phí ship của giỏ được hỏi. Phần tính tiền thuần của applyVouchers được gọi trực tiếp.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER = 'user-1';
const TX = { __tx: true } as unknown as Tx;
const actor: AuthenticatedActor = { userId: USER, email: 'khach@fitly.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-1' };

const SHIP_FEE = 30_000n;
const FREE_SHIP_THRESHOLD = 1_000_000n;

/* ------------------------------------------------------------------ applyVouchers: dữ liệu vào thuần */

type GroupIn = { shopId: string; lines: Basket['lines']; subtotal: bigint; shippingFee: bigint };
const grp = (shopId: string, subtotal: bigint, shippingFee: bigint): GroupIn => ({ shopId, lines: [], subtotal, shippingFee });

const quote = (over: Partial<PromotionQuote> = {}): PromotionQuote => ({ ok: true, code: 'X', name: 'Mã X', type: 'percentage', scope: 'platform', shopId: null, discount: 0n, error: null, missingAmount: null, ...over });
const platformV = (discount: bigint, over: Partial<PromotionQuote> = {}) => ({ shopId: null, quote: quote({ code: 'PLAT', scope: 'platform', shopId: null, discount, ...over }) });
const shopV = (shopId: string, discount: bigint, over: Partial<PromotionQuote> = {}) => ({ shopId, quote: quote({ code: `SHOP-${shopId.slice(0, 1)}`, scope: 'shop', shopId, discount, ...over }) });

const apply = (groups: GroupIn[], vouchers: Array<{ shopId: string | null; quote: PromotionQuote }>) => OrderService['applyVouchers'](groups, vouchers);
const sumOf = <T>(rows: T[], pick: (r: T) => bigint) => rows.reduce((s, r) => s + pick(r), 0n);

/* Bất biến TIỀN mọi kết quả phải thoả: discount = shop + sàn, total = subtotal + ship − discount ≥ 0, không giảm quá subtotal + ship. */
function expectMoneyInvariants(result: ReturnType<typeof apply>): void {
  for (const g of result) {
    expect(g.shopDiscount).toBeGreaterThanOrEqual(0n);
    expect(g.platformDiscount).toBeGreaterThanOrEqual(0n);
    expect(g.discount).toBe(g.shopDiscount + g.platformDiscount);
    expect(g.total).toBe(g.subtotal + g.shippingFee - g.discount);
    expect(g.total).toBeGreaterThanOrEqual(0n);
    expect(g.discount).toBeLessThanOrEqual(g.subtotal + g.shippingFee);
  }
}

describe('OrderService.applyVouchers — phân bổ voucher về đơn con', () => {
  const three = () => [grp(A, 500_000n, 30_000n), grp(B, 300_000n, 30_000n), grp(C, 200_000n, 30_000n)];

  it('(a) chỉ voucher shop → đúng đơn con của shop đó, các đơn khác không giảm', () => {
    const r = apply(three(), [shopV(B, 40_000n)]);
    expect(r.map((g) => [g.shopDiscount, g.platformDiscount, g.discount, g.total])).toEqual([
      [0n, 0n, 0n, 530_000n],
      [40_000n, 0n, 40_000n, 290_000n],
      [0n, 0n, 0n, 230_000n],
    ]);
    expectMoneyInvariants(r);
  });

  it('(a2) voucher của shop KHÔNG có trong danh sách gói bị bỏ qua (không rơi sang gói khác)', () => {
    const r = apply(three(), [shopV(D, 40_000n)]);
    expect(r.every((g) => g.discount === 0n)).toBe(true);
  });

  it('(b) chỉ voucher sàn percentage trên 3 đơn con → phân bổ theo tỉ lệ subtotal, tổng khớp tuyệt đối', () => {
    const r = apply(three(), [platformV(100_000n)]);
    expect(r.map((g) => g.platformDiscount)).toEqual([50_000n, 30_000n, 20_000n]);
    expect(r.every((g) => g.shopDiscount === 0n)).toBe(true);
    expect(sumOf(r, (g) => g.platformDiscount)).toBe(100_000n);
    expectMoneyInvariants(r);
  });

  it('(b2) số lẻ: 100.001đ chia 3 đơn bằng nhau → dư làm tròn dồn vào đơn có trọng số CUỐI, tổng đúng 100.001đ', () => {
    const r = apply([grp(A, 100_000n, 30_000n), grp(B, 100_000n, 30_000n), grp(C, 100_000n, 30_000n)], [platformV(100_001n)]);
    expect(r.map((g) => g.platformDiscount)).toEqual([33_333n, 33_333n, 33_335n]);
    expect(sumOf(r, (g) => g.platformDiscount)).toBe(100_001n);
    expectMoneyInvariants(r);
  });

  it('(b3) số lẻ + trọng số lệch 1:2:3 → [16.666, 33.333, 50.002], tổng 100.001', () => {
    const r = apply([grp(A, 100_000n, 30_000n), grp(B, 200_000n, 30_000n), grp(C, 300_000n, 30_000n)], [platformV(100_001n)]);
    expect(r.map((g) => g.platformDiscount)).toEqual([16_666n, 33_333n, 50_002n]);
    expect(sumOf(r, (g) => g.platformDiscount)).toBe(100_001n);
  });

  it('(b4) 1 đơn con duy nhất nhận trọn voucher sàn', () => {
    const r = apply([grp(A, 500_000n, 30_000n)], [platformV(77_777n)]);
    expect(r[0].platformDiscount).toBe(77_777n);
    expect(r[0].total).toBe(530_000n - 77_777n);
  });

  it('(b5) tính chất: nhiều tổ hợp ngẫu nhiên (seed cố định) — tổng phân bổ == discount của voucher sàn, mỗi suất lệch < n đồng so với tỉ lệ chính xác', () => {
    let seed = 20_261_003;
    const rnd = (max: number) => {
      seed = (seed * 48_271) % 2_147_483_647; // Park–Miller: giữ trong miền số nguyên an toàn của JS
      return seed % max;
    };
    for (let i = 0; i < 300; i += 1) {
      const n = 2 + rnd(4);
      const groups = Array.from({ length: n }, (_, k) => grp(`shop-${k}`, BigInt(10_000 + rnd(2_000_000)), BigInt(10_000 + rnd(40_000))));
      const total = sumOf(groups, (g) => g.subtotal);
      const discount = (total * BigInt(1 + rnd(100))) / 100n; // ≤ 100% subtotal ⇒ không bị clamp (còn phí ship làm đệm)
      const r = apply(groups, [platformV(discount)]);
      expect(sumOf(r, (g) => g.platformDiscount)).toBe(discount);
      expectMoneyInvariants(r);
      r.forEach((g, k) => {
        const exactTimesW = discount * groups[k].subtotal;
        const gotTimesW = g.platformDiscount * total;
        const diff = gotTimesW > exactTimesW ? gotTimesW - exactTimesW : exactTimesW - gotTimesW;
        expect(diff).toBeLessThan(BigInt(n) * total);
      });
    }
  });

  it('(c) voucher sàn free_shipping → phân bổ theo phí ship từng gói; gói ship 0 nhận 0', () => {
    const groups = [grp(A, 500_000n, 30_000n), grp(B, 1_200_000n, 0n), grp(C, 200_000n, 20_000n)];
    const r = apply(groups, [platformV(50_000n, { type: 'free_shipping' })]);
    expect(r.map((g) => g.platformDiscount)).toEqual([30_000n, 0n, 20_000n]);
    expect(r[1].total).toBe(1_200_000n);
    expectMoneyInvariants(r);
  });

  it('(c2) free_shipping khi gói CUỐI có ship 0: phần dư dồn vào gói có trọng số cuối (không phải gói cuối danh sách)', () => {
    const groups = [grp(A, 500_000n, 30_000n), grp(B, 300_000n, 20_000n), grp(C, 1_500_000n, 0n)];
    const r = apply(groups, [platformV(50_000n, { type: 'free_shipping' })]);
    expect(r.map((g) => g.platformDiscount)).toEqual([30_000n, 20_000n, 0n]);
    expect(sumOf(r, (g) => g.platformDiscount)).toBe(50_000n);
  });

  it('(d) cả hai loại: shopDiscount + platformDiscount, discount = tổng, total = subtotal + ship − discount ≥ 0', () => {
    const r = apply([grp(A, 500_000n, 30_000n), grp(B, 300_000n, 30_000n)], [shopV(A, 30_000n), platformV(100_000n)]);
    // sàn chia theo subtotal 500:300 → 62.500 / 37.500
    expect(r[0]).toMatchObject({ shopDiscount: 30_000n, platformDiscount: 62_500n, discount: 92_500n, total: 437_500n });
    expect(r[1]).toMatchObject({ shopDiscount: 0n, platformDiscount: 37_500n, discount: 37_500n, total: 292_500n });
    expect(sumOf(r, (g) => g.discount)).toBe(130_000n);
    expectMoneyInvariants(r);
  });

  it('(d2) mỗi shop một voucher shop riêng + voucher sàn: cộng đủ, không trùng', () => {
    const r = apply(three(), [shopV(A, 50_000n), shopV(B, 40_000n), platformV(100_000n)]);
    expect(sumOf(r, (g) => g.shopDiscount)).toBe(90_000n);
    expect(sumOf(r, (g) => g.platformDiscount)).toBe(100_000n);
    expect(sumOf(r, (g) => g.discount)).toBe(190_000n);
    expectMoneyInvariants(r);
  });

  it('(e) clamp: voucher shop 100% + voucher sàn ⇒ đơn con KHÔNG giảm quá subtotal+ship, phần sàn bị cắt, shop được ưu tiên', () => {
    const r = apply([grp(A, 100_000n, 30_000n), grp(B, 100_000n, 30_000n)], [shopV(A, 100_000n), platformV(80_000n)]);
    // sàn chia 40.000/40.000; đơn A còn đệm 130.000 − 100.000 = 30.000 ⇒ phần sàn của A bị cắt xuống 30.000
    expect(r[0]).toMatchObject({ shopDiscount: 100_000n, platformDiscount: 30_000n, discount: 130_000n, total: 0n });
    expect(r[1]).toMatchObject({ shopDiscount: 0n, platformDiscount: 40_000n, discount: 40_000n, total: 90_000n });
    expectMoneyInvariants(r);
  });

  it('(e2) voucher shop tự nó vượt subtotal+ship ⇒ bị cắt về đúng subtotal+ship, phần sàn về 0, total 0', () => {
    const r = apply([grp(A, 100_000n, 30_000n)], [shopV(A, 500_000n), platformV(50_000n)]);
    expect(r[0]).toMatchObject({ shopDiscount: 130_000n, platformDiscount: 0n, discount: 130_000n, total: 0n });
  });

  it('(e3) voucher sàn bằng 100% tiền hàng (số lẻ, gói đầu ship 0) ⇒ chỉ còn phải trả phí ship, không gói nào âm', () => {
    const r = apply([grp(A, 33_333n, 0n), grp(B, 33_333n, 30_000n), grp(C, 33_334n, 30_000n)], [platformV(100_000n)]);
    expect(r.map((g) => g.platformDiscount)).toEqual([33_333n, 33_333n, 33_334n]);
    expect(r.map((g) => g.total)).toEqual([0n, 30_000n, 30_000n]);
    expectMoneyInvariants(r);
  });

  it('(f) voucher bị từ chối (ok=false) không ảnh hưởng số tiền dù mang discount > 0', () => {
    const r = apply(three(), [platformV(999_999n, { ok: false, error: 'Mã hết hạn' }), shopV(A, 50_000n, { ok: false, error: 'Mã hết hạn' })]);
    expect(r.every((g) => g.shopDiscount === 0n && g.platformDiscount === 0n && g.discount === 0n)).toBe(true);
    expect(r.map((g) => g.total)).toEqual([530_000n, 330_000n, 230_000n]);
  });

  it('(f2) voucher bị từ chối đứng cạnh voucher hợp lệ: chỉ voucher hợp lệ được tính', () => {
    const r = apply(three(), [platformV(999_999n, { ok: false, error: 'x' }), platformV(100_000n, { code: 'PLAT-OK' }), shopV(A, 77_777n, { ok: false, error: 'x' }), shopV(A, 50_000n, { code: 'SHOP-OK' })]);
    expect(sumOf(r, (g) => g.platformDiscount)).toBe(100_000n);
    expect(r[0].shopDiscount).toBe(50_000n);
  });

  it('không có voucher / voucher sàn discount 0 ⇒ không giảm gì', () => {
    expect(apply(three(), []).every((g) => g.discount === 0n)).toBe(true);
    expect(apply(three(), [platformV(0n)]).every((g) => g.discount === 0n)).toBe(true);
  });

  it('phòng thủ: hai voucher sàn hợp lệ (không xảy ra từ price()) KHÔNG bị cộng dồn — chỉ cái đầu được tính', () => {
    const r = apply(three(), [platformV(100_000n, { code: 'P1' }), platformV(60_000n, { code: 'P2' })]);
    expect(sumOf(r, (g) => g.platformDiscount)).toBe(100_000n);
  });

  it('phòng thủ: hai voucher hợp lệ cùng shop KHÔNG bị cộng dồn', () => {
    const r = apply(three(), [shopV(A, 50_000n, { code: 'S1' }), shopV(A, 15_000n, { code: 'S2' })]);
    expect(r[0].shopDiscount === 65_000n).toBe(false);
    expect([50_000n, 15_000n]).toContain(r[0].shopDiscount);
  });

  describe('freeship sàn + freeship shop trên CÙNG đơn con: tổng không vượt phí ship, shop được ưu tiên', () => {
    const fs = (n: bigint) => ({ type: 'free_shipping', discount: n });

    it('cả hai freeship ⇒ chỉ giảm đúng 1× phí ship (phần shop), phần sàn bị cắt về 0, tiền hàng không bị trừ', () => {
      const r = apply([grp(A, 500_000n, 30_000n)], [platformV(30_000n, fs(30_000n)), shopV(A, 30_000n, fs(30_000n))]);
      expect(r[0]).toMatchObject({ shopDiscount: 30_000n, platformDiscount: 0n, discount: 30_000n, total: 500_000n });
      expectMoneyInvariants(r);
    });

    it('nhiều gói: chỉ gói có freeship shop bị cắt phần sàn, các gói còn lại vẫn được freeship sàn đủ', () => {
      const r = apply([grp(A, 500_000n, 30_000n), grp(B, 300_000n, 30_000n), grp(C, 200_000n, 30_000n)], [platformV(90_000n, fs(90_000n)), shopV(A, 30_000n, fs(30_000n))]);
      expect(r.map((g) => [g.shopDiscount, g.platformDiscount])).toEqual([
        [30_000n, 0n],
        [0n, 30_000n],
        [0n, 30_000n],
      ]);
      expect(r.map((g) => g.total)).toEqual([500_000n, 300_000n, 200_000n]);
    });

    it('chỉ cắt khi CẢ HAI cùng là freeship: shop fixed 40.000 + sàn freeship ⇒ cộng đủ (giảm hàng + miễn ship)', () => {
      const r = apply([grp(A, 500_000n, 30_000n)], [platformV(30_000n, fs(30_000n)), shopV(A, 40_000n, { type: 'fixed_amount' })]);
      expect(r[0]).toMatchObject({ shopDiscount: 40_000n, platformDiscount: 30_000n, discount: 70_000n, total: 460_000n });
    });

    it('shop freeship nhưng discount 0 (ví dụ phạm vi không khớp) ⇒ sàn vẫn freeship đủ', () => {
      const r = apply([grp(A, 500_000n, 30_000n)], [platformV(30_000n, fs(30_000n)), shopV(A, 0n, { type: 'free_shipping' })]);
      expect(r[0]).toMatchObject({ shopDiscount: 0n, platformDiscount: 30_000n });
    });

    it('shop percentage + sàn freeship: không bị luật freeship cắt', () => {
      const r = apply([grp(A, 500_000n, 30_000n)], [platformV(30_000n, fs(30_000n)), shopV(A, 50_000n, { type: 'percentage' })]);
      expect(r[0]).toMatchObject({ shopDiscount: 50_000n, platformDiscount: 30_000n, total: 450_000n });
    });
  });
});

/* ------------------------------------------------------------------ OrderService['normalizeCodes'] */

describe('OrderService.normalizeCodes', () => {
  const norm = (input: { voucherCode?: string | null; voucherCodes?: string[] }) => OrderService['normalizeCodes'](input);

  it('gộp voucherCode + voucherCodes, giữ thứ tự (voucherCode đứng đầu)', () => {
    expect(norm({ voucherCode: 'A1', voucherCodes: ['B2', 'C3'] })).toEqual(['A1', 'B2', 'C3']);
  });

  it('bỏ rỗng / khoảng trắng / null / undefined', () => {
    expect(norm({ voucherCode: '  ', voucherCodes: ['', ' B2 ', '   '] })).toEqual(['B2']);
    expect(norm({ voucherCode: null })).toEqual([]);
    expect(norm({})).toEqual([]);
  });

  it('bỏ trùng KHÔNG phân biệt hoa thường, giữ bản gặp đầu tiên', () => {
    expect(norm({ voucherCode: 'abc', voucherCodes: ['ABC', 'Abc', 'def', 'DEF'] })).toEqual(['abc', 'def']);
  });

  it('tối đa 12 mã', () => {
    const many = Array.from({ length: 20 }, (_, i) => `M${i}`);
    const out = norm({ voucherCodes: many });
    expect(out).toHaveLength(12);
    expect(out[0]).toBe('M0');
    expect(out[11]).toBe('M11');
  });

  it('trim giữ nguyên chữ hoa/thường của bản đầu', () => {
    expect(norm({ voucherCode: '  FreeShip ' })).toEqual(['FreeShip']);
  });
});

/* ------------------------------------------------------------------ fixture đầy đủ cho checkoutSummary / placeOrder / doCancel */

interface VoucherDef {
  code: string;
  scope: 'platform' | 'shop';
  shopId?: string;
  type: 'percentage' | 'fixed_amount' | 'free_shipping';
  value?: number;
  minOrder?: bigint;
}

const VOUCHERS: VoucherDef[] = [
  { code: 'PLAT10', scope: 'platform', type: 'percentage', value: 10 },
  { code: 'PLAT5', scope: 'platform', type: 'percentage', value: 5 },
  { code: 'PLATFS', scope: 'platform', type: 'free_shipping' },
  { code: 'PLATODD', scope: 'platform', type: 'fixed_amount', value: 100_001 },
  { code: 'PLATBIG', scope: 'platform', type: 'fixed_amount', value: 400_000 },
  { code: 'SA10', scope: 'shop', shopId: A, type: 'percentage', value: 10 },
  { code: 'SA15K', scope: 'shop', shopId: A, type: 'fixed_amount', value: 15_000 },
  { code: 'SB40K', scope: 'shop', shopId: B, type: 'fixed_amount', value: 40_000 },
  { code: 'SC100', scope: 'shop', shopId: C, type: 'percentage', value: 100 },
  { code: 'SD1K', scope: 'shop', shopId: D, type: 'fixed_amount', value: 1_000 },
  { code: 'SAFS', scope: 'shop', shopId: A, type: 'free_shipping' },
  /* Mã không đủ điều kiện (đơn tối thiểu cao) — để kiểm "mã bị từ chối KHÔNG chiếm chỗ". */
  { code: 'PLATMIN', scope: 'platform', type: 'percentage', value: 10, minOrder: 5_000_000n },
  { code: 'SAMIN', scope: 'shop', shopId: A, type: 'percentage', value: 10, minOrder: 900_000n },
];

const SHOP_NAMES: Record<string, string> = { [A]: 'Shop A', [B]: 'Shop B', [C]: 'Shop C', [D]: 'Shop D' };
const brief = (id: string): ShopBrief => ({ id, code: `S-${id.slice(0, 1)}`, slug: `shop-${id.slice(0, 1)}`, name: SHOP_NAMES[id], logoUrl: null, ratingAvg: null, status: 'approved', commissionRate: '5.00' });

/* Mô phỏng PromotionService.evaluate đủ cho test order: shop-mismatch, đơn tối thiểu, 3 loại giảm. */
function evalVoucher(defs: VoucherDef[], code: string, basket: BasketForPromotion): PromotionQuote {
  const key = code.trim().toUpperCase();
  const def = defs.find((d) => d.code.toUpperCase() === key);
  if (!def) return { ok: false, code: key, name: null, type: 'unknown', scope: 'platform', shopId: null, discount: 0n, error: 'Mã không tồn tại hoặc đã hết hạn', missingAmount: null };
  const base = { code: def.code, name: `Mã ${def.code}`, type: def.type, scope: def.scope, shopId: def.shopId ?? null };
  const fail = (error: string, missingAmount: bigint | null = null): PromotionQuote => ({ ...base, ok: false, discount: 0n, error, missingAmount });
  if (def.scope === 'shop' && basket.shopId !== def.shopId) return fail('Mã chỉ áp dụng cho sản phẩm của gian hàng phát hành mã');
  if (def.minOrder !== undefined && basket.subtotal < def.minOrder) return fail('Đơn tối thiểu chưa đủ', def.minOrder - basket.subtotal);
  const lineSum = basket.lines.reduce((s, l) => s + l.lineTotal, 0n);
  let discount: bigint;
  if (def.type === 'free_shipping') discount = lineSum > 0n ? basket.shippingFee : 0n;
  else if (def.type === 'percentage') discount = (lineSum * BigInt(Math.round((def.value ?? 0) * 100))) / 10_000n;
  else discount = BigInt(def.value ?? 0) < lineSum ? BigInt(def.value ?? 0) : lineSum;
  return { ...base, ok: true, discount, error: null, missingAmount: null };
}

function bline(shopId: string, variantId: string, unitPrice: bigint, quantity = 1): Basket['lines'][number] {
  return { variantId, productId: `prod-${variantId}`, slug: variantId, name: `SP ${variantId}`, categorySlug: 'ao', imageUrl: null, color: 'Đen', size: 'M', sku: `SKU-${variantId}`, quantity, unitPrice, lineTotal: unitPrice * BigInt(quantity), available: 100, isSellable: true, shopId };
}

/* Giỏ mặc định: shop A 500k · shop B 300k · shop C 200k ⇒ subtotal 1.000.000, ship 3 × 30.000 = 90.000 (mỗi gói < ngưỡng freeship). */
const DEFAULT_LINES = [bline(A, 'a1', 500_000n), bline(B, 'b1', 300_000n), bline(C, 'c1', 200_000n)];

const ADDRESS = { recipientName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '79', provinceName: 'TP. Hồ Chí Minh', districtName: 'Q.1', wardName: null, street: '12 Nguyễn Huệ' };

function buildFixture(cfg: { lines?: Basket['lines']; vouchers?: VoucherDef[]; members?: Record<string, string[]>; shops?: Record<string, Partial<ShopBrief> | null> } = {}) {
  const lines = cfg.lines ?? DEFAULT_LINES;
  const defs = cfg.vouchers ?? VOUCHERS;
  const members = cfg.members ?? {};

  const cart = {
    basketOf: jest.fn((_userId: string, _onlySelected: boolean): Promise<Basket> => {
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0n);
      return Promise.resolve({ userId: USER, lines, subtotal, itemCount: lines.reduce((n, l) => n + l.quantity, 0) });
    }),
  };
  const system = {
    shippingFeeFor: jest.fn((subtotal: bigint, _hint: string | null | undefined) => Promise.resolve({ fee: subtotal >= FREE_SHIP_THRESHOLD ? 0n : SHIP_FEE, province: { code: '79', name: 'TP. Hồ Chí Minh' } })),
    settingNumber: jest.fn((_key: string): Promise<number> => Promise.resolve(0)),
  };
  const shops = {
    /* `cfg.shops[id]` ghi đè một phần hồ sơ shop (status…); `null` = shop không còn tồn tại. */
    findBrief: jest.fn((id: string): Promise<ShopBrief | null> => {
      if (cfg.shops && cfg.shops[id] === null) return Promise.resolve(null);
      return Promise.resolve(SHOP_NAMES[id] ? { ...brief(id), ...(cfg.shops?.[id] ?? {}) } : null);
    }),
    /* Thành viên ACTIVE của shop (mặc định rỗng) — placeOrder chặn khách là thành viên của chính shop có hàng trong giỏ. */
    activeMemberUserIds: jest.fn((shopId: string): Promise<string[]> => Promise.resolve(members[shopId] ?? [])),
  };

  const scopeOf = jest.fn((code: string): Promise<{ scope: 'platform' | 'shop'; shopId: string | null } | null> => {
    const d = defs.find((x) => x.code.toUpperCase() === code.trim().toUpperCase());
    return Promise.resolve(d ? { scope: d.scope, shopId: d.shopId ?? null } : null);
  });
  const quoteFn = jest.fn((code: string, basket: BasketForPromotion): Promise<PromotionQuote> => Promise.resolve(evalVoucher(defs, code, basket)));
  const consume = jest.fn((code: string, basket: BasketForPromotion, _orderRef: string, _tx: Tx): Promise<PromotionQuote> => Promise.resolve(evalVoucher(defs, code, basket)));
  const release = jest.fn((_orderCode: string, _tx: Tx): Promise<void> => Promise.resolve());
  const promotion: PromotionGateway = { scopeOf, quote: quoteFn, consume, release };

  let groupSeq = 0;
  let childSeq = 0;
  const nextGroupCode = jest.fn((_tx: Tx): Promise<string> => Promise.resolve(`DHN26100${(groupSeq += 1)}`));
  const nextCode = jest.fn((_tx: Tx): Promise<string> => Promise.resolve(`DH26100${(childSeq += 1)}`));
  const createGroup = jest.fn((data: Prisma.OrderGroupUncheckedCreateInput, _tx: Tx): Promise<{ id: string; code: string }> => Promise.resolve({ id: `grp-${data.code}`, code: data.code }));
  const create = jest.fn((data: Prisma.OrderUncheckedCreateInput, _tx: Tx): Promise<OrderRow> => Promise.resolve({ id: `ord-${data.code}`, code: data.code } as unknown as OrderRow));
  const addHistory = jest.fn((_orderId: string, _from: string | null, _to: string, _note: string | null, _actor: string | null, _tx: Tx): Promise<void> => Promise.resolve());
  const findByCodeForUpdate = jest.fn((_code: string, _tx: Tx): Promise<OrderRow | null> => Promise.resolve(null));
  const groupSiblingInfo = jest.fn((_groupId: string, _excludeId: string, _tx: Tx): Promise<{ groupCode: string; activeOthers: number } | null> => Promise.resolve(null));
  const update = jest.fn((_id: string, _data: Prisma.OrderUncheckedUpdateInput, _tx: Tx): Promise<OrderRow> => Promise.resolve({} as unknown as OrderRow));
  const repo = { nextGroupCode, nextCode, createGroup, create, addHistory, findByCodeForUpdate, groupSiblingInfo, update };

  const reserve = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const inventoryRelease = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const restock = jest.fn((_lines: unknown, _ref: unknown, _tx: Tx): Promise<void> => Promise.resolve());
  const inventory = { reserve, release: inventoryRelease, restock, commit: jest.fn(), availableOf: jest.fn() } as unknown as InventoryGateway;

  const initiate = jest.fn((_input: { orderCode: string; amount: bigint }, _tx: Tx): Promise<unknown> => Promise.resolve({}));
  const paymentCancel = jest.fn((_code: string, _reason: string, _tx: Tx): Promise<void> => Promise.resolve());
  const requestRefund = jest.fn((_input: { orderCode: string; amount: bigint }, _tx: Tx): Promise<{ refundId: string | null }> => Promise.resolve({ refundId: null }));
  const payment = { isMethodActive: jest.fn((_m: string): Promise<boolean> => Promise.resolve(true)), initiate, cancel: paymentCancel, requestRefund, markCodCollected: jest.fn() } as unknown as PaymentGateway;

  const audit = { write: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) };
  const outbox = { publish: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) };
  const notify = { notify: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()), notifyMany: jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve()) };
  const cartWrite = { removeLines: jest.fn((_userId: string, _variantIds: string[], _tx: Tx): Promise<void> => Promise.resolve()) };
  const users = { staffUserIdsWithPermission: jest.fn((_perm: string): Promise<string[]> => Promise.resolve([])) };
  const prisma = { $transaction: jest.fn((fn: (tx: Tx) => Promise<unknown>, _opts?: unknown): Promise<unknown> => fn(TX)) };

  const service = new OrderService(
    prisma as unknown as PrismaService,
    repo as unknown as OrderRepository,
    audit as never,
    outbox as never,
    cart as unknown as CartQueryApi,
    {} as never,
    system as unknown as SystemQueryApi,
    {} as never,
    shops as unknown as ShopQueryApi,
    inventory,
    promotion,
    payment,
    cartWrite as never,
    notify,
    {} as never,
    users as never,
  );
  const myOrderGroup = jest.spyOn(service, 'myOrderGroup').mockResolvedValue({ code: 'DHN261001' } as unknown as OrderGroupResponse);

  return { service, system, scopeOf, quote: quoteFn, consume, release, nextGroupCode, nextCode, createGroup, create, groupSiblingInfo, update, findByCodeForUpdate, reserve, inventoryRelease, restock, initiate, paymentCancel, requestRefund, cartWrite, myOrderGroup, repo, audit, notify, shops };
}

const summary = (f: ReturnType<typeof buildFixture>, voucherCodes: string[], extra: { voucherCode?: string } = {}) => f.service.checkoutSummary(actor, { voucherCodes, province: 'Hồ Chí Minh', ...extra });

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/* ------------------------------------------------------------------ checkoutSummary (price) */

describe('OrderService.checkoutSummary — luật cộng dồn voucher', () => {
  it('chỉ voucher shop: giảm đúng gói của shop, vouchers[] có đủ code/scope/shopId/shopName/ok/error/discount', async () => {
    const f = buildFixture();
    const r = await summary(f, ['sa10']);
    expect(r.vouchers).toEqual([{ code: 'SA10', scope: 'shop', shopId: A, shopName: 'Shop A', ok: true, error: null, discount: { amount: '50000', display: '50.000 ₫', currency: 'VND', symbol: '₫' } }]);
    expect(r.subtotal.amount).toBe('1000000');
    expect(r.shippingFee.amount).toBe('90000');
    expect(r.discount.amount).toBe('50000');
    expect(r.total.amount).toBe('1040000');
    expect(r.promotionCode).toBe('SA10');
    expect(r.promotionError).toBeNull();
    expect(r.shopGroups.map((g) => [g.shopId, g.shopName, g.discount.amount, g.total.amount])).toEqual([
      [A, 'Shop A', '50000', '480000'],
      [B, 'Shop B', '0', '330000'],
      [C, 'Shop C', '0', '230000'],
    ]);
  });

  it('mã shop được hỏi bằng GIỎ RIÊNG của shop (shopId + subtotal + ship + dòng của shop), mã sàn bằng giỏ cả đơn không shopId', async () => {
    const f = buildFixture();
    await summary(f, ['PLAT10', 'SB40K']);
    const byCode = new Map(f.quote.mock.calls.map(([code, basket]) => [code, basket] as const));
    expect(byCode.get('PLAT10')).toMatchObject({ userId: USER, subtotal: 1_000_000n, shippingFee: 90_000n });
    expect(byCode.get('PLAT10')?.shopId).toBeUndefined();
    expect(byCode.get('PLAT10')?.lines).toHaveLength(3);
    expect(byCode.get('SB40K')).toMatchObject({ shopId: B, subtotal: 300_000n, shippingFee: 30_000n });
    expect(byCode.get('SB40K')?.lines.map((l) => l.productId)).toEqual(['prod-b1']);
  });

  it('chỉ voucher sàn: phân bổ về 3 gói theo subtotal, tổng giảm == giảm của voucher', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLAT10']);
    expect(r.vouchers[0]).toMatchObject({ code: 'PLAT10', scope: 'platform', shopId: null, shopName: null, ok: true, error: null });
    expect(r.shopGroups.map((g) => g.discount.amount)).toEqual(['50000', '30000', '20000']);
    expect(r.discount.amount).toBe('100000');
    expect(r.total.amount).toBe('990000');
  });

  it('voucher sàn số lẻ (100.001đ) chia 3 gói: dư dồn vào gói cuối, tổng khớp', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLATODD']);
    expect(r.shopGroups.map((g) => g.discount.amount)).toEqual(['50000', '30000', '20001']);
    expect(r.discount.amount).toBe('100001');
  });

  it('voucher sàn + voucher shop các shop: tổng đúng, mỗi gói = phần shop + phần sàn', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLAT10', 'SA10', 'SB40K']);
    expect(r.shopGroups.map((g) => g.discount.amount)).toEqual(['100000', '70000', '20000']); // A: 50k+50k · B: 40k+30k · C: 0+20k
    expect(r.shopGroups.map((g) => g.total.amount)).toEqual(['430000', '260000', '210000']);
    expect(r.discount.amount).toBe('190000');
    expect(r.total.amount).toBe('900000');
    expect(r.promotionCode).toBe('PLAT10');
    expect(r.vouchers.every((v) => v.ok)).toBe(true);
  });

  it('freeship sàn: phân bổ theo phí ship từng gói — gói đã freeship theo ngưỡng (ship 0) nhận 0', async () => {
    const f = buildFixture({ lines: [bline(A, 'a1', 500_000n), bline(B, 'b1', 1_200_000n), bline(C, 'c1', 200_000n)] });
    const r = await summary(f, ['PLATFS']);
    expect(r.shippingFee.amount).toBe('60000');
    expect(r.shopGroups.map((g) => g.discount.amount)).toEqual(['30000', '0', '30000']);
    expect(r.shopGroups.map((g) => g.total.amount)).toEqual(['500000', '1200000', '200000']);
    expect(r.discount.amount).toBe('60000');
  });

  it('2 mã SÀN ⇒ mã thứ hai bị từ chối "Mỗi đơn chỉ dùng được 1 mã giảm giá của sàn", mã đầu vẫn áp', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLAT10', 'PLAT5']);
    expect(r.vouchers[0]).toMatchObject({ code: 'PLAT10', ok: true });
    expect(r.vouchers[1]).toMatchObject({ code: 'PLAT5', scope: 'platform', shopId: null, ok: false, error: 'Mỗi đơn chỉ dùng được 1 mã giảm giá của sàn' });
    expect(r.vouchers[1].discount.amount).toBe('0');
    expect(r.discount.amount).toBe('100000'); // chỉ PLAT10, không cộng 5%
    expect(r.promotionCode).toBe('PLAT10');
    expect(r.promotionError).toBe('Mỗi đơn chỉ dùng được 1 mã giảm giá của sàn');
    expect(f.quote.mock.calls.map((c) => c[0])).toEqual(['PLAT10']); // mã thừa không bị quote
  });

  it('2 mã CÙNG SHOP ⇒ mã sau bị từ chối "Mỗi gian hàng chỉ dùng được 1 mã…"; mã của shop khác vẫn được', async () => {
    const f = buildFixture();
    const r = await summary(f, ['SA10', 'SA15K', 'SB40K']);
    expect(r.vouchers.map((v) => [v.code, v.ok])).toEqual([['SA10', true], ['SA15K', false], ['SB40K', true]]);
    expect(r.vouchers[1]).toMatchObject({ scope: 'shop', shopId: A, shopName: 'Shop A', error: 'Mỗi gian hàng chỉ dùng được 1 mã giảm giá của gian hàng' });
    expect(r.discount.amount).toBe('90000'); // 50.000 (SA10) + 40.000 (SB40K), không có 15.000
    expect(r.promotionError).toBe('Mỗi gian hàng chỉ dùng được 1 mã giảm giá của gian hàng');
  });

  it('mã shop của shop KHÔNG có trong giỏ ⇒ từ chối, không ảnh hưởng tiền', async () => {
    const f = buildFixture();
    const r = await summary(f, ['SD1K']);
    expect(r.vouchers[0]).toMatchObject({ code: 'SD1K', scope: 'shop', shopId: D, shopName: 'Shop D', ok: false, error: 'Mã này dành cho gian hàng không có trong giỏ hàng của bạn' });
    expect(r.discount.amount).toBe('0');
    expect(r.total.amount).toBe('1090000');
    expect(r.promotionCode).toBeNull();
    expect(r.promotionError).toBe('Mã này dành cho gian hàng không có trong giỏ hàng của bạn');
    expect(f.quote).not.toHaveBeenCalled();
  });

  it('mã không tồn tại ⇒ ok=false, scope platform, shopId null, mã in hoa', async () => {
    const f = buildFixture();
    const r = await summary(f, ['  nope ']);
    expect(r.vouchers[0]).toMatchObject({ code: 'NOPE', scope: 'platform', shopId: null, shopName: null, ok: false, error: 'Mã không tồn tại hoặc đã hết hạn' });
  });

  it('promotionCode = mã ĐẦU TIÊN được nhận; promotionError = lỗi ĐẦU TIÊN (theo thứ tự gõ)', async () => {
    const f = buildFixture();
    const r = await summary(f, ['NOPE', 'SA10', 'PLAT10', 'PLAT5', 'SD1K']);
    expect(r.promotionCode).toBe('SA10');
    expect(r.promotionError).toBe('Mã không tồn tại hoặc đã hết hạn');
    expect(r.vouchers.map((v) => [v.code, v.ok])).toEqual([['NOPE', false], ['SA10', true], ['PLAT10', true], ['PLAT5', false], ['SD1K', false]]);
  });

  it('voucherCode + voucherCodes gộp, trùng không phân biệt hoa thường chỉ tính một lần', async () => {
    const f = buildFixture();
    const r = await summary(f, ['sa10', 'SA10', 'Sb40k'], { voucherCode: 'SA10' });
    expect(r.vouchers.map((v) => v.code)).toEqual(['SA10', 'SB40K']);
    expect(r.discount.amount).toBe('90000');
  });

  it('shop voucher dưới đơn tối thiểu của shop: bị từ chối theo GIỎ SHOP (không phải cả giỏ)', async () => {
    const f = buildFixture({ vouchers: [...VOUCHERS, { code: 'SBMIN', scope: 'shop', shopId: B, type: 'fixed_amount', value: 10_000, minOrder: 400_000n }] });
    const r = await summary(f, ['SBMIN']); // cả giỏ 1tr ≥ 400k nhưng riêng shop B chỉ 300k
    expect(r.vouchers[0]).toMatchObject({ ok: false, error: 'Đơn tối thiểu chưa đủ' });
    expect(r.discount.amount).toBe('0');
  });

  it('clamp ở checkout: shop 100% + sàn lớn ⇒ đơn con không giảm quá subtotal+ship, tổng khớp tổng đơn con', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLATBIG', 'SC100']);
    // sàn 400k chia 200k/120k/80k; C: shop 200k + sàn min(80k, 30k) = 230k ⇒ total 0
    expect(r.shopGroups.map((g) => g.discount.amount)).toEqual(['200000', '120000', '230000']);
    expect(r.shopGroups.map((g) => g.total.amount)).toEqual(['330000', '210000', '0']);
    expect(r.discount.amount).toBe('550000');
    expect(r.total.amount).toBe('540000');
    expect(BigInt(r.discount.amount)).toBe(r.shopGroups.reduce((s, g) => s + BigInt(g.discount.amount), 0n));
    expect(BigInt(r.total.amount)).toBe(r.shopGroups.reduce((s, g) => s + BigInt(g.total.amount), 0n));
  });

  it('vouchers[].discount là số THỰC áp (sau cắt theo đơn con): tổng các mã == tổng giảm của đơn', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLATBIG', 'SC100']);
    // sàn quote 400k nhưng thực áp 200k + 120k + 30k (đơn C bị cắt) = 350k; shop C thực áp 200k
    expect(r.vouchers.map((v) => [v.code, v.discount.amount])).toEqual([
      ['PLATBIG', '350000'],
      ['SC100', '200000'],
    ]);
    expect(r.vouchers.reduce((s, v) => s + BigInt(v.discount.amount), 0n)).toBe(BigInt(r.discount.amount));
  });

  it('vouchers[].discount thực áp khi không cắt: khớp số quote; mã bị từ chối = 0', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLAT10', 'PLAT5', 'SA10', 'SB40K']);
    expect(r.vouchers.map((v) => [v.code, v.ok, v.discount.amount])).toEqual([
      ['PLAT10', true, '100000'],
      ['PLAT5', false, '0'],
      ['SA10', true, '50000'],
      ['SB40K', true, '40000'],
    ]);
    expect(r.vouchers.reduce((s, v) => s + BigInt(v.discount.amount), 0n)).toBe(BigInt(r.discount.amount));
  });

  it('freeship sàn + freeship shop cùng đơn con: vouchers[] phản ánh phần sàn bị cắt, tổng giảm ≤ phí ship', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLATFS', 'SAFS']);
    // sàn quote 90k (3 × 30k) nhưng gói A đã được freeship shop ⇒ sàn thực áp 60k; shop A thực áp 30k
    expect(r.vouchers.map((v) => [v.code, v.discount.amount])).toEqual([
      ['PLATFS', '60000'],
      ['SAFS', '30000'],
    ]);
    expect(r.discount.amount).toBe('90000');
    expect(r.shopGroups.map((g) => g.total.amount)).toEqual(['500000', '300000', '200000']);
  });

  it('mã bị từ chối KHÔNG chiếm chỗ: mã sàn không đủ điều kiện đứng trước, mã sàn hợp lệ đứng sau vẫn được nhận', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLATMIN', 'PLAT10']);
    expect(r.vouchers.map((v) => [v.code, v.ok])).toEqual([
      ['PLATMIN', false],
      ['PLAT10', true],
    ]);
    expect(r.vouchers[0].error).toBe('Đơn tối thiểu chưa đủ'); // lý do thật, không phải "chỉ 1 mã sàn"
    expect(r.discount.amount).toBe('100000');
    expect(r.promotionCode).toBe('PLAT10');
    expect(r.promotionError).toBe('Đơn tối thiểu chưa đủ');
  });

  it('mã bị từ chối KHÔNG chiếm chỗ (shop): mã shop không đủ điều kiện đứng trước, mã khác của cùng shop vẫn được nhận', async () => {
    const f = buildFixture();
    const r = await summary(f, ['SAMIN', 'SA10']);
    expect(r.vouchers.map((v) => [v.code, v.ok])).toEqual([
      ['SAMIN', false],
      ['SA10', true],
    ]);
    expect(r.discount.amount).toBe('50000');
  });

  it('mã đã được nhận vẫn chiếm chỗ: sau mã sàn hợp lệ, mã sàn thứ hai (dù hợp lệ) vẫn bị từ chối', async () => {
    const f = buildFixture();
    const r = await summary(f, ['PLATMIN', 'PLAT10', 'PLAT5']);
    expect(r.vouchers.map((v) => [v.code, v.ok])).toEqual([
      ['PLATMIN', false],
      ['PLAT10', true],
      ['PLAT5', false],
    ]);
    expect(r.vouchers[2].error).toBe('Mỗi đơn chỉ dùng được 1 mã giảm giá của sàn');
  });

  it('giỏ rỗng: không hỏi voucher (không tính gì), totals 0', async () => {
    const f = buildFixture({ lines: [] });
    const r = await summary(f, ['PLAT10']);
    expect(r.vouchers).toEqual([]);
    expect(r.total.amount).toBe('0');
    expect(f.scopeOf).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ placeOrder */

describe('OrderService.placeOrder — consume voucher & ghi đơn', () => {
  const place = (f: ReturnType<typeof buildFixture>, voucherCodes: string[]) => f.service.placeOrder(actor, { address: ADDRESS, paymentMethodCode: 'cod', voucherCodes }, null);
  const orderData = (f: ReturnType<typeof buildFixture>) => f.create.mock.calls.map((c) => c[0]);
  const expectNothingWritten = (f: ReturnType<typeof buildFixture>) => {
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.createGroup).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.initiate).not.toHaveBeenCalled();
    expect(f.cartWrite.removeLines).not.toHaveBeenCalled();
  };

  describe('luồng thành công', () => {
    it('voucher SÀN consume với mã NHÓM (giỏ cả đơn, không shopId); voucher SHOP consume với mã ĐƠN CON của đúng shop (giỏ riêng, có shopId)', async () => {
      const f = buildFixture();
      await place(f, ['PLAT10', 'SA10', 'SB40K']);
      const calls = f.consume.mock.calls;
      expect(calls.map((c) => [c[0], c[2]])).toEqual([
        ['PLAT10', 'DHN261001'],
        ['SA10', 'DH261001'],
        ['SB40K', 'DH261002'],
      ]);
      expect(calls[0][1]).toMatchObject({ userId: USER, subtotal: 1_000_000n, shippingFee: 90_000n });
      expect(calls[0][1].shopId).toBeUndefined();
      expect(calls[0][1].lines).toHaveLength(3);
      expect(calls[1][1]).toMatchObject({ shopId: A, subtotal: 500_000n, shippingFee: 30_000n });
      expect(calls[2][1]).toMatchObject({ shopId: B, subtotal: 300_000n, shippingFee: 30_000n });
      expect(calls.every((c) => c[3] === TX)).toBe(true); // cùng transaction với việc tạo đơn
    });

    it('mã đơn con khớp ĐÚNG đơn tạo cho shop đó (đơn của A mang mã DH261001 …)', async () => {
      const f = buildFixture();
      await place(f, ['SB40K']);
      const orders = orderData(f);
      expect(orders.map((o) => [o.shopId, o.code])).toEqual([[A, 'DH261001'], [B, 'DH261002'], [C, 'DH261003']]);
      expect(f.consume.mock.calls[0][2]).toBe(orders.find((o) => o.shopId === B)?.code);
    });

    it('đơn con ghi shopDiscount / platformDiscount / promotionCode / shopPromotionCode / total đúng', async () => {
      const f = buildFixture();
      await place(f, ['PLAT10', 'SA10', 'SB40K']);
      const [oa, ob, oc] = orderData(f);
      expect(oa).toMatchObject({ shopId: A, subtotal: '500000', shippingFee: '30000', shopDiscount: '50000', platformDiscount: '50000', discount: '100000', promotionCode: 'PLAT10', promotionName: 'Mã PLAT10', shopPromotionCode: 'SA10', shopPromotionName: 'Mã SA10', total: '430000' });
      expect(ob).toMatchObject({ shopId: B, shopDiscount: '40000', platformDiscount: '30000', discount: '70000', promotionCode: 'PLAT10', shopPromotionCode: 'SB40K', total: '260000' });
      expect(oc).toMatchObject({ shopId: C, shopDiscount: '0', platformDiscount: '20000', discount: '20000', promotionCode: 'PLAT10', shopPromotionCode: null, shopPromotionName: null, total: '210000' });
    });

    it('Order group: discount = tổng discount đơn con, total = tổng total đơn con, subtotal/ship khớp', async () => {
      const f = buildFixture();
      await place(f, ['PLAT10', 'SA10', 'SB40K']);
      const group = f.createGroup.mock.calls[0][0];
      const orders = orderData(f);
      const total = (k: 'discount' | 'total' | 'subtotal' | 'shippingFee') => orders.reduce((s, o) => s + BigInt(o[k] as string), 0n);
      expect(group).toMatchObject({ code: 'DHN261001', discount: '190000', total: '900000', subtotal: '1000000', shippingFee: '90000' });
      expect(BigInt(group.discount as string)).toBe(total('discount'));
      expect(BigInt(group.total as string)).toBe(total('total'));
      expect(BigInt(group.subtotal as string)).toBe(total('subtotal'));
      expect(BigInt(group.shippingFee as string)).toBe(total('shippingFee'));
      orders.forEach((o) => expect(BigInt(o.discount as string)).toBe(BigInt(o.shopDiscount as string) + BigInt(o.platformDiscount as string)));
    });

    it('voucher sàn số lẻ: tổng platformDiscount các đơn con ghi xuống DB == đúng số của voucher (100.001)', async () => {
      const f = buildFixture();
      await place(f, ['PLATODD']);
      const orders = orderData(f);
      expect(orders.map((o) => o.platformDiscount)).toEqual(['50000', '30000', '20001']);
      expect(f.createGroup.mock.calls[0][0].discount).toBe('100001');
    });

    it('shop không dùng voucher: shopPromotionCode null, shopDiscount 0; trả về đơn nhóm', async () => {
      const f = buildFixture();
      const out = await place(f, ['SA10']);
      const orders = orderData(f);
      expect(orders[1]).toMatchObject({ shopId: B, shopDiscount: '0', platformDiscount: '0', discount: '0', shopPromotionCode: null, promotionCode: null, total: '330000' });
      expect(orders[0]).toMatchObject({ promotionCode: null, shopPromotionCode: 'SA10' });
      expect(out).toMatchObject({ code: 'DHN261001' });
      expect(f.myOrderGroup).toHaveBeenCalledWith(actor, 'DHN261001');
    });

    it('không voucher: không consume, mọi giảm = 0, tạo đủ N đơn con + giữ kho + khởi tạo thanh toán theo TỪNG đơn với số tiền sau giảm', async () => {
      const f = buildFixture();
      await place(f, []);
      expect(f.consume).not.toHaveBeenCalled();
      expect(orderData(f).every((o) => o.discount === '0' && o.shopDiscount === '0' && o.platformDiscount === '0')).toBe(true);
      expect(f.reserve).toHaveBeenCalledTimes(3);
      expect(f.initiate.mock.calls.map((c) => [c[0].orderCode, c[0].amount])).toEqual([['DH261001', 530_000n], ['DH261002', 330_000n], ['DH261003', 230_000n]]);
    });

    it('thanh toán từng đơn con dùng số tiền SAU giảm (shop + sàn)', async () => {
      const f = buildFixture();
      await place(f, ['PLAT10', 'SA10']);
      expect(f.initiate.mock.calls.map((c) => c[0].amount)).toEqual([430_000n, 300_000n, 210_000n]); // B: 330k − 30k sàn
    });

    it('đơn con bị giảm hết (total 0) ⇒ chặn PROMOTION_INVALID 409, không consume/không tạo đơn (cổng thanh toán không nhận số 0)', async () => {
      const f = buildFixture();
      const err = await place(f, ['PLATBIG', 'SC100']).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BusinessException);
      expect(err as BusinessException).toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID, httpStatus: 409 });
      expectNothingWritten(f);
    });

    it('freeship sàn + freeship shop A: đơn A ghi shopDiscount = phí ship, platformDiscount = 0; đơn khác nhận freeship sàn đủ; tổng khớp group', async () => {
      const f = buildFixture();
      await place(f, ['PLATFS', 'SAFS']);
      const [oa, ob, oc] = orderData(f);
      expect(oa).toMatchObject({ shopId: A, shopDiscount: '30000', platformDiscount: '0', discount: '30000', total: '500000', promotionCode: 'PLATFS', shopPromotionCode: 'SAFS' });
      expect(ob).toMatchObject({ shopDiscount: '0', platformDiscount: '30000', discount: '30000', total: '300000' });
      expect(oc).toMatchObject({ shopDiscount: '0', platformDiscount: '30000', discount: '30000', total: '200000' });
      expect(f.createGroup.mock.calls[0][0]).toMatchObject({ discount: '90000', total: '1000000' });
    });

    it('mã sàn bị từ chối đứng trước KHÔNG chiếm chỗ nhưng vẫn chặn đặt hàng (còn mã lỗi trong danh sách)', async () => {
      const f = buildFixture();
      await expect(place(f, ['PLATMIN', 'PLAT10'])).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID, message: 'PLATMIN: Đơn tối thiểu chưa đủ' });
      expectNothingWritten(f);
    });

    it('cả consume lẫn tạo đơn cùng chạy trong MỘT transaction', async () => {
      const f = buildFixture();
      await place(f, ['PLAT10', 'SA10']);
      expect(f.createGroup.mock.calls[0][1]).toBe(TX);
      expect(f.create.mock.calls.every((c) => c[1] === TX)).toBe(true);
    });
  });

  describe('chống mua chéo: thành viên shop không mua hàng của chính shop mình', () => {
    const SELF_MSG = 'Bạn không thể mua sản phẩm của chính gian hàng mình';

    it('khách là thành viên ACTIVE của một shop có hàng trong giỏ ⇒ SHOP_NOT_AVAILABLE 409, không consume/không tạo đơn', async () => {
      const f = buildFixture({ members: { [B]: ['someone-else', USER] } });
      const err = (await place(f, ['PLAT10']).then(
        () => null,
        (e: unknown) => e,
      )) as BusinessException;
      expect(err).toBeInstanceOf(BusinessException);
      expect(err.errorCode).toBe(ORDER_ERR.SHOP_NOT_AVAILABLE);
      expect(err.httpStatus).toBe(409);
      expect(err.message).toBe(SELF_MSG);
      expectNothingWritten(f);
    });

    it('kiểm theo TỪNG shop trong giỏ (đọc thẳng trong tx): chỉ cần một shop vi phạm là chặn cả đơn', async () => {
      const f = buildFixture({ members: { [C]: [USER] } });
      await expect(place(f, [])).rejects.toMatchObject({ errorCode: ORDER_ERR.SHOP_NOT_AVAILABLE, httpStatus: 409 });
      expect(f.shops.activeMemberUserIds.mock.calls.map((c) => c[0])).toEqual([A, B, C]);
      expectNothingWritten(f);
    });

    it('là thành viên của shop KHÔNG có trong giỏ, hoặc người khác là thành viên ⇒ vẫn đặt được', async () => {
      const f = buildFixture({ members: { [D]: [USER], [A]: ['staff-a'], [B]: ['staff-b'] } });
      await expect(place(f, [])).resolves.toMatchObject({ code: 'DHN261001' });
      expect(f.create).toHaveBeenCalledTimes(3);
    });

    it('chặn mua chéo đứng TRƯỚC kiểm voucher bị từ chối: có cả hai lỗi thì báo mua chéo', async () => {
      const f = buildFixture({ members: { [A]: [USER] } });
      await expect(place(f, ['NOPE'])).rejects.toMatchObject({ errorCode: ORDER_ERR.SHOP_NOT_AVAILABLE, message: SELF_MSG });
    });

    it('ngược lại, đơn bị giảm hết (total 0) được báo trước khi kiểm mua chéo', async () => {
      const f = buildFixture({ members: { [A]: [USER] } });
      await expect(place(f, ['PLATBIG', 'SC100'])).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID, httpStatus: 409 });
    });

    it('checkoutSummary KHÔNG chặn mua chéo (chỉ placeOrder chặn) — không gọi activeMemberUserIds', async () => {
      const f = buildFixture({ members: { [A]: [USER] } });
      await expect(summary(f, [])).resolves.toMatchObject({ total: { amount: '1090000' } });
      expect(f.shops.activeMemberUserIds).not.toHaveBeenCalled();
    });
  });

  /*
   * Gian hàng trong giỏ không còn đặt được (không còn `approved`, hoặc tắt COD khi khách chọn COD): HIỆN TẠI placeOrder chặn CẢ lần checkout bằng 409 — KHÔNG loại riêng dòng của
   * shop đó rồi đặt tiếp các shop còn lại (thiết kế PLAN-0014 ban đầu). Các test dưới đây mô tả ĐÚNG hành vi hiện tại; đổi sang "loại dòng của shop đó" là quyết định của chủ dự án.
   * Thông điệp chỉ nêu TÊN gian hàng (công khai trên web bán hàng) — không lộ trạng thái nội bộ, hoa hồng, cờ COD, mã/ID shop, hay tên người trong shop.
   */
  describe('gian hàng không còn approved / tắt COD ⇒ chặn CẢ lần checkout (409), thông điệp chỉ nêu tên gian hàng', () => {
    const placeAs = (f: ReturnType<typeof buildFixture>, method: string, codes: string[] = []) => f.service.placeOrder(actor, { address: ADDRESS, paymentMethodCode: method, voucherCodes: codes }, null);
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e as BusinessException,
      );
    /* Dữ liệu nội bộ của shop (brief) không được xuất hiện trong thông điệp lỗi trả khách. */
    const expectNoInternals = (message: string) => {
      for (const secret of ['5.00', 'commission', 'hoa hồng', 'suspended', 'rejected', 'pending', 'approved', A, B, C, 'S-b', 'shop-b']) expect(message).not.toContain(secret);
    };

    describe('gian hàng không còn approved', () => {
      it.each(['pending', 'suspended', 'rejected'])('shop B ở trạng thái "%s" ⇒ SHOP_NOT_AVAILABLE 409, nêu tên "Shop B", KHÔNG tạo đơn nào (kể cả đơn của shop A, C còn bình thường)', async (status) => {
        const f = buildFixture({ shops: { [B]: { status } } });

        const err = await failure(placeAs(f, 'payos'));

        expect(err).toBeInstanceOf(BusinessException);
        expect(err).toMatchObject({ errorCode: ORDER_ERR.SHOP_NOT_AVAILABLE, httpStatus: 409 });
        expect(err?.message).toBe('Gian hàng "Shop B" hiện không thể đặt hàng — vui lòng bỏ sản phẩm này khỏi giỏ');
        expectNoInternals(err?.message ?? '');
        expectNothingWritten(f);
        expect(f.nextGroupCode).not.toHaveBeenCalled(); // chặn trước cả khi cấp mã đơn
      });

      it('chặn bất kể phương thức thanh toán (COD, PayOS)', async () => {
        for (const method of ['cod', 'payos']) {
          const f = buildFixture({ shops: { [C]: { status: 'suspended' } } });
          await expect(placeAs(f, method)).rejects.toMatchObject({ errorCode: ORDER_ERR.SHOP_NOT_AVAILABLE, httpStatus: 409 });
          expectNothingWritten(f);
        }
      });

      it('nhiều shop không đặt được ⇒ báo shop ĐẦU TIÊN theo thứ tự trong giỏ (A trước B trước C), không liệt kê các shop còn lại', async () => {
        const f = buildFixture({ shops: { [B]: { status: 'suspended' }, [C]: { status: 'pending' } } });
        const err = await failure(placeAs(f, 'payos'));
        expect(err?.message).toContain('"Shop B"');
        expect(err?.message).not.toContain('Shop C');
        expect(f.shops.findBrief.mock.calls.map((c) => c[0])).toContain(B);
      });

      it('shop không còn tồn tại (findBrief = null) cũng bị chặn 409 (không để lọt đơn)', async () => {
        const f = buildFixture({ shops: { [C]: null } });
        await expect(placeAs(f, 'payos')).rejects.toMatchObject({ errorCode: ORDER_ERR.SHOP_NOT_AVAILABLE, httpStatus: 409 });
        expectNothingWritten(f);
      });

      it('shop approved + COD bật ⇒ đặt bình thường (đối chứng): 3 đơn con', async () => {
        const f = buildFixture();
        await expect(placeAs(f, 'cod')).resolves.toMatchObject({ code: 'DHN261001' });
        expect(f.create).toHaveBeenCalledTimes(3);
      });

      it('shop khoá nhưng KHÔNG có hàng trong giỏ ⇒ không ảnh hưởng (chỉ kiểm shop có trong giỏ)', async () => {
        const f = buildFixture({ shops: { [D]: { status: 'suspended' } } });
        await expect(placeAs(f, 'payos')).resolves.toMatchObject({ code: 'DHN261001' });
      });

      it('kiểm SAU voucher/mua chéo: có mã bị từ chối thì báo mã trước; shop mình là thành viên báo mua chéo trước', async () => {
        await expect(placeAs(buildFixture({ shops: { [B]: { status: 'suspended' } } }), 'payos', ['NOPE'])).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID });
        await expect(placeAs(buildFixture({ shops: { [B]: { status: 'suspended' } }, members: { [A]: [USER] } }), 'payos')).rejects.toMatchObject({ errorCode: ORDER_ERR.SHOP_NOT_AVAILABLE, message: 'Bạn không thể mua sản phẩm của chính gian hàng mình' });
      });

      it('checkoutSummary KHÔNG chặn (chỉ placeOrder chặn): vẫn tính tiền bình thường dù một shop trong giỏ đã bị khoá', async () => {
        const f = buildFixture({ shops: { [B]: { status: 'suspended' } } });
        await expect(summary(f, [])).resolves.toMatchObject({ total: { amount: '1090000' } });
      });
    });

    describe('COD (PLAN-0018: sàn thu hộ COD, không còn cờ COD theo shop)', () => {
      it('khách chọn COD ⇒ đặt được cho mọi shop trong giỏ (không còn chặn theo ví/cờ COD của shop), tạo đủ 3 đơn con', async () => {
        const f = buildFixture();
        await expect(placeAs(f, 'cod')).resolves.toMatchObject({ code: 'DHN261001' });
        expect(f.create).toHaveBeenCalledTimes(3);
      });

      it('hạn mức COD vẫn áp theo từng đơn con', async () => {
        const f = buildFixture();
        f.system.settingNumber.mockResolvedValue(1); // hạn mức COD 1đ ⇒ mọi đơn đều vượt
        await expect(placeAs(f, 'cod')).rejects.toMatchObject({ errorCode: ORDER_ERR.COD_LIMIT });
        expectNothingWritten(f);
      });
    });
  });

  describe('mã bị từ chối ⇒ PROMOTION_INVALID, không tạo đơn, không consume', () => {
    const cases: Array<[string, string[], string, string]> = [
      ['mã không tồn tại', ['NOPE'], 'NOPE', 'Mã không tồn tại hoặc đã hết hạn'],
      ['mã sàn thứ hai', ['PLAT10', 'PLAT5'], 'PLAT5', 'Mỗi đơn chỉ dùng được 1 mã giảm giá của sàn'],
      ['mã thứ hai của cùng shop', ['SA10', 'SA15K'], 'SA15K', 'Mỗi gian hàng chỉ dùng được 1 mã giảm giá của gian hàng'],
      ['mã của shop không có trong giỏ', ['SD1K'], 'SD1K', 'Mã này dành cho gian hàng không có trong giỏ hàng của bạn'],
    ];

    it.each(cases)('%s', async (_name, codes, rejectedCode, message) => {
      const f = buildFixture();
      const err = await place(f, codes).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BusinessException);
      const be = err as BusinessException;
      expect(be.errorCode).toBe(ORDER_ERR.PROMOTION_INVALID);
      expect(be.message).toBe(`${rejectedCode}: ${message}`);
      expectNothingWritten(f);
    });

    it('một mã hợp lệ đứng cạnh một mã bị từ chối ⇒ KHÔNG consume mã hợp lệ (không đốt lượt dùng)', async () => {
      const f = buildFixture();
      await expect(place(f, ['PLAT10', 'SA10', 'NOPE'])).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID });
      expectNothingWritten(f);
    });

    it('mã shop dùng trên giỏ có shop đó nhưng bị cổng từ chối (hết hạn) ⇒ PROMOTION_INVALID kèm lý do của cổng', async () => {
      const f = buildFixture({ vouchers: [...VOUCHERS, { code: 'SBMIN', scope: 'shop', shopId: B, type: 'fixed_amount', value: 10_000, minOrder: 400_000n }] });
      await expect(place(f, ['SBMIN'])).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID, message: 'SBMIN: Đơn tối thiểu chưa đủ' });
      expectNothingWritten(f);
    });
  });

  describe('consume lệch quote', () => {
    it('consume trả discount lệch quote ⇒ BusinessException PROMOTION_INVALID 409, không tạo đơn', async () => {
      const f = buildFixture();
      f.consume.mockImplementationOnce((code, basket) => Promise.resolve({ ...evalVoucher(VOUCHERS, code, basket), discount: evalVoucher(VOUCHERS, code, basket).discount - 1n }));
      const err = (await place(f, ['PLAT10']).then(
        () => null,
        (e: unknown) => e,
      )) as BusinessException;
      expect(err).toBeInstanceOf(BusinessException);
      expect(err.errorCode).toBe(ORDER_ERR.PROMOTION_INVALID);
      expect(err.httpStatus).toBe(409);
      expect(err.message).toContain('PLAT10');
      expect(f.createGroup).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    });

    it('lệch ở voucher SHOP (sau khi voucher sàn đã consume) cũng ném 409 và dừng trước khi tạo đơn', async () => {
      const f = buildFixture();
      f.consume.mockImplementation((code, basket) => {
        const q = evalVoucher(VOUCHERS, code, basket);
        return Promise.resolve(code === 'SA10' ? { ...q, discount: q.discount + 5n } : q);
      });
      await expect(place(f, ['PLAT10', 'SA10'])).rejects.toMatchObject({ errorCode: ORDER_ERR.PROMOTION_INVALID, httpStatus: 409 });
      expect(f.createGroup).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
    });

    it('consume trả ok=false (hết lượt giữa lúc đặt) ⇒ PROMOTION_INVALID 400 kèm lý do, không tạo đơn', async () => {
      const f = buildFixture();
      f.consume.mockImplementationOnce((code) => Promise.resolve({ ...evalVoucher(VOUCHERS, code, { userId: USER, subtotal: 1n, shippingFee: 0n, lines: [] }), ok: false, discount: 0n, error: 'Mã đã hết lượt sử dụng', code }));
      const err = (await place(f, ['PLAT10']).then(
        () => null,
        (e: unknown) => e,
      )) as BusinessException;
      expect(err.errorCode).toBe(ORDER_ERR.PROMOTION_INVALID);
      expect(err.httpStatus).toBe(400);
      expect(err.message).toBe('PLAT10: Mã đã hết lượt sử dụng');
      expect(f.createGroup).not.toHaveBeenCalled();
    });
  });
});

/* ------------------------------------------------------------------ doCancel */

describe('OrderService — huỷ đơn con nhả voucher', () => {
  const GROUP_ID = 'grp-1';
  const GROUP_CODE = 'DHN261001';
  const row = (id: string, code: string, over: Record<string, unknown> = {}): OrderRow => ({ id, code, userId: USER, shopId: A, orderGroupId: GROUP_ID, status: ORDER_STATUS.PENDING, paymentStatus: 'unpaid', items: [{ variantId: `v-${id}`, quantity: 1 }], ...over }) as unknown as OrderRow;
  const doCancel = (f: ReturnType<typeof buildFixture>, o: OrderRow) => f.service['doCancel'](o, 'Khách đổi ý', actor, TX);
  const released = (f: ReturnType<typeof buildFixture>) => f.release.mock.calls.map((c) => c[0]);

  it('huỷ đơn con có voucher shop, còn đơn con khác hoạt động ⇒ release(mã đơn con), KHÔNG release mã nhóm', async () => {
    const f = buildFixture();
    f.groupSiblingInfo.mockResolvedValue({ groupCode: GROUP_CODE, activeOthers: 2 });
    await doCancel(f, row('o1', 'DH261001'));
    expect(released(f)).toEqual(['DH261001']);
    expect(f.release.mock.calls[0][1]).toBe(TX);
    expect(f.groupSiblingInfo).toHaveBeenCalledWith(GROUP_ID, 'o1', TX);
  });

  it('huỷ đơn con CUỐI còn hoạt động của nhóm ⇒ release mã đơn con rồi release thêm mã NHÓM (voucher sàn)', async () => {
    const f = buildFixture();
    f.groupSiblingInfo.mockResolvedValue({ groupCode: GROUP_CODE, activeOthers: 0 });
    await doCancel(f, row('o1', 'DH261001'));
    expect(released(f)).toEqual(['DH261001', GROUP_CODE]);
  });

  it('không tìm thấy nhóm (groupSiblingInfo = null) ⇒ chỉ nhả mã đơn con', async () => {
    const f = buildFixture();
    f.groupSiblingInfo.mockResolvedValue(null);
    await doCancel(f, row('o1', 'DH261001'));
    expect(released(f)).toEqual(['DH261001']);
  });

  it('huỷ lần lượt cả 3 đơn con: mã nhóm chỉ được nhả ĐÚNG MỘT LẦN và chỉ ở đơn con huỷ cuối, bất kể thứ tự huỷ', async () => {
    const f = buildFixture();
    const orders = [row('o1', 'DH261001'), row('o2', 'DH261002'), row('o3', 'DH261003')];
    const status = new Map(orders.map((o) => [o.id, o.status]));
    f.groupSiblingInfo.mockImplementation((_g, excludeId) => Promise.resolve({ groupCode: GROUP_CODE, activeOthers: [...status].filter(([id, s]) => id !== excludeId && s !== ORDER_STATUS.CANCELLED).length }));
    f.update.mockImplementation((id, data) => {
      if (typeof data.status === 'string') status.set(id, data.status);
      return Promise.resolve({} as unknown as OrderRow);
    });
    for (const o of [orders[1], orders[2], orders[0]]) await doCancel(f, o);
    expect(released(f)).toEqual(['DH261002', 'DH261003', 'DH261001', GROUP_CODE]);
    expect(released(f).filter((c) => c === GROUP_CODE)).toHaveLength(1);
    expect(released(f).at(-1)).toBe(GROUP_CODE);
  });

  it('một đơn con đã huỷ từ trước không tính là "còn hoạt động": huỷ đơn con cuối còn lại ⇒ nhả mã nhóm', async () => {
    const f = buildFixture();
    const status = new Map<string, string>([['o1', ORDER_STATUS.PENDING], ['o2', ORDER_STATUS.CANCELLED]]);
    f.groupSiblingInfo.mockImplementation((_g, excludeId) => Promise.resolve({ groupCode: GROUP_CODE, activeOthers: [...status].filter(([id, s]) => id !== excludeId && s !== ORDER_STATUS.CANCELLED).length }));
    await doCancel(f, row('o1', 'DH261001'));
    expect(released(f)).toEqual(['DH261001', GROUP_CODE]);
  });

  it('đơn đã thanh toán: vẫn nhả voucher và yêu cầu hoàn tiền theo total ĐÃ GIẢM của đơn con', async () => {
    const f = buildFixture();
    f.groupSiblingInfo.mockResolvedValue({ groupCode: GROUP_CODE, activeOthers: 0 });
    await doCancel(f, row('o1', 'DH261001', { paymentStatus: 'paid', total: new Prisma.Decimal(430_000) }));
    expect(released(f)).toEqual(['DH261001', GROUP_CODE]);
    expect(f.requestRefund.mock.calls[0][0]).toMatchObject({ orderCode: 'DH261001', amount: 430_000n });
    expect(f.paymentCancel).not.toHaveBeenCalled();
  });

  it('đơn chưa thanh toán: huỷ giao dịch + nhả giữ kho (pending); đơn đã xác nhận: hoàn kho (restock) — voucher vẫn nhả', async () => {
    const f = buildFixture();
    f.groupSiblingInfo.mockResolvedValue({ groupCode: GROUP_CODE, activeOthers: 1 });
    await doCancel(f, row('o1', 'DH261001'));
    expect(f.inventoryRelease).toHaveBeenCalledTimes(1);
    expect(f.paymentCancel).toHaveBeenCalledTimes(1);
    await doCancel(f, row('o2', 'DH261002', { status: ORDER_STATUS.CONFIRMED }));
    expect(f.restock).toHaveBeenCalledTimes(1);
    expect(released(f)).toEqual(['DH261001', 'DH261002']);
  });

  describe('qua cancelByCustomer / cancelByStaff', () => {
    it('khách huỷ đơn pending của mình ⇒ nhả voucher; đơn của người khác ⇒ NotFound, không nhả', async () => {
      const f = buildFixture();
      jest.spyOn(f.service, 'myOrder').mockResolvedValue({ code: 'DH261001' } as never);
      f.groupSiblingInfo.mockResolvedValue({ groupCode: GROUP_CODE, activeOthers: 0 });
      f.findByCodeForUpdate.mockResolvedValueOnce(row('o1', 'DH261001'));
      await f.service.cancelByCustomer(actor, 'DH261001', 'Đổi ý');
      expect(released(f)).toEqual(['DH261001', GROUP_CODE]);

      f.release.mockClear();
      f.findByCodeForUpdate.mockResolvedValueOnce(row('o9', 'DH261009', { userId: 'someone-else' }));
      await expect(f.service.cancelByCustomer(actor, 'DH261009', 'Đổi ý')).rejects.toBeInstanceOf(NotFoundException);
      expect(f.release).not.toHaveBeenCalled();
    });

    it('khách không huỷ được đơn đã xác nhận (CANNOT_CANCEL) ⇒ voucher giữ nguyên, không nhả', async () => {
      const f = buildFixture();
      f.findByCodeForUpdate.mockResolvedValueOnce(row('o1', 'DH261001', { status: ORDER_STATUS.CONFIRMED }));
      await expect(f.service.cancelByCustomer(actor, 'DH261001', 'Đổi ý')).rejects.toMatchObject({ errorCode: ORDER_ERR.CANNOT_CANCEL });
      expect(f.release).not.toHaveBeenCalled();
    });

    it('nhân viên/vendor huỷ đơn confirmed ⇒ restock + nhả voucher đơn con (mã nhóm chỉ khi là đơn cuối)', async () => {
      const f = buildFixture();
      jest.spyOn(f.service, 'getAdmin').mockResolvedValue({ code: 'DH261001' } as never);
      f.groupSiblingInfo.mockResolvedValue({ groupCode: GROUP_CODE, activeOthers: 1 });
      f.findByCodeForUpdate.mockResolvedValueOnce(row('o1', 'DH261001', { status: ORDER_STATUS.CONFIRMED }));
      await f.service.cancelByStaff(actor, 'DH261001', 'Hết hàng');
      expect(f.restock).toHaveBeenCalledTimes(1);
      expect(released(f)).toEqual(['DH261001']);
    });
  });
});
