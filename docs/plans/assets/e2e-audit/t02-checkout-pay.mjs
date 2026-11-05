/* Nhóm 02: checkout (CK) + thanh toán vào PayOS (PAY) — gồm các ngoại lệ. */
import * as L from './lib.mjs';
const { check, group, api, q, q1, note, sleep } = L;

const shops = {};
for (const s of ['techzone', 'ngonviet', 'sneaker', 'nhaxinh', 'mobilehub']) shops[s] = await L.shopBySlug(s);
const pick = async (slug, opts) => (await L.pickVariant({ shopId: shops[slug].id, ...opts }))[0];
await L.mockReset();

/* tạo nhanh một đơn PayOS 1 shop, trả về { kid, payos, total, variant } */
async function quickPayos({ as = 'khach12', slug = 'techzone', qty = 1, method = 'payos', voucherCodes, idem } = {}) {
  const v = await pick(slug, { qty: qty + 2 });
  const placed = await L.placeOrder({ as, items: [{ variantId: v.id, qty }], method, voucherCodes, idempotencyKey: idem });
  if (placed.status !== 201) return { placed, v };
  const kid = L.childOrders(placed)[0];
  const payos = method === 'payos' ? await L.payosCodeOf(kid.code) : null;
  return { placed, kid, payos, total: Number(L.money(kid.total)), v };
}

