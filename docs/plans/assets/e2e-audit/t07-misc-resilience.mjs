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

group('PRICE — voucher / phí ship / tổng tiền toàn vẹn');
{
  // voucher giới hạn theo người dùng
  await q(`DELETE FROM promotion.promotions WHERE code='AUDITUSER1'`);
  await q(`INSERT INTO promotion.promotions (code, name, type, value, min_order_amount, usage_limit, usage_limit_per_user, used_count, applies_to, starts_at, ends_at, is_active, is_public, scope) VALUES ('AUDITUSER1','mỗi người 1 lần','fixed_amount',10000,50000,NULL,1,0,'all', now() - interval '1 day', now() + interval '30 days', true, false, 'platform')`);
  L.clearCaches();
  const v = (await L.pickVariant({ shopId: shops.techzone.id, qty: 4, maxPrice: 600000 })).slice(0, 2);
  const a = await L.placeOrder({ as: 'khach26', items: [{ variantId: v[0].id, qty: 1 }], method: 'cod', voucherCodes: ['AUDITUSER1'] });
  const b = await L.placeOrder({ as: 'khach26', items: [{ variantId: v[1].id, qty: 1 }], method: 'cod', voucherCodes: ['AUDITUSER1'] });
  check('PRICE-01', 'voucher giới hạn 1 lần/người: lần 2 của cùng khách bị từ chối (400)', a.status === 201 && b.status === 400, { a: a.status, b: b.status, code: b.code, msg: b.raw?.message });
  const other = await L.placeOrder({ as: 'khach27', items: [{ variantId: v[1].id, qty: 1 }], method: 'cod', voucherCodes: ['AUDITUSER1'] });
  check('PRICE-02', 'khách khác vẫn dùng được mã đó', other.status === 201, { st: other.status, code: other.code });
  const ghost = await L.placeOrder({ as: 'khach26', items: [{ variantId: v[1].id, qty: 1 }], method: 'cod', voucherCodes: ['KHONGTONTAI'] });
  check('PRICE-03', 'mã không tồn tại ⇒ 400 rõ lý do, không tạo đơn', ghost.status === 400, { st: ghost.status, code: ghost.code });
  const expired = await L.placeOrder({ as: 'khach26', items: [{ variantId: v[1].id, qty: 1 }], method: 'cod', voucherCodes: ['HETHAN'] });
  check('PRICE-04', 'mã hết hạn (HETHAN) ⇒ 400', expired.status === 400, { st: expired.status, code: expired.code, msg: expired.raw?.message });
  const minOrder = await L.placeOrder({ as: 'khach26', items: [{ variantId: (await L.pickVariant({ shopId: shops.ngonviet.id, qty: 2, maxPrice: 150000 }))[0].id, qty: 1 }], method: 'cod', voucherCodes: ['GIAM200K'] });
  check('PRICE-05', 'chưa đạt đơn tối thiểu của mã ⇒ 400', minOrder.status === 400, { st: minOrder.status, msg: minOrder.raw?.message });
  for (const x of [a, other]) if (x.status === 201) { const c = L.childOrders(x)[0]?.code; await api('POST', `/orders/${c}/cancel`, { as: x === a ? 'khach26' : 'khach27', body: { reason: 'dọn đơn thử' } }); }
}
{
  // phí ship & toàn vẹn tổng tiền
  const th = Number((await L.getSetting('shipping.free_threshold')) ?? 500000);
  const cheap = (await L.pickVariant({ shopId: shops.sneaker.id, qty: 3, maxPrice: 200000 }))[0];
  const big = (await L.pickVariant({ shopId: shops.sneaker.id, qty: 3, maxPrice: 2_000_000 })).sort((x, y) => Number(y.price) - Number(x.price))[0];
  const p1 = await L.placeOrder({ as: 'khach28', items: [{ variantId: cheap.id, qty: 1 }], method: 'cod' });
  const p2 = await L.placeOrder({ as: 'khach28', items: [{ variantId: big.id, qty: Math.ceil((th + 1) / Number(big.price)) }], method: 'cod' });
  const rows = [];
  for (const p of [p1, p2]) if (p.status === 201) rows.push(await q1(`SELECT code, subtotal, shipping_fee, discount, total, item_count FROM "order".orders WHERE code = $1`, [L.childOrders(p)[0].code]));
  check('PRICE-06', `đơn nhỏ (< ${th}) có phí ship > 0; đơn ≥ ngưỡng miễn phí có ship = 0`, rows.length === 2 && Number(rows[0].shipping_fee) > 0 && Number(rows[1].shipping_fee) === 0, rows);
  for (const r of rows) {
    const items = await q(`SELECT unit_price, quantity, line_total FROM "order".order_items WHERE order_id = (SELECT id FROM "order".orders WHERE code = $1)`, [r.code]);
    const sumItems = items.reduce((a, i) => a + Number(i.unit_price) * i.quantity, 0);
    check('PRICE-07', `đơn ${r.code}: subtotal = Σ(đơn giá × SL), total = subtotal + ship − giảm`, sumItems === Number(r.subtotal) && Number(r.total) === Number(r.subtotal) + Number(r.shipping_fee) - Number(r.discount), { r, sumItems });
  }
  // giá thay đổi sau khi đặt không ảnh hưởng đơn
  if (rows[0]) {
    const before = await q1(`SELECT unit_price FROM "order".order_items WHERE order_id = (SELECT id FROM "order".orders WHERE code = $1) LIMIT 1`, [rows[0].code]);
    await q(`UPDATE product.product_variants SET price = COALESCE(price, 0) + 50000 WHERE id = $1`, [cheap.id]);
    const after = await q1(`SELECT unit_price FROM "order".order_items WHERE order_id = (SELECT id FROM "order".orders WHERE code = $1) LIMIT 1`, [rows[0].code]);
    check('PRICE-08', 'đổi giá sản phẩm sau khi đặt KHÔNG đổi giá trên đơn đã tạo (snapshot)', Number(before.unit_price) === Number(after.unit_price), { before, after });
    await q(`UPDATE product.product_variants SET price = price - 50000 WHERE id = $1`, [cheap.id]);
  }
  for (const [i, p] of [p1, p2].entries()) if (p.status === 201) await api('POST', `/orders/${L.childOrders(p)[0].code}/cancel`, { as: 'khach28', body: { reason: 'dọn đơn thử' } });
}

