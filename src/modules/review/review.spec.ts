import { NotFoundException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ReviewService } from './review.service';

type ReviewRow = Parameters<typeof ReviewService.toShop>[0];

/* Test quy tắc THUẦN của review. */
describe('review — che tên khách', () => {
  it('giữ họ, viết tắt phần còn lại', () => {
    expect(ReviewService.maskName('Nguyễn Văn An')).toBe('Nguyễn V. A.');
    expect(ReviewService.maskName('An')).toBe('An');
  });

  it('authorName rơi về EMAIL thì không bao giờ lộ email', () => {
    const masked = ReviewService.maskName('khach.hang@gmail.com');
    expect(masked).toBe('k***');
    expect(masked).not.toContain('@');
    expect(masked).not.toContain('gmail');
  });
});

const NOW = new Date('2026-05-01T08:00:00.000Z');

/* Dòng review "đầy đủ nhạy cảm": mọi trường vendor KHÔNG được thấy đều có giá trị dễ nhận ra. */
function makeRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 'rv-1',
    productId: 'prod-1',
    productSlug: 'ao-thun-basic',
    productName: 'Áo thun basic',
    shopId: 'shop-1',
    userId: 'USER-ID-BI-MAT',
    authorName: 'Nguyễn Văn An',
    avatarUrl: null,
    orderCode: 'ORD-SECRET-001',
    orderItemId: 'item-1',
    variantLabel: 'Đen / M',
    rating: 5,
    content: 'Vải đẹp, form chuẩn',
    media: [
      { type: 'image', url: 'https://cdn/a.jpg', name: 'a.jpg' },
      { type: 'video', url: 'https://cdn/v.mp4', name: 'v.mp4' },
    ],
    status: 'approved',
    moderationNote: 'GHI-CHU-NOI-BO-KIEM-DUYET',
    moderatedBy: 'staff-9',
    moderatedAt: NOW,
    helpfulCount: 3,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    isDeleted: false,
    replies: [{ id: 'rp-1', reviewId: 'rv-1', staffUserId: 'STAFF-USER-ID', staffName: 'Trần Thị Nhân Viên Thật', authorKind: 'platform', content: 'Cảm ơn bạn!', createdAt: NOW, updatedAt: NOW }],
    ...overrides,
  };
}

describe('ReviewService.toShop — response cho vendor (M-2)', () => {
  it('chỉ có trường whitelist: không userId/orderCode/moderationNote/status/staffName/tên đầy đủ', () => {
    const r = ReviewService.toShop(makeRow());

    expect(Object.keys(r).sort()).toEqual(['authorDisplay', 'content', 'createdAt', 'helpfulCount', 'id', 'images', 'productId', 'productName', 'productSlug', 'rating', 'reply', 'variantLabel'].sort());
    const json = JSON.stringify(r);
    for (const secret of ['USER-ID-BI-MAT', 'ORD-SECRET-001', 'GHI-CHU-NOI-BO-KIEM-DUYET', 'STAFF-USER-ID', 'Trần Thị Nhân Viên Thật', 'Nguyễn Văn An', 'staff-9']) {
      expect(json).not.toContain(secret);
    }
  });

  it('tên khách đã che; ảnh chỉ lấy loại image; reply chỉ có nội dung + thời điểm', () => {
    const r = ReviewService.toShop(makeRow());

    expect(r.authorDisplay).toBe('Nguyễn V. A.');
    expect(r.images).toEqual(['https://cdn/a.jpg']);
    expect(r.reply).toEqual({ content: 'Cảm ơn bạn!', createdAt: NOW.toISOString() });
    expect(r).toMatchObject({ id: 'rv-1', productId: 'prod-1', productName: 'Áo thun basic', productSlug: 'ao-thun-basic', rating: 5, helpfulCount: 3, variantLabel: 'Đen / M' });
  });

  it('chưa có trả lời → reply = null; authorName là email → không lộ email', () => {
    const r = ReviewService.toShop(makeRow({ replies: [], authorName: 'khach@gmail.com' }));

    expect(r.reply).toBeNull();
    expect(r.authorDisplay).toBe('k***');
  });

  it('khác ReviewAdminResponse: admin vẫn thấy userId/orderCode/moderationNote (nhân viên sàn cần)', () => {
    const admin = ReviewService.toAdmin(makeRow());

    expect(admin).toMatchObject({ userId: 'USER-ID-BI-MAT', orderCode: 'ORD-SECRET-001', moderationNote: 'GHI-CHU-NOI-BO-KIEM-DUYET' });
  });
});

