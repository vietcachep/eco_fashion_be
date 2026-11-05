/* Nhóm 06: phân quyền (ma trận vai × endpoint) · IDOR · rate limit · vận hành/quan sát · thông báo thực tế · đồng thời. */
import * as L from './lib.mjs';
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.stack ?? e); process.exit(3); });
const { check, group, api, q, q1, note } = L;
const shops = {};
for (const s of ['techzone', 'ngonviet', 'sneaker', 'nhaxinh', 'mobilehub']) shops[s] = await L.shopBySlug(s);
await L.mockReset(); await L.mockBalance(5_000_000_000);
const num = (x) => Number(L.money(x));
const sstat = (slug, code, status, extra = {}) => api('PUT', `/shop/orders/${code}/status`, { as: `owner:${slug}`, body: { status, ...extra } });

// ---------- dữ liệu tham chiếu để gọi endpoint ----------
const aOrder = await q1(`SELECT code FROM "order".orders WHERE shop_id = $1 AND is_deleted = false ORDER BY created_at DESC LIMIT 1`, [shops.techzone.id]);
const aRefund = await q1(`SELECT id FROM payment.refunds ORDER BY created_at DESC LIMIT 1`);
const aPayout = await q1(`SELECT id FROM payment.shop_payouts ORDER BY created_at DESC LIMIT 1`);
const aReturn = await q1(`SELECT id FROM "order".return_requests ORDER BY created_at DESC LIMIT 1`);
const aDeposit = await q1(`SELECT id FROM payment.shop_cod_deposits ORDER BY created_at DESC LIMIT 1`);
const UUID0 = '00000000-0000-4000-8000-000000000000';


