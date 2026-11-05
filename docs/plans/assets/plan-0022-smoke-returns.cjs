/* Smoke HTTP toàn luồng đổi trả/hoàn tiền (PLAN-0022) trên backend cô lập :4010 + DB :55432. */
const { createRequire } = require('node:module');
const req = createRequire('D:/Fullstack/eco_fashion/eco_backend/package.json');
const { Client } = req('pg');

const BASE = 'http://localhost:4010/api/v1';
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ← ' + JSON.stringify(extra)}`);
}
async function api(method, path, token, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* không phải JSON */ }
  return { status: res.status, data: json?.data, error: json?.error, raw: json };
}
const tokens = {};
async function login(email, password) {
  if (tokens[email]) return tokens[email];
  const r = await api('POST', '/auth/login', null, { email, password });
  if (!r.data?.accessToken) throw new Error(`Đăng nhập thất bại ${email}: ${JSON.stringify(r.raw).slice(0, 200)}`);
  return (tokens[email] = r.data.accessToken);
}
const cust = (n) => login(`khach${n}@ecofashion.vn`, 'Khach123456!');
const owner = (n) => login(`${n}@ecofashion.vn`, 'Vendor123456!');
const staff = (n) => login(`${n}@ecofashion.vn`, 'NhanVien123!');
const admin = () => login('admin@ecofashion.vn', 'Admin123456!');
const EVID = [{ type: 'image', url: '/static/uploads/smoke-test.jpg', name: 'smoke-test.jpg' }];
const ADDR = { name: 'Kho Test', phone: '0900000000', address: '1 Đường Thử, Quận 1, TP.HCM' };
const ACC = { bankBin: '970436', accountNumber: '0123456789', accountName: 'Nguyen Van Khach' };

