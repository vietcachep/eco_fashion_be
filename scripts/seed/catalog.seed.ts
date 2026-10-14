/*
 * SEED module catalog: 7 ngành hàng (kèm ảnh), 4 bộ sưu tập (kèm ảnh), 3 thuộc tính màu/size/chất liệu.
 * Idempotent: upsert theo slug/code; ảnh upload Cloudinary với public_id cố định (SeedImages) — chạy lại không tạo trùng.
 * Dữ liệu trùng khớp mock của FE (features/catalog/mock) để nối API không phải đổi màn hình.
 */
import { loadEnv } from '../../src/config/env';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { SeedImages } from './lib/seed-images';

export const CATEGORIES = [
  { slug: 'ao-thun', name: 'Áo thun', description: 'Áo thun cotton, polo, croptop, in hình', sortOrder: 1 },
  { slug: 'ao-so-mi', name: 'Áo sơ mi', description: 'Sơ mi công sở, linen, tay phồng', sortOrder: 2 },
  { slug: 'quan-jean', name: 'Quần jean', description: 'Slim fit, ống đứng, ống rộng, skinny', sortOrder: 3 },
  { slug: 'quan-short', name: 'Quần short', description: 'Short kaki, short jean', sortOrder: 4 },
  { slug: 'vay', name: 'Váy', description: 'Chân váy xếp ly, chân váy jean', sortOrder: 5 },
  { slug: 'dam', name: 'Đầm', description: 'Đầm suông, đầm hoa, đầm dự tiệc', sortOrder: 6 },
  { slug: 'ao-khoac', name: 'Áo khoác', description: 'Bomber, áo dù, blazer', sortOrder: 7 },
];

/* PLAN-0016 — bộ sưu tập theo NGÀNH HÀNG (không theo giới tính) — sàn đa ngành hàng, không phải shop thời
   trang đơn lẻ. Ảnh minh hoạ (gradient + icon, `scripts/seed/assets/catalog/collections/`) tự vẽ bằng
   script Python chạy tay một lần khi thêm — khớp icon của dải ngành hàng trang chủ
   (fashion_frontend_user `department-strip.tsx`) và mega menu Bộ sưu tập. */
export const COLLECTIONS = [
  { slug: 'thoi-trang', name: 'Thời trang', tagline: 'Phong cách mỗi ngày', queryCategorySlug: 'ao-thun', sortOrder: 1 },
  { slug: 'dien-thoai-cong-nghe', name: 'Điện thoại & Công nghệ', tagline: 'Công nghệ trong tầm tay', queryCategorySlug: 'dien-thoai', sortOrder: 2 },
  { slug: 'nha-cua-doi-song', name: 'Nhà cửa & Đời sống', tagline: 'Tiện nghi cho tổ ấm', queryCategorySlug: 'do-dung-nha-bep', sortOrder: 3 },
  { slug: 'sac-dep-suc-khoe', name: 'Sắc đẹp & Sức khoẻ', tagline: 'Chăm sóc bản thân mỗi ngày', queryCategorySlug: 'cham-soc-da', sortOrder: 4 },
];

/* Màu — code dùng làm khoá ảnh (`mau-<code>.jpg`) và mã biến thể. */
export const COLORS = [
  { code: 'den', name: 'Đen', hex: '#1c1c1c' },
  { code: 'trang', name: 'Trắng', hex: '#f5f5f5' },
  { code: 'xam', name: 'Xám', hex: '#9a9a9a' },
  { code: 'be', name: 'Be', hex: '#d9c8a9' },
  { code: 'xanh', name: 'Xanh navy', hex: '#1f2a44' },
  { code: 'hong', name: 'Hồng', hex: '#f1b8c4' },
  { code: 'do', name: 'Đỏ', hex: '#c0392b' },
  { code: 'nau', name: 'Nâu', hex: '#7b5b3a' },
  { code: 'xanhla', name: 'Xanh rêu', hex: '#5c6b3a' },
  { code: 'denim', name: 'Xanh denim', hex: '#5a7fa8' },
];

