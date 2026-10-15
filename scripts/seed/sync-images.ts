/*
 * ĐỒNG BỘ ẢNH LÊN CLOUDINARY (CHUYÊN DỤNG KHI ĐỔI KEY CLOUDINARY HOẶC SEED LẠI ẢNH)
 *
 * Cách chạy:
 *   npm run seed:images
 *
 * Đặc điểm:
 * - Kiểm tra Cloudinary trước bằng `public_id` cố định `ecofashion/seed/...`:
 *   + Đã có trên Cloudinary của key đó → lấy URL sẵn, KHÔNG upload lại (tiết kiệm quota).
 *   + Chưa có trên Cloudinary → upload lên và lấy `secure_url`.
 * - Cập nhật đồng loạt các URL mới vào PostgreSQL:
 *   + `categories` (ngành hàng)
 *   + `collections` (bộ sưu tập)
 *   + `banners` (banner quảng cáo / trang chủ)
 *   + `product_images` (ảnh sản phẩm, hover, ảnh theo màu)
 * - Idempotent: chạy nhiều lần an toàn tuyệt đối, không tạo trùng dữ liệu.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnv } from '../../src/config/env';
import { PrismaClient } from '../../src/generated/prisma/client';
import { ASSETS_DIR, SeedImages } from './lib/seed-images';
import { CATEGORIES, COLLECTIONS } from './catalog.seed';
import { PRODUCTS } from './product.seed';

const BANNERS = [
  { title: 'Bộ sưu tập mùa này', image: 'catalog/collections/hang-moi.jpg' },
  { title: 'Thời trang nữ', image: 'catalog/collections/nu.jpg' },
  { title: 'Thời trang nam', image: 'catalog/collections/nam.jpg' },
  { title: 'Đầm dự tiệc', image: 'catalog/collections/dam-du-tiec.jpg' },
];

async function main(): Promise<number> {
  const env = loadEnv();
  const images = new SeedImages(env);
  const dbUrl = env.EF_DATABASE_URL.replace('://localhost:', '://127.0.0.1:');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });

  console.log('='.repeat(65));
  console.log(`[ĐỒNG BỘ ẢNH SEED] — Chế độ: ${images.mode}`);
  if (!images.isConfigured) {
    console.log('ℹ️  Chưa cấu hình EF_CLOUDINARY_* — ảnh có trong manifest đóng gói dùng link Cloudinary sẵn có, ảnh còn lại dùng URL tĩnh (/static/seed).');
    console.log('   Muốn đẩy ảnh lên Cloudinary của bạn: điền EF_CLOUDINARY_CLOUD_NAME, EF_CLOUDINARY_API_KEY, EF_CLOUDINARY_API_SECRET và đặt EF_SEED_IMAGE_SOURCE=upload.');
  } else {
    console.log(`☁️  Đang kết nối Cloudinary: ${env.EF_CLOUDINARY_CLOUD_NAME}`);
  }
  console.log('='.repeat(65));

  let dbUpdatedCount = 0;

  try {
    // 1. Ngành hàng (Categories)
    console.log('\n[1/4] Đồng bộ ảnh Ngành hàng (Categories)...');
    for (const c of CATEGORIES) {
      const img = await images.resolve(`catalog/categories/${c.slug}.jpg`);
      const existing = await prisma.category.findFirst({ where: { slug: c.slug, isDeleted: false }, select: { id: true, imageUrl: true, imagePublicId: true } });
      if (existing && (existing.imageUrl !== img.url || existing.imagePublicId !== img.publicId)) {
        await prisma.category.update({ where: { id: existing.id }, data: { imageUrl: img.url, imagePublicId: img.publicId } });
        dbUpdatedCount += 1;
      }
    }
    console.log(`  ✓ Đã kiểm tra ${CATEGORIES.length} ngành hàng.`);

    // 2. Bộ sưu tập (Collections)
    console.log('\n[2/4] Đồng bộ ảnh Bộ sưu tập (Collections)...');
    for (const c of COLLECTIONS) {
      const img = await images.resolve(`catalog/collections/${c.slug}.jpg`);
      const existing = await prisma.collection.findFirst({ where: { slug: c.slug, isDeleted: false }, select: { id: true, imageUrl: true, imagePublicId: true } });
      if (existing && (existing.imageUrl !== img.url || existing.imagePublicId !== img.publicId)) {
        await prisma.collection.update({ where: { id: existing.id }, data: { imageUrl: img.url, imagePublicId: img.publicId } });
        dbUpdatedCount += 1;
      }
    }
    console.log(`  ✓ Đã kiểm tra ${COLLECTIONS.length} bộ sưu tập.`);

    // 3. Banner
    console.log('\n[3/4] Đồng bộ ảnh Banner...');
    for (const b of BANNERS) {
      const img = await images.resolve(b.image);
      const existing = await prisma.banner.findFirst({ where: { title: b.title, isDeleted: false }, select: { id: true, imageUrl: true, imagePublicId: true } });
      if (existing && (existing.imageUrl !== img.url || existing.imagePublicId !== img.publicId)) {
        await prisma.banner.update({ where: { id: existing.id }, data: { imageUrl: img.url, imagePublicId: img.publicId } });
        dbUpdatedCount += 1;
      }
    }
    console.log(`  ✓ Đã kiểm tra ${BANNERS.length} banner.`);

    // 4. Sản phẩm (Products)
    console.log('\n[4/4] Đồng bộ ảnh 24 Sản phẩm (Products)...');
    let totalProductImages = 0;
    for (const p of PRODUCTS) {
      const product = await prisma.product.findFirst({ where: { slug: p.slug, isDeleted: false }, select: { id: true } });
      if (!product) continue;

      const dir = path.join(ASSETS_DIR, 'product', p.slug);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')) : [];
      const order = ['main.jpg', 'hover.jpg', ...files.filter((f) => f.startsWith('mau-')).sort()];
      const existingImages = await prisma.productImage.findMany({
        where: { productId: product.id },
        select: { id: true, url: true, publicId: true, sortOrder: true },
      });
      const existingMap = new Map(existingImages.map((img) => [img.sortOrder, img]));
      const mainColor = p.mau[0];

      for (const [k, f] of order.filter((f) => files.includes(f)).entries()) {
        totalProductImages += 1;
        const img = await images.resolve(`product/${p.slug}/${f}`);
        const current = existingMap.get(k);
        if (current) {
          if (current.url !== img.url || current.publicId !== img.publicId) {
            await prisma.productImage.update({ where: { id: current.id }, data: { url: img.url, publicId: img.publicId } });
            dbUpdatedCount += 1;
          }
        } else {
          const colorCode = f.startsWith('mau-') ? f.slice(4, -4) : f === 'main.jpg' ? mainColor : null;
          await prisma.productImage.create({
            data: {
              productId: product.id,
              url: img.url,
              publicId: img.publicId,
              colorCode: colorCode && p.mau.includes(colorCode) ? colorCode : null,
              alt: p.name,
              sortOrder: k,
              isPrimary: k === 0,
            },
          });
          dbUpdatedCount += 1;
        }
      }
    }
    console.log(`  ✓ Đã kiểm tra ${PRODUCTS.length} sản phẩm (${totalProductImages} ảnh).`);

    // Tổng kết
    console.log('\n' + '='.repeat(65));
    console.log('KẾT QUẢ ĐỒNG BỘ:');
    console.log(`  - Link đóng gói sẵn      : ${images.packagedCount} ảnh (không upload, không gọi mạng)`);
    if (images.isConfigured) {
      console.log(`  - Tải lên mới Cloudinary : ${images.uploadedCount} ảnh`);
      console.log(`  - Đã có sẵn (bỏ qua)     : ${images.reusedCount} ảnh (không tốn thêm dung lượng/băng thông)`);
    }
    console.log(`  - Cập nhật Database      : ${dbUpdatedCount} bản ghi`);
    console.log('='.repeat(65));
    console.log('HOÀN TẤT ĐỒNG BỘ ẢNH THÀNH CÔNG!\n');
    return 0;
  } catch (error) {
    console.error('\n❌ LỖI ĐỒNG BỘ ẢNH:', error);
    return 1;
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
