/*
 * `npm run seed:validate` — kiểm dữ liệu mẫu (scripts/seed/data) KHÔNG cần DB. Thoát mã 1 nếu có lỗi.
 * Dùng khi viết/sửa `data/dept/*.ts` để biết sai ở đâu ngay (slug trùng, sai trục biến thể, shop không bán ngành…).
 */
import { validateSeedData } from '../data/validate';

const r = validateSeedData();
for (const w of r.warnings) console.log(`  ! ${w}`);
for (const e of r.errors) console.error(`  ✗ ${e}`);
const s = r.stats;
console.log(`\nNgành gốc ${s.departments} · ngành lá ${s.leaves} · sản phẩm ${s.products} · biến thể ${s.variants} · ảnh ~${s.images} · shop ${s.shops}`);
console.log(r.errors.length === 0 ? `OK — 0 lỗi, ${r.warnings.length} cảnh báo` : `LỖI: ${r.errors.length} lỗi, ${r.warnings.length} cảnh báo`);
process.exit(r.errors.length === 0 ? 0 : 1);
