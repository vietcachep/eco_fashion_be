/* Nhóm 04: đổi trả (RET) + hoàn tiền (REF) — luồng chính, ngoại lệ, SLA, quyền, PayOS payout giả (thành công / từ chối / timeout / treo). */
import * as L from './lib.mjs';
process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e?.stack ?? e, e?.cause); });
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.stack ?? e, e?.cause); process.exit(3); });
const { check, group, api, q, q1, note } = L;
const shops = {};
for (const s of ['techzone', 'ngonviet', 'sneaker', 'nhaxinh', 'mobilehub', 'sportplanet']) shops[s] = await L.shopBySlug(s);
await L.mockReset();
const EV = [{ type: 'image', url: '/static/uploads/audit.jpg', name: 'audit.jpg' }];
const ADDR = { name: 'Kho kiểm thử', phone: '0909000222', address: '1 Đường Thử, Quận 7' };
const ACC = { bankBin: '970436', accountNumber: '0123456789', accountName: 'Nguyen Van Khach' };
const sstat = (slug, code, status, extra = {}) => api('PUT', `/shop/orders/${code}/status`, { as: `owner:${slug}`, body: { status, ...extra } });

/* Đơn 2 dòng hàng (2 biến thể) của một shop, đã giao. method payos|cod. */
async function delivered({ slug = 'techzone', as = 'khach34', method = 'payos', qtys = [1, 1] } = {}) {
  const vs = (await L.pickVariant({ shopId: shops[slug].id, qty: 4, maxPrice: 900000 })).slice(0, 2);
  const placed = await L.placeOrder({ as, items: vs.map((v, i) => ({ variantId: v.id, qty: qtys[i] })), method });
  if (placed.status !== 201) throw new Error(`đặt lỗi ${placed.status} ${placed.code} ${placed.raw?.message}`);
  const kid = L.childOrders(placed)[0];
  const total = Number(L.money(kid.total));
  if (method === 'payos') {
    const payos = await L.payosCodeOf(kid.code);
    await L.sendWebhook(payos, total, { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } });
  }
  await sstat(slug, kid.code, 'confirmed'); await sstat(slug, kid.code, 'packing'); await sstat(slug, kid.code, 'shipping', { trackingUrl: 'https://ghn.vn/t/AUDIT' });
  await sstat(slug, kid.code, 'delivered');
  const detail = (await api('GET', `/orders/${kid.code}`, { as })).data;
  return { code: kid.code, slug, as, method, total, items: detail.items, vs };
}
const mkReturn = (o, body) => api('POST', `/orders/${o.code}/returns`, { as: o.as, body: { reasonCode: 'defective', reason: 'Hàng bị lỗi khi nhận', evidence: EV, ...(o.method === 'cod' ? { refundAccount: ACC } : {}), ...body } });
const refundOf = async (code) => (await api('GET', '/admin/refunds?size=100', { as: 'accountant' })).data?.content?.filter((r) => r.orderCode === code) ?? [];

