/* Nhóm 04: đổi trả (RET) + hoàn tiền (REF) — luồng chính, ngoại lệ, SLA, quyền, PayOS payout giả (thành công / từ chối / timeout / treo). */
import * as L from './lib.mjs';
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

group('RET — luồng chính PayOS (từng dòng hàng, nhận hàng, hoàn qua PayOS)');
let R1;
{
  const o = await delivered({ method: 'payos' });
  const itemA = o.items[0];
  const stockBefore = await L.stock(itemA.variantId);
  const c = await mkReturn(o, { items: [{ orderItemId: itemA.id, quantity: 1 }] });
  check('RET-01a', 'khách tạo yêu cầu đổi trả 1/2 dòng (201, requested, hạn shop duyệt)', c.status === 201 && c.data?.status === 'requested' && c.data?.deadlineKind === 'shop_respond', { st: c.status, code: c.code, d: c.data?.status });
  const id = c.data?.id;
  const calc = Number(L.money(c.data?.refundAmount));
  note('RET-01a2', 'số tiền hoàn tính sẵn cho dòng đầu', `${calc} (tổng đơn ${o.total}, dòng ${Number(L.money(itemA.unitPrice))}×1 ⇒ tỉ lệ cả phí ship)`);
  const ap = await api('POST', `/shop/returns/${id}/approve`, { as: `owner:${o.slug}`, body: { returnAddress: ADDR } });
  check('RET-01b', 'shop duyệt kèm địa chỉ nhận hàng trả ⇒ approved', ap.status === 200 || ap.status === 201, { st: ap.status, code: ap.code });
  const cust = await api('GET', `/returns/${id}`, { as: o.as });
  check('RET-01c', 'khách thấy địa chỉ gửi trả + canShipBack', cust.data?.status === 'approved' && !!cust.data?.returnAddress && cust.data?.canShipBack === true, cust.data);
  const sb = await api('POST', `/returns/${id}/ship-back`, { as: o.as, body: { carrier: 'GHN', trackingCode: 'GHN-AUD-1' } });
  check('RET-01d', 'khách báo đã gửi hàng trả (hạn shop nhận)', sb.status === 200 || sb.status === 201, { st: sb.status, code: sb.code });
  const rc = await api('POST', `/shop/returns/${id}/receive`, { as: `owner:${o.slug}`, body: { condition: 'ok', note: 'Nhận đủ hàng' } });
  check('RET-01e', 'shop xác nhận nhận đúng hàng ⇒ received', (rc.status === 200 || rc.status === 201) && rc.data?.status === 'received', { st: rc.status, code: rc.code });
  const stAfter = await L.stock(itemA.variantId);
  check('RET-01f', 'nhập kho lại đúng 1 đơn vị', Number(stAfter.stock) === Number(stockBefore.stock) + 1, { stockBefore, stAfter });
  const rf = (await refundOf(o.code))[0];
  check('RET-01g', 'refund requested, gateway, payee từ TK người trả, số tiền = số tính sẵn', !!rf && rf.status === 'requested' && rf.payeeSource === 'payer' && Number(L.money(rf.amount)) === calc && rf.returnRequestId === id, rf);
  const pr = await api('POST', `/admin/refunds/${rf.id}/process`, { as: 'accountant', body: {} });
  check('RET-01h', 'kế toán chi hoàn qua PayOS ⇒ processing (chưa done)', pr.status === 200 && pr.data?.status === 'processing', { st: pr.status, d: pr.data?.status });
  const st = await L.mockState();
  const po = st.payouts.find((p) => p.amount === calc);
  check('RET-01i', 'PayOS giả nhận lệnh chi đúng số tiền + TK người trả', !!po && po.toAccountNumber === '0011223344', st.payouts);
  const mid = await api('GET', `/returns/${id}`, { as: o.as });
  check('RET-01j', 'trong lúc processing: yêu cầu chưa "refunded", khách thấy refund đang xử lý', mid.data?.status === 'received' && mid.data?.refund?.status === 'processing', { s: mid.data?.status, r: mid.data?.refund });
  await L.mockPayoutState({ id: po.id }, 'SUCCEEDED');
  L.runJob('refund-reconcile');
  const fin = await api('GET', `/returns/${id}`, { as: o.as });
  check('RET-01k', 'PayOS SUCCEEDED + job ⇒ refund done, yêu cầu refunded', fin.data?.status === 'refunded' && fin.data?.refund?.status === 'done', { s: fin.data?.status, r: fin.data?.refund });
  const od = await api('GET', `/orders/${o.code}`, { as: o.as });
  check('RET-01l', 'đơn hiển thị trạng thái hoàn tiền (refund.done) và payment partially_refunded', od.data?.refund?.status === 'done' && od.data?.paymentStatus === 'partially_refunded', { refund: od.data?.refund, ps: od.data?.paymentStatus });
  // hoàn nốt dòng còn lại ⇒ đơn returned
  const c2 = await mkReturn(o, { items: [{ orderItemId: o.items[1].id, quantity: 1 }] });
  const id2 = c2.data?.id;
  await api('POST', `/shop/returns/${id2}/approve`, { as: `owner:${o.slug}`, body: { returnAddress: ADDR } });
  await api('POST', `/returns/${id2}/ship-back`, { as: o.as, body: { carrier: 'GHN', trackingCode: 'GHN-AUD-2' } });
  await api('POST', `/shop/returns/${id2}/receive`, { as: `owner:${o.slug}`, body: { condition: 'ok' } });
  const orow = await L.orderRow(o.code);
  check('RET-13', 'trả đủ mọi dòng ⇒ đơn → returned; tổng 2 yêu cầu hoàn ≤ tổng đơn', orow.status === 'returned' && (await refundOf(o.code)).reduce((a, r) => a + Number(L.money(r.amount)), 0) <= o.total, { st: orow.status, refunds: (await refundOf(o.code)).map((r) => r.amount?.amount), total: o.total });
  R1 = { o, id };
}