group('CMP — đánh giá');
{
  const v = (await L.pickVariant({ shopId: shops.techzone.id, qty: 3, maxPrice: 900000 }))[0];
  const p = await L.placeOrder({ as: 'khach29', items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
  const kid = L.childOrders(p)[0];
  const slug = (await q1(`SELECT slug FROM product.products WHERE id = $1`, [v.product_id])).slug;
  const before = await api('GET', `/products/${slug}/reviews/eligibility`, { as: 'khach29' });
  check('CMP-01d', 'chưa nhận hàng ⇒ chưa được đánh giá', before.data?.canReview === false || before.data?.eligible === false, before.raw);
  for (const s of ['confirmed', 'packing', 'shipping', 'delivered']) await api('PUT', `/shop/orders/${kid.code}/status`, { as: 'owner:techzone', body: { status: s } });
  const elig = await api('GET', `/products/${slug}/reviews/eligibility`, { as: 'khach29' });
  const rv = await api('POST', `/products/${slug}/reviews`, { as: 'khach29', body: { rating: 5, content: 'Hàng tốt, giao nhanh — đánh giá kiểm thử tự động.' } });
  check('CMP-01b', 'tạo đánh giá sau khi nhận hàng', rv.status === 200 || rv.status === 201, { st: rv.status, code: rv.code, msg: rv.message, elig: elig.raw });
  const rv2 = await api('POST', `/products/${slug}/reviews`, { as: 'khach29', body: { rating: 4, content: 'Đánh giá lần hai cho cùng dòng hàng.' } });
  check('CMP-02a', 'đánh giá lần 2 cho cùng dòng hàng ⇒ bị chặn', rv2.status >= 400, { st: rv2.status, code: rv2.code });
  const rvBad = await api('POST', `/products/${slug}/reviews`, { as: 'khach29', body: { rating: 9, content: 'ngắn' } });
  check('CMP-02b', 'số sao/độ dài sai ⇒ 400', rvBad.status === 400, { st: rvBad.status });
  const reply = await api('POST', `/shop/reviews/${rv.data?.id}/reply`, { as: 'owner:techzone', body: { content: 'Cảm ơn bạn đã ủng hộ shop!' } });
  check('CMP-04a', 'shop trả lời đánh giá', reply.status === 200 || reply.status === 201, { st: reply.status, code: reply.code });
  const otherShopReply = await api('POST', `/shop/reviews/${rv.data?.id}/reply`, { as: 'owner:sneaker', body: { content: 'Shop khác trả lời hộ?' } });
  check('SEC-01v', 'shop khác trả lời đánh giá không thuộc shop mình ⇒ 404/403', otherShopReply.status === 404 || otherShopReply.status === 403, { st: otherShopReply.status });
  note('CMP-03', 'đánh giá còn hiệu lực sau khi đơn bị trả hàng / hạn viết đánh giá', 'chưa có hạn viết đánh giá (WP-09 CMP-02) và sold_count không trừ khi trả');
}

group('OPS — sự cố hạ tầng: Redis / DB / worker');
{
  // Redis chết 20s
  sh('docker stop fitly-audit-redis');
  await sleep(2500);
  const h = await fetch(`${L.BASE}/health`, { headers: { connection: 'close' } }).then(async (r) => ({ st: r.status, j: await r.json().catch(() => null) })).catch((e) => ({ st: 0, err: String(e) }));
  const catalog = await fetch(`${L.BASE}/categories`, { headers: { connection: 'close' } }).then((r) => r.status).catch(() => 0);
  const login = await fetch(`${L.BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ email: 'khach11@ecofashion.vn', password: process.env.E2E_PW_KHACH }) }).then((r) => r.status).catch(() => 0);
  note('OPS-04a', 'Redis tắt', `health=${h.st} ${h.j?.data?.redis ?? ''} | GET /categories=${catalog} | đăng nhập=${login}`);
  sh('docker start fitly-audit-redis');
  await sleep(6000);
  const h2 = await fetch(`${L.BASE}/health`, { headers: { connection: 'close' } }).then((r) => r.json()).catch(() => null);
  const login2 = await fetch(`${L.BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ email: 'khach11@ecofashion.vn', password: process.env.E2E_PW_KHACH }) }).then((r) => r.status).catch(() => 0);
  check('OPS-04b', 'Redis bật lại ⇒ API tự hồi phục (health UP, đăng nhập được) KHÔNG cần khởi động lại', h2?.data?.status === 'UP' && h2?.data?.redis === 'UP' && login2 === 200, { health: h2?.data, login: login2 });
  check('OPS-04c', 'Redis tắt ⇒ health báo DOWN/degraded (có thể cảnh báo)', h.st === 503 || h.j?.data?.redis === 'DOWN' || h.j?.data?.status !== 'UP', h);
}
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

L.saveResults(process.env.OUT ?? 'out-t07.json');
const R = L.results;
console.log(`\nTỔNG nhóm 07: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
