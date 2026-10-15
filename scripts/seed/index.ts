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
  { name: 'catalog', describe: '7 ngành hàng thời trang + 4 bộ sưu tập (kèm ảnh) + thuộc tính màu/size/chất liệu', load: () => import('./catalog.seed') },
  { name: 'marketplace', describe: '12 ngành hàng gốc ngoài thời trang (~48 ngành lá) + thuộc tính động + 18 gian hàng (chủ/nhân viên) + ~340 sản phẩm có biến thể/ảnh + tồn kho (PLAN-0016/0017)', load: () => import('./marketplace.seed') },
  { name: 'payment', describe: '2 phương thức thanh toán (cod · payos — payos tự tắt khi chưa có khoá)', load: () => import('./payment.seed') },
  { name: 'promotion', describe: '5 mã khuyến mãi sàn đủ loại (freeship, %, số tiền, theo ngành, hết hạn)', load: () => import('./promotion.seed') },
  { name: 'promotion-marketplace', describe: 'mã giảm giá sàn theo ngành + mã riêng của từng gian hàng (voucher shop)', load: () => import('./promotion-marketplace.seed') },
  { name: 'product', describe: '24 sản phẩm quần áo: biến thể màu×size, ảnh theo màu, phiếu nhập kho đã duyệt', load: () => import('./product.seed') },
  { name: 'order', describe: 'giỏ/wishlist demo + 14 đơn thời trang đủ trạng thái (COD/PayOS, huỷ, đổi trả đã hoàn; COD đã giao = đã thu) + thanh toán + sổ kho', load: () => import('./order.seed') },
  { name: 'activity', describe: '40 khách thêm + ~320 đơn lịch sử nhiều shop/nhiều ngành (voucher sàn+shop, đổi trả, PayOS/COD)', load: () => import('./activity.seed') },
  { name: 'settlement', describe: 'tài khoản ngân hàng shop, các kỳ đối soát (payout) lịch sử gồm cả đơn PayOS lẫn COD', load: () => import('./settlement.seed') },
  { name: 'review', describe: 'đánh giá gắn đơn đã giao (có trả lời shop, 1 ẩn kiểm duyệt) + rating sản phẩm', load: () => import('./review.seed') },
  { name: 'review-marketplace', describe: 'hàng trăm đánh giá theo ngành hàng + trả lời của shop + tính lại rating sản phẩm/shop', load: () => import('./review-marketplace.seed') },
  { name: 'content-marketplace', describe: 'banner theo ngành, FAQ/chính sách người bán, kho tri thức chatbot cho các ngành mới', load: () => import('./content-marketplace.seed') },
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
