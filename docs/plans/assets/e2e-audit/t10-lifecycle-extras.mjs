/*
 * Nhóm 10: vòng đời đơn bổ sung của PLAN-0040 Tầng 3/4/5 — kiểm trên POSTGRES THẬT (jest dùng DB giả nên không bắt được lỗi SQL/ràng buộc):
 * yêu cầu huỷ của khách · hạn chót SLA (nhắc, tự huỷ, rebase) · gia hạn giao · điểm vi phạm + cảnh báo khoá shop · đổi địa chỉ · "Đã nhận hàng" ·
 * tóm tắt đơn mở khi khoá shop · xác minh TK ngân hàng (tên chủ TK lệch) · health.
 * Bài tự dọn: trả `order.sla_enabled` về giá trị cũ và TK ngân hàng của shop về như cũ.
 */
import * as L from './lib.mjs';
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.stack ?? e); process.exit(3); });
const { check, group, api, q, q1, note } = L;
const shops = {};
for (const s of ['techzone', 'ngonviet']) shops[s] = await L.shopBySlug(s);
await L.mockReset(); await L.mockBalance(5_000_000_000);
const shopStatus = (slug, code, status, extra = {}) => api('PUT', `/shop/orders/${code}/status`, { as: `owner:${slug}`, body: { status, ...extra } });
const num = (x) => Number(L.money(x));

async function newOrder({ as, slug = 'techzone', method = 'cod', qty = 1 } = {}) {
  const v = (await L.pickVariant({ shopId: shops[slug].id, qty: qty + 2, maxPrice: 900000 }))[0];
  const placed = await L.placeOrder({ as, items: [{ variantId: v.id, qty }], method });
  if (placed.status !== 201) throw new Error(`đặt hàng lỗi ${placed.status} ${placed.code}`);
  const kid = L.childOrders(placed)[0];
  return { kid, code: kid.code, v, as, slug, total: num(kid.total) };
}
const toStatus = async (o, target) => {
  const chain = ['confirmed', 'packing', 'shipping', 'delivered'];
  for (const s of chain) { await shopStatus(o.slug, o.code, s); if (s === target) break; }
};
const row = (code) => q1(`SELECT status, cancel_source, cancel_reason_code, cancel_request_status, cancel_request_due_at, confirm_due_at, ship_due_at, ship_extended_at, completed_by, shipping_address FROM "order".orders WHERE code = $1`, [code]);
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const r = await fn(); if (r) return r; await L.sleep(1000); } return null; };
const slaBefore = await L.getSetting('order.sla_enabled');
const t0 = new Date();

