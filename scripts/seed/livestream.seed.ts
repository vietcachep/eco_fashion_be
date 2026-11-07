/* Dữ liệu mẫu chỉ là bản nháp: không tạo phiên đang phát, token, lượt xem hay giao dịch giả. */
import type { PrismaClient } from '../../src/generated/prisma/client';
import { FITLY_OFFICIAL_SHOP_ID } from './lib/seed-shop';

const DRAFT_ID = '00000000-0000-4000-8000-000000004501';

export async function seed(prisma: PrismaClient): Promise<void> {
  const shop = await prisma.shop.findFirst({
    where: { id: FITLY_OFFICIAL_SHOP_ID, status: 'approved', isDeleted: false },
  });
  if (!shop) return;
  await prisma.liveSession.upsert({
    where: { id: DRAFT_ID },
    update: {},
    create: {
      id: DRAFT_ID,
      shopId: shop.id,
      title: 'Khám phá bộ sưu tập cùng FITLY Official',
      description:
        'Bản nháp để chủ shop chuẩn bị nội dung. Cấu hình LiveKit và chọn sản phẩm trước khi phát thật.',
      createdBy: shop.ownerUserId,
    },
  });
}
