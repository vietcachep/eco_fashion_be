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
import * as path from 'node:path';
import { ASSETS_DIR } from './seed-images';

export const REAL_MANIFEST = path.join(ASSETS_DIR, 'real-images.json');
/* public_id Cloudinary của ảnh thật — khác `ecofashion/seed/` của ảnh mẫu để nhận biết ảnh nào đã được thay. */
export const REAL_PREFIX = 'ecofashion/real/';

export interface RealImage {
  /* nguồn ảnh; thiếu = pexels (manifest cũ) */
  provider?: 'pexels' | 'commons';
  /* id ảnh trên Pexels (provider pexels) */
  id?: number;
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

/* `product/<slug>/a` → { kind:'product', slug, slot:'a' } ; trả null nếu khoá không đúng khuôn. */
export function parseKey(key: string): { kind: 'product' | 'shop'; slug: string; slot: 'a' | 'b' | 'logo' | 'banner' } | null {
  const m = /^(product|shop)\/([a-z0-9-]+)\/(a|b|logo|banner)$/.exec(key);
  if (!m) return null;
  const kind = m[1] as 'product' | 'shop';
  const slot = m[3] as 'a' | 'b' | 'logo' | 'banner';
  if (kind === 'product' ? slot !== 'a' && slot !== 'b' : slot !== 'logo' && slot !== 'banner') return null;
  return { kind, slug: m[2], slot };
}

/* URL gốc để tải ảnh của một mục manifest (Commons: `src`; Pexels: CDN đã cắt khung). */
export function imageUrl(item: RealImage, key: string): string {
  if (item.src) return item.src;
  if (item.id === undefined) throw new Error(`Mục ${key} thiếu cả src lẫn id`);
  return pexelsUrl(item.id, key);
}

/* Ảnh Pexels đã được Pexels cắt đúng khung; ảnh Commons giữ tỉ lệ gốc nên Cloudinary phải cắt (fill, tự nhận chủ thể). */
export function needsCrop(item: RealImage): boolean {
  return Boolean(item.src);
}
