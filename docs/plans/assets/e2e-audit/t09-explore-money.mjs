/*
 * Khảo sát ngoại lệ về TIỀN sau Tầng 1–2 của PLAN-0040 (trả thiếu/thừa/trùng, hoàn tự động, giữ tay chi trả, thanh toán lại).
 * Mục đích: tìm lỗi CÒN SÓT ở những ca bộ audit t01–t08 chưa chạm tới. Mỗi ca kiểm "bảo toàn tiền": Σ khách đã chuyển = phần đơn giữ lại + Σ hoàn (đã tạo).
 * Chạy: sau reset-env.sh (backend cô lập + PayOS giả). Biến môi trường như run-all.sh.
 */
import { createHmac } from 'node:crypto';
import * as L from './lib.mjs';
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.stack ?? e); process.exit(3); });
const { check, group, api, q, q1, note } = L;
const num = (x) => Number(L.money(x));
const USERS = Array.from({ length: 20 }, (_, i) => `khach${13 + i}`);
let ui = 0;
const nextUser = () => USERS[ui++ % USERS.length];

await L.mockReset();
await L.mockBalance(5_000_000_000);
L.resetRateLimit();
const techzone = await L.shopBySlug('techzone');
const PAYER = { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' };

/* Giá đơn PHẢI > 100k + biên (các ca dùng khoản chuyển cố định 100k/50k): chọn biến thể 250k–1,5 triệu. */
async function mk(slug = 'techzone', maxPrice = 1500000) {
  const shop = slug === 'techzone' ? techzone : await L.shopBySlug(slug);
  const v = (await L.pickVariant({ shopId: shop.id, qty: 4, maxPrice })).find((x) => Number(x.price) >= 250000);
  if (!v) throw new Error(`shop ${slug} không có biến thể giá 250k–${maxPrice}`);
  const as = nextUser();
  L.resetRateLimit();
  const p = await L.placeOrder({ as, items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  if (p.status !== 201) throw new Error(`đặt lỗi ${p.status} ${p.code} ${p.raw?.message}`);
  const kid = L.childOrders(p)[0];
  return { as, code: kid.code, total: num(kid.total), payos: await L.payosCodeOf(kid.code), shop };
}
/* Webhook KHÔNG có `reference` và `transactionDateTime` (PayOS thật luôn có — thử độ bền khử trùng). */
async function bareWebhook(payos, amount) {
  const data = { orderCode: Number(payos), amount: Number(amount), description: 'AUDIT', accountNumber: '12345678', currency: 'VND', paymentLinkId: `pl-${payos}`, code: '00', desc: 'Thành công', counterAccountBankId: PAYER.bin, counterAccountBankName: '', counterAccountName: PAYER.name, counterAccountNumber: PAYER.number, virtualAccountName: '', virtualAccountNumber: '' };
  const canonical = Object.keys(data).sort().map((k) => `${k}=${data[k] ?? ''}`).join('&');
  const signature = createHmac('sha256', L.CHECKSUM).update(canonical, 'utf8').digest('hex');
  const r = await fetch(`${L.BASE}/payments/payos/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ code: '00', desc: 'success', success: true, data, signature }) });
  return { status: r.status, body: await r.text() };
}
const pay = (c) => L.paymentRows(c);
const sumRefunds = async (c, statuses = ['requested', 'processing', 'done']) => (await L.refundRows(c)).filter((r) => statuses.includes(r.status)).reduce((a, r) => a + num({ amount: r.amount }), 0);
const expireNow = async (code) => {
  await q(`UPDATE "order".orders SET payment_expires_at = now() - interval '3 hours' WHERE code = $1`, [code]);
  await q(`UPDATE payment.payments SET expires_at = now() - interval '3 hours' WHERE order_code = $1 AND status = 'pending'`, [code]);
};
/* Đánh dấu mọi lệnh chi giả SUCCEEDED rồi chạy job đối soát nhiều lượt (job xoay vòng theo lô nên cần > 1 lượt khi DB có nhiều hoàn đang xử lý). */
async function settleMockPayouts(codes = []) {
  for (let i = 0; i < 6; i++) {
    for (const po of (await L.mockState()).payouts) await L.mockPayoutState({ id: po.id }, 'SUCCEEDED');
    L.runJob('refund-reconcile');
    if (codes.length === 0) return;
    const open = await q(`SELECT 1 FROM payment.refunds WHERE order_code = ANY($1) AND status = 'processing'`, [codes]);
    if (open.length === 0) return;
  }
}

/* ===================================================================== TIỀN LỆCH */
group('MNY — trả thiếu / thừa / trùng');
{
  // E1: trả thiếu rồi trả nốt TRƯỚC hạn ⇒ paid, không hoàn
  const o = await mk();
  const a = await L.sendWebhook(o.payos, o.total - 100000, { payer: PAYER });
  const mid = await L.orderRow(o.code);
  const b = await L.sendWebhook(o.payos, 100000, { payer: PAYER });
  const end = await L.orderRow(o.code);
  const p = (await pay(o.code))[0];
  check('MNY-01', 'trả thiếu 100k rồi trả nốt ⇒ đơn chưa paid sau lần 1, paid sau lần 2, KHÔNG phát sinh hoàn, received = tổng đơn', a.status === 200 && b.status === 200 && mid.payment_status !== 'paid' && end.payment_status === 'paid' && (await L.refundRows(o.code)).length === 0 && num({ amount: p.received_amount }) === o.total, { a: a.status, b: b.status, mid: mid.payment_status, end: end.payment_status, received: p.received_amount, total: o.total });
}
{
  // E2: trả thiếu → hết hạn → đơn huỷ + hoàn phần đã nhận → khách chuyển nốt PHẦN CÒN LẠI sau khi đã huỷ
  const o = await mk();
  await L.sendWebhook(o.payos, 100000, { payer: PAYER });
  await expireNow(o.code);
  L.runJob('cancel-expired');
  const afterCancel = await L.orderRow(o.code);
  const rf1 = await L.refundRows(o.code);
  check('MNY-02a', 'trả thiếu rồi hết hạn ⇒ đơn huỷ + CÓ yêu cầu hoàn `mismatch` đúng số đã nhận (100k)', afterCancel.status === 'cancelled' && rf1.length === 1 && rf1[0].kind === 'mismatch' && num({ amount: rf1[0].amount }) === 100000, { status: afterCancel.status, rf: rf1.map((r) => [r.kind, r.amount, r.status]) });
  const late = await L.sendWebhook(o.payos, o.total - 100000, { payer: PAYER });
  const rf2 = await L.refundRows(o.code);
  const p = (await pay(o.code))[0];
  const refundSum = rf2.filter((r) => r.status !== 'failed').reduce((s, r) => s + num({ amount: r.amount }), 0);
  check('MNY-02b', 'khách chuyển nốt PHẦN CÒN LẠI sau khi đơn đã huỷ ⇒ webhook KHÔNG 500 (PayOS không bị bắt gửi lại mãi)', late.status === 200, { st: late.status, body: late.body, rf: rf2.map((r) => [r.kind, r.amount, r.status]) });
  check('MNY-02c', 'bảo toàn tiền: Σ hoàn đã tạo = Σ khách thật sự chuyển (đơn đã huỷ không giữ đồng nào)', refundSum === o.total, { received: p.received_amount, refundSum, total: o.total, refunds: rf2.map((r) => [r.kind, r.amount, r.status]), order: (await L.orderRow(o.code)).status, payStatus: p.status });
}
{
  // E3: webhook không có reference — gửi lại cùng payload (replay) 2 lần cho khoản THIẾU
  const o = await mk();
  const a = await bareWebhook(o.payos, Math.floor(o.total / 2));
  const b = await bareWebhook(o.payos, Math.floor(o.total / 2));
  const end = await L.orderRow(o.code);
  note('MNY-03', 'replay webhook THIẾU `reference` + `transactionDateTime` (PayOS thật luôn có hai trường này)', `st=${a.status}/${b.status} → đơn ${end.payment_status} (nếu paid = đã cộng dồn hai lần cùng một khoản chuyển)`);
  check('MNY-03a', '[củng cố — PayOS thật luôn kèm mã khoản] hai webhook cùng số tiền, KHÔNG có mã khoản: không được tự coi là đủ tiền (không mã khoản = không phân biệt replay với chuyển thêm)', end.payment_status !== 'paid', { a: a.status, b: b.status, ps: end.payment_status, hint: 'khi thiếu reference/transactionDateTime nên coi là replay và KHÔNG cộng dồn' });
}
{
  // E3b: replay cùng reference
  const o = await mk();
  const ref = `REF-${Date.now()}`;
  const a = await L.sendWebhook(o.payos, Math.floor(o.total / 2), { reference: ref, payer: PAYER });
  const b = await L.sendWebhook(o.payos, Math.floor(o.total / 2), { reference: ref, payer: PAYER });
  const end = await L.orderRow(o.code);
  const p = (await pay(o.code))[0];
  check('MNY-03b', 'replay CÙNG reference cho khoản thiếu ⇒ chỉ cộng MỘT lần, đơn chưa paid', end.payment_status !== 'paid' && num({ amount: p.received_amount }) === Math.floor(o.total / 2), { a: a.status, b: b.status, ps: end.payment_status, received: p.received_amount });
}
{
  // E4: trả thừa rồi KHÁCH HUỶ đơn đã trả ⇒ tổng hoàn = tổng đã chuyển
  const o = await mk();
  const w = await L.sendWebhook(o.payos, o.total + 30000, { payer: PAYER });
  const c = await api('POST', `/orders/${o.code}/cancel`, { as: o.as, body: { reason: 'Huỷ sau khi trả thừa' } });
  const rf = await L.refundRows(o.code);
  const sum = rf.reduce((s, r) => s + num({ amount: r.amount }), 0);
  check('MNY-04', 'trả thừa 30k + khách huỷ ⇒ huỷ 200, tổng hoàn = tổng đã chuyển (đơn + 30k thừa), gồm 1 `mismatch` + 1 hoàn đơn', w.status === 200 && c.status === 200 && sum === o.total + 30000 && rf.some((r) => r.kind === 'mismatch'), { w: w.status, c: c.status, c_code: c.code, sum, expect: o.total + 30000, rf: rf.map((r) => [r.kind, r.amount, r.status]) });
  // xử lý hoàn cả hai rồi kiểm số liệu payment
  for (const r of rf) await api('POST', `/admin/refunds/${r.id}/process`, { as: 'accountant', body: {} });
  await settleMockPayouts([o.code]);
  const p = (await pay(o.code))[0];
  const o2 = await L.orderRow(o.code);
  const rf2 = await L.refundRows(o.code);
  check('MNY-04b', 'hoàn xong cả hai khoản: refunded_amount = received_amount, payment `refunded`, order `refunded`', rf2.every((r) => r.status === 'done') && num({ amount: p.refunded_amount }) === o.total + 30000 && p.status === 'refunded' && o2.payment_status === 'refunded', { refunds: rf2.map((r) => [r.kind, r.amount, r.status]), refunded: p.refunded_amount, pstatus: p.status, ops: o2.payment_status });
}
{
  // E5: trả HAI LẦN cùng một link (reference khác) rồi khách huỷ đơn
  const o = await mk();
  await L.sendWebhook(o.payos, o.total, { payer: PAYER, reference: 'DUP-A' });
  await L.sendWebhook(o.payos, o.total, { payer: PAYER, reference: 'DUP-B' });
  const mid = await L.orderRow(o.code);
  const rfMid = await L.refundRows(o.code);
  check('MNY-05a', 'trả hai lần cùng link ⇒ đơn vẫn paid MỘT lần, có đúng 1 hoàn `duplicate_payment` = số tiền khoản thứ hai', mid.payment_status === 'paid' && rfMid.length === 1 && rfMid[0].kind === 'duplicate_payment' && num({ amount: rfMid[0].amount }) === o.total, { ps: mid.payment_status, rf: rfMid.map((r) => [r.kind, r.amount, r.status]) });
  const c = await api('POST', `/orders/${o.code}/cancel`, { as: o.as, body: { reason: 'Huỷ sau khi trả trùng' } });
  const rf = await L.refundRows(o.code);
  const sum = rf.reduce((s, r) => s + num({ amount: r.amount }), 0);
  check('MNY-05b', 'huỷ đơn sau khi trả trùng ⇒ 200 và tổng hoàn = 2 × tổng đơn (không chặn bởi trần hoàn)', c.status === 200 && sum === 2 * o.total, { c: c.status, code: c.code, sum, expect: 2 * o.total, rf: rf.map((r) => [r.kind, r.amount, r.status]) });
}
{
  // E5c: hai webhook trùng reference ĐỒNG THỜI trên đơn đã paid + một khoản khác
  const o = await mk();
  const ref = `SAME-${Date.now()}`;
  const rs = await Promise.all([L.sendWebhook(o.payos, o.total, { payer: PAYER, reference: ref }), L.sendWebhook(o.payos, o.total, { payer: PAYER, reference: ref }), L.sendWebhook(o.payos, o.total, { payer: PAYER, reference: ref })]);
  const rf = await L.refundRows(o.code);
  check('MNY-05c', 'ba webhook GIỐNG HỆT đồng thời ⇒ không 500, đơn paid, KHÔNG có hoàn', rs.every((r) => r.status === 200) && rf.length === 0 && (await L.orderRow(o.code)).payment_status === 'paid', { st: rs.map((r) => r.status), rf: rf.length });
}

{
  // E6: trả thiếu → khách bấm thanh toán lại (link mới) → trả ĐỦ link mới ⇒ giữ đơn, hoàn phần thiếu cũ
  const o = await mk();
  await L.sendWebhook(o.payos, 100000, { payer: PAYER });
  const r = await api('POST', `/payments/payos/retry/${o.code}`, { as: o.as });
  const payos2 = await L.payosCodeOf(o.code);
  const w = await L.sendWebhook(payos2, o.total, { payer: PAYER });
  const ord = await L.orderRow(o.code);
  const refunds = await L.refundRows(o.code);
  const keep = ord.payment_status === 'paid' ? o.total : 0;
  const refundSum = refunds.reduce((s, x) => s + num({ amount: x.amount }), 0);
  check('MNY-06', 'trả thiếu 100k → thanh toán lại → trả đủ link mới ⇒ đơn paid, 100k của link cũ được hoàn (bảo toàn: đã chuyển 100k + đủ = giữ đơn + hoàn)', r.status === 200 && w.status === 200 && ord.payment_status === 'paid' && keep + refundSum === 100000 + o.total, { retry: r.status, w: w.status, ps: ord.payment_status, refundSum, expect: 100000 + o.total - keep, refunds: refunds.map((x) => [x.kind, x.amount, x.status]) });
}
{
  // E7: trả thiếu rồi trả thêm một khoản đủ đơn ⇒ paid + hoàn phần thừa
  const o = await mk();
  await L.sendWebhook(o.payos, 100000, { payer: PAYER });
  const w = await L.sendWebhook(o.payos, o.total, { payer: PAYER }); // 100k + total > total
  const ord = await L.orderRow(o.code);
  const refunds = await L.refundRows(o.code);
  check('MNY-07', 'trả thiếu 100k rồi trả thêm một khoản đủ đơn ⇒ đơn paid + hoàn đúng 100k thừa', w.status === 200 && ord.payment_status === 'paid' && refunds.length === 1 && refunds[0].kind === 'mismatch' && num({ amount: refunds[0].amount }) === 100000, { w: w.status, ps: ord.payment_status, refunds: refunds.map((x) => [x.kind, x.amount, x.status]) });
}
{
  // E8: sau khi đơn đã huỷ + đã có hoàn mismatch, khách chuyển thêm một khoản vẫn CHƯA đủ ⇒ khoản mới có được hoàn không?
  const o = await mk();
  await L.sendWebhook(o.payos, 100000, { payer: PAYER });
  await api('POST', `/orders/${o.code}/cancel`, { as: o.as, body: { reason: 'Huỷ khi mới trả thiếu' } });
  const w = await L.sendWebhook(o.payos, 50000, { payer: PAYER });
  const refunds = await L.refundRows(o.code);
  const p = (await pay(o.code))[0];
  const refundSum = refunds.reduce((s, x) => s + num({ amount: x.amount }), 0);
  check('MNY-08', 'đơn đã huỷ (đã có hoàn 100k), khách chuyển thêm 50k (vẫn chưa đủ) ⇒ webhook 200 VÀ khoản 50k cũng được hoàn (Σ hoàn = Σ đã nhận = 150k)', w.status === 200 && refundSum === 150000, { w: w.status, received: p.received_amount, refundSum, refunds: refunds.map((x) => [x.kind, x.amount, x.status]) });
}
{
  // E9: khách huỷ ĐƠN rồi mới chuyển thiếu lần đầu (payment đã cancelled, chưa từng nhận)
  const o = await mk();
  await api('POST', `/orders/${o.code}/cancel`, { as: o.as, body: { reason: 'Huỷ trước khi trả' } });
  const w = await L.sendWebhook(o.payos, 100000, { payer: PAYER });
  const refunds = await L.refundRows(o.code);
  const refundSum = refunds.reduce((s, x) => s + num({ amount: x.amount }), 0);
  check('MNY-09', 'đơn đã huỷ, khách chuyển 100k vào link cũ (thiếu) ⇒ webhook 200 và 100k được hoàn', w.status === 200 && refundSum === 100000, { w: w.status, refundSum, refunds: refunds.map((x) => [x.kind, x.amount, x.status]) });
}

/* ===================================================================== THANH TOÁN LẠI / POLL */
group('RTY — thanh toán lại, hạn, poll');
{
  const o = await mk();
  await q(`UPDATE "order".orders SET payment_expires_at = now() + interval '1 minute' WHERE code = $1`, [o.code]);
  const r = await api('POST', `/payments/payos/retry/${o.code}`, { as: o.as });
  const ord = await L.orderRow(o.code);
  const left = (new Date(ord.payment_expires_at).getTime() - Date.now()) / 60000;
  check('RTY-01', 'thanh toán lại ⇒ 200 và HẠN ĐƠN được gia hạn (≥ 20 phút)', r.status === 200 && left > 20, { st: r.status, code: r.code, minutesLeft: Math.round(left) });
}
{
  // E12: hai lần bấm "thanh toán lại" ĐỒNG THỜI
  const o = await mk();
  const rs = await Promise.all([api('POST', `/payments/payos/retry/${o.code}`, { as: o.as }), api('POST', `/payments/payos/retry/${o.code}`, { as: o.as })]);
  const ps = await pay(o.code);
  const pending = ps.filter((p) => p.status === 'pending');
  check('RTY-02', 'bấm "thanh toán lại" hai lần ĐỒNG THỜI ⇒ không 5xx, ít nhất một 200, chỉ MỘT payment đang chờ (không để link mồ côi còn trả được)', rs.every((r) => r.status < 500) && rs.some((r) => r.status === 200) && pending.length === 1, { st: rs.map((r) => r.status), payments: ps.map((p) => p.status) });
  note('RTY-02b', 'lần bấm thứ hai đồng thời trả gì', rs.map((r) => `${r.status} ${r.code ?? ''} "${(r.message ?? '').slice(0, 40)}"`).join(' | ') + ' (409 COMMON_DUPLICATE = đụng chỉ mục "một payment chờ/đơn"; nên trả lại link hiện có thay vì lỗi)');
}
{
  // poll: mất webhook, link PAID ở PayOS ⇒ job poll ghi nhận trước hạn huỷ
  const o = await mk();
  await L.mockPay(o.payos, o.total);
  await q(`UPDATE payment.payments SET created_at = now() - interval '20 minutes', last_checked_at = NULL WHERE order_code = $1`, [o.code]);
  const j = L.runJob('payos-poll');
  const ord = await L.orderRow(o.code);
  check('RTY-03', 'mất webhook + PayOS báo PAID ⇒ job poll ghi nhận paid', ord.payment_status === 'paid', { job: j, ps: ord.payment_status });
}
{
  // poll không được cộng dồn khi PayOS báo số luỹ kế (thiếu)
  const o = await mk();
  await L.sendWebhook(o.payos, 100000, { payer: PAYER });
  await L.mockPay(o.payos, 100000); // PayOS giả: link báo đã trả 100k (luỹ kế)
  await q(`UPDATE payment.payments SET created_at = now() - interval '20 minutes', last_checked_at = NULL WHERE order_code = $1`, [o.code]);
  L.runJob('payos-poll');
  const p = (await pay(o.code))[0];
  check('RTY-04', 'poll với số luỹ kế = số webhook đã ghi ⇒ KHÔNG cộng dồn lần hai (received vẫn 100k)', num({ amount: p.received_amount }) === 100000, { received: p.received_amount });
}

/* ===================================================================== TỰ CHI HOÀN */
group('AUTO — tự chi hoàn nhỏ');
{
  await L.setSetting('refund.auto_max_amount', 5_000_000);
  // Mỗi lượt job chỉ xử lý 20 khoản cũ nhất (limit=20): các khoản `requested` tích tụ từ bài trước sẽ chiếm lô và khoản của bài này rơi sang lượt sau ⇒ gạt chúng sang xử lý tay.
  await q(`UPDATE payment.refunds SET needs_manual = true WHERE status = 'requested' AND method = 'gateway' AND needs_manual = false`);
  const o = await mk();
  await L.sendWebhook(o.payos, o.total, { payer: PAYER });
  await api('POST', `/orders/${o.code}/cancel`, { as: o.as, body: { reason: 'Huỷ để thử tự chi' } });
  const rf0 = (await L.refundRows(o.code))[0];
  const mineCount = async () => (await L.mockState()).payouts.filter((x) => (x.referenceId ?? '').startsWith(rf0.id)).length;
  const before = await mineCount();
  const j1 = L.runJob('refund-auto');
  const mid = await mineCount();
  const j2 = L.runJob('refund-auto');
  const after = await mineCount();
  const rf = (await L.refundRows(o.code))[0];
  check('AUTO-01', 'hoàn ≤ ngưỡng ⇒ job tự gửi ĐÚNG MỘT lệnh PayOS cho khoản này; chạy lại không gửi thêm', before === 0 && mid === 1 && after === 1 && ['processing', 'done'].includes(rf.status), { before, mid, after, status: rf.status, j1, j2 });
  await settleMockPayouts([o.code]);
  check('AUTO-02', 'PayOS báo thành công ⇒ refund `done` (chỉ sau khi PayOS chốt)', (await L.refundRows(o.code))[0].status === 'done', { rf: (await L.refundRows(o.code)).map((r) => r.status) });
}
{
  await L.setSetting('refund.auto_max_amount', 1000);
  const o = await mk();
  await L.sendWebhook(o.payos, o.total, { payer: PAYER });
  await api('POST', `/orders/${o.code}/cancel`, { as: o.as, body: { reason: 'Huỷ — vượt ngưỡng tự chi' } });
  const before = (await L.mockState()).payouts.length;
  L.runJob('refund-auto');
  const rf = (await L.refundRows(o.code))[0];
  check('AUTO-03', 'hoàn VƯỢT ngưỡng ⇒ không tự chi, giữ `requested` cho kế toán', rf.status === 'requested' && (await L.mockState()).payouts.length === before, { status: rf.status });
  await L.setSetting('refund.auto_max_amount', 2000000);
}
{
  // ngưỡng 0 = tắt
  await L.setSetting('refund.auto_max_amount', 0);
  const o = await mk();
  await L.sendWebhook(o.payos, o.total, { payer: PAYER });
  await api('POST', `/orders/${o.code}/cancel`, { as: o.as, body: { reason: 'Huỷ — tự chi tắt' } });
  L.runJob('refund-auto');
  check('AUTO-04', 'ngưỡng 0 = TẮT tự chi', (await L.refundRows(o.code))[0].status === 'requested', {});
  await L.setSetting('refund.auto_max_amount', 2000000);
}
{
  // trả thừa nhỏ: hoàn `mismatch` có tự chi được không (và có TK người trả)?
  await L.setSetting('refund.auto_max_amount', 5_000_000);
  const o = await mk();
  await L.sendWebhook(o.payos, o.total + 20000, { payer: PAYER });
  const before = (await L.mockState()).payouts.length;
  L.runJob('refund-auto');
  const rf = (await L.refundRows(o.code)).find((r) => r.kind === 'mismatch');
  note('AUTO-05', 'hoàn phần thừa (`mismatch`) có được tự chi không', `${rf?.status} · payouts +${(await L.mockState()).payouts.length - before} (thiết kế: tự chi — kế toán chỉ được báo)`);
  await settleMockPayouts();
}

/* ===================================================================== GIỮ TAY / KỲ CHI */
group('HLD — giữ tay chi trả');
{
  const shop = await L.shopBySlug('techzone');
  const owner = 'owner:techzone';
  const hold = (as, body) => api('POST', '/admin/payouts/holds', { as, body });
  const noReason = await hold('accountant', { shopId: shop.id, reason: '' });
  const unknown = await hold('accountant', { shopId: '00000000-0000-0000-0000-000000000000', reason: 'Shop không tồn tại' });
  const byCs = await hold('sales', { shopId: shop.id, reason: 'CSKH thử giữ' });
  const byOwner = await hold(owner, { shopId: shop.id, reason: 'Chủ shop thử giữ' });
  check('HLD-01', 'giữ tay: thiếu lý do ⇒ 400; shop không tồn tại ⇒ 4xx (không 5xx); CSKH & chủ shop ⇒ 403', noReason.status === 400 && unknown.status >= 400 && unknown.status < 500 && byCs.status === 403 && byOwner.status === 403, { noReason: noReason.status, unknown: unknown.status, cs: byCs.status, owner: byOwner.status });
  const ok = await hold('accountant', { shopId: shop.id, reason: 'Nghi ngờ gian lận giao hàng — kiểm thử' });
  const [dup1, dup2] = await Promise.all([hold('accountant', { shopId: shop.id, reason: 'Trùng 1' }), hold('admin', { shopId: shop.id, reason: 'Trùng 2' })]);
  check('HLD-02', 'giữ tay hợp lệ ⇒ 2xx; giữ lần nữa khi đang giữ (kể cả đồng thời) ⇒ 409, KHÔNG 500', ok.status < 300 && dup1.status === 409 && dup2.status === 409, { ok: ok.status, dup1: dup1.status, dup2: dup2.status, codes: [dup1.code, dup2.code] });
  const list = await api('GET', `/admin/payouts/holds?shopId=${shop.id}`, { as: 'accountant' });
  const holdId = ok.data?.id ?? list.data?.[0]?.id ?? list.data?.content?.[0]?.id;
  check('HLD-03', 'liệt kê lệnh giữ theo shop', list.status === 200 && !!holdId, { st: list.status });

  // đối soát khi đang giữ
  const vs = (await L.pickVariant({ shopId: shop.id, qty: 4, maxPrice: 900000 }))[0];
  const p = await L.placeOrder({ as: nextUser(), items: [{ variantId: vs.id, qty: 1 }], method: 'payos' });
  const kid = L.childOrders(p)[0];
  await L.sendWebhook(await L.payosCodeOf(kid.code), num(kid.total), { payer: PAYER });
  for (const s of ['confirmed', 'packing', 'shipping', 'delivered']) await api('PUT', `/shop/orders/${kid.code}/status`, { as: owner, body: { status: s, ...(s === 'shipping' ? { trackingUrl: 'https://track.example.com/X1' } : {}) } });
  await q(`UPDATE "order".orders SET status='completed', delivered_at = now() - interval '8 days', completed_at = now() - interval '1 day' WHERE code = $1`, [kid.code]);
  await L.setSetting('payout.min_amount', 1000);
  const start = (await q1(`SELECT max(period_end) AS e FROM payment.shop_payouts`))?.e ?? new Date('2020-01-01');
  const run = await api('POST', '/admin/payouts/run', { as: 'accountant', body: { periodStart: new Date(start).toISOString(), periodEnd: new Date().toISOString(), shopId: shop.id } });
  const po = run.data?.[0];
  check('HLD-04', 'chạy kỳ cho shop đang bị giữ tay ⇒ kỳ `held` kèm lý do, KHÔNG có lệnh chi PayOS', po?.status === 'held' && !!po?.holdReason, { status: po?.status, reason: po?.holdReason, st: run.status });
  const vendorView = await api('GET', `/shop/payouts/${po?.id}`, { as: owner });
  note('HLD-05', 'chủ shop có thấy LÝ DO giữ tay nội bộ của sàn không', `GET /shop/payouts/:id → ${vendorView.status}; holdReason=${JSON.stringify(vendorView.data?.holdReason ?? null)}`);
  const relBlocked = await api('POST', `/admin/payouts/${po?.id}/release`, { as: 'accountant' });
  check('HLD-06', 'mở giữ kỳ khi LỆNH GIỮ TAY còn hiệu lực ⇒ 409 kèm lý do (không 200 im lặng)', relBlocked.status === 409 && !!relBlocked.message, { st: relBlocked.status, msg: relBlocked.message });
  const rel = await api('POST', `/admin/payouts/holds/${holdId}/release`, { as: 'accountant' });
  const rel2 = await api('POST', `/admin/payouts/holds/${holdId}/release`, { as: 'accountant' });
  check('HLD-07', 'mở lệnh giữ ⇒ 2xx; mở lần hai ⇒ 4xx (không 5xx)', rel.status < 300 && rel2.status >= 400 && rel2.status < 500, { rel: rel.status, rel2: rel2.status });
  const after = await q1(`SELECT status FROM payment.shop_payouts WHERE id = $1`, [po?.id]);
  check('HLD-08', 'mở lệnh giữ ⇒ kỳ `held` của shop TỰ đi tiếp (không còn `held`, không cần bấm mở giữ lần nữa)', after?.status !== 'held', { status: after?.status });
}

group('BAL — số dư PayOS khi chi');
{
  const shop = await L.shopBySlug('mobilehub');
  const owner = 'owner:mobilehub';
  await L.setSetting('payout.auto_max_amount', 100000000);
  await L.setSetting('payout.min_amount', 1000);
  await q(`UPDATE "order".orders SET delivered_at = now(), completed_at = now() WHERE shop_id = $1 AND code LIKE 'DHSEED%'`, [shop.id]);
  await q(`UPDATE payment.shop_payouts SET status = 'paid' WHERE shop_id = $1 AND status IN ('pending','processing','failed','held')`, [shop.id]);
  const vs = (await L.pickVariant({ shopId: shop.id, qty: 4, maxPrice: 900000 }))[0];
  const p = await L.placeOrder({ as: nextUser(), items: [{ variantId: vs.id, qty: 1 }], method: 'payos' });
  const kid = L.childOrders(p)[0];
  await L.sendWebhook(await L.payosCodeOf(kid.code), num(kid.total), { payer: PAYER });
  for (const s of ['confirmed', 'packing', 'shipping', 'delivered']) await api('PUT', `/shop/orders/${kid.code}/status`, { as: owner, body: { status: s, ...(s === 'shipping' ? { trackingUrl: 'https://track.example.com/X2' } : {}) } });
  await q(`UPDATE "order".orders SET status='completed', delivered_at = now() - interval '8 days', completed_at = now() - interval '1 day' WHERE code = $1`, [kid.code]);
  await L.mockBalance(1); // PayOS giả gần hết tiền
  const start = (await q1(`SELECT max(period_end) AS e FROM payment.shop_payouts`))?.e ?? new Date('2020-01-01');
  const run = await api('POST', '/admin/payouts/run', { as: 'accountant', body: { periodStart: new Date(start).toISOString(), periodEnd: new Date().toISOString(), shopId: shop.id } });
  const po = run.data?.[0];
  const sentWhileEmpty = (await L.mockState()).payouts.filter((x) => (x.referenceId ?? '').startsWith(po?.code ?? '#')).length;
  const row = await q1(`SELECT status, gateway_status, fail_reason FROM payment.shop_payouts WHERE id = $1`, [po?.id]);
  note('BAL-01', 'số dư PayOS không đủ lúc chạy kỳ', `status=${row?.status} gateway=${row?.gateway_status} lệnh gửi PayOS=${sentWhileEmpty} reason=${(row?.fail_reason ?? '').slice(0, 90)}`);
  check('BAL-02', 'thiếu số dư ⇒ KHÔNG treo ở `processing`; kỳ ở trạng thái xử lý được (failed/pending) kèm lý do', ['failed', 'pending'].includes(row?.status) && !!row?.fail_reason, { row });
  await L.mockBalance(5_000_000_000);
  const retry = await api('POST', `/admin/payouts/${po?.id}/retry`, { as: 'accountant' });
  const row2 = await q1(`SELECT status FROM payment.shop_payouts WHERE id = $1`, [po?.id]);
  check('BAL-03', 'nạp quỹ rồi chạy lại ⇒ kỳ đi tiếp (processing/paid)', retry.status < 300 && ['processing', 'paid', 'awaiting_approval'].includes(row2?.status), { st: retry.status, code: retry.code, status: row2?.status });
}

group('MRG — kỳ `merged` không được chi lần nữa');
{
  const m = await q1(`SELECT id, code, status FROM payment.shop_payouts WHERE status = 'merged' LIMIT 1`);
  if (!m) note('MRG-00', 'không có kỳ merged trong DB (t05b chưa tạo) — bỏ qua', '');
  else {
    const attempts = {
      retry: (await api('POST', `/admin/payouts/${m.id}/retry`, { as: 'accountant' })).status,
      markPaid: (await api('POST', `/admin/payouts/${m.id}/mark-paid`, { as: 'accountant', body: { providerRef: `MRG-${Date.now()}`, note: 'thử' } })).status,
      approve: (await api('POST', `/admin/payouts/${m.id}/approve`, { as: 'accountant' })).status,
      release: (await api('POST', `/admin/payouts/${m.id}/release`, { as: 'accountant' })).status,
    };
    const still = await q1(`SELECT status FROM payment.shop_payouts WHERE id = $1`, [m.id]);
    check('MRG-01', 'kỳ `merged` (đã cộng vào kỳ sau): retry/mark-paid/approve/release đều bị từ chối 4xx và trạng thái giữ nguyên — nếu không sẽ chi hai lần', Object.values(attempts).every((s) => s >= 400 && s < 500) && still.status === 'merged', { attempts, still: still.status });
  }
}

group('API — tên shop ở kỳ chi/hoàn (kế toán không có shop.read)');
{
  const pl = await api('GET', '/admin/payouts?page=1&size=5', { as: 'accountant' });
  const rl = await api('GET', '/admin/refunds?page=1&size=50', { as: 'accountant' });
  const p0 = pl.data?.content?.[0];
  const r0 = (rl.data?.content ?? []).find((x) => x.shopId);
  check('API-01', 'kỳ chi trả kèm shopName + shopCode', !!p0?.shopName && !!p0?.shopCode, { keys: Object.keys(p0 ?? {}) });
  check('API-02', 'hoàn tiền (có shop) kèm shopName + shopCode', !!r0?.shopName && !!r0?.shopCode, { keys: Object.keys(r0 ?? {}) });
  const vendorPo = await api('GET', '/shop/payouts?page=1&size=3', { as: 'owner:techzone' });
  const leak = JSON.stringify(vendorPo.data ?? {});
  note('API-03', 'vendor GET /shop/payouts có chứa trường nội bộ không', `status=${vendorPo.status}; bankSnapshot=${/bankSnapshot/.test(leak)} holdReason=${/holdReason/.test(leak)} failReason=${/failReason/.test(leak)}`);
}

group('HLD — job chi tự động tôn trọng lệnh giữ tay');
{
  const shop = await L.shopBySlug('sneaker');
  const owner = 'owner:sneaker';
  const h = await api('POST', '/admin/payouts/holds', { as: 'accountant', body: { shopId: shop.id, reason: 'Kiểm thử job tự động' } });
  const vs = (await L.pickVariant({ shopId: shop.id, qty: 4, maxPrice: 900000 }))[0];
  const p = await L.placeOrder({ as: nextUser(), items: [{ variantId: vs.id, qty: 1 }], method: 'payos' });
  const kid = L.childOrders(p)[0];
  await L.sendWebhook(await L.payosCodeOf(kid.code), num(kid.total), { payer: PAYER });
  for (const s of ['confirmed', 'packing', 'shipping', 'delivered']) await api('PUT', `/shop/orders/${kid.code}/status`, { as: owner, body: { status: s, ...(s === 'shipping' ? { trackingUrl: 'https://track.example.com/X3' } : {}) } });
  await q(`UPDATE "order".orders SET status='completed', delivered_at = now() - interval '9 days', completed_at = now() - interval '2 days' WHERE code = $1`, [kid.code]);
  // runOnce(now) chốt kỳ tới 00:00 (giờ VN) hôm nay và nối sau kỳ gần nhất: các kỳ do bài này/bài trước tạo kết thúc 'bây giờ' nên lùi chúng 3 ngày để job có khoảng trống thật
  await q(`UPDATE payment.shop_payouts SET period_start = period_start - interval '3 days', period_end = period_end - interval '3 days'`);
  const j = L.runJob('payout-auto');
  const row = await q1(`SELECT l.order_code, s.status FROM payment.shop_payout_lines l JOIN payment.shop_payouts s ON s.id = l.payout_id WHERE l.order_code = $1 AND l.kind = 'sale'`, [kid.code]);
  note('HLD-09a', 'job payout-auto cho shop đang bị giữ tay', JSON.stringify({ job: j, row, hold: h.status }));
  check('HLD-09', 'job chi tự động chạy cho shop đang bị giữ tay ⇒ đơn nằm trong kỳ `held` (có kỳ thật, không phải chạy rỗng), không gửi PayOS', row?.status === 'held', { job: j, row, hold: h.status });
  if (h.data?.id) await api('POST', `/admin/payouts/holds/${h.data.id}/release`, { as: 'accountant' });
}

/* ===================================================================== TRẢ HAI LẦN CHO MỘT LINK (phát hiện khi làm PLAN-0041) */
group('INS — khách chuyển HAI lần cho một link; poll/return thấy luỹ kế đủ TRƯỚC khi hai webhook về');
{
  const mfPost = (pth, body) => fetch(`http://127.0.0.1:4020${pth}`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) }).then((r) => r.json());
  const o = await mk();
  const a1 = Math.round(o.total * 0.6);
  const a2 = o.total - a1;
  await mfPost('/_receive', { orderCode: o.payos, amount: a1, reference: 'INSREF1', webhook: 'skip' }); // PayOS nhận 2 khoản, KHÔNG gửi webhook
  await mfPost('/_receive', { orderCode: o.payos, amount: a2, reference: 'INSREF2', webhook: 'skip' });
  await q(`UPDATE payment.payments SET created_at = now() - interval '20 minutes', last_checked_at = NULL WHERE order_code = $1`, [o.code]);
  L.runJob('payos-poll'); // poll thấy luỹ kế = đủ đơn ⇒ paid
  const afterPoll = (await pay(o.code))[0];
  const w1 = await L.sendWebhook(o.payos, a1, { reference: 'INSREF1', payer: PAYER });
  const w2 = await L.sendWebhook(o.payos, a2, { reference: 'INSREF2', payer: PAYER });
  const p = (await pay(o.code))[0];
  const rfs = await L.refundRows(o.code);
  check('INS-01', 'poll ghi paid theo luỹ kế đủ; hai webhook về sau là phần CỦA ĐƠN ⇒ KHÔNG hoàn trùng, received = đúng giá trị đơn', afterPoll?.status === 'paid' && w1.status === 200 && w2.status === 200 && rfs.length === 0 && num({ amount: p.received_amount }) === o.total, { afterPoll: afterPoll?.status, w1: w1.status, w2: w2.status, received: p.received_amount, total: o.total, refunds: rfs.map((r) => ({ kind: r.kind, amount: r.amount })) });
  const w3 = await L.sendWebhook(o.payos, a2, { reference: 'INSREF3', payer: PAYER }); // một khoản chuyển THẬT SỰ thêm
  const rfs2 = await L.refundRows(o.code);
  check('INS-02', 'khoản chuyển thứ ba (thật sự dư) ⇒ hoàn trùng đúng phần dư, đúng MỘT lần', w3.status === 200 && rfs2.length === 1 && rfs2[0].kind === 'duplicate_payment' && Number(rfs2[0].amount) === a2, { st: w3.status, refunds: rfs2.map((r) => ({ kind: r.kind, amount: r.amount })), a2 });
  await L.sendWebhook(o.payos, a2, { reference: 'INSREF3', payer: PAYER }); // PayOS gửi lại đúng khoản ấy
  check('INS-03', 'PayOS gửi lại khoản thứ ba ⇒ không hoàn thêm', (await L.refundRows(o.code)).length === 1, { n: (await L.refundRows(o.code)).length });
}

L.saveResults(process.env.OUT ?? 'out-t09.json');
const R = L.results;
console.log(`\nTỔNG nhóm 09: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', ') || '(không)');
process.exit(0);