group('RET — ngoại lệ khi tạo / quyền / hạn');
{
  const o = await delivered({ method: 'payos', as: 'khach35' });
  const it = o.items[0];
  const over = await mkReturn(o, { items: [{ orderItemId: it.id, quantity: 5 }] });
  check('RET-20', 'trả nhiều hơn số đã mua ⇒ 400', over.status === 400, { st: over.status, code: over.code });
  const ok1 = await mkReturn(o, { items: [{ orderItemId: it.id, quantity: 1 }] });
  const dup = await mkReturn(o, { items: [{ orderItemId: it.id, quantity: 1 }] });
  check('RET-21', 'yêu cầu thứ hai cho cùng dòng (đã hết số lượng còn trả được) ⇒ 400', ok1.status === 201 && dup.status === 400, { ok1: ok1.status, dup: dup.status, code: dup.code });
  const badEv = await mkReturn(o, { items: [{ orderItemId: o.items[1].id, quantity: 1 }], evidence: [{ type: 'image', url: 'https://evil.example.com/x.jpg', name: 'x.jpg' }] });
  check('RET-22', 'minh chứng URL ngoài kho upload ⇒ 400', badEv.status === 400, { st: badEv.status, code: badEv.code });
  const noEv = await mkReturn(o, { items: [{ orderItemId: o.items[1].id, quantity: 1 }], evidence: [] });
  check('RET-23', 'lý do thường không có minh chứng ⇒ 400', noEv.status === 400, { st: noEv.status, code: noEv.code });
  const sixty = await mkReturn(o, { items: [{ orderItemId: o.items[1].id, quantity: 1 }], reasonCode: 'weird_reason' });
  check('RET-24', 'reasonCode không hợp lệ ⇒ 400', sixty.status === 400, { st: sixty.status });
  // quyền
  const retId = ok1.data?.id;
  const other = await api('GET', `/returns/${retId}`, { as: 'khach33' });
  check('SEC-02r', 'khách khác xem yêu cầu đổi trả của người khác ⇒ 404', other.status === 404, { st: other.status });
  const shopB = await api('GET', `/shop/returns/${retId}`, { as: 'owner:sneaker' });
  check('SEC-01r', 'shop khác xem yêu cầu của shop mình không phải ⇒ 404', shopB.status === 404, { st: shopB.status });
  const shopBap = await api('POST', `/shop/returns/${retId}/approve`, { as: 'owner:sneaker', body: { returnAddress: ADDR } });
  check('SEC-01r2', 'shop khác duyệt yêu cầu không phải của mình ⇒ 404', shopBap.status === 404, { st: shopBap.status });
  const staffNoPerm = await api('POST', `/shop/returns/${retId}/approve`, { as: 'staff:techzone', body: { returnAddress: ADDR } });
  check('SEC-04r', 'nhân viên shop KHÔNG có shop.return.process ⇒ 403', staffNoPerm.status === 403, { st: staffNoPerm.status });
  const salesApprove = await api('POST', `/shop/returns/${retId}/approve`, { as: 'sales', body: { returnAddress: ADDR } });
  check('SEC-03r', 'nhân viên sàn gọi API shop ⇒ 403', salesApprove.status === 403, { st: salesApprove.status });
  const resolveEarly = await api('POST', `/admin/returns/${retId}/resolve`, { as: 'sales', body: { decision: 'refund', note: 'phân xử sớm khi chưa chuyển sàn' } });
  check('SEC-03r2', 'CSKH phân xử khi yêu cầu chưa escalated ⇒ 409', resolveEarly.status === 409, { st: resolveEarly.status });
  for (const role of ['manager', 'accountant', 'marketing']) {
    const r = await api('POST', `/admin/returns/${retId}/resolve`, { as: role, body: { decision: 'refund', note: 'không đủ quyền phân xử' } });
    check(`SEC-03r-${role}`, `${role} phân xử ⇒ 403`, r.status === 403, { st: r.status });
  }
  // shop: reject quá ngắn, approve số tiền
  const rj0 = await api('POST', `/shop/returns/${retId}/reject`, { as: 'owner:techzone', body: { reason: 'ngắn' } });
  check('RET-25', 'shop từ chối với lý do < 10 ký tự ⇒ 400', rj0.status === 400, { st: rj0.status });
  const calc = Number(L.money(ok1.data?.refundAmount));
  const hi = await api('POST', `/shop/returns/${retId}/approve`, { as: 'owner:techzone', body: { returnAddress: ADDR, refundAmount: String(calc + 1000), adjustReason: 'tăng số tiền hoàn' } });
  check('RET-26', 'shop duyệt với số tiền hoàn CAO hơn số tính sẵn ⇒ 400', hi.status === 400, { st: hi.status, code: hi.code });
  const lowNoReason = await api('POST', `/shop/returns/${retId}/approve`, { as: 'owner:techzone', body: { returnAddress: ADDR, refundAmount: String(calc - 1000) } });
  check('RET-27', 'shop giảm số tiền hoàn nhưng không nêu lý do ⇒ 400', lowNoReason.status === 400, { st: lowNoReason.status, code: lowNoReason.code });
  const noAddr = await api('POST', `/shop/returns/${retId}/approve`, { as: 'owner:techzone', body: {} });
  note('RET-28', 'shop duyệt không gửi địa chỉ nhận hàng (lần đầu)', `HTTP ${noAddr.status} ${noAddr.code ?? ''} (nếu đã có địa chỉ cũ của shop thì tự lấy lại)`);
  // receive khi chưa approved
  const recvEarly = await api('POST', `/shop/returns/${retId}/receive`, { as: 'owner:techzone', body: { condition: 'ok' } });
  check('RET-29', 'xác nhận nhận hàng khi yêu cầu chưa ở approved ⇒ 409', recvEarly.status === 409 || recvEarly.status === 400, { st: recvEarly.status, code: recvEarly.code });
  // rút yêu cầu trước khi gửi; sau khi gửi thì không
  const retId2 = (await mkReturn(o, { items: [{ orderItemId: o.items[1].id, quantity: 1 }] })).data?.id;
  const cn = await api('POST', `/returns/${retId2}/cancel`, { as: o.as });
  check('RET-30', 'khách rút yêu cầu khi còn requested ⇒ cancelled', (cn.status === 200 || cn.status === 201) && cn.data?.status === 'cancelled', { st: cn.status, d: cn.data?.status });
  const ap = await api('POST', `/shop/returns/${retId}/approve`, { as: 'owner:techzone', body: { returnAddress: ADDR } });
  await api('POST', `/returns/${retId}/ship-back`, { as: o.as, body: { carrier: 'GHN', trackingCode: 'GHN-AUD-3' } });
  const cn2 = await api('POST', `/returns/${retId}/cancel`, { as: o.as });
  check('RET-31', 'khách rút yêu cầu SAU khi đã báo gửi hàng ⇒ chặn', cn2.status >= 400, { st: cn2.status, code: cn2.code });
  const esc = await api('POST', `/returns/${retId}/escalate`, { as: o.as, body: { reason: 'Muốn khiếu nại khi yêu cầu đang approved' } });
  check('RET-32', 'khách khiếu nại khi shop chưa từ chối ⇒ chặn', esc.status >= 400, { st: esc.status });
  globalThis.RET_approved = { o, retId };
}
{
  // quá hạn đổi trả
  const o = await delivered({ method: 'payos', as: 'khach36' });
  await q(`UPDATE "order".orders SET delivered_at = now() - interval '8 days' WHERE code = $1`, [o.code]);
  const c = await mkReturn(o, { items: [{ orderItemId: o.items[0].id, quantity: 1 }] });
  check('RET-33', 'quá 7 ngày kể từ khi giao ⇒ 400 ORDER_RETURN_WINDOW_CLOSED', c.status === 400 && /WINDOW/.test(c.code ?? ''), { st: c.status, code: c.code });
  const vs = (await L.pickVariant({ shopId: shops.techzone.id, qty: 3 }))[0];
  const p = await L.placeOrder({ as: 'khach36', items: [{ variantId: vs.id, qty: 1 }], method: 'cod' });
  const k = L.childOrders(p)[0];
  await sstat('techzone', k.code, 'confirmed');
  const it = (await api('GET', `/orders/${k.code}`, { as: 'khach36' })).data.items[0];
  const c2 = await api('POST', `/orders/${k.code}/returns`, { as: 'khach36', body: { reasonCode: 'defective', reason: 'Lỗi', items: [{ orderItemId: it.id, quantity: 1 }], evidence: EV, refundAccount: ACC } });
  check('RET-34', 'đơn chưa giao (confirmed) ⇒ không đổi trả được (400)', c2.status === 400, { st: c2.status, code: c2.code });
  const c3 = await api('POST', `/orders/${k.code}/returns`, { as: 'khach36', body: { reasonCode: 'not_received', reason: 'chưa nhận' } });
  check('RET-35', 'đơn confirmed (chưa giao) cũng không được báo "chưa nhận hàng" (đúng)', c3.status === 400, { st: c3.status, code: c3.code });
  await api('POST', `/orders/${k.code}/cancel`, { as: 'khach36', body: { reason: 'dọn đơn kiểm thử' } });
}