group('SEC — rate limit thật (không tự reset)');
{
  const tok = await L.login('khach20');
  const v = (await L.pickVariant({ shopId: shops.ngonviet.id, qty: 2 }))[0];
  let statuses = [];
  for (let i = 0; i < 13; i++) {
    await fetch(`${L.BASE}/cart`, { method: 'DELETE', headers: { authorization: `Bearer ${tok}`, connection: 'close' } });
    await fetch(`${L.BASE}/cart/items`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ variantId: v.id, quantity: 1 }) });
    const r = await fetch(`${L.BASE}/orders`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ paymentMethodCode: 'cod', address: L.ADDRESS }) });
    statuses.push(r.status);
    if (r.status === 201) { const j = await r.json(); const c = j.data?.orders?.[0]?.code; if (c) await fetch(`${L.BASE}/orders/${c}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ reason: 'dọn đơn thử' }) }); }
  }
  check('SEC-07c', 'đặt hàng > 10 lần/10 phút/người ⇒ 429', statuses.includes(429), { statuses });
  L.resetRateLimit();
  const okLogin = await fetch(`${L.BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ email: 'khach11@ecofashion.vn', password: process.env.E2E_PW_KHACH }) });
  check('SEC-07b', 'sau khi mở khoá, đăng nhập đúng được', okLogin.status === 200, { st: okLogin.status });
}
group('NTF — ai nhận thông báo gì trong một vòng đời đơn thật (ghi nhận)');
{
  // Hoàn nhỏ (≤ refund.auto_max_amount) tự chi nên kế toán KHÔNG cần được báo (PLAN-0040 2b) — bài này kiểm đường "cần kế toán xử lý" ⇒ tắt tự chi trong bài, trả lại sau.
  const autoMaxBefore = await L.getSetting('refund.auto_max_amount');
  await L.setSetting('refund.auto_max_amount', 0);
  const t0 = new Date();
  const v = (await L.pickVariant({ shopId: shops.techzone.id, qty: 4, maxPrice: 900000 })).slice(0, 2);
  const placed = await L.placeOrder({ as: 'khach11', items: v.map((x) => ({ variantId: x.id, qty: 1 })), method: 'payos' });
  const kid = L.childOrders(placed)[0];
  const T = (label) => ({ label, t: new Date() });
  const steps = [];
  const snap = async (label) => { steps.push({ label, rows: await q(`SELECT u.email, n.title FROM system.notifications n JOIN identity.users u ON u.id = n.user_id WHERE n.created_at >= $1 ORDER BY n.created_at`, [t0]) }); };
  await snap('sau khi đặt hàng');
  await L.sendWebhook(await L.payosCodeOf(kid.code), num(kid.total), { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } });
  await snap('sau khi thanh toán');
  await sstat('techzone', kid.code, 'confirmed'); await sstat('techzone', kid.code, 'packing'); await sstat('techzone', kid.code, 'shipping'); await sstat('techzone', kid.code, 'delivered');
  await snap('sau khi giao');
  const items = (await api('GET', `/orders/${kid.code}`, { as: 'khach11' })).data.items;
  const ret = await api('POST', `/orders/${kid.code}/returns`, { as: 'khach11', body: { reasonCode: 'defective', reason: 'Lỗi', items: [{ orderItemId: items[0].id, quantity: 1 }], evidence: [{ type: 'image', url: '/static/uploads/audit.jpg', name: 'a.jpg' }] } });
  await snap('sau khi khách tạo đổi trả');
  await api('POST', `/shop/returns/${ret.data.id}/approve`, { as: 'owner:techzone', body: { returnAddress: { name: 'Kho kiểm thử', phone: '0909000222', address: '1 Đường Thử, Quận 7, TP.HCM' } } });
  await api('POST', `/returns/${ret.data.id}/ship-back`, { as: 'khach11', body: { carrier: 'GHN', trackingCode: 'GHN-NTF' } });
  const rcv = await api('POST', `/shop/returns/${ret.data.id}/receive`, { as: 'owner:techzone', body: { condition: 'ok' } });
  console.log('  DEBUG return flow', ret.status, rcv.status, rcv.code, rcv.message);
  await snap('sau khi shop nhận hàng trả');
  const rf = (await api('GET', '/admin/refunds?size=100', { as: 'accountant' })).data.content.find((r) => r.orderCode === kid.code);
  await api('POST', `/admin/refunds/${rf.id}/process`, { as: 'accountant', body: {} });
  const po = (await L.mockState()).payouts.at(-1);
  await L.mockPayoutState({ id: po.id }, 'SUCCEEDED');
  L.runJob('refund-reconcile');
  await snap('sau khi hoàn tiền xong');
  let prev = 0;
  const summary = [];
  for (const s of steps) {
    const fresh = s.rows.slice(prev); prev = s.rows.length;
    const byUser = {};
    for (const r of fresh) { (byUser[r.email] ??= []).push(r.title.replace(kid.code, '<đơn>')); }
    summary.push(`${s.label}: ` + Object.entries(byUser).map(([e, t]) => `${e.split('@')[0]}[${t.length}]`).join(' '));
  }
  console.log('  ' + summary.join('\n  '));
  const staffNew = steps[0].rows.filter((r) => /^(admin|manager|sales|accountant|warehouse|marketing)@/.test(r.email) && /Đơn mới/.test(r.title));
  check('NTF-03', 'đơn mới KHÔNG gửi cho nhân viên sàn không liên quan (kế toán/kho/admin…) — chống spam; dùng số đếm dashboard', staffNew.length === 0, { recipients: staffNew.map((r) => r.email.split('@')[0]) });
  // Thông báo đơn mới đi qua outbox (~3s) nên ảnh chụp ngay sau khi đặt hàng chưa có — xét ảnh chụp cuối (tích luỹ từ t0).
  const shopNew = steps[steps.length - 1].rows.filter((r) => r.email === 'techzone@ecofashion.vn' && /Đơn mới/.test(r.title));
  check('NTF-01a', 'chủ shop nhận thông báo đơn mới', shopNew.length >= 1, { n: shopNew.length });
  const acctRefund = steps[5].rows.filter((r) => r.email.startsWith('accountant@') && r.title.includes(kid.code));
  check('NTF-01b', 'kế toán được báo khi có khoản hoàn mới cần xử lý (không chỉ khi lỗi)', acctRefund.length >= 1, { n: acctRefund.length, note: 'WP-04 §2.3' });
  const custRefund = steps[5].rows.filter((r) => r.email === 'khach11@ecofashion.vn' && /hoàn/i.test(r.title));
  check('NTF-01c', 'khách được báo khi hoàn tiền xong', custRefund.length >= 1, { n: custRefund.length });
  await L.setSetting('refund.auto_max_amount', autoMaxBefore ?? 2000000);
}

