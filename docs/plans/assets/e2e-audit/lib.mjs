/* Thư viện kiểm thử end-to-end vòng đời đơn (backend snapshot :4030, DB :55442, PayOS giả :4020). */
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const req = createRequire(process.env.BE_DIR + '/package.json');
const { Client } = req('pg');

export const BASE = 'http://localhost:4030/api/v1';
export const MOCK = 'http://127.0.0.1:4020';
export const CHECKSUM = 'audit-checksum-key-collect';
// Mật khẩu tài khoản mẫu (seed) lấy từ biến môi trường — KHÔNG ghi cứng vào repo. Đặt E2E_PW_<VAI>, vd E2E_PW_ADMIN, E2E_PW_NHANVIEN, E2E_PW_KHACH, E2E_PW_VENDOR
const PW = new Proxy({}, { get: (_, k) => process.env[`E2E_PW_${String(k).toUpperCase()}`] });
const SCR = process.env.SCR;

const ACCOUNTS = {
  admin: ['admin@ecofashion.vn', PW.admin],
  manager: ['manager@ecofashion.vn', PW.nhanvien],
  sales: ['sales@ecofashion.vn', PW.nhanvien],
  accountant: ['accountant@ecofashion.vn', PW.nhanvien],
  marketing: ['marketing@ecofashion.vn', PW.nhanvien],
};
function cred(as) {
  if (ACCOUNTS[as]) return ACCOUNTS[as];
  let m = as.match(/^khach(\d+)$/);
  if (m) return [`khach${m[1]}@ecofashion.vn`, PW.khach];
  m = as.match(/^owner:(.+)$/);
  if (m) return [`${m[1]}@ecofashion.vn`, PW.vendor];
  m = as.match(/^staff:(.+)$/);
  if (m) return [`nv.${m[1]}@ecofashion.vn`, PW.vendor];
  throw new Error('vai không biết: ' + as);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dbc;
export async function db() {
  if (!dbc) {
    const c = new Client({ connectionString: 'postgresql://ecofashion:ecofashion@localhost:55442/ecofashion' });
    c.on('error', () => { if (dbc === c) dbc = null; });
    await c.connect();
    dbc = c;
  }
  return dbc;
}
export async function q(sql, params) {
  return (await (await db()).query(sql, params)).rows;
}
export async function q1(sql, params) {
  return (await q(sql, params))[0];
}

export function resetRateLimit() {
  try {
    execSync(`docker exec fitly-audit-redis sh -c "redis-cli --scan --pattern 'ef:rl:*' | xargs -r redis-cli del; redis-cli --scan --pattern 'ef:identity:login-fail:*' | xargs -r redis-cli del"`, { stdio: 'ignore' });
  } catch { /* bỏ qua */ }
}

const tokens = {};
export async function login(as) {
  if (tokens[as]) return tokens[as];
  const [email, password] = cred(as);
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ email, password }) });
    if (r.status === 429) { resetRateLimit(); continue; }
    const j = await r.json().catch(() => null);
    if (!j?.data?.accessToken) throw new Error(`Đăng nhập lỗi ${as}: ${r.status} ${JSON.stringify(j)?.slice(0, 200)}`);
    return (tokens[as] = j.data.accessToken);
  }
  throw new Error('rate limit đăng nhập: ' + as);
}
export function dropToken(as) { delete tokens[as]; }

/* api(method, path, { as, body, headers }) → { status, data, error, code, raw } */
let trackSeq = 0;
export async function api(method, path, { as, body, headers } = {}) {
  // PLAN-0040 3.6: chuyển `shipping` BẮT BUỘC có hãng + mã vận đơn. Mọi bài harness chuyển shipping qua đây được tự bổ sung hãng + mã DUY NHẤT
  // (trùng mã trong cùng shop bật cờ SHP-13). Bài cố ý kiểm trường hợp thiếu: truyền `__noAuto: true` trong body (cờ bị gỡ trước khi gửi).
  if (body && typeof body === 'object' && body.__noAuto) { const { __noAuto, ...rest } = body; body = rest; }
  else if (method === 'PUT' && /^\/(shop|admin)\/orders\/[^/]+\/status$/.test(path) && body?.status === 'shipping' && body.carrier === undefined && body.trackingCode === undefined) {
    body = { ...body, carrier: 'ghn', trackingCode: `GHN${Date.now().toString(36).toUpperCase()}${(trackSeq++).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}` };
  }
  const h = { 'content-type': 'application/json', connection: 'close', ...(headers ?? {}) };
  if (as) h.authorization = `Bearer ${await login(as)}`;
  const go = async () => {
    for (let i = 0; i < 3; i++) {
      try { return await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); } catch (e) { if (i === 2) throw e; await sleep(300); }
    }
  };
  let r = await go();
  if (r.status === 429) { resetRateLimit(); await sleep(300); r = await go(); }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* không JSON */ }
  return { status: r.status, data: j?.data, error: j?.error, code: j?.error?.code ?? j?.errorCode, message: j?.message ?? j?.error?.message, raw: j ?? text };
}

