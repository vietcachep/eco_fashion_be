import { BusinessException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { OrderService } from '../order/service/order.service';
import { CheckoutIntentRepository } from './checkout-intent.repository';
import { CheckoutIntentService } from './checkout-intent.service';

describe('Checkout unknown giữ một lệnh server', () => {
  afterEach(() => jest.useRealTimers());
  it('không kết luận thất bại khi500; hết lease hỏi lại dùng cùng intent/key, không sinh lần mua mới', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-06T10:00:00Z'));
    const actor = { userId: 'user' } as AuthenticatedActor;
    const attempt = {
      id: 'attempt',
      intentId: 'intent',
      userId: 'user',
      state: 'processing',
      leaseUntil: null as Date | null,
      command: { addressId: 'address', paymentMethodCode: 'cod', expectedTotal: '100000', intentVersion: 0 },
      groupCode: null as string | null,
      errorCode: null,
      message: null,
    };
    const db = {
      checkoutAttempt: {
        findFirst: jest.fn(() => Promise.resolve({ ...attempt })),
        findUniqueOrThrow: jest.fn(() => Promise.resolve({ ...attempt })),
        updateMany: jest.fn(() => {
          if (attempt.state !== 'processing' || (attempt.leaseUntil && attempt.leaseUntil > new Date()))
            return Promise.resolve({ count: 0 });
          attempt.leaseUntil = new Date(Date.now() + 90_000);
          return Promise.resolve({ count: 1 });
        }),
        update: jest.fn((p: { data: Partial<typeof attempt> }) => Promise.resolve(Object.assign(attempt, p.data))),
      },
    };
    const group = { code: 'GROUP' };
    const orders = {
      placeOrder: jest
        .fn<Promise<typeof group>, [unknown, unknown, string]>()
        .mockRejectedValueOnce(
          new BusinessException('TEMPORARY_FAILURE', 'Mất kết nối sau khi gửi lệnh', 503),
        )
        .mockResolvedValueOnce(group),
      myOrderGroup: jest.fn().mockResolvedValue(group),
    };
    const repo = { row: jest.fn() };
    const service = new CheckoutIntentService(
      repo as unknown as CheckoutIntentRepository,
      db as unknown as PrismaService,
      orders as unknown as OrderService,
    );
    expect((await service.read(actor, 'intent', 'attempt')).state).toBe('processing');
    expect((await service.read(actor, 'intent', 'attempt')).state).toBe('processing');
    expect(orders.placeOrder).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(91_000);
    const result = await service.read(actor, 'intent', 'attempt');
    expect(result.state).toBe('succeeded');
    expect(result.groupCode).toBe('GROUP');
    expect(orders.placeOrder).toHaveBeenCalledTimes(2);
    expect(orders.placeOrder.mock.calls[0]).toEqual(orders.placeOrder.mock.calls[1]);
    expect(orders.placeOrder.mock.calls[1][2]).toBe('intent:attempt');
    expect(repo.row).not.toHaveBeenCalled(); // Unknown không mở lại intent hay cho tạo lệnh khác.
  });
});
