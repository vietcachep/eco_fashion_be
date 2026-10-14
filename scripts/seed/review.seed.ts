/*
 * SEED module review: đánh giá thật gắn dòng đơn đã giao (đơn seed DHDEMO*), vài đánh giá có trả lời của shop, một
 * đánh giá bị ẩn (kiểm duyệt) + nhãn AI đề xuất; cập nhật avg_rating/review_count trên product (đếm sẵn, chỉ approved).
 * Idempotent: unique (user_id, order_item_id) — đã có thì bỏ qua. Cần order.seed chạy trước.
 */
import type { PrismaClient } from '../../src/generated/prisma/client';

const TEXTS: Record<number, string[]> = {
  5: [
    'Vải mềm, mặc mát, form chuẩn như mô tả. Giao nhanh hơn dự kiến, đóng gói cẩn thận.',
    'Mua lần 2 rồi, chất lượng ổn định, màu giống hình. Sẽ ủng hộ shop tiếp.',
    'Rất ưng! Size vừa in, đường may đẹp, giá này quá hợp lý.',
  ],
  4: [
    'Đẹp, chất ổn, hơi mỏng một chút so với mình nghĩ nhưng mặc mùa này thì mát.',
    'Form đẹp, màu hơi đậm hơn ảnh xíu. Nhìn chung hài lòng.',
    'Giao hơi lâu (4 ngày) nhưng sản phẩm ok, mặc thoải mái.',
  ],
  3: ['Bình thường, đúng giá tiền. Size hơi rộng, nên chọn nhỏ hơn một size.'],
  2: ['Đường chỉ hơi lỏng ở gấu, mặc được nhưng chưa ưng lắm. Shop nên kiểm hàng kỹ hơn.'],
};

const REPLIES = [
  'Cảm ơn bạn đã tin tưởng FITLY! Hẹn gặp lại bạn ở những đơn hàng sau nhé.',
  'Cảm ơn bạn đã góp ý. Shop đã ghi nhận về khâu kiểm hàng và sẽ hỗ trợ đổi nếu bạn cần — inbox shop bất kỳ lúc nào nhé.',
];

export async function seed(prisma: PrismaClient): Promise<void> {
  const staff = await prisma.user.findFirst({ where: { email: 'sales@ecofashion.vn' }, select: { id: true, fullName: true } });
  const orders = await prisma.order.findMany({ where: { code: { startsWith: 'DHDEMO' }, status: { in: ['delivered', 'completed'] }, isDeleted: false }, orderBy: { createdAt: 'asc' }, include: { items: true } });
  const users = new Map((await prisma.user.findMany({ where: { id: { in: orders.map((o) => o.userId) } }, select: { id: true, fullName: true, avatarUrl: true } })).map((u) => [u.id, u]));
  if (orders.length === 0) throw new Error('Chưa có đơn đã giao — chạy order.seed trước');

  // Điểm cố định theo thứ tự dòng để lần nào seed cũng cho cùng bộ dữ liệu.
  const ratings = [5, 4, 5, 5, 4, 3, 5, 2, 4, 5, 5, 4];
  let i = 0;
  let created = 0;
  const touched = new Set<string>();
  for (const o of orders) {
    for (const item of o.items) {
      if (o.status !== 'completed' && o.code !== 'DHDEMO0006') continue; // đơn delivered chưa completed (DHDEMO0009) để demo "chưa đánh giá"
      const rating = ratings[i % ratings.length];
      const pool = TEXTS[rating];
      const content = pool[i % pool.length];
      i += 1;
      const exists = await prisma.review.findFirst({ where: { userId: o.userId, orderItemId: item.id }, select: { id: true } });
      if (exists) continue;
      const u = users.get(o.userId);
      const hidden = rating === 2; // demo kiểm duyệt: đánh giá 2 sao bị ẩn kèm nhãn AI
      const createdAt = new Date((o.deliveredAt ?? o.createdAt).getTime() + 36 * 3_600_000);
      const r = await prisma.$transaction(async (tx) => {
        const created = await tx.review.create({
          data: {
            productId: item.productId, productSlug: item.slug, productName: item.name, shopId: item.shopId, userId: o.userId, authorName: u?.fullName ?? 'Khách hàng', avatarUrl: u?.avatarUrl ?? null,
            orderCode: o.code, orderItemId: item.id, variantLabel: `${item.color} / ${item.size}`, rating, content, media: [], status: hidden ? 'hidden' : 'approved',
            moderationNote: hidden ? 'Đang xác minh phản ánh lỗi đường may với kho' : null, moderatedBy: hidden ? staff?.id ?? null : null, moderatedAt: hidden ? new Date(createdAt.getTime() + 3_600_000) : null,
            helpfulCount: rating >= 4 ? 3 + (i % 5) : 0, createdAt, updatedAt: createdAt,
          },
        });
        await tx.orderItem.update({ where: { id: item.id }, data: { reviewed: true } });
        if (staff && (rating <= 3 || i % 3 === 0)) await tx.reviewReply.create({ data: { reviewId: created.id, staffUserId: staff.id, staffName: 'Sàn FITLY', authorKind: 'platform', content: rating <= 3 ? REPLIES[1] : REPLIES[0], createdAt: new Date(createdAt.getTime() + 5 * 3_600_000) } });
        if (hidden) await tx.moderationFlag.upsert({ where: { reviewId: created.id }, create: { reviewId: created.id, label: 'ok', score: '0.350', reason: 'Phản ánh chất lượng, không vi phạm — nhân viên tự ẩn để xác minh', model: 'rule' }, update: {} });
        return created;
      });
      touched.add(r.productId);
      created += 1;
    }
  }

  // Đếm sẵn lên product (chỉ approved) — cập nhật mọi sản phẩm có đánh giá.
  const agg = await prisma.review.groupBy({ by: ['productId'], where: { status: 'approved', isDeleted: false }, _avg: { rating: true }, _count: true });
  for (const a of agg) await prisma.product.update({ where: { id: a.productId }, data: { avgRating: Math.round((a._avg.rating ?? 0) * 100) / 100, reviewCount: a._count } });
  console.log(`   đánh giá: tạo mới ${created} (1 ẩn kiểm duyệt, có trả lời shop); cập nhật rating ${agg.length} sản phẩm`);
}
