/*
 * CHỌN ẢNH THẬT TỪ PEXELS CHO SẢN PHẨM + GIAN HÀNG  —  `npm run seed:real-images:curate`
 *
 * Với mỗi sản phẩm (`img.query` trong data/dept/*.ts, tiếng Anh) tìm 2 ảnh dọc (a = ảnh chính, b = ảnh phụ); với mỗi gian hàng tìm
 * logo + banner theo từ khoá bên dưới. Kết quả ghi vào `assets/real-images.json` (commit cùng repo) — bước deploy
 * (`npm run seed:real-images`) chỉ đọc file này, không cần khoá Pexels.
 *
 * Cần: EF_PEXELS_API_KEY trong .env (miễn phí tại https://www.pexels.com/api/). Hạn mức Pexels 200 lượt/giờ — công cụ đọc header
 * X-Ratelimit-* và tự chờ khi hết; chạy lại bao nhiêu lần cũng được: khoá đã có trong manifest thì bỏ qua (thêm --force để chọn lại hết).
 * Mỗi ảnh được dùng cho đúng MỘT chỗ (không trùng giữa các sản phẩm) khi tìm đủ ảnh khác nhau.
 *
 * Chất lượng khớp ảnh–sản phẩm phụ thuộc kết quả tìm kiếm của Pexels: nên lướt `assets/real-images.json` (có `page` từng ảnh) và sửa
 * tay `id` của ảnh nào chưa hợp trước khi deploy. Giấy phép Pexels: dùng tự do kể cả thương mại, không bắt buộc ghi công.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import { loadEnv } from '../../../src/config/env';
import { DEPARTMENTS } from '../data/dept';
import { REAL_MANIFEST, type RealImage, type RealManifest } from '../lib/real-images';

/* Từ khoá tiếng Anh cho gian hàng: [logo, banner]. Logo = vật thể gọn, banner = cảnh rộng. */
const SHOP_QUERIES: Record<string, [string, string]> = {
  'fitly-official': ['fashion boutique hanger', 'fashion clothing store interior'],
  'techzone-vn': ['laptop on desk', 'electronics store technology'],
  'mobile-hub': ['smartphone accessories', 'mobile phones display shop'],
  'gia-dung-thong-minh': ['air fryer kitchen appliance', 'modern kitchen appliances'],
  'nha-xinh-decor': ['scandinavian lamp decor', 'scandinavian living room interior'],
  'beauty-box-vn': ['skincare bottles cosmetics', 'makeup cosmetics flatlay'],
  'healthy-life': ['vitamins supplements bottle', 'healthy food fresh vegetables'],
  'sneaker-station': ['sneakers shoes', 'sneaker store shelf'],
  'bag-and-co': ['leather handbag', 'handbags fashion store'],
  'time-lab': ['wrist watch', 'watches collection display'],
  'sport-planet': ['sport equipment gym', 'outdoor camping hiking gear'],
  'baby-land': ['baby toys', 'nursery baby room'],
  'book-cafe': ['stack of books', 'bookstore shelves'],
  'ngon-viet': ['vietnamese food', 'asian market food products'],
  'pet-world': ['dog and cat pet', 'pet shop supplies'],
  'auto-moto-pro': ['motorcycle helmet', 'motorcycle garage'],
  'cua-hang-moi': ['small shop storefront', 'shopping retail store'],
  'hang-nhai-24h': ['online shopping packages', 'warehouse parcels shipping'],
};

interface PexelsPhoto { id: number; url: string; photographer: string; width: number; height: number; alt?: string }

/* Độ khớp ảnh–từ khoá: Pexels trả `alt` (mô tả ảnh) và slug trong URL trang ảnh — đếm số từ khoá xuất hiện ở đó. Ảnh khớp nhiều từ nhất được chọn trước,
   thay vì lấy kết quả đầu tiên một cách máy móc. Điểm 0 = ảnh chỉ "liên quan" theo thuật toán của Pexels, cần người xem lại. */
function relevance(photo: PexelsPhoto, query: string): number {
  const text = `${photo.alt ?? ''} ${photo.url}`.toLowerCase();
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return words.filter((w) => text.includes(w.replace(/s$/, ''))).length;
}
interface Target { key: string; query: string; orientation: 'portrait' | 'landscape' | 'square' }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function buildTargets(): Target[] {
  const out: Target[] = [];
  for (const d of DEPARTMENTS) {
    for (const p of d.products) {
      const q = p.img.query?.trim() || p.name;
      out.push({ key: `product/${p.slug}/a`, query: q, orientation: 'portrait' });
      out.push({ key: `product/${p.slug}/b`, query: q, orientation: 'portrait' });
    }
  }
  for (const [slug, [logo, banner]] of Object.entries(SHOP_QUERIES)) {
    out.push({ key: `shop/${slug}/logo`, query: logo, orientation: 'square' });
    out.push({ key: `shop/${slug}/banner`, query: banner, orientation: 'landscape' });
  }
  return out;
}

