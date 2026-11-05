/*
 * PLAN-0041 WP-5 — harness Postgres THẬT cho "nạp cọc COD qua PayOS": bảng §6.6 WTP-01…WTP-32 (đặc tả §9.2–9.3, bất biến §10).
 * Mọi tiền đi qua PayOS GIẢ (mock-payos.mjs: /_receive, /_transfers, /_link_status, /_confirm). /_transfers là NGUỒN SỰ THẬT
 * ĐỘC LẬP về tiền PayOS nhận: WTP-32 đối chiếu tổng ví với nó, không đi qua code của hệ thống.
 * KHÔNG mạng ngoài; KHÔNG ghi thẳng shop_cod_wallets.balance (chỉnh ví bằng API adjust). SQL chỉ ĐỔI THỜI GIAN của khoản nạp
 * (expires_at, last_checked_at) để kích hoạt job, và đóng khoản mở của bài khi dọn dẹp.
 * Chạy: sau reset-env.sh, biến môi trường như run-all.sh (SCR, BE_DIR, E2E_PW_*). Tuỳ chọn:
 *   CONC_ROUNDS (WTP-08/28, mặc định 4) · CONC_COD_ROUNDS (WTP-29, mặc định 6) · OUT (file kết quả, mặc định out-t11.json).
 * Dòng cuối in: TỔNG nhóm 11: x/y PASS (run-all.sh gom dòng này).
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';

process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.stack ?? e); process.exit(3); });
process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e?.stack ?? e); });

const { check, group, note, api, q, q1, sleep } = L;
const DIR = process.env.SCR ?? path.dirname(fileURLToPath(import.meta.url));
const FLAG = 'wallet.payos_deposit_enabled';
const RUN = Date.now().toString(36);
let seq = 0;
const ref = (tag) => `${tag}-${RUN}-${seq++}`; // mã giao dịch duy nhất trong bài (khoá biên nhận theo khoản)
const num = (v) => Number(v ?? 0);
const X = 1_000_000;
const CONC_ROUNDS = Number(process.env.CONC_ROUNDS ?? 4);
const COD_ROUNDS = Number(process.env.CONC_COD_ROUNDS ?? 6);
// Shop xoay vòng cho các bài đồng thời; mỗi shop chỉ một khoản mở tại một thời điểm (chốt ở DB).
const POOL = ['beautybox', 'mobilehub', 'sportplanet', 'sneaker', 'techzone', 'ngonviet'];
const STAFF = ['accountant@ecofashion.vn', 'admin@ecofashion.vn']; // người có supplier.wallet.approve nhận cảnh báo
const owner = (slug) => `owner:${slug}`;
const ownerMail = (slug) => `${slug}@ecofashion.vn`;

let MIN_DEP = 500000;
let MAX_TOP = 50000000;
let MIN_COD = 200000;
let RUN_START = null;
let DRIFT0 = new Map();
let PREV_FLAG;
let SUSPENDED = null;

const bad = (extra) => ({ ok: false, extra });

/* ---------- DB ---------- */
const TOPUP_COLS = 'id, shop_id, amount, payos_order_code, status, received_amount, polled_amount, expires_at, paid_at, closed_at, checkout_url, link_error, last_checked_at';
const topupRow = (id) => q1(`SELECT ${TOPUP_COLS} FROM payment.shop_cod_topups WHERE id = $1`, [id]);
const openRow = (shopId) => q1(`SELECT ${TOPUP_COLS} FROM payment.shop_cod_topups WHERE shop_id = $1 AND status IN ('creating','pending','partial') ORDER BY created_at DESC LIMIT 1`, [shopId]);
const receiptsOf = (id) => q(`SELECT reference, amount FROM payment.shop_cod_topup_receipts WHERE topup_id = $1 ORDER BY created_at, id`, [id]);
const ledgerOf = (id) => q(`SELECT type, amount, balance_after, ref_key, shop_id FROM payment.shop_cod_wallet_transactions WHERE topup_id = $1 ORDER BY created_at, id`, [id]);
async function ledgerSumTopup(id) {
  const r = await q1(`SELECT COALESCE(SUM(amount), 0) AS s FROM payment.shop_cod_wallet_transactions WHERE topup_id = $1 AND type = 'topup_payos'`, [id]);
  return num(r?.s);
}
async function walletBal(shopId) {
  const r = await q1(`SELECT balance FROM payment.shop_cod_wallets WHERE shop_id = $1`, [shopId]);
  return num(r?.balance);
}
async function driftOf(shopId) {
  const r = await q1(`SELECT COALESCE(SUM(amount), 0) AS s FROM payment.shop_cod_wallet_transactions WHERE shop_id = $1`, [shopId]);
  return (await walletBal(shopId)) - num(r?.s);
}
// Lệch "ví − Σ sổ cái" của mọi ví; bài t03 ghi thẳng balance nên lệch đầu bài khác 0 — bất biến là lệch KHÔNG ĐỔI.
async function driftAll() {
  const rows = await q(`SELECT w.shop_id, w.balance - COALESCE(s.total, 0) AS drift FROM payment.shop_cod_wallets w LEFT JOIN (SELECT shop_id, SUM(amount) AS total FROM payment.shop_cod_wallet_transactions GROUP BY shop_id) s ON s.shop_id = w.shop_id`);
  return new Map(rows.map((r) => [r.shop_id, num(r.drift)]));
}
async function deadlocks() {
  // Bộ đếm của Postgres cập nhật trễ: chờ trước khi đọc (mẫu plan §9.2).
  await sleep(1500);
  return num((await q1(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`))?.deadlocks);
}
async function dbNow() {
  return (await q1(`SELECT now() AS t`)).t;
}
const sidCache = {};
async function sid(slug) {
  if (!sidCache[slug]) {
    const s = await L.shopBySlug(slug);
    if (!s) throw new Error(`không có gian hàng ${slug}`);
    sidCache[slug] = s.id;
  }
  return sidCache[slug];
}
// Đóng mọi khoản mở (null = toàn bộ). Chỉ dùng để dọn dẹp giữa các bài; không đụng số dư ví.
async function closeOpen(shopIds) {
  const set = `status = 'cancelled', closed_at = COALESCE(closed_at, now()), version = version + 1`;
  if (shopIds === null) return q(`UPDATE payment.shop_cod_topups SET ${set} WHERE status IN ('creating','pending','partial')`);
  return q(`UPDATE payment.shop_cod_topups SET ${set} WHERE shop_id = ANY($1::uuid[]) AND status IN ('creating','pending','partial')`, [shopIds]);
}
async function setFlag(v) { await L.setSetting(FLAG, v); }

/* ---------- API ---------- */
async function createTopup(slug, amount) {
  // Giới hạn tạo link 10/10 phút/người: api() tự xoá rate-limit và thử lại khi gặp 429 (không xoá trước mỗi lần — tốn docker exec).
  return api('POST', '/shop/wallet/topups', { as: owner(slug), body: { amount: String(amount) } });
}
const cancelTopup = (slug, id) => api('POST', `/shop/wallet/topups/${id}/cancel`, { as: owner(slug) });
const getTopup = (slug, id) => api('GET', `/shop/wallet/topups/${id}`, { as: owner(slug) });
const myWallet = (slug) => api('GET', '/shop/wallet', { as: owner(slug) });
const setStatus = (slug, code, status) => api('PUT', `/shop/orders/${code}/status`, { as: owner(slug), body: { status } });

/* ---------- PayOS giả + webhook ---------- */
async function mock(p, { method = 'GET', body, retry = true } = {}) {
  const tries = retry ? 4 : 1;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(L.MOCK + p, { method, headers: { 'content-type': 'application/json', connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      try { return JSON.parse(text); } catch { return { raw: text, httpStatus: r.status }; }
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(200);
    }
  }
  return null;
}
// Khoản tiền PayOS nhận: ghi vào sổ giả; webhook 'send' (mặc định) gửi ký đúng như PayOS thật; 'skip' = mất webhook.
const receive = (code, amount, o = {}) => mock('/_receive', { method: 'POST', retry: false, body: { orderCode: String(code), amount, reference: o.reference, webhook: o.webhook ?? 'send' } });
const transfersAll = async () => {
  const r = await mock('/_transfers');
  return Array.isArray(r) ? r : [];
};
const linkStatus = (code, body) => mock('/_link_status', { method: 'POST', body: { orderCode: String(code), ...body } });
// Webhook ký gửi trực tiếp (không đi qua sổ giả): dùng để gửi LẠI đúng khoản đã có, hoặc gửi sai chữ ký.
const hook = (code, amount, reference) => L.sendWebhook(code, amount, { reference });
const hookSig = (code, amount) => L.sendWebhook(code, amount, { badSignature: true });
async function mockCount(method, prefix) {
  const logs = await L.mockLog();
  return (Array.isArray(logs) ? logs : []).filter((x) => x.m === method && String(x.p).startsWith(prefix)).length;
}
// Chạy job NỀN bất đồng bộ (execFile) để nó đua với request khác; jobs.cjs in JSON ở dòng cuối.
function runJobAsync(name) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(DIR, 'jobs.cjs'), name], { cwd: process.env.BE_DIR, env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const line = String(stdout ?? '').trim().split('\n').pop() ?? '';
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: String(stderr || err?.message || line).slice(-300) }); }
    });
  });
}
// Ép job dò PayOS đọc lại khoản này ngay (CAS last_checked_at không cho hỏi trùng trong 60 giây).
async function pollNow(id) {
  await q(`UPDATE payment.shop_cod_topups SET last_checked_at = NULL WHERE id = $1`, [id]);
  return runJobAsync('topup-reconcile');
}

/* ---------- thông báo ---------- */
// Lý do cảnh báo kế toán (§7.1): payload.reason, hoặc đoán theo tiêu đề nếu payload thiếu.
function reasonOf(r) {
  if (r.payload?.reason) return r.payload.reason;
  const t = r.title ?? '';
  if (/trả thừa/i.test(t)) return 'overpaid';
  if (/chuyển thêm/i.test(t)) return 'duplicate';
  if (/muộn/i.test(t)) return 'late';
  if (/kết thúc thiếu/i.test(t)) return 'partial_closed';
  if (/bất thường/i.test(t)) return 'invalid';
  return '?';
}
async function notesFor(topupId, since, slug) {
  await sleep(300); // thông báo ghi sau commit, best-effort: chờ một nhịp trước khi đọc
  const rows = await q(`SELECT u.email, n.title, n.payload FROM system.notifications n JOIN identity.users u ON u.id = n.user_id WHERE n.created_at >= $2 AND (n.payload->>'topupId' = $1 OR n.title ILIKE 'Nạp cọc%') ORDER BY n.created_at`, [topupId, since]);
  const mine = rows.filter((r) => (r.payload?.topupId ? r.payload.topupId === topupId : true));
  const alerts = mine
    .filter((r) => STAFF.includes(r.email) && (r.payload?.topupId === topupId || /^Nạp cọc PayOS/i.test(r.title ?? '')))
    .map((r) => ({ email: r.email, title: r.title, reason: reasonOf(r) }));
  const ownerRows = mine
    .filter((r) => r.email === ownerMail(slug) && (r.payload?.topupId === topupId || /PayOS thành công/i.test(r.title ?? '')))
    .map((r) => ({ title: r.title }));
  return { alerts, owner: ownerRows };
}

/* ---------- khung bài ---------- */
// Chạy một bài: lỗi ngoại lệ thành FAIL (không dừng cả harness), rồi đóng khoản mở của shop bài dùng.
async function runCase(id, label, slugs, fn) {
  let res;
  try {
    res = await fn();
  } catch (e) {
    res = bad({ exception: String(e?.message ?? e), stack: String(e?.stack ?? '').split('\n').slice(0, 4).join(' | ') });
  }
  check(id, label, res?.ok === true, res?.extra ?? {});
  try {
    await closeOpen(await Promise.all(slugs.map((s) => sid(s))));
  } catch (e) {
    note(id, 'dọn khoản mở lỗi', String(e?.message ?? e));
  }
}

/* ===================================================================== WTP-01…07: ghi có cơ bản */
async function c01() {
  const slug = 'techzone';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code, msg: c.message });
  const id = c.data.id;
  const code = c.data.payosOrderCode;
  const rc = await receive(code, X, { reference: ref('W01') });
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const recs = await receiptsOf(id);
  const led = await ledgerOf(id);
  const w = await myWallet(slug);
  const n = await notesFor(id, since, slug);
  const codOk = bal1 < MIN_COD || w.data?.codEnabled === true;
  const ok = rc.webhookStatus === 200 && row?.status === 'paid' && num(row.received_amount) === X && bal1 - bal0 === X
    && recs.length === 1 && led.length === 1 && led[0].type === 'topup_payos' && led[0].ref_key === `payos-topup:${id}:${X}`
    && n.owner.length >= 1 && n.alerts.length === 0 && codOk;
  return { ok, extra: { webhook: rc.webhookStatus, status: row?.status, received: row?.received_amount, walletDelta: bal1 - bal0, receipts: recs.length, ledger: led, ownerNotified: n.owner.length, alerts: n.alerts, codEnabled: w.data?.codEnabled, balance: bal1 } };
}

async function c02() {
  const slug = 'mobilehub';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const rc = await receive(c.data.payosOrderCode, 400_000, { reference: ref('W02') });
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const g = await getTopup(slug, id);
  const n = await notesFor(id, since, slug);
  const ok = rc.webhookStatus === 200 && row?.status === 'partial' && num(row.received_amount) === 400_000 && bal1 - bal0 === 400_000
    && g.status === 200 && !!g.data?.checkoutUrl && n.alerts.length === 0;
  return { ok, extra: { webhook: rc.webhookStatus, status: row?.status, walletDelta: bal1 - bal0, getStatus: g.status, checkoutUrl: !!g.data?.checkoutUrl, alerts: n.alerts } };
}

async function c03() {
  const slug = 'sportplanet';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const code = c.data.payosOrderCode;
  const r1 = await receive(code, 400_000, { reference: ref('W03a') });
  const mid = await topupRow(id);
  const r2 = await receive(code, 600_000, { reference: ref('W03b') });
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const recs = await receiptsOf(id);
  const led = await ledgerOf(id);
  const keys = led.map((x) => x.ref_key);
  const n = await notesFor(id, since, slug);
  const ok = r1.webhookStatus === 200 && r2.webhookStatus === 200 && mid?.status === 'partial' && row?.status === 'paid' && num(row.received_amount) === X
    && recs.length === 2 && led.length === 2 && keys.includes(`payos-topup:${id}:400000`) && keys.includes(`payos-topup:${id}:${X}`)
    && led.reduce((s, x) => s + num(x.amount), 0) === X && bal1 - bal0 === X && n.alerts.length === 0;
  return { ok, extra: { mid: mid?.status, final: row?.status, received: row?.received_amount, receipts: recs.length, ledger: led, walletDelta: bal1 - bal0, alerts: n.alerts } };
}

async function c04() {
  const slug = 'beautybox';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const rc = await receive(c.data.payosOrderCode, 1_200_000, { reference: ref('W04') });
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const n = await notesFor(id, since, slug);
  const ok = rc.webhookStatus === 200 && row?.status === 'paid' && num(row.received_amount) === 1_200_000 && bal1 - bal0 === 1_200_000
    && n.alerts.some((a) => a.reason === 'overpaid') && n.owner.length >= 1;
  return { ok, extra: { webhook: rc.webhookStatus, status: row?.status, received: row?.received_amount, walletDelta: bal1 - bal0, alerts: n.alerts, ownerNotified: n.owner.length } };
}

async function c05() {
  const slug = 'sneaker';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const code = c.data.payosOrderCode;
  const R = ref('W05');
  const rc = await receive(code, 300_000, { reference: R });
  const h1 = await hook(code, 300_000, R);
  const h2 = await hook(code, 300_000, R);
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const recs = await receiptsOf(id);
  const led = await ledgerOf(id);
  const n = await notesFor(id, since, slug);
  const ok = rc.webhookStatus === 200 && h1.status === 200 && h2.status === 200 && row?.status === 'partial'
    && recs.length === 1 && led.length === 1 && bal1 - bal0 === 300_000 && n.alerts.length === 0;
  return { ok, extra: { webhook: rc.webhookStatus, replay: [h1.status, h2.status], status: row?.status, receipts: recs.length, ledger: led.length, walletDelta: bal1 - bal0, alerts: n.alerts } };
}

async function c06() {
  const slug = 'ngonviet';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, 800_000);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const code = c.data.payosOrderCode;
  const RR = ref('W06');
  await receive(code, 800_000, { reference: RR, webhook: 'skip' }); // tiền đã vào PayOS; ba webhook cùng mã đến đồng thời
  const hs = await Promise.all([hook(code, 800_000, RR), hook(code, 800_000, RR), hook(code, 800_000, RR)]);
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const recs = await receiptsOf(id);
  const led = await ledgerOf(id);
  const n = await notesFor(id, since, slug);
  const ok = hs.every((h) => h.status === 200) && row?.status === 'paid' && recs.length === 1 && led.length === 1 && bal1 - bal0 === 800_000 && n.alerts.length === 0;
  return { ok, extra: { webhooks: hs.map((h) => h.status), status: row?.status, receipts: recs.length, ledger: led.length, walletDelta: bal1 - bal0, alerts: n.alerts } };
}

async function c07() {
  const slug = 'techzone';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const code = c.data.payosOrderCode;
  const r1 = await receive(code, X, { reference: ref('W07a') });
  const r2 = await receive(code, 200_000, { reference: ref('W07b') });
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const led = await ledgerOf(id);
  const n = await notesFor(id, since, slug);
  const ok = r1.webhookStatus === 200 && r2.webhookStatus === 200 && row?.status === 'paid' && num(row.received_amount) === 1_200_000
    && led.length === 2 && bal1 - bal0 === 1_200_000 && n.alerts.some((a) => a.reason === 'duplicate');
  return { ok, extra: { webhooks: [r1.webhookStatus, r2.webhookStatus], status: row?.status, received: row?.received_amount, ledger: led.length, walletDelta: bal1 - bal0, alerts: n.alerts } };
}

/* ===================================================================== WTP-08 / WTP-28: đồng thời */
async function c08() {
  const dl0 = await deadlocks();
  const rounds = [];
  for (let i = 0; i < CONC_ROUNDS; i++) {
    const slug = POOL[i % POOL.length];
    const shopId = await sid(slug);
    const bal0 = await walletBal(shopId);
    const c = await createTopup(slug, X);
    if (c.status !== 201) { rounds.push({ i, slug, ok: false, create: c.status, code: c.code }); continue; }
    const id = c.data.id;
    const code = c.data.payosOrderCode;
    const R1 = ref('W08a');
    const R2 = ref('W08b');
    await receive(code, 400_000, { reference: R1, webhook: 'skip' });
    await receive(code, 300_000, { reference: R2, webhook: 'skip' });
    const [h1, h2] = await Promise.all([hook(code, 400_000, R1), hook(code, 300_000, R2)]);
    const row = await topupRow(id);
    const recs = await receiptsOf(id);
    const led = await ledgerOf(id);
    const bal1 = await walletBal(shopId);
    const r = { i, slug, webhooks: [h1.status, h2.status], status: row?.status, received: num(row?.received_amount), receipts: recs.length, ledger: led.length, walletDelta: bal1 - bal0 };
    r.ok = h1.status === 200 && h2.status === 200 && r.status === 'partial' && r.received === 700_000 && r.receipts === 2 && r.ledger === 2 && r.walletDelta === 700_000;
    rounds.push(r);
    await closeOpen([shopId]);
  }
  const dl1 = await deadlocks();
  return { ok: rounds.length === CONC_ROUNDS && rounds.every((r) => r.ok) && dl1 - dl0 === 0, extra: { deadlocks: [dl0, dl1], rounds } };
}

async function c28() {
  const dl0 = await deadlocks();
  const rounds = [];
  for (let i = 0; i < CONC_ROUNDS; i++) {
    const slug = POOL[(i + 2) % POOL.length];
    const shopId = await sid(slug);
    const bal0 = await walletBal(shopId);
    const c = await createTopup(slug, X);
    if (c.status !== 201) { rounds.push({ i, slug, ok: false, create: c.status, code: c.code }); continue; }
    const id = c.data.id;
    const code = c.data.payosOrderCode;
    // Ba khoản tiền về ĐỒNG THỜI ∥ job dò PayOS ∥ 5 lần GET làm mới (mỗi GET có thể hỏi PayOS).
    const [m1, m2, m3, job, ...gs] = await Promise.all([
      receive(code, 300_000, { reference: ref('W28a') }),
      receive(code, 300_000, { reference: ref('W28b') }),
      receive(code, 400_000, { reference: ref('W28c') }),
      runJobAsync('topup-reconcile'),
      ...Array.from({ length: 5 }, () => getTopup(slug, id)),
    ]);
    const row = await topupRow(id);
    const recs = await receiptsOf(id);
    const ledger = await ledgerSumTopup(id);
    const bal1 = await walletBal(shopId);
    const tr = (await transfersAll()).filter((x) => x.orderCode === code).reduce((s, x) => s + num(x.amount), 0);
    const r = {
      i, slug, webhooks: [m1.webhookStatus, m2.webhookStatus, m3.webhookStatus], job: job.ok === true, gets: gs.map((g) => g.status),
      status: row?.status, received: num(row?.received_amount), ledger, transfers: tr, walletDelta: bal1 - bal0, receipts: recs.length,
    };
    r.ok = r.webhooks.every((s) => s === 200) && r.job && r.gets.every((s) => s === 200) && r.status === 'paid'
      && r.received === X && r.ledger === X && r.transfers === X && r.walletDelta === X && r.receipts === 3;
    rounds.push(r);
  }
  const dl1 = await deadlocks();
  return { ok: rounds.length === CONC_ROUNDS && rounds.every((r) => r.ok) && dl1 - dl0 === 0, extra: { deadlocks: [dl0, dl1], rounds } };
}

/* ===================================================================== WTP-09…15: mất webhook, poll, hết hạn, muộn */
async function c09() {
  const slug = 'mobilehub';
  const shopId = await sid(slug);
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const R = ref('W09');
  const rc = await receive(c.data.payosOrderCode, 400_000, { reference: R, webhook: 'skip' }); // mất webhook
  const j1 = await pollNow(id);
  const row1 = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const led1 = await ledgerOf(id);
  const recs1 = await receiptsOf(id);
  const j2 = await pollNow(id);
  const row2 = await topupRow(id);
  const bal2 = await walletBal(shopId);
  const led2 = await ledgerOf(id);
  const ok = rc.webhookStatus === null && j1.ok === true && row1?.status === 'partial' && num(row1.received_amount) === 400_000
    && bal1 - bal0 === 400_000 && led1.length === 1 && led1[0].ref_key === `payos-topup:${id}:400000` && recs1.length === 0
    && j2.ok === true && bal2 === bal1 && led2.length === 1 && num(row2?.received_amount) === 400_000;
  return { ok, extra: { job1: j1, job2: j2, status: row1?.status, received: row1?.received_amount, walletDelta: [bal1 - bal0, bal2 - bal1], ledger: led2.length, receipts: recs1.length } };
}

async function c10() {
  const slug = 'sportplanet';
  const shopId = await sid(slug);
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const rc = await receive(c.data.payosOrderCode, 400_000, { reference: ref('W10') }); // webhook tới TRƯỚC
  const j = await pollNow(id); // poll sau, cùng luỹ kế
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const led = await ledgerOf(id);
  const recs = await receiptsOf(id);
  const ok = rc.webhookStatus === 200 && j.ok === true && num(row?.received_amount) === 400_000 && bal1 - bal0 === 400_000 && led.length === 1 && recs.length === 1;
  return { ok, extra: { webhook: rc.webhookStatus, job: j, received: row?.received_amount, polled: row?.polled_amount, walletDelta: bal1 - bal0, ledger: led.length, receipts: recs.length } };
}

async function c11() {
  const slug = 'beautybox';
  const shopId = await sid(slug);
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const R = ref('W11');
  await receive(c.data.payosOrderCode, 400_000, { reference: R, webhook: 'skip' }); // PayOS đã có tiền, webhook chưa về
  const j = await pollNow(id); // poll tới trước: ghi có theo luỹ kế
  const mid = await ledgerOf(id);
  const hk = await hook(c.data.payosOrderCode, 400_000, R); // webhook của CÙNG khoản về sau
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const led = await ledgerOf(id);
  const recs = await receiptsOf(id);
  const ok = j.ok === true && mid.length === 1 && hk.status === 200 && led.length === 1 && bal1 - bal0 === 400_000
    && recs.length === 1 && num(row?.received_amount) === 400_000;
  return { ok, extra: { job: j, webhook: hk.status, ledgerAfterPoll: mid.length, ledger: led.length, walletDelta: bal1 - bal0, receipts: recs.length, received: row?.received_amount } };
}

async function c12() {
  const slug = 'sneaker';
  const shopId = await sid(slug);
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const rc = await receive(c.data.payosOrderCode, 400_000, { reference: ref('W12') });
  const ls = await linkStatus(c.data.payosOrderCode, { amountPaid: 100_000 }); // PayOS báo luỹ kế THẤP hơn số đã ghi có
  const j = await pollNow(id);
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const led = await ledgerOf(id);
  const ok = rc.webhookStatus === 200 && ls.amountPaid === 100_000 && j.ok === true && row?.status === 'partial' && num(row.received_amount) === 400_000
    && bal1 - bal0 === 400_000 && led.length === 1;
  return { ok, extra: { webhook: rc.webhookStatus, linkStatus: ls.amountPaid, job: j, status: row?.status, received: row?.received_amount, polled: row?.polled_amount, walletDelta: bal1 - bal0, ledger: led.length } };
}

async function c13() {
  const slug = 'ngonviet';
  const shopId = await sid(slug);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  await q(`UPDATE payment.shop_cod_topups SET expires_at = now() - interval '3 hours' WHERE id = $1`, [id]); // dịch thời gian: link đã hết hạn, không có tiền
  const j = await runJobAsync('topup-reconcile');
  const row = await topupRow(id);
  const c2 = await createTopup(slug, X);
  const ok = j.ok === true && row?.status === 'expired' && row.closed_at !== null && num(row.received_amount) === 0
    && c2.status === 201 && c2.data?.reused === false && c2.data?.id !== id;
  return { ok, extra: { job: j, status: row?.status, closedAt: row?.closed_at, received: row?.received_amount, newTopup: c2.status, reused: c2.data?.reused, newId: c2.data?.id } };
}

async function c14() {
  const slug = 'techzone';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  await q(`UPDATE payment.shop_cod_topups SET expires_at = now() - interval '3 hours' WHERE id = $1`, [id]);
  const j = await runJobAsync('topup-reconcile');
  const row0 = await topupRow(id);
  const r1 = await receive(c.data.payosOrderCode, 400_000, { reference: ref('W14a') }); // tiền về sau khi link đã đóng
  const row1 = await topupRow(id);
  const r2 = await receive(c.data.payosOrderCode, 600_000, { reference: ref('W14b') }); // đủ X ⇒ paid
  const row2 = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const n = await notesFor(id, since, slug);
  const ok = j.ok === true && row0?.status === 'expired' && r1.webhookStatus === 200 && row1?.status === 'expired' && num(row1.received_amount) === 400_000
    && r2.webhookStatus === 200 && row2?.status === 'paid' && num(row2.received_amount) === X && bal1 - bal0 === X && n.alerts.some((a) => a.reason === 'late');
  return { ok, extra: { job: j, after1: row1?.status, after2: row2?.status, received: row2?.received_amount, walletDelta: bal1 - bal0, alerts: n.alerts } };
}

async function c15() {
  const slug = 'mobilehub';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const rc = await receive(c.data.payosOrderCode, 300_000, { reference: ref('W15') });
  await q(`UPDATE payment.shop_cod_topups SET expires_at = now() - interval '3 hours' WHERE id = $1`, [id]); // hết hạn khi mới trả một phần
  const j1 = await runJobAsync('topup-reconcile');
  const row1 = await topupRow(id);
  const n1 = await notesFor(id, since, slug);
  const j2 = await pollNow(id); // chạy lại: không được báo "kết thúc thiếu" lần hai
  const n2 = await notesFor(id, since, slug);
  const row2 = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const closedAll2 = n2.alerts.filter((a) => a.reason === 'partial_closed');
  const closedAll1 = n1.alerts.filter((a) => a.reason === 'partial_closed');
  const perRecipient = (list) => Object.values(list.reduce((m, a) => { m[a.email] = (m[a.email] ?? 0) + 1; return m; }, {}));
  const onceEach = (list) => list.length > 0 && perRecipient(list).every((n) => n === 1);
  const closedCount = closedAll2.length;
  const ok = rc.webhookStatus === 200 && j1.ok === true && row1?.status === 'expired' && num(row1.received_amount) === 300_000 && row1.closed_at !== null
    && onceEach(closedAll1) && closedAll2.length === closedAll1.length && onceEach(closedAll2) && j2.ok === true
    && row2?.status === 'expired' && bal1 - bal0 === 300_000;
  return { ok, extra: { status: row1?.status, received: row1?.received_amount, alertsAfterFirst: n1.alerts, alertsAfterSecond: closedCount, walletDelta: bal1 - bal0, job2: j2.ok } };
}

/* ===================================================================== WTP-16…19: tạo link xen kẽ, lỗi PayOS, cờ, khoá shop */
async function c16() {
  const slug = 'sportplanet';
  const shopId = await sid(slug);
  const bal0 = await walletBal(shopId);
  await L.mockCtl({ delayMs: 4000 }); // PayOS "đã có link" nhưng phản hồi chậm 4 giây
  let pCreate = null;
  try {
    pCreate = createTopup(slug, X);
    let open = null;
    for (let k = 0; k < 40 && !open; k++) {
      await sleep(100);
      open = await q1(`SELECT id, payos_order_code, status FROM payment.shop_cod_topups WHERE shop_id = $1 AND status = 'creating'`, [shopId]);
    }
    if (!open) {
      const cc0 = await pCreate;
      return bad({ why: 'không thấy dòng creating trong 4 giây', create: cc0.status });
    }
    const rc = await receive(open.payos_order_code, 600_000, { reference: ref('W16'), webhook: 'send' }); // webhook đến khi dòng còn creating
    const cc = await pCreate;
    const row = await topupRow(open.id);
    const bal1 = await walletBal(shopId);
    const ok = rc.webhookStatus === 200 && cc.status === 201 && cc.data?.status === 'partial' && row?.status === 'partial'
      && num(row.received_amount) === 600_000 && !!row.checkout_url && bal1 - bal0 === 600_000;
    return { ok, extra: { webhook: rc.webhookStatus, createStatus: cc.status, createdStatus: cc.data?.status, rowStatus: row?.status, received: row?.received_amount, checkoutSaved: !!row?.checkout_url, walletDelta: bal1 - bal0 } };
  } finally {
    await L.mockCtl({ delayMs: 0 });
    if (pCreate) await pCreate.catch(() => null);
  }
}

async function c17() {
  const slug = 'beautybox';
  const shopId = await sid(slug);
  const bal0 = await walletBal(shopId);
  const results = [];
  try {
    for (const mode of ['500', 'fail', 'drop']) {
      await L.mockCtl({ createLink: mode });
      const c = await createTopup(slug, X);
      const last = await q1(`SELECT status FROM payment.shop_cod_topups WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 1`, [shopId]);
      const open = await openRow(shopId);
      results.push({ mode, http: c.status, code: c.code, lastStatus: last?.status, open: !!open });
    }
  } finally {
    await L.mockCtl({ createLink: 'ok' });
  }
  const c2 = await createTopup(slug, X); // PayOS ổn lại ⇒ tạo lại được
  const bal1 = await walletBal(shopId);
  const failedOk = results.every((r) => r.http === 503 && r.code === 'WALLET_TOPUP_LINK_FAILED' && r.lastStatus === 'failed' && r.open === false);
  return { ok: failedOk && c2.status === 201 && bal1 === bal0, extra: { results, retryAfterFix: c2.status, walletDelta: bal1 - bal0 } };
}

async function c18() {
  const slug = 'sneaker';
  const shopId = await sid(slug);
  try {
    await setFlag(false);
    const n0 = await mockCount('POST', '/v2/payment-requests');
    const c = await createTopup(slug, X);
    const n1 = await mockCount('POST', '/v2/payment-requests');
    const w = await myWallet(slug);
    const disabledOk = c.status === 409 && c.code === 'WALLET_TOPUP_DISABLED' && n1 === n0 && w.data?.payosTopup?.enabled === false;
    await setFlag(true);
    const c2 = await createTopup(slug, X); // link đang chờ được tạo khi cờ còn bật
    await setFlag(false); // tắt cờ khi link còn chờ: tiền về vẫn phải được ghi có
    const bal0 = await walletBal(shopId);
    const rc = await receive(c2.data?.payosOrderCode, 400_000, { reference: ref('W18') });
    const row = await topupRow(c2.data?.id);
    const bal1 = await walletBal(shopId);
    return {
      ok: disabledOk && c2.status === 201 && rc.webhookStatus === 200 && row?.status === 'partial' && bal1 - bal0 === 400_000,
      extra: { disabled: c.status, code: c.code, payCallsAdded: n1 - n0, payosEnabledFlag: w.data?.payosTopup?.enabled, makeWhileOn: c2.status, webhook: rc.webhookStatus, status: row?.status, walletDelta: bal1 - bal0 },
    };
  } finally {
    await setFlag(true);
  }
}

async function c19() {
  const slug = 'ngonviet';
  const shopId = await sid(slug);
  const since = await dbNow();
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const code = c.data.payosOrderCode;
  const sus = await api('PATCH', `/admin/shops/${shopId}/suspend`, { as: 'admin', body: { reason: 'E2E WTP-19: khoá tạm khi đang nạp' } });
  if (sus.status !== 200) return bad({ suspend: sus.status, code: sus.code, msg: sus.message });
  SUSPENDED = shopId;
  const c2 = await createTopup(slug, X); // shop bị khoá: không được tạo link mới
  const rc = await receive(code, 400_000, { reference: ref('W19') }); // tiền về khi shop đang khoá
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const un = await api('PATCH', `/admin/shops/${shopId}/approve`, { as: 'admin' });
  if (un.status === 200) SUSPENDED = null;
  const w = await myWallet(slug);
  const n = await notesFor(id, since, slug);
  const ok = c2.status === 403 && c2.code === 'SHOP_NOT_APPROVED' && rc.webhookStatus === 200 && row?.status === 'partial'
    && bal1 - bal0 === 400_000 && un.status === 200 && num(w.data?.balance) === bal0 + 400_000;
  return { ok, extra: { createWhileSuspended: c2.status, code: c2.code, webhook: rc.webhookStatus, status: row?.status, walletDelta: bal1 - bal0, unsuspend: un.status, balanceAfterUnlock: w.data?.balance, alerts: n.alerts } };
}

/* ===================================================================== WTP-20…23: tạo link: tái dùng, đồng thời, hết hạn, số tiền */
async function c20() {
  const slug = 'techzone';
  const c1 = await createTopup(slug, X);
  if (c1.status !== 201) return bad({ create: c1.status, code: c1.code });
  const n0 = await mockCount('POST', '/v2/payment-requests');
  const c2 = await createTopup(slug, 2 * X); // số tiền khác vẫn trả link cũ
  const n1 = await mockCount('POST', '/v2/payment-requests');
  const ok = c2.status === 201 && c2.data?.reused === true && c2.data?.id === c1.data.id && !!c1.data.checkoutUrl
    && c2.data?.checkoutUrl === c1.data.checkoutUrl && n1 === n0;
  return { ok, extra: { first: c1.data?.id, second: c2.data?.id, reused: c2.data?.reused, payCallsAdded: n1 - n0, status2: c2.status } };
}

async function c21() {
  const slug = 'mobilehub';
  const shopId = await sid(slug);
  const [a, b] = await Promise.all([createTopup(slug, X), createTopup(slug, X)]);
  const open = await q(`SELECT id, status FROM payment.shop_cod_topups WHERE shop_id = $1 AND status IN ('creating','pending','partial')`, [shopId]);
  const okStatus = (r) => r.status === 201 || (r.status === 409 && r.code === 'WALLET_TOPUP_IN_PROGRESS');
  const sameId = a.status === 201 && b.status === 201 ? a.data.id === b.data.id : true;
  const ok = okStatus(a) && okStatus(b) && open.length === 1 && (a.status === 201 || b.status === 201) && sameId;
  return { ok, extra: { a: [a.status, a.code, a.data?.id, a.data?.reused], b: [b.status, b.code, b.data?.id, b.data?.reused], openRows: open.length } };
}

async function c22() {
  const slug = 'sportplanet';
  const c1 = await createTopup(slug, X);
  if (c1.status !== 201) return bad({ create: c1.status, code: c1.code });
  const id1 = c1.data.id;
  await q(`UPDATE payment.shop_cod_topups SET expires_at = now() - interval '1 hour' WHERE id = $1`, [id1]); // link cũ quá hạn, chưa quét
  const c2 = await createTopup(slug, X);
  const row1 = await topupRow(id1);
  const ok = c2.status === 201 && c2.data?.reused === false && c2.data?.id !== id1 && row1?.status === 'expired' && row1.closed_at !== null;
  return { ok, extra: { oldStatus: row1?.status, newCreate: c2.status, reused: c2.data?.reused, newId: c2.data?.id } };
}

async function c23() {
  const slug = 'beautybox';
  const bads = [
    [String(MIN_DEP - 1), 'WALLET_DEPOSIT_TOO_SMALL'],
    [String(MAX_TOP + 1), 'WALLET_TOPUP_TOO_LARGE'],
    ['0', 'COMMON_VALIDATION_ERROR'],
    ['-5', 'COMMON_VALIDATION_ERROR'],
    ['1.5', 'COMMON_VALIDATION_ERROR'],
    ['abc', 'COMMON_VALIDATION_ERROR'],
    ['1234567890123456', 'COMMON_VALIDATION_ERROR'],
  ];
  const got = [];
  for (const [amt, want] of bads) {
    L.resetRateLimit();
    const r = await api('POST', '/shop/wallet/topups', { as: owner(slug), body: { amount: amt } });
    got.push({ amt, http: r.status, code: r.code, want, ok: r.status === 400 && r.code === want });
  }
  const cm = await createTopup(slug, MIN_DEP); // đúng biên min ⇒ được
  const okMin = cm.status === 201;
  if (cm.status === 201) await cancelTopup(slug, cm.data.id);
  const cM = await createTopup(slug, MAX_TOP); // đúng biên max ⇒ được
  const okMax = cM.status === 201;
  if (cM.status === 201) await cancelTopup(slug, cM.data.id);
  return { ok: got.every((g) => g.ok) && okMin && okMax, extra: { got, min: [MIN_DEP, cm.status, cm.code], max: [MAX_TOP, cM.status, cM.code] } };
}

/* ===================================================================== WTP-24…27: quyền, huỷ, luồng tay */
async function c24() {
  const slug = 'techzone';
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const s1 = await api('POST', '/shop/wallet/topups', { as: 'staff:techzone', body: { amount: String(X) } });
  const s2 = await api('POST', '/shop/wallet/topups', { as: 'accountant', body: { amount: String(X) } });
  const s3 = await api('GET', `/shop/wallet/topups/${id}`, { as: owner('mobilehub') });
  const s4 = await api('POST', `/shop/wallet/topups/${id}/cancel`, { as: owner('mobilehub') });
  const s5 = await api('GET', '/admin/wallet-topups?page=1&size=5', { as: 'admin' });
  const s6 = await api('GET', '/admin/wallet-topups?page=1&size=5', { as: 'accountant' });
  const s7 = await api('POST', `/admin/wallet-deposits/${id}/approve`, { as: 'accountant' });
  const row = await topupRow(id);
  const ok = s1.status === 403 && s2.status === 403 && s3.status === 404 && s4.status === 404 && s5.status === 200 && s6.status === 200
    && s7.status === 409 && s7.code === 'WALLET_DEPOSIT_PAYOS_NOT_MANUAL' && row?.status === 'pending';
  return { ok, extra: { staffCreate: s1.status, accountantCreate: s2.status, otherOwnerGet: s3.status, otherOwnerCancel: s4.status, adminList: s5.status, accountantList: s6.status, approvePayosId: [s7.status, s7.code], rowStatus: row?.status } };
}

async function c25() {
  const slug = 'mobilehub';
  const shopId = await sid(slug);
  const since = await dbNow();
  // (a) pending → huỷ
  const a = await createTopup(slug, X);
  if (a.status !== 201) return bad({ createA: a.status, code: a.code });
  const ca = await cancelTopup(slug, a.data.id);
  const ra = await topupRow(a.data.id);
  // (b) đã paid → huỷ bị từ chối 409
  const b = await createTopup(slug, X);
  if (b.status !== 201) return bad({ createB: b.status, code: b.code });
  const rb = await receive(b.data.payosOrderCode, X, { reference: ref('W25b') });
  const cb = await cancelTopup(slug, b.data.id);
  const rbRow = await topupRow(b.data.id);
  // (c) đã huỷ → tiền về muộn vẫn ghi có, trạng thái giữ cancelled
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ createC: c.status, code: c.code });
  const cc = await cancelTopup(slug, c.data.id);
  const bal1 = await walletBal(shopId);
  const rcLate = await receive(c.data.payosOrderCode, 300_000, { reference: ref('W25c') });
  const rcRow = await topupRow(c.data.id);
  const bal2 = await walletBal(shopId);
  const n = await notesFor(c.data.id, since, slug);
  const ok = ca.status === 200 && ra?.status === 'cancelled' && rb.webhookStatus === 200 && cb.status === 409
    && cb.code === 'WALLET_TOPUP_INVALID_STATE' && rbRow?.status === 'paid' && cc.status === 200
    && rcLate.webhookStatus === 200 && rcRow?.status === 'cancelled' && num(rcRow.received_amount) === 300_000
    && bal2 - bal1 === 300_000 && n.alerts.some((x) => x.reason === 'late');
  return { ok, extra: { cancelPending: [ca.status, ra?.status], cancelPaid: [cb.status, cb.code], paidRow: rbRow?.status, cancelOk: cc.status, lateWebhook: rcLate.webhookStatus, lateStatus: rcRow?.status, lateReceived: rcRow?.received_amount, walletDelta: bal2 - bal1, alerts: n.alerts } };
}

async function c26() {
  const slug = 'ngonviet';
  const shopId = await sid(slug);
  const bal0 = await walletBal(shopId);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const code = c.data.payosOrderCode;
  const sig = await hookSig(code, X); // chữ ký sai
  const row = await topupRow(id);
  const bal1 = await walletBal(shopId);
  const unk = await L.sendWebhook('5999999999999999', 1000, { reference: ref('W26u') }); // mã dải nạp không có ở DB
  // hồi quy định tuyến: thanh toán ĐƠN HÀNG PayOS vẫn chạy đúng
  const tz = await sid('techzone');
  const v = (await L.pickVariant({ shopId: tz, qty: 2, maxPrice: 1_500_000 }))[0];
  if (!v) return bad({ why: 'không có biến thể của techzone để đặt đơn thử' });
  const p = await L.placeOrder({ as: 'khach33', items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
  if (p.status !== 201) return bad({ place: p.status, code: p.code });
  const kid = L.childOrders(p)[0];
  const pc = await L.payosCodeOf(kid.code);
  const wh = await L.sendWebhook(pc, Number(L.money(kid.total)), { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } });
  const ord = await L.orderRow(kid.code);
  const ok = sig.status === 401 && row?.status === 'pending' && num(row.received_amount) === 0 && bal1 === bal0
    && unk.status === 200 && /ignored/i.test(unk.body ?? '') && wh.status === 200 && ord?.payment_status === 'paid';
  return { ok, extra: { badSignature: sig.status, topupStatus: row?.status, unknownOrder: [unk.status, unk.body?.slice(0, 80)], orderWebhook: wh.status, orderPaymentStatus: ord?.payment_status, orderPayosCode: pc ?? null } };
}

async function c27() {
  const slug = 'beautybox';
  const shopId = await sid(slug);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const w0 = await myWallet(slug);
  if (w0.data?.pendingDeposit) { // dọn yêu cầu chuyển khoản tay còn chờ của bài trước (chỉ dữ liệu thử)
    await api('POST', `/admin/wallet-deposits/${w0.data.pendingDeposit.id}/reject`, { as: 'accountant', body: { reason: 'E2E WTP-27: dọn yêu cầu cũ' } });
  }
  const bal0 = await walletBal(shopId);
  const d = await api('POST', '/shop/wallet/deposit-requests', { as: owner(slug), body: { amount: '600000', transferRef: ref('FT27') } });
  if (d.status !== 201) return bad({ deposit: d.status, code: d.code, msg: d.message });
  const ap = await api('POST', `/admin/wallet-deposits/${d.data.id}/approve`, { as: 'accountant' });
  const bal1 = await walletBal(shopId);
  const row = await topupRow(id);
  const ok = ap.status === 200 && bal1 - bal0 === 600_000 && row?.status === 'pending';
  return { ok, extra: { depositCreate: d.status, approve: ap.status, walletDelta: bal1 - bal0, payosTopupStatus: row?.status } };
}

/* ===================================================================== WTP-29…31: COD ∥ nạp, rollback, E2E */
async function c29() {
  const slug = 'ngonviet';
  const shopId = await sid(slug);
  const dl0 = await deadlocks();
  const drift0 = DRIFT0.get(shopId) ?? 0;
  const rounds = [];
  for (let r = 0; r < COD_ROUNDS; r++) {
    const rr = { i: r };
    try {
      if ((await walletBal(shopId)) < MIN_COD) { // đệm để COD mở
        const c0 = await createTopup(slug, X);
        if (c0.status !== 201) throw new Error(`tạo khoản đệm lỗi ${c0.status} ${c0.code}`);
        const x0 = await receive(c0.data.payosOrderCode, X, { reference: ref('W29p') });
        if (x0.webhookStatus !== 200) throw new Error(`webhook khoản đệm ${x0.webhookStatus}`);
        await closeOpen([shopId]);
      }
      const v = (await L.pickVariant({ shopId, qty: 1, maxPrice: 1_000_000 }))[0];
      if (!v) throw new Error('không có biến thể giá ≤ 1 triệu');
      const p = await L.placeOrder({ as: `khach${30 + r}`, items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
      if (p.status !== 201) throw new Error(`đặt COD lỗi ${p.status} ${p.code}`);
      const kid = L.childOrders(p)[0];
      rr.order = kid.code;
      for (const s of ['confirmed', 'packing', 'shipping']) {
        const st = await setStatus(slug, kid.code, s);
        if (st.status !== 200) throw new Error(`chuyển ${s} lỗi ${st.status} ${st.code}`);
      }
      const c = await createTopup(slug, 500_000);
      if (c.status !== 201) throw new Error(`tạo khoản lỗi ${c.status} ${c.code}`);
      // Nạp tiền ∥ đơn COD chuyển "đã giao" (trừ hoa hồng) — cùng một ví.
      const [rc, put] = await Promise.all([receive(c.data.payosOrderCode, 500_000, { reference: ref('W29') }), setStatus(slug, kid.code, 'delivered')]);
      const row = await topupRow(c.data.id);
      const ord = await L.orderRow(kid.code);
      const comm = await q(`SELECT amount FROM payment.shop_cod_wallet_transactions WHERE shop_id = $1 AND type = 'cod_commission' AND order_code = $2`, [shopId, kid.code]);
      const drift = await driftOf(shopId);
      rr.webhook = rc.webhookStatus;
      rr.put = put.status;
      rr.order_status = ord?.status;
      rr.topup = row?.status;
      rr.commission = comm.length;
      rr.driftDelta = drift - drift0;
      rr.ok = rc.webhookStatus === 200 && put.status === 200 && row?.status === 'paid' && (ord?.status === 'delivered' || ord?.status === 'completed')
        && comm.length >= 1 && drift === drift0;
    } catch (e) {
      rr.error = String(e?.message ?? e);
      rr.ok = false;
    }
    rounds.push(rr);
    await closeOpen([shopId]);
  }
  const dl1 = await deadlocks();
  return { ok: rounds.length === COD_ROUNDS && rounds.every((x) => x.ok) && dl1 - dl0 === 0, extra: { deadlocks: [dl0, dl1], rounds } };
}

async function c30() {
  const slug = 'beautybox';
  const shopId = await sid(slug);
  const c = await createTopup(slug, X);
  if (c.status !== 201) return bad({ create: c.status, code: c.code });
  const id = c.data.id;
  const code = c.data.payosOrderCode;
  const bal0 = await walletBal(shopId);
  const R = ref('W30');
  let failStatus = null;
  let mid = null;
  try {
    // Trigger giả lỗi GIỮA transaction: cập nhật dòng nạp với received = 777777 ⇒ RAISE sau khi đã ghi biên nhận + sổ + ví.
    await q(`DROP TRIGGER IF EXISTS t11_fail_topup ON payment.shop_cod_topups`);
    await q(`CREATE OR REPLACE FUNCTION payment.t11_fail_topup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.received_amount = 777777 THEN RAISE EXCEPTION 't11: lỗi giả lập giữa chừng (WTP-30)'; END IF; RETURN NEW; END $$`);
    await q(`CREATE TRIGGER t11_fail_topup BEFORE UPDATE ON payment.shop_cod_topups FOR EACH ROW EXECUTE FUNCTION payment.t11_fail_topup()`);
    const rc = await receive(code, 777_777, { reference: R, webhook: 'send' });
    failStatus = rc.webhookStatus;
    const row = await topupRow(id);
    const recs = await receiptsOf(id);
    const led = await ledgerOf(id);
    const bal1 = await walletBal(shopId);
    mid = { status: row?.status, received: num(row?.received_amount), receipts: recs.length, ledger: led.length, walletDelta: bal1 - bal0 };
  } finally {
    await q(`DROP TRIGGER IF EXISTS t11_fail_topup ON payment.shop_cod_topups`);
    await q(`DROP FUNCTION IF EXISTS payment.t11_fail_topup()`);
  }
  const rs1 = await hook(code, 777_777, R); // PayOS gửi lại đúng webhook: trigger đã gỡ
  const row2 = await topupRow(id);
  const bal2 = await walletBal(shopId);
  const led2 = await ledgerOf(id);
  const rs2 = await hook(code, 777_777, R); // gửi lần nữa: không cộng thêm
  const bal3 = await walletBal(shopId);
  const led3 = await ledgerOf(id);
  const ok = failStatus === 500 && mid?.status === 'pending' && mid.received === 0 && mid.receipts === 0 && mid.ledger === 0 && mid.walletDelta === 0
    && rs1.status === 200 && bal2 - bal0 === 777_777 && num(row2?.received_amount) === 777_777 && led2.length === 1
    && rs2.status === 200 && bal3 === bal2 && led3.length === 1;
  return { ok, extra: { failWebhook: failStatus, midState: mid, resend: rs1.status, afterResend: { status: row2?.status, received: row2?.received_amount, walletDelta: bal2 - bal0, ledger: led2.length }, resend2: rs2.status, walletAfterResend2: bal3 - bal2, ledger2: led3.length } };
}

async function c31() {
  const slug = 'ngonviet';
  const shopId = await sid(slug);
  const t0 = await dbNow();
  const bal0 = await walletBal(shopId);
  const steps = {};
  // (1) ví về 0 (chỉnh tay qua API adjust, không SQL): COD đóng ⇒ đặt đơn COD bị 409
  if (bal0 !== 0) {
    const a = await api('POST', `/admin/shops/${shopId}/wallet/adjust`, { as: 'admin', body: { amount: String(-bal0), note: 'E2E WTP-31: đưa ví về 0 để thử COD đóng' } });
    steps.adjust = a.status;
    if (a.status !== 200) return bad({ adjust: a.status, code: a.code, msg: a.message });
  }
  const balAfterAdjust = await walletBal(shopId);
  const w0 = await myWallet(slug);
  const v = (await L.pickVariant({ shopId, qty: 1, maxPrice: 1_000_000 }))[0];
  if (!v) return bad({ why: 'không có biến thể giá ≤ 1 triệu' });
  const codClosed = await L.placeOrder({ as: 'khach31', items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
  steps.codClosed = { codEnabled: w0.data?.codEnabled, placeStatus: codClosed.status, code: codClosed.code };
  // (2) chủ shop tạo link 600.000 ₫
  const c = await createTopup(slug, 600_000);
  if (c.status !== 201) return bad({ create: c.status, code: c.code, msg: c.message, steps });
  const id = c.data.id;
  steps.link = { status: c.status, checkoutIsPayos: /\/pay\//.test(c.data.checkoutUrl ?? '') };
  // (3) người trả bấm "Chuyển khoản thành công" trên trang PayOS giả ⇒ webhook thật
  const conf = await fetch(`${L.MOCK}/_confirm/${c.data.payosOrderCode}`, { method: 'POST' }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  steps.confirmWebhook = conf.webhook;
  // (4) chờ tối đa 10 giây: khoản thành paid, số dư tăng, COD mở
  let row = null;
  for (let k = 0; k < 20; k++) {
    const g = await getTopup(slug, id);
    row = g.data;
    if (row?.status === 'paid') break;
    await sleep(500);
  }
  const w1 = await myWallet(slug);
  const bal1 = await walletBal(shopId);
  const n = await notesFor(id, t0, slug);
  // (5) khách đặt COD ⇒ shop giao ⇒ hoa hồng trừ
  const cod2 = await L.placeOrder({ as: 'khach32', items: [{ variantId: v.id, qty: 1 }], method: 'cod' });
  if (cod2.status !== 201) return bad({ steps, codAfterTopup: cod2.status, code: cod2.code, msg: cod2.raw?.message });
  const kid = L.childOrders(cod2)[0];
  for (const s of ['confirmed', 'packing', 'shipping', 'delivered']) {
    const st = await setStatus(slug, kid.code, s);
    steps[`st_${s}`] = st.status;
  }
  const comm = await q(`SELECT amount FROM payment.shop_cod_wallet_transactions WHERE shop_id = $1 AND type = 'cod_commission' AND order_code = $2`, [shopId, kid.code]);
  const bal2 = await walletBal(shopId);
  const led = await q(`SELECT amount, balance_after FROM payment.shop_cod_wallet_transactions WHERE shop_id = $1 AND created_at >= $2 ORDER BY created_at, id`, [shopId, t0]);
  let prev = bal0;
  let chainOk = true;
  for (const x of led) {
    if (num(x.balance_after) !== prev + num(x.amount)) chainOk = false;
    prev = num(x.balance_after);
  }
  chainOk = chainOk && prev === bal2;
  const ok = c.status === 201 && steps.link.checkoutIsPayos && conf.webhook === 200 && row?.status === 'paid'
    && w1.status === 200 && num(w1.data?.balance) === balAfterAdjust + 600_000 && w1.data?.codEnabled === true
    && codClosed.status === 409 && codClosed.code === 'ORDER_COD_NOT_AVAILABLE'
    && comm.length >= 1 && num(comm[0].amount) < 0 && chainOk
    && n.owner.length >= 1 && n.alerts.length === 0;
  return { ok, extra: { steps, topupStatus: row?.status, balanceAfterTopup: w1.data?.balance, codEnabledAfterTopup: w1.data?.codEnabled, commissions: comm.map((x) => x.amount), chainOk, ledgerRows: led.length, ownerNotified: n.owner.length, alerts: n.alerts, walletAfter: bal2 } };
}

/* ===================================================================== WTP-32: bất biến cuối bài (§10) */
async function c32() {
  const inv = {
    I1: `SELECT t.id FROM payment.shop_cod_topups t WHERE t.received_amount <> COALESCE((SELECT SUM(l.amount) FROM payment.shop_cod_wallet_transactions l WHERE l.topup_id = t.id AND l.type = 'topup_payos'), 0)`,
    I2: `SELECT t.id FROM payment.shop_cod_topups t WHERE t.received_amount < GREATEST(COALESCE((SELECT SUM(r.amount) FROM payment.shop_cod_topup_receipts r WHERE r.topup_id = t.id), 0), t.polled_amount)`,
    I3: `SELECT ref_key FROM payment.shop_cod_wallet_transactions WHERE ref_key IS NOT NULL GROUP BY ref_key HAVING count(*) > 1`,
    I5: `SELECT id FROM payment.shop_cod_wallet_transactions WHERE type = 'topup_payos' AND (amount <= 0 OR topup_id IS NULL OR ref_key IS NULL)`,
    I6: `SELECT id, status FROM payment.shop_cod_topups WHERE (status = 'paid') <> (received_amount >= amount) OR (status IN ('creating', 'pending') AND received_amount > 0) OR (status = 'partial' AND NOT (received_amount > 0 AND received_amount < amount))`,
    I7: `SELECT shop_id, count(*) FROM payment.shop_cod_topups WHERE status IN ('creating', 'pending', 'partial') GROUP BY shop_id HAVING count(*) > 1`,
    I8: `SELECT id FROM payment.shop_cod_topups WHERE (status IN ('expired', 'cancelled', 'failed') AND closed_at IS NULL) OR payos_order_code !~ '^[5-8][0-9]{15}$'`,
    I9: `SELECT t.id FROM payment.shop_cod_topups t WHERE (SELECT COALESCE(SUM(r.amount), 0) FROM payment.shop_cod_topup_receipts r WHERE r.topup_id = t.id) > t.received_amount`,
  };
  const violations = {};
  for (const [k, s] of Object.entries(inv)) violations[k] = (await q(s)).length;
  // I4: lệch "ví − Σ sổ cái" của mọi ví KHÔNG đổi so với đầu bài
  const now = await driftAll();
  const driftBad = [];
  for (const [shop, d] of now) {
    if (d !== (DRIFT0.get(shop) ?? 0)) driftBad.push({ shop, before: DRIFT0.get(shop) ?? 0, now: d });
  }
  violations.I4 = driftBad.length;
  // TỔNG: Σ ví ghi có từ PayOS = Σ tiền PayOS giả nhận (/_transfers), theo từng mã và cả bài
  const topups = await q(`SELECT id, payos_order_code, received_amount FROM payment.shop_cod_topups WHERE created_at >= $1`, [RUN_START]);
  const codes = new Set(topups.map((t) => t.payos_order_code));
  const tr = await transfersAll();
  const perCode = new Map();
  for (const x of tr) perCode.set(x.orderCode, (perCode.get(x.orderCode) ?? 0) + num(x.amount));
  const stray = tr.filter((x) => !codes.has(x.orderCode)).length;
  const mismatch = topups.filter((t) => num(t.received_amount) !== (perCode.get(t.payos_order_code) ?? 0));
  const ids = topups.map((t) => t.id);
  const walletSum = ids.length === 0 ? 0 : num((await q1(`SELECT COALESCE(SUM(amount), 0) AS s FROM payment.shop_cod_wallet_transactions WHERE type = 'topup_payos' AND topup_id = ANY($1::uuid[])`, [ids]))?.s);
  const payosSum = tr.reduce((s, x) => s + num(x.amount), 0);
  const dl = await deadlocks();
  note('WTP-32/dl', 'bộ đếm deadlock Postgres (cộng dồn từ khi DB khởi động) sau bài', String(dl));
  const allZero = Object.values(violations).every((v) => v === 0);
  const ok = allZero && stray === 0 && mismatch.length === 0 && walletSum === payosSum && payosSum > 0;
  return { ok, extra: { violations, driftBad, topups: topups.length, transfers: tr.length, stray, mismatch: mismatch.map((t) => [t.payos_order_code, t.received_amount, perCode.get(t.payos_order_code) ?? 0]), walletSum, payosSum } };
}

/* ===================================================================== bảng bài */
const CASES = [
  { g: 'WTP-01…07 — ghi có cơ bản (đủ, thiếu, thiếu rồi nốt, thừa, replay, trùng đồng thời, trùng sau paid)', id: 'WTP-01', label: 'Trả đủ một lần: paid; ví +X; 1 biên nhận; 1 dòng sổ topup_payos (topup_id, ref_key); COD mở; chủ shop được báo, kế toán không', slugs: ['techzone'], fn: c01 },
  { id: 'WTP-02', label: 'Trả thiếu: partial; ví +a; link còn sống (checkoutUrl); kế toán không bị báo', slugs: ['mobilehub'], fn: c02 },
  { id: 'WTP-03', label: 'Thiếu rồi trả nốt (2 reference): paid; ví +(a1+a2); 2 dòng sổ với ref_key theo luỹ kế', slugs: ['sportplanet'], fn: c03 },
  { id: 'WTP-04', label: 'Trả thừa (X + 200k): paid; ví +toàn bộ thực nhận; kế toán được báo "trả thừa" (overpaid)', slugs: ['beautybox'], fn: c04 },
  { id: 'WTP-05', label: 'Replay tuần tự cùng reference: 200; không thêm biên nhận/dòng sổ; ví không đổi', slugs: ['sneaker'], fn: c05 },
  { id: 'WTP-06', label: '3 webhook CÙNG reference đồng thời: cả 3 200; đúng 1 biên nhận + 1 dòng sổ; ví +X một lần', slugs: ['ngonviet'], fn: c06 },
  { id: 'WTP-07', label: 'Trả lần 2 sau khi paid (reference khác): ví +số lần 2; vẫn paid; kế toán được báo "chuyển thêm lần nữa" (duplicate)', slugs: ['techzone'], fn: c07 },
  { g: 'WTP-08 / WTP-28 — đồng thời (deadlock đo bằng pg_stat_database)', id: 'WTP-08', label: '2 webhook khác reference đồng thời (CONC_ROUNDS vòng): cả hai cộng đúng; ví đúng tổng; 0 deadlock', slugs: POOL, fn: c08 },
  { g: 'WTP-09…15 — mất webhook, poll, hết hạn, tiền về muộn', id: 'WTP-09', label: 'Mất webhook: job dò ghi có theo luỹ kế PayOS; chạy lại job không cộng thêm', slugs: ['mobilehub'], fn: c09 },
  { id: 'WTP-10', label: 'Webhook tới trước, poll báo luỹ kế cùng khoản: không cộng đôi', slugs: ['sportplanet'], fn: c10 },
  { id: 'WTP-11', label: 'Poll tới trước, webhook cùng khoản về sau: không cộng đôi; biên nhận vẫn được ghi', slugs: ['beautybox'], fn: c11 },
  { id: 'WTP-12', label: 'Poll báo luỹ kế THẤP hơn đã ghi có: ví không đổi; không 5xx', slugs: ['sneaker'], fn: c12 },
  { id: 'WTP-13', label: 'Link hết hạn không có tiền: expired + closed_at; tạo link mới được; khoản cũ không còn mở', slugs: ['ngonviet'], fn: c13 },
  { id: 'WTP-14', label: 'Tiền về muộn vào khoản expired: ghi có đúng số; paid khi đủ X, ngược lại giữ expired; báo "tiền về muộn" (late)', slugs: ['techzone'], fn: c14 },
  { id: 'WTP-15', label: 'Hết hạn khi mới trả một phần: expired kèm received > 0; ví giữ phần đã nhận; báo "kết thúc thiếu" đúng MỘT lần', slugs: ['mobilehub'], fn: c15 },
  { g: 'WTP-16…19 — tạo link xen kẽ, lỗi PayOS, cờ, khoá shop', id: 'WTP-16', label: 'Webhook đến khi dòng còn creating (PayOS trễ 4 giây): ghi có; markLinkCreated KHÔNG ghi đè partial; URL được lưu', slugs: ['sportplanet'], fn: c16 },
  { id: 'WTP-17', label: 'PayOS lỗi khi tạo link (500 / mã lỗi / đứt kết nối): 503 WALLET_TOPUP_LINK_FAILED; dòng failed; không khoản mở; ví không đổi; tạo lại được', slugs: ['beautybox'], fn: c17 },
  { id: 'WTP-18', label: 'Cờ tắt: 409 WALLET_TOPUP_DISABLED và không gọi PayOS; payosTopup.enabled=false; cờ tắt khi link đang chờ vẫn ghi có', slugs: ['sneaker'], fn: c18 },
  { id: 'WTP-19', label: 'Shop bị khoá khi đang nạp: tạo link mới 403 SHOP_NOT_APPROVED; tiền về vẫn ghi có; mở khoá: ví đúng', slugs: ['ngonviet'], fn: c19 },
  { g: 'WTP-20…23 — tái dùng link, đồng thời, hết hạn, số tiền', id: 'WTP-20', label: 'Tạo lần hai khi còn link hạn (kể cả số tiền khác): trả đúng link cũ (reused:true), không gọi PayOS lần nữa', slugs: ['techzone'], fn: c20 },
  { id: 'WTP-21', label: 'Hai request tạo link ĐỒNG THỜI: đúng 1 dòng mở; không 5xx (một bên reused hoặc 409 WALLET_TOPUP_IN_PROGRESS)', slugs: ['mobilehub'], fn: c21 },
  { id: 'WTP-22', label: 'Link cũ quá hạn chưa quét + tạo mới: link cũ bị đóng expired; link mới được tạo', slugs: ['sportplanet'], fn: c22 },
  { id: 'WTP-23', label: 'Số tiền: < min ⇒ 400 WALLET_DEPOSIT_TOO_SMALL; > max ⇒ 400 WALLET_TOPUP_TOO_LARGE; sai định dạng ⇒ 400 COMMON_VALIDATION_ERROR; đúng biên min/max ⇒ được', slugs: ['beautybox'], fn: c23 },
  { g: 'WTP-24…27 — quyền, huỷ, luồng nạp tay', id: 'WTP-24', label: 'Quyền: staff 403; kế toán gọi /shop 403; chủ shop khác 404; admin/kế toán list 200; approve id PayOS ⇒ 409 WALLET_DEPOSIT_PAYOS_NOT_MANUAL', slugs: ['techzone'], fn: c24 },
  { id: 'WTP-25', label: 'Huỷ: pending ⇒ cancelled; paid ⇒ 409 WALLET_TOPUP_INVALID_STATE; sau huỷ, tiền về vẫn ghi có (muộn) và giữ cancelled', slugs: ['mobilehub'], fn: c25 },
  { id: 'WTP-26', label: 'Chữ ký sai ⇒ 401 và không ghi gì; mã dải nạp lạ ⇒ 200 "Ignored: unknown order"; thanh toán ĐƠN PayOS vẫn chạy đúng', slugs: ['ngonviet'], fn: c26 },
  { id: 'WTP-27', label: 'Luồng nạp tay (deposit-requests + approve) vẫn đúng khi đang có link PayOS mở; hai luồng độc lập', slugs: ['beautybox'], fn: c27 },
  { g: 'WTP-28…32 — đồng thời với COD, rollback, E2E, bất biến', id: 'WTP-28', label: 'Đa luồng: 3 webhook (khác reference) ∥ job dò ∥ 5 GET làm mới (CONC_ROUNDS vòng): tổng ví = Σ PayOS nhận; 0 deadlock; không 5xx', slugs: POOL, fn: c28 },
  { id: 'WTP-29', label: 'Webhook nạp ∥ đơn COD chuyển "đã giao" trên cùng ví (CONC_COD_ROUNDS vòng): hoa hồng trừ; lệch ví − Σ sổ không đổi; 0 deadlock', slugs: ['ngonviet'], fn: c29 },
  { id: 'WTP-30', label: 'Rollback: lỗi giữa transaction ⇒ webhook 500, không có biên nhận/sổ/ví/trạng thái nửa chừng; gửi lại đúng ⇒ ghi có đúng một lần', slugs: ['beautybox'], fn: c30 },
  { id: 'WTP-31', label: 'E2E qua API: ví < ngưỡng ⇒ COD 409; tạo link ⇒ trả trên PayOS giả ⇒ ví tăng, COD mở ⇒ đơn COD ⇒ giao ⇒ hoa hồng trừ; sổ khớp; thông báo đúng người', slugs: ['ngonviet'], fn: c31 },
  { id: 'WTP-32', label: 'Bất biến cuối bài: I1–I9 (§10) = 0 vi phạm; ví không lệch đầu bài; Σ ví ghi có PayOS = Σ /_transfers đúng từng mã', slugs: [], fn: c32 },
];

/* ===================================================================== main */
async function main() {
  await L.mockReset();
  L.resetRateLimit();
  RUN_START = await dbNow();
  PREV_FLAG = await L.getSetting(FLAG);
  MIN_DEP = Number((await L.getSetting('wallet.min_deposit')) ?? 500000);
  MAX_TOP = Number((await L.getSetting('wallet.max_topup_amount')) ?? 50000000);
  MIN_COD = Number((await L.getSetting('wallet.min_balance_for_cod')) ?? 200000);
  try {
    await closeOpen(null); // dọn khoản mở còn sót từ lần chạy trước
    await setFlag(true); // bài cần cờ bật để tạo link; trả lại cuối bài
    DRIFT0 = await driftAll();
    let lastGroup = null;
    for (const cs of CASES) {
      if (process.env.ONLY && !process.env.ONLY.split(',').includes(cs.id)) continue; // gỡ lỗi: ONLY=WTP-15,WTP-26
      if (cs.g && cs.g !== lastGroup) {
        group(cs.g);
        lastGroup = cs.g;
      }
      await runCase(cs.id, cs.label, cs.slugs, cs.fn);
    }
  } finally {
    // Dọn dẹp dù bài có lỗi: đóng khoản mở, gỡ trigger, mở khoá shop, trả cờ và cấu hình PayOS giả về như cũ.
    try { await closeOpen(null); } catch (e) { note('CLEAN', 'đóng khoản mở lỗi', String(e?.message ?? e)); }
    try {
      await q(`DROP TRIGGER IF EXISTS t11_fail_topup ON payment.shop_cod_topups`);
      await q(`DROP FUNCTION IF EXISTS payment.t11_fail_topup()`);
    } catch (e) { note('CLEAN', 'gỡ trigger lỗi', String(e?.message ?? e)); }
    if (SUSPENDED) {
      try { await api('PATCH', `/admin/shops/${SUSPENDED}/approve`, { as: 'admin' }); SUSPENDED = null; } catch (e) { note('CLEAN', 'mở khoá shop lỗi', String(e?.message ?? e)); }
    }
    try { await L.mockCtl({ delayMs: 0, createLink: 'ok' }); } catch { /* bỏ qua */ }
    try {
      if (PREV_FLAG === undefined) await q(`DELETE FROM system.settings WHERE key = $1`, [FLAG]);
      else await L.setSetting(FLAG, PREV_FLAG);
    } catch (e) { note('CLEAN', 'trả cờ lỗi', String(e?.message ?? e)); }
  }
}

try {
  await main();
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
}
L.saveResults(process.env.OUT ?? 'out-t11.json');
const R = L.results;
console.log('FAIL:', R.filter((r) => r.ok === false).map((r) => r.id).join(', ') || '(không)');
console.log(`\nTỔNG nhóm 11: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
process.exit(0);