group('RET — COD: tài khoản nhận hoàn, từ chối → khiếu nại → CSKH, ví cọc');
{
  const o = await delivered({ slug: 'ngonviet', method: 'cod', as: 'khach37' });
  const it = o.items[0];
  const noAcc = await api('POST', `/orders/${o.code}/returns`, { as: o.as, body: { reasonCode: 'wrong_item', reason: 'Giao sai hàng', items: [{ orderItemId: it.id, quantity: 1 }], evidence: EV } });
  check('RET-02a', 'COD đã thu mà không khai TK nhận hoàn ⇒ 400', noAcc.status === 400, { st: noAcc.status, code: noAcc.code });
  const badAcc = await api('POST', `/orders/${o.code}/returns`, { as: o.as, body: { reasonCode: 'wrong_item', reason: 'Giao sai hàng', items: [{ orderItemId: it.id, quantity: 1 }], evidence: EV, refundAccount: { bankBin: '12', accountNumber: 'abc', accountName: '' } } });
  check('RET-02b', 'TK nhận hoàn sai định dạng ⇒ 400', badAcc.status === 400, { st: badAcc.status });
  const c = await mkReturn(o, { reasonCode: 'wrong_item', reason: 'Giao sai hàng', items: [{ orderItemId: it.id, quantity: 1 }] });
  check('RET-02c', 'COD có TK hợp lệ ⇒ 201, số TK che, tên chuẩn hoá', c.status === 201 && /\*\*\*\*6789/.test(JSON.stringify(c.data?.refundAccount)) && c.data?.refundAccount?.accountName === 'NGUYEN VAN KHACH', c.data?.refundAccount);
  const id = c.data?.id;
  const shopView = await api('GET', `/shop/returns/${id}`, { as: 'owner:ngonviet' });
  check('RET-02d', 'API shop không lộ TK nhận hoàn của khách', shopView.status === 200 && !shopView.data?.refundAccount, shopView.data?.refundAccount);
  const rj = await api('POST', `/shop/returns/${id}/reject`, { as: 'owner:ngonviet', body: { reason: 'Hàng đúng đơn đặt, không giao sai' } });
  check('RET-03a', 'shop từ chối (có lý do) ⇒ rejected', (rj.status === 200 || rj.status === 201) && rj.data?.status === 'rejected', { st: rj.status });
  const es = await api('POST', `/returns/${id}/escalate`, { as: o.as, body: { reason: 'Tôi không đồng ý, hàng giao sai thật' } });
  check('RET-03b', 'khách khiếu nại ⇒ escalated', (es.status === 200 || es.status === 201) && es.data?.status === 'escalated', { st: es.status });
  const w0 = Number((await q1(`SELECT balance FROM payment.shop_cod_wallets WHERE shop_id = $1`, [shops.ngonviet.id])).balance);
  const rs = await api('POST', `/admin/returns/${id}/resolve`, { as: 'sales', body: { decision: 'refund', note: 'Đối chiếu ảnh: shop giao sai mẫu' } });
  check('RET-03c', 'CSKH phân xử hoàn tiền ⇒ received', (rs.status === 200 || rs.status === 201) && rs.data?.status === 'received', { st: rs.status, code: rs.code });
  const rf = (await refundOf(o.code))[0];
  check('RET-03d', 'refund COD: payee do khách khai, KT xem được số TK đầy đủ, CSKH thì không', !!rf && rf.payeeSource === 'customer' && (await api('GET', `/admin/refunds/${rf.id}/payee`, { as: 'accountant' })).data?.accountNumber === '0123456789' && (await api('GET', `/admin/refunds/${rf.id}/payee`, { as: 'sales' })).status === 403, rf);
  const pr = await api('POST', `/admin/refunds/${rf.id}/process`, { as: 'accountant', body: {} });
  check('REF-COD-1', 'hoàn COD có TK khách ⇒ đi PayOS payout (processing)', pr.status === 200 && pr.data?.status === 'processing', { st: pr.status, d: pr.data?.status, code: pr.code });
  const po = (await L.mockState()).payouts.find((p) => p.toAccountNumber === '0123456789');
  await L.mockPayoutState({ id: po.id }, 'SUCCEEDED');
  L.runJob('refund-reconcile');
  const done = (await refundOf(o.code))[0];
  check('REF-COD-2', 'PayOS thành công ⇒ refund done', done.status === 'done', done);
  const w1 = Number((await q1(`SELECT balance FROM payment.shop_cod_wallets WHERE shop_id = $1`, [shops.ngonviet.id])).balance);
  const tx = await q(`SELECT type, amount FROM payment.shop_cod_wallet_transactions WHERE shop_id = $1 AND order_code LIKE $2`, [shops.ngonviet.id, `%${o.code}%`]);
  const refunded = Number(L.money(done.amount));
  check('WAL-05', 'hoàn đơn COD ⇒ ví shop bị trừ số hoàn (đã đảo hoa hồng theo tỉ lệ)', tx.some((t) => t.type === 'cod_refund') && w1 < w0, { w0, w1, refunded, tx });
  const resolveAgain = await api('POST', `/admin/returns/${id}/resolve`, { as: 'sales', body: { decision: 'reject', note: 'phân xử lại sau khi đã hoàn' } });
  check('RET-36', 'phân xử lại yêu cầu đã received/refunded ⇒ 409', resolveAgain.status === 409, { st: resolveAgain.status });
}
{
  // CSKH từ chối lần cuối ⇒ khách không khiếu nại lại; resolve vượt trần
  const o = await delivered({ slug: 'sneaker', method: 'payos', as: 'khach38' });
  const c = await mkReturn(o, { reasonCode: 'changed_mind', reason: 'Đổi ý không muốn nữa', items: [{ orderItemId: o.items[0].id, quantity: 1 }] });
  const id = c.data?.id;
  await api('POST', `/shop/returns/${id}/reject`, { as: 'owner:sneaker', body: { reason: 'Đổi ý không thuộc diện đổi trả' } });
  await api('POST', `/returns/${id}/escalate`, { as: o.as, body: { reason: 'Tôi cho rằng hàng không đúng mô tả' } });
  const over = await api('POST', `/admin/returns/${id}/resolve`, { as: 'sales', body: { decision: 'refund', note: 'hoàn quá tổng đơn', refundAmount: String(o.total + 100000) } });
  check('RET-37', 'CSKH hoàn số tiền > tổng đơn ⇒ 400', over.status === 400, { st: over.status, code: over.code });
  const rej = await api('POST', `/admin/returns/${id}/resolve`, { as: 'sales', body: { decision: 'reject', note: 'Đổi ý — không thuộc diện đổi trả theo chính sách' } });
  check('RET-38', 'CSKH từ chối lần cuối ⇒ rejected (platform)', (rej.status === 200 || rej.status === 201) && rej.data?.status === 'rejected', { st: rej.status });
  const esc2 = await api('POST', `/returns/${id}/escalate`, { as: o.as, body: { reason: 'Tôi muốn khiếu nại lần nữa' } });
  check('RET-39', 'sau quyết định cuối của sàn khách KHÔNG khiếu nại lại được', esc2.status >= 400, { st: esc2.status, code: esc2.code });
  const noNote = await api('POST', `/admin/returns/${id}/resolve`, { as: 'sales', body: { decision: 'refund' } });
  check('RET-40', 'phân xử thiếu ghi chú ⇒ 400', noNote.status === 400, { st: noNote.status });
}