/* ---------- PayOS giả ---------- */
async function mfetch(path, init) {
  for (let i = 0; i < 4; i++) {
    try { return await fetch(MOCK + path, { ...init, headers: { connection: 'close' } }); } catch (e) { if (i === 3) throw e; await sleep(200); }
  }
}
export async function mockCtl(patch) {
  return (await mfetch('/_ctl', { method: 'POST', body: JSON.stringify(patch) })).json();
}
export async function mockReset() { await mfetch('/_reset', { method: 'POST', body: '{}' }); }
export async function mockPay(orderCode, amount) {
  return (await mfetch('/_pay', { method: 'POST', body: JSON.stringify({ orderCode, amount }) })).json();
}
export async function mockState() { return (await mfetch('/_state')).json(); }
export async function mockLog() { return (await mfetch('/_log')).json(); }
export async function mockPayoutState(by, state) {
  return (await mfetch('/_payout_state', { method: 'POST', body: JSON.stringify({ ...by, state }) })).json();
}
export async function mockBalance(balance) { return (await mfetch('/_balance', { method: 'POST', body: JSON.stringify({ balance }) })).json(); }

/* Webhook PayOS "đã thanh toán" ký đúng checksum. opts.payer = { bin, number, name } mô phỏng TK người trả. */
export async function sendWebhook(payosOrderCode, amount, opts = {}) {
  const data = {
    orderCode: Number(payosOrderCode),
    amount: Number(amount),
    description: opts.description ?? 'AUDIT',
    accountNumber: '12345678',
    reference: opts.reference ?? `AUD${Date.now()}${Math.floor(Math.random() * 1000)}`,
    transactionDateTime: new Date().toISOString().replace('T', ' ').slice(0, 19),
    currency: 'VND',
    paymentLinkId: `pl-${payosOrderCode}`,
    code: '00',
    desc: 'Thành công',
    counterAccountBankId: opts.payer?.bin ?? '',
    counterAccountBankName: opts.payer?.bankName ?? '',
    counterAccountName: opts.payer?.name ?? '',
    counterAccountNumber: opts.payer?.number ?? '',
    virtualAccountName: '',
    virtualAccountNumber: '',
  };
  const canonical = Object.keys(data).sort().map((k) => `${k}=${data[k] ?? ''}`).join('&');
  const signature = opts.badSignature ? 'deadbeef' : createHmac('sha256', CHECKSUM).update(canonical, 'utf8').digest('hex');
  const r = await fetch(`${BASE}/payments/payos/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ code: '00', desc: 'success', success: true, data, signature }) });
  return { status: r.status, body: await r.text() };
}

/* ---------- chạy job nền ngay ---------- */
export function runJob(name, arg) {
  try {
    const out = execSync(`node "${SCR}/jobs.cjs" ${name} ${arg ?? ''}`, { cwd: process.env.BE_DIR, encoding: 'utf8', env: process.env, timeout: 120000 });
    const line = out.trim().split('\n').pop();
    return JSON.parse(line);
  } catch (e) {
    return { ok: false, error: String(e.stdout ?? e.message).slice(-300) };
  }
}

/* ---------- kết quả ---------- */
export const results = [];
let currentGroup = '';
export function group(name) { currentGroup = name; console.log(`\n=== ${name}`); }
export function check(id, label, ok, extra) {
  results.push({ id, group: currentGroup, label, ok: !!ok, extra: ok ? undefined : extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${ok ? '' : '  ← ' + JSON.stringify(extra)?.slice(0, 500)}`);
  return !!ok;
}
export function note(id, label, text) {
  results.push({ id, group: currentGroup, label, ok: null, extra: text });
  console.log(`NOTE  [${id}] ${label}: ${text}`);
}
export function saveResults(file) {
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
}

/* ---------- dữ liệu ---------- */
export const money = (v) => BigInt(typeof v === 'object' && v ? v.amount : v ?? 0);

/* Chọn biến thể bán được (còn tồn ≥ qty) của shop. */
export async function pickVariant({ shopId, qty = 1, minStock = 5, maxPrice = 3_000_000 } = {}) {
  const rows = await q(
    `SELECT v.id, v.stock, v.reserved, COALESCE(v.price, p.base_price) AS price, p.shop_id, p.id AS product_id, p.name
       FROM product.product_variants v JOIN product.products p ON p.id = v.product_id
      WHERE v.is_deleted = false AND v.is_active = true AND p.is_deleted = false AND p.status = 'active'
        AND (v.stock - v.reserved) >= $1 AND ($2::uuid IS NULL OR p.shop_id = $2)
        AND COALESCE(v.price, p.base_price) <= $3
      ORDER BY (v.stock - v.reserved) DESC, v.id LIMIT 40`,
    [Math.max(qty, minStock), shopId ?? null, maxPrice],
  );
  return rows;
}
export async function shopBySlug(slug) {
  return q1(`SELECT s.id, s.code, s.name, s.status, s.commission_rate FROM shop.shops s WHERE s.id = (SELECT m.shop_id FROM shop.shop_members m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 AND m.status='active' LIMIT 1)`, [`${slug}@ecofashion.vn`]);
}

