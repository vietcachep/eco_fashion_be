/* PLAN-0043: HTTP + PostgreSQL thật, chỉ DB audit riêng. Chạy lại được; root dọn toàn bộ container audit. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { Client } = require('pg');
const databaseUrl = process.env.GHN_AUDIT_DATABASE_URL;
if (!databaseUrl) throw new Error('Thiếu GHN_AUDIT_DATABASE_URL (không đọc .env).');
const target = new URL(databaseUrl);
if (target.hostname !== 'localhost' || target.port !== '55443' || target.pathname !== '/fitly_ghn_audit') throw new Error('Từ chối DB ngoài fitly_ghn_audit localhost:55443.');
const BASE = 'http://localhost:4031/api/v1';
const run = `ghn-t12-${Date.now()}`;
const db = new Client({ connectionString: databaseUrl });
await db.connect();
const sql = async (query, values = []) => (await db.query(query, values)).rows;
let passed = 0;
const check = (name, value) => { assert.ok(value, name); passed++; console.log(`PASS ${name}`); };
async function request(method, path, token, body, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (response.status === 429 && attempt < 2) { await new Promise((resolve) => setTimeout(resolve, Math.min(60, Math.max(1, Number(result.error?.details?.retryAfterSeconds) || 2)) * 1000 + 100)); continue; }
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result).slice(0, 700)}`);
    return result.data;
  }
}
async function login(email, password) { if (!password) throw new Error('Thiếu mật khẩu fixture audit qua env.'); return (await request('POST', '/auth/login', null, { email, password })).accessToken; }
async function rejected(name, method, path, token, body, expected, headers = {}) {
  const response = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json();
  check(name, expected.includes(response.status));
  return payload;
}
const pickup = { name: 'Người gửi audit', phone: '0901234567', street: '12 Nguyễn Huệ', provinceName: 'Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Phường Bến Nghé', provinceId: 202, districtId: 1442, wardCode: '20101', addressSystem: 'legacy_3level' };
const address = { recipientName: 'Khách kiểm thử vận chuyển', phone: '0901234567', street: '24 Nguyễn Huệ', provinceName: 'Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Phường Bến Nghé', ghnProvinceId: 202, ghnDistrictId: 1442, ghnWardCode: '20101', addressSystem: 'legacy_3level', isDefault: true };
const ownerEmails = ['bookcafe@ecofashion.vn', 'giadung@ecofashion.vn'];
let customer, admin;
const owners = new Map();
const amount = (money) => BigInt(typeof money === 'object' ? money.amount : money);
async function makeOrder(variants, method = 'cod') {
  await request('DELETE', '/cart', customer);
  for (const variant of variants) await request('POST', '/cart/items', customer, { variantId: variant.id, quantity: 1 });
  const summary = await request('GET', `/checkout/summary?addressId=${addressId}&paymentMethodCode=${method}`, customer);
  const key = randomUUID();
  const input = { addressId, paymentMethodCode: method, quoteIds: summary.shopGroups.map((g) => g.shippingQuoteId), expectedTotal: summary.total.amount, note: run };
  const order = await request('POST', '/orders', customer, input, { 'Idempotency-Key': key });
  return { order, input, key, summary };
}
let addressId;
try {
  const email = `${run}@audit.invalid`;
  const fixture = (await sql(`INSERT INTO identity.users (id,email,password_hash,full_name,role_id,status,email_verified_at) SELECT gen_random_uuid(),$1,password_hash,'Khách audit GHN',role_id,'active',now() FROM identity.users WHERE email='khach6@ecofashion.vn' RETURNING id`, [email]))[0];
  assert.ok(fixture, 'Có tài khoản seed để clone hash trong DB audit');
  customer = await login(email, process.env.GHN_AUDIT_CUSTOMER_PASSWORD);
  admin = await login('admin@ecofashion.vn', process.env.GHN_AUDIT_ADMIN_PASSWORD);
  addressId = (await request('POST', '/users/me/addresses', customer, address)).id;
  const variants = [];
  for (const [i, emailOwner] of ownerEmails.entries()) {
    const token = await login(emailOwner, process.env.GHN_AUDIT_VENDOR_PASSWORD);
    const shop = await request('GET', '/shop/me', token);
    const origin = i === 0 ? pickup : { ...pickup, provinceName: 'Hà Nội', districtName: 'Quận Ba Đình', wardName: 'Phường Phúc Xá', provinceId: 201, districtId: 1485, wardCode: '10301' };
    await request('PATCH', '/shop/me', token, { shippingCarrierEnabled: true, shippingPickup: origin, shippingReturn: origin });
    owners.set(shop.id, token);
    const v = (await sql(`SELECT v.id,v.shop_id FROM product.product_variants v JOIN product.products p ON p.id=v.product_id WHERE v.shop_id=$1 AND NOT v.is_deleted AND v.is_active AND p.status='active' AND NOT p.is_deleted AND v.stock-v.reserved>5 ORDER BY coalesce(v.price,p.base_price),v.id LIMIT 1`, [shop.id]))[0];
    assert.ok(v, `Có hàng shop ${shop.id}`); variants.push(v);
  }
  const first = await makeOrder(variants);
  check('SHP-D01 hai shop tách hai đơn carrier_cod', first.order.orders.length === 2 && first.order.orders.every((o) => o.fulfilmentMode === 'carrier' && o.collectionMode === 'carrier_cod'));
  check('SHP-D01 tổng nhóm bằng tổng đơn con', amount(first.order.total) === first.order.orders.reduce((sum, o) => sum + amount(o.total), 0n));
  check('SHP-D01 phí origin khác nhau', new Set(first.summary.shopGroups.map((g) => g.shippingFee.amount)).size === 2);
  const replay = await request('POST', '/orders', customer, first.input, { 'Idempotency-Key': first.key });
  check('SHP-D04 replay sau giỏ đã xoá giữ nhóm', replay.code === first.order.code);
  for (const order of first.order.orders) {
    const owner = owners.get(order.shopId);
    assert.ok(owner, `Có owner cho ${order.code}`);
    await request('PUT', `/shop/orders/${order.code}/status`, owner, { status: 'confirmed' });
    await request('PUT', `/shop/orders/${order.code}/status`, owner, { status: 'packing' });
    const responses = await Promise.all(Array.from({ length: 3 }, () => request('POST', `/shop/orders/${order.code}/ship`, owner)));
    const shipment = await request('POST', `/shop/orders/${order.code}/shipping/reconcile`, owner);
    check(`SHP-D05 ${order.code} concurrent ship một mã`, responses.every((s) => s.id === shipment.id));
    check(`SHP-D10 ${order.code} chờ lấy chưa bàn giao`, shipment.createStatus === 'created' && shipment.status === 'awaiting_pickup' && !shipment.pickedUpAt);
    const label = await request('GET', `/shop/orders/${order.code}/label`, owner);
    check(`SHP-D10 ${order.code} phiếu in đúng mã`, label.internal && label.html.includes(shipment.carrierOrderCode));
    const picked = await request('POST', '/admin/shipping/simulate', admin, { shipmentId: shipment.id, event: 'picked', eventId: `${run}-${order.code}-picked` });
    check(`SHP-D10 ${order.code} picked có mốc bàn giao`, !!picked.pickedUpAt);
    await rejected(`SHP-D08 ${order.code} picked chặn huỷ trực tiếp`, 'POST', `/shop/orders/${order.code}/cancel`, owner, { reasonCode: 'customer_request', note: 'Không được huỷ khi hãng đã lấy kiện' }, [409]);
    const otherOwner = [...owners.entries()].find(([id]) => id !== order.shopId)[1];
    await rejected(`SHP-D22 ${order.code} shop khác không xem vận đơn`, 'GET', `/shop/orders/${order.code}/shipments`, otherOwner, undefined, [404]);
    await rejected(`SHP-D22 ${order.code} vendor không giả lập`, 'POST', '/admin/shipping/simulate', owner, { shipmentId: shipment.id, event: 'delivered' }, [403]);
    await request('POST', '/admin/shipping/simulate', admin, { shipmentId: shipment.id, event: 'delivered', eventId: `${run}-${order.code}-delivered` });
    const delivered = await request('GET', `/orders/${order.code}`, customer);
    check(`SHP-D16 ${order.code} hãng thu chưa tiền về`, delivered.carrierCodStatus === 'collected_pending_remittance' && delivered.paymentStatus !== 'paid');
    const transactionCount = (await sql(`SELECT count(*)::int n FROM payment.shop_cod_wallet_transactions WHERE order_code=$1`, [order.code]))[0].n;
    check(`SHP-D16 ${order.code} không ghi ví cọc`, transactionCount === 0);
    const body = { amount: order.total.amount, reference: `${run}-${order.code}`, note: 'Tiền giả lập trong DB audit' };
    await request('POST', `/admin/shipments/${shipment.id}/confirm-cod-received`, admin, body, { 'Idempotency-Key': randomUUID() });
    await request('POST', `/admin/shipments/${shipment.id}/confirm-cod-received`, admin, body, { 'Idempotency-Key': randomUUID() });
    check(`SHP-D17 ${order.code} xác nhận lặp không lỗi/thu đôi`, (await sql('SELECT cod_remitted_amount FROM payment.payments WHERE order_code=$1', [order.code]))[0].cod_remitted_amount === order.total.amount);
    await rejected(`SHP-D17 ${order.code} đổi ref sau ghi thu bị chặn`, 'POST', `/admin/shipments/${shipment.id}/confirm-cod-received`, admin, { ...body, reference: `${body.reference}-changed` }, [409]);
    await request('POST', `/orders/${order.code}/received`, customer);
    const paid = await request('GET', `/orders/${order.code}`, customer);
    check(`SHP-D16 ${order.code} remitted + complete`, paid.paymentStatus === 'paid' && paid.status === 'completed');
  }
  const cancelled = await makeOrder([variants[0]]);
  const cancelOrder = cancelled.order.orders[0]; const owner = owners.get(cancelOrder.shopId);
  await request('PUT', `/shop/orders/${cancelOrder.code}/status`, owner, { status: 'confirmed' });
  await request('PUT', `/shop/orders/${cancelOrder.code}/status`, owner, { status: 'packing' });
  await request('POST', `/shop/orders/${cancelOrder.code}/ship`, owner);
  await request('POST', `/shop/orders/${cancelOrder.code}/cancel`, owner, { reasonCode: 'customer_request', note: 'Khách audit yêu cầu huỷ trước lấy' });
  const afterCancel = await request('GET', `/orders/${cancelOrder.code}`, customer);
  check('SHP-D08 huỷ trước lấy chốt đơn cancelled', afterCancel.status === 'cancelled');
  const payment = (await sql('SELECT status FROM payment.payments WHERE order_code=$1', [cancelOrder.code]))[0];
  check('SHP-D17 COD chưa thu đóng payment', payment.status === 'cancelled');
  // Chỉ audit DB: lùi thời gian để kiểm escrow, không đổi setting/đồng hồ hệ thống.
  const deliveredCodes = first.order.orders.map((o) => o.code);
  await sql(`UPDATE "order".orders SET delivered_at=now()-interval '8 days',completed_at=now()-interval '8 days' WHERE code=ANY($1::text[])`, [deliveredCodes]);
  for (const order of first.order.orders) {
    const priorPeriod = (await sql('SELECT max(period_end) last FROM payment.shop_payouts WHERE shop_id=$1', [order.shopId]))[0].last;
    const periodStart = priorPeriod ? new Date(new Date(priorPeriod).getTime() + 1) : new Date(Date.now() - 10 * 86400000);
    await request('POST', '/admin/payouts/run', admin, { shopId: order.shopId, periodStart: periodStart.toISOString(), periodEnd: new Date(Date.now() - 100).toISOString() });
    const line = (await sql('SELECT gross,commission FROM payment.shop_payout_lines WHERE order_code=$1 AND kind=$2', [order.code, 'sale']))[0];
    const source = (await sql('SELECT subtotal,shop_discount,shipping_fee,commission_rate_snapshot FROM "order".orders WHERE code=$1', [order.code]))[0];
    check(`SHP-D18 ${order.code} carrier COD vào kỳ sau escrow`, !!line);
    check(`SHP-D19 ${order.code} gross không gồm phí ship`, amount(line.gross) === amount(source.subtotal) - amount(source.shop_discount));
  }
  const online = await makeOrder([variants[0]], 'payos');
  const onlineOrder = online.order.orders[0]; const onlineOwner = owners.get(onlineOrder.shopId);
  const onlinePayment = (await sql(`SELECT p.amount,t.provider_ref FROM payment.payments p JOIN payment.payment_transactions t ON t.payment_id=p.id WHERE p.order_code=$1 AND t.type='create_url' ORDER BY t.created_at DESC LIMIT 1`, [onlineOrder.code]))[0];
  check('SHP-D02 online có link PayOS mock', !!onlineOrder.paymentUrl && !!onlinePayment?.provider_ref);
  const receive = await fetch('http://localhost:4021/_receive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderCode: onlinePayment.provider_ref, amount: Number(onlinePayment.amount), reference: `${run}-online`, webhook: 'send' }) });
  assert.equal(receive.status, 200, 'PayOS mock nhận tiền');
  const onlinePaid = await request('GET', `/orders/${onlineOrder.code}`, customer);
  check('SHP-D02 webhook PayOS mock ghi paid', onlinePaid.paymentStatus === 'paid');
  await request('PUT', `/shop/orders/${onlineOrder.code}/status`, onlineOwner, { status: 'confirmed' });
  await request('PUT', `/shop/orders/${onlineOrder.code}/status`, onlineOwner, { status: 'packing' });
  const onlineShipment = await request('POST', `/shop/orders/${onlineOrder.code}/ship`, onlineOwner);
  check('SHP-D02 online hãng không thu COD', amount(onlineShipment.codAmount) === 0n);
  // Mô phỏng crash T2 bằng DB audit: hãng đã có mã, app mất trạng thái hoàn tất.
  await sql(`UPDATE shipping.shipments SET create_status='unknown',lease_token=NULL,lease_until=NULL,carrier_order_code=NULL WHERE id=$1`, [onlineShipment.id]);
  const recovered = await request('POST', `/shop/orders/${onlineOrder.code}/shipping/reconcile`, onlineOwner);
  check('SHP-D06 đối soát unknown tìm đúng mã cũ', recovered.id === onlineShipment.id && recovered.carrierOrderCode === onlineShipment.carrierOrderCode);
  const count = (await sql('SELECT count(*)::int n FROM shipping.fake_carrier_states WHERE client_order_code=$1', [onlineShipment.clientOrderCode]))[0].n;
  check('SHP-D06 không tạo thêm kiện phía hãng', count === 1);
  for (const event of ['picked', 'delivery_fail', 'returning', 'returned']) await request('POST', '/admin/shipping/simulate', admin, { shipmentId: recovered.id, event, eventId: `${run}-online-${event}` });
  const returned = await request('GET', `/orders/${onlineOrder.code}`, customer);
  check('SHP-D13 online returned huỷ đơn', returned.status === 'cancelled');
  const refunds = await sql('SELECT id,amount,status FROM payment.refunds WHERE order_code=$1', [onlineOrder.code]);
  check('SHP-D20 online trả về tạo đúng một hoàn đủ', refunds.length === 1 && amount(refunds[0].amount) === amount(onlinePayment.amount));
  await request('DELETE', '/cart', customer);
  await request('POST', '/cart/items', customer, { variantId: variants[0].id, quantity: 1 });
  const freshQuote = await request('GET', `/checkout/summary?addressId=${addressId}&paymentMethodCode=cod`, customer);
  const tamperKey = randomUUID();
  const tamperInput = { addressId, paymentMethodCode: 'cod', quoteIds: freshQuote.shopGroups.map((g) => g.shippingQuoteId), expectedTotal: String(amount(freshQuote.total) + 1n), note: `${run}-tamper` };
  await rejected('SHP-D03 expectedTotal sửa 1đ trả409', 'POST', '/orders', customer, tamperInput, [409], { 'Idempotency-Key': tamperKey });
  check('SHP-D03 giá sai không tạo đơn', (await sql('SELECT count(*)::int n FROM "order".orders WHERE customer_note=$1', [tamperInput.note]))[0].n === 0);
  const corrected = await request('POST', '/orders', customer, { ...tamperInput, expectedTotal: freshQuote.total.amount }, { 'Idempotency-Key': tamperKey });
  check('SHP-D03 xác nhận lại giá tạo được đơn', corrected.orders.length === 1);
  const selfOwner = owners.get(variants[0].shop_id);
  const walletBefore = (await sql('SELECT balance FROM payment.shop_cod_wallets WHERE shop_id=$1', [variants[0].shop_id]))[0];
  await sql('UPDATE payment.shop_cod_wallets SET balance=0 WHERE shop_id=$1', [variants[0].shop_id]);
  await request('PATCH', '/shop/me', selfOwner, { shippingCarrierEnabled: false });
  try {
    await request('POST', '/cart/items', customer, { variantId: variants[0].id, quantity: 1 });
    await rejected('SHP-D21 self COD không cọc vẫn bị chặn', 'POST', '/orders', customer, { addressId, paymentMethodCode: 'cod', note: `${run}-self` }, [400, 409]);
  } finally {
    if (walletBefore) await sql('UPDATE payment.shop_cod_wallets SET balance=$2 WHERE shop_id=$1', [variants[0].shop_id, walletBefore.balance]);
    await request('PATCH', '/shop/me', selfOwner, { shippingCarrierEnabled: true });
  }
  const expiring = await request('GET', `/checkout/summary?addressId=${addressId}&paymentMethodCode=cod`, customer);
  const staleQuote = expiring.shopGroups[0].shippingQuoteId;
  await sql(`UPDATE shipping.shipping_quotes SET expires_at=now()-interval '1 minute' WHERE id=$1`, [staleQuote]);
  const refreshedOrder = await request('POST', '/orders', customer, { addressId, paymentMethodCode: 'cod', quoteIds: [staleQuote], expectedTotal: expiring.total.amount, note: `${run}-expired-quote` }, { 'Idempotency-Key': randomUUID() });
  const freshStored = (await sql('SELECT shipping_quote_id FROM "order".orders WHERE code=$1', [refreshedOrder.orders[0].code]))[0];
  check('SHP-D23 quote hết hạn được báo lại, không chốt quote cũ', freshStored.shipping_quote_id !== staleQuote);
  console.log(JSON.stringify({ passed, run, customerEmail: email, orderCodes: first.order.orders.map((o) => o.code), cancelledOrder: cancelOrder.code }));
} finally { await db.end(); }
