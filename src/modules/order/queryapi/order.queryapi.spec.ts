import type { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { OrderRepository } from '../order/repository/order.repository';
import { OrderQueryApi } from './order.queryapi';

/*
 * settlementOrders (đối soát chi trả shop): đơn còn yêu cầu đổi trả MỞ phải được GIỮ LẠI (escrow) — requested · approved · escalated · received (khoản hoàn đang chờ payment báo xong).
 * Chỉ refunded/rejected/cancelled/expired mới được thả (PLAN-0022 §3).
 */
describe('OrderQueryApi.settlementOrders — loại đơn có đổi trả mở', () => {
  function build(rows: unknown[] = []) {
    const findMany = jest.fn((_args: unknown): Promise<unknown[]> => Promise.resolve(rows));
    const api = new OrderQueryApi({ order: { findMany } } as unknown as PrismaService, {} as unknown as OrderRepository);
    return { api, findMany };
  }
  const periodEnd = new Date('2026-10-26T00:00:00Z');

  it('where: none{status ∈ requested·approved·escalated·received HOẶC rejected-bởi-shop còn hạn khiếu nại}, chỉ completed + không COD + đã thu + qua hạn đổi trả', async () => {
    const { api, findMany } = build();
    await api.settlementOrders(7, periodEnd);
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.returns).toEqual({ none: { OR: [{ status: { in: ['requested', 'approved', 'escalated', 'received'] } }, { status: 'rejected', rejectedBy: 'shop', escalateDueAt: { gt: expect.any(Date) as unknown } }] } });
    const gt = ((where.returns as { none: { OR: Array<{ escalateDueAt?: { gt: Date } }> } }).none.OR[1].escalateDueAt as { gt: Date }).gt;
    expect(Math.abs(gt.getTime() - Date.now())).toBeLessThan(5_000); // "còn hạn" = escalate_due_at > bây giờ
    expect(where).toMatchObject({ isDeleted: false, status: 'completed', AND:[{OR:[{paymentMethodCode:{not:'cod'}},{collectionMode:'carrier_cod',paymentStatus:{in:['paid','partially_refunded']}}]}], paymentStatus: { in: ['paid', 'partially_refunded'] } });
    const cutoff = new Date(periodEnd.getTime() - 7 * 86_400_000);
    expect(where.OR).toEqual([{ deliveredAt: { lte: cutoff } }, { deliveredAt: null, completedAt: { lte: cutoff } }]);
  });

  it('không loại đơn có yêu cầu đã KẾT THÚC: refunded/cancelled/expired và rejected do SÀN hoặc do shop đã hết hạn khiếu nại không nằm trong tập loại', async () => {
    const { api, findMany } = build();
    await api.settlementOrders(7, periodEnd);
    const none = (findMany.mock.calls[0][0] as { where: { returns: { none: { OR: Array<{ status: string | { in: string[] }; rejectedBy?: string }> } } } }).where.returns.none;
    const inList = (none.OR[0].status as { in: string[] }).in;
    for (const closed of ['refunded', 'rejected', 'cancelled', 'expired']) expect(inList).not.toContain(closed);
    // `rejected` chỉ bị giữ khi do SHOP từ chối (nhánh riêng có điều kiện hạn khiếu nại) — rejected do sàn (quyết định cuối) được thả
    expect(none.OR[1]).toMatchObject({ status: 'rejected', rejectedBy: 'shop' });
  });

  it('map kết quả: settleFrom = ngày giao (hoặc ngày hoàn tất nếu thiếu)', async () => {
    const delivered = new Date('2026-10-01T00:00:00Z');
    const completed = new Date('2026-10-05T00:00:00Z');
    const { api } = build([
      { code: 'DH1', shopId: 's1', total: new Prisma.Decimal(100_000), platformDiscount: new Prisma.Decimal(0), subtotal: new Prisma.Decimal(100_000), shopDiscount: new Prisma.Decimal(0), shopShippingDiscount: new Prisma.Decimal(0), commissionRateSnapshot: new Prisma.Decimal(5), deliveredAt: delivered, completedAt: completed },
      { code: 'DH2', shopId: 's1', total: new Prisma.Decimal(50_000), platformDiscount: new Prisma.Decimal(0), subtotal: new Prisma.Decimal(100_000), shopDiscount: new Prisma.Decimal(0), shopShippingDiscount: new Prisma.Decimal(0), commissionRateSnapshot: new Prisma.Decimal(5), deliveredAt: null, completedAt: completed },
    ]);
    const out = await api.settlementOrders(7, periodEnd);
    expect(out.map((o) => [o.orderCode, o.settleFrom])).toEqual([['DH1', delivered], ['DH2', completed]]);
  });
});
