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

group('REF — không có TK nhận hoàn');
{
  // không có TK nhận (PayOS không kèm counterAccount, khách không khai) ⇒ chuyển tay
  const vs = (await L.pickVariant({ shopId: shops.techzone.id, qty: 4, maxPrice: 900000 })).slice(0, 2);
  const p = await L.placeOrder({ as: 'khach45', items: vs.map((v) => ({ variantId: v.id, qty: 1 })), method: 'payos' });
  const k = L.childOrders(p)[0];
  await L.sendWebhook(await L.payosCodeOf(k.code), Number(L.money(k.total))); // không có TK người trả
  const cr = await api('POST', `/orders/${k.code}/cancel`, { as: 'khach45', body: { reason: 'Huỷ đơn đã trả, không có TK đối ứng' } });
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

L.saveResults(process.env.OUT ?? 'out-t04d.json');
const R = L.results;
console.log(`\nTỔNG nhóm 04: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
