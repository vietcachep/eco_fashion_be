/* Nhóm 05: đối soát & chi trả shop (STL) — công thức, escrow, hoàn sau chi, hạn mức/duyệt, PayOS chi giả (OK / từ chối / timeout / treo), giữ tiền, chạy theo shop, đồng thời. */
import * as L from './lib.mjs';
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.stack ?? e); process.exit(3); });
const { check, group, api, q, q1, note } = L;
const SLUG = 'sportplanet';
const shop = await L.shopBySlug(SLUG);
const owner = `owner:${SLUG}`;
await L.mockReset();
await L.mockBalance(5_000_000_000);
const EV = [{ type: 'image', url: '/static/uploads/audit.jpg', name: 'audit.jpg' }];
const ADDR = { name: 'Kho kiểm thử', phone: '0909000222', address: '1 Đường Thử, Quận 7' };
const sstat = (code, status, extra = {}) => api('PUT', `/shop/orders/${code}/status`, { as: owner, body: { status, ...extra } });
const num = (x) => Number(L.money(x));

// cách ly dữ liệu: đơn mẫu cũ của shop coi như vừa giao hôm nay ⇒ còn trong escrow, không lọt kỳ chi
await q(`UPDATE "order".orders SET delivered_at = now(), completed_at = now() WHERE shop_id = $1 AND code LIKE 'DHSEED%'`, [shop.id]);
await q(`UPDATE "order".orders SET delivered_at = now() WHERE shop_id = $1 AND status = 'delivered' AND code NOT LIKE 'DHSEED%'`, [shop.id]);
await q(`DELETE FROM promotion.promotions WHERE code IN ('AUDITSHOP20')`);
await q(`INSERT INTO promotion.promotions (code, name, type, value, min_order_amount, usage_limit, usage_limit_per_user, used_count, applies_to, starts_at, ends_at, is_active, is_public, scope, shop_id) VALUES ('AUDITSHOP20','audit shop 20k','fixed_amount',20000,100000,NULL,20,0,'all', now() - interval '1 day', now() + interval '30 days', true, false, 'shop', $1)`, [shop.id]);
L.clearCaches();

/* Đơn PayOS đã trả, giao xong, và (tuỳ chọn) đã "hoàn tất + qua escrow" ⇒ đủ điều kiện vào kỳ chi. */
async function completedOrder({ as = 'khach34', voucherCodes, qtys = [1], eligible = true, maxPrice = 900000 } = {}) {
  const vs = (await L.pickVariant({ shopId: shop.id, qty: 4, maxPrice })).slice(0, qtys.length);
  const placed = await L.placeOrder({ as, items: vs.map((v, i) => ({ variantId: v.id, qty: qtys[i] })), method: 'payos', voucherCodes });
  if (placed.status !== 201) throw new Error(`đặt lỗi ${placed.status} ${placed.code} ${placed.raw?.message}`);
  const kid = L.childOrders(placed)[0];
  const total = num(kid.total);
  await L.sendWebhook(await L.payosCodeOf(kid.code), total, { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } });
  await sstat(kid.code, 'confirmed'); await sstat(kid.code, 'packing'); await sstat(kid.code, 'shipping', { trackingUrl: 'https://ghn.vn/t/AUDIT' });
  await sstat(kid.code, 'delivered');
  if (eligible) await q(`UPDATE "order".orders SET status = 'completed', delivered_at = now() - interval '8 days', completed_at = now() - interval '1 day' WHERE code = $1`, [kid.code]);
  const row = await L.orderRow(kid.code);
  const items = (await api('GET', `/orders/${kid.code}`, { as })).data.items;
  return { code: kid.code, as, total, row, items };
}
const lastEnd = async () => (await q1(`SELECT max(period_end) AS e FROM payment.shop_payouts`))?.e;
async function runPeriod(extra = {}) {
  // Lỗi đã biết (PAYOUT code trùng trong cùng ngày): đổi mã kỳ cũ của shop để chạy tiếp kịch bản
  await q(`UPDATE payment.shop_payouts SET code = substr(code,1,18) || upper(substr(md5(random()::text),1,8)) WHERE shop_id = $1 AND code ~ '^PAY-[0-9]{6}-[0-9]{6}-[0-9A-F]{8}$' AND period_end > now() - interval '2 days'`, [shop.id]);
  const start = await lastEnd();
  return api('POST', '/admin/payouts/run', { as: 'accountant', body: { periodStart: new Date(start ?? Date.now() - 60 * 86400000).toISOString(), periodEnd: new Date().toISOString(), shopId: shop.id, ...extra } });
}
const payoutsOf = async () => (await api('GET', `/admin/payouts?shopId=${shop.id}&size=50`, { as: 'accountant' })).data?.content ?? [];
async function detail(id) { return (await api('GET', `/admin/payouts/${id}`, { as: 'accountant' })).data; }
const poRow = (id) => q1(`SELECT * FROM payment.shop_payouts WHERE id = $1`, [id]);

