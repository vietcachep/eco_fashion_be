import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { LiveVoucherService } from './live-voucher.service';

describe('FITLY_LIVE_V1 — claim, nguồn hàng và hoàn mã', () => {
  const now = new Date('2026-11-06T10:00:00Z');
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });
  afterEach(() => jest.useRealTimers());
  const campaign = {
    id: 'c',
    sessionId: 'live-A',
    shopId: 'shop-A',
    state: 'active',
    redeemUntil: new Date('2026-11-07T10:00:00Z'),
    policyVersion: 'FITLY_LIVE_V1',
  };
  const promo = {
    id: 'p',
    code: 'LIVE',
    name: 'Live',
    liveCampaignId: 'c',
    shopId: null,
    scope: 'platform',
    type: 'fixed_amount',
    value: new Prisma.Decimal(500),
    minOrderAmount: new Prisma.Decimal(0),
    maxDiscount: null,
    usageLimit: 100,
    usedCount: 0,
  };
  function fixture(claimState: string | null = 'available') {
    const db = {
      liveVoucherCampaign: { findUnique: jest.fn().mockResolvedValue(campaign) },
      liveVoucherClaim: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            claimState
              ? { id: 'claim', state: claimState, campaignId: 'c', recoveryEntitlementId: null }
              : null,
          ),
      },
    };
    return { db, service: new LiveVoucherService(db as unknown as PrismaService, {} as ModuleRef) };
  }
  const basket = {
    userId: 'u',
    subtotal: 5000n,
    shippingFee: 1000n,
    shippingByShop: { 'shop-A': 300n, 'shop-B': 700n },
    lines: [
      {
        variantId: 'v',
        productId: 'phone',
        shopId: 'shop-A',
        quantity: 3,
        unitPrice: 1000n,
        lineTotal: 3000n,
        categorySlug: 'phones',
        liveSources: [
          {
            id: 'grant',
            sessionId: 'live-A',
            shopId: 'shop-A',
            productId: 'phone',
            quantity: 1,
            eligibleUntil: '2026-11-07T10:00:00Z',
          },
        ],
      },
      {
        variantId: 'other',
        productId: 'bag',
        shopId: 'shop-B',
        quantity: 2,
        unitPrice: 1000n,
        lineTotal: 2000n,
        categorySlug: 'bags',
      },
    ],
  };
  it('có claim không nâng toàn dòng3 chiếc thành eligible khi chỉ1 chiếc từlive', async () => {
    const r = await fixture().service.prepare(promo, basket);
    expect(r.basket.subtotal).toBe(1000n);
    expect(r.basket.lines[0].quantity).toBe(1);
    expect(r.covered).toHaveLength(1);
    expect(r.weights).toEqual({ 'shop-A': '1000' });
  });
  it('mã freeship sàn live không giảm phí của shopB', async () => {
    const r = await fixture().service.prepare({ ...promo, type: 'free_shipping' }, basket);
    expect(r.basket.shippingFee).toBe(300n);
    expect(r.weights).toEqual({ 'shop-A': '300' });
  });
  it.each([null, 'used', 'pending_refund', 'partial'])(
    'claim %s không được dùng đồng thời ở đơn khác',
    async (state) => {
      expect((await fixture(state).service.prepare(promo, basket)).error).toBeTruthy();
    },
  );
  it('nguồn đã hết hạn vẫn ở giỏ nhưng không có quyền giảm', async () => {
    jest.setSystemTime(new Date('2026-11-07T11:00:00Z'));
    expect((await fixture().service.prepare(promo, basket)).error).toBeTruthy();
  });
  it('receipt recovery khác claim không cấp lại lượng live', async () => {
    const b = {
      ...basket,
      lines: [
        {
          ...basket.lines[0],
          liveSources: [{ ...basket.lines[0].liveSources![0], recoveryEntitlementId: 'not-this-claim' }],
        },
      ],
    };
    expect((await fixture('restored').service.prepare(promo, b)).error).toBeTruthy();
  });
  function reconciliation(complete: boolean, expiry: Date, state = 'active') {
    const tx = {
      liveVoucherUse: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      liveVoucherCampaign: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...campaign, redeemUntil: expiry, state }),
      },
      promotionUsage: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'usage', promotionId: 'promo' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      promotion: { update: jest.fn() },
      liveVoucherClaim: { updateMany: jest.fn() },
      livePromotionAudit: { create: jest.fn() },
    };
    const db = {
      liveVoucherUse: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 'use',
              claimId: 'claim',
              campaignId: 'c',
              promotionUsageId: 'usage',
              orderCode: 'ORDER',
              state: 'active',
              covered: [],
            },
          ]),
        updateMany: jest.fn().mockResolvedValue({count:0}),
      },
      $transaction: jest.fn((f: (t: typeof tx) => Promise<unknown>) => f(tx)),
    };
    const modules = {
      get: jest
        .fn()
        .mockReturnValue({
          coverage: jest.fn().mockResolvedValue({ complete, partial: !complete, pendingRefund: !complete }),
        }),
    };
    return {
      tx,
      db,
      service: new LiveVoucherService(db as unknown as PrismaService, modules as unknown as ModuleRef),
    };
  }
  it('refund chưa done không release mã để tạo đơn thứ hai', async () => {
    const f = reconciliation(false, campaign.redeemUntil);
    await f.service.reconcile();
    expect(f.tx.promotion.update).not.toHaveBeenCalled();
    expect(f.tx.liveVoucherClaim.updateMany).not.toHaveBeenCalled();
    expect(f.db.liveVoucherUse.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({restoredAt:null,state:{in:['active','partial','pending_refund']}}) as unknown}));
  });
  it('hoàn toàn bộ và còn hạn: restore giữ policy, có quyền mua lại và release1lượt', async () => {
    const f = reconciliation(true, campaign.redeemUntil);
    await f.service.reconcile();
    expect(f.tx.liveVoucherClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'restored',
          activeUseId: null,
          recoveryEntitlementId: expect.any(String) as unknown,
        }) as unknown,
      }),
    );
    expect(f.tx.promotion.update).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['expired', new Date('2026-11-06T09:00:00Z'), 'active'],
    ['revoked', campaign.redeemUntil, 'revoked'],
  ] as const)('hoàn mã khi %s không gia hạn hay tạo quyền dùng mới', async (expected, expiry, state) => {
    const f = reconciliation(true, expiry, state);
    await f.service.reconcile();
    expect(f.tx.liveVoucherClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: expected, recoveryEntitlementId: null }) as unknown,
      }),
    );
  });
  it('replay đã thắng restore trước đó không releasequota hai lần', async () => {
    const f = reconciliation(true, campaign.redeemUntil);
    f.tx.liveVoucherUse.updateMany.mockResolvedValue({ count: 0 });
    await f.service.reconcile();
    expect(f.tx.promotion.update).not.toHaveBeenCalled();
    expect(f.tx.liveVoucherClaim.updateMany).not.toHaveBeenCalled();
  });
});