describe('ReviewService — listShop / replyShop cho vendor', () => {
  const findMany = jest.fn<Promise<ReviewRow[]>, [unknown]>();
  const count = jest.fn<Promise<number>, [unknown]>();
  const findFirst = jest.fn<Promise<{ id: string } | null>, [unknown]>();
  const findUniqueOrThrow = jest.fn<Promise<ReviewRow>, [unknown]>();
  const replyFindFirst = jest.fn<Promise<{ id: string } | null>, [unknown]>();
  const replyCreate = jest.fn<Promise<unknown>, [unknown]>();
  const replyUpdate = jest.fn<Promise<unknown>, [unknown]>();
  const auditCreate = jest.fn<Promise<unknown>, [unknown]>();

  const actor: AuthenticatedActor = { userId: 'staff-user-1', email: 'nv@shop.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-1' };
  const shop = { shopId: 'shop-1', shopName: 'Tiệm Xanh' };
  let service: ReviewService;

  beforeEach(() => {
    jest.resetAllMocks();
    const tx = {
      review: { findUniqueOrThrow },
      reviewReply: { findFirst: replyFindFirst, create: replyCreate, update: replyUpdate },
      reviewAuditLog: { create: auditCreate },
    };
    const prisma = { review: { findMany, count, findFirst }, $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
    service = new ReviewService(prisma, {} as never, {} as never, {} as never, {} as never, {} as never);
    findUniqueOrThrow.mockResolvedValue(makeRow());
    replyCreate.mockResolvedValue({});
    replyUpdate.mockResolvedValue({});
    auditCreate.mockResolvedValue({});
  });

  describe('listShop', () => {
    it('luôn khoá status=approved + shopId + chưa xoá (vendor không thấy ẩn/chờ duyệt)', async () => {
      findMany.mockResolvedValue([makeRow()]);
      count.mockResolvedValue(1);

      await service.listShop('shop-1', 2, 10);

      const where = { isDeleted: false, shopId: 'shop-1', status: 'approved' };
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 10, take: 10 }));
      expect(count).toHaveBeenCalledWith({ where });
    });

    it('trả ShopReviewResponse: không lộ userId/orderCode/moderationNote/staffName/tên đầy đủ', async () => {
      findMany.mockResolvedValue([makeRow()]);
      count.mockResolvedValue(1);

      const page = await service.listShop('shop-1', 1, 10);

      expect(page.content).toHaveLength(1);
      expect(page.totalElements).toBe(1);
      const json = JSON.stringify(page);
      for (const secret of ['USER-ID-BI-MAT', 'ORD-SECRET-001', 'GHI-CHU-NOI-BO-KIEM-DUYET', 'Trần Thị Nhân Viên Thật', 'Nguyễn Văn An']) {
        expect(json).not.toContain(secret);
      }
      expect(page.content[0].authorDisplay).toBe('Nguyễn V. A.');
    });
  });

  describe('replyShop', () => {
    it('chỉ tìm đánh giá approved + chưa xoá của CHÍNH shop; không có → 404, không ghi gì', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.replyShop(actor, shop, 'rv-x', 'Cảm ơn')).rejects.toThrow(NotFoundException);

      expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'rv-x', shopId: 'shop-1', status: 'approved', isDeleted: false } }));
      expect(replyCreate).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('trả lời mới: staffName = TÊN GIAN HÀNG, staffUserId = người trả lời thật (audit); audit REVIEW_REPLIED', async () => {
      findFirst.mockResolvedValue({ id: 'rv-1' });
      replyFindFirst.mockResolvedValue(null);

      await service.replyShop(actor, shop, 'rv-1', '  Cảm ơn bạn  ');

      expect(replyCreate).toHaveBeenCalledWith({ data: { reviewId: 'rv-1', staffUserId: 'staff-user-1', staffName: 'Tiệm Xanh', authorKind: 'shop', content: 'Cảm ơn bạn' } });
      expect(auditCreate.mock.calls[0][0]).toMatchObject({ data: { action: 'REVIEW_REPLIED', actorUserId: 'staff-user-1', entityId: 'rv-1' } });
    });

    it('sửa trả lời cũ: ghi đè staffName bằng tên shop (xoá họ tên thật còn sót)', async () => {
      findFirst.mockResolvedValue({ id: 'rv-1' });
      replyFindFirst.mockResolvedValue({ id: 'rp-1' });

      await service.replyShop(actor, shop, 'rv-1', 'Nội dung mới');

      expect(replyUpdate).toHaveBeenCalledWith({ where: { id: 'rp-1' }, data: { content: 'Nội dung mới', staffUserId: 'staff-user-1', staffName: 'Tiệm Xanh', authorKind: 'shop' } });
      expect(replyCreate).not.toHaveBeenCalled();
    });

    it('response không lộ staffName/staffUserId/userId/orderCode', async () => {
      findFirst.mockResolvedValue({ id: 'rv-1' });
      replyFindFirst.mockResolvedValue(null);

      const r = await service.replyShop(actor, shop, 'rv-1', 'Cảm ơn');

      const json = JSON.stringify(r);
      for (const secret of ['USER-ID-BI-MAT', 'ORD-SECRET-001', 'GHI-CHU-NOI-BO-KIEM-DUYET', 'STAFF-USER-ID', 'Trần Thị Nhân Viên Thật', 'staffName']) {
        expect(json).not.toContain(secret);
      }
      expect(r.reply).toEqual({ content: 'Cảm ơn bạn!', createdAt: NOW.toISOString() });
    });
  });
});