group('RET — "Chưa nhận được hàng" (not_received)');
{
  // PayOS đang giao
  const vs = (await L.pickVariant({ shopId: shops.techzone.id, qty: 3, maxPrice: 900000 }))[0];
  const p = await L.placeOrder({ as: 'khach39', items: [{ variantId: vs.id, qty: 1 }], method: 'payos' });
  const k = L.childOrders(p)[0];
  const payos = await L.payosCodeOf(k.code);
  await L.sendWebhook(payos, Number(L.money(k.total)), { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } });
  await sstat('techzone', k.code, 'confirmed'); await sstat('techzone', k.code, 'packing'); await sstat('techzone', k.code, 'shipping');
  const st0 = await L.stock(vs.id);
  const c = await api('POST', `/orders/${k.code}/returns`, { as: 'khach39', body: { reasonCode: 'not_received', reason: 'Chưa nhận được hàng' } });
  check('RET-08a', 'PayOS, đang giao: báo chưa nhận hàng không cần minh chứng/items (201, requireReturn=false)', c.status === 201 && c.data?.requireReturn === false, { st: c.status, code: c.code });
  const ap = await api('POST', `/shop/returns/${c.data?.id}/approve`, { as: 'owner:techzone', body: {} });
  check('RET-08b', 'shop duyệt ⇒ received thẳng (không cần gửi trả), tạo hoàn đủ', (ap.status === 200 || ap.status === 201) && ap.data?.status === 'received', { st: ap.status, code: ap.code });
  const st1 = await L.stock(vs.id);
  check('RET-08c', 'KHÔNG nhập kho (hàng thất lạc)', Number(st1.stock) === Number(st0.stock), { st0, st1 });
  const rf = (await refundOf(k.code))[0];
  check('RET-08d', 'hoàn đủ tổng đơn', !!rf && Number(L.money(rf.amount)) === Number(L.money(k.total)), rf);
  const orow = await L.orderRow(k.code);
  note('RET-08e', 'trạng thái đơn sau khi duyệt "chưa nhận hàng" cho đơn đang giao', `status=${orow.status} (shop có thể bấm delivered tiếp? thử bên dưới)`);
  const dl = await sstat('techzone', k.code, 'delivered');
  note('RET-08f', 'shop báo delivered sau khi đã duyệt hoàn (đơn ở trạng thái trên)', `HTTP ${dl.status} ${dl.code ?? ''}`);
}
{
  // COD đã giao rồi khách báo chưa nhận (COD-08)
  const o = await delivered({ slug: 'ngonviet', method: 'cod', as: 'khach40', qtys: [1, 1] });
  const w0 = Number((await q1(`SELECT balance FROM payment.shop_cod_wallets WHERE shop_id = $1`, [shops.ngonviet.id])).balance);
  const noAcc = await api('POST', `/orders/${o.code}/returns`, { as: o.as, body: { reasonCode: 'not_received', reason: 'Chưa nhận được hàng' } });
  // PLAN-0040 3.6: khách báo "chưa nhận" đơn COD KHÔNG phải khai TK nhận hoàn (khách chưa từng trả tiền mặt) — yêu cầu tạo được (201) không kèm TK.
  check('COD-08a', 'COD đã báo giao, khách báo chưa nhận KHÔNG bị bắt khai TK nhận hoàn (khách chưa hề trả tiền) ⇒ 201', noAcc.status === 201, { st: noAcc.status, code: noAcc.code });
  const c = noAcc;
  if (c.status === 201) {
    const ap = await api('POST', `/shop/returns/${c.data.id}/approve`, { as: 'owner:ngonviet', body: {} });
    const rf = (await refundOf(o.code))[0];
    const ord = await L.orderRow(o.code);
    const pays = await L.paymentRows(o.code);
    const rev = await q(`SELECT type, amount FROM payment.shop_cod_wallet_transactions WHERE shop_id = $1 AND order_code = $2 AND type = 'cod_reversal'`, [shops.ngonviet.id, o.code]);
    check('COD-08b', 'COD "chưa nhận": KHÔNG chuyển tiền cho khách (khách chưa trả) — đảo ghi thu COD: không có hoàn tiền, payment không còn `paid`, đơn `returned`+`unpaid`, ví có giao dịch `cod_reversal`', ap.status < 300 && !rf && pays[0]?.status !== 'paid' && ord.payment_status === 'unpaid' && rev.length === 1, { approve: ap.status, refund: rf && { st: rf.status, amount: rf.amount?.amount, payee: rf.payeeSource }, pay: pays[0]?.status, ps: ord.payment_status, order: ord.status, rev: rev.length });
    const w1 = Number((await q1(`SELECT balance FROM payment.shop_cod_wallets WHERE shop_id = $1`, [shops.ngonviet.id])).balance);
    note('COD-08c', 'ví shop sau khi đảo ghi thu', `trước=${w0} sau=${w1} (hoa hồng đã trừ được trả lại; phần voucher sàn đã bù bị thu lại)`);
  } else check('COD-08b', 'tạo được yêu cầu chưa nhận hàng cho COD', false, { st: c.status, code: c.code });
}

