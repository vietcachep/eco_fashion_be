/*
 * Đánh dấu lại cột HT của docs/11_SCENARIO_CATALOGUE.md bằng hậu tố `E2E ✔/✘/ℹ` từ kết quả run-all.sh (idempotent: gỡ hậu tố cũ rồi gắn lại; giữ CRLF).
 * Dùng:  REG_DIR="$(cygpath -m /tmp)/reg" node mark-docs11.cjs ../../../11_SCENARIO_CATALOGUE.md
 * Mã kết thúc bằng 'x' (vd STL-16x) là bài bổ sung riêng, không đại diện cho dòng cùng số trong docs/11 nên bị bỏ qua.
 */
const fs = require('fs');
const { byId } = require('./merge-results.cjs');
const base = new Map();
for (const r of byId.values()) {
  const m = r.id.match(/^([A-Z]+-\d+)/); if (!m || /x$/.test(r.id)) continue;
  const b = base.get(m[1]) ?? { fail: 0, pass: 0, note: 0 };
  if (r.ok === false) b.fail++; else if (r.ok === true) b.pass++; else b.note++;
  base.set(m[1], b);
}
const doc = process.argv[2];
const raw = fs.readFileSync(doc, 'utf8'); const crlf = raw.includes('\r\n');
let md = raw.replace(/\r\n/g, '\n').split('\n');
const n = { fail: 0, pass: 0, note: 0 };
md = md.map((line) => {
  const m = line.match(/^\| ([A-Z]+-\d+) \|/); if (!m || !line.trimEnd().endsWith('|')) return line;
  line = line.replace(/ · E2E [✔✘ℹ]/, '');
  const b = base.get(m[1]); if (!b) return line;
  const tag = b.fail ? 'E2E ✘' : b.pass ? 'E2E ✔' : 'E2E ℹ';
  n[b.fail ? 'fail' : b.pass ? 'pass' : 'note']++;
  return line.replace(/\s*\|\s*$/, ` · ${tag} |`);
});
fs.writeFileSync(doc, crlf ? md.join('\n').replace(/\n/g, '\r\n') : md.join('\n'));
console.log('docs/11 đã đánh dấu', JSON.stringify(n), 'mã có kết quả:', base.size);