/* Điểm sản phẩm đổi ⇒ phải báo shop tính lại Shop.ratingAvg (trước đây chỉ khi TẠO đánh giá, ẩn/hiện/xoá thì điểm shop không cập nhật). */
describe('ReviewService.moderate — báo shop tính lại điểm', () => {
  it('ẩn đánh giá: setRating cho sản phẩm + phát outbox REVIEW_RATING_CHANGED cùng transaction', async () => {
    const outboxCreate = jest.fn<Promise<unknown>, [{ data: { eventType: string; payload: unknown } }]>().mockResolvedValue({});
    const tx = {
      review: { update: jest.fn().mockResolvedValue(makeRow()), aggregate: jest.fn().mockResolvedValue({ _avg: { rating: 4.5 }, _count: 2 }) },
      reviewAuditLog: { create: jest.fn().mockResolvedValue({}) },
      reviewOutboxEvent: { create: outboxCreate },
    };
    const prisma = { review: { findFirst: jest.fn().mockResolvedValue({ id: 'rv-1', productId: 'prod-1', status: 'approved' }) }, $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
    const stats = { setRating: jest.fn().mockResolvedValue(undefined) };
    const service = new ReviewService(prisma, {} as never, {} as never, {} as never, stats as never, {} as never);
    const actor: AuthenticatedActor = { userId: 'staff-1', email: 's@x.vn', roleCode: 'admin', permissionVersion: 1, tokenId: 'jti' };

    await service.moderate(actor, 'rv-1', 'hidden', 'spam');

    expect(stats.setRating).toHaveBeenCalledWith('prod-1', 4.5, 2, tx);
    expect(outboxCreate).toHaveBeenCalledTimes(1);
    expect(outboxCreate.mock.calls[0][0].data.eventType).toBe('REVIEW_RATING_CHANGED');
    expect(outboxCreate.mock.calls[0][0].data.payload).toEqual({ productId: 'prod-1' });
  });
});

/*
 * Tên đứng dưới phản hồi (công khai): TÍNH từ authorKind, không bao giờ đọc staffName lưu trong DB (dữ liệu cũ còn HỌ TÊN nhân viên).
 *   shop ⇒ tên gian hàng hiện tại; platform ⇒ 'Sàn FITLY'. Người trả lời thật chỉ ở staffUserId + audit.
 */
const REAL_NAME = 'Trần Thị Nhân Viên Thật';
const replyOf = (o: Partial<ReviewRow['replies'][number]> = {}): ReviewRow['replies'][number] => ({ id: 'rp-1', reviewId: 'rv-1', staffUserId: 'STAFF-USER-ID', staffName: REAL_NAME, authorKind: 'platform', content: 'Cảm ơn bạn!', createdAt: NOW, updatedAt: NOW, ...o });

describe('tên đứng dưới phản hồi — không lộ họ tên nhân viên', () => {
  it('replyAuthorName: shop ⇒ tên shop (cắt khoảng trắng); thiếu tên shop ⇒ "Cửa hàng"; platform / giá trị lạ ⇒ "Sàn FITLY"', () => {
    expect(ReviewService.replyAuthorName({ authorKind: 'shop' }, '  Tiệm Xanh ')).toBe('Tiệm Xanh');
    expect(ReviewService.replyAuthorName({ authorKind: 'shop' }, null)).toBe('Cửa hàng');
    expect(ReviewService.replyAuthorName({ authorKind: 'shop' }, '   ')).toBe('Cửa hàng');
    expect(ReviewService.replyAuthorName({ authorKind: 'shop' })).toBe('Cửa hàng');
    expect(ReviewService.replyAuthorName({ authorKind: 'platform' }, 'Tiệm Xanh')).toBe('Sàn FITLY');
    expect(ReviewService.replyAuthorName({ authorKind: '' }, 'Tiệm Xanh')).toBe('Sàn FITLY');
    expect(ReviewService.replyAuthorName({ authorKind: 'staff' }, 'Tiệm Xanh')).toBe('Sàn FITLY');
  });

  it('toPublic: phản hồi của SÀN (kể cả dữ liệu cũ lưu họ tên) hiện "Sàn FITLY", JSON công khai không chứa họ tên', () => {
    const r = ReviewService.toPublic(makeRow({ replies: [replyOf({ authorKind: 'platform', staffName: REAL_NAME })] }), 'Tiệm Xanh');

    expect(r.reply).toEqual({ staffName: 'Sàn FITLY', content: 'Cảm ơn bạn!', createdAt: NOW.toISOString() });
    expect(JSON.stringify(r)).not.toContain(REAL_NAME);
    expect(JSON.stringify(r)).not.toContain('STAFF-USER-ID');
  });

  it('toPublic: phản hồi của SHOP hiện TÊN SHOP hiện tại — không đọc staffName đã lưu (dù là họ tên cũ hay tên shop cũ)', () => {
    const legacy = ReviewService.toPublic(makeRow({ replies: [replyOf({ authorKind: 'shop', staffName: REAL_NAME })] }), 'Tiệm Xanh');
    const renamed = ReviewService.toPublic(makeRow({ replies: [replyOf({ authorKind: 'shop', staffName: 'Tên Shop Cũ' })] }), 'Tên Shop Mới');

    expect(legacy.reply?.staffName).toBe('Tiệm Xanh');
    expect(JSON.stringify(legacy)).not.toContain(REAL_NAME);
    expect(renamed.reply?.staffName).toBe('Tên Shop Mới');
    expect(JSON.stringify(renamed)).not.toContain('Tên Shop Cũ');
  });

  it('toPublic: không có phản hồi ⇒ reply = null', () => {
    expect(ReviewService.toPublic(makeRow({ replies: [] })).reply).toBeNull();
  });

  it('toMine (khách xem đánh giá của mình) cũng không lộ họ tên: platform ⇒ Sàn FITLY, shop ⇒ tên shop', () => {
    const platform = ReviewService.toMine(makeRow({ replies: [replyOf({ authorKind: 'platform' })] }), null, 'Tiệm Xanh');
    const shop = ReviewService.toMine(makeRow({ replies: [replyOf({ authorKind: 'shop' })] }), null, 'Tiệm Xanh');

    expect(platform.reply?.staffName).toBe('Sàn FITLY');
    expect(shop.reply?.staffName).toBe('Tiệm Xanh');
    expect(JSON.stringify([platform, shop])).not.toContain(REAL_NAME);
  });

  it('toAdmin: cùng tên trung tính như công khai (nhân viên sàn thấy đúng cái khách thấy); userId/orderCode vẫn có cho nhân viên', () => {
    const admin = ReviewService.toAdmin(makeRow({ replies: [replyOf({ authorKind: 'platform' })] }));

    expect(admin.reply?.staffName).toBe('Sàn FITLY');
    expect(JSON.stringify(admin)).not.toContain(REAL_NAME);
    expect(admin).toMatchObject({ userId: 'USER-ID-BI-MAT', orderCode: 'ORD-SECRET-001' });
  });
});

describe('ReviewService — phản hồi của nhân viên sàn / vendor ghi authorKind + tên trung tính', () => {
  const findFirst = jest.fn<Promise<unknown>, [unknown]>();
  const findUniqueOrThrow = jest.fn<Promise<ReviewRow>, [unknown]>();
  const replyFindFirst = jest.fn<Promise<{ id: string } | null>, [unknown]>();
  const replyCreate = jest.fn<Promise<unknown>, [unknown]>();
  const replyUpdate = jest.fn<Promise<unknown>, [unknown]>();
  const auditCreate = jest.fn<Promise<unknown>, [unknown]>();
  const findSnapshot = jest.fn<Promise<unknown>, [string]>();
  const findManyBrief = jest.fn<Promise<Map<string, { id: string; name: string }>>, [string[]]>();

  const staffActor: AuthenticatedActor = { userId: 'staff-user-1', email: 'cskh@fitly.vn', roleCode: 'sales', permissionVersion: 1, tokenId: 'jti-1' };
  let service: ReviewService;

  beforeEach(() => {
    jest.resetAllMocks();
    const tx = { review: { findUniqueOrThrow }, reviewReply: { findFirst: replyFindFirst, create: replyCreate, update: replyUpdate }, reviewAuditLog: { create: auditCreate } };
    const prisma = { review: { findFirst }, $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
    service = new ReviewService(prisma, {} as never, {} as never, { findManyBrief } as never, {} as never, { findSnapshot } as never);
    replyCreate.mockResolvedValue({});
    replyUpdate.mockResolvedValue({});
    auditCreate.mockResolvedValue({});
    findFirst.mockResolvedValue({ id: 'rv-1' });
    findSnapshot.mockResolvedValue({ fullName: REAL_NAME });
  });

  it('admin reply MỚI: lưu authorKind=platform + staffName="Sàn FITLY" + staffUserId thật (audit); KHÔNG tra họ tên nhân viên; response không có họ tên', async () => {
    replyFindFirst.mockResolvedValue(null);
    findUniqueOrThrow.mockResolvedValue(makeRow({ replies: [replyOf({ authorKind: 'platform', staffName: 'Sàn FITLY', staffUserId: 'staff-user-1' })] }));

    const r = await service.reply(staffActor, 'rv-1', '  Cảm ơn bạn  ');

    expect(replyCreate).toHaveBeenCalledWith({ data: { reviewId: 'rv-1', content: 'Cảm ơn bạn', staffUserId: 'staff-user-1', staffName: 'Sàn FITLY', authorKind: 'platform' } });
    expect(findSnapshot).not.toHaveBeenCalled();
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ data: { action: 'REVIEW_REPLIED', actorUserId: 'staff-user-1', entityId: 'rv-1' } });
    expect(r.reply?.staffName).toBe('Sàn FITLY');
    expect(JSON.stringify(r)).not.toContain(REAL_NAME);
  });

  it('admin reply SỬA reply cũ (kể cả reply của vendor): ghi đè sang platform + tên sàn, xoá họ tên cũ còn sót ở staffName', async () => {
    replyFindFirst.mockResolvedValue({ id: 'rp-1' });
    findUniqueOrThrow.mockResolvedValue(makeRow({ replies: [replyOf({ authorKind: 'platform', staffName: 'Sàn FITLY' })] }));

    await service.reply(staffActor, 'rv-1', 'Nội dung mới');

    expect(replyUpdate).toHaveBeenCalledWith({ where: { id: 'rp-1' }, data: { content: 'Nội dung mới', staffUserId: 'staff-user-1', staffName: 'Sàn FITLY', authorKind: 'platform' } });
    expect(replyCreate).not.toHaveBeenCalled();
  });

  it('admin reply: đánh giá không tồn tại → 404, không ghi', async () => {
    findFirst.mockResolvedValue(null);

    await expect(service.reply(staffActor, 'rv-x', 'Cảm ơn')).rejects.toThrow(NotFoundException);

    expect(replyCreate).not.toHaveBeenCalled();
  });

  it('vendor reply sau khi sàn đã trả lời: ghi đè sang authorKind=shop + tên shop', async () => {
    replyFindFirst.mockResolvedValue({ id: 'rp-1' });
    findUniqueOrThrow.mockResolvedValue(makeRow({ replies: [replyOf({ authorKind: 'shop', staffName: 'Tiệm Xanh' })] }));

    await service.replyShop(staffActor, { shopId: 'shop-1', shopName: 'Tiệm Xanh' }, 'rv-1', 'Shop xin cảm ơn');

    expect(replyUpdate).toHaveBeenCalledWith({ where: { id: 'rp-1' }, data: { content: 'Shop xin cảm ơn', staffUserId: 'staff-user-1', staffName: 'Tiệm Xanh', authorKind: 'shop' } });
  });
});