async function main() {
  const db = new Client({ connectionString: 'postgresql://ecofashion:ecofashion@localhost:55432/ecofashion' });
  await db.connect();
  const q = (sql, params) => db.query(sql, params);

  // ---------- chuẩn bị dữ liệu ----------
  await q(`UPDATE "order".orders SET delivered_at = now(), status = 'delivered' WHERE code = ANY($1)`, [['DHSEED00248', 'DHSEED00265', 'DHSEED00258', 'DHSEED00253', 'DHSEED00250']]);
  await q(`UPDATE "order".orders SET status = 'shipping', delivered_at = NULL, shipped_at = now() - interval '2 days' WHERE code = ANY($1)`, [['DHSEED00252', 'DHSEED00247']]);

  // ================= A: PayOS happy path =================
  console.log('\n=== A. PayOS: khách tạo → shop duyệt → khách gửi → shop nhận → kế toán ghi sổ ===');
  const kA = await cust(35), oA = await owner('ngonviet'), acc = await staff('accountant'), sales = await staff('sales'), adm = await admin();
  const ordA = await api('GET', '/orders/DHSEED00248', kA);
  check('A0 khách thấy đơn', ordA.status === 200 && ordA.data?.items?.length > 0, ordA);
  const itemA = ordA.data.items[0];
  let r = await api('POST', '/orders/DHSEED00248/returns', kA, { reasonCode: 'defective', reason: 'Hàng bị lỗi', items: [{ orderItemId: itemA.id, quantity: 1 }], evidence: [{ type: 'image', url: 'https://evil.example.com/x.jpg', name: 'x.jpg' }] });
  check('A1 minh chứng URL lạ bị chặn (400)', r.status === 400, r);
  r = await api('POST', '/orders/DHSEED00248/returns', kA, { reasonCode: 'defective', reason: 'Hàng bị lỗi', items: [{ orderItemId: itemA.id, quantity: 1 }], evidence: EVID });
  check('A2 tạo yêu cầu (201, requested)', r.status === 201 && r.data?.status === 'requested', r);
  const retA = r.data?.id;
  check('A2b có hạn shop duyệt', r.data?.deadlineKind === 'shop_respond' && !!r.data?.deadlineAt, r.data);
  r = await api('GET', '/shop/returns?status=requested', oA);
  check('A3 shop thấy yêu cầu', r.status === 200 && JSON.stringify(r.data).includes(retA), { status: r.status });
  r = await api('GET', `/admin/returns/${retA}`, sales);
  check('A3b CSKH xem được (chỉ xem)', r.status === 200, { status: r.status });
  r = await api('POST', `/admin/returns/${retA}/resolve`, sales, { decision: 'refund', note: 'Thử phân xử sớm' });
  check('A3c CSKH KHÔNG phân xử được khi chưa escalated (409)', r.status === 409, r);
  r = await api('POST', `/shop/returns/${retA}/approve`, oA, { returnAddress: ADDR });
  check('A4 shop duyệt → approved + địa chỉ trả', r.status === 201 || r.status === 200, r);
  r = await api('GET', `/returns/${retA}`, kA);
  check('A4b khách thấy approved + returnAddress + canShipBack', r.data?.status === 'approved' && !!r.data?.returnAddress && r.data?.canShipBack === true, { status: r.data?.status, addr: r.data?.returnAddress, can: r.data?.canShipBack });
  r = await api('POST', `/returns/${retA}/ship-back`, kA, { carrier: 'GHN', trackingCode: 'GHN-SMOKE-1' });
  check('A5 khách báo đã gửi hàng', r.status === 201 || r.status === 200, r);
  r = await api('POST', `/shop/returns/${retA}/receive`, oA, { condition: 'ok', note: 'Nhận đủ hàng' });
  check('A6 shop xác nhận nhận hàng → received', (r.status === 201 || r.status === 200) && r.data?.status === 'received', r);
  r = await api('GET', '/admin/refunds?status=requested&size=100', acc);
  const refA = (r.data?.content ?? []).find((x) => x.orderCode === 'DHSEED00248');
  check('A7 kế toán thấy khoản hoàn requested', !!refA && refA.status === 'requested', { status: r.status, sample: refA });
  if (refA) {
    check('A7b hoàn PayOS chưa cấu hình ⇒ cần chuyển tay', refA.needsManual === true || refA.method === 'manual_transfer', refA);
    const pv = await api('GET', `/admin/refunds/${refA.id}/payee`, acc);
    check('A7c xem payee: 404 (PayOS không có TK) hoặc 200', [200, 404].includes(pv.status), pv);
    const pv2 = await api('GET', `/admin/refunds/${refA.id}/payee`, sales);
    check('A7d CSKH KHÔNG xem được payee (403)', pv2.status === 403, pv2);
    const p0 = await api('POST', `/admin/refunds/${refA.id}/process`, acc, {});
    check('A8 ghi sổ không có providerRef ⇒ lỗi (4xx)', p0.status >= 400 && p0.status < 500, p0);
    const p1 = await api('POST', `/admin/refunds/${refA.id}/process`, acc, { providerRef: 'SMOKE-REF-0001', note: 'chuyển khoản tay' });
    check('A9 ghi sổ với providerRef → done', (p1.status === 201 || p1.status === 200) && p1.data?.status === 'done', p1);
    r = await api('GET', `/returns/${retA}`, kA);
    check('A10 yêu cầu → refunded', r.data?.status === 'refunded', r.data?.status);
    r = await api('GET', '/orders/DHSEED00248', kA);
    check('A11 đơn hiện trạng thái hoàn tiền (refund.done)', r.data?.refund?.status === 'done', r.data?.refund);
  }

  // ================= B: COD → từ chối → khiếu nại → CSKH phân xử → kế toán =================
  console.log('\n=== B. COD: thiếu TK ⇒ 400; shop từ chối → khách khiếu nại → CSKH phân xử → kế toán chi ===');
  const kB = await cust(29), oB = await owner('nhaxinh');
  const ordB = await api('GET', '/orders/DHSEED00265', kB);
  const itemB = ordB.data.items[0];
  r = await api('POST', '/orders/DHSEED00265/returns', kB, { reasonCode: 'wrong_item', reason: 'Giao sai hàng', items: [{ orderItemId: itemB.id, quantity: 1 }], evidence: EVID });
  check('B1 COD thiếu TK nhận hoàn ⇒ 400', r.status === 400 && /REFUND_ACCOUNT/.test(JSON.stringify(r.raw)), r);
  r = await api('POST', '/orders/DHSEED00265/returns', kB, { reasonCode: 'wrong_item', reason: 'Giao sai hàng', items: [{ orderItemId: itemB.id, quantity: 1 }], evidence: EVID, refundAccount: ACC });
  check('B2 COD có TK ⇒ 201', r.status === 201, r);
  const retB = r.data?.id;
  check('B2b response khách che số TK', JSON.stringify(r.data?.refundAccount ?? {}).includes('****') && !JSON.stringify(r.data).includes('0123456789'), r.data?.refundAccount);
  r = await api('GET', `/shop/returns/${retB}`, oB);
  check('B3 API shop KHÔNG lộ refundAccount', r.status === 200 && !('refundAccount' in (r.data ?? {})) || r.data?.refundAccount == null, r.data?.refundAccount);
  r = await api('POST', `/shop/returns/${retB}/reject`, oB, { reason: 'Hàng đúng đơn, khách nhầm lẫn' });
  check('B4 shop từ chối → rejected', (r.status === 201 || r.status === 200) && r.data?.status === 'rejected', r);
  r = await api('POST', `/returns/${retB}/escalate`, kB, { reason: 'Tôi không đồng ý, hàng giao sai thật' });
  check('B5 khách khiếu nại → escalated', (r.status === 201 || r.status === 200) && r.data?.status === 'escalated', r);
  r = await api('POST', `/admin/returns/${retB}/resolve`, oB, { decision: 'refund', note: 'x'.repeat(10) });
  check('B6 chủ shop KHÔNG phân xử được (403)', r.status === 403, { status: r.status });
  const mgr = await staff('manager');
  r = await api('POST', `/admin/returns/${retB}/resolve`, mgr, { decision: 'refund', note: 'x'.repeat(10) });
  check('B6b quản lý KHÔNG phân xử được (403)', r.status === 403, { status: r.status });
  r = await api('POST', `/admin/returns/${retB}/resolve`, sales, { decision: 'refund', note: 'Đối chiếu ảnh: shop giao sai mẫu' });
  check('B7 CSKH phân xử hoàn tiền → received', (r.status === 201 || r.status === 200) && r.data?.status === 'received', r);
  r = await api('GET', '/admin/refunds?status=requested&size=100', acc);
  const refB = (r.data?.content ?? []).find((x) => x.orderCode === 'DHSEED00265');
  check('B8 khoản hoàn COD có payee (customer)', !!refB && refB.payeeSource === 'customer', refB);
  if (refB) {
    const pv = await api('GET', `/admin/refunds/${refB.id}/payee`, acc);
    check('B9 kế toán xem đủ số TK', pv.status === 200 && pv.data?.accountNumber === '0123456789', { status: pv.status, bankBin: pv.data?.bankBin });
    const dup = await api('POST', `/admin/refunds/${refB.id}/process`, acc, { providerRef: 'SMOKE-REF-0001' });
    check('B10 providerRef trùng ⇒ 409', dup.status === 409, dup);
    const ok = await api('POST', `/admin/refunds/${refB.id}/process`, acc, { providerRef: 'SMOKE-REF-0002' });
    check('B11 ghi sổ providerRef mới ⇒ done', (ok.status === 201 || ok.status === 200) && ok.data?.status === 'done', ok);
    r = await api('GET', `/returns/${retB}`, kB);
    check('B12 yêu cầu → refunded', r.data?.status === 'refunded', r.data?.status);
  }

  // ================= C: chưa nhận hàng =================
  console.log('\n=== C. Chưa nhận hàng (đơn shipping): shop duyệt ⇒ hoàn thẳng, không nhập kho ===');
  const kC = await cust(2), oC = await owner('sneaker');
  const ordC = await api('GET', '/orders/DHSEED00252', kC);
  check('C0 canReportNotReceived', ordC.data?.canReportNotReceived === true, { can: ordC.data?.canReportNotReceived, status: ordC.data?.status });
  r = await api('POST', '/orders/DHSEED00252/returns', kC, { reasonCode: 'not_received', reason: 'Chưa nhận được hàng' });
  check('C1 tạo yêu cầu chưa nhận hàng', r.status === 201 && r.data?.requireReturn === false, r);
  const retC = r.data?.id;
  r = await api('POST', `/shop/returns/${retC}/approve`, oC, {});
  check('C2 shop duyệt ⇒ received thẳng', (r.status === 201 || r.status === 200) && r.data?.status === 'received', r);

  // ================= D: giao thất bại =================
  console.log('\n=== D. Giao không thành công (shop báo) ===');
  const oD = await owner('sportplanet');
  r = await api('POST', '/shop/orders/DHSEED00247/delivery-failed', oD, { reasonCode: 'refused', note: 'Khách từ chối nhận hàng', goodsReturned: true });
  check('D1 delivery-failed ⇒ đơn cancelled', (r.status === 201 || r.status === 200) && r.data?.status === 'cancelled', r);
  r = await api('POST', '/shop/orders/DHSEED00247/delivery-failed', oD, { reasonCode: 'refused', note: 'Khách từ chối nhận hàng', goodsReturned: true });
  check('D2 gọi lại ⇒ lỗi (400)', r.status === 400, r);
  const oWrong = await owner('sneaker');
  r = await api('POST', '/shop/orders/DHSEED00247/delivery-failed', oWrong, { reasonCode: 'lost', note: 'Thất lạc trên đường', goodsReturned: false });
  check('D3 shop khác ⇒ 404', r.status === 404, r);

  // ================= E: chuẩn bị SLA =================
  console.log('\n=== E. Chuẩn bị 3 yêu cầu quá hạn để worker tự chuyển bước ===');
  const out = {};
  // E1: requested quá hạn shop duyệt
  const kE1 = await cust(22), oE1 = await owner('mobilehub');
  let o = await api('GET', '/orders/DHSEED00258', kE1);
  r = await api('POST', '/orders/DHSEED00258/returns', kE1, { reasonCode: 'changed_mind', reason: 'Đổi ý', items: [{ orderItemId: o.data.items[0].id, quantity: 1 }], evidence: EVID });
  check('E1 tạo (quá hạn shop duyệt)', r.status === 201, r);
  out.e1 = r.data?.id;
  await q(`UPDATE "order".return_requests SET shop_respond_due_at = now() - interval '1 hour' WHERE id = $1`, [out.e1]);
  // E2: approved, quá hạn gửi hàng
  const kE2 = await cust(45), oE2 = await owner('nhaxinh');
  o = await api('GET', '/orders/DHSEED00253', kE2);
  r = await api('POST', '/orders/DHSEED00253/returns', kE2, { reasonCode: 'defective', reason: 'Hàng lỗi', items: [{ orderItemId: o.data.items[0].id, quantity: 1 }], evidence: EVID, refundAccount: ACC });
  out.e2 = r.data?.id;
  r = await api('POST', `/shop/returns/${out.e2}/approve`, oE2, { returnAddress: ADDR });
  check('E2 duyệt (rồi chỉnh quá hạn gửi hàng)', r.status === 201 || r.status === 200, r);
  await q(`UPDATE "order".return_requests SET ship_back_due_at = now() - interval '1 hour' WHERE id = $1`, [out.e2]);
  // E3: approved + đã báo gửi, quá hạn shop xác nhận nhận
  const kE3 = await cust(18), oE3 = await owner('sneaker');
  o = await api('GET', '/orders/DHSEED00250', kE3);
  r = await api('POST', '/orders/DHSEED00250/returns', kE3, { reasonCode: 'size_issue', reason: 'Không vừa', items: [{ orderItemId: o.data.items[0].id, quantity: 1 }], evidence: EVID, refundAccount: ACC });
  out.e3 = r.data?.id;
  r = await api('POST', `/shop/returns/${out.e3}/approve`, oE3, { returnAddress: ADDR });
  r = await api('POST', `/returns/${out.e3}/ship-back`, kE3, { carrier: 'GHTK', trackingCode: 'GHTK-SMOKE-3' });
  check('E3 duyệt + khách báo gửi (rồi chỉnh quá hạn nhận)', r.status === 201 || r.status === 200, r);
  await q(`UPDATE "order".return_requests SET shop_receive_due_at = now() - interval '1 hour' WHERE id = $1`, [out.e3]);

  require('node:fs').writeFileSync(process.env.SMOKE_OUT || 'smoke-e.json', JSON.stringify(out));
  await db.end();

  const bad = results.filter((x) => !x.ok);
  console.log(`\nTỔNG: ${results.length - bad.length}/${results.length} PASS`);
  if (bad.length) { console.log('FAIL:', bad.map((b) => b.name).join(' | ')); process.exitCode = 1; }
}
main().catch((e) => { console.error('LỖI KỊCH BẢN:', e); process.exit(2); });
