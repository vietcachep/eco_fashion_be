/* SEED module promotion: 5 mã đủ loại (freeship, %, số tiền, theo ngành hàng, giới hạn lượt). Idempotent theo mã. */
import type { PrismaClient } from '../../src/generated/prisma/client';

const DAY = 86_400_000;
const now = Date.now();

const PROMOS = [
  { code: 'FREESHIP', name: 'Miễn phí vận chuyển', description: 'Đơn từ 300.000₫', type: 'free_shipping', value: '0', minOrderAmount: '300000', usageLimit: null, usageLimitPerUser: 3, appliesTo: 'all', startsAt: now - 30 * DAY, endsAt: now + 180 * DAY, targets: [] as Array<{ targetType: string; targetRef: string }> },
  { code: 'GIAM10', name: 'Giảm 10% toàn bộ', description: 'Tối đa 50.000₫, đơn từ 200.000₫', type: 'percentage', value: '10', maxDiscount: '50000', minOrderAmount: '200000', usageLimit: 1000, usageLimitPerUser: 2, appliesTo: 'all', startsAt: now - 30 * DAY, endsAt: now + 90 * DAY, targets: [] },
  { code: 'DAM100K', name: 'Giảm 100.000₫ cho đầm', description: 'Áp dụng ngành hàng Đầm, đơn từ 500.000₫', type: 'fixed_amount', value: '100000', minOrderAmount: '500000', usageLimit: 200, usageLimitPerUser: 1, appliesTo: 'category', startsAt: now - 7 * DAY, endsAt: now + 60 * DAY, targets: [{ targetType: 'category', targetRef: 'dam' }] },
  { code: 'CHAOBAN', name: 'Chào bạn mới -50.000₫', description: 'Mỗi tài khoản một lần, đơn từ 250.000₫', type: 'fixed_amount', value: '50000', minOrderAmount: '250000', usageLimit: null, usageLimitPerUser: 1, appliesTo: 'all', startsAt: now - 30 * DAY, endsAt: now + 365 * DAY, targets: [] },
  { code: 'HETHAN', name: 'Mã đã hết hạn (demo)', description: 'Để kiểm tra thông báo hết hạn', type: 'percentage', value: '20', minOrderAmount: '0', usageLimit: null, usageLimitPerUser: null, appliesTo: 'all', startsAt: now - 60 * DAY, endsAt: now - 1 * DAY, targets: [] },
];

export async function seed(prisma: PrismaClient): Promise<void> {
  let created = 0;
  for (const p of PROMOS) {
    const exists = await prisma.promotion.findFirst({ where: { code: p.code, isDeleted: false }, select: { id: true } });
    if (exists) continue;
    await prisma.promotion.create({
      data: {
        code: p.code, name: p.name, description: p.description, type: p.type, value: p.value, maxDiscount: (p as { maxDiscount?: string }).maxDiscount ?? null, minOrderAmount: p.minOrderAmount,
        usageLimit: p.usageLimit, usageLimitPerUser: p.usageLimitPerUser, appliesTo: p.appliesTo, startsAt: new Date(p.startsAt), endsAt: new Date(p.endsAt), isActive: true, isPublic: p.code !== 'HETHAN',
        targets: { create: p.targets },
      },
    });
    created += 1;
  }
  console.log(`   mã khuyến mãi: ${PROMOS.length} (tạo mới ${created})`);
}