// ------------------------------------------------------------------ CRQ
group('CRQ — khách yêu cầu huỷ đơn đang đóng gói');
{
  const o = await newOrder({ as: 'khach41' });
  await toStatus(o, 'confirmed');
  const early = await api('POST', `/orders/${o.code}/cancel-request`, { as: 'khach41', body: { reasonCode: 'changed_mind' } });
  check('CRQ-01a', 'đơn confirmed: yêu cầu huỷ ⇒ 409 ORDER_CANNOT_CANCEL kèm hint cancel_direct', early.status === 409 && early.code === 'ORDER_CANNOT_CANCEL' && early.error?.details?.hint === 'cancel_direct', { st: early.status, code: early.code, d: early.error?.details });
  await shopStatus(o.slug, o.code, 'packing');
  const direct = await api('POST', `/orders/${o.code}/cancel`, { as: 'khach41', body: { reasonCode: 'changed_mind' } });
  check('CRQ-01b', 'đơn packing: huỷ trực tiếp ⇒ 409 ORDER_CANNOT_CANCEL kèm hint cancel_request', direct.status === 409 && direct.error?.details?.hint === 'cancel_request', { st: direct.status, code: direct.code, d: direct.error?.details });
  const noReason = await api('POST', `/orders/${o.code}/cancel-request`, { as: 'khach41', body: {} });
  check('CRQ-01c', 'yêu cầu huỷ thiếu reasonCode ⇒ 400', noReason.status === 400, { st: noReason.status });
  const other = await api('POST', `/orders/${o.code}/cancel-request`, { as: 'khach42', body: { reasonCode: 'changed_mind' } });
  check('CRQ-01d', 'khách khác gửi yêu cầu huỷ đơn không phải của mình ⇒ 404 (không lộ đơn)', other.status === 404, { st: other.status });
  const ok = await api('POST', `/orders/${o.code}/cancel-request`, { as: 'khach41', body: { reasonCode: 'changed_mind', note: 'Không cần nữa' } });
  const r1 = await row(o.code);
  check('CRQ-02a', 'gửi yêu cầu huỷ đơn packing ⇒ 2xx, cancel_request_status=pending, có hạn xử lý', ok.status < 300 && r1?.cancel_request_status === 'pending' && !!r1?.cancel_request_due_at, { st: ok.status, code: ok.code, r1 });
  const dup = await api('POST', `/orders/${o.code}/cancel-request`, { as: 'khach41', body: { reasonCode: 'changed_mind' } });
  check('CRQ-02b', 'gửi lần hai ⇒ 409 ORDER_CANCEL_REQUEST_EXISTS', dup.status === 409 && dup.code === 'ORDER_CANCEL_REQUEST_EXISTS', { st: dup.status, code: dup.code });
  const view = await api('GET', `/orders/${o.code}`, { as: 'khach41' });
  check('CRQ-02c', 'khách xem đơn thấy cancelRequest.status=pending và canRequestCancel=false', view.data?.cancelRequest?.status === 'pending' && view.data?.canRequestCancel === false, { cr: view.data?.cancelRequest, can: view.data?.canRequestCancel });
  const shopView = await api('GET', `/shop/orders/${o.code}`, { as: `owner:${o.slug}` });
  check('CRQ-02d', 'shop xem đơn thấy yêu cầu huỷ đang chờ', shopView.data?.cancelRequest?.status === 'pending', { cr: shopView.data?.cancelRequest });
  const shortRej = await api('POST', `/shop/orders/${o.code}/cancel-request/reject`, { as: `owner:${o.slug}`, body: { reason: 'ngắn' } });
  check('CRQ-03a', 'từ chối yêu cầu huỷ với lý do < 10 ký tự ⇒ 400', shortRej.status === 400, { st: shortRej.status });
  const rej = await api('POST', `/shop/orders/${o.code}/cancel-request/reject`, { as: `owner:${o.slug}`, body: { reason: 'Hàng đã đóng gói xong, sắp giao cho vận chuyển' } });
  const r2 = await row(o.code);
  check('CRQ-03b', 'shop từ chối ⇒ đơn vẫn packing, yêu cầu rejected kèm lý do', rej.status < 300 && r2?.status === 'packing' && r2?.cancel_request_status === 'rejected', { st: rej.status, code: rej.code, r2 });
  const again = await api('POST', `/shop/orders/${o.code}/cancel-request/accept`, { as: `owner:${o.slug}` });
  check('CRQ-03c', 'chấp nhận khi không còn yêu cầu đang chờ ⇒ 409 ORDER_CANCEL_REQUEST_NOT_FOUND', again.status === 409 && again.code === 'ORDER_CANCEL_REQUEST_NOT_FOUND', { st: again.status, code: again.code });
  const view2 = await api('GET', `/orders/${o.code}`, { as: 'khach41' });
  check('CRQ-03d', 'khách đọc được lý do bị từ chối', !!view2.data?.cancelRequest?.rejectReason, { cr: view2.data?.cancelRequest });
}
{
  // chấp nhận ⇒ huỷ + nhập kho + không điểm vi phạm
  const o = await newOrder({ as: 'khach42' });
  const stock0 = await L.stock(o.v.id);
  await toStatus(o, 'packing');
  await api('POST', `/orders/${o.code}/cancel-request`, { as: 'khach42', body: { reasonCode: 'found_cheaper' } });
  const acc = await api('POST', `/shop/orders/${o.code}/cancel-request/accept`, { as: `owner:${o.slug}` });
  const r = await row(o.code);
  const stock1 = await L.stock(o.v.id);
  const viol = await q1(`SELECT count(*)::int AS n FROM "order".shop_violations WHERE order_code = $1`, [o.code]);
  check('CRQ-04a', 'shop chấp nhận ⇒ đơn cancelled (nguồn customer), giữ chỗ tồn kho được nhả (reserved -1)', acc.status < 300 && r?.status === 'cancelled' && stock1.stock === stock0.stock && stock1.reserved === stock0.reserved - 1, { st: acc.status, code: acc.code, r, stock0, stock1 });
  await L.sleep(4000);
  const viol2 = await q1(`SELECT count(*)::int AS n FROM "order".shop_violations WHERE order_code = $1`, [o.code]);
  check('CRQ-04b', 'chấp nhận yêu cầu huỷ KHÔNG bị tính điểm vi phạm', viol.n === 0 && viol2.n === 0, { viol, viol2 });
}

