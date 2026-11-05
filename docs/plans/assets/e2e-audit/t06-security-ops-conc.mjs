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

group('SEC — ma trận quyền (vai × endpoint). Cho phép = KHÔNG 401/403 (có thể 400/404/409 vì dữ liệu giả)');
const ROLES = ['khach11', 'owner:techzone', 'staff:techzone', 'manager', 'sales', 'accountant', 'marketing', 'admin'];
const ENDPOINTS = [
  // [nhãn, method, path, body, vai ĐƯỢC PHÉP theo docs/10 §12 (null = chỉ ghi nhận)]
  ['admin/orders (tìm đơn toàn sàn)', 'GET', '/admin/orders', undefined, ['manager', 'sales', 'accountant', 'admin']],
  ['admin/orders/:code/cancel', 'POST', `/admin/orders/${aOrder.code}/cancel`, { reason: 'x' }, ['manager', 'sales', 'admin']],
  ['admin/returns (xem)', 'GET', '/admin/returns', undefined, ['manager', 'sales', 'accountant', 'admin']],
  ['admin/returns/:id/resolve (phân xử)', 'POST', `/admin/returns/${aReturn.id}/resolve`, {}, ['sales', 'admin']],
  ['admin/refunds (xem)', 'GET', '/admin/refunds', undefined, ['manager', 'sales', 'accountant', 'admin']],
  ['admin/refunds/:id/process (chi hoàn)', 'POST', `/admin/refunds/${aRefund.id}/process`, {}, ['accountant', 'admin']],
  ['admin/refunds/:id/payee (xem số TK)', 'GET', `/admin/refunds/${aRefund.id}/payee`, undefined, ['accountant', 'admin']],
  ['admin/payments (xem)', 'GET', '/admin/payments', undefined, ['manager', 'sales', 'accountant', 'admin']],
  ['admin/payment-methods (đổi)', 'PUT', '/admin/payment-methods/payos', { isActive: true }, ['admin']],
  ['admin/payouts (xem)', 'GET', '/admin/payouts', undefined, ['manager', 'accountant', 'admin']],
  ['admin/payouts/run', 'POST', '/admin/payouts/run', {}, ['accountant', 'admin']],
  ['admin/payouts/:id/approve', 'POST', `/admin/payouts/${aPayout.id}/approve`, undefined, ['accountant', 'admin']],
  ['admin/payouts/:id/mark-paid', 'POST', `/admin/payouts/${aPayout.id}/mark-paid`, {}, ['accountant', 'admin']],
  ['admin/payouts/payos-balance', 'GET', '/admin/payouts/payos-balance', undefined, ['accountant', 'admin']],
  ['admin/wallets (xem ví cọc)', 'GET', '/admin/wallets', undefined, ['manager', 'accountant', 'admin']],
  ['admin/wallet-deposits/:id/approve', 'POST', `/admin/wallet-deposits/${aDeposit.id}/approve`, undefined, ['accountant', 'admin']],
  ['admin/shops/:id/wallet/adjust', 'POST', `/admin/shops/${shops.techzone.id}/wallet/adjust`, {}, ['admin']],
  ['admin/shops/:id/suspend', 'PATCH', `/admin/shops/${UUID0}/suspend`, { reason: 'abc' }, ['manager', 'admin']],
  ['admin/shops/:id/commission', 'PATCH', `/admin/shops/${UUID0}/commission`, {}, ['admin']],
  ['admin/reports/dashboard', 'GET', '/admin/reports/dashboard', undefined, ['manager', 'accountant', 'admin', 'marketing']],
  ['admin/users (danh sách nhân viên/khách)', 'GET', '/admin/users', undefined, ['admin']],
  ['shop/orders (xem)', 'GET', '/shop/orders', undefined, ['owner:techzone', 'staff:techzone']],
  ['shop/orders/:code/status', 'PUT', `/shop/orders/${aOrder.code}/status`, { status: 'confirmed' }, ['owner:techzone', 'staff:techzone']],
  ['shop/returns/:id/approve (duyệt đổi trả)', 'POST', `/shop/returns/${aReturn.id}/approve`, {}, ['owner:techzone']],
  ['shop/payouts (xem kỳ chi)', 'GET', '/shop/payouts', undefined, ['owner:techzone']],
  ['shop/wallet (ví cọc)', 'GET', '/shop/wallet', undefined, ['owner:techzone']],
  ['shop/wallet/deposit-requests (nộp cọc)', 'POST', '/shop/wallet/deposit-requests', {}, ['owner:techzone']],
  ['shop/me (sửa hồ sơ/ngân hàng)', 'PATCH', '/shop/me', {}, ['owner:techzone']],
  ['shop/members (nhân sự)', 'GET', '/shop/members', undefined, ['owner:techzone']],
  ['customer: orders của tôi', 'GET', '/orders', undefined, ['khach11']],
];
const matrix = [];
for (const [label, method, path, body, expected] of ENDPOINTS) {
  const row = { label, res: {} };
  for (const role of ROLES) {
    const r = await api(method, path, { as: role, body });
    row.res[role] = r.status;
  }
  const anon = await api(method, path, { body });
  row.res.anon = anon.status;
  matrix.push({ ...row, expected });
}
const allowed = (st) => st !== 401 && st !== 403;
let matrixFail = 0;
for (const m of matrix) {
  const actual = ROLES.filter((r) => allowed(m.res[r]));
  const anonOk = allowed(m.res.anon);
  const exp = [...m.expected];
  const extra = actual.filter((r) => !exp.includes(r));
  const missing = exp.filter((r) => !actual.includes(r));
  const ok = extra.length === 0 && missing.length === 0 && !anonOk;
  if (!ok) matrixFail++;
  check(`SEC-M`, `${m.label}: được phép = [${exp.join(',')}]`, ok, { actualAllowed: actual, extraAllowed: extra, missingAllowed: missing, anonStatus: m.res.anon, statuses: m.res });
}
note('SEC-M-sum', 'ma trận quyền', `${matrix.length - matrixFail}/${matrix.length} dòng khớp docs/10 §12`);

