/*
 * Xuất danh sách ảnh cần sinh (từ DSL scripts/seed/data) ra `.image-manifest.json` cho `gen_images.py` đọc.
 * Chạy qua `npm run seed:gen-images` (xuất manifest rồi sinh ảnh). Ảnh đã có trong assets thì bị bỏ qua (thêm `--force` để vẽ lại).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEPARTMENTS } from '../data/dept';
import { SHOPS } from '../data/shops';
import { THEMES, type ThemeName } from '../data/types';

interface Item {
  out: string;
  kind: 'product' | 'product-hover' | 'category' | 'collection' | 'shop-logo' | 'shop-banner' | 'banner';
  emoji: string;
  emoji2?: string;
  colors: readonly [string, string];
  /* Nhãn: tên ngành/shop; với kind 'banner' là TIÊU ĐỀ lớn của banner */
  label?: string;
  /* Chỉ kind 'banner': dòng phụ, nhãn chip nhỏ phía trên tiêu đề, chữ trên nút */
  subtitle?: string;
  tag?: string;
  cta?: string;
}

/* Dòng phụ in trên ảnh banner của từng ngành gốc (ngắn gọn — nội dung đầy đủ nằm ở banner trong DB: content-marketplace.seed.ts).
   Ngành mới chưa có ở đây thì lấy từ đầu mô tả ngành. */
const DEPT_BANNER_TAGLINE: Record<string, string> = {
  'dien-thoai-phu-kien': 'Smartphone · Ốp lưng · Cáp sạc · Tai nghe',
  'may-tinh-thiet-bi-dien-tu': 'Laptop · Màn hình · Phụ kiện · Âm thanh',
  'nha-cua-doi-song': 'Gia dụng · Nội thất · Chăn ga gối nệm',
  'sac-dep-suc-khoe': 'Chăm sóc da · Trang điểm · Nước hoa',
  'giay-dep-tui-xach': 'Sneaker · Sandal · Túi xách · Vali',
  'dong-ho-phu-kien': 'Đồng hồ · Kính mắt · Trang sức bạc',
  'the-thao-da-ngoai': 'Gym · Yoga · Xe đạp · Cắm trại',
  'me-be': 'Sữa · Tã · Đồ chơi · Xe đẩy',
  'sach-van-phong-pham': 'Sách hay · Bút vở · Dụng cụ học tập',
  'thuc-pham-do-uong': 'Đặc sản · Cà phê · Trà · Đồ ăn vặt',
  'thu-cung': 'Thức ăn · Đồ chơi · Phụ kiện chó mèo',
  'o-to-xe-may': 'Mũ bảo hiểm · Phụ kiện · Dầu nhớt',
};

/* 3 banner khuyến mãi CHUNG của sàn (`banners/home-N.jpg`) — khớp thứ tự với HOME_BANNERS trong content-marketplace.seed.ts */
const HOME_BANNER_IMAGES: Array<{ emoji: string; theme: ThemeName; label: string; subtitle: string; tag: string; cta: string }> = [
  { emoji: '🛍️', theme: 'coral', label: 'Sàn FITLY — mua sắm đa ngành', subtitle: 'Nhiều gian hàng · Một giỏ hàng · Giao tận nơi', tag: 'FITLY', cta: 'Khám phá ngay' },
  { emoji: '🚚', theme: 'sky', label: 'Freeship toàn quốc', subtitle: 'Đơn từ 500.000₫ của mỗi gian hàng được miễn phí vận chuyển', tag: 'Vận chuyển', cta: 'Xem chi tiết' },
  { emoji: '🎟️', theme: 'violet', label: 'Voucher của từng gian hàng', subtitle: 'Săn mã riêng của mỗi shop, dùng kèm mã giảm giá của sàn', tag: 'Khuyến mãi', cta: 'Săn voucher' },
];

const colors = (t: ThemeName): readonly [string, string] => THEMES[t];
const items: Item[] = [];

/* Đầu mô tả ngành (trước dấu phẩy đầu tiên, tối đa ~60 ký tự) — dự phòng cho ngành chưa có trong DEPT_BANNER_TAGLINE */
const shortDesc = (s: string): string => {
  const first = s.split(',')[0]?.trim() ?? s;
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
};

for (const d of DEPARTMENTS) {
  items.push({ out: `catalog/categories/${d.slug}.jpg`, kind: 'category', emoji: d.icon, colors: colors(d.theme) });
  items.push({ out: `catalog/collections/${d.slug}.jpg`, kind: 'collection', emoji: d.icon, colors: colors(d.theme), label: d.name });
  for (const c of d.categories) items.push({ out: `catalog/categories/${c.slug}.jpg`, kind: 'category', emoji: c.icon, colors: colors(c.theme) });
  for (const p of d.products) {
    items.push({ out: `product/${p.slug}/a.jpg`, kind: 'product', emoji: p.img.emoji, emoji2: p.img.emoji2, colors: colors(p.img.theme) });
    items.push({ out: `product/${p.slug}/b.jpg`, kind: 'product-hover', emoji: p.img.emoji, emoji2: p.img.emoji2, colors: colors(p.img.theme) });
  }
}
for (const s of SHOPS) {
  items.push({ out: `shop/${s.slug}/logo.jpg`, kind: 'shop-logo', emoji: s.emoji, colors: colors(s.theme), label: s.name });
  items.push({ out: `shop/${s.slug}/banner.jpg`, kind: 'shop-banner', emoji: s.emoji, colors: colors(s.theme), label: s.name });
}
/* Banner trang chủ: mỗi ngành GỐC một banner theo emoji + màu ngành, kèm 3 banner khuyến mãi chung của sàn */
for (const d of DEPARTMENTS) {
  items.push({ out: `banners/${d.slug}.jpg`, kind: 'banner', emoji: d.icon, colors: colors(d.theme), label: d.name, subtitle: DEPT_BANNER_TAGLINE[d.slug] ?? shortDesc(d.description), tag: 'Ngành hàng', cta: 'Mua ngay' });
}
for (const [i, b] of HOME_BANNER_IMAGES.entries()) {
  items.push({ out: `banners/home-${i + 1}.jpg`, kind: 'banner', emoji: b.emoji, colors: colors(b.theme), label: b.label, subtitle: b.subtitle, tag: b.tag, cta: b.cta });
}

const file = path.join(__dirname, '.image-manifest.json');
fs.writeFileSync(file, JSON.stringify({ items }, null, 1));
console.log(`Đã xuất ${items.length} ảnh cần sinh → ${path.relative(process.cwd(), file)}`);