// ------------------------------------------------------------------ SLA
group('SLA — hạn xác nhận/giao, nhắc, tự huỷ, rebase (order.sla_enabled)');
{
  await L.setSetting('order.sla_enabled', false);
  const o = await newOrder({ as: 'khach43' });
  const r0 = await row(o.code);
  check('SLA-01a', 'đơn mới luôn có hạn xác nhận (confirm_due_at) kể cả khi SLA tắt', !!r0?.confirm_due_at, { r0 });
  await q(`UPDATE "order".orders SET confirm_due_at = now() - interval '2 hours' WHERE code = $1`, [o.code]);
  const j0 = L.runJob('order-sla');
  const r1 = await row(o.code);
  check('SLA-01b', 'SLA TẮT: job không động tới đơn trễ hạn', r1?.status === 'pending' && j0.ok !== false, { r1, j0 });

  await L.setSetting('order.sla_enabled', true);
  await q(`DELETE FROM "order".job_state WHERE key LIKE '%sla%'`);
  const j1 = L.runJob('order-sla');
  const r2 = await row(o.code);
  check('SLA-02a', 'lần chạy đầu sau khi bật ⇒ REBASE hạn đã trễ (không huỷ hàng loạt)', r2?.status === 'pending' && new Date(r2.confirm_due_at) > new Date(), { r2, j1 });

  await q(`UPDATE "order".orders SET confirm_due_at = now() - interval '10 minutes' WHERE code = $1`, [o.code]);
  const j2 = L.runJob('order-sla');
  const r3 = await waitFor(async () => { const r = await row(o.code); return r?.status === 'cancelled' ? r : null; }, 15000);
  check('SLA-02b', 'quá hạn xác nhận ⇒ tự huỷ (system / shop_confirm_timeout)', r3?.status === 'cancelled' && r3?.cancel_source === 'system' && r3?.cancel_reason_code === 'shop_confirm_timeout', { r3, j2 });
  const v1 = await waitFor(async () => q1(`SELECT kind, points FROM "order".shop_violations WHERE order_code = $1`, [o.code]), 15000);
  check('SLA-02c', 'tự huỷ do shop không xác nhận ⇒ ghi 1 điểm vi phạm confirm_timeout', v1?.kind === 'confirm_timeout' && v1?.points === 1, { v1 });
  L.runJob('order-sla');
  await L.sleep(3000);
  const vN = await q1(`SELECT count(*)::int AS n FROM "order".shop_violations WHERE order_code = $1`, [o.code]);
  check('SLA-02d', 'chạy job lần nữa KHÔNG cộng điểm hai lần (UNIQUE order_code+kind)', vN.n === 1, { vN });

  // nhắc 1 lần: hạn xác nhận còn 5 giờ
  const o2 = await newOrder({ as: 'khach43' });
  await q(`UPDATE "order".orders SET confirm_due_at = now() + interval '5 hours' WHERE code = $1`, [o2.code]);
  L.runJob('order-sla'); L.runJob('order-sla');
  await L.sleep(2000);
  const rem = await q(`SELECT n.title FROM system.notifications n JOIN identity.users u ON u.id = n.user_id WHERE u.email = 'techzone@ecofashion.vn' AND n.created_at >= $1 AND n.title ILIKE '%' || $2 || '%'`, [t0, o2.code]);
  const remRow = await q1(`SELECT confirm_reminded_at FROM "order".orders WHERE code = $1`, [o2.code]);
  check('SLA-03a', 'còn ≤ 6h tới hạn xác nhận ⇒ nhắc chủ shop ĐÚNG 1 lần dù job chạy 2 lần', !!remRow?.confirm_reminded_at && rem.filter((x) => /hạn|nhắc|sắp/i.test(x.title)).length === 1, { remRow, titles: rem.map((x) => x.title) });
  await api('POST', `/shop/orders/${o2.code}/cancel`, { as: `owner:${o2.slug}`, body: { reasonCode: 'other', note: 'dọn đơn thử SLA' } });

  // quá hạn giao ⇒ tự huỷ + nhập kho
  const o3 = await newOrder({ as: 'khach43' });
  const stockA = await L.stock(o3.v.id);
  await toStatus(o3, 'confirmed');
  const sd = await row(o3.code);
  check('SLA-04a', 'xác nhận đơn ⇒ có hạn giao (ship_due_at)', !!sd?.ship_due_at, { sd });
  await q(`UPDATE "order".orders SET ship_due_at = now() - interval '10 minutes' WHERE code = $1`, [o3.code]);
  L.runJob('order-sla');
  const r4 = await waitFor(async () => { const r = await row(o3.code); return r?.status === 'cancelled' ? r : null; }, 15000);
  const stockB = await L.stock(o3.v.id);
  check('SLA-04b', 'quá hạn giao ⇒ tự huỷ (shop_ship_timeout), nhả giữ chỗ tồn kho', r4?.cancel_reason_code === 'shop_ship_timeout' && stockB.stock === stockA.stock && stockB.reserved === stockA.reserved - 1, { r4, stockA, stockB });

  // yêu cầu huỷ im lặng quá hạn ⇒ tự chấp nhận
  const o4 = await newOrder({ as: 'khach44' });
  await toStatus(o4, 'packing');
  await api('POST', `/orders/${o4.code}/cancel-request`, { as: 'khach44', body: { reasonCode: 'changed_mind' } });
  await q(`UPDATE "order".orders SET cancel_request_due_at = now() - interval '5 minutes' WHERE code = $1`, [o4.code]);
  L.runJob('order-sla');
  const r5 = await waitFor(async () => { const r = await row(o4.code); return r?.status === 'cancelled' ? r : null; }, 15000);
  check('SLA-05', 'shop im lặng quá hạn xử lý yêu cầu huỷ ⇒ tự chấp nhận (auto_accepted) và huỷ đơn', r5?.status === 'cancelled' && r5?.cancel_request_status === 'auto_accepted', { r5 });
}

