/*
 * GỠ ẢNH SAI KHỎI MANIFEST  —  `npm run seed:real-images:prune -- <rejects.json>`
 * `rejects.json` là danh sách khoá (vd "product/ao-thun/a") do trang xem lại (`seed:real-images:review`) xuất ra. Sản phẩm bị gỡ ảnh giữ ảnh mẫu khi deploy.
 * Ảnh bị gỡ được ghi vào `scripts/seed/assets/real-images.rejected.json` (theo URL ảnh) để `curate` KHÔNG chọn lại đúng ảnh đó; khoá của nó sẽ được chọn lại bằng ảnh khác.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REAL_MANIFEST, type RealManifest } from '../lib/real-images';

const file = process.argv[2];
if (!file) { console.error('Dùng: npm run seed:real-images:prune -- <rejects.json>'); process.exit(1); }
const rejects = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
const m = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8')) as RealManifest;
let removed = 0;
const bad: string[] = [];
for (const k of rejects) {
  const it = m.items[k];
  if (!it) continue;
  bad.push(it.src ?? `pexels:${String(it.id)}`); // ghi lại ẢNH bị loại (không phải khoá) để curate không chọn lại đúng ảnh đó
  delete m.items[k];
  removed += 1;
}
fs.writeFileSync(REAL_MANIFEST, JSON.stringify(m, null, 1) + '\n');
const rejectedFile = path.join(path.dirname(REAL_MANIFEST), 'real-images.rejected.json');
const prev = fs.existsSync(rejectedFile) ? (JSON.parse(fs.readFileSync(rejectedFile, 'utf8')) as string[]) : [];
fs.writeFileSync(rejectedFile, JSON.stringify([...new Set([...prev, ...bad])].sort(), null, 1) + '\n');
console.log(`Đã gỡ ${removed}/${rejects.length} ảnh khỏi manifest; còn ${Object.keys(m.items).length}. Ảnh bị loại lưu ở ${rejectedFile} (khoá đó sẽ được chọn lại bằng ảnh khác ở lần curate sau).`);
