/*
 * CHỌN ẢNH THẬT CHO SẢN PHẨM + GIAN HÀNG  —  `npm run seed:real-images:curate`
 *
 * Với mỗi sản phẩm (`img.query` trong data/dept/*.ts, tiếng Anh) tìm 2 ảnh (a = ảnh chính, b = ảnh phụ); với mỗi gian hàng tìm logo + banner
 * theo từ khoá bên dưới. Kết quả ghi vào `assets/real-images.json` (commit cùng repo) — bước deploy (`npm run seed:real-images`) chỉ đọc file
 * này, không cần khoá nào của nguồn ảnh.
 *
 * Hai nguồn (đổi bằng --provider=commons|pexels; mặc định: có EF_PEXELS_API_KEY thì pexels, không thì commons):
 *  - commons : Wikimedia Commons, KHÔNG cần khoá. Chỉ nhận ảnh JPEG ≥ 600px có giấy phép CC0 / Public domain / CC BY / CC BY-SA; ghi giấy phép +
 *              tác giả vào manifest (CC BY / BY-SA yêu cầu ghi công — xem scripts/seed/assets/NGUON-ANH.md). Chỉ nhận ảnh mà TÊN FILE khớp từ khoá
 *              (NGUYÊN TỪ, không khớp chuỗi con; tất cả từ khi từ khoá ≤ 2 từ, ≥ 2/3 khi dài hơn) và mô tả không có người/địa danh/sự kiện làm chủ thể — không khớp thì BỎ QUA và giữ ảnh mẫu, thay vì dùng ảnh sai.
 *  - pexels  : cần EF_PEXELS_API_KEY (miễn phí tại https://www.pexels.com/api/), hạn mức 200 lượt/giờ (tự chờ). Pexels không bắt buộc ghi công.
 * Chạy lại bao nhiêu lần cũng được: khoá đã có trong manifest thì bỏ qua (--force chọn lại hết; --limit=N giới hạn số ảnh mỗi lượt).
 * Mỗi ảnh chỉ dùng cho MỘT chỗ khi tìm đủ ảnh khác nhau. Nên lướt `assets/real-images.json` (có `page` từng ảnh) và xoá/sửa mục chưa hợp.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import { loadEnv } from '../../../src/config/env';
import { DEPARTMENTS } from '../data/dept';
import { REAL_MANIFEST, alreadyRealAssetPaths, alreadyRealProductSlugs, type RealImage, type RealManifest } from '../lib/real-images';

/* Từ khoá tiếng Anh cho gian hàng: [logo, banner]. Logo = vật thể gọn, banner = cảnh rộng. */
const SHOP_QUERIES: Record<string, [string, string]> = {
  'fitly-official': ['fashion boutique hanger', 'clothing store interior'],
  'techzone-vn': ['laptop', 'electronics store'],
  'mobile-hub': ['smartphone', 'mobile phone shop'],
  'gia-dung-thong-minh': ['air fryer', 'kitchen appliances'],
  'nha-xinh-decor': ['table lamp', 'sofa'],
  'beauty-box-vn': ['cosmetics', 'lipstick'],
  'healthy-life': ['vitamin supplements', 'vegetables market'],
  'sneaker-station': ['sneakers', 'shoe store'],
  'bag-and-co': ['handbag', 'handbag store'],
  'time-lab': ['wrist watch', 'watch shop'],
  'sport-planet': ['football', 'camping equipment'],
  'baby-land': ['baby toys', 'baby stroller'],
  'book-cafe': ['stack of books', 'bookstore'],
  'ngon-viet': ['vietnamese food', 'vietnamese market'],
  'pet-world': ['dog cat', 'pet shop'],
  'auto-moto-pro': ['motorcycle helmet', 'motorcycle workshop'],
  'cua-hang-moi': ['shop storefront', 'retail store'],
  'hang-nhai-24h': ['cardboard boxes', 'warehouse'],
};

