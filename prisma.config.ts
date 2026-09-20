import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/*
 * Cấu hình Prisma CLI (generate / migrate / studio). Schema là THƯ MỤC prisma/schema: mỗi module một file
 * `<module>.prisma` (module sở hữu file của mình), `base.prisma` giữ generator + datasource.
 * URL lấy từ EF_DATABASE_URL (cùng biến với app; `dotenv/config` nạp .env vì Prisma CLI không tự đọc).
 * `prisma generate` chạy lúc `npm ci` (postinstall) — khi đó chưa có DB nên URL được phép trống: chỉ migrate cần.
 */
export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.EF_DATABASE_URL ?? 'postgresql://ecofashion:ecofashion@localhost:5434/ecofashion',
  },
});
