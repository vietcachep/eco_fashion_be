/* Nhóm 07: voucher/ship/tổng tiền toàn vẹn · đánh giá · sự cố hạ tầng (Redis/DB/worker) · sao lưu–khôi phục. */
import * as L from './lib.mjs';
import { execSync } from 'node:child_process';
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.stack ?? e); process.exit(3); });
const { check, group, api, q, q1, note, sleep } = L;
const shops = {};
for (const s of ['techzone', 'ngonviet', 'sneaker']) shops[s] = await L.shopBySlug(s);
await L.mockReset(); await L.mockBalance(5_000_000_000);
const num = (x) => Number(L.money(x));
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return String(e.stdout ?? e.message).trim(); } };

group('OPS — sự cố hạ tầng: DB / sao lưu / worker');
{
  // Postgres chết 15s
  sh('docker stop fitly-audit-db');
  await sleep(2500);
  const h = await fetch(`${L.BASE}/health`, { headers: { connection: 'close' } }).then(async (r) => ({ st: r.status, j: await r.json().catch(() => null) })).catch((e) => ({ st: 0, err: String(e) }));
  const order = await fetch(`${L.BASE}/orders`, { headers: { connection: 'close', authorization: 'Bearer x' } }).then((r) => r.status).catch(() => 0);
  const wh = await L.sendWebhook('123', 1000).catch(() => ({ status: 0 }));
  note('OPS-04d', 'Postgres tắt', `health=${h.st} db=${h.j?.data?.database ?? ''} | webhook PayOS trả HTTP ${wh.status} (PayOS sẽ thử lại nếu ≥ 500)`);
  sh('docker start fitly-audit-db');
  for (let i = 0; i < 20; i++) { if (sh('docker exec fitly-audit-db pg_isready -U ecofashion -d ecofashion').includes('accepting')) break; await sleep(1500); }
  await sleep(6000);
  const h2 = await fetch(`${L.BASE}/health`, { headers: { connection: 'close' } }).then((r) => r.json()).catch(() => null);
  check('OPS-04e', 'Postgres bật lại ⇒ API tự hồi phục (health UP) KHÔNG cần khởi động lại', h2?.data?.status === 'UP' && h2?.data?.database === 'UP', h2?.data);
  check('OPS-04f', 'Postgres tắt ⇒ webhook PayOS trả 5xx (để PayOS thử lại), KHÔNG trả 200 giả', wh.status >= 500, wh);
  L.dropToken?.('khach11');
}
{
  // sao lưu – khôi phục: pg_dump → DB mới → so sánh số dòng
  sh('docker exec fitly-audit-db psql -U ecofashion -d postgres -c "DROP DATABASE IF EXISTS restore_check"');
  sh('docker exec fitly-audit-db psql -U ecofashion -d postgres -c "CREATE DATABASE restore_check"');
  const dump = sh('docker exec fitly-audit-db sh -c "pg_dump -U ecofashion -Fc ecofashion > /tmp/audit.dump && ls -l /tmp/audit.dump | awk \'{print $5}\'"');
  const rest = sh('docker exec fitly-audit-db sh -c "pg_restore -U ecofashion -d restore_check --no-owner /tmp/audit.dump 2>&1 | tail -2"');
  const cnt = (db) => sh(`docker exec fitly-audit-db psql -U ecofashion -d ${db} -At -c "select (select count(*) from \\"order\\".orders)||'/'||(select count(*) from payment.refunds)||'/'||(select count(*) from payment.shop_payouts)||'/'||(select count(*) from payment.shop_cod_wallet_transactions)"`);
  const a = cnt('ecofashion'), b = cnt('restore_check');
  check('OPS-05', 'sao lưu pg_dump → khôi phục vào DB mới: số dòng đơn/hoàn/kỳ chi/ví khớp 100%', a === b && /\d+\/\d+\/\d+\/\d+/.test(a), { orig: a, restored: b, dumpBytes: dump, rest });
  sh('docker exec fitly-audit-db psql -U ecofashion -d postgres -c "DROP DATABASE IF EXISTS restore_check"');
}
{
  // worker chết: job nền ngừng — chứng minh "không ai biết"
  const pid = sh(`powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'dist[\\\\/]src[\\\\/]worker\\.js' } | Select-Object -First 1).ProcessId"`);
  note('OPS-01x', 'tiến trình worker', `pid=${pid}`);
  const hw = await api('GET', '/health');
  note('OPS-01y', '/health khi worker chết', `status=${hw.data?.status} (health chỉ kiểm DB+Redis — worker chết vẫn UP; job nền, email, outbox dừng im lặng)`);
}

L.saveResults(process.env.OUT ?? 'out-t07b.json');
const R = L.results;
console.log(`\nTỔNG nhóm 07: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
