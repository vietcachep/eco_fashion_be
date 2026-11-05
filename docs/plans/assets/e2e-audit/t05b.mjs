/* Nhóm 05b: đối soát — theo dõi (timing / dồn kỳ / giữ / đồng thời / mã kỳ trùng trong ngày). */
import * as L from './lib.mjs';
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.stack ?? e); process.exit(3); });
const { check, group, api, q, q1, note } = L;
const SLUG = 'mobilehub';
const shop = await L.shopBySlug(SLUG);
const owner = `owner:${SLUG}`;
await L.mockReset();
await L.mockBalance(5_000_000_000);
await q(`UPDATE "order".orders SET delivered_at = now(), completed_at = now() WHERE shop_id = $1 AND code LIKE 'DHSEED%'`, [shop.id]);
await q(`UPDATE payment.shop_payouts SET status = 'paid' WHERE shop_id = $1 AND status IN ('pending','processing')`, [shop.id]);
const sstat = (code, status, extra = {}) => api('PUT', `/shop/orders/${code}/status`, { as: owner, body: { status, ...extra } });
const num = (x) => Number(L.money(x));
const renameCodes = () => q(`UPDATE payment.shop_payouts SET code = substr(code,1,18) || upper(substr(md5(random()::text),1,8)) WHERE shop_id = $1 AND code ~ '^PAY-[0-9]{6}-[0-9]{6}-[0-9A-F]{8}$' AND period_end > now() - interval '2 days'`, [shop.id]);

async function completedOrder({ as = 'khach34', qtys = [1], maxPrice = 900000 } = {}) {
  const vs = (await L.pickVariant({ shopId: shop.id, qty: 4, maxPrice })).slice(0, qtys.length);
  const placed = await L.placeOrder({ as, items: vs.map((v, i) => ({ variantId: v.id, qty: qtys[i] })), method: 'payos' });
  if (placed.status !== 201) throw new Error(`đặt lỗi ${placed.status} ${placed.code} ${placed.raw?.message}`);
  const kid = L.childOrders(placed)[0];
  await L.sendWebhook(await L.payosCodeOf(kid.code), num(kid.total), { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } });
  for (const s of ['confirmed', 'packing', 'shipping', 'delivered']) await sstat(kid.code, s);
  await q(`UPDATE "order".orders SET status = 'completed', delivered_at = now() - interval '8 days', completed_at = now() - interval '1 day' WHERE code = $1`, [kid.code]);
  return { code: kid.code, as };
}
const lastEnd = async () => (await q1(`SELECT max(period_end) AS e FROM payment.shop_payouts`))?.e;
async function runPeriod() {
  await renameCodes();
  const start = await lastEnd();
  return api('POST', '/admin/payouts/run', { as: 'accountant', body: { periodStart: new Date(start).toISOString(), periodEnd: new Date().toISOString(), shopId: shop.id } });
}
async function detail(id) { return (await api('GET', `/admin/payouts/${id}`, { as: 'accountant' })).data; }
const poRow = (id) => q1(`SELECT * FROM payment.shop_payouts WHERE id = $1`, [id]);
async function freshPeriod(mockMode) {
  const o = await completedOrder();
  await L.mockReset(); await L.mockBalance(5_000_000_000);
  if (mockMode) await L.mockCtl({ payout: mockMode });
  const run = await runPeriod();
  const p = run.data?.[0];
  if (!p) console.log('  (freshPeriod không tạo kỳ)', run.status, run.code, run.message);
  return { o, run, p, row: p ? await poRow(p.id) : null };
}

