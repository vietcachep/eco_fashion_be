/* Nhóm 01: dựng ví cọc theo luồng thật + hành trình mua bán hoàn chỉnh (PayOS và COD) từ giỏ hàng tới chi trả shop. */
import * as L from './lib.mjs';
const { check, group, api, q, q1 } = L;
const results = L.results;
const SLUGS = ['techzone', 'ngonviet', 'sneaker', 'nhaxinh', 'mobilehub', 'sportplanet'];
const T = {}; // shop theo slug

group('SETUP — ví cọc COD theo luồng thật (WAL-01)');
for (const s of SLUGS) T[s] = await L.shopBySlug(s);
// Shop TechZone nộp cọc thật: yêu cầu → kế toán duyệt
const dep = await api('POST', '/shop/wallet/deposit-requests', { as: 'owner:techzone', body: { amount: '3000000', transferRef: `AUDIT-DEP-${Date.now()}`, note: 'audit' } });
check('WAL-01a', 'chủ shop gửi yêu cầu nộp cọc (200/201)', dep.status === 200 || dep.status === 201, dep);
const depId = dep.data?.id;
const apr = await api('POST', `/admin/wallet-deposits/${depId}/approve`, { as: 'accountant' });
check('WAL-01b', 'kế toán duyệt nộp cọc', apr.status === 200 || apr.status === 201, apr);
const w1 = await api('GET', '/shop/wallet', { as: 'owner:techzone' });
check('WAL-01c', 'ví TechZone tăng đúng 3.000.000 sau duyệt (≥ 3tr)', L.money(w1.data?.balance) >= 3000000n, w1.data);
const dupRef = await api('POST', '/shop/wallet/deposit-requests', { as: 'owner:techzone', body: { amount: '500000', transferRef: dep.data?.transferRef ?? 'x', note: 'trùng mã' } });
check('WAL-02', 'mã giao dịch nộp cọc trùng bị chặn (409)', dupRef.status === 409, { status: dupRef.status, code: dupRef.code });
const rej = await api('POST', '/shop/wallet/deposit-requests', { as: 'owner:techzone', body: { amount: '100', transferRef: `AUDIT-DEP-LOW-${Date.now()}` } });
check('WAL-03', 'nộp cọc dưới mức tối thiểu bị chặn hoặc ghi nhận để kế toán từ chối', [400, 409, 422].includes(rej.status) || rej.status === 201, { status: rej.status, code: rej.code, msg: rej.message });
if (rej.status === 201 || rej.status === 200) {
  const r2 = await api('POST', `/admin/wallet-deposits/${rej.data?.id}/reject`, { as: 'accountant', body: { reason: 'Không thấy khoản chuyển khớp' } });
  check('WAL-03b', 'kế toán từ chối khoản nộp cọc', r2.status === 200 || r2.status === 201, r2);
}
// các shop khác: chỉnh ví tay (admin) để có COD
for (const s of SLUGS.slice(1)) {
  const r = await api('POST', `/admin/shops/${T[s].id}/wallet/adjust`, { as: 'admin', body: { amount: '3000000', note: 'audit setup' } });
  check(`SETUP-${s}`, `admin cộng ví 3tr cho ${s}`, r.status === 200 || r.status === 201, r);
}
const adjForbid = await api('POST', `/admin/shops/${T.techzone.id}/wallet/adjust`, { as: 'accountant', body: { amount: '1000000', note: 'thử' } });
check('SEC-03w', 'kế toán KHÔNG chỉnh ví tay được (403)', adjForbid.status === 403, { status: adjForbid.status });

