/* Nhóm 02b: chạy lại các ca của nhóm 02 bị sai mô hình test (CK-02, PAY-04, PAY-06b) + ca mới: giá/ship/voucher/hoàn lượt. */
import * as L from './lib.mjs';
const { check, group, api, q, q1, note } = L;
const shops = {};
for (const s of ['techzone', 'ngonviet', 'sneaker', 'nhaxinh']) shops[s] = await L.shopBySlug(s);
const pick = async (slug, opts) => (await L.pickVariant({ shopId: shops[slug].id, ...opts }))[0];
await L.mockReset();

group('CK-02 — nhiều shop + voucher sàn / shop');
await q(`DELETE FROM promotion.promotions WHERE code IN ('AUDIT50K','AUDITPCT')`);
await q(`INSERT INTO promotion.promotions (code, name, type, value, min_order_amount, usage_limit, usage_limit_per_user, used_count, applies_to, starts_at, ends_at, is_active, is_public, scope) VALUES ('AUDIT50K','audit 50k','fixed_amount',50000,100000,NULL,20,0,'all', now() - interval '1 day', now() + interval '30 days', true, false, 'platform'), ('AUDITPCT','audit 10%','percentage',10,100000,NULL,20,0,'all', now() - interval '1 day', now() + interval '30 days', true, false, 'platform')`);
L.clearCaches();
let g3;
{
  const items = [];
  for (const s of ['techzone', 'ngonviet', 'sneaker']) {
    const v = await pick(s, { qty: 2, maxPrice: 400000 });
    items.push({ variantId: v.id, qty: 2, shop: s });
  }
  const p = await L.placeOrder({ as: 'khach13', items, method: 'payos', voucherCodes: ['AUDIT50K'] });
  check('CK-02a', '3 shop + voucher sàn 50k: đặt thành công, 3 đơn con', p.status === 201 && L.childOrders(p).length === 3, { st: p.status, code: p.code, msg: p.raw?.message });
  if (p.status === 201) {
    const kids = L.childOrders(p);
    const rows = await q(`SELECT code, subtotal, shipping_fee, discount, platform_discount, shop_discount, shop_shipping_discount, platform_shipping_discount, total FROM "order".orders WHERE code = ANY($1) ORDER BY code`, [kids.map((k) => k.code)]);
    const sumPlat = rows.reduce((a, r) => a + Number(r.platform_discount) + Number(r.platform_shipping_discount ?? 0), 0);
    check('CK-02b', 'voucher sàn 50.000 phân bổ đủ cho các đơn con (Σ phần sàn chịu = 50.000)', sumPlat === 50000, { sumPlat, rows });
    check('CK-02c', 'mỗi đơn con: total = subtotal + ship − discount', rows.every((r) => Number(r.total) === Number(r.subtotal) + Number(r.shipping_fee) - Number(r.discount)), rows);
    check('CK-02d', 'mỗi đơn con một link PayOS riêng (3 link)', (await L.mockState()).links.length === 3, { links: (await L.mockState()).links.length });
    const grpRow = await q1(`SELECT total FROM "order".order_groups WHERE code = $1`, [p.data.code]);
    check('CK-02e', 'tổng nhóm = Σ tổng các đơn con', Number(grpRow?.total) === rows.reduce((a, r) => a + Number(r.total), 0), { grp: grpRow, rows });
    g3 = { p, kids, rows };
  }
}
// hoàn lượt voucher khi huỷ: huỷ cả 3 đơn con ⇒ used_count giảm
if (g3) {
  const before = (await q1(`SELECT used_count FROM promotion.promotions WHERE code='AUDIT50K'`)).used_count;
  for (const k of g3.kids) await api('POST', `/orders/${k.code}/cancel`, { as: 'khach13', body: { reason: 'Đổi ý, huỷ đơn kiểm thử' } });
  const after = (await q1(`SELECT used_count FROM promotion.promotions WHERE code='AUDIT50K'`)).used_count;
  const rs = await q(`SELECT status FROM "order".orders WHERE code = ANY($1)`, [g3.kids.map((k) => k.code)]);
  check('CAN-11', 'huỷ hết 3 đơn con (pending) ⇒ cả 3 cancelled và lượt voucher sàn được nhả (used_count −1)', rs.every((r) => r.status === 'cancelled') && Number(before) - Number(after) === 1, { before, after, rs });
}
// huỷ MỘT đơn trong nhóm: các đơn còn lại không đổi, voucher sàn giữ lượt
{
  const items = [];
  for (const s of ['techzone', 'ngonviet']) { const v = await pick(s, { qty: 2, maxPrice: 400000 }); items.push({ variantId: v.id, qty: 1 }); }
  const p = await L.placeOrder({ as: 'khach14', items, method: 'payos', voucherCodes: ['AUDIT50K'] });
  if (p.status === 201) {
    const [a, b] = L.childOrders(p);
    const used0 = (await q1(`SELECT used_count FROM promotion.promotions WHERE code='AUDIT50K'`)).used_count;
    const r = await api('POST', `/orders/${a.code}/cancel`, { as: 'khach14', body: { reason: 'Huỷ riêng đơn thứ nhất' } });
    const rows = await q(`SELECT code,status,discount,total FROM "order".orders WHERE code = ANY($1) ORDER BY code`, [[a.code, b.code]]);
    const used1 = (await q1(`SELECT used_count FROM promotion.promotions WHERE code='AUDIT50K'`)).used_count;
    check('CAN-10', 'huỷ 1/2 đơn con: đơn kia giữ nguyên, voucher sàn KHÔNG nhả lượt khi còn đơn con khác', r.status === 200 && rows.find((x) => x.code === a.code).status === 'cancelled' && rows.find((x) => x.code === b.code).status === 'pending' && used0 === used1, { rows, used0, used1 });
    const detail = await api('GET', `/orders/groups/${p.data.code}`, { as: 'khach14' });
    note('CAN-10b', 'tổng nhóm sau khi huỷ 1 đơn con (G16)', `group.total=${JSON.stringify(detail.data?.total?.display)} orders=${(detail.data?.orders ?? []).map((o) => o.status).join(',')} (tổng không đổi dù 1 đơn đã huỷ)`);
  }
}