export const ADDRESS = { recipientName: 'Nguyễn Kiểm Thử', phone: '0909000111', provinceName: 'TP. Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Phường Bến Nghé', street: '12 Nguyễn Huệ' };

/*
 * Đặt hàng thật qua giỏ: xoá giỏ → thêm các biến thể → tick → POST /orders.
 * items: [{ variantId, qty }]. Trả { group, orders:[{code, shopId, total, paymentMethod}], status, raw }.
 */
export async function placeOrder({ as, items, method = 'cod', voucherCodes, note, idempotencyKey, address = ADDRESS }) {
  await api('DELETE', '/cart', { as });
  for (const it of items) {
    const r = await api('POST', '/cart/items', { as, body: { variantId: it.variantId, quantity: it.qty ?? 1 } });
    if (r.status >= 400) return { status: r.status, error: r, stage: 'cart' };
  }
  const body = { paymentMethodCode: method, address, ...(voucherCodes ? { voucherCodes } : {}), ...(note ? { note } : {}) };
  const r = await api('POST', '/orders', { as, body, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined });
  return { status: r.status, raw: r, data: r.data, code: r.code };
}

/* Các đơn con của một nhóm trả về từ POST /orders → [{code,...}] */
export function childOrders(placed) {
  const d = placed.data;
  const arr = d?.orders ?? d?.items ?? [];
  return arr;
}

export async function orderRow(code) {
  return q1(`SELECT id, code, status, payment_status, payment_method_code, shop_id, user_id, total, subtotal, shipping_fee, discount, platform_discount, shop_discount, commission_rate_snapshot, item_count, delivered_at, completed_at, shipped_at, cancel_reason, payment_expires_at, created_at FROM "order".orders WHERE code = $1`, [code]);
}
export async function paymentRows(code) {
  return q(`SELECT id, status, method_code, amount, transaction_code, refunded_amount, received_amount, link_attempts, last_link_error, expires_at, paid_at, created_at FROM payment.payments WHERE order_code = $1 ORDER BY created_at`, [code]);
}
export async function refundRows(code) {
  return q(`SELECT id, status, method, kind, amount, provider_ref, return_request_id, reason, gateway_status, needs_manual, payee_source, created_at FROM payment.refunds WHERE order_code = $1 ORDER BY created_at`, [code]);
}
export async function stock(variantId) {
  return q1(`SELECT stock, reserved FROM product.product_variants WHERE id = $1`, [variantId]);
}
export async function notifs(userEmail, since) {
  return q(`SELECT n.title, n.link, n.created_at FROM system.notifications n JOIN identity.users u ON u.id = n.user_id WHERE u.email = $1 AND n.created_at >= $2 ORDER BY n.created_at`, [userEmail, since ?? new Date(0)]);
}
export async function payosCodeOf(orderCode) {
  const r = await q1(`SELECT t.raw_request->>'payosOrderCode' AS code FROM payment.payment_transactions t JOIN payment.payments p ON p.id = t.payment_id WHERE p.order_code = $1 AND t.type = 'create_url' ORDER BY t.created_at DESC LIMIT 1`, [orderCode]);
  return r?.code;
}
export async function ownerEmailOf(shopId) {
  const r = await q1(`SELECT u.email FROM shop.shop_members m JOIN identity.users u ON u.id = m.user_id JOIN identity.roles ro ON ro.id = m.role_id WHERE m.shop_id = $1 AND m.status = 'active' AND ro.code = 'shop_owner' LIMIT 1`, [shopId]);
  return r?.email;
}
export async function setSetting(key, value) {
  await q(`INSERT INTO system.settings (key, value, group_code, description, is_public) VALUES ($1, $2::jsonb, 'audit', 'audit override', false) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
  try { execSync(`docker exec fitly-audit-redis sh -c "redis-cli --scan --pattern 'ef:system:*' | xargs -r redis-cli del"`, { stdio: 'ignore' }); } catch { /* bỏ qua */ }
}
export async function getSetting(key) {
  const r = await q1(`SELECT value FROM system.settings WHERE key = $1`, [key]);
  return r?.value;
}
export function clearCaches() {
  try { execSync(`docker exec fitly-audit-redis sh -c "redis-cli --scan --pattern 'ef:*' | grep -v ef:rl | xargs -r redis-cli del"`, { stdio: 'ignore' }); } catch { /* bỏ qua */ }
}
export const nowMinus = (ms) => new Date(Date.now() - ms);