group('STL — công thức kỳ chi & điều kiện vào kỳ');
await L.setSetting('payout.auto_max_amount', 100000000);
await L.setSetting('payout.min_amount', 50000);
let P1;
{
  const A = await completedOrder({ qtys: [1] });                                    // thường
  const B = await completedOrder({ qtys: [1], voucherCodes: ['AUDIT50K'] });         // voucher sàn 50k
  const C = await completedOrder({ qtys: [1], voucherCodes: ['AUDITSHOP20'] });      // voucher shop 20k
  const D = await completedOrder({ qtys: [1, 1] });                                  // 2 dòng — hoàn 1 dòng
  // E: đang trong escrow (giao hôm nay)
  const E = await completedOrder({ qtys: [1], eligible: false });
  // F: có đổi trả mở
  const F = await completedOrder({ qtys: [1] });
  await q(`UPDATE "order".orders SET delivered_at = now() - interval '2 days' WHERE code = $1`, [F.code]);
  const rf = await api('POST', `/orders/${F.code}/returns`, { as: F.as, body: { reasonCode: 'defective', reason: 'Lỗi', items: [{ orderItemId: F.items[0].id, quantity: 1 }], evidence: EV } });
  await q(`UPDATE "order".orders SET delivered_at = now() - interval '8 days' WHERE code = $1`, [F.code]); // qua escrow nhưng còn đổi trả mở
  // G: bị shop từ chối còn trong hạn khiếu nại
  const G = await completedOrder({ qtys: [1] });
  await q(`UPDATE "order".orders SET delivered_at = now() - interval '2 days' WHERE code = $1`, [G.code]);
  const rg = await api('POST', `/orders/${G.code}/returns`, { as: G.as, body: { reasonCode: 'defective', reason: 'Lỗi', items: [{ orderItemId: G.items[0].id, quantity: 1 }], evidence: EV } });
  await api('POST', `/shop/returns/${rg.data?.id}/reject`, { as: owner, body: { reason: 'Hàng không có lỗi như mô tả' } });
  await q(`UPDATE "order".orders SET delivered_at = now() - interval '8 days' WHERE code = $1`, [G.code]);
  // D: trả 1 dòng (hoàn xong) trước khi chi
  await q(`UPDATE "order".orders SET delivered_at = now() - interval '2 days' WHERE code = $1`, [D.code]);
  const rd = await api('POST', `/orders/${D.code}/returns`, { as: D.as, body: { reasonCode: 'defective', reason: 'Lỗi', items: [{ orderItemId: D.items[0].id, quantity: 1 }], evidence: EV } });
  await api('POST', `/shop/returns/${rd.data?.id}/approve`, { as: owner, body: { returnAddress: ADDR } });
  await api('POST', `/returns/${rd.data?.id}/ship-back`, { as: D.as, body: { carrier: 'GHN', trackingCode: 'GHN-STL-1' } });
  await api('POST', `/shop/returns/${rd.data?.id}/receive`, { as: owner, body: { condition: 'ok' } });
  const rfD = (await api('GET', '/admin/refunds?size=100', { as: 'accountant' })).data.content.find((r) => r.orderCode === D.code);
  await api('POST', `/admin/refunds/${rfD.id}/process`, { as: 'accountant', body: {} });
  const po1 = (await L.mockState()).payouts.at(-1);
  await L.mockPayoutState({ id: po1.id }, 'SUCCEEDED');
  L.runJob('refund-reconcile');
  await q(`UPDATE "order".orders SET delivered_at = now() - interval '8 days' WHERE code = $1`, [D.code]);
  const refundedD = num(rfD.amount);
  await L.mockReset(); await L.mockBalance(5_000_000_000);

  const run = await runPeriod();
  check('STL-14a', 'chạy đối soát cho MỘT shop (shopId) ⇒ trả đúng 1 kỳ cho shop đó', (run.status === 200 || run.status === 201) && (run.data ?? []).length === 1 && run.data[0].shopId === shop.id, { st: run.status, code: run.code, n: run.data?.length });
  const p = run.data?.[0];
  const det = await detail(p.id);
  const lines = det.lines;
  const sale = (o) => lines.find((l) => l.orderCode === o.code && l.kind === 'sale');
  const refundLine = lines.find((l) => l.kind === 'refund' && l.orderCode === D.code);
  check('STL-02a', 'kỳ chứa SALE của A, B, C, D', [A, B, C, D].every((o) => !!sale(o)), lines.map((l) => `${l.kind}:${l.orderCode}`));
  check('STL-02b', 'KHÔNG chứa đơn còn trong escrow (E)', !sale(E), lines.map((l) => l.orderCode));
  check('STL-02c', 'KHÔNG chứa đơn có đổi trả đang mở (F)', !sale(F), lines.map((l) => l.orderCode));
  check('STL-02d', 'KHÔNG chứa đơn bị shop từ chối còn hạn khiếu nại (G)', !sale(G), { hasG: !!sale(G) });
  const rateOf = (o) => Number(o.row.commission_rate_snapshot);
  const expect = (o) => {
    const r = o.row;
    const gross = Number(r.total) + Number(r.platform_discount) + Number(r.platform_shipping_discount ?? 0);
    const base = Number(r.subtotal) - (Number(r.shop_discount) - Number(r.shop_shipping_discount ?? 0));
    return { gross, commission: Math.round((base * rateOf(o)) / 100) };
  };
  for (const [name, o] of [['A', A], ['B', B], ['C', C]]) {
    const ex = expect(o), s = sale(o);
    check(`STL-01-${name}`, `SALE đơn ${name}: gross = tiền khách trả + trợ giá voucher sàn; hoa hồng = tỉ lệ × (tiền hàng − voucher shop), KHÔNG tính phí ship`, !!s && num(s.gross) === ex.gross && num(s.commission) === ex.commission, { line: s, expected: ex, subtotal: o.row.subtotal, ship: o.row.shipping_fee, platDisc: o.row.platform_discount, shopDisc: o.row.shop_discount });
  }
  const exD = expect(D);
  const ratio = refundedD / D.total;
  const expRefGross = Math.round(exD.gross * ratio), expRefComm = Math.round(exD.commission * ratio);
  check('STL-03a', 'dòng REFUND của đơn D (trả 1/2 dòng): doanh thu và hoa hồng đảo theo tỉ lệ số hoàn / tiền khách trả', !!refundLine && Math.abs(num(refundLine.gross) - expRefGross) <= 1 && Math.abs(num(refundLine.commission) - expRefComm) <= 1, { line: refundLine, expRefGross, expRefComm, refundedD, total: D.total });
  const sumSale = lines.filter((l) => l.kind === 'sale').reduce((a, l) => a + num(l.gross), 0);
  const sumComm = lines.filter((l) => l.kind === 'sale').reduce((a, l) => a + num(l.commission), 0);
  const refGross = lines.filter((l) => l.kind === 'refund').reduce((a, l) => a + num(l.gross), 0);
  const refComm = lines.filter((l) => l.kind === 'refund').reduce((a, l) => a + num(l.commission), 0);
  const expectNet = sumSale - sumComm - (refGross - refComm);
  const cur = await poRow(p.id);
  check('STL-01d', 'thực nhận = Σ(gross − hoa hồng) − (hoàn − hoa hồng hoàn) (− nợ mang sang)', Number(cur.net_payout) === expectNet - Number(cur.carried_debt), { net: Number(cur.net_payout), expectNet, carried: Number(cur.carried_debt), gross: Number(cur.gross_revenue), commission: Number(cur.commission), refundAmount: Number(cur.refund_amount) });
  note('STL-status0', 'trạng thái kỳ sau khi tạo (net trong ngưỡng, payout.auto_enabled=true trong dữ liệu mẫu)', `${cur.status}; gateway=${cur.gateway_status}; bankSnapshot=${JSON.stringify(cur.bank_snapshot)?.slice(0, 80)}`);
  // COD không vào kỳ chi
  P1 = { p, A, B, C, D };
}
{
  // idempotent: chạy lại cùng kỳ
  const start = await lastEnd();
  const again = await api('POST', '/admin/payouts/run', { as: 'accountant', body: { periodStart: new Date(Date.now() - 3 * 86400000).toISOString(), periodEnd: new Date().toISOString(), shopId: shop.id } });
  check('STL-15', 'chạy lại kỳ chồng ⇒ 409 PAYOUT_PERIOD_OVERLAP, không tạo trùng', again.status === 409 && /OVERLAP/.test(again.code ?? ''), { st: again.status, code: again.code });
  const nonAcct = await api('POST', '/admin/payouts/run', { as: 'sales', body: { periodStart: new Date(start).toISOString(), periodEnd: new Date().toISOString() } });
  check('SEC-03p', 'CSKH KHÔNG chạy đối soát (403)', nonAcct.status === 403, { st: nonAcct.status });
  const vendor = await api('POST', '/admin/payouts/run', { as: owner, body: { periodStart: new Date(start).toISOString(), periodEnd: new Date().toISOString() } });
  check('SEC-03p2', 'chủ shop KHÔNG chạy đối soát (403)', vendor.status === 403, { st: vendor.status });
  const future = await api('POST', '/admin/payouts/run', { as: 'accountant', body: { periodStart: new Date(start).toISOString(), periodEnd: new Date(Date.now() + 3 * 86400000).toISOString(), shopId: shop.id } });
  check('STL-15b', 'periodEnd ở tương lai ⇒ 400', future.status === 400, { st: future.status, code: future.code });
}