group('STL — theo dõi');
await L.setSetting('payout.auto_max_amount', 100000000);
await L.setSetting('payout.min_amount', 50000);
{
  const t = await freshPeriod('drop');
  let r = t.row;
  if (r.status === 'pending') { await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' }); r = await poRow(t.p.id); }
  await L.mockCtl({ payout: 'ok' });
  await api('POST', `/admin/payouts/${t.p.id}/reconcile`, { as: 'accountant' });
  const mockPo = (await L.mockState()).payouts.filter((p) => p.referenceId.startsWith(t.p.code));
  await L.mockPayoutState({ id: mockPo[0].id }, 'SUCCEEDED');
  await q(`UPDATE payment.shop_payouts SET updated_at = now() - interval '5 minutes' WHERE id = $1`, [t.p.id]);
  const j = L.runJob('payout-reconcile');
  r = await poRow(t.p.id);
  check('STL-08d', 'job đối chiếu định kỳ (kỳ đã processing > 60s) ⇒ paid', r.status === 'paid', { status: r.status, job: j });
}
{
  const t = await freshPeriod('drop_before');
  let r = t.row;
  if (r.status === 'pending') { await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' }); r = await poRow(t.p.id); }
  check('STL-08e0', 'timeout trước khi PayOS nhận ⇒ kỳ unknown', r.status === 'unknown', { status: r.status });
  await L.mockCtl({ payout: 'ok' });
  await api('POST', `/admin/payouts/${t.p.id}/reconcile`, { as: 'accountant' });
  r = await poRow(t.p.id);
  check('STL-08e1', 'tra sớm (< 10 phút) mà PayOS chưa thấy ⇒ CHỜ thêm, giữ unknown (không kết luận vội)', r.status === 'unknown', { status: r.status });
  await q(`UPDATE payment.shop_payouts SET gateway_attempted_at = now() - interval '15 minutes' WHERE id = $1`, [t.p.id]);
  await api('POST', `/admin/payouts/${t.p.id}/reconcile`, { as: 'accountant' });
  r = await poRow(t.p.id);
  check('STL-08e2', 'sau 15 phút PayOS vẫn không có lệnh ⇒ failed (not_received), cho phép chạy lại', r.status === 'failed' && r.gateway_status === 'not_received', { status: r.status, gw: r.gateway_status });
  await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' });
  const mockPo = (await L.mockState()).payouts.filter((p) => p.referenceId.startsWith(t.p.code));
  r = await poRow(t.p.id);
  check('STL-08e3', 'chạy lại ⇒ processing và PayOS có đúng 1 lệnh', r.status === 'processing' && mockPo.length === 1, { status: r.status, n: mockPo.length, refs: mockPo.map((p) => p.referenceId) });
}
{
  await L.setSetting('payout.min_amount', 100000000);
  const t = await freshPeriod();
  const deferredNet = Number(t.row.net_payout);
  await L.setSetting('payout.min_amount', 50000);
  const t2 = await freshPeriod();
  const net2 = Number(t2.row.net_payout);
  const lines = (await detail(t2.p.id)).lines;
  const thisOnly = lines.reduce((a, l) => a + (l.kind === 'sale' ? num(l.gross) - num(l.commission) : -(num(l.gross) - num(l.commission))), 0);
  check('STL-04c', 'kỳ deferred được CỘNG vào thực nhận của kỳ kế (carried), shop không mất tiền', t.row.status === 'deferred' && net2 === thisOnly + deferredNet, { deferredNet, thisOnly, net2, carried: Number(t2.row.carried_debt), prevStatus: t.row.status });
  check('STL-04d', 'kỳ deferred đã cộng sang kỳ kế ⇒ trạng thái merged (không còn gây hiểu nhầm "chưa trả")', (await poRow(t.p.id)).status === 'merged', { status: (await poRow(t.p.id)).status });
}
{
  const o = await completedOrder();
  await api('PATCH', `/admin/shops/${shop.id}/suspend`, { as: 'manager', body: { reason: 'Khoá thử lần 2' } });
  await L.mockReset(); await L.mockBalance(5_000_000_000);
  const run = await runPeriod();
  const p = run.data?.[0];
  const rel = await api('POST', `/admin/payouts/${p.id}/release`, { as: 'accountant' });
  const r = await poRow(p.id);
  check('STL-12b', 'mở giữ khi shop CÒN bị khoá: không chuyển trạng thái (vẫn held)', r.status === 'held', { st: rel.status, status: r.status });
  check('STL-12b2', 'phản hồi API khi "mở giữ" nhưng không mở được: 409 PAYOUT_STILL_HELD kèm lý do', rel.status === 409 && rel.code === 'PAYOUT_STILL_HELD' && /khoá/.test(rel.message ?? ''), { st: rel.status, code: rel.code, message: rel.message });
  await api('PATCH', `/admin/shops/${shop.id}/approve`, { as: 'manager' });
  await api('POST', `/admin/payouts/${p.id}/release`, { as: 'accountant' });
}
{
  const o = await completedOrder();
  await renameCodes();
  const start = await lastEnd();
  await L.mockReset(); await L.mockBalance(5_000_000_000);
  const body = { periodStart: new Date(start).toISOString(), periodEnd: new Date().toISOString(), shopId: shop.id };
  const [a, b] = await Promise.all([api('POST', '/admin/payouts/run', { as: 'accountant', body }), api('POST', '/admin/payouts/run', { as: 'admin', body })]);
  const lines = await q(`SELECT count(*)::int AS n FROM payment.shop_payout_lines WHERE order_code = $1 AND kind = 'sale'`, [o.code]);
  const periods = await q(`SELECT count(*)::int AS n FROM payment.shop_payouts WHERE shop_id = $1 AND period_start >= $2`, [shop.id, start]);
  const sends = (await L.mockState()).payouts.length;
  check('CONC-06', 'hai người chạy đối soát ĐỒNG THỜI cho cùng shop ⇒ đúng 1 dòng SALE, 1 kỳ, ≤ 1 lệnh chi', lines[0].n === 1 && periods[0].n === 1 && sends <= 1, { a: a.status, b: b.status, sale: lines[0].n, periods: periods[0].n, sends });
}
{
  const o = await completedOrder();
  const start = await lastEnd();
  const r = await api('POST', '/admin/payouts/run', { as: 'accountant', body: { periodStart: new Date(start).toISOString(), periodEnd: new Date().toISOString(), shopId: shop.id } });
  const sale = await q1(`SELECT count(*)::int AS n FROM payment.shop_payout_lines WHERE order_code = $1`, [o.code]);
  check('STL-16x', 'chạy đối soát lần 2 TRONG CÙNG NGÀY cho cùng shop phải gom đơn mới (mã kỳ không được trùng)', sale.n === 1, { run: r.status, msg: r.message, saleLines: sale.n, hint: 'mã kỳ PAY-<yymmdd>-<yymmdd>-<shop> trùng ⇒ coi là "đã chạy" ⇒ 0 kỳ, đơn mới bị bỏ sót' });
}

L.saveResults(process.env.OUT ?? 'out-t05b.json');
const R = L.results;
console.log(`\nTỔNG nhóm 05b: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