group('CONC — đồng thời giữa người, webhook và job');
{
  // CONC-02: webhook vs huỷ quá hạn
  const v = (await L.pickVariant({ shopId: shops.ngonviet.id, qty: 3 }))[0];
  const p = await L.placeOrder({ as: 'khach21', items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  const kid = L.childOrders(p)[0];
  const payos = await L.payosCodeOf(kid.code);
  await L.mockPay(payos, num(kid.total));
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '30 minutes' WHERE code = $1`, [kid.code]);
  const [wh, job] = await Promise.all([L.sendWebhook(payos, num(kid.total), { payer: { bin: '970436', name: 'A', number: '123456789' } }), Promise.resolve(L.runJob('cancel-expired'))]);
  const o = await L.orderRow(kid.code);
  const rf = await L.refundRows(kid.code);
  const consistent = (o.payment_status === 'paid' && o.status === 'pending') || (o.status === 'cancelled' && o.payment_status === 'paid' && rf.length === 1);
  check('CONC-02', 'webhook đến ĐỒNG THỜI job huỷ quá hạn: không "huỷ + đã trả mà không hoàn"', consistent, { wh: wh.status, status: o.status, ps: o.payment_status, refunds: rf.length });
}
{
  // CONC-07: 2 webhook đồng thời
  const v = (await L.pickVariant({ shopId: shops.techzone.id, qty: 3 }))[0];
  const st0 = await L.stock(v.id);
  const p = await L.placeOrder({ as: 'khach22', items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  const kid = L.childOrders(p)[0];
  const payos = await L.payosCodeOf(kid.code);
  const [a, b] = await Promise.all([L.sendWebhook(payos, num(kid.total), { reference: 'CONC-A' }), L.sendWebhook(payos, num(kid.total), { reference: 'CONC-A' })]); // PayOS GỬI LẠI cùng một khoản (cùng mã giao dịch) — hai mã khác nhau là hai lần chuyển tiền thật (xem PAY-09)
  const o = await L.orderRow(kid.code);
  const paidNotifs = await q(`SELECT count(*)::int AS n FROM system.notifications n JOIN identity.users u ON u.id = n.user_id WHERE u.email = 'khach22@ecofashion.vn' AND n.title LIKE $1`, [`%${kid.code}%`]);
  const tx = await q(`SELECT count(*)::int AS n FROM payment.payment_transactions WHERE payment_id = (SELECT id FROM payment.payments WHERE order_code = $1) AND status = 'ok' AND type = 'payos_webhook'`, [kid.code]);
  check('CONC-07', '2 webhook thanh toán đồng thời cho cùng đơn ⇒ ghi nhận paid MỘT lần (1 giao dịch ok), không hoàn trùng', o.payment_status === 'paid' && tx[0].n === 1 && (await L.refundRows(kid.code)).length === 0, { a: a.status, b: b.status, ps: o.payment_status, okTx: tx[0].n, refunds: (await L.refundRows(kid.code)).length });
}
{
  // CONC-08: khách huỷ ĐỒNG THỜI tiền về
  const v = (await L.pickVariant({ shopId: shops.techzone.id, qty: 3 }))[0];
  const p = await L.placeOrder({ as: 'khach23', items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  const kid = L.childOrders(p)[0];
  const payos = await L.payosCodeOf(kid.code);
  const [c, w] = await Promise.all([api('POST', `/orders/${kid.code}/cancel`, { as: 'khach23', body: { reason: 'Huỷ cùng lúc tiền về' } }), L.sendWebhook(payos, num(kid.total), { payer: { bin: '970436', name: 'A', number: '123456789' } })]);
  const o = await L.orderRow(kid.code);
  const rf = await L.refundRows(kid.code);
  const ok = (o.status === 'cancelled' && o.payment_status === 'paid' && rf.length === 1 && num({ amount: rf[0].amount }) === num(kid.total)) || (o.status === 'pending' && o.payment_status === 'paid' && rf.length === 0);
  check('CONC-08', 'khách huỷ ĐỒNG THỜI webhook tiền về ⇒ hoặc huỷ+hoàn đủ, hoặc giữ đơn đã trả — không mất tiền khách', ok, { c: c.status, w: w.status, status: o.status, ps: o.payment_status, refunds: rf.map((r) => r.amount) });
}
{
  // CONC-09: 2 shop-confirm đồng thời ⇒ trừ kho MỘT lần
  const v = (await L.pickVariant({ shopId: shops.techzone.id, qty: 3 }))[0];
  const p = await L.placeOrder({ as: 'khach24', items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
  const kid = L.childOrders(p)[0];
  const st0 = await L.stock(v.id);
  const [a, b] = await Promise.all([sstat('techzone', kid.code, 'confirmed'), api('PUT', `/shop/orders/${kid.code}/status`, { as: 'staff:techzone', body: { status: 'confirmed' } })]);
  const st1 = await L.stock(v.id);
  check('CONC-09', '2 người cùng bấm "xác nhận" ⇒ trừ kho MỘT lần', Number(st0.stock) - Number(st1.stock) === 1, { a: a.status, b: b.status, st0, st1 });
  await api('POST', `/shop/orders/${kid.code}/cancel`, { as: 'owner:techzone', body: { reason: 'Dọn đơn thử nghiệm đồng thời' } });
}
{
  // CONC-10: hai yêu cầu đổi trả cùng dòng
  const v = (await L.pickVariant({ shopId: shops.techzone.id, qty: 3, maxPrice: 900000 }))[0];
  const p = await L.placeOrder({ as: 'khach25', items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  const kid = L.childOrders(p)[0];
  await L.sendWebhook(await L.payosCodeOf(kid.code), num(kid.total), { payer: { bin: '970436', name: 'A', number: '123456789' } });
  for (const s of ['confirmed', 'packing', 'shipping', 'delivered']) await sstat('techzone', kid.code, s);
  const items = (await api('GET', `/orders/${kid.code}`, { as: 'khach25' })).data.items;
  const body = { reasonCode: 'defective', reason: 'Lỗi', items: [{ orderItemId: items[0].id, quantity: 1 }], evidence: [{ type: 'image', url: '/static/uploads/audit.jpg', name: 'a.jpg' }] };
  const [a, b] = await Promise.all([api('POST', `/orders/${kid.code}/returns`, { as: 'khach25', body }), api('POST', `/orders/${kid.code}/returns`, { as: 'khach25', body })]);
  const n = await q1(`SELECT count(*)::int AS n FROM "order".return_requests WHERE order_code = $1 AND status NOT IN ('cancelled','expired','rejected')`, [kid.code]);
  check('CONC-10', 'khách bấm tạo đổi trả 2 lần đồng thời ⇒ chỉ MỘT yêu cầu mở', n.n === 1, { a: a.status, b: b.status, open: n.n });
}


L.saveResults(process.env.OUT ?? 'out-t06b.json');
const R = L.results;
console.log(`\nTỔNG nhóm 06b: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
