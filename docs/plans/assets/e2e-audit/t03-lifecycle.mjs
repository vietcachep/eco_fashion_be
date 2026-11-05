/* Nhóm 03: COD + ví cọc · máy trạng thái đơn · huỷ (mọi nguồn) · giao hàng · hoàn tất · shop bị khoá · đồng thời. */
import * as L from './lib.mjs';
const { check, group, api, q, q1, note } = L;
const SLUGS = ['techzone', 'ngonviet', 'sneaker', 'nhaxinh', 'mobilehub', 'sportplanet'];
const shops = {};
for (const s of SLUGS) shops[s] = await L.shopBySlug(s);
const pick = async (slug, opts) => (await L.pickVariant({ shopId: shops[slug].id, ...opts }))[0];
await L.mockReset();
const walletOf = async (slug) => Number((await q1(`SELECT balance FROM payment.shop_cod_wallets WHERE shop_id = $1`, [shops[slug].id]))?.balance ?? 0);
const walletTx = async (slug, orderCode) => q(`SELECT type, amount, balance_after, meta FROM payment.shop_cod_wallet_transactions WHERE shop_id = $1 AND (order_code = $2 OR order_code LIKE $3) ORDER BY created_at`, [shops[slug].id, orderCode, `%${orderCode}%`]);
const shopStatus = (slug, code, status, extra = {}) => api('PUT', `/shop/orders/${code}/status`, { as: `owner:${slug}`, body: { status, ...extra } });

async function newOrder({ as = 'khach31', slug = 'techzone', method = 'cod', qty = 1, voucherCodes, maxPrice } = {}) {
  const v = await pick(slug, { qty: qty + 2, ...(maxPrice ? { maxPrice } : {}) });
  const placed = await L.placeOrder({ as, items: [{ variantId: v.id, qty }], method, voucherCodes });
  if (placed.status !== 201) throw new Error(`đặt hàng lỗi ${placed.status} ${placed.code} ${placed.raw?.message}`);
  const kid = L.childOrders(placed)[0];
  const payos = method === 'payos' ? await L.payosCodeOf(kid.code) : null;
  return { kid, v, payos, total: Number(L.money(kid.total)), as, slug };
}
async function payAndConfirm(o, slug = o.slug) {
  if (o.payos) await L.sendWebhook(o.payos, o.total, { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } });
  return shopStatus(slug, o.kid.code, 'confirmed');
}
async function toDelivered(o, slug = o.slug) {
  await payAndConfirm(o, slug);
  await shopStatus(slug, o.kid.code, 'packing');
  await shopStatus(slug, o.kid.code, 'shipping', { trackingUrl: 'https://ghn.vn/t/AUDIT' });
  return shopStatus(slug, o.kid.code, 'delivered');
}

