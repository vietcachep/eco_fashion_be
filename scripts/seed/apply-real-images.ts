/*
 * THAY ẢNH MẪU BẰNG ẢNH THẬT TRONG DB  —  `npm run seed:real-images`  (chạy tự động lúc deploy, xem deploy/docker-compose.prod.yml)
 *
 * Đọc `assets/real-images.json` (do `npm run seed:real-images:curate` tạo), nhờ Cloudinary tự tải từng ảnh từ CDN công khai của Pexels
 * (public_id `ecofashion/real/...`) rồi đổi URL ảnh sản phẩm (ProductImage, thứ tự 0/1) và logo/banner gian hàng.
 *
 * An toàn khi chạy lặp / trên dữ liệu thật:
 *  - CHỈ thay ảnh còn là ảnh MẪU (isSampleImage). Ảnh chủ shop tự tải lên, hoặc ảnh thật đã áp dụng, giữ nguyên (--force để áp lại ảnh thật).
 *  - Upload thành công mới ghi DB; một ảnh lỗi không dừng cả mẻ. Mặc định luôn thoát mã 0 để KHÔNG làm hỏng deploy (--strict để lỗi thì thoát 1).
 *  - Thiếu EF_CLOUDINARY_* hoặc chưa có manifest ⇒ bỏ qua, ghi rõ lý do.
 *  - `--dry-run`: chỉ liệt kê việc sẽ làm, không upload, không ghi DB.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnv } from '../../src/config/env';
import { PrismaClient } from '../../src/generated/prisma/client';
import { REAL_MANIFEST, REAL_PREFIX, cropFor, imageUrl, isSampleImage, needsCrop, parseKey, type RealManifest } from './lib/real-images';

/* Wikimedia yêu cầu User-Agent mô tả rõ ứng dụng; tải về bằng fetch riêng rồi upload buffer (không nhờ Cloudinary tải để tránh bị chặn). */
const UA = 'FitlySeedImageApplier/1.0 (student project; seed script)';
async function download(url: string): Promise<Buffer> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error('tải ảnh lỗi sau 3 lần');
}

const CONCURRENCY = 4;

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main(): Promise<number> {
  const strict = process.argv.includes('--strict');
  const force = process.argv.includes('--force');
  const dry = process.argv.includes('--dry-run');
  const env = loadEnv();

  if (!fs.existsSync(REAL_MANIFEST)) {
    console.log('[ảnh thật] Chưa có assets/real-images.json (chạy `npm run seed:real-images:curate` trước) — bỏ qua.');
    return 0;
  }
  const manifest = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8')) as RealManifest;
  const keys = Object.keys(manifest.items);
  const cloudOk = Boolean(env.EF_CLOUDINARY_CLOUD_NAME && env.EF_CLOUDINARY_API_KEY && env.EF_CLOUDINARY_API_SECRET);
  if (!cloudOk && !dry) {
    console.log('[ảnh thật] Thiếu EF_CLOUDINARY_* — không có chỗ lưu ảnh, bỏ qua (ảnh mẫu giữ nguyên).');
    return 0;
  }
  if (cloudOk) cloudinary.config({ cloud_name: env.EF_CLOUDINARY_CLOUD_NAME, api_key: env.EF_CLOUDINARY_API_KEY, api_secret: env.EF_CLOUDINARY_API_SECRET, secure: true });

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.EF_DATABASE_URL.replace('://localhost:', '://127.0.0.1:') }) });
  let replaced = 0, kept = 0, missing = 0, failed = 0;
  try {
    console.log(`[ảnh thật] ${keys.length} ảnh trong manifest${dry ? ' (dry-run)' : ''}…`);
    await pool(keys, CONCURRENCY, async (key) => {
      const parsed = parseKey(key);
      if (!parsed) { failed += 1; console.warn(`  ✗ khoá không hợp lệ: ${key}`); return; }
      const real = manifest.items[key];
      try {
        // 1. Tìm bản ghi cần thay và kiểm tra còn là ảnh mẫu.
        let target: { kind: 'img'; id: string } | { kind: 'shop'; id: string; field: 'logoUrl' | 'bannerUrl' } | null = null;
        if (parsed.kind === 'product') {
          const product = await prisma.product.findFirst({ where: { slug: parsed.slug, isDeleted: false }, select: { id: true } });
          const img = product && (await prisma.productImage.findFirst({ where: { productId: product.id, sortOrder: parsed.slot === 'a' ? 0 : 1 }, select: { id: true, url: true, publicId: true } }));
          if (!img) { missing += 1; return; }
          if (!force && !isSampleImage(img.url, img.publicId)) { kept += 1; return; }
          target = { kind: 'img', id: img.id };
        } else {
          const field = parsed.slot === 'logo' ? 'logoUrl' : 'bannerUrl';
          const shop = await prisma.shop.findFirst({ where: { slug: parsed.slug, isDeleted: false }, select: { id: true, logoUrl: true, bannerUrl: true } });
          if (!shop) { missing += 1; return; }
          if (!force && !isSampleImage(shop[field])) { kept += 1; return; }
          target = { kind: 'shop', id: shop.id, field };
        }
        if (dry) { replaced += 1; console.log(`  → ${key}  ←  ${real.page}`); return; }
        // 2. Pexels: Cloudinary tự tải từ CDN (đã cắt khung). Commons: tải bằng User-Agent riêng, upload buffer và cắt đúng khung.
        const publicId = `${REAL_PREFIX}${key}`;
        const url = imageUrl(real, key);
        const opts = { public_id: publicId, overwrite: true, resource_type: 'image' as const };
        const up = needsCrop(real)
          ? await new Promise<{ secure_url: string }>((resolve, reject) => {
              const { w, h } = cropFor(key);
              const stream = cloudinary.uploader.upload_stream({ ...opts, transformation: [{ width: w, height: h, crop: 'fill', gravity: 'auto' }] }, (err, r) => (err || !r ? reject(new Error(err?.message ?? 'upload lỗi')) : resolve(r)));
              download(url).then((buf) => stream.end(buf), (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
            })
          : await cloudinary.uploader.upload(url, opts);
        // 3. Ghi DB sau khi upload thành công.
        if (target.kind === 'img') await prisma.productImage.update({ where: { id: target.id }, data: { url: up.secure_url, publicId } });
        else await prisma.shop.update({ where: { id: target.id }, data: { [target.field]: up.secure_url } });
        replaced += 1;
      } catch (e) {
        failed += 1;
        console.warn(`  ✗ ${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  } finally {
    await prisma.$disconnect();
  }
  console.log(`[ảnh thật] ${dry ? 'sẽ thay' : 'đã thay'} ${replaced} · giữ nguyên ${kept} (không phải ảnh mẫu) · không thấy bản ghi ${missing} · lỗi ${failed}`);
  return strict && failed > 0 ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e: unknown) => { console.error(e); process.exit(process.argv.includes('--strict') ? 1 : 0); });