group('E2E-A — PayOS: giỏ → đặt → trả (webhook) → xác nhận → đóng gói → giao → hoàn tất → chi trả → PayOS chi');
const vs = await L.pickVariant({ shopId: T.techzone.id, qty: 3 });
const v = vs[0];
const before = await L.stock(v.id);
const placed = await L.placeOrder({ as: 'khach11', items: [{ variantId: v.id, qty: 2 }], method: 'payos' });
check('CK-01a', 'đặt hàng PayOS thành công (201)', placed.status === 201, placed.raw);
const grp = placed.data;
const kid = L.childOrders(placed)[0];
check('CK-01b', 'mã nhóm DHN…, đơn con DH…, pending/unpaid', /^DHN\d+/.test(grp?.code) && /^DH\d+/.test(kid?.code) && kid?.status === 'pending' && kid?.paymentStatus === 'unpaid', { g: grp?.code, k: kid?.code, s: kid?.status });
const afterOrder = await L.stock(v.id);
check('CK-01c', 'giữ tồn: reserved tăng đúng 2, stock chưa trừ', Number(afterOrder.reserved) - Number(before.reserved) === 2 && Number(afterOrder.stock) === Number(before.stock), { before, afterOrder });
const pay = (await L.paymentRows(kid.code))[0];
const diffMin = (new Date(pay.expires_at) - Date.now()) / 60000;
check('CK-01d', 'payment pending + hạn thanh toán ≈ 30 phút', pay?.status === 'pending' && diffMin > 25 && diffMin <= 31, { status: pay?.status, diffMin });
const payosCode = await L.payosCodeOf(kid.code);
check('CK-01e', 'có link PayOS giả (mock nhận 1 link)', !!payosCode && (await L.mockState()).links.some((l) => String(l.orderCode) === String(payosCode)), { payosCode });
const total = Number(L.money(kid.total));
const wh = await L.sendWebhook(payosCode, total, { payer: { bin: '970436', name: 'NGUYEN KIEM THU', number: '0011223344' } });
check('PAY-01a', 'webhook đã thanh toán đúng số tiền (200)', wh.status === 200, wh);
const o1 = await L.orderRow(kid.code);
check('PAY-01b', 'đơn: payment_status=paid, status vẫn pending chờ shop xác nhận', o1.payment_status === 'paid' && o1.status === 'pending', o1);
const wh2 = await L.sendWebhook(payosCode, total, { reference: 'DUP-SAME' });
const o1b = await L.orderRow(kid.code);
check('PAY-02', 'webhook gửi lại không đổi gì thêm (idempotent, không tạo hoàn trùng)', o1b.payment_status === 'paid' && (await L.refundRows(kid.code)).length <= 1, { st: wh2.status, refunds: await L.refundRows(kid.code) });
// shop xử lý
const conf = await api('PUT', `/shop/orders/${kid.code}/status`, { as: 'owner:techzone', body: { status: 'confirmed' } });
check('FUL-01', 'shop xác nhận đơn PayOS đã trả', conf.status === 200, conf);
const afterConf = await L.stock(v.id);
check('FUL-01b', 'xác nhận ⇒ trừ kho thật (stock −2, reserved −2)', Number(before.stock) - Number(afterConf.stock) === 2 && Number(afterConf.reserved) === Number(before.reserved), { before, afterConf });
const pk = await api('PUT', `/shop/orders/${kid.code}/status`, { as: 'owner:techzone', body: { status: 'packing' } });
check('FUL-05', 'đóng gói', pk.status === 200, pk);
const sh = await api('PUT', `/shop/orders/${kid.code}/status`, { as: 'owner:techzone', body: { status: 'shipping', trackingUrl: 'https://ghn.vn/tracking/GHN123' } });
check('FUL-08', 'giao (shipping) kèm link vận đơn', sh.status === 200, sh);
const dl = await api('PUT', `/shop/orders/${kid.code}/status`, { as: 'owner:techzone', body: { status: 'delivered' } });
check('SHP-01', 'shop báo đã giao', dl.status === 200, dl);
// giả lập thời gian: đã giao 8 ngày trước ⇒ job tự hoàn tất
await q(`UPDATE "order".orders SET delivered_at = now() - interval '8 days' WHERE code = $1`, [kid.code]);
const ac = L.runJob('auto-complete');
const o2 = await L.orderRow(kid.code);
check('SHP-03', 'job tự hoàn tất đơn đã giao quá 7 ngày ⇒ completed', ac.ok && o2.status === 'completed', { ac, status: o2.status });
// đối soát chi trả
const periodEnd = new Date().toISOString();
const lastEnd = (await q1(`SELECT max(period_end) AS e FROM payment.shop_payouts WHERE shop_id = $1`, [T.techzone.id]))?.e;
const run = await api('POST', '/admin/payouts/run', { as: 'accountant', body: { periodStart: new Date(lastEnd ?? Date.now() - 40 * 86400000).toISOString(), periodEnd, shopId: T.techzone.id } });
check('STL-14', 'chạy đối soát CHO MỘT shop (shopId) được chấp nhận', run.status === 200 || run.status === 201, run);
const list = await api('GET', `/admin/payouts?shopId=${T.techzone.id}`, { as: 'accountant' });
const pItems = list.data?.content ?? [];
const po = pItems[0];
check('STL-01a', 'có kỳ chi cho TechZone', !!po, list.raw);
if (po) {
  const det = await api('GET', `/admin/payouts/${po.id}`, { as: 'accountant' });
  const lines = det.data?.lines ?? [];
  const line = lines.find((l) => l.orderCode === kid.code);
  check('STL-01b', 'kỳ chứa dòng SALE của đơn vừa hoàn tất', !!line, { lines: lines.slice(0, 3) });
  if (line) {
    const gross = Number(L.money(line.gross)), comm = Number(L.money(line.commission));
    const shipping = Number(L.money(o2.shipping_fee));
    const expectCommOnGoods = Math.round(((gross - shipping) * Number(o2.commission_rate_snapshot)) / 100);
    const expectCommOnTotal = Math.round((gross * Number(o2.commission_rate_snapshot)) / 100);
    check('STL-01c', 'hoa hồng KHÔNG tính trên phí ship (gốc = tiền hàng) — theo luật docs/10 §10', comm === expectCommOnGoods || shipping === 0, { gross, shipping, comm, expectCommOnGoods, expectCommOnTotal, rate: o2.commission_rate_snapshot });
  }
  note: {
    L.note('STL-status', 'trạng thái kỳ chi sau khi chạy', `${po.status} net=${JSON.stringify(po.netPayout ?? po.net_payout)} auto_enabled=${JSON.stringify(await L.getSetting('payout.auto_enabled'))}`);
  }
}
L.saveResults(process.env.OUT ?? 'out-t01.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\nTỔNG nhóm 01: ${results.filter((r) => r.ok).length}/${results.filter((r) => r.ok !== null).length} PASS`);
if (bad.length) console.log('FAIL:', bad.map((b) => b.id).join(', '));
process.exit(0);