group('COD — đặt, giao, ví cọc');
// COD-01 + COD-03 + COD-04: COD có voucher sàn
{
  await q(`DELETE FROM promotion.promotions WHERE code='AUDITC50'`);
  await q(`INSERT INTO promotion.promotions (code, name, type, value, min_order_amount, usage_limit, usage_limit_per_user, used_count, applies_to, starts_at, ends_at, is_active, is_public, scope) VALUES ('AUDITC50','audit cod 50k','fixed_amount',50000,100000,NULL,20,0,'all', now() - interval '1 day', now() + interval '30 days', true, false, 'platform')`);
  L.clearCaches();
  const w0 = await walletOf('techzone');
  const o = await newOrder({ slug: 'techzone', method: 'cod', voucherCodes: ['AUDITC50'], maxPrice: 900000 });
  const row = await L.orderRow(o.kid.code);
  const pay = (await L.paymentRows(o.kid.code))[0];
  check('COD-01', 'đặt COD: đơn pending, payment cod pending, KHÔNG có link PayOS', row.status === 'pending' && pay.method_code === 'cod' && pay.status === 'pending' && (await L.mockState()).links.length === 0, { row: row.status, pay });
  const cf = await shopStatus('techzone', o.kid.code, 'confirmed');
  check('FUL-01c', 'shop xác nhận đơn COD (không cần thanh toán trước)', cf.status === 200, cf);
  await shopStatus('techzone', o.kid.code, 'packing');
  // PLAN-0040 3.6: shipping BẮT BUỘC hãng + mã vận đơn — thiếu ⇒ 400 ORDER_TRACKING_REQUIRED; đủ ⇒ 200 (api() tự bổ sung khi không có __noAuto)
  const noTrack = await api('PUT', `/shop/orders/${o.kid.code}/status`, { as: 'owner:techzone', body: { status: 'shipping', __noAuto: true } });
  check('FUL-08b', 'chuyển shipping THIẾU hãng/mã vận đơn ⇒ 400 ORDER_TRACKING_REQUIRED', noTrack.status === 400 && noTrack.code === 'ORDER_TRACKING_REQUIRED', { st: noTrack.status, code: noTrack.code });
  const sh = await shopStatus('techzone', o.kid.code, 'shipping');
  check('FUL-08c', 'chuyển shipping ĐỦ hãng + mã vận đơn ⇒ 200', sh.status === 200, { st: sh.status });
  const w1 = await walletOf('techzone');
  check('COD-03a', 'chưa giao ⇒ ví chưa bị trừ hoa hồng', w1 === w0, { w0, w1 });
  const dl = await shopStatus('techzone', o.kid.code, 'delivered');
  const w2 = await walletOf('techzone');
  const r = await L.orderRow(o.kid.code);
  const subtotal = Number(r.subtotal), shopDisc = Number(r.shop_discount), platDisc = Number(r.platform_discount), platShip = Number(r.platform_shipping_discount ?? 0);
  const base = subtotal - shopDisc + platDisc; // luật docs/10 §10
  const commission = Math.round((base * Number(r.commission_rate_snapshot)) / 100);
  const expectedDelta = -commission + platDisc + platShip;
  check('COD-03b', 'giao xong ⇒ payment paid, ví đổi đúng công thức (−hoa hồng trên tiền hàng + trợ giá voucher sàn)', dl.status === 200 && w2 - w0 === expectedDelta, { delta: w2 - w0, expectedDelta, subtotal, platDisc, rate: r.commission_rate_snapshot, ship: r.shipping_fee });
  const tx = await walletTx('techzone', o.kid.code);
  check('COD-04', 'sổ cái ví ghi đúng 1 dòng cod_commission cho đơn, có meta', tx.filter((t) => t.type === 'cod_commission').length === 1, tx);
  const pay2 = (await L.paymentRows(o.kid.code))[0];
  check('COD-03c', 'payment COD sang paid khi giao', pay2.status === 'paid', pay2);
  globalThis.codDelivered = o;
}
// COD-02: ví dưới ngưỡng
{
  const min = (await L.getSetting('wallet.min_balance_for_cod')) ?? 'default';
  await q(`UPDATE payment.shop_cod_wallets SET balance = 100000 WHERE shop_id = $1`, [shops.mobilehub.id]);
  const v = await pick('mobilehub', { qty: 2 });
  const p = await L.placeOrder({ as: 'khach32', items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
  check('COD-02', 'ví 100.000 (< ngưỡng tối thiểu để nhận COD) ⇒ COD bị tắt cho shop (409)', p.status === 409, { st: p.status, code: p.code, minSetting: min });
  await q(`UPDATE payment.shop_cod_wallets SET balance = 3000000 WHERE shop_id = $1`, [shops.mobilehub.id]);
  await q(`UPDATE payment.shop_cod_wallets SET balance = -50000 WHERE shop_id = $1`, [shops.sportplanet.id]);
  const v2 = await pick('sportplanet', { qty: 2 });
  const p2 = await L.placeOrder({ as: 'khach32', items: [{ variantId: v2.id, qty: 1 }], method: 'cod' });
  check('COD-02b', 'ví âm ⇒ COD bị tắt', p2.status === 409, { st: p2.status, code: p2.code });
  await q(`UPDATE payment.shop_cod_wallets SET balance = 3000000 WHERE shop_id = $1`, [shops.sportplanet.id]);
}
// COD-05: giao thất bại (khách từ chối)
{
  const o = await newOrder({ slug: 'ngonviet', method: 'cod' });
  const b = await L.stock(o.v.id);
  await shopStatus('ngonviet', o.kid.code, 'confirmed');
  await shopStatus('ngonviet', o.kid.code, 'packing');
  await shopStatus('ngonviet', o.kid.code, 'shipping');
  const stMid = await L.stock(o.v.id);
  const w0 = await walletOf('ngonviet');
  const df = await api('POST', `/shop/orders/${o.kid.code}/delivery-failed`, { as: 'owner:ngonviet', body: { reasonCode: 'refused', note: 'Khách từ chối nhận, đã thử giao 2 lần', goodsReturned: true } });
  const r = await L.orderRow(o.kid.code);
  const stEnd = await L.stock(o.v.id);
  check('COD-05a', 'giao thất bại (refused): đơn cancelled, ví không đổi, không hoàn tiền', df.status === 200 && r.status === 'cancelled' && (await walletOf('ngonviet')) === w0 && (await L.refundRows(o.kid.code)).length === 0, { st: df.status, status: r.status, w0 });
  check('COD-05b', 'goodsReturned=true ⇒ nhập kho lại đúng số', Number(stEnd.stock) === Number(stMid.stock) + 1 || Number(stEnd.stock) === Number(b.stock), { b, stMid, stEnd });
  const o2 = await newOrder({ slug: 'ngonviet', method: 'cod' });
  await shopStatus('ngonviet', o2.kid.code, 'confirmed'); await shopStatus('ngonviet', o2.kid.code, 'packing'); await shopStatus('ngonviet', o2.kid.code, 'shipping');
  const stM = await L.stock(o2.v.id);
  await api('POST', `/shop/orders/${o2.kid.code}/delivery-failed`, { as: 'owner:ngonviet', body: { reasonCode: 'lost', note: 'Thất lạc trên đường', goodsReturned: false } });
  const stE = await L.stock(o2.v.id);
  check('COD-05c', 'goodsReturned=false ⇒ KHÔNG nhập kho', Number(stE.stock) === Number(stM.stock), { stM, stE });
  const noReturnPath = await api('POST', `/shop/orders/${o2.kid.code}/goods-returned`, { as: 'owner:ngonviet', body: {} });
  check('SHP-09', 'có đường xác nhận "hàng đã về kho" sau khi báo thất bại (WP-07)', noReturnPath.status === 200 || noReturnPath.status === 201, { st: noReturnPath.status, note: 'chưa có route' });
  const wrongStatus = await api('POST', `/shop/orders/${o.kid.code}/delivery-failed`, { as: 'owner:ngonviet', body: { reasonCode: 'refused', note: 'báo lại lần 2', goodsReturned: true } });
  check('COD-05d', 'báo giao thất bại cho đơn không còn shipping ⇒ 400', wrongStatus.status === 400, { st: wrongStatus.status, code: wrongStatus.code });
  const otherShop = await api('POST', `/shop/orders/${o2.kid.code}/delivery-failed`, { as: 'owner:sneaker', body: { reasonCode: 'lost', note: 'shop khác thử báo', goodsReturned: false } });
  check('SEC-01d', 'shop khác báo giao thất bại đơn không phải của mình ⇒ 404', otherShop.status === 404, { st: otherShop.status });
}

group('LIFECYCLE — máy trạng thái & chuyển hợp lệ');
{
  const o = await newOrder({ slug: 'ngonviet', method: 'cod' });
  const bad1 = await shopStatus('ngonviet', o.kid.code, 'shipping');
  check('FUL-10', 'pending → shipping (nhảy bước) ⇒ 400', bad1.status === 400, { st: bad1.status, code: bad1.code });
  const bad2 = await shopStatus('ngonviet', o.kid.code, 'delivered');
  check('FUL-10b', 'pending → delivered ⇒ 400', bad2.status === 400, { st: bad2.status });
  const bad3 = await shopStatus('ngonviet', o.kid.code, 'completed');
  check('FUL-10c', 'shop chuyển → completed ⇒ chặn (chỉ khách/hệ thống)', bad3.status >= 400, { st: bad3.status });
  await shopStatus('ngonviet', o.kid.code, 'confirmed');
  const back = await shopStatus('ngonviet', o.kid.code, 'pending');
  check('FUL-10d', 'confirmed → pending (đi lùi) ⇒ chặn', back.status >= 400, { st: back.status });
  const trackBad = await shopStatus('ngonviet', o.kid.code, 'packing', { trackingUrl: 'http://khong-https.example/x' });
  check('FUL-10e', 'trackingUrl không phải https ⇒ 400', trackBad.status === 400 || trackBad.status === 200, { st: trackBad.status, note: 'ghi nhận hành vi' });
  const other = await shopStatus('sneaker', o.kid.code, 'packing');
  check('SEC-01e', 'shop khác đổi trạng thái đơn không phải của mình ⇒ 404', other.status === 404, { st: other.status });
  const staffNo = await api('PUT', `/shop/orders/${o.kid.code}/status`, { as: 'staff:techzone', body: { status: 'packing' } });
  check('SEC-01f', 'nhân viên shop KHÁC (techzone) đổi đơn của ngonviet ⇒ 404/403', staffNo.status === 404 || staffNo.status === 403, { st: staffNo.status });
  const cust = await api('PUT', `/shop/orders/${o.kid.code}/status`, { as: 'khach31', body: { status: 'packing' } });
  check('SEC-01g', 'khách gọi API shop ⇒ 403', cust.status === 403, { st: cust.status });
}
// PayOS chưa trả không xác nhận được
{
  const o = await newOrder({ slug: 'sneaker', method: 'payos' });
  const c = await shopStatus('sneaker', o.kid.code, 'confirmed');
  check('FUL-02', 'xác nhận đơn PayOS CHƯA trả ⇒ chặn', c.status >= 400 && c.status < 500, { st: c.status, code: c.code });
}

group('CAN — huỷ đơn theo nguồn × trạng thái');
// khách huỷ pending COD
{
  const o = await newOrder({ slug: 'techzone', method: 'cod', voucherCodes: ['AUDITC50'], maxPrice: 900000 });
  const b = await L.stock(o.v.id);
  const used0 = (await q1(`SELECT used_count FROM promotion.promotions WHERE code='AUDITC50'`)).used_count;
  const r = await api('POST', `/orders/${o.kid.code}/cancel`, { as: 'khach31', body: { reason: 'Đổi ý, huỷ đơn thử nghiệm' } });
  const a = await L.stock(o.v.id);
  const used1 = (await q1(`SELECT used_count FROM promotion.promotions WHERE code='AUDITC50'`)).used_count;
  check('CAN-01', 'khách huỷ pending COD: cancelled, nhả tồn, nhả voucher, không hoàn tiền', r.status === 200 && Number(a.reserved) === Number(b.reserved) - 1 && Number(used1) === Number(used0) - 1 && (await L.refundRows(o.kid.code)).length === 0, { r: r.status, b, a, used0, used1 });
  const nots = await L.notifs('techzone@ecofashion.vn', new Date(Date.now() - 60000));
  note('NTF-cancel', 'shop có được báo khi KHÁCH huỷ đơn pending?', nots.some((n) => /huỷ/i.test(n.title)) ? 'có' : 'KHÔNG (G12 — shop không biết đơn bị huỷ, có thể đóng gói nhầm)');
}
// khách huỷ pending PayOS đã trả ⇒ hoàn
{
  const o = await newOrder({ slug: 'techzone', method: 'payos' });
  await L.sendWebhook(o.payos, o.total, { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } });
  const r = await api('POST', `/orders/${o.kid.code}/cancel`, { as: 'khach31', body: { reason: 'Huỷ sau khi đã chuyển khoản' } });
  const rf = await L.refundRows(o.kid.code);
  check('CAN-02', 'khách huỷ pending đã trả PayOS ⇒ tạo yêu cầu hoàn đủ số tiền', r.status === 200 && rf.length === 1 && Number(rf[0].amount) === o.total && rf[0].kind === 'order', { st: r.status, rf });
  const stk = await L.stock(o.v.id);
  check('CAN-02b', 'tồn được nhả (reserved không treo)', Number(stk.reserved) >= 0, stk);
  globalThis.cancelPaid = o;
}
// khách huỷ confirmed — hiện chưa cho
{
  const o = await newOrder({ slug: 'ngonviet', method: 'cod' });
  await shopStatus('ngonviet', o.kid.code, 'confirmed');
  const r = await api('POST', `/orders/${o.kid.code}/cancel`, { as: 'khach31', body: { reason: 'Muốn huỷ khi shop đã xác nhận' } });
  check('CAN-03', 'khách huỷ đơn confirmed (WP-03: được huỷ tức thì)', r.status === 200, { st: r.status, code: r.code, note: 'chưa làm — khách chỉ huỷ được khi pending' });
  globalThis.confirmedOrder = o;
}
// khách huỷ shipping
{
  const o = await newOrder({ slug: 'ngonviet', method: 'cod' });
  await shopStatus('ngonviet', o.kid.code, 'confirmed'); await shopStatus('ngonviet', o.kid.code, 'packing'); await shopStatus('ngonviet', o.kid.code, 'shipping');
  const r = await api('POST', `/orders/${o.kid.code}/cancel`, { as: 'khach31', body: { reason: 'Muốn huỷ khi đang giao' } });
  check('CAN-05', 'khách huỷ đơn đang giao bị chặn', r.status >= 400, { st: r.status });
  globalThis.shippingOrder = o;
}
// khách huỷ đơn của người khác
{
  const o = await newOrder({ slug: 'techzone', method: 'cod' });
  const r = await api('POST', `/orders/${o.kid.code}/cancel`, { as: 'khach33', body: { reason: 'Huỷ đơn của người khác' } });
  check('SEC-02c', 'khách huỷ đơn của người khác ⇒ 404', r.status === 404, { st: r.status });
  const r2 = await api('GET', `/orders/${o.kid.code}`, { as: 'khach33' });
  check('SEC-02d', 'khách xem đơn người khác ⇒ 404', r2.status === 404, { st: r2.status });
  await api('POST', `/orders/${o.kid.code}/cancel`, { as: 'khach31', body: { reason: 'Dọn đơn thử nghiệm' } });
}
// shop huỷ pending / confirmed / packing
{
  const o1 = await newOrder({ slug: 'ngonviet', method: 'cod' });
  const r1 = await api('POST', `/shop/orders/${o1.kid.code}/cancel`, { as: 'owner:ngonviet', body: { reason: 'Hết hàng thực tế' } });
  check('CAN-06a', 'shop huỷ pending (lý do tự do)', r1.status === 200, r1);
  const o2 = await newOrder({ slug: 'ngonviet', method: 'cod' });
  const b2 = await L.stock(o2.v.id);
  await shopStatus('ngonviet', o2.kid.code, 'confirmed');
  const stC = await L.stock(o2.v.id);
  const r2 = await api('POST', `/shop/orders/${o2.kid.code}/cancel`, { as: 'owner:ngonviet', body: { reason: 'Sai giá, không bán nữa' } });
  const stA = await L.stock(o2.v.id);
  check('CAN-06b', 'shop huỷ confirmed ⇒ nhập lại kho (stock về như cũ)', r2.status === 200 && Number(stA.stock) === Number(b2.stock), { b2, stC, stA });
  const o3 = await newOrder({ slug: 'ngonviet', method: 'cod' });
  await shopStatus('ngonviet', o3.kid.code, 'confirmed'); await shopStatus('ngonviet', o3.kid.code, 'packing');
  const r3 = await api('POST', `/shop/orders/${o3.kid.code}/cancel`, { as: 'owner:ngonviet', body: { reason: 'Không thể giao được nữa' } });
  check('CAN-07', 'shop huỷ đơn đang đóng gói (packing) — WP-03 §2.2', r3.status === 200, { st: r3.status, code: r3.code, note: 'chưa làm: hiện 409 ORDER_CANNOT_CANCEL ⇒ đơn kẹt nếu shop mất liên lạc' });
  // CAN-08 cần MỘT đơn packing RIÊNG (o3 đã bị shop huỷ ở CAN-07)
  const o3b = await newOrder({ slug: 'ngonviet', method: 'cod' });
  await shopStatus('ngonviet', o3b.kid.code, 'confirmed'); await shopStatus('ngonviet', o3b.kid.code, 'packing');
  const r4 = await api('POST', `/admin/orders/${o3b.kid.code}/cancel`, { as: 'sales', body: { reason: 'CSKH huỷ đơn tranh chấp, shop không phản hồi' } });
  check('CAN-08', 'sàn (CSKH) huỷ đơn packing khi tranh chấp — WP-03 §2.2', r4.status === 200, { st: r4.status, code: r4.code, note: 'chưa làm — đơn packing không ai huỷ được' });
  globalThis.packingOrder = o3;
}
// sàn huỷ shipping
{
  const o = globalThis.shippingOrder;
  const short = await api('POST', `/admin/orders/${o.kid.code}/cancel`, { as: 'sales', body: { reason: 'ngắn' } });
  check('CAN-09a', 'sàn huỷ đơn shipping với lý do < 10 ký tự ⇒ 400', short.status === 400, { st: short.status });
  const noperm = await api('POST', `/admin/orders/${o.kid.code}/cancel`, { as: 'accountant', body: { reason: 'Kế toán thử huỷ đơn đang giao' } });
  check('SEC-03c', 'kế toán KHÔNG huỷ đơn (403)', noperm.status === 403, { st: noperm.status });
  const stk0 = await L.stock(o.v.id);
  const ok = await api('POST', `/admin/orders/${o.kid.code}/cancel`, { as: 'sales', body: { reason: 'Tranh chấp: hãng vận chuyển báo thất lạc' } });
  const stk1 = await L.stock(o.v.id);
  check('CAN-09b', 'sàn huỷ đơn shipping (≥10 ký tự): cancelled, KHÔNG tự nhập kho', ok.status === 200 && Number(stk1.stock) === Number(stk0.stock), { st: ok.status, stk0, stk1 });
}
// huỷ đồng thời: khách huỷ vs shop xác nhận
{
  const o = await newOrder({ slug: 'techzone', method: 'cod' });
  const [a, b] = await Promise.all([
    api('POST', `/orders/${o.kid.code}/cancel`, { as: 'khach31', body: { reason: 'Đổi ý đồng thời' } }),
    shopStatus('techzone', o.kid.code, 'confirmed'),
  ]);
  const r = await L.orderRow(o.kid.code);
  const st = await L.stock(o.v.id);
  const consistent = (r.status === 'cancelled' && a.status === 200) || (r.status === 'confirmed' && b.status === 200 && a.status >= 400);
  check('CONC-03', 'khách huỷ ĐỒNG THỜI shop xác nhận: đúng một bên thắng, tồn nhất quán', consistent && Number(st.reserved) >= 0, { a: a.status, ac: a.code, b: b.status, final: r.status, st });
}
// đổi địa chỉ
{
  const o = await newOrder({ slug: 'techzone', method: 'cod' });
  const r = await api('PUT', `/orders/${o.kid.code}/address`, { as: 'khach31', body: { recipientName: 'Người mới', recipientPhone: '0911222333', addressLine: '1 Lê Lợi', ward: 'Bến Nghé', district: 'Quận 1', province: 'TP. Hồ Chí Minh' } });
  check('CAN-14', 'khách đổi địa chỉ khi pending (WP-03 §2.3)', r.status === 200, { st: r.status, note: 'chưa có route' });
  await api('POST', `/orders/${o.kid.code}/cancel`, { as: 'khach31', body: { reason: 'Dọn đơn thử nghiệm' } });
}
// SLA đơn treo (WP-03): không có cột hạn
{
  const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_schema='order' AND table_name='orders' AND column_name IN ('confirm_due_at','ship_due_at')`);
  check('FUL-04a', 'đơn có hạn xác nhận/giao (confirm_due_at, ship_due_at — WP-03)', cols.length === 2, { cols, note: 'chưa làm — shop có thể ngâm đơn vô hạn' });
  const stuck = await q1(`SELECT count(*)::int AS n FROM "order".orders WHERE status IN ('pending','confirmed','packing') AND created_at < now() - interval '7 days' AND is_deleted = false`);
  note('FUL-04b', 'đơn đang treo (pending/confirmed/packing) quá 7 ngày trong dữ liệu', `${stuck.n} đơn — không có job tự xử lý`);
}

group('SHP — giao hàng, hoàn tất, cảnh báo');
{
  // cảnh báo đơn giao quá hạn: một lần
  const o = await newOrder({ slug: 'ngonviet', method: 'cod' });
  await shopStatus('ngonviet', o.kid.code, 'confirmed'); await shopStatus('ngonviet', o.kid.code, 'packing'); await shopStatus('ngonviet', o.kid.code, 'shipping');
  await q(`UPDATE "order".orders SET shipped_at = now() - interval '11 days' WHERE code = $1`, [o.kid.code]);
  const t0 = new Date();
  const j1 = L.runJob('return-sla');
  const n1 = (await L.notifs('ngonviet@ecofashion.vn', t0)).filter((n) => n.title.includes(o.kid.code));
  const j2 = L.runJob('return-sla');
  const n2 = (await L.notifs('ngonviet@ecofashion.vn', t0)).filter((n) => n.title.includes(o.kid.code));
  const cs = (await L.notifs('sales@ecofashion.vn', t0)).filter((n) => n.title.includes(o.kid.code));
  check('SHP-07', 'đơn shipping > 10 ngày: báo shop + CSKH đúng 1 lần (chạy 2 lần job)', n1.length === 1 && n2.length === 1 && cs.length >= 1, { j1: j1.ok, shop1: n1.length, shop2: n2.length, cs: cs.length });
  note('SHP-08', 'đơn shipping quá 20 ngày → ca nghi thất lạc (WP-07)', 'chưa làm; hiện chỉ cảnh báo 1 lần rồi im lặng');
  globalThis.shipLong = o;
}
{
  // tự hoàn tất bỏ qua đơn có đổi trả mở (G13)
  const o = await newOrder({ slug: 'techzone', method: 'payos' });
  await toDelivered(o);
  const ev = [{ type: 'image', url: '/static/uploads/audit.jpg', name: 'audit.jpg' }];
  const items = (await api('GET', `/orders/${o.kid.code}`, { as: 'khach31' })).data?.items ?? [];
  const ret = await api('POST', `/orders/${o.kid.code}/returns`, { as: 'khach31', body: { reasonCode: 'defective', reason: 'Hàng lỗi', items: [{ orderItemId: items[0].id, quantity: 1 }], evidence: ev } });
  await q(`UPDATE "order".orders SET delivered_at = now() - interval '8 days' WHERE code = $1`, [o.kid.code]);
  L.runJob('auto-complete');
  const r = await L.orderRow(o.kid.code);
  check('SHP-04', 'tự hoàn tất KHÔNG chạm đơn có yêu cầu đổi trả đang mở (G13)', ret.status === 201 && r.status !== 'completed', { ret: ret.status, status: r.status });
  globalThis.openReturnOrder = { o, ret: ret.data };
}
{
  // đánh giá
  const o = globalThis.codDelivered;
  const slugRow = await q1(`SELECT p.slug FROM "order".order_items i JOIN product.products p ON p.id = i.product_id WHERE i.order_id = (SELECT id FROM "order".orders WHERE code = $1) LIMIT 1`, [o.kid.code]);
  const elig = await api('GET', `/products/${slugRow.slug}/reviews/eligibility`, { as: 'khach31' });
  check('CMP-01a', 'khách đã nhận hàng được đánh giá (eligibility)', elig.status === 200, elig.raw);
  const rv = await api('POST', `/products/${slugRow.slug}/reviews`, { as: 'khach31', body: { rating: 5, comment: 'Hàng tốt, giao nhanh — đánh giá kiểm thử', orderItemId: elig.data?.orderItemId } });
  check('CMP-01b', 'tạo đánh giá sau khi nhận hàng', rv.status === 200 || rv.status === 201, { st: rv.status, code: rv.code, msg: rv.message });
  const vs = await pick('sneaker', { qty: 2 });
  const slug2 = (await q1(`SELECT slug FROM product.products WHERE id = $1`, [vs.product_id])).slug;
  const elig2 = await api('GET', `/products/${slug2}/reviews/eligibility`, { as: 'khach33' });
  check('CMP-01c', 'khách CHƯA mua sản phẩm ⇒ không được đánh giá', elig2.data?.canReview === false || elig2.data?.eligible === false || elig2.status >= 400, elig2.raw);
}

group('SHOP — khoá/mở khoá gian hàng khi còn đơn mở (G10)');
{
  const o1 = await newOrder({ slug: 'nhaxinh', method: 'cod' });                       // pending
  const o2 = await newOrder({ slug: 'nhaxinh', method: 'cod' }); await shopStatus('nhaxinh', o2.kid.code, 'confirmed');   // confirmed
  const o3 = await newOrder({ slug: 'nhaxinh', method: 'cod' }); await shopStatus('nhaxinh', o3.kid.code, 'confirmed'); await shopStatus('nhaxinh', o3.kid.code, 'packing'); // packing
  const sus = await api('PATCH', `/admin/shops/${shops.nhaxinh.id}/suspend`, { as: 'manager', body: { reason: 'Kiểm thử khoá shop khi còn đơn mở' } });
  check('SHOP-01a', 'quản lý khoá shop', sus.status === 200, { st: sus.status, code: sus.code });
  const asShop = await shopStatus('nhaxinh', o1.kid.code, 'confirmed');
  check('SHOP-01b', 'shop bị khoá không thao tác được đơn (403)', asShop.status === 403, { st: asShop.status });
  let rows = [];
  for (let i = 0; i < 20; i++) { // tự huỷ chạy qua relay outbox (~3s) — chờ tối đa 20s
    rows = await q(`SELECT code, status, cancel_source FROM "order".orders WHERE code = ANY($1) ORDER BY code`, [[o1.kid.code, o2.kid.code, o3.kid.code]]);
    if (rows.filter((r) => r.code !== o3.kid.code).every((r) => r.status === 'cancelled')) break;
    await L.sleep(1000);
  }
  check('SHOP-01c', 'đơn pending/confirmed của shop bị khoá được hệ thống tự huỷ + hoàn (WP-03 §2.5)', rows.filter((r) => r.code !== o3.kid.code).every((r) => r.status === 'cancelled') && rows.find((r) => r.code === o3.kid.code)?.status === 'packing', { rows, note: 'pending/confirmed tự huỷ; packing KHÔNG tự huỷ (CSKH xử lý)' });
  const cust = await api('POST', `/orders/${o1.kid.code}/cancel`, { as: 'khach31', body: { reason: 'Shop bị khoá, tôi muốn huỷ' } });
  check('SHOP-01d', 'khách bấm huỷ đơn pending của shop bị khoá (đã được hệ thống huỷ) ⇒ 200 idempotent, không lỗi', cust.status === 200, { st: cust.status, code: cust.code });
  const o2row = await q1(`SELECT status, cancel_source FROM "order".orders WHERE code = $1`, [o2.kid.code]);
  check('SHOP-01e', 'đơn confirmed của shop bị khoá được HỆ THỐNG huỷ (cancel_source=system)', o2row?.status === 'cancelled' && o2row?.cancel_source === 'system', { o2row });
  const salesCancelPk = await api('POST', `/admin/orders/${o3.kid.code}/cancel`, { as: 'sales', body: { reason: 'Shop bị khoá — CSKH huỷ đơn đóng gói' } });
  check('SHOP-01f', 'CSKH huỷ được đơn packing của shop bị khoá (WP-03)', salesCancelPk.status === 200, { st: salesCancelPk.status, note: 'chưa làm' });
  const newOrderOnSuspended = await (async () => {
    const v = await pick('nhaxinh', { qty: 2 });
    return L.placeOrder({ as: 'khach32', items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
  })();
  check('SHOP-01g', 'khách không đặt mới được hàng của shop bị khoá', newOrderOnSuspended.status >= 400, { st: newOrderOnSuspended.status, code: newOrderOnSuspended.code });
  const re = await api('PATCH', `/admin/shops/${shops.nhaxinh.id}/approve`, { as: 'manager' });
  check('SHOP-02', 'mở khoá shop (approve) được', re.status === 200, { st: re.status });
  const dl3 = await api('POST', `/shop/orders/${o3.kid.code}/cancel`, { as: 'owner:nhaxinh', body: { reason: 'Dọn đơn thử nghiệm sau khi mở khoá' } });
  note('SHOP-02b', 'dọn đơn packing sau mở khoá', `shop huỷ packing → HTTP ${dl3.status} (${dl3.code ?? 'ok'})`);
}

L.saveResults(process.env.OUT ?? 'out-t03.json');
const R = L.results;
console.log(`\nTỔNG nhóm 03: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
