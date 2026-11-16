/*
 * XEM LẠI ẢNH ĐÃ CHỌN  —  `npm run seed:real-images:review`  rồi mở file HTML được in ra bằng trình duyệt.
 *
 * Mỗi dòng: tên sản phẩm/shop (từ slug) · từ khoá đã tìm · ảnh · mô tả ảnh · giấy phép. Tích "Sai" ở ảnh không đúng sản phẩm rồi bấm
 * "Tải danh sách loại" → file `rejects.json`. Gỡ các ảnh đó khỏi manifest bằng:  `npm run seed:real-images:prune -- <đường dẫn rejects.json>`
 * (sản phẩm bị gỡ ảnh sẽ GIỮ ảnh mẫu khi deploy). Công cụ chỉ đọc manifest, không gọi mạng; trình duyệt tự tải ảnh từ Wikimedia để hiển thị.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REAL_MANIFEST, type RealManifest } from '../lib/real-images';

const esc = (s: string | undefined | null): string => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function main(): void {
  const m = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8')) as RealManifest;
  const keys = Object.keys(m.items).sort();
  const rows = keys
    .map((k) => {
      const it = m.items[k];
      // Ảnh đóng gói sẵn (provider web) nằm trong assets/; trang HTML nằm ở tools/.review/ nên đường dẫn tương đối là ../../assets/<file>.
      const url = it.file ? `../../assets/${it.file}` : (it.src ?? '');
      return `<tr data-key="${esc(k)}"><td><label><input type="checkbox" class="bad"> Sai</label></td><td><b>${esc(k.split('/')[1])}</b><br><small>${esc(k.split('/')[2])} · tìm: ${esc(it.query)}</small></td>` +
        `<td><a href="${esc(it.page)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(url)}" width="220" alt=""></a></td>` +
        `<td><small>${esc((it.alt ?? '').slice(0, 220))}<br><i>${esc(it.license ?? '')}</i></small></td></tr>`;
    })
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>Xem lại ảnh đã chọn (${keys.length})</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:8px;vertical-align:top}tr.x{background:#fee}img{border-radius:6px;display:block}
#bar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:2px solid #333}</style>
<div id="bar"><b>${keys.length} ảnh.</b> Tích "Sai" ảnh không đúng sản phẩm. <button id="dl">Tải danh sách loại (<span id="n">0</span>)</button> <input id="f" placeholder="lọc theo tên..." size="30"></div>
<table>${rows}</table>
<script>
const rows=[...document.querySelectorAll('tr[data-key]')];const n=document.getElementById('n');
const count=()=>{n.textContent=rows.filter(r=>r.querySelector('.bad').checked).length};
rows.forEach(r=>r.querySelector('.bad').addEventListener('change',e=>{r.classList.toggle('x',e.target.checked);count()}));
document.getElementById('f').addEventListener('input',e=>{const q=e.target.value.toLowerCase();rows.forEach(r=>r.style.display=r.textContent.toLowerCase().includes(q)?'':'none')});
document.getElementById('dl').onclick=()=>{const keys=rows.filter(r=>r.querySelector('.bad').checked).map(r=>r.dataset.key);
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(keys,null,1)],{type:'application/json'}));a.download='rejects.json';a.click()};
</script>`;
  const outDir = path.resolve(__dirname, '.review');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'real-images-review.html');
  fs.writeFileSync(out, html);
  console.log(`Đã tạo ${out}\nMở file này bằng trình duyệt, tích ảnh sai, tải rejects.json rồi chạy: npm run seed:real-images:prune -- <rejects.json>`);
}
main();
