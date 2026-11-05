import type { PrismaService } from '@common/prisma/prisma.service';
import { OrderRepository } from '../repository/order.repository';
import { OrderService } from './order.service';

/*
 * PLAN-0040 tầng 4 — AUD-12b / OPS-08: CSKH tìm đơn toàn sàn không cần chọn shop; `q` khớp mã đơn con, mã NHÓM `DHN…` và EMAIL khách.
 * Email → userId tra qua IdentityQueryApi (order không join chéo schema); phân trang vẫn ở server.
 */

type Where = { isDeleted?: boolean; shopId?: string; OR?: Array<Record<string, unknown>> };

function build(opts: { emailUser?: { id: string } | null; total?: number } = {}) {
  const findMany = jest.fn((_args: { where: Where; skip: number; take: number }) => Promise.resolve([] as unknown[]));
  const count = jest.fn((_args: { where: Where }) => Promise.resolve(opts.total ?? 0));
  const prisma = { order: { findMany, count } };
  const repo = new OrderRepository(prisma as unknown as PrismaService);
  const findUserBriefByEmail = jest.fn((_email: string) => Promise.resolve(opts.emailUser ?? null));
  const refundSummaries = jest.fn((_codes: string[]) => Promise.resolve(new Map()));
  const service = new OrderService(
    prisma as unknown as PrismaService,
    repo,
    {} as never, // audit
    {} as never, // outbox
    {} as never, // cart
    { findUserBriefByEmail } as never, // identity
    {} as never, // system
    {} as never, // payments
    {} as never, // shops
    {} as never, // inventory
    {} as never, // promotion
    { refundSummaries } as never, // payment
    {} as never, // cartWrite
    {} as never, // notify
    {} as never, // productStats
    {} as never, // users
  );
  const whereOf = () => findMany.mock.calls[0][0].where;
  return { service, repo, findMany, count, findUserBriefByEmail, whereOf };
}

describe('listAdmin — tìm đơn toàn sàn (AUD-12b / OPS-08)', () => {
  it('[OPS-08] q = mã nhóm DHN… ⇒ where có nhánh theo mã nhóm (không phân biệt hoa thường), KHÔNG cần shopId', async () => {
    const f = build();
    await f.service.listAdmin({ q: 'dhn2610010001' }, 1, 20);
    const where = f.whereOf();
    expect(where.shopId).toBeUndefined();
    expect(where.OR).toEqual(expect.arrayContaining([{ orderGroup: { code: { contains: 'DHN2610010001' } } }, { code: { contains: 'DHN2610010001' } }]));
    expect(f.findUserBriefByEmail).not.toHaveBeenCalled(); // không có '@' ⇒ không quét bảng user
  });

  it('[OPS-08] q = email khách ⇒ tra userId qua IdentityQueryApi (email đã trim) và lọc userId IN (…)', async () => {
    const f = build({ emailUser: { id: 'u-1' } });
    await f.service.listAdmin({ q: '  Khach11@EcoFashion.vn ' }, 1, 20);
    expect(f.findUserBriefByEmail).toHaveBeenCalledWith('Khach11@EcoFashion.vn');
    const where = f.whereOf();
    expect(where.OR).toEqual(expect.arrayContaining([{ userId: { in: ['u-1'] } }]));
    // các nhánh cũ (mã đơn, tên, SĐT) vẫn còn — email chỉ THÊM nhánh
    expect(where.OR).toEqual(expect.arrayContaining([{ recipientPhone: { contains: 'Khach11@EcoFashion.vn' } }]));
  });

  it('email không có tài khoản ⇒ không thêm nhánh userId, không lỗi; trả trang rỗng', async () => {
    const f = build({ emailUser: null });
    const page = await f.service.listAdmin({ q: 'ai-do@x.vn' }, 1, 20);
    expect(f.whereOf().OR?.some((c) => 'userId' in c)).toBe(false);
    expect(page.content).toEqual([]);
    expect(page.totalElements).toBe(0);
  });

  it('q là mã đơn con / SĐT / tên (không có @) ⇒ hành vi cũ không đổi, không gọi identity', async () => {
    const f = build();
    await f.service.listAdmin({ q: 'dh2610010001' }, 1, 20);
    expect(f.findUserBriefByEmail).not.toHaveBeenCalled();
    expect(f.whereOf().OR).toEqual(expect.arrayContaining([{ code: { contains: 'DH2610010001' } }, { recipientName: { contains: 'dh2610010001', mode: 'insensitive' } }, { recipientPhone: { contains: 'dh2610010001' } }]));
  });

  it('không có q (hoặc toàn khoảng trắng) ⇒ không có điều kiện OR nào; shopId tuỳ chọn (có thì lọc, không có thì toàn sàn)', async () => {
    const all = build();
    await all.service.listAdmin({}, 1, 20);
    expect(all.whereOf().OR).toBeUndefined();
    expect(all.whereOf().shopId).toBeUndefined();
    const blank = build();
    await blank.service.listAdmin({ q: '   ' }, 1, 20);
    expect(blank.whereOf().OR).toBeUndefined();
    const byShop = build();
    await byShop.service.listAdmin({ shopId: 'shop-1', q: 'DHN2610010001' }, 1, 20);
    expect(byShop.whereOf().shopId).toBe('shop-1');
  });

  it('vẫn phân trang ở server: skip/take theo page+size, total lấy từ count', async () => {
    const f = build({ total: 57 });
    const page = await f.service.listAdmin({ q: 'DHN2610010001' }, 3, 20);
    expect(f.findMany.mock.calls[0][0]).toMatchObject({ skip: 40, take: 20 });
    expect(page.totalElements).toBe(57);
    expect(f.count).toHaveBeenCalledTimes(1);
  });

  it('[SEC] repo.list mặc định (đường của SHOP / khách) KHÔNG khớp mã nhóm hay email — chỉ admin bật qua listAdmin', async () => {
    const f = build();
    await f.repo.list({ shopId: 'shop-1', q: 'DHN2610010001' }, 0, 20);
    const where = f.whereOf();
    expect(where.shopId).toBe('shop-1');
    expect(where.OR?.some((c) => 'orderGroup' in c || 'userId' in c)).toBe(false);
  });
});