// ------------------------------------------------------------------ EXT
group('EXT — gia hạn giao hàng một lần');
{
  const o = await newOrder({ as: 'khach44' });
  await toStatus(o, 'confirmed');
  const before = await row(o.code);
  const shortR = await api('POST', `/shop/orders/${o.code}/extend-ship`, { as: `owner:${o.slug}`, body: { reason: 'ngắn' } });
  check('EXT-01a', 'lý do gia hạn < 10 ký tự ⇒ 400', shortR.status === 400, { st: shortR.status });
  const ok = await api('POST', `/shop/orders/${o.code}/extend-ship`, { as: `owner:${o.slug}`, body: { reason: 'Hàng đang chờ bổ sung từ kho tổng' } });
  const after = await row(o.code);
  const dueDiffH = (new Date(after.ship_due_at) - new Date(before.ship_due_at)) / 3600000;
  check('EXT-01b', 'gia hạn lần 1 ⇒ ship_due_at tăng đúng order.shop_ship_hours (48h)', ok.status < 300 && Math.abs(dueDiffH - 48) < 0.1 && !!after.ship_extended_at, { st: ok.status, code: ok.code, dueDiffH });
  const twice = await api('POST', `/shop/orders/${o.code}/extend-ship`, { as: `owner:${o.slug}`, body: { reason: 'Xin gia hạn thêm lần nữa nhé' } });
  check('EXT-01c', 'gia hạn lần 2 ⇒ 409 ORDER_SHIP_ALREADY_EXTENDED', twice.status === 409 && twice.code === 'ORDER_SHIP_ALREADY_EXTENDED', { st: twice.status, code: twice.code });
  const o2 = await newOrder({ as: 'khach44' });
  await toStatus(o2, 'confirmed');
  await q(`UPDATE "order".orders SET ship_due_at = now() - interval '1 hour' WHERE code = $1`, [o2.code]);
  const late = await api('POST', `/shop/orders/${o2.code}/extend-ship`, { as: `owner:${o2.slug}`, body: { reason: 'Xin gia hạn dù đã trễ hạn giao' } });
  check('EXT-01d', 'đã quá hạn giao ⇒ 409 ORDER_SHIP_OVERDUE', late.status === 409 && late.code === 'ORDER_SHIP_OVERDUE', { st: late.status, code: late.code });
  const o3 = await newOrder({ as: 'khach44' });
  await toStatus(o3, 'confirmed');
  await q(`UPDATE "order".orders SET ship_due_at = NULL WHERE code = $1`, [o3.code]);
  const nodl = await api('POST', `/shop/orders/${o3.code}/extend-ship`, { as: `owner:${o3.slug}`, body: { reason: 'Đơn cũ không có hạn giao nào' } });
  check('EXT-01e', 'đơn cũ không có hạn ⇒ 409 ORDER_SHIP_NO_DEADLINE', nodl.status === 409 && nodl.code === 'ORDER_SHIP_NO_DEADLINE', { st: nodl.status, code: nodl.code });
  for (const x of [o, o2, o3]) await api('POST', `/shop/orders/${x.code}/cancel`, { as: `owner:${x.slug}`, body: { reasonCode: 'customer_request', note: 'dọn đơn thử' } });
}