group('PAY-04 / PAY-06b (chạy lại đúng mô hình)');
{
  const v = await pick('techzone', { qty: 3 });
  const placed = await L.placeOrder({ as: 'khach11', items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  const kid = L.childOrders(placed)[0];
  const payos = await L.payosCodeOf(kid.code);
  const total = Number(L.money(kid.total));
  await L.mockPay(payos, total);
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '20 minutes' WHERE code = $1`, [kid.code]);
  await q(`UPDATE payment.payments SET expires_at = now() - interval '20 minutes' WHERE order_code = $1`, [kid.code]);
  const j = L.runJob('cancel-expired');
  const o = await L.orderRow(kid.code);
  check('PAY-04', 'mất webhook, quá hạn + ân hạn: job hỏi PayOS thấy PAID ⇒ ghi nhận paid, KHÔNG huỷ oan', o.status === 'pending' && o.payment_status === 'paid', { job: j, status: o.status, ps: o.payment_status });
  // trong ân hạn: job không hỏi PayOS ⇒ đơn đã trả chưa được ghi nhận (an toàn nhưng chậm)
  const v2 = await pick('ngonviet', { qty: 3 });
  const p2 = await L.placeOrder({ as: 'khach11', items: [{ variantId: v2.id, qty: 1 }], method: 'payos' });
  const k2 = L.childOrders(p2)[0];
  const pc2 = await L.payosCodeOf(k2.code);
  await L.mockPay(pc2, Number(L.money(k2.total)));
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '2 minutes' WHERE code = $1`, [k2.code]);
  L.runJob('cancel-expired');
  const o2 = await L.orderRow(k2.code);
  note('PAY-04b', 'đã trả ở PayOS nhưng mất webhook, đơn quá hạn 2 phút (trong ân hạn 10 phút)', `payment_status=${o2.payment_status} — chưa được ghi nhận; chờ hết ân hạn + job đối chiếu (WP-01 §2.3 chưa có job poll riêng)`);
  // PAY-06b qua API kế toán
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '30 minutes' WHERE code = $1`, [k2.code]);
  L.runJob('cancel-expired');
  const o3 = await L.orderRow(k2.code);
  check('PAY-04c', 'sau ân hạn: đơn được ghi nhận paid (không bị huỷ)', o3.payment_status === 'paid' && o3.status === 'pending', { st: o3.status, ps: o3.payment_status });
}
{
  const v = await pick('techzone', { qty: 3 });
  const placed = await L.placeOrder({ as: 'khach11', items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  const kid = L.childOrders(placed)[0];
  const payos = await L.payosCodeOf(kid.code);
  const total = Number(L.money(kid.total));
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '30 minutes' WHERE code = $1`, [kid.code]);
  L.runJob('cancel-expired');
  await L.sendWebhook(payos, total, { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '9988776655' } });
  const rf = (await api('GET', '/admin/refunds?status=requested&size=100', { as: 'accountant' })).data?.content?.find((r) => r.orderCode === kid.code);
  check('PAY-06b', 'trả muộn sau huỷ: có yêu cầu hoàn đủ số tiền, payeeSource=payer, KT thấy ở danh sách', !!rf && Number(L.money(rf.amount)) === total && rf.payeeSource === 'payer' && rf.needsManual === false, rf);
  // KT xử lý: PayOS payout (mock) → processing → succeeded → done
  const pr = await api('POST', `/admin/refunds/${rf.id}/process`, { as: 'accountant', body: {} });
  check('REF-01a', 'hoàn PayOS với TK người trả: gửi lệnh chi ⇒ processing (chưa done)', pr.status === 200 && pr.data?.status === 'processing', { st: pr.status, data: pr.data?.status, code: pr.code });
  const st0 = await L.mockState();
  check('REF-01b', 'PayOS giả nhận đúng 1 lệnh chi với TK/BIN người trả', st0.payouts.length === 1 && st0.payouts[0].toAccountNumber === '9988776655' && st0.payouts[0].toBin === '970436' && st0.payouts[0].amount === total, st0.payouts);
  const pr2 = await api('POST', `/admin/refunds/${rf.id}/process`, { as: 'accountant', body: {} });
  const st1 = await L.mockState();
  check('REF-01c', 'bấm "hoàn tiền" lần nữa khi đang processing ⇒ KHÔNG gửi lệnh thứ hai', st1.payouts.length === 1, { n: st1.payouts.length, res: pr2.data?.status ?? pr2.code });
  await L.mockPayoutState({ referenceId: st0.payouts[0].referenceId }, 'SUCCEEDED');
  const rr = L.runJob('refund-reconcile');
  const after = (await L.refundRows(kid.code))[0];
  const orderAfter = await L.orderRow(kid.code);
  check('REF-01d', 'job đối soát: PayOS SUCCEEDED ⇒ refund done (chỉ lúc này), providerRef ghi, payment refunded', after.status === 'done' && !!after.provider_ref, { job: rr, after });
  const pay = (await L.paymentRows(kid.code))[0];
  check('REF-01e', 'payment đã hoàn đủ: refunded_amount = số tiền, payment_status = refunded', Number(pay.refunded_amount) === total && pay.status === 'refunded', pay);
  const stock0 = await L.stock(v.id);
  note('REF-01f', 'tồn sau huỷ quá hạn', JSON.stringify(stock0));
}

L.saveResults(process.env.OUT ?? 'out-t02b.json');
const R = L.results;
console.log(`\nTỔNG nhóm 02b: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