/* Ngành hàng (ảnh vuông) — `category/<slug>`. 7 ngành thời trang gốc đã có ảnh thật (NGUON-ANH.md) nên không có ở đây. */
const CATEGORY_QUERIES: Record<string, string> = {
  'balo-vali': 'backpack', 'ca-phe-tra': 'coffee', 'cham-soc-da': 'moisturizer', 'cham-soc-toc': 'shampoo', 'cham-soc-xe': 'car wash',
  'chan-ga-goi-nem': 'duvet', 'chuot-ban-phim': 'computer keyboard', 'dac-san-viet-nam': 'banh mi', 'dien-thoai-phu-kien': 'phone charger',
  'dien-thoai': 'smartphone', 'do-an-vat': 'snacks', 'do-choi-tre-em': 'toys', 'do-da-ngoai-cam-trai': 'camping tent', 'do-dien-gia-dung': 'air fryer',
  'do-dung-nha-bep': 'cookware', 'do-the-thao-ngoai-troi': 'hiking', 'dong-ho-nam': 'wrist watch', 'dong-ho-nu': 'ladies watch', 'dong-ho-phu-kien': 'watch',
  'dung-cu-gym-yoga': 'yoga mat', 'dung-cu-hoc-tap': 'stationery', 'giay-dep-tui-xach': 'sneakers', 'giay-the-thao': 'running shoes', 'kinh-mat': 'sunglasses',
  'laptop': 'laptop', 'man-hinh-linh-kien': 'computer monitor screen', 'may-tinh-bang': 'tablet', 'may-tinh-thiet-bi-dien-tu': 'laptop computer',
  'me-be': 'baby bottle', 'mu-bao-hiem': 'motorcycle helmet', 'ngu-coc-hat-dinh-duong': 'almonds', 'nha-cua-doi-song': 'sofa', 'noi-that': 'furniture',
  'nuoc-hoa': 'perfume bottle', 'o-to-xe-may': 'car', 'phu-kien-dien-thoai': 'smartphone case', 'phu-kien-do-choi-thu-cung': 'dog toy', 'phu-kien-o-to': 'car steering wheel',
  'phu-kien-xe-may': 'motorcycle', 'quan-ao-so-sinh': 'baby bodysuit', 'sac-dep-suc-khoe': 'cosmetics', 'sach-thieu-nhi': 'children book',
  'sach-van-hoc-ky-nang': 'books', 'sach-van-phong-pham': 'books', 'sandal-dep': 'sandals', 'sua-ta-be': 'diapers', 'tai-nghe-loa': 'headphones',
  'the-thao-da-ngoai': 'football', 'thu-cung': 'pet', 'thuc-an-thu-cung': 'dog food', 'thuc-pham-chuc-nang': 'vitamin pills', 'thuc-pham-do-uong': 'food',
  'trang-diem': 'makeup', 'trang-suc': 'necklace', 'trang-tri-nha-cua': 'home decor', 'tui-xach': 'handbag',
};
/* Bộ sưu tập (ảnh ngang 3:2) — `collection/<slug>` (nam/nu/hang-moi/dam-du-tiec đã là ảnh thật). */
const COLLECTION_QUERIES: Record<string, string> = {
  'thoi-trang': 'clothing', 'dien-thoai-cong-nghe': 'smartphone', 'nha-cua-doi-song': 'living room', 'sac-dep-suc-khoe': 'lipstick',
  'dien-thoai-phu-kien': 'smartphone', 'dong-ho-phu-kien': 'wrist watch', 'giay-dep-tui-xach': 'sneakers', 'may-tinh-thiet-bi-dien-tu': 'laptop',
  'me-be': 'baby bottle', 'o-to-xe-may': 'motorcycle', 'sach-van-phong-pham': 'books', 'the-thao-da-ngoai': 'football', 'thu-cung': 'dog',
  'thuc-pham-do-uong': 'food',
};
/* Banner trang chủ (ảnh ngang rộng) — `banner/<slug>`: 3 banner chung + 12 banner ngành (cùng slug với bộ sưu tập ngành). */
const BANNER_QUERIES: Record<string, string> = {
  'home-1': 'shopping cart', 'home-2': 'delivery truck', 'home-3': 'gift box',
  'dien-thoai-phu-kien': 'smartphone', 'dong-ho-phu-kien': 'wrist watch', 'giay-dep-tui-xach': 'sneakers', 'may-tinh-thiet-bi-dien-tu': 'laptop computer',
  'me-be': 'baby bottle', 'nha-cua-doi-song': 'sofa', 'o-to-xe-may': 'motorcycle', 'sac-dep-suc-khoe': 'lipstick', 'sach-van-phong-pham': 'books',
  'the-thao-da-ngoai': 'football', 'thu-cung': 'dog', 'thuc-pham-do-uong': 'food',
};

interface Candidate { id: string; page: string; author: string; title: string; text: string; src?: string; license?: string; width: number; height: number; pexelsId?: number }
interface Target { key: string; query: string; orientation: 'portrait' | 'landscape' | 'square' }
interface Provider { name: 'commons' | 'pexels'; search(query: string, orientation: string): Promise<Candidate[]> }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const UA = 'FitlySeedImageCurator/1.0 (student project; seed script)';

