/*
 * ẢNH THẬT THAY ẢNH MẪU — phần dùng chung giữa công cụ chọn ảnh (tools/curate-real-images.ts) và bước áp dụng lúc deploy
 * (apply-real-images.ts).
 *
 * Hai bước tách rời có chủ đích:
 *  1. CHỌN ẢNH (cần EF_PEXELS_API_KEY, chạy MỘT lần trên máy dev): tìm trên Pexels theo từ khoá tiếng Anh của từng sản phẩm/gian hàng
 *     rồi ghi kết quả vào `assets/real-images.json` (commit cùng repo, kèm trang gốc + tác giả để đối chiếu).
 *  2. ÁP DỤNG (KHÔNG cần khoá Pexels, chạy lúc deploy): đọc file đó, nhờ Cloudinary tự tải ảnh từ CDN công khai của Pexels rồi
 *     thay URL ảnh mẫu trong DB. Lúc deploy vì thế không phụ thuộc hạn mức API Pexels (200 lượt/giờ).
 *
 * Quy ước khoá trong manifest: `product/<slug>/a` · `product/<slug>/b` · `shop/<slug>/logo` · `shop/<slug>/banner`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ASSETS_DIR } from './seed-images';

export const REAL_MANIFEST = path.join(ASSETS_DIR, 'real-images.json');
/* public_id Cloudinary của ảnh thật — khác `ecofashion/seed/` của ảnh mẫu để nhận biết ảnh nào đã được thay. */
export const REAL_PREFIX = 'ecofashion/real/';

export interface RealImage {
  /* nguồn ảnh; thiếu = pexels (manifest cũ) */
  provider?: 'pexels' | 'commons' | 'web';
  /* id ảnh trên Pexels (provider pexels) */
  id?: number;
  /* provider 'web' (ảnh tìm bằng Google Images, ghi giấy phép = chưa rõ): ảnh thu nhỏ ĐÓNG GÓI SẴN trong repo, đường dẫn tương đối trong assets/ (vd `web/product/x/a.jpg`).
     Lưu file thay vì URL để deploy không phụ thuộc Google/trang gốc còn sống. */
  file?: string;
  /* URL tải trực tiếp (provider commons: bản thu nhỏ 1000px trên upload.wikimedia.org) */
  src?: string;
  /* giấy phép + tác giả để ghi công khi cần (Commons: CC0 / Public domain / CC BY / CC BY-SA) */
  license?: string;
  author?: string;
  /* trang gốc để đối chiếu giấy phép */
  page: string;
  photographer: string;
  /* từ khoá đã tìm ra ảnh này */
  query: string;
  /* mô tả ảnh do Pexels cung cấp — để người xem lại đối chiếu với tên sản phẩm */
  alt?: string;
  /* số từ khoá khớp trong mô tả; 0 = khớp yếu, cần xem lại */
  match?: number;
}
export interface RealManifest {
  source: string;
  license: string;
  items: Record<string, RealImage>;
}

/* Kích thước cắt theo loại ảnh (cùng tỉ lệ với ảnh mẫu cũ để giao diện không vỡ khung). */
export function cropFor(key: string): { w: number; h: number } {
  if (key.startsWith('banner/')) return { w: 1600, h: 520 };
  if (key.startsWith('collection/')) return { w: 900, h: 600 };
  if (key.startsWith('category/')) return { w: 600, h: 600 };
  if (key.endsWith('/logo')) return { w: 400, h: 400 };
  if (key.endsWith('/banner')) return { w: 1600, h: 533 };
  return { w: 800, h: 1000 };
}