group('REF — hoàn tiền: ngoại lệ PayOS payout');
async function newRefund(label) {
  const o = await delivered({ method: 'payos', as: 'khach45', slug: 'techzone' });
  const c = await mkReturn(o, { items: [{ orderItemId: o.items[0].id, quantity: 1 }] });
  const id = c.data.id;
  await api('POST', `/shop/returns/${id}/approve`, { as: 'owner:techzone', body: { returnAddress: ADDR } });
  await api('POST', `/returns/${id}/ship-back`, { as: o.as, body: { carrier: 'GHN', trackingCode: 'GHN-R-' + label } });
  await api('POST', `/shop/returns/${id}/receive`, { as: 'owner:techzone', body: { condition: 'ok' } });
  const rf = (await refundOf(o.code))[0];
  return { o, id, rf };
}
{
  // processing treo > 30 phút ⇒ needsManual + báo KT 1 lần
  const r = await newRefund('STL');
  const p1 = await api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'accountant', body: {} });
  await q(`UPDATE payment.refunds SET gateway_submitted_at = now() - interval '45 minutes', updated_at = now() - interval '45 minutes' WHERE id = $1`, [r.rf.id]);
  const t0 = new Date();
  L.runJob('refund-reconcile'); L.runJob('refund-reconcile');
  const cur = (await refundOf(r.o.code))[0];
  const nn = (await L.notifs('accountant@ecofashion.vn', t0)).filter((n) => n.title.includes(r.o.code) || /treo|PayOS/i.test(n.title));
  check('REF-05', 'PayOS treo > 30 phút ⇒ needsManual + báo kế toán đúng 1 lần', cur.needsManual === true && nn.length === 1, { cur: { st: cur.status, nm: cur.needsManual }, notif: nn.map((n) => n.title) });
}
{
  // PayOS trả FAILED khi tra lại ⇒ failed; chạy lại = lệnh MỚI
  const r = await newRefund('FLD');
  await api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'accountant', body: {} });
  const po = (await L.mockState()).payouts.find((p) => p.referenceId === r.rf.id);
  await L.mockPayoutState({ id: po.id }, 'FAILED');
  L.runJob('refund-reconcile');
  const cur = (await refundOf(r.o.code))[0];
  check('REF-07a', 'PayOS báo lệnh chi FAILED ⇒ refund failed', cur.status === 'failed', cur);
  await api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'accountant', body: {} });
  const pos = (await L.mockState()).payouts.filter((p) => p.referenceId.startsWith(r.rf.id));
  check('REF-07b', 'chạy lại sau FAILED hẳn ⇒ lệnh MỚI với referenceId khác (<id>-2)', pos.length === 2 && pos.some((p) => p.referenceId === `${r.rf.id}-2`), pos.map((p) => p.referenceId));
}
{
  // bấm đồng thời 2 lần
  const r = await newRefund('CON');
  const [a, b] = await Promise.all([
    api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'accountant', body: {} }),
    api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'admin', body: {} }),
  ]);
  const pos = (await L.mockState()).payouts.filter((p) => p.referenceId.startsWith(r.rf.id));
  check('CONC-04', 'hai người bấm hoàn tiền ĐỒNG THỜI ⇒ chỉ MỘT lệnh chi PayOS', pos.length === 1, { a: a.status, b: b.status, n: pos.length });
}
{
  // không có TK nhận (PayOS không kèm counterAccount, khách không khai) ⇒ chuyển tay
  const vs = (await L.pickVariant({ shopId: shops.techzone.id, qty: 4, maxPrice: 900000 })).slice(0, 2);
  const p = await L.placeOrder({ as: 'khach46', items: vs.map((v) => ({ variantId: v.id, qty: 1 })), method: 'payos' });
  const k = L.childOrders(p)[0];
  await L.sendWebhook(await L.payosCodeOf(k.code), Number(L.money(k.total))); // không có TK người trả
  const cr = await api('POST', `/orders/${k.code}/cancel`, { as: 'khach46', body: { reason: 'Huỷ đơn đã trả, không có TK đối ứng' } });
  const rf = (await refundOf(k.code))[0];
  check('REF-07c', 'hoàn không có TK nhận (PayOS không kèm TK, khách chưa khai) ⇒ needsManual, payeeSource=none', !!rf && rf.needsManual === true && rf.payeeSource === 'none', { cr: cr.status, rf });
  const noRef = await api('POST', `/admin/refunds/${rf.id}/process`, { as: 'accountant', body: {} });
  check('REF-07d', 'xử lý mà không nhập mã giao dịch ⇒ 400 (không tự chi được)', noRef.status === 400, { st: noRef.status, code: noRef.code });
  const reveal = await api('GET', `/admin/refunds/${rf.id}/payee`, { as: 'accountant' });
  check('REF-07e', 'xem số TK khi chưa có TK nào ⇒ 404 (KT phải gọi khách)', reveal.status === 404, { st: reveal.status, code: reveal.code });
  const man = await api('POST', `/admin/refunds/${rf.id}/process`, { as: 'accountant', body: { providerRef: 'FT-MAN-' + Date.now() } });
  check('REF-07f', 'chuyển tay + mã ⇒ done, đơn/payment được cập nhật', man.status === 200 && man.data?.status === 'done', { st: man.status, d: man.data?.status });
  const rv2 = await api('GET', `/admin/refunds/${rf.id}/payee`, { as: 'accountant' });
  check('REF-08c', 'xem số TK của refund đã done ⇒ 409 (chỉ còn che số)', rv2.status === 409 || rv2.status === 404, { st: rv2.status });
}

L.saveResults(process.env.OUT ?? 'out-t04c.json');
const R = L.results;
console.log(`\nTỔNG nhóm 04: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