group('CK — Checkout');
// CK-02: 3 shop + voucher sàn
{
  const items = [];
  for (const s of ['techzone', 'ngonviet', 'sneaker']) {
    const v = await pick(s, { qty: 2, maxPrice: 400000 });
    if (v) items.push({ variantId: v.id, qty: 2, shop: s });
  }
  const p = await L.placeOrder({ as: 'khach13', items, method: 'payos', voucherCodes: ['DIENTHOAI50K'] });
  check('CK-02a', '3 shop + voucher sàn: đặt thành công, 3 đơn con', p.status === 201 && L.childOrders(p).length === 3, { st: p.status, code: p.code, msg: p.raw?.message });
  if (p.status === 201) {
    const kids = L.childOrders(p);
    const rows = await q(`SELECT code, subtotal, shipping_fee, discount, platform_discount, shop_discount, total FROM "order".orders WHERE code = ANY($1)`, [kids.map((k) => k.code)]);
    const sumPlat = rows.reduce((a, r) => a + Number(r.platform_discount), 0);
    const okEach = rows.every((r) => Number(r.total) === Number(r.subtotal) + Number(r.shipping_fee) - Number(r.discount));
    check('CK-02b', 'voucher sàn 50.000 phân bổ đủ cho các đơn con (Σ platform_discount = 50.000)', sumPlat === 50000, { sumPlat, rows });
    check('CK-02c', 'mỗi đơn con: total = subtotal + ship − discount', okEach, rows);
    const links = (await L.mockState()).links.length;
    check('CK-02d', 'mỗi đơn con một link PayOS (3 link)', links >= 3, { links });
    const grpRow = await q1(`SELECT total FROM "order".order_groups WHERE code = $1`, [p.data.code]);
    check('CK-02e', 'tổng nhóm = Σ tổng các đơn con', Number(grpRow?.total) === rows.reduce((a, r) => a + Number(r.total), 0), { grp: grpRow, rows });
    globalThis.group3 = { p, kids, rows };
  }
}
// CK-03: COD shop chưa có ví (FITLY official miễn; shop khác không ví)
{
  const nowallet = await L.shopBySlug('beautybox');
  const vs = await L.pickVariant({ shopId: nowallet.id, qty: 1 });
  const p = await L.placeOrder({ as: 'khach14', items: [{ variantId: vs[0].id, qty: 1 }], method: 'cod' });
  check('CK-03', 'COD với shop chưa nộp cọc ⇒ 409 ORDER_COD_NOT_AVAILABLE, không tạo đơn', p.status === 409 && p.code === 'ORDER_COD_NOT_AVAILABLE', { st: p.status, code: p.code });
}
// CK-04: idempotency
{
  const v = await pick('techzone', { qty: 3 });
  const key = `idem-${Date.now()}`;
  const b = await L.stock(v.id);
  const a1 = await L.placeOrder({ as: 'khach15', items: [{ variantId: v.id, qty: 1 }], method: 'payos', idempotencyKey: key });
  // đặt lại cùng key: cần giỏ còn nguyên → gọi POST trực tiếp (placeOrder sẽ xoá giỏ)
  const a2 = await api('POST', '/orders', { as: 'khach15', body: { paymentMethodCode: 'payos', address: L.ADDRESS }, headers: { 'Idempotency-Key': key } });
  const af = await L.stock(v.id);
  check('CK-04a', 'cùng Idempotency-Key đặt 2 lần ⇒ cùng một nhóm đơn', a1.status === 201 && (a2.status === 201 || a2.status === 200) && a2.data?.code === a1.data?.code, { a1: a1.data?.code, a2: a2.data?.code ?? a2.code });
  check('CK-04b', 'tồn chỉ giữ 1 lần', Number(af.reserved) - Number(b.reserved) === 1, { b, af });
  // không key, bấm 2 lần liên tiếp: giỏ đã trống ⇒ lần 2 lỗi giỏ rỗng
  const a3 = await api('POST', '/orders', { as: 'khach15', body: { paymentMethodCode: 'payos', address: L.ADDRESS } });
  check('CK-04c', 'bấm đặt lần 2 không key khi giỏ đã trống ⇒ lỗi rõ (không tạo đơn rỗng)', a3.status >= 400 && a3.status < 500, { st: a3.status, code: a3.code });
}
// CK-06: hai khách tranh món cuối
{
  const v = await pick('techzone', { qty: 3 });
  await q(`UPDATE product.product_variants SET stock = 1, reserved = 0 WHERE id = $1`, [v.id]);
  const [r1, r2] = await Promise.all([
    L.placeOrder({ as: 'khach16', items: [{ variantId: v.id, qty: 1 }], method: 'payos' }),
    L.placeOrder({ as: 'khach17', items: [{ variantId: v.id, qty: 1 }], method: 'payos' }),
  ]);
  const ok = [r1, r2].filter((r) => r.status === 201).length;
  const st = await L.stock(v.id);
  check('CK-06', 'tranh món cuối: đúng 1 thành công, tồn giữ = 1, không âm', ok === 1 && Number(st.reserved) === 1, { r1: r1.status, r2: r2.status, c1: r1.code, c2: r2.code, st });
  await q(`UPDATE product.product_variants SET stock = 40, reserved = 0 WHERE id = $1`, [v.id]);
}
// CK-07: sản phẩm bị ẩn sau khi vào giỏ
{
  const v = await pick('techzone', { qty: 3 });
  await api('DELETE', '/cart', { as: 'khach18' });
  await api('POST', '/cart/items', { as: 'khach18', body: { variantId: v.id, quantity: 1 } });
  await q(`UPDATE product.products SET status = 'hidden' WHERE id = $1`, [v.product_id]);
  L.clearCaches();
  const r = await api('POST', '/orders', { as: 'khach18', body: { paymentMethodCode: 'payos', address: L.ADDRESS } });
  check('CK-07', 'sản phẩm bị ẩn sau khi vào giỏ ⇒ chặn đặt (4xx), không giữ tồn', r.status >= 400 && r.status < 500, { st: r.status, code: r.code });
  await q(`UPDATE product.products SET status = 'active' WHERE id = $1`, [v.product_id]);
  L.clearCaches();
}
// CK-08: chủ shop mua hàng của chính shop
{
  const v = await pick('techzone', { qty: 3 });
  const p = await L.placeOrder({ as: 'owner:techzone', items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  check('CK-08', 'chủ shop mua hàng của chính shop mình bị chặn', p.status >= 400 && p.status < 500, { st: p.status, code: p.code });
}
// CK-09: voucher hết lượt đúng lúc đặt
{
  await q(`DELETE FROM promotion.promotions WHERE code = 'AUDIT1'`);
  await q(`INSERT INTO promotion.promotions (code, name, type, value, min_order_amount, usage_limit, usage_limit_per_user, used_count, applies_to, starts_at, ends_at, is_active, is_public, scope) VALUES ('AUDIT1','audit 1 lượt','fixed_amount',20000,50000,1,1,0,'all', now() - interval '1 day', now() + interval '30 days', true, false, 'platform')`);
  L.clearCaches();
  const v = await pick('ngonviet', { qty: 3, maxPrice: 500000 });
  const [a, b] = await Promise.all([
    L.placeOrder({ as: 'khach19', items: [{ variantId: v.id, qty: 1 }], method: 'payos', voucherCodes: ['AUDIT1'] }),
    L.placeOrder({ as: 'khach20', items: [{ variantId: v.id, qty: 1 }], method: 'payos', voucherCodes: ['AUDIT1'] }),
  ]);
  const ok = [a, b].filter((r) => r.status === 201).length;
  const used = await q1(`SELECT used_count FROM promotion.promotions WHERE code = 'AUDIT1'`);
  check('CK-09', 'voucher còn 1 lượt, 2 khách đặt đồng thời ⇒ đúng 1 thành công, used_count = 1', ok === 1 && used.used_count === 1, { a: a.status, b: b.status, ca: a.code, cb: b.code, used });
  globalThis.voucherOrder = [a, b].find((r) => r.status === 201);
}
// CK-12: COD vượt trần
{
  const vs = await L.pickVariant({ shopId: shops.techzone.id, qty: 1, maxPrice: 20_000_000 });
  const big = vs.sort((x, y) => Number(y.price) - Number(x.price))[0];
  const qty = Math.ceil(5_500_000 / Number(big.price));
  await q(`UPDATE product.product_variants SET stock = GREATEST(stock, $2 + 5) WHERE id = $1`, [big.id, qty]);
  const p = await L.placeOrder({ as: 'khach21', items: [{ variantId: big.id, qty }], method: 'cod' });
  check('CK-12', 'COD > cod_max_amount (5 triệu) bị chặn', p.status === 409 || p.status === 400, { st: p.status, code: p.code, subtotal: qty * Number(big.price) });
}
// CK-05: giá đổi — expectedTotal chưa có
{
  const v = await pick('techzone', { qty: 3 });
  await api('DELETE', '/cart', { as: 'khach22' });
  await api('POST', '/cart/items', { as: 'khach22', body: { variantId: v.id, quantity: 1 } });
  const r = await api('POST', '/orders', { as: 'khach22', body: { paymentMethodCode: 'payos', address: L.ADDRESS, expectedTotal: '1000' } });
  check('CK-05', 'gửi expectedTotal lệch ⇒ 409 ORDER_PRICE_CHANGED (WP-08)', r.status === 409 && r.code === 'ORDER_PRICE_CHANGED', { st: r.status, code: r.code, note: 'WP-08 chưa làm — server bỏ qua expectedTotal và tạo đơn' });
}
// CK-13/14: giới hạn COD khách mới (WP-08)
{
  const nc = await q1(`SELECT u.email FROM identity.users u WHERE u.email LIKE 'khach%@ecofashion.vn' AND NOT EXISTS (SELECT 1 FROM "order".orders o WHERE o.user_id = u.id) LIMIT 1`);
  note('CK-13', 'khách mới (0 đơn) có tồn tại trong dữ liệu mẫu?', nc ? nc.email : 'không có — dữ liệu mẫu mọi khách đều có đơn');
}
// CK-15 / PAY-13: PayOS lỗi khi tạo link
{
  await L.mockCtl({ createLink: '500' });
  const v = await pick('techzone', { qty: 3 });
  const before = await L.stock(v.id);
  const p = await L.placeOrder({ as: 'khach23', items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  const after = await L.stock(v.id);
  const created = p.status === 201;
  note('CK-15', 'PayOS 500 khi tạo link', `HTTP ${p.status} ${p.code ?? ''}; đơn ${created ? 'ĐƯỢC tạo (link null?)' : 'KHÔNG được tạo'}; tồn reserved ${before.reserved}→${after.reserved}`);
  check('CK-15', 'PayOS lỗi ⇒ hoặc đơn tạo kèm cách thanh toán lại (WP-01), hoặc báo lỗi thân thiện và KHÔNG treo tồn', created ? !!L.childOrders(p)[0] : Number(after.reserved) === Number(before.reserved), { st: p.status, code: p.code, msg: p.raw?.message, before, after });
  await L.mockCtl({ createLink: 'ok' });
  // COD không bị ảnh hưởng khi PayOS sập
  const pc = await L.placeOrder({ as: 'khach23', items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
  check('PAY-13b', 'PayOS sập nhưng COD vẫn đặt được', pc.status === 201, { st: pc.status, code: pc.code });
}
// CK-16: PayOS chậm 3s, 6 khách đặt đồng thời
{
  await L.mockCtl({ delayMs: 3000 });
  const t0 = Date.now();
  const users = ['khach24', 'khach25', 'khach26', 'khach27', 'khach28', 'khach29'];
  const rs = await Promise.all(users.map(async (u, i) => {
    const v = await pick(['techzone', 'ngonviet', 'sneaker'][i % 3], { qty: 3 });
    const t = Date.now();
    const r = await L.placeOrder({ as: u, items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
    return { st: r.status, ms: Date.now() - t, code: r.code };
  }));
  await L.mockCtl({ delayMs: 0 });
  const okN = rs.filter((r) => r.st === 201).length;
  const max = Math.max(...rs.map((r) => r.ms));
  check('CK-16', '6 khách đặt PayOS khi PayOS chậm 3s: không lỗi hàng loạt', okN === 6, { rs, totalMs: Date.now() - t0 });
  note('CK-16', 'độ trễ khi PayOS chậm 3s (6 đồng thời)', `max=${max}ms tổng=${Date.now() - t0}ms — gọi HTTP trong transaction nên các đơn xếp hàng`);
}
// validation đầu vào
{
  const v = await pick('techzone', { qty: 3 });
  await api('DELETE', '/cart', { as: 'khach30' });
  const empty = await api('POST', '/orders', { as: 'khach30', body: { paymentMethodCode: 'payos', address: L.ADDRESS } });
  check('CK-20', 'giỏ rỗng ⇒ lỗi 4xx rõ', empty.status >= 400 && empty.status < 500, { st: empty.status, code: empty.code });
  await api('POST', '/cart/items', { as: 'khach30', body: { variantId: v.id, quantity: 1 } });
  const badPhone = await api('POST', '/orders', { as: 'khach30', body: { paymentMethodCode: 'payos', address: { ...L.ADDRESS, phone: '123' } } });
  check('CK-21', 'SĐT sai định dạng ⇒ 400', badPhone.status === 400, { st: badPhone.status });
  const badMethod = await api('POST', '/orders', { as: 'khach30', body: { paymentMethodCode: 'vnpay', address: L.ADDRESS } });
  check('CK-22', 'phương thức thanh toán không hỗ trợ (vnpay) ⇒ 400', badMethod.status === 400, { st: badMethod.status });
  const zero = await api('POST', '/cart/items', { as: 'khach30', body: { variantId: v.id, quantity: 0 } });
  check('CK-23', 'thêm số lượng 0 vào giỏ ⇒ 400', zero.status === 400, { st: zero.status });
  const huge = await api('POST', '/cart/items', { as: 'khach30', body: { variantId: v.id, quantity: 999 } });
  check('CK-24', 'thêm số lượng vượt tối đa/tồn ⇒ 4xx', huge.status >= 400 && huge.status < 500, { st: huge.status, code: huge.code });
  const anon = await api('POST', '/orders', { body: { paymentMethodCode: 'payos', address: L.ADDRESS } });
  check('SEC-09', 'đặt hàng không đăng nhập ⇒ 401', anon.status === 401, { st: anon.status });
}

group('PAY — Thanh toán vào (ngoại lệ)');
await L.mockReset();
// PAY-03: sai chữ ký
{
  const t = await quickPayos({ as: 'khach11' });
  const bad = await L.sendWebhook(t.payos, t.total, { badSignature: true });
  const o = await L.orderRow(t.kid.code);
  check('PAY-03', 'webhook sai chữ ký ⇒ từ chối (4xx) và đơn không đổi', bad.status >= 400 && o.payment_status === 'unpaid', { bad, ps: o.payment_status });
  globalThis.payT = t;
  // webhook mã lạ
  const unk = await L.sendWebhook('9999999999999', 1000);
  check('PAY-03b', 'webhook cho mã PayOS không tồn tại ⇒ không lỗi 5xx', unk.status < 500, unk);
}
// PAY-04: mất webhook (khách đã trả ở PayOS, hệ thống không nhận webhook), đơn quá hạn ⇒ job huỷ
{
  const t = await quickPayos({ as: 'khach11' });
  await L.mockPay(t.payos, t.total); // PayOS ghi nhận đã trả
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '2 minutes' WHERE code = $1`, [t.kid.code]);
  await q(`UPDATE payment.payments SET expires_at = now() - interval '2 minutes' WHERE order_code = $1`, [t.kid.code]);
  const j = L.runJob('cancel-expired');
  const o1 = await L.orderRow(t.kid.code); // job huỷ quá hạn KHÔNG được huỷ đơn mà PayOS báo đã trả (PLAN-0040: có ân hạn, chờ job dò PayOS)
  const j2 = L.runJob('payos-poll'); // job 2 phút hỏi PayOS các link pending quá hạn ⇒ ghi nhận paid
  const o = await L.orderRow(t.kid.code);
  check('PAY-04', 'mất webhook + quá hạn: KHÔNG được huỷ đơn đã trả — job dò PayOS ghi nhận paid', o1.status !== 'cancelled' && o.status !== 'cancelled' && o.payment_status === 'paid', { job: j, job2: j2, before: o1.status, status: o.status, ps: o.payment_status, cancelReason: o.cancel_reason });
}
// PAY-05: ân hạn
{
  const t = await quickPayos({ as: 'khach11' });
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '3 minutes' WHERE code = $1`, [t.kid.code]);
  const j = L.runJob('cancel-expired');
  const o = await L.orderRow(t.kid.code);
  check('PAY-05a', 'quá hạn 3 phút (trong ân hạn 10 phút), PayOS còn PENDING ⇒ CHƯA huỷ', o.status === 'pending', { job: j, status: o.status });
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '20 minutes' WHERE code = $1`, [t.kid.code]);
  const j2 = L.runJob('cancel-expired');
  const o2 = await L.orderRow(t.kid.code);
  check('PAY-05b', 'quá hạn 20 phút, PayOS vẫn chưa trả ⇒ huỷ + nhả tồn', o2.status === 'cancelled', { job: j2, status: o2.status });
  const st = await L.mockState();
  check('PAY-05c', 'huỷ đơn quá hạn cũng huỷ link PayOS', st.links.find((l) => String(l.orderCode) === String(t.payos))?.status === 'CANCELLED', { link: st.links.find((l) => String(l.orderCode) === String(t.payos)) });
  globalThis.cancelledT = t;
}
// PAY-06: tiền về sau khi đơn đã huỷ
{
  const t = globalThis.cancelledT;
  const wh = await L.sendWebhook(t.payos, t.total, { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '9988776655' } });
  const o = await L.orderRow(t.kid.code);
  const rf = await L.refundRows(t.kid.code);
  check('PAY-06a', 'trả muộn sau huỷ: webhook 200, đơn vẫn cancelled, payment paid', wh.status === 200 && o.status === 'cancelled' && o.payment_status === 'paid', { wh, st: o.status, ps: o.payment_status });
  check('PAY-06b', 'tự tạo yêu cầu hoàn đủ số tiền, có TK người trả (payer)', rf.length === 1 && Number(rf[0].amount) === t.total && rf[0].payee_source === 'payer', { rf });
  globalThis.lateRefund = rf[0];
}
// PAY-07: trả thiếu
{
  const t = await quickPayos({ as: 'khach11' });
  const wh = await L.sendWebhook(t.payos, Math.floor(t.total / 2), { payer: { bin: '970436', name: 'A', number: '123456789' } });
  const o = await L.orderRow(t.kid.code);
  const tx = await q(`SELECT type,status,amount FROM payment.payment_transactions WHERE payment_id = (SELECT id FROM payment.payments WHERE order_code=$1) ORDER BY created_at`, [t.kid.code]);
  check('PAY-07a', 'trả thiếu: KHÔNG ghi paid, có giao dịch mismatch', wh.status < 500 && o.payment_status !== 'paid' && tx.some((x) => x.status === 'mismatch' || x.type === 'mismatch'), { wh, ps: o.payment_status, tx });
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '20 minutes' WHERE code = $1`, [t.kid.code]);
  L.runJob('cancel-expired');
  const o2 = await L.orderRow(t.kid.code);
  const rf = await L.refundRows(t.kid.code);
  check('PAY-07b', 'hết hạn ⇒ huỷ đơn VÀ tự hoàn đúng số đã nhận (mismatch) — tiền khách không kẹt', o2.status === 'cancelled' && rf.length === 1 && Number(rf[0].amount) === Math.floor(t.total / 2), { st: o2.status, rf, note: 'WP-01 §2.4 chưa làm' });
}
// PAY-08: trả thừa
{
  const t = await quickPayos({ as: 'khach11' });
  const wh = await L.sendWebhook(t.payos, t.total + 30000, { payer: { bin: '970436', name: 'A', number: '123456789' } });
  const o = await L.orderRow(t.kid.code);
  const rf = await L.refundRows(t.kid.code);
  check('PAY-08', 'trả thừa 30.000: ghi paid + hoàn phần thừa 30.000 (mismatch)', o.payment_status === 'paid' && rf.some((r) => Number(r.amount) === 30000), { wh, ps: o.payment_status, rf, note: 'WP-01 §2.4 chưa làm' });
}
// PAY-09: trả hai lần cùng một đơn
{
  const t = await quickPayos({ as: 'khach11' });
  await L.sendWebhook(t.payos, t.total, { reference: 'REF-A-' + Date.now() });
  const wh2 = await L.sendWebhook(t.payos, t.total, { reference: 'REF-B-' + Date.now(), payer: { bin: '970436', name: 'A', number: '123456789' } });
  const rf = await L.refundRows(t.kid.code);
  const o = await L.orderRow(t.kid.code);
  check('PAY-09', 'trả 2 lần (mã giao dịch khác nhau): khoản 2 ⇒ hoàn duplicate_payment, đơn không đổi', rf.length === 1 && rf[0].kind === 'duplicate_payment' && o.payment_status === 'paid', { wh2, rf, ps: o.payment_status });
}
// PAY-10 / PAY-11: thanh toán lại
{
  const t = await quickPayos({ as: 'khach11' });
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '1 minutes' WHERE code = $1`, [t.kid.code]);
  await q(`UPDATE payment.payments SET expires_at = now() - interval '1 minutes' WHERE order_code = $1`, [t.kid.code]);
  const r = await api('POST', `/payments/payos/retry/${t.kid.code}`, { as: 'khach11' });
  const o = await L.orderRow(t.kid.code);
  const ext = new Date(o.payment_expires_at) > new Date();
  check('PAY-10a', 'thanh toán lại ⇒ trả link mới', r.status === 200 && !!r.data?.paymentUrl, r);
  check('PAY-10b', 'thanh toán lại GIA HẠN hạn của đơn (nếu không job huỷ ngay)', ext, { exp: o.payment_expires_at, note: 'WP-01 §2.2 chưa làm' });
  const rc = await api('POST', `/payments/payos/retry/${globalThis.cancelledT.kid.code}`, { as: 'khach12' });
  check('PAY-11', 'thanh toán lại đơn đã huỷ bị chặn (4xx)', rc.status >= 400 && rc.status < 500, { st: rc.status, code: rc.code });
  const other = await api('POST', `/payments/payos/retry/${t.kid.code}`, { as: 'khach13' });
  check('SEC-02p', 'khách khác thanh toán lại đơn của người khác ⇒ 404/403', other.status === 404 || other.status === 403, { st: other.status });
}
// PAY-15: nhóm 3 đơn, trả 2/3
{
  const g = globalThis.group3;
  if (g) {
    const [k1, k2, k3] = g.kids;
    for (const k of [k1, k2]) {
      const code = await L.payosCodeOf(k.code);
      await L.sendWebhook(code, Number(L.money(k.total)));
    }
    await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '20 minutes' WHERE code = $1`, [k3.code]);
    L.runJob('cancel-expired');
    const rows = await q(`SELECT code, status, payment_status FROM "order".orders WHERE code = ANY($1) ORDER BY code`, [[k1.code, k2.code, k3.code]]);
    const promo = await q1(`SELECT used_count FROM promotion.promotions WHERE code='DIENTHOAI50K'`);
    check('PAY-15a', 'nhóm 3 đơn: 2 đơn đã trả giữ nguyên, đơn chưa trả bị huỷ', rows.filter((r) => r.payment_status === 'paid').length === 2 && rows.filter((r) => r.status === 'cancelled').length === 1, rows);
    note('PAY-15b', 'voucher sàn sau khi 1/3 đơn con bị huỷ', `used_count=${promo.used_count}; phần giảm của đơn bị huỷ không được tính lại cho các đơn còn lại (đúng thiết kế)`);
  }
}
// Return page
{
  const t = await quickPayos({ as: 'khach11' });
  await L.mockPay(t.payos, t.total);
  const r = await api('GET', `/payments/payos/return?orderCode=${t.payos}`);
  const o = await L.orderRow(t.kid.code);
  check('PAY-17', 'trang return: hỏi PayOS rồi ghi nhận paid (khách quay về trang kết quả)', r.status === 200 && o.payment_status === 'paid', { r: r.raw, ps: o.payment_status });
  const r2 = await api('GET', `/payments/payos/return?orderCode=${t.payos}`);
  check('PAY-17b', 'gọi lại trang return không lỗi / không nhân đôi', r2.status === 200 && (await L.refundRows(t.kid.code)).length === 0, r2.raw);
}
// PayOS getLink down khi job chạy
{
  const t = await quickPayos({ as: 'khach11' });
  await L.mockCtl({ getLink: 'down' });
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '30 minutes' WHERE code = $1`, [t.kid.code]);
  L.runJob('cancel-expired');
  const o = await L.orderRow(t.kid.code);
  note('PAY-18', 'PayOS tra cứu lỗi khi job huỷ quá hạn (đơn quá hạn 30 phút)', `status=${o.status} (huỷ khi không hỏi được PayOS → rủi ro huỷ oan nếu khách đã trả; WP-01 nói: PayOS lỗi quá 60' mới huỷ)`);
  await L.mockCtl({ getLink: 'ok' });
}

L.saveResults(process.env.OUT ?? 'out-t02.json');
const R = L.results;
console.log(`\nTỔNG nhóm 02: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
