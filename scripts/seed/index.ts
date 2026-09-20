/*
 * SEED DEMO TOÀN SÀN — dựng đủ dữ liệu mẫu theo thứ tự phụ thuộc, IDEMPOTENT (chạy lần 2 không tạo trùng,
 * không lỗi). Service `seed` của docker-compose gọi `seed:admin` rồi `seed` → máy khác `docker compose up`
 * là có đúng bộ dữ liệu như máy gốc (AGENTS.md — Seed Rule: MỖI MODULE PHẢI CÓ SEED).
 * Từ chối chạy khi NODE_ENV=production trừ khi --force (mật khẩu demo nằm trong mã nguồn).
 * Mỗi bước là `scripts/seed/<module>.seed.ts` export `seed(prisma): Promise<void>`; thêm module = thêm dòng vào STEPS.
 */
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnv } from '../../src/config/env';
import { PrismaClient } from '../../src/generated/prisma/client';

export type SeedFn = (prisma: PrismaClient) => Promise<void>;

interface SeedStep {
  name: string;
  describe: string;
  load: () => Promise<{ seed: SeedFn }>;
}

const STEPS: SeedStep[] = [
  { name: 'identity', describe: 'nhân viên mỗi vai + 5 khách demo + địa chỉ (vai/quyền do perms:sync, admin do seed:admin)', load: () => import('./identity.seed') },
  { name: 'system', describe: 'tham số vận hành, 63 tỉnh/thành + phí ship, banner, FAQ, trang chính sách, tin nhắn liên hệ', load: () => import('./system.seed') },
  { name: 'catalog', describe: '7 ngành hàng + 4 bộ sưu tập (kèm ảnh) + thuộc tính màu/size/chất liệu', load: () => import('./catalog.seed') },
  { name: 'payment', describe: '3 phương thức thanh toán (cod · bank_transfer · vnpay)', load: () => import('./payment.seed') },
  { name: 'promotion', describe: '5 mã khuyến mãi đủ loại (freeship, %, số tiền, theo ngành, hết hạn)', load: () => import('./promotion.seed') },
  { name: 'product', describe: '24 sản phẩm quần áo: biến thể màu×size, ảnh theo màu, phiếu nhập kho đã duyệt', load: () => import('./product.seed') },
  { name: 'order', describe: 'giỏ/wishlist demo + 14 đơn đủ trạng thái (COD/CK/VNPay, huỷ, đổi trả đã hoàn) + thanh toán + sổ kho', load: () => import('./order.seed') },
  { name: 'review', describe: 'đánh giá gắn đơn đã giao (có trả lời shop, 1 ẩn kiểm duyệt) + rating sản phẩm', load: () => import('./review.seed') },
  { name: 'ai', describe: 'kho tri thức chatbot (chính sách/FAQ/size/bảo quản), phiên chat mẫu, yêu cầu hỗ trợ, lượt xem', load: () => import('./ai.seed') },
];

async function main(): Promise<number> {
  const env = loadEnv();
  const force = process.argv.includes('--force');
  if (env.NODE_ENV === 'production' && !force) {
    console.error('DỪNG: NODE_ENV=production — seed demo tạo tài khoản mật khẩu cố định. Chắc chắn thì thêm --force.');
    return 2;
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.EF_DATABASE_URL }) });
  try {
    console.log(`SEED DEMO — ${STEPS.length} bước, DB ${env.EF_DATABASE_URL.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')}`);
    for (const [i, step] of STEPS.entries()) {
      const t0 = Date.now();
      console.log(`\n[${i + 1}/${STEPS.length}] ${step.name} — ${step.describe}`);
      const mod = await step.load();
      await mod.seed(prisma);
      console.log(`-- ${step.name} xong sau ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    console.log('\nXONG.');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
