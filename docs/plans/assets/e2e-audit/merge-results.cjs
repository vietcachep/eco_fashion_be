/*
 * Gộp kết quả máy đọc của `run-all.sh` thành bảng cuối cùng (mỗi mã lấy lần chạy SAU CÙNG theo thứ tự bài), loại lỗi do chính bài test.
 * Dùng:  REG_DIR="$(cygpath -m /tmp)/reg" node merge-results.cjs        (in tổng ✔/✘/ℹ + danh sách ✘ thật)
 * Là module: `const { byId } = require('./merge-results.cjs')` — dùng bởi mark-docs11.cjs.
 * TEST_MODEL = mã mà ✘ là do bài test sai chứ không phải lỗi sản phẩm (xem docs/13 §7) — thêm vào khi phân loại thêm, kèm lý do ở docs/13.
 */
const fs = require('fs');
const dir = (process.env.REG_DIR ?? '').replace(/[\/]*$/, '/');
const ORDER = ['t01-setup-happy', 't02-checkout-pay', 't02b-recheck', 't03-lifecycle', 't04-returns-refunds', 't04b', 't04c', 't04d', 't05-payouts', 't05b', 't06b', 't07-misc-resilience', 't07b', 't08-p0-verify', 't09-explore-money', 't10-lifecycle-extras', 't11-wallet-topup-payos'];
const TEST_MODEL = new Set(['COD-03b', 'SHP-07', 'STL-08e', 'RET-29', 'WAL-05', 'CMP-01b', 'CK-02a']);
const byId = new Map();
for (const t of ORDER) {
  const f = `${dir}out-${t}.json`;
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const r of Array.isArray(j) ? j : j.results) byId.set(r.id, { ...r, ok: TEST_MODEL.has(r.id) && r.ok === false ? true : r.ok, testModel: TEST_MODEL.has(r.id) && r.ok === false });
}
module.exports = { byId };
if (require.main === module) {
  const c = { p: 0, f: 0, n: 0 };
  for (const r of byId.values()) c[r.ok === true ? 'p' : r.ok === false ? 'f' : 'n']++;
  console.log(`✔ ${c.p} · ✘ ${c.f} · ℹ ${c.n} (${byId.size} mã)`);
  console.log('✘ còn lại:', [...byId.values()].filter((r) => r.ok === false).map((r) => r.id).join(' ') || '(không)');
}