const words = (q: string): string[] => q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
/* Số ít đơn giản: bỏ "s"/"es"/"ies" cuối — chỉ để "shoes" ~ "shoe"; KHÔNG so khớp chuỗi con ("watch" ≠ "watching"). */
const stem = (w: string): string => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : /(ss|ch|sh|x)es$/.test(w) ? w.slice(0, -2) : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const wordSet = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem));
/* Số từ khoá xuất hiện NGUYÊN TỪ trong văn bản. */
function hits(text: string, query: string): number {
  const have = wordSet(text);
  return words(query).filter((w) => have.has(stem(w))).length;
}
/* Ngưỡng khớp tối thiểu (trên TÊN FILE) theo độ dài từ khoá: ≤ 2 từ = đủ hết; dài hơn = ≥ 2/3. */
function minHits(query: string): number {
  const n = words(query).length;
  return n <= 2 ? n : Math.ceil((n * 2) / 3);
}
/* Từ khoá DỰ PHÒNG khi từ khoá đầy đủ không ra ảnh: rút gọn về LOẠI hàng (2 từ cuối, rồi từ cuối) — ảnh đúng loại, không cần đúng mẫu. */
const GENERIC = new Set(['pro', 'max', 'set', 'kit', 'mini', 'plus', 'lite', 'new', 'size', 'premium', 'classic', 'basic', 'equipment', 'accessories', 'products', 'appliance', 'supplies', 'care', 'store', 'shop', 'market', 'room', 'bag', 'bags', 'home', 'pet', 'baby', 'food', 'sports', 'car', 'tool', 'tools', 'gear']);
function fallbackQueries(query: string): string[] {
  const w = query.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !GENERIC.has(x));
  const out: string[] = [];
  if (w.length > 2) out.push(w.slice(-2).join(' '));
  if (w.length > 1) out.push(w[w.length - 1]);
  return [...new Set(out)].filter((q) => q !== query.toLowerCase());
}
/* Ảnh có người/địa danh/sự kiện làm chủ thể (mô tả nhắc tới) KHÔNG phải ảnh sản phẩm — loại, trừ khi chính từ khoá tìm có từ đó (vd "women watch"). */
const SUBJECT_NOISE = /\b(woman|women|man|men|boy|boys|girl|girls|child|children|kid|kids|people|person|student|students|guy|lady|ladies|crowd|fans|team|player|players|match|game|visitors?|tourists?|view|town|city|village|street|festival|exhibition|fair|expo|conference|ceremony|prototype|demonstration|speaker|presentation|wearing|holding|using|watching|playing|eating|riding|walking|selling|shopping|customers?|bird|birds|dove|pigeon|cat|cats|dog|dogs|whale|mouse|lizard|monkey|horse)\b/gi;
function hasNoise(text: string, query: string): boolean {
  const allowed = wordSet(query);
  return [...text.matchAll(SUBJECT_NOISE)].some((m) => !allowed.has(stem(m[0].toLowerCase())));
}

function buildTargets(): Target[] {
  const out: Target[] = [];
  const real = alreadyRealProductSlugs(); // đã có ảnh thật chọn tay (NGUON-ANH.md) — không tìm ảnh mới
  for (const d of DEPARTMENTS) {
    for (const p of d.products) {
      if (real.has(p.slug)) continue;
      const q = p.img.query?.trim() || p.name;
      out.push({ key: `product/${p.slug}/a`, query: q, orientation: 'portrait' });
      out.push({ key: `product/${p.slug}/b`, query: q, orientation: 'portrait' });
    }
  }
  const realAssets = alreadyRealAssetPaths();
  for (const [slug, q] of Object.entries(CATEGORY_QUERIES)) if (!realAssets.has(`catalog/categories/${slug}`)) out.push({ key: `category/${slug}`, query: q, orientation: 'square' });
  for (const [slug, q] of Object.entries(COLLECTION_QUERIES)) if (!realAssets.has(`catalog/collections/${slug}`)) out.push({ key: `collection/${slug}`, query: q, orientation: 'landscape' });
  for (const [slug, q] of Object.entries(BANNER_QUERIES)) if (!realAssets.has(`banners/${slug}`)) out.push({ key: `banner/${slug}`, query: q, orientation: 'landscape' });
  for (const [slug, [logo, banner]] of Object.entries(SHOP_QUERIES)) {
    out.push({ key: `shop/${slug}/logo`, query: logo, orientation: 'square' });
    out.push({ key: `shop/${slug}/banner`, query: banner, orientation: 'landscape' });
  }
  return out;
}