describe('ReviewService — đọc công khai/admin/của tôi: tên phản hồi được tính, tra tên shop theo lô', () => {
  const findMany = jest.fn<Promise<ReviewRow[]>, [unknown]>();
  const count = jest.fn<Promise<number>, [unknown]>();
  const groupBy = jest.fn<Promise<unknown[]>, [unknown]>();
  const findFirst = jest.fn<Promise<unknown>, [unknown]>();
  const findProductBriefBySlug = jest.fn<Promise<{ id: string } | null>, [string]>();
  const cardsByIds = jest.fn<Promise<unknown[]>, [string[]]>();
  const findManyBrief = jest.fn<Promise<Map<string, { id: string; name: string }>>, [string[]]>();

  const customer: AuthenticatedActor = { userId: 'USER-ID-BI-MAT', email: 'a@x.vn', roleCode: 'customer', permissionVersion: 1, tokenId: 'jti-9' };
  let service: ReviewService;

  const shopRow = (id: string, shopId: string, kind: string): ReviewRow => makeRow({ id, shopId, replies: [replyOf({ id: `rp-${id}`, reviewId: id, authorKind: kind })] });

  beforeEach(() => {
    jest.resetAllMocks();
    const prisma = { review: { findMany, count, groupBy, findFirst } } as unknown as PrismaService;
    service = new ReviewService(prisma, { findProductBriefBySlug, cardsByIds } as never, {} as never, { findManyBrief } as never, {} as never, {} as never);
    count.mockResolvedValue(3);
    groupBy.mockResolvedValue([]);
    findProductBriefBySlug.mockResolvedValue({ id: 'prod-1' });
    cardsByIds.mockResolvedValue([]);
    findManyBrief.mockResolvedValue(new Map([['shop-1', { id: 'shop-1', name: 'Tiệm Xanh' }]]));
  });

  it('trang sản phẩm công khai: reply của sàn ⇒ "Sàn FITLY", reply của shop ⇒ tên shop, không phản hồi ⇒ null; KHÔNG chuỗi họ tên nào lọt ra', async () => {
    findMany.mockResolvedValue([shopRow('rv-1', 'shop-1', 'platform'), shopRow('rv-2', 'shop-1', 'shop'), makeRow({ id: 'rv-3', replies: [] })]);

    const page = await service.listForProduct('ao-thun-basic', 1, 10);

    expect(page.content.map((r) => r.reply?.staffName ?? null)).toEqual(['Sàn FITLY', 'Tiệm Xanh', null]);
    expect(JSON.stringify(page)).not.toContain(REAL_NAME);
    expect(findManyBrief).toHaveBeenCalledTimes(1);
    expect(findManyBrief).toHaveBeenCalledWith(['shop-1']);
  });

  it('chỉ có phản hồi của sàn ⇒ không tra tên shop (không tốn query); dữ liệu CŨ (họ tên trong staffName) vẫn bị ẩn', async () => {
    findMany.mockResolvedValue([shopRow('rv-1', 'shop-1', 'platform'), shopRow('rv-2', 'shop-1', 'platform')]);

    const page = await service.listForProduct('ao-thun-basic', 1, 10);

    expect(findManyBrief).not.toHaveBeenCalled();
    expect(page.content.every((r) => r.reply?.staffName === 'Sàn FITLY')).toBe(true);
    expect(JSON.stringify(page)).not.toContain(REAL_NAME);
  });

  it('shop không tra được (đã xoá) ⇒ "Cửa hàng", vẫn không lộ gì', async () => {
    findMany.mockResolvedValue([shopRow('rv-1', 'shop-gone', 'shop')]);
    findManyBrief.mockResolvedValue(new Map());

    const page = await service.listForProduct('ao-thun-basic', 1, 10);

    expect(page.content[0].reply?.staffName).toBe('Cửa hàng');
    expect(JSON.stringify(page)).not.toContain(REAL_NAME);
  });

  it('admin list nhiều shop: một lần tra tên theo lô (không N+1), mỗi dòng đúng tên shop của nó', async () => {
    findMany.mockResolvedValue([shopRow('rv-1', 'shop-1', 'shop'), shopRow('rv-2', 'shop-2', 'shop'), shopRow('rv-3', 'shop-1', 'shop'), shopRow('rv-4', 'shop-2', 'platform')]);
    findManyBrief.mockResolvedValue(
      new Map([
        ['shop-1', { id: 'shop-1', name: 'Tiệm Xanh' }],
        ['shop-2', { id: 'shop-2', name: 'Nhà Xinh' }],
      ]),
    );

    const page = await service.listAdmin(1, 10, {});

    expect(page.content.map((r) => r.reply?.staffName)).toEqual(['Tiệm Xanh', 'Nhà Xinh', 'Tiệm Xanh', 'Sàn FITLY']);
    expect(findManyBrief).toHaveBeenCalledTimes(1);
  });

  it('đánh giá của tôi: tên phản hồi được tính như công khai', async () => {
    findMany.mockResolvedValue([shopRow('rv-1', 'shop-1', 'shop'), shopRow('rv-2', 'shop-1', 'platform')]);

    const page = await service.mine(customer, 1, 10);

    expect(page.content.map((r) => r.reply?.staffName)).toEqual(['Tiệm Xanh', 'Sàn FITLY']);
    expect(JSON.stringify(page)).not.toContain(REAL_NAME);
  });
});
