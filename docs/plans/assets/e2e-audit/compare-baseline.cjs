/*
 * So kết quả run-all.sh hiện tại với baseline đã lưu — in HỒI QUY (✔→✘), CẢI THIỆN (✘/ℹ→✔) và mã mới. Thoát mã 1 nếu có hồi quy.
 * Dùng:  REG_DIR="$(cygpath -m /tmp)/reg" node compare-baseline.cjs [baseline.json]      (mặc định baseline-2026-10-27.json)
 */
const fs = require('fs');
const { byId } = require('./merge-results.cjs');
const base = JSON.parse(fs.readFileSync(process.argv[2] ?? `${__dirname}/baseline-2026-10-27.json`, 'utf8'));
const now = {}; for (const [id, r] of byId) now[id] = r.ok === true ? '✔' : r.ok === false ? '✘' : 'ℹ';
const reg = [], imp = [], missing = [];
for (const [id, b] of Object.entries(base)) {
  if (!(id in now)) { missing.push(id); continue; }
  if (b === '✔' && now[id] === '✘') reg.push(id);
  else if (b !== '✔' && now[id] === '✔') imp.push(`${id} ${b}→✔`);
}
const added = Object.keys(now).filter((id) => !(id in base));
console.log(`HỒI QUY (✔→✘): ${reg.length}`, reg.join(' ') || '(không)');
console.log(`CẢI THIỆN: ${imp.length}`, imp.join(' '));
console.log(`mã mới: ${added.length} · mã baseline không còn chạy: ${missing.length}${missing.length ? ' → ' + missing.join(' ') : ''}`);
process.exit(reg.length ? 1 : 0);