// ------------------------------------------------------------------ VIO
group('VIO — điểm vi phạm của shop + cảnh báo khoá');
{
  const slug = 'ngonviet';
  const shop = shops[slug];
  await q(`DELETE FROM "order".shop_violations WHERE shop_id = $1`, [shop.id]);
  await q(`DELETE FROM "order".shop_violation_alerts WHERE shop_id = $1`, [shop.id]);
  const o = await newOrder({ as: 'khach45', slug });
  const cancel = await api('POST', `/shop/orders/${o.code}/cancel`, { as: `owner:${slug}`, body: { reasonCode: 'out_of_stock', note: 'Hết hàng thật' } });
  const v = await waitFor(async () => q1(`SELECT kind, points FROM "order".shop_violations WHERE order_code = $1`, [o.code]), 15000);
  check('VIO-01a', 'shop huỷ vì hết hàng ⇒ +1 điểm (cancel_out_of_stock)', cancel.status < 300 && v?.kind === 'cancel_out_of_stock' && v?.points === 1, { st: cancel.status, code: cancel.code, v });
  const sum = await api('GET', '/shop/violations/summary', { as: `owner:${slug}` });
  check('VIO-01b', 'GET /shop/violations/summary của chủ shop ⇒ points ≥ 1, windowDays 30', sum.status === 200 && sum.data?.points >= 1 && sum.data?.windowDays === 30, { st: sum.status, d: sum.data });
  const list = await api('GET', '/shop/violations?page=1&size=10', { as: `owner:${slug}` });
  check('VIO-01c', 'danh sách điểm vi phạm của shop có dòng vừa ghi', list.status === 200 && JSON.stringify(list.data).includes(o.code), { st: list.status });
  const adm = await api('GET', `/admin/shops/${shop.id}/violations/summary`, { as: 'manager' });
  check('VIO-01d', 'quản lý sàn xem được tóm tắt vi phạm của shop', adm.status === 200 && adm.data?.points >= 1, { st: adm.status, d: adm.data });
  const acc = await api('GET', `/admin/shops/${shop.id}/violations/summary`, { as: 'marketing' });
  check('VIO-01e', 'vai không có supplier.shop.read (marketing) ⇒ 403', acc.status === 403, { st: acc.status });

  // vượt ngưỡng 10 điểm trong 30 ngày ⇒ báo quản lý, tối đa 1 lần / 7 ngày
  const tAlert = new Date();
  for (let i = 0; i < 9; i++) await q(`INSERT INTO "order".shop_violations (shop_id, order_code, kind, points) VALUES ($1, $2, 'ship_timeout', 1)`, [shop.id, `AUDIT-VIO-${Date.now()}-${i}`]);
  const o2 = await newOrder({ as: 'khach45', slug });
  await api('POST', `/shop/orders/${o2.code}/cancel`, { as: `owner:${slug}`, body: { reasonCode: 'price_error', note: 'Sai giá' } });
  const alert1 = await waitFor(async () => { const r = await q(`SELECT n.title FROM system.notifications n JOIN identity.users u ON u.id = n.user_id WHERE u.email = 'manager@ecofashion.vn' AND n.created_at >= $1 AND n.title ILIKE '%vi phạm%'`, [tAlert]); return r.length ? r : null; }, 20000);
  check('VIO-02a', 'tổng ≥ 10 điểm/30 ngày ⇒ quản lý được báo xem xét khoá shop', !!alert1, { n: alert1?.length });
  const o3 = await newOrder({ as: 'khach45', slug });
  await api('POST', `/shop/orders/${o3.code}/cancel`, { as: `owner:${slug}`, body: { reasonCode: 'out_of_stock', note: 'Hết hàng' } });
  await waitFor(async () => q1(`SELECT 1 FROM "order".shop_violations WHERE order_code = $1`, [o3.code]), 15000);
  await L.sleep(3000);
  const alertN = await q(`SELECT n.title FROM system.notifications n JOIN identity.users u ON u.id = n.user_id WHERE u.email = 'manager@ecofashion.vn' AND n.created_at >= $1 AND n.title ILIKE '%vi phạm%'`, [tAlert]);
  check('VIO-02b', 'thêm điểm trong 7 ngày KHÔNG báo lại (shop_violation_alerts)', alertN.length === 1, { n: alertN.length });
  await q(`DELETE FROM "order".shop_violations WHERE shop_id = $1`, [shop.id]);
  await q(`DELETE FROM "order".shop_violation_alerts WHERE shop_id = $1`, [shop.id]);
}