group('RET — SLA tự chuyển bước (job)');
{
  const mk = async (as, slug, step) => {
    const o = await delivered({ slug, method: 'payos', as });
    const c = await mkReturn(o, { items: [{ orderItemId: o.items[0].id, quantity: 1 }] });
    const id = c.data.id;
    if (step >= 1) await api('POST', `/shop/returns/${id}/approve`, { as: `owner:${slug}`, body: { returnAddress: ADDR } });
    if (step >= 2) await api('POST', `/returns/${id}/ship-back`, { as: o.as, body: { carrier: 'GHN', trackingCode: `GHN-SLA-${Date.now() % 100000}` } });
    return { o, id };
  };
  const a = await mk('khach41', 'techzone', 0); // quá hạn shop duyệt
  const b = await mk('khach42', 'ngonviet', 1); // quá hạn gửi trả
  const c = await mk('khach43', 'sneaker', 2);  // quá hạn shop nhận
  const d = await mk('khach44', 'nhaxinh', 0);  // nhắc 24h
  await q(`UPDATE "order".return_requests SET shop_respond_due_at = now() - interval '1 hour' WHERE id = $1`, [a.id]);
  await q(`UPDATE "order".return_requests SET ship_back_due_at = now() - interval '1 hour' WHERE id = $1`, [b.id]);
  await q(`UPDATE "order".return_requests SET shop_receive_due_at = now() - interval '1 hour' WHERE id = $1`, [c.id]);
  await q(`UPDATE "order".return_requests SET shop_respond_due_at = now() + interval '10 hours' WHERE id = $1`, [d.id]);
  const t0 = new Date();
  const j = L.runJob('return-sla');
  const rows = await q(`SELECT id, status, escalate_source FROM "order".return_requests WHERE id = ANY($1)`, [[a.id, b.id, c.id, d.id]]);
  const by = (id) => rows.find((r) => r.id === id);
  check('RET-04', 'shop quá hạn duyệt ⇒ escalated(shop_timeout)', by(a.id).status === 'escalated' && by(a.id).escalate_source === 'shop_timeout', by(a.id));
  check('RET-05', 'khách quá hạn gửi trả ⇒ expired', by(b.id).status === 'expired', by(b.id));
  check('RET-06', 'shop quá hạn xác nhận nhận ⇒ escalated(shop_receive_timeout)', by(c.id).status === 'escalated' && by(c.id).escalate_source === 'shop_receive_timeout', by(c.id));
  const remind = (await L.notifs('nhaxinh@ecofashion.vn', t0)).filter((n) => /sắp hết hạn|còn.*giờ|nhắc/i.test(n.title));
  const remind2 = L.runJob('return-sla');
  const remindAfter = (await L.notifs('nhaxinh@ecofashion.vn', t0)).filter((n) => /sắp hết hạn|còn.*giờ|nhắc/i.test(n.title));
  check('RET-SLA-4', 'còn < 24h hạn duyệt ⇒ nhắc shop đúng 1 lần (chạy job 2 lần)', remind.length === 1 && remindAfter.length === 1, { remind: remind.length, after: remindAfter.length, job: j.ok && remind2.ok });
  const csTitles = (await L.notifs('sales@ecofashion.vn', t0)).filter((n) => /phân xử/i.test(n.title));
  check('RET-SLA-5', 'CSKH được báo khi yêu cầu chuyển sàn (≥ 2 ca)', csTitles.length >= 2, { n: csTitles.length });
}

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
  // từ chối ngay ⇒ failed; kế toán chuyển tay + mã ⇒ done, KHÔNG gọi PayOS lại
  const r = await newRefund('REJ');
  await L.mockCtl({ payout: 'reject' });
  const n0 = (await L.mockState()).payouts.length;
  const p1 = await api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'accountant', body: {} });
  const cur = (await refundOf(r.o.code))[0];
  check('REF-03a', 'PayOS từ chối ngay (TK sai) ⇒ failed + gatewayStatus=failed, cho phép chuyển tay', cur.status === 'failed' && cur.gatewayStatus === 'failed', { st: p1.status, cur });
  await L.mockCtl({ payout: 'ok' });
  const ref = 'FT-AUD-' + Date.now();
  const p2 = await api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'accountant', body: { providerRef: ref, note: 'chuyển tay vì PayOS từ chối' } });
  const n1 = (await L.mockState()).payouts.length;
  check('REF-03b', 'ghi sổ tay với mã giao dịch ⇒ done và KHÔNG gửi lệnh PayOS mới', p2.status === 200 && p2.data?.status === 'done' && n1 === n0, { st: p2.status, d: p2.data?.status, n0, n1 });
  const dup = await newRefund('DUP');
  await L.mockCtl({ payout: 'reject' });
  await api('POST', `/admin/refunds/${dup.rf.id}/process`, { as: 'accountant', body: {} });
  await L.mockCtl({ payout: 'ok' });
  const dupRes = await api('POST', `/admin/refunds/${dup.rf.id}/process`, { as: 'accountant', body: { providerRef: ref } });
  check('REF-06', 'mã giao dịch hoàn đã dùng ⇒ 409', dupRes.status === 409, { st: dupRes.status, code: dupRes.code });
  const bad = await api('POST', `/admin/refunds/${dup.rf.id}/process`, { as: 'accountant', body: { providerRef: '??' } });
  check('REF-06b', 'mã giao dịch sai định dạng ⇒ 400', bad.status === 400, { st: bad.status });
  globalThis.dupRefund = dup;
}
{
  // timeout sau khi PayOS đã nhận lệnh (không rõ kết quả)
  const r = await newRefund('TMO');
  await L.mockCtl({ payout: 'drop' });
  const p1 = await api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'accountant', body: {} });
  const cur = (await refundOf(r.o.code))[0];
  check('REF-04a', 'timeout (PayOS đã nhận lệnh nhưng mất kết nối): KHÔNG coi là thất bại chắc chắn — needsReconcile', cur.status === 'failed' && cur.needsReconcile === true && cur.gatewayStatus !== 'failed', { st: p1.status, cur });
  await L.mockCtl({ payout: 'ok' });
  const manualWhileUnknown = await api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'accountant', body: { providerRef: 'FT-TMO-' + Date.now() } });
  check('REF-04b', 'đang "không rõ": chuyển tay phải kèm xác nhận (409 PAYMENT_REFUND_RECONCILE_REQUIRED) — tránh chi trùng', manualWhileUnknown.status === 409, { st: manualWhileUnknown.status, code: manualWhileUnknown.code });
  const before = (await L.mockState()).payouts.length;
  const retry = await api('POST', `/admin/refunds/${r.rf.id}/process`, { as: 'accountant', body: { confirmGatewayNotRefunded: true } });
  const after = (await L.mockState()).payouts;
  check('REF-04c', 'chạy lại cùng khoá ⇒ PayOS (idempotent) KHÔNG tạo lệnh thứ hai cho cùng referenceId', after.filter((p) => p.referenceId === r.rf.id).length === 1, { before, after: after.map((p) => p.referenceId), retry: retry.status });
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

L.saveResults(process.env.OUT ?? 'out-t04.json');
const R = L.results;
console.log(`\nTỔNG nhóm 04: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', '));
process.exit(0);