/* ------------------------------------------------------------- Wikimedia Commons (không cần khoá) */
/* Loại ảnh không phải ảnh sản phẩm: bản đồ/biểu đồ/ảnh chụp màn hình/logo/hình vẽ/hàng hỏng/người dùng đang làm gì đó... (xét trên tên file + mô tả). */
const COMMONS_UNWANTED = /\b(map|maps|chart|graph|diagram|statistic|statistics|screenshot|logo|icon|flag|drawing|illustration|poster|sketch|damaged|broken|bad|ownership|countries|infographic|protest|accident|crash|fire|wreck|museum|stamp|advertis\w*|sign|signs|vector|svg|comic|cartoon|antique|vintage|historic|historical|ruins|abandoned|rusty|postcard|newspaper|magazine|painting|engraving|satellite|microscope|micrograph|sepia|grayscale|monochrome|exhibit|exhibition|souvenir|replica|sculpture|statue|temple|church|cathedral|castle)\b/i;
const COMMONS_LICENSE_OK = /^(CC0|Public domain|PD\b|CC BY(?!-NC)(?!-ND)|CC BY-SA)/i;
function commonsProvider(): Provider {
  let last = 0;
  return {
    name: 'commons',
    async search(query) {
      const wait = 1100 - (Date.now() - last); // lịch sự với máy chủ: tối đa ~1 lượt/giây
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const params = new URLSearchParams({
        action: 'query', format: 'json', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '30',
        prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1000',
      });
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
        if (res.status === 429 || res.status >= 500) { await sleep(3000 * attempt); continue; }
        if (!res.ok) return [];
        const json = (await res.json()) as { query?: { pages?: Record<string, { index: number; title: string; imageinfo?: Array<{ thumburl?: string; descriptionurl: string; width: number; height: number; mime: string; extmetadata?: Record<string, { value: string }> }> }> } };
        const pages = Object.values(json.query?.pages ?? {}).sort((a, b) => a.index - b.index);
        const out: Candidate[] = [];
        for (const pg of pages) {
          const ii = pg.imageinfo?.[0];
          const md = ii?.extmetadata ?? {};
          const license = md.LicenseShortName?.value ?? '';
          if (!ii || ii.mime !== 'image/jpeg' || ii.width < 600 || ii.height < 600 || !COMMONS_LICENSE_OK.test(license) || !ii.thumburl) continue;
          const author = (md.Artist?.value ?? '').replace(/<[^>]*>/g, '').trim() || 'Wikimedia Commons contributor';
          const title = pg.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '');
          const text = `${title} ${(md.ImageDescription?.value ?? '').replace(/<[^>]*>/g, ' ')}`;
          if (COMMONS_UNWANTED.test(text)) continue;
          out.push({ id: pg.title, page: ii.descriptionurl, author: author.slice(0, 120), title, text, src: ii.thumburl, license, width: ii.width, height: ii.height });
        }
        return out;
      }
      return [];
    },
  };
}