export const SIZES = [
  ...['XS', 'S', 'M', 'L', 'XL', 'XXL'].map((s, i) => ({ code: s, name: s, groupCode: 'ao', sortOrder: i })),
  ...['26', '27', '28', '29', '30', '31', '32', '33', '34'].map((s, i) => ({ code: s, name: s, groupCode: 'quan', sortOrder: 10 + i })),
];

export const MATERIALS = ['Cotton', 'Cotton pique', 'Cotton spandex', 'Linen', 'Denim', 'Kaki', 'Tuyết mưa', 'Voan', 'Thun lụa', 'Vải dù', 'Đũi'].map((m, i) => ({
  code: m
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-'),
  name: m,
  sortOrder: i,
}));

export async function seed(prisma: PrismaClient): Promise<void> {
  const images = new SeedImages(loadEnv());
  console.log(`   ảnh: ${images.mode}`);

  let created = 0;
  for (const c of CATEGORIES) {
    const img = await images.resolve(`catalog/categories/${c.slug}.jpg`);
    const existing = await prisma.category.findFirst({ where: { slug: c.slug, isDeleted: false }, select: { id: true, imageUrl: true } });
    if (existing) {
      if (existing.imageUrl !== img.url) await prisma.category.update({ where: { id: existing.id }, data: { imageUrl: img.url, imagePublicId: img.publicId } });
      continue;
    }
    await prisma.category.create({ data: { ...c, imageUrl: img.url, imagePublicId: img.publicId, isActive: true } });
    created += 1;
  }
  console.log(`   ngành hàng: ${CATEGORIES.length} (tạo mới ${created})`);

  created = 0;
  for (const c of COLLECTIONS) {
    const img = await images.resolve(`catalog/collections/${c.slug}.jpg`);
    const existing = await prisma.collection.findFirst({ where: { slug: c.slug, isDeleted: false }, select: { id: true, imageUrl: true } });
    if (existing) {
      if (existing.imageUrl !== img.url) await prisma.collection.update({ where: { id: existing.id }, data: { imageUrl: img.url, imagePublicId: img.publicId } });
      continue;
    }
    await prisma.collection.create({ data: { ...c, imageUrl: img.url, imagePublicId: img.publicId, isActive: true } });
    created += 1;
  }
  console.log(`   bộ sưu tập: ${COLLECTIONS.length} (tạo mới ${created})`);

  const attrs: Array<{ code: string; name: string; kind: string; sortOrder: number; values: Array<{ code: string; name: string; hex?: string; groupCode?: string; sortOrder: number }> }> = [
    { code: 'color', name: 'Màu sắc', kind: 'color', sortOrder: 1, values: COLORS.map((c, i) => ({ ...c, sortOrder: i })) },
    { code: 'size', name: 'Kích cỡ', kind: 'size', sortOrder: 2, values: SIZES },
    { code: 'material', name: 'Chất liệu', kind: 'text', sortOrder: 3, values: MATERIALS },
  ];
  let values = 0;
  for (const a of attrs) {
    const attr = await prisma.attribute.upsert({ where: { code: a.code }, create: { code: a.code, name: a.name, kind: a.kind, sortOrder: a.sortOrder, isFilterable: a.kind !== 'text' }, update: { name: a.name, kind: a.kind, isDeleted: false }, select: { id: true } });
    for (const v of a.values) {
      await prisma.attributeValue.upsert({
        where: { attributeId_code: { attributeId: attr.id, code: v.code } },
        create: { attributeId: attr.id, code: v.code, name: v.name, hex: v.hex ?? null, groupCode: v.groupCode ?? null, sortOrder: v.sortOrder },
        update: { name: v.name, hex: v.hex ?? null, groupCode: v.groupCode ?? null, sortOrder: v.sortOrder, isDeleted: false, isActive: true },
      });
      values += 1;
    }
  }
  console.log(`   thuộc tính: ${attrs.length} (${values} giá trị, upsert)`);
}
