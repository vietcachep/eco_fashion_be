import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '@common/prisma/prisma.service';
import { LiveOrderGateway, returnedFromSession } from './live-order.gateway';

describe('Báo cáo và hoàn lượng live', () => {
  const sources = [
    { sessionId: '', quantity: 2 },
    { sessionId: 'live', quantity: 1 },
    { sessionId: '', quantity: 1 },
  ];
  it('trả lượng thường thêm sau không khôi phục quyền live; trả tiếp lượng live mới được tính', () => {
    expect(returnedFromSession(sources, 4, 1, 'live')).toBe(0);
    expect(returnedFromSession(sources, 4, 2, 'live')).toBe(1);
    expect(returnedFromSession(sources, 4, 4, 'live')).toBe(1);
  });
  it.each([
    ['done', false, 250000n, 50000],
    ['pending', true, 250000n, 0],
    ['partial', false, 20000n, 0],
  ] as const)(
    'đơn huỷ đã thu tiền %s ghi khoản hoàn hàng live khi nghĩa vụ hoàn hoàn tất',
    async (_label, pending, done, expected) => {
      const order = {
        code: 'ORDER',
        status: 'cancelled',
        paymentStatus: 'refunded',
        total: '250000',
        subtotal: '300000',
        discount: '50000',
        shopShippingDiscount: '0',
        platformShippingDiscount: '0',
        returns: [],
        items: [
          {
            id: 'line',
            quantity: 3,
            lineTotal: '300000',
            liveSources: [{ sessionId: 'live', quantity: 1 }],
            discountAllocation: { netGoodsAmount: '150000' },
          },
        ],
      };
      const db = { order: { findMany: jest.fn().mockResolvedValue([order]) } };
      const modules = {
        get: jest
          .fn()
          .mockReturnValue({
            liveRefundSettlement: jest
              .fn()
              .mockResolvedValue(
                new Map([['ORDER', { moneyCollected: true, refundPending: pending, refundDone: done }]]),
              ),
          }),
      };
      const report = await new LiveOrderGateway(
        db as unknown as PrismaService,
        modules as unknown as ModuleRef,
      ).report('live');
      expect(report.revenue.amount).toBe('50000');
      expect(report.refunded.amount).toBe(String(expected));
    },
  );
});