// ------------------------------------------------------------------ ADR + RCV
group('ADR/RCV — đổi địa chỉ, "Đã nhận hàng"');
{
  const o = await newOrder({ as: 'khach41' });
  const NEWADDR = { recipientName: 'Người Nhận Mới', recipientPhone: '0909555666', addressLine: '99 Lê Lợi', ward: 'Phường Bến Thành', district: 'Quận 1', province: 'TP. Hồ Chí Minh' };
  const ok = await api('PUT', `/orders/${o.code}/address`, { as: 'khach41', body: NEWADDR });
  check('ADR-01a', 'đổi địa chỉ đơn pending ⇒ 200', ok.status === 200, { st: ok.status, code: ok.code, msg: ok.message });
  const after = await row(o.code);
  check('ADR-01b', 'địa chỉ trong đơn đã đổi', JSON.stringify(after?.shipping_address ?? {}).includes('Người Nhận Mới') || JSON.stringify(after?.shipping_address ?? {}).includes('99 Lê Lợi'), { addr: after?.shipping_address });
  const diffProv = await api('PUT', `/orders/${o.code}/address`, { as: 'khach41', body: { ...NEWADDR, province: 'Hà Nội' } });
  check('ADR-01c', 'đổi sang tỉnh/thành khác ⇒ 409 ORDER_ADDRESS_PROVINCE_CHANGED', diffProv.status === 409 && diffProv.code === 'ORDER_ADDRESS_PROVINCE_CHANGED', { st: diffProv.status, code: diffProv.code });
  const stranger = await api('PUT', `/orders/${o.code}/address`, { as: 'khach42', body: NEWADDR });
  check('ADR-01d', 'khách khác đổi địa chỉ đơn không phải của mình ⇒ 404', stranger.status === 404, { st: stranger.status });
  await toStatus(o, 'packing');
  const lock = await api('PUT', `/orders/${o.code}/address`, { as: 'khach41', body: NEWADDR });
  check('ADR-01e', 'đơn packing ⇒ 409 ORDER_ADDRESS_LOCKED', lock.status === 409 && lock.code === 'ORDER_ADDRESS_LOCKED', { st: lock.status, code: lock.code });

  const notYet = await api('POST', `/orders/${o.code}/received`, { as: 'khach41' });
  check('RCV-01a', 'chưa giao mà bấm "Đã nhận hàng" ⇒ 409 ORDER_NOT_DELIVERED', notYet.status === 409 && notYet.code === 'ORDER_NOT_DELIVERED', { st: notYet.status, code: notYet.code });
  await shopStatus(o.slug, o.code, 'shipping'); await shopStatus(o.slug, o.code, 'delivered');
  const view = await api('GET', `/orders/${o.code}`, { as: 'khach41' });
  check('RCV-01b', 'đơn delivered ⇒ canMarkReceived = true', view.data?.canMarkReceived === true, { can: view.data?.canMarkReceived });
  const rcv = await api('POST', `/orders/${o.code}/received`, { as: 'khach41' });
  const r = await row(o.code);
  check('RCV-01c', '"Đã nhận hàng" ⇒ completed (completed_by=customer)', rcv.status === 200 && r?.status === 'completed' && r?.completed_by === 'customer', { st: rcv.status, code: rcv.code, r });
  const rcv2 = await api('POST', `/orders/${o.code}/received`, { as: 'khach41' });
  check('RCV-01d', 'bấm lại ⇒ 200 (idempotent)', rcv2.status === 200, { st: rcv2.status, code: rcv2.code });
}