/* URL ảnh trên CDN công khai của Pexels, đã cắt đúng khung — không cần khoá API. */
export function pexelsUrl(id: number, key: string): string {
  const { w, h } = cropFor(key);
  return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&fit=crop&w=${w}&h=${h}`;
}

/* Ảnh hiện tại còn là ảnh MẪU (tự sinh / đóng gói trong seed) ⇒ được phép thay. Ảnh chủ shop tự tải lên hoặc ảnh thật đã áp dụng thì giữ nguyên. */
export function isSampleImage(url: string | null | undefined, publicId?: string | null): boolean {
  if (publicId?.startsWith(REAL_PREFIX) || url?.includes(`/${REAL_PREFIX}`)) return false;
  if (publicId?.startsWith('ecofashion/seed/')) return true;
  return Boolean(url && (url.includes('/static/seed/') || url.includes('/ecofashion/seed/')));
}

export type ParsedKey =
  | { kind: 'product'; slug: string; slot: 'a' | 'b' }
  | { kind: 'shop'; slug: string; slot: 'logo' | 'banner' }
  | { kind: 'category' | 'collection' | 'banner'; slug: string; slot: 'main' };

/* `product/<slug>/a` · `shop/<slug>/logo` · `category/<slug>` · `collection/<slug>` · `banner/<slug>`; trả null nếu khoá không đúng khuôn. */
export function parseKey(key: string): ParsedKey | null {
  const three = /^(product|shop)\/([a-z0-9-]+)\/(a|b|logo|banner)$/.exec(key);
  if (three) {
    if (three[1] === 'product' && (three[3] === 'a' || three[3] === 'b')) return { kind: 'product', slug: three[2], slot: three[3] };
    if (three[1] === 'shop' && (three[3] === 'logo' || three[3] === 'banner')) return { kind: 'shop', slug: three[2], slot: three[3] };
    return null;
  }
  const two = /^(category|collection|banner)\/([a-z0-9-]+)$/.exec(key);
  return two ? { kind: two[1] as 'category' | 'collection' | 'banner', slug: two[2], slot: 'main' } : null;
}

/* URL gốc để tải ảnh của một mục manifest (Commons: `src`; Pexels: CDN đã cắt khung). */
export function imageUrl(item: RealImage, key: string): string {
  if (item.file) throw new Error(`Mục ${key} là ảnh đóng gói sẵn (file) — không có URL`);
  if (item.src) return item.src;
  if (item.id === undefined) throw new Error(`Mục ${key} thiếu cả src lẫn id`);
  return pexelsUrl(item.id, key);
}

/* Ảnh Pexels đã được Pexels cắt đúng khung; ảnh Commons giữ tỉ lệ gốc nên Cloudinary phải cắt (fill, tự nhận chủ thể). */
export function needsCrop(item: RealImage): boolean {
  return Boolean(item.src || item.file);
}

/*
 * Sản phẩm mà ảnh ĐÃ LÀ ẢNH THẬT (chọn tay từ Pexels, liệt kê trong assets/NGUON-ANH.md) — KHÔNG bao giờ bị thay. Cần danh sách riêng vì ảnh thật của
 * nhóm này vẫn được tải lên Cloudinary với public_id `ecofashion/seed/...` (giống ảnh mẫu) nên `isSampleImage` một mình không phân biệt được.
 */
export function alreadyRealProductSlugs(file = path.join(path.dirname(REAL_MANIFEST), 'NGUON-ANH.md')): Set<string> {
  try {
    return new Set([...fs.readFileSync(file, 'utf8').matchAll(/`product\/([a-z0-9-]+)\//g)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}

/*
 * Đường dẫn ảnh (không đuôi) đã là ảnh thật chọn tay trong NGUON-ANH.md, vd `catalog/categories/ao-thun`, `catalog/collections/nu`.
 * Ngành hàng/bộ sưu tập/banner trỏ tới các ảnh này KHÔNG bị thay.
 */
export function alreadyRealAssetPaths(file = path.join(path.dirname(REAL_MANIFEST), 'NGUON-ANH.md')): Set<string> {
  try {
    return new Set([...fs.readFileSync(file, 'utf8').matchAll(/`((?:catalog\/categories|catalog\/collections|banners)\/[a-z0-9-]+)\./g)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}

/* public_id mẫu mà các hàng banner có thể mang cho khoá `banner/<slug>`: ảnh dải banner (`banners/<slug>`) hoặc ảnh bộ sưu tập dùng lại làm banner. */
export function bannerSamplePaths(slug: string): string[] {
  return [`banners/${slug}`, `catalog/collections/${slug}`];
}