class Pexels {
  private remaining = 200;
  constructor(private readonly apiKey: string) {}
  async search(query: string, orientation: string): Promise<PexelsPhoto[]> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (this.remaining <= 1) {
        console.log('  … hết hạn mức giờ này, chờ 60 phút (Ctrl+C rồi chạy lại sau cũng được — tiến độ đã lưu).');
        await sleep(61 * 60 * 1000);
        this.remaining = 200;
      }
      const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=40&orientation=${orientation}`;
      const res = await fetch(url, { headers: { Authorization: this.apiKey }, signal: AbortSignal.timeout(20_000) });
      const left = Number(res.headers.get('x-ratelimit-remaining'));
      if (Number.isFinite(left)) this.remaining = left;
      if (res.status === 429) { this.remaining = 0; continue; }
      if (res.status === 401 || res.status === 403) throw new Error('EF_PEXELS_API_KEY không hợp lệ.');
      if (!res.ok) { await sleep(2000 * (attempt + 1)); continue; }
      return ((await res.json()) as { photos?: PexelsPhoto[] }).photos ?? [];
    }
    return [];
  }
}

function load(): RealManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8')) as RealManifest;
    if (raw && raw.items) return raw;
  } catch { /* chưa có — bình thường */ }
  return { source: 'pexels', license: 'Pexels License — https://www.pexels.com/license/', items: {} };
}

function save(m: RealManifest): void {
  const sorted = Object.fromEntries(Object.entries(m.items).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(REAL_MANIFEST, JSON.stringify({ ...m, items: sorted }, null, 1) + '\n');
}

async function main(): Promise<number> {
  const env = loadEnv();
  if (!env.EF_PEXELS_API_KEY) {
    console.error('Thiếu EF_PEXELS_API_KEY trong .env — lấy khoá miễn phí tại https://www.pexels.com/api/ rồi chạy lại.');
    return 1;
  }
  const force = process.argv.includes('--force');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice(8)) : Infinity;
  const manifest = load();
  if (force) manifest.items = {};
  const used = new Set(Object.values(manifest.items).map((i) => i.id));
  const targets = buildTargets().filter((t) => !manifest.items[t.key]);
  console.log(`Cần chọn ${targets.length} ảnh (đã có ${Object.keys(manifest.items).length}).`);

  const api = new Pexels(env.EF_PEXELS_API_KEY);
  // Cùng một từ khoá + hướng chỉ tìm một lần trong lượt chạy (nhiều sản phẩm dùng chung từ khoá, và a/b của một sản phẩm).
  const cache = new Map<string, PexelsPhoto[]>();
  let done = 0;
  let missing = 0;
  let weak = 0;
  for (const t of targets) {
    if (done >= limit) break;
    const ck = `${t.orientation}|${t.query}`;
    let photos = cache.get(ck);
    if (!photos) {
      photos = await api.search(t.query, t.orientation);
      cache.set(ck, photos);
    }
    // Ưu tiên ảnh khớp từ khoá nhất (và chưa dùng ở sản phẩm khác); cùng điểm thì giữ thứ hạng của Pexels.
    const ranked = photos.map((p, i) => ({ p, i, score: relevance(p, t.query) })).sort((a, b) => b.score - a.score || a.i - b.i);
    const best = ranked.find((r) => !used.has(r.p.id)) ?? ranked[0];
    const pick = best?.p;
    if (best && best.score === 0) weak += 1;
    if (!pick) { missing += 1; console.warn(`  ✗ ${t.key}: không có kết quả cho "${t.query}"`); continue; }
    used.add(pick.id);
    const item: RealImage = { id: pick.id, page: pick.url, photographer: pick.photographer, query: t.query, alt: pick.alt ?? '', match: best.score };
    manifest.items[t.key] = item;
    done += 1;
    if (done % 20 === 0) { save(manifest); console.log(`  … ${done}/${targets.length}`); }
  }
  save(manifest);
  console.log(`Xong: chọn thêm ${done} ảnh, không tìm thấy ${missing}, khớp yếu (match=0, nên xem lại) ${weak}. Tổng trong manifest: ${Object.keys(manifest.items).length}.`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e: unknown) => { console.error(e); process.exit(1); });