/* ------------------------------------------------------------- Pexels (cần khoá) */
function pexelsProvider(apiKey: string): Provider {
  let remaining = 200;
  return {
    name: 'pexels',
    async search(query, orientation) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (remaining <= 1) {
          console.log('  … hết hạn mức giờ này, chờ 60 phút (Ctrl+C rồi chạy lại sau cũng được — tiến độ đã lưu).');
          await sleep(61 * 60 * 1000);
          remaining = 200;
        }
        const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=40&orientation=${orientation}`;
        const res = await fetch(url, { headers: { Authorization: apiKey }, signal: AbortSignal.timeout(20_000) });
        const left = Number(res.headers.get('x-ratelimit-remaining'));
        if (Number.isFinite(left)) remaining = left;
        if (res.status === 429) { remaining = 0; continue; }
        if (res.status === 401 || res.status === 403) throw new Error('EF_PEXELS_API_KEY không hợp lệ.');
        if (!res.ok) { await sleep(2000 * (attempt + 1)); continue; }
        const photos = ((await res.json()) as { photos?: Array<{ id: number; url: string; photographer: string; alt?: string; width: number; height: number }> }).photos ?? [];
        return photos.map((p) => ({ id: String(p.id), pexelsId: p.id, page: p.url, author: p.photographer, title: `${p.alt ?? ''} ${p.url}`, text: `${p.alt ?? ''} ${p.url}`, width: p.width, height: p.height }));
      }
      return [];
    },
  };
}

function load(): RealManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8')) as RealManifest;
    if (raw && raw.items) return raw;
  } catch { /* chưa có — bình thường */ }
  return { source: 'pexels + wikimedia-commons', license: 'Pexels License (free to use) · Wikimedia Commons: CC0 / Public domain / CC BY / CC BY-SA — see each item', items: {} };
}

function save(m: RealManifest): void {
  const sorted = Object.fromEntries(Object.entries(m.items).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(REAL_MANIFEST, JSON.stringify({ ...m, items: sorted }, null, 1) + '\n');
}

async function main(): Promise<number> {
  const env = loadEnv();
  const argProvider = process.argv.find((a) => a.startsWith('--provider='))?.slice(11);
  const useKey = argProvider ? argProvider === 'pexels' : Boolean(env.EF_PEXELS_API_KEY);
  if (useKey && !env.EF_PEXELS_API_KEY) { console.error('Thiếu EF_PEXELS_API_KEY — bỏ cờ --provider=pexels để dùng Wikimedia Commons (không cần khoá).'); return 1; }
  const provider = useKey ? pexelsProvider(env.EF_PEXELS_API_KEY) : commonsProvider();
  const force = process.argv.includes('--force');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice(8)) : Infinity;
  const manifest = load();
  if (force) manifest.items = {};
  const used = new Set(Object.values(manifest.items).map((i) => i.src ?? String(i.id)));
  // Ảnh đã bị người xem lại loại (real-images.rejected.json) nạp vào `used` ⇒ không bao giờ chọn lại đúng ảnh đó; khoá của nó vẫn được chọn lại bằng ảnh khác.
  const rejectedFile = REAL_MANIFEST.replace(/real-images\.json$/, 'real-images.rejected.json');
  const rejected = fs.existsSync(rejectedFile) ? (JSON.parse(fs.readFileSync(rejectedFile, 'utf8')) as string[]) : [];
  for (const r of rejected) used.add(r.startsWith('pexels:') ? r.slice(7) : r);
  const targets = buildTargets().filter((t) => !manifest.items[t.key]);
  console.log(`Nguồn: ${provider.name}. Cần chọn ${targets.length} ảnh (đã có ${Object.keys(manifest.items).length}).`);

  // Cùng từ khoá + hướng chỉ tìm một lần trong lượt chạy (a/b của một sản phẩm dùng chung kết quả).
  const cache = new Map<string, Candidate[]>();
  let done = 0, skipped = 0;
  for (const t of targets) {
    if (done >= limit) break;
    // Thử từ khoá đầy đủ trước, không ra thì lần lượt các từ khoá dự phòng (đúng loại hàng).
    let best: { c: Candidate; i: number; score: number } | undefined;
    let usedQuery = t.query;
    for (const q of [t.query, ...fallbackQueries(t.query)]) {
      const ck = `${t.orientation}|${q}`;
      let cands = cache.get(ck);
      if (!cands) { cands = await provider.search(q, t.orientation); cache.set(ck, cands); }
      // Commons: bắt buộc TÊN FILE khớp từ khoá; Pexels: lấy ảnh khớp nhiều từ nhất (Pexels đã xếp theo độ liên quan).
      const need = provider.name === 'commons' ? minHits(q) : 0;
      const ranked = cands
        .map((c, i) => ({ c, i, score: hits(c.title, q) }))
        .filter((r) => r.score >= need)
        .filter((r) => provider.name !== 'commons' || !hasNoise(r.c.text, q))
        .filter((r) => (t.orientation === 'landscape' ? r.c.width >= r.c.height : true))
        .sort((x, y) => y.score - x.score || x.i - y.i);
      best = ranked.find((r) => !used.has(r.c.src ?? r.c.id));
      if (best) { usedQuery = q; break; }
    }
    if (!best) { skipped += 1; console.warn(`  – ${t.key}: không có ảnh khớp "${t.query}" → giữ ảnh mẫu`); continue; }
    used.add(best.c.src ?? best.c.id);
    const item: RealImage = provider.name === 'commons'
      ? { provider: 'commons', src: best.c.src, page: best.c.page, photographer: best.c.author, license: best.c.license, query: usedQuery, alt: best.c.text.slice(0, 160), match: best.score }
      : { provider: 'pexels', id: best.c.pexelsId, page: best.c.page, photographer: best.c.author, query: usedQuery, alt: best.c.text.slice(0, 160), match: best.score };
    manifest.items[t.key] = item;
    done += 1;
    if (done % 20 === 0) { save(manifest); console.log(`  … ${done} ảnh (bỏ qua ${skipped})`); }
  }
  save(manifest);
  console.log(`Xong: chọn thêm ${done} ảnh, không có ảnh khớp ${skipped}. Tổng trong manifest: ${Object.keys(manifest.items).length}.`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e: unknown) => { console.error(e); process.exit(1); });