// ------------------------------------------------------------------ SUS
group('SUS — tóm tắt đơn mở trước khi khoá shop');
{
  const o = await newOrder({ as: 'khach42', slug: 'ngonviet' });
  const s = await api('GET', `/admin/shops/${shops.ngonviet.id}/open-orders-summary`, { as: 'manager' });
  check('SUS-01a', 'GET open-orders-summary ⇒ {pending, confirmed, packing, shipping} là số', s.status === 200 && ['pending', 'confirmed', 'packing', 'shipping'].every((k) => Number.isInteger(s.data?.[k])) && s.data.pending >= 1, { st: s.status, d: s.data });
  const deny = await api('GET', `/admin/shops/${shops.ngonviet.id}/open-orders-summary`, { as: 'accountant' });
  check('SUS-01b', 'kế toán (không có supplier.shop.read) ⇒ 403', deny.status === 403, { st: deny.status });
  await api('POST', `/orders/${o.code}/cancel`, { as: 'khach42', body: { reasonCode: 'changed_mind' } });
}

// ------------------------------------------------------------------ BNK
group('BNK — tên chủ TK lệch tên chủ shop ⇒ chờ quản lý xác minh');
{
  const shop = shops.techzone;
  const owner = 'owner:techzone';
  const before = await q1(`SELECT bank_account_number, bank_code, bank_account_name, bank_status, bank_verified_at FROM shop.shops WHERE id = $1`, [shop.id]);
  const bad = await api('PATCH', '/shop/me', { as: owner, body: { bankCode: '970422', bankAccountNumber: '1122334455', bankAccountName: 'NGUYEN VAN KHONG KHOP', currentPassword: process.env.E2E_PW_VENDOR } });
  const mid = await q1(`SELECT bank_status, bank_account_number FROM shop.shops WHERE id = $1`, [shop.id]);
  check('BNK-01a', 'đổi TK với tên chủ TK lệch tên chủ shop ⇒ 200 và bank_status=pending_verification', bad.status === 200 && mid?.bank_status === 'pending_verification', { st: bad.status, code: bad.code, mid });
  const me = await api('GET', '/shop/me', { as: owner });
  check('BNK-01b', 'GET /shop/me trả bankStatus + bankChangeHoldHours (số giờ giữ thật)', me.data?.bankStatus === 'pending_verification' && Number.isInteger(me.data?.bankChangeHoldHours), { bs: me.data?.bankStatus, h: me.data?.bankChangeHoldHours });
  const wrongNum = await api('POST', `/admin/shops/${shop.id}/bank/verify`, { as: 'manager', body: { bankAccountNumber: '0000000000' } });
  check('BNK-02a', 'xác minh kèm SỐ TK không khớp TK hiện tại ⇒ 409 SHOP_BANK_CHANGED_SINCE', wrongNum.status === 409 && wrongNum.code === 'SHOP_BANK_CHANGED_SINCE', { st: wrongNum.status, code: wrongNum.code });
  const noPerm = await api('POST', `/admin/shops/${shop.id}/bank/verify`, { as: 'sales', body: { bankAccountNumber: '1122334455' } });
  check('BNK-02b', 'CSKH không có supplier.shop.approve ⇒ 403', noPerm.status === 403, { st: noPerm.status });
  const ok = await api('POST', `/admin/shops/${shop.id}/bank/verify`, { as: 'manager', body: { bankAccountNumber: '1122334455' } });
  const after = await q1(`SELECT bank_status, bank_verified_at FROM shop.shops WHERE id = $1`, [shop.id]);
  check('BNK-02c', 'quản lý xác minh ⇒ 200, bank_status=verified, có bank_verified_at', ok.status === 200 && after?.bank_status === 'verified' && !!after?.bank_verified_at, { st: ok.status, code: ok.code, after });
  const twice = await api('POST', `/admin/shops/${shop.id}/bank/verify`, { as: 'manager', body: { bankAccountNumber: '1122334455' } });
  check('BNK-02d', 'xác minh lần hai ⇒ 409 SHOP_BANK_NOT_PENDING', twice.status === 409 && twice.code === 'SHOP_BANK_NOT_PENDING', { st: twice.status, code: twice.code });
  await q(`UPDATE shop.shops SET bank_account_number = $2, bank_code = $3, bank_account_name = $4, bank_status = $5, bank_verified_at = $6 WHERE id = $1`, [shop.id, before.bank_account_number, before.bank_code, before.bank_account_name, before.bank_status ?? 'verified', before.bank_verified_at]);
}

// ------------------------------------------------------------------ HLT
group('HLT — health');
{
  const h = await fetch(`${L.BASE}/health`).then(async (r) => ({ st: r.status, j: await r.json().catch(() => null) }));
  check('HLT-01a', 'GET /health ⇒ 200 UP, database/redis/worker UP', h.st === 200 && h.j?.data?.status === 'UP' && h.j?.data?.worker === 'UP', { st: h.st, d: h.j?.data });
  const w = await fetch(`${L.BASE}/health/worker`).then(async (r) => ({ st: r.status, j: await r.json().catch(() => null) }));
  check('HLT-01b', 'GET /health/worker ⇒ 200 UP kèm lastSeenAt', w.st === 200 && !!w.j?.data?.lastSeenAt, { st: w.st, d: w.j?.data });
}

await L.setSetting('order.sla_enabled', slaBefore ?? false);
L.saveResults(process.env.OUT ?? 'out-t10.json');
const R = L.results;
console.log(`
TỔNG nhóm 10: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', ') || '(không)');
process.exit(0);