group('STL — gửi lệnh chi PayOS: thành công / treo / từ chối / timeout');
{
  const p = P1.p;
  let cur = await poRow(p.id);
  if (cur.status === 'pending') {
    const rt = await api('POST', `/admin/payouts/${p.id}/retry`, { as: 'accountant' });
    note('STL-07pre', 'kỳ đang pending ⇒ kế toán bấm "gửi lệnh chi"', `HTTP ${rt.status} ${rt.code ?? ''} status=${rt.data?.status}`);
    cur = await poRow(p.id);
  }
  check('STL-07a', 'lệnh chi gửi sang PayOS giả ⇒ kỳ processing (chưa paid)', cur.status === 'processing' && !!cur.provider_ref, { status: cur.status, ref: cur.provider_ref, gw: cur.gateway_status });
  const st = await L.mockState();
  const po = st.payouts.at(-1);
  check('STL-07b', 'PayOS giả nhận đúng số tiền + TK ngân hàng của shop', !!po && po.amount === Number(cur.net_payout) && po.toAccountNumber === cur.bank_snapshot?.accountNumber && po.toBin === cur.bank_snapshot?.bankCode, { po, net: Number(cur.net_payout), bank: [shop.bank_code, shop.bank_account_number] });
  const m1 = await api('POST', `/admin/payouts/${p.id}/mark-paid`, { as: 'accountant', body: { providerRef: 'FT-TAY-' + Date.now() } });
  check('STL-10a', 'đang processing (PayOS đã nhận lệnh): đánh dấu tay bị chặn khi chưa xác nhận PayOS không chi (chống chi trùng)', m1.status >= 400, { st: m1.status, code: m1.code, note: 'WP-02 §2.2' });
  await L.mockPayoutState({ id: po.id }, 'SUCCEEDED');
  const rc = await api('POST', `/admin/payouts/${p.id}/reconcile`, { as: 'accountant' });
  cur = await poRow(p.id);
  check('STL-07c', 'đối chiếu: PayOS SUCCEEDED ⇒ kỳ paid, có paid_at', cur.status === 'paid' && !!cur.paid_at, { rc: rc.status, status: cur.status });
  const rt2 = await api('POST', `/admin/payouts/${p.id}/retry`, { as: 'accountant' });
  check('STL-07d', 'kỳ đã paid không gửi lại được (4xx)', rt2.status >= 400, { st: rt2.status, code: rt2.code });
  const shopView = await api('GET', `/shop/payouts/${p.id}`, { as: owner });
  check('STL-07e', 'chủ shop xem được kỳ của mình, số TK che 4 số cuối', shopView.status === 200 && /^\*{4}\d{4}$/.test(shopView.data?.payout?.bankAccountMasked ?? shopView.data?.bankAccountMasked ?? ''), shopView.data?.payout?.bankAccountMasked);
  const otherShop = await api('GET', `/shop/payouts/${p.id}`, { as: 'owner:sneaker' });
  check('SEC-01p', 'shop khác xem kỳ chi của shop mình không phải ⇒ 404', otherShop.status === 404, { st: otherShop.status });
}
// kỳ tiếp theo cho các kịch bản lỗi
async function freshPeriod(mockMode) {
  const o = await completedOrder({ qtys: [1] });
  await L.mockReset(); await L.mockBalance(5_000_000_000);
  if (mockMode) await L.mockCtl({ payout: mockMode });
  const run = await runPeriod();
  const p = run.data?.[0];
  if (!p) console.log('  (freshPeriod không tạo kỳ)', run.status, run.code, run.message);
  return { o, run, p, row: p ? await poRow(p.id) : null };
}
{
  // từ chối chắc chắn
  const t = await freshPeriod('reject');
  let r = t.row;
  if (r.status === 'pending') { await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' }); r = await poRow(t.p.id); }
  check('STL-09a', 'PayOS từ chối chắc chắn (400) ⇒ kỳ failed, giữ lý do', r.status === 'failed' && !!r.fail_reason, { status: r.status, reason: r.fail_reason, gw: r.gateway_status, run: t.run.status });
  await L.mockCtl({ payout: 'ok' });
  const rt = await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' });
  const pos = (await L.mockState()).payouts;
  r = await poRow(t.p.id);
  check('STL-09b', 'chạy lại sau từ chối: gửi lệnh với khoá mới <mã kỳ>-<lần> (PayOS cache lỗi theo khoá cũ)', pos.length === 1 && /-\d+$/.test(pos[0].referenceId) && r.status === 'processing', { refs: pos.map((x) => x.referenceId), status: r.status, rt: rt.status, gw: r.gateway_status, attempt: r.gateway_attempt });
  await L.mockPayoutState({ id: pos[0].id }, 'FAILED');
  await api('POST', `/admin/payouts/${t.p.id}/reconcile`, { as: 'accountant' });
  r = await poRow(t.p.id);
  check('STL-09c', 'PayOS báo FAILED khi tra lại ⇒ failed', r.status === 'failed', { status: r.status });
  globalThis.failedPayout = t.p;
}
{
  // timeout sau khi PayOS có thể đã nhận lệnh
  const t = await freshPeriod('drop');
  let r = t.row;
  if (r.status === 'pending') { await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' }); r = await poRow(t.p.id); }
  check('STL-08a', 'timeout khi gửi lệnh chi ⇒ kỳ "unknown" (KHÔNG coi là failed)', r.status === 'unknown', { status: r.status, gw: r.gateway_status, reason: r.fail_reason });
  await L.mockCtl({ payout: 'ok' });
  const mp = await api('POST', `/admin/payouts/${t.p.id}/mark-paid`, { as: 'accountant', body: { providerRef: 'FT-TMO-' + Date.now() } });
  check('STL-08b', 'kỳ unknown: đánh dấu tay BỊ CHẶN khi chưa tra PayOS (PayOS có thể đã chi)', mp.status >= 400, { st: mp.status, code: mp.code });
  const rc = await api('POST', `/admin/payouts/${t.p.id}/reconcile`, { as: 'accountant' });
  r = await poRow(t.p.id);
  const mockPo = (await L.mockState()).payouts.filter((p) => p.referenceId.startsWith(t.p.code));
  check('STL-08c', 'đối chiếu theo referenceId: PayOS ĐÃ nhận lệnh ⇒ chuyển processing, không gửi lệnh thứ hai', r.status === 'processing' && mockPo.length === 1, { status: r.status, n: mockPo.length, rc: rc.status });
  await L.mockPayoutState({ id: mockPo[0].id }, 'SUCCEEDED');
  L.runJob('payout-reconcile');
  r = await poRow(t.p.id);
  check('STL-08d', 'job đối chiếu định kỳ ⇒ paid', r.status === 'paid', { status: r.status });
}
{
  // timeout TRƯỚC khi PayOS nhận
  const t = await freshPeriod('drop_before');
  let r = t.row;
  if (r.status === 'pending') { await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' }); r = await poRow(t.p.id); }
  await L.mockCtl({ payout: 'ok' });
  const rc = await api('POST', `/admin/payouts/${t.p.id}/reconcile`, { as: 'accountant' });
  r = await poRow(t.p.id);
  const mockPo = (await L.mockState()).payouts.filter((p) => p.referenceId.startsWith(t.p.code));
  check('STL-08e', 'timeout trước khi PayOS nhận + tra theo referenceId không thấy ⇒ an toàn gửi lại (cùng khoá), không bị kẹt unknown', ['processing', 'failed', 'pending'].includes(r.status) && mockPo.length <= 1, { status: r.status, n: mockPo.length, rc: rc.status });
  if (r.status !== 'processing') { await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' }); }
}
{
  // mã chứng từ chi trùng
  const t = await freshPeriod('reject');
  await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' });
  await L.mockCtl({ payout: 'ok' });
  const ref = 'FT-DUP-' + Date.now();
  const a = await api('POST', `/admin/payouts/${t.p.id}/mark-paid`, { as: 'accountant', body: { providerRef: ref, note: 'đã chuyển tay, đã tra PayOS không có lệnh' } });
  note('STL-10b', 'đánh dấu tay kỳ failed (kế toán đã tra PayOS)', `HTTP ${a.status} ${a.code ?? ''} status=${a.data?.status}`);
  const t2 = await freshPeriod('reject');
  await api('POST', `/admin/payouts/${t2.p.id}/retry`, { as: 'accountant' });
  await L.mockCtl({ payout: 'ok' });
  const b = await api('POST', `/admin/payouts/${t2.p.id}/mark-paid`, { as: 'accountant', body: { providerRef: ref } });
  check('STL-10', 'mã chứng từ chi trùng với kỳ khác ⇒ 409 (một chứng từ không đánh dấu nhiều kỳ)', b.status === 409, { st: b.status, code: b.code, note: 'WP-02 §2.2 unique providerRef' });
}

group('STL — duyệt vượt hạn mức, số dư, kỳ nhỏ, giữ tiền, đồng thời');
{
  await L.setSetting('payout.auto_max_amount', 10000);
  const t = await freshPeriod();
  check('STL-05a', 'thực nhận > payout.auto_max_amount ⇒ awaiting_approval, KHÔNG có lệnh chi nào gửi', t.row?.status === 'awaiting_approval' && (await L.mockState()).payouts.length === 0, { status: t.row?.status, n: (await L.mockState()).payouts.length });
  const noPerm = await api('POST', `/admin/payouts/${t.p.id}/approve`, { as: 'sales' });
  check('STL-05b', 'CSKH KHÔNG duyệt kỳ chi (403)', noPerm.status === 403, { st: noPerm.status });
  const retry = await api('POST', `/admin/payouts/${t.p.id}/retry`, { as: 'accountant' });
  check('STL-05c', 'kỳ chờ duyệt không "gửi lại" vòng qua bước duyệt (4xx)', retry.status >= 400, { st: retry.status });
  const ap = await api('POST', `/admin/payouts/${t.p.id}/approve`, { as: 'accountant' });
  const r = await poRow(t.p.id);
  check('STL-05d', 'kế toán duyệt ⇒ gửi PayOS ⇒ processing', (ap.status === 200 || ap.status === 201) && r.status === 'processing' && (await L.mockState()).payouts.length === 1, { st: ap.status, status: r.status });
  const ap2 = await api('POST', `/admin/payouts/${t.p.id}/approve`, { as: 'accountant' });
  check('STL-05e', 'duyệt lần hai ⇒ 4xx, không gửi lệnh thứ hai', ap2.status >= 400 && (await L.mockState()).payouts.length === 1, { st: ap2.status, n: (await L.mockState()).payouts.length });
  await L.setSetting('payout.auto_max_amount', 100000000);
}
{
  // số dư PayOS không đủ
  const o = await completedOrder({ qtys: [1] });
  await L.mockReset(); await L.mockBalance(1000);   // số dư thấp TRƯỚC khi chạy kỳ — hệ thống phải tra số dư trước khi gửi (AUD-07)
  const run = await runPeriod();
  const p = run.data?.[0];
  const r = p ? await poRow(p.id) : null;
  check('STL-06', 'số dư PayOS không đủ: KHÔNG gửi lệnh, kỳ pending + lý do nạp quỹ (không treo processing)', !!r && r.status === 'pending' && /số dư/i.test(r.fail_reason ?? '') && (await L.mockState()).payouts.length === 0, { status: r?.status, reason: r?.fail_reason, sent: (await L.mockState()).payouts.length });
  await L.mockBalance(5_000_000_000);
  if (p) {
    await api('POST', `/admin/payouts/${p.id}/retry`, { as: 'accountant' });
    const again = await poRow(p.id);
    check('STL-06c', 'nạp đủ quỹ rồi bấm Gửi lại ⇒ processing', again.status === 'processing', { status: again.status });
  }
  await L.mockBalance(5_000_000_000);
  const bal = await api('GET', '/admin/payouts/payos-balance', { as: 'accountant' });
  check('STL-06b', 'kế toán xem được số dư PayOS', bal.status === 200, bal.raw);
}
{
  // kỳ rất nhỏ ⇒ dồn kỳ sau
  await L.setSetting('payout.min_amount', 100000000);
  const t = await freshPeriod();
  check('STL-04', 'thực nhận < payout.min_amount ⇒ deferred (dồn kỳ sau), không chi', t.row?.status === 'deferred' && (await L.mockState()).payouts.length === 0, { status: t.row?.status });
  await L.setSetting('payout.min_amount', 50000);
  const t2 = await freshPeriod();
  const lines = (await detail(t2.p.id)).lines.map((l) => l.orderCode);
  note('STL-04b', 'kỳ sau kỳ deferred có gom phần dồn không', `kỳ mới có ${lines.length} dòng (đơn của kỳ deferred ${t.o.code} ${lines.includes(t.o.code) ? 'ĐƯỢC' : 'KHÔNG'} chuyển sang kỳ mới)`);
}
{
  // shop bị khoá ⇒ kỳ held
  const o = await completedOrder({ qtys: [1] });
  await api('PATCH', `/admin/shops/${shop.id}/suspend`, { as: 'manager', body: { reason: 'Khoá thử để kiểm tra giữ tiền chi trả' } });
  await L.mockReset(); await L.mockBalance(5_000_000_000);
  const run = await runPeriod();
  const r = run.data?.[0] ? await poRow(run.data[0].id) : null;
  check('STL-12a', 'shop bị khoá ⇒ kỳ chi ở trạng thái held, KHÔNG gửi lệnh chi', r?.status === 'held' && (await L.mockState()).payouts.length === 0, { status: r?.status, reason: r?.hold_reason, n: (await L.mockState()).payouts.length });
  const rel0 = await api('POST', `/admin/payouts/${r.id}/release`, { as: 'accountant' });
  check('STL-12b', 'mở giữ khi shop CÒN bị khoá ⇒ chặn (4xx)', rel0.status >= 400, { st: rel0.status, code: rel0.code });
  await api('PATCH', `/admin/shops/${shop.id}/approve`, { as: 'manager' });
  const rel = await api('POST', `/admin/payouts/${r.id}/release`, { as: 'accountant' });
  const r2 = await poRow(r.id);
  check('STL-12c', 'shop được mở khoá ⇒ mở giữ ⇒ kỳ đi tiếp (pending/processing/awaiting_approval)', rel.status < 300 && r2.status !== 'held', { st: rel.status, status: r2.status });
  const hold = await api('POST', '/admin/payouts/holds', { as: 'accountant', body: { shopId: shop.id, reason: 'Nghi ngờ gian lận giao hàng' } });
  check('STL-13', 'sàn giữ tay tiền chi trả của một shop (có lý do) — WP-02 §2.4', hold.status < 300, { st: hold.status });
  const hold2 = await api('POST', '/admin/payouts/holds', { as: 'accountant', body: { shopId: shop.id, reason: 'Lệnh giữ thứ hai' } });
  check('STL-13b', 'mỗi shop chỉ một lệnh giữ đang hiệu lực ⇒ lệnh thứ hai 409', hold2.status === 409, { st: hold2.status, code: hold2.code });
  const hs = await api('GET', `/admin/payouts/holds?shopId=${shop.id}`, { as: 'accountant' });
  check('STL-13c', 'xem danh sách lệnh giữ của shop (kèm tên/mã shop)', hs.status === 200 && (hs.data ?? []).some((h) => h.id === hold.data?.id && h.releasedAt === null && !!h.shopName), { st: hs.status });
  const cs = await api('POST', '/admin/payouts/holds', { as: 'sales', body: { shopId: shop.id, reason: 'CSKH không được giữ tiền' } });
  check('STL-13d', 'CSKH KHÔNG giữ được tiền chi trả (403)', cs.status === 403, { st: cs.status });
  if (hold.data?.id) {
    const rl = await api('POST', `/admin/payouts/holds/${hold.data.id}/release`, { as: 'accountant' });
    check('STL-13e', 'mở lệnh giữ ⇒ 200', rl.status === 200, { st: rl.status });
  }
}
{
  // đổi tài khoản ngân hàng
  const before = await q1(`SELECT bank_account_number, bank_code, bank_account_name FROM shop.shops WHERE id = $1`, [shop.id]);
  const noPass = await api('PATCH', '/shop/me', { as: owner, body: { bankCode: '970422', bankAccountNumber: '9999888877', bankAccountName: 'KE GIAN LAN' } });
  const after = await q1(`SELECT bank_account_number FROM shop.shops WHERE id = $1`, [shop.id]);
  check('STL-11a', 'đổi TK ngân hàng PHẢI xác thực lại mật khẩu (WP-02 §2.5, AUD-03): thiếu mật khẩu ⇒ 400 và TK không đổi', noPass.status === 400 && noPass.code === 'SHOP_BANK_PASSWORD_REQUIRED' && after.bank_account_number === before.bank_account_number, { st: noPass.status, code: noPass.code, changed: after.bank_account_number !== before.bank_account_number });
  // Đổi HỢP LỆ (kèm mật khẩu của chủ shop) để kiểm tiếp: kỳ chi sau đổi TK bị giữ.
  const legit = await api('PATCH', '/shop/me', { as: owner, body: { bankCode: '970422', bankAccountNumber: '9999888877', bankAccountName: 'KE GIAN LAN', currentPassword: process.env.E2E_PW_VENDOR } });
  if (legit.status !== 200) console.log('  (đổi TK hợp lệ không thành công:', legit.status, legit.code, ')');
  const o = await completedOrder({ qtys: [1] });
  await L.mockReset(); await L.mockBalance(5_000_000_000);
  const run = await runPeriod();
  const r = run.data?.[0] ? await poRow(run.data[0].id) : null;
  check('STL-11b', 'vừa đổi TK ⇒ kỳ chi bị giữ (held) trong thời gian giữ sau đổi TK', r?.status === 'held', { status: r?.status, reason: r?.hold_reason, snapshot: JSON.stringify(r?.bank_snapshot)?.slice(0, 60) });
  note('STL-11c', 'TK trong snapshot của kỳ sau khi đổi TK', JSON.stringify(r?.bank_snapshot));
  await q(`UPDATE shop.shops SET bank_account_number = $2, bank_code = $3, bank_account_name = $4, bank_status = 'verified', bank_verified_at = NULL WHERE id = $1`, [shop.id, before.bank_account_number, before.bank_code, before.bank_account_name]);
  globalThis.bankChanged = r;
}
{
  // chạy đồng thời hai lần cho cùng shop
  const o = await completedOrder({ qtys: [1] });
  const start = await lastEnd();
  const body = { periodStart: new Date(start).toISOString(), periodEnd: new Date().toISOString(), shopId: shop.id };
  const [a, b] = await Promise.all([api('POST', '/admin/payouts/run', { as: 'accountant', body }), api('POST', '/admin/payouts/run', { as: 'admin', body })]);
  const rows = await q(`SELECT id FROM payment.shop_payouts WHERE shop_id = $1 AND period_start >= $2`, [shop.id, start]);
  const lines = await q(`SELECT count(*)::int AS n FROM payment.shop_payout_lines WHERE order_code = $1 AND kind = 'sale'`, [o.code]);
  check('CONC-06', 'hai người chạy đối soát ĐỒNG THỜI cho cùng shop ⇒ đúng 1 kỳ, đơn chỉ có 1 dòng SALE', rows.length === 1 && lines[0].n === 1, { a: a.status, b: b.status, rows: rows.length, sale: lines[0].n });
}
{
  // nợ mang sang: hoàn lớn hơn doanh thu kỳ ⇒ carried (âm), kỳ sau trừ nợ
  const o = await completedOrder({ qtys: [1] });
  const start = await lastEnd();
  note('STL-03b', 'nợ mang sang (kỳ âm) — cần hoàn sau chi vượt doanh thu kỳ; trong luồng hiện tại escrow = hạn đổi trả nên gần như không xảy ra', 'chỉ kiểm bằng unit test (shop-payout.spec) — bỏ qua ở E2E');
  const rows = await q(`SELECT status, count(*)::int n FROM payment.shop_payouts WHERE shop_id = $1 GROUP BY status ORDER BY status`, [shop.id]);
  note('STL-summary', 'thống kê kỳ chi của shop test theo trạng thái', JSON.stringify(rows));
}

L.saveResults(process.env.OUT ?? 'out-t05.json');
const R = L.results;
console.log(`\nTỔNG nhóm 05: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