group('SEC — IDOR, rate limit, đầu vào độc');
{
  const k = await L.placeOrder({ as: 'khach11', items: [{ variantId: (await L.pickVariant({ shopId: shops.techzone.id, qty: 2 }))[0].id, qty: 1 }], method: 'cod' });
  const code = L.childOrders(k)[0].code;
  for (const [label, as, path, method, body] of [
    ['khách khác xem đơn', 'khach12', `/orders/${code}`, 'GET'],
    ['khách khác xem nhóm đơn', 'khach12', `/orders/groups/${k.data.code}`, 'GET'],
    ['shop khác xem đơn (shop/orders/:code)', 'owner:sneaker', `/shop/orders/${code}`, 'GET'],
    ['nhân viên shop khác đổi trạng thái', 'staff:techzone', `/shop/orders/${code}/status`, 'PUT', { status: 'confirmed' }],
  ]) {
    const r = await api(method ?? 'GET', path, { as, body });
    if (label.includes('nhân viên shop khác')) { /* staff:techzone là NV CÙNG shop techzone ⇒ được phép — bỏ qua */ continue; }
    check('SEC-IDOR', label + ' ⇒ 404/403', r.status === 404 || r.status === 403, { st: r.status });
  }
  const sqli = await api('GET', `/admin/orders?q=${encodeURIComponent("' OR 1=1 --")}`, { as: 'sales' });
  check('SEC-INJ1', 'tìm đơn với chuỗi SQL injection không lỗi 5xx', sqli.status < 500, { st: sqli.status });
  const xss = await L.placeOrder({ as: 'khach11', items: [{ variantId: (await L.pickVariant({ shopId: shops.techzone.id, qty: 2 }))[0].id, qty: 1 }], method: 'cod', note: '<script>alert(1)</script>"><img src=x onerror=alert(1)>' });
  check('SEC-INJ2', 'ghi chú đơn chứa HTML được lưu như chữ (không lỗi 5xx)', xss.status === 201, { st: xss.status });
  const big = await api('POST', '/orders', { as: 'khach11', body: { paymentMethodCode: 'cod', address: L.ADDRESS, note: 'x'.repeat(5000) } });
  check('SEC-INJ3', 'ghi chú quá dài ⇒ 400', big.status === 400, { st: big.status });
  const badUuid = await api('GET', '/admin/orders?shopId=not-a-uuid', { as: 'sales' });
  check('SEC-INJ4', 'shopId sai định dạng ⇒ 400', badUuid.status === 400, { st: badUuid.status });
  const badTrack = await sstat('techzone', code, 'confirmed');
  await sstat('techzone', code, 'packing');
  const js = await sstat('techzone', code, 'shipping', { carrier: 'other', trackingCode: 'XXXX1234', trackingUrl: 'javascript:alert(1)' });
  check('SEC-INJ5', 'trackingUrl "javascript:" bị từ chối', js.status === 400, { st: js.status });
  await api('POST', `/orders/${code}/cancel`, { as: 'khach11', body: { reason: 'dọn' } });
}
{
  // brute force đăng nhập
  L.resetRateLimit();
  let blocked = 0, last = 0;
  for (let i = 0; i < 25; i++) {
    const r = await fetch(`${L.BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ email: 'khach11@ecofashion.vn', password: 'sai-mat-khau-' + i }) });
    last = r.status;
    if (r.status === 429) { blocked++; }
  }
  check('SEC-07a', 'đăng nhập sai liên tục ⇒ bị khoá tạm (429) sau một số lần', blocked > 0, { blocked, last });
  L.resetRateLimit();
  const ok = await fetch(`${L.BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ email: 'khach11@ecofashion.vn', password: process.env.E2E_PW_KHACH }) });
  check('SEC-07b', 'sau khi hết khoá đăng nhập đúng lại được', ok.status === 200, { st: ok.status });
  // đặt hàng quá nhiều: 10/10 phút/người
  const v = (await L.pickVariant({ shopId: shops.ngonviet.id, qty: 2 }))[0];
  let rl = 0;
  for (let i = 0; i < 13; i++) {
    const r = await L.placeOrder({ as: 'khach20', items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
    if (r.status === 429) rl++;
    if (r.status === 201) { const c = L.childOrders(r)[0]?.code; if (c) await api('POST', `/orders/${c}/cancel`, { as: 'khach20', body: { reason: 'dọn đơn thử' } }); }
  }
  check('SEC-07c', 'đặt hàng > 10 lần/10 phút ⇒ 429', rl > 0, { rateLimited: rl });
  L.resetRateLimit();
}

group('OPS — vận hành & quan sát');
{
  const h = await api('GET', '/health');
  check('OPS-00', 'GET /health trả UP (DB + Redis)', h.status === 200 && h.data?.status === 'UP', h.raw);
  const hw = await api('GET', '/health/worker');
  check('OPS-01', '/health/worker báo trạng thái job nền (WP-05)', hw.status === 200, { st: hw.status, note: 'chưa có — worker chết không ai biết' });
  const s1 = await api('GET', `/admin/orders?q=${aOrder.code}`, { as: 'sales' });
  check('OPS-08a', 'CSKH tìm đơn theo mã đơn con KHÔNG cần chọn shop', s1.status === 200 && (s1.data?.content ?? []).some((o) => o.code === aOrder.code), { st: s1.status, n: s1.data?.content?.length });
  const grp = await q1(`SELECT g.code AS gcode, u.email FROM "order".order_groups g JOIN identity.users u ON u.id = g.user_id ORDER BY g.created_at DESC LIMIT 1`);
  const s2 = await api('GET', `/admin/orders?q=${grp.gcode}`, { as: 'sales' });
  check('OPS-08b', 'CSKH tìm theo MÃ NHÓM DHN…', (s2.data?.content ?? []).length > 0, { n: s2.data?.content?.length, code: grp.gcode });
  const s3 = await api('GET', `/admin/orders?q=${encodeURIComponent(grp.email)}`, { as: 'sales' });
  check('OPS-08c', 'CSKH tìm theo EMAIL khách', (s3.data?.content ?? []).length > 0, { n: s3.data?.content?.length });
  const s4 = await api('GET', '/admin/orders?q=0909000111', { as: 'sales' });
  check('OPS-08d', 'tìm theo SĐT người nhận', s4.status === 200 && (s4.data?.content ?? []).length > 0, { n: s4.data?.content?.length });
  const tl = await api('GET', `/admin/orders/${aOrder.code}/timeline`, { as: 'sales' });
  check('OPS-09', 'dòng thời gian đầy đủ một đơn (WP-05)', tl.status === 200, { st: tl.status, note: 'chưa có' });
  const dash = await api('GET', '/admin/reports/dashboard', { as: 'accountant' });
  const pend = dash.data?.pending ?? {};
  check('OPS-10', 'dashboard có số đếm hàng đợi kế toán (refundsNeedManual / payoutsAwaitingApproval / depositsPending — WP-05)', 'refundsNeedManual' in pend && 'payoutsAwaitingApproval' in pend && 'depositsPending' in pend, { keys: Object.keys(pend) });
  const outb = await q(`SELECT 'order' AS s, status, count(*)::int n FROM "order".outbox_events GROUP BY status UNION ALL SELECT 'payment', status, count(*)::int FROM payment.outbox_events GROUP BY status UNION ALL SELECT 'shop', status, count(*)::int FROM shop.outbox_events GROUP BY status ORDER BY 1,2`);
  note('OPS-02', 'trạng thái outbox (mail thất bại vì SMTP giả — bình thường trong môi trường test)', JSON.stringify(outb));
  const audit = await api('GET', '/admin/audit-logs', { as: 'admin' });
  note('OPS-audit', 'xem audit log order/payment', `GET /admin/audit-logs → HTTP ${audit.status} (chỉ identity; audit tiền/đơn không có màn xem)`);
  const nt = await api('GET', '/notifications?size=5', { as: 'sales' });
  check('NTF-api', 'API thông báo dùng được cho nhân viên sàn (web quản trị chưa có chuông)', nt.status === 200, { st: nt.status });
  const noBell = await q1(`SELECT count(*)::int AS n FROM system.notifications n JOIN identity.users u ON u.id = n.user_id WHERE u.email IN ('sales@ecofashion.vn','accountant@ecofashion.vn') AND n.read_at IS NULL`);
  note('NTF-unread', 'thông báo chưa đọc tồn đọng của CSKH + kế toán', `${noBell.n} — không giao diện nào để đọc`);
}

group('NTF — ai nhận thông báo gì trong một vòng đời đơn thật (ghi nhận)');
{
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
  await api('POST', `/shop/returns/${ret.data.id}/approve`, { as: 'owner:techzone', body: { returnAddress: { name: 'K', phone: '0909000222', address: '1 Đường Thử' } } });
  await api('POST', `/returns/${ret.data.id}/ship-back`, { as: 'khach11', body: { carrier: 'GHN', trackingCode: 'GHN-NTF' } });
  await api('POST', `/shop/returns/${ret.data.id}/receive`, { as: 'owner:techzone', body: { condition: 'ok' } });
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
  const shopNew = steps[0].rows.filter((r) => r.email === 'techzone@ecofashion.vn');
  check('NTF-01a', 'chủ shop nhận thông báo đơn mới', shopNew.length >= 1, { n: shopNew.length });
  const acctRefund = steps[5].rows.filter((r) => r.email.startsWith('accountant@') && r.title.includes(kid.code));
  check('NTF-01b', 'kế toán được báo khi có khoản hoàn mới cần xử lý (không chỉ khi lỗi)', acctRefund.length >= 1, { n: acctRefund.length, note: 'WP-04 §2.3' });
  const custRefund = steps[5].rows.filter((r) => r.email === 'khach11@ecofashion.vn' && /hoàn/i.test(r.title));
  check('NTF-01c', 'khách được báo khi hoàn tiền xong', custRefund.length >= 1, { n: custRefund.length });
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
  const [a, b] = await Promise.all([L.sendWebhook(payos, num(kid.total), { reference: 'CONC-A' }), L.sendWebhook(payos, num(kid.total), { reference: 'CONC-B' })]);
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
  const v = (await L.pickVariant({ shopId: shops.ngonviet.id, qty: 3 }))[0];
  const p = await L.placeOrder({ as: 'khach24', items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
  const kid = L.childOrders(p)[0];
  const st0 = await L.stock(v.id);
  const [a, b] = await Promise.all([sstat('ngonviet', kid.code, 'confirmed'), api('PUT', `/shop/orders/${kid.code}/status`, { as: 'staff:ngonviet', body: { status: 'confirmed' } })]);
  const st1 = await L.stock(v.id);
  check('CONC-09', '2 người cùng bấm "xác nhận" ⇒ trừ kho MỘT lần', Number(st0.stock) - Number(st1.stock) === 1, { a: a.status, b: b.status, st0, st1 });
  await api('POST', `/shop/orders/${kid.code}/cancel`, { as: 'owner:ngonviet', body: { reason: 'Dọn đơn thử nghiệm đồng thời' } });
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

L.saveResults(process.env.OUT ?? 'out-t06.json');
const R = L.results;
console.log(`\nTỔNG nhóm 06: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
// in ma trận để đưa vào báo cáo
console.log('\nMA TRẬN (status theo vai):');
for (const m of matrix) console.log(m.label.padEnd(48), ROLES.map((r) => String(m.res[r]).padStart(4)).join(' '), ' anon', m.res.anon);
console.log('vai:'.padEnd(48), ROLES.map((r) => r.slice(0, 4).padStart(4)).join(' '));
process.exit(0);
