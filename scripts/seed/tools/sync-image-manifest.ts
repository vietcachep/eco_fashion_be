/*
 * ĐÓNG GÓI LINK ẢNH CLOUDINARY CHO SEED  —  `npm run seed:manifest`
 *
 * Upload (hoặc tái dùng nếu đã có) MỌI ảnh trong `scripts/seed/assets/` lên Cloudinary của máy này rồi ghi link vào
 * `assets/.cloudinary-manifest.json` (commit cùng repo). Máy khác chạy `npm run seed` sẽ dùng thẳng các link công khai này — không cần
 * khoá Cloudinary, không cần upload lại, kể cả khi máy đó dùng tài khoản Cloudinary khác (xem lib/seed-images.ts).
 *
 * Khi nào chạy: sau khi thêm/đổi ảnh trong `assets/` (hoặc muốn đổi sang tài khoản Cloudinary của mình: manifest cũ của tài khoản khác sẽ bị
 * THAY bằng link của tài khoản này). Cần đủ EF_CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET trong .env. Không đụng database.
 * Idempotent: ảnh đã có trên Cloudinary (public_id cố định `ecofashion/seed/...`) và file không đổi thì không upload lại.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnv } from '../../../src/config/env';
import { ASSETS_DIR, SeedImages } from '../lib/seed-images';

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const CONCURRENCY = 6;

function listAssets(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listAssets(p, base));
    else if (IMAGE_EXT.test(e.name)) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

async function main(): Promise<number> {
  const env = loadEnv();
  const images = new SeedImages(env, { repackage: true });
  if (!images.isConfigured) {
    console.error('Thiếu khoá Cloudinary — điền EF_CLOUDINARY_CLOUD_NAME, EF_CLOUDINARY_API_KEY, EF_CLOUDINARY_API_SECRET trong .env rồi chạy lại.');
    return 1;
  }
  const files = listAssets(ASSETS_DIR);
  console.log(`Đóng gói ${files.length} ảnh lên Cloudinary "${env.EF_CLOUDINARY_CLOUD_NAME}" …`);

  let next = 0;
  let done = 0;
  const failed: string[] = [];
  async function worker(): Promise<void> {
    while (next < files.length) {
      const rel = files[next++];
      try {
        await images.resolve(rel);
      } catch (e) {
        failed.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
      }
      done += 1;
      if (done % 100 === 0) console.log(`  … ${done}/${files.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const pruned = failed.length === 0 ? images.prune(new Set(files)) : 0;
  images.saveManifest();
  console.log(`Xong: upload mới ${images.uploadedCount}, đã có sẵn trên Cloudinary ${images.reusedCount}, bỏ khỏi manifest ${pruned}, lỗi ${failed.length}.`);
  for (const f of failed.slice(0, 20)) console.error('  ✗', f);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
