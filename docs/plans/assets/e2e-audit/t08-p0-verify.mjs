/*
 * Bài hồi quy 3 lỗi P0 của audit E2E 2026-10-27 (docs/13_E2E_TEST_REPORT.md):
 *   AUD-01 — webhook tiền về ĐỒNG THỜI khách huỷ đơn (CONC-08): không deadlock, webhook không trả 500, tiền khách không mất.
 *   AUD-02 — kỳ đối soát thứ hai của cùng shop trong CÙNG NGÀY (STL-16x): vẫn tạo kỳ, gom đơn mới, mã có hậu tố chữ.
 *   AUD-03 — đổi tài khoản ngân hàng nhận tiền của shop phải nhập lại mật khẩu (STL-11a).
 * Chạy: backend cô lập + PayOS giả (xem README). Biến môi trường: SCR, BE_DIR, E2E_PW_*.
 */
import * as L from './lib.mjs';
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e?.stack ?? e); process.exit(3); });
const { check, group, api, q, q1, note } = L;
const num = (x) => Number(L.money(x));
const ROUNDS = Number(process.env.CONC_ROUNDS ?? 12);

await L.mockReset();
await L.mockBalance(5_000_000_000);
L.resetRateLimit();

/* ------------------------------------------------------------------ AUD-01 */
group('AUD-01 — webhook ∥ khách huỷ (CONC-08), nhiều vòng');
{
  const tz = await L.shopBySlug('techzone');
  const variants = await L.pickVariant({ shopId: tz.id, qty: 3 });
  const users = Array.from({ length: ROUNDS }, (_, i) => `khach${12 + i}`); // mỗi vòng một khách: tránh giới hạn 10 đơn/10 phút
  const outcomes = [];
  for (let i = 0; i < ROUNDS; i++) {
    const as = users[i];
    const v = variants[i % variants.length];
    const p = await L.placeOrder({ as, items: [{ variantId: v.id, qty: 1 }], method: 'payos' });
    if (p.status !== 201) { outcomes.push({ i, skip: `đặt lỗi ${p.status} ${p.code ?? ''}` }); continue; }
    const kid = L.childOrders(p)[0];
    const payos = await L.payosCodeOf(kid.code);
    const [c, w] = await Promise.all([
      api('POST', `/orders/${kid.code}/cancel`, { as, body: { reason: 'Huỷ cùng lúc tiền về' } }),
      L.sendWebhook(payos, num(kid.total), { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } }),
    ]);
    const o = await L.orderRow(kid.code);
    const rf = await L.refundRows(kid.code);
    // Hợp lệ: (a) huỷ thắng rồi tiền về muộn ⇒ cancelled + paid + đúng 1 refund đủ số; (b) tiền về thắng, huỷ bị chặn/đi sau ⇒ đơn đã trả có refund đủ (nếu huỷ được) hoặc còn pending+paid.
    const refundOk = rf.length === 1 && num({ amount: rf[0].amount }) === num(kid.total);
    const consistent = (o.status === 'cancelled' && o.payment_status === 'paid' && refundOk) || (o.status === 'pending' && o.payment_status === 'paid' && rf.length === 0);
    outcomes.push({ i, cancel: c.status, webhook: w.status, status: o.status, ps: o.payment_status, refunds: rf.length, consistent });
  }
  const run = outcomes.filter((o) => !o.skip);
  console.log('  ' + run.map((o) => `${o.cancel}/${o.webhook}→${o.status}/${o.ps}/rf${o.refunds}`).join('  '));
  check('AUD-01a', `${run.length} vòng huỷ ∥ webhook: webhook KHÔNG trả 500 ở vòng nào (không deadlock)`, run.length >= Math.ceil(ROUNDS * 0.66) && run.every((o) => o.webhook === 200), { outcomes });
  check('AUD-01b', 'mọi vòng kết thúc nhất quán — hoặc huỷ + hoàn đủ, hoặc giữ đơn đã trả (không "huỷ mà tiền không ai hoàn")', run.every((o) => o.consistent), { bad: run.filter((o) => !o.consistent) });
  check('AUD-01c', 'không vòng nào cancel trả 5xx', run.every((o) => o.cancel < 500), { outcomes });
  const dead = await q(`SELECT 1 FROM pg_stat_database WHERE datname = current_database() AND deadlocks > 0`);
  note('AUD-01d', 'bộ đếm deadlock của Postgres (pg_stat_database.deadlocks) sau test', (await q1(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).deadlocks + (dead.length ? ' (> 0: kiểm tra log API xem có thử lại thành công không)' : ''));
}

/* ------------------------------------------------------------------ AUD-02 */
group('AUD-02 — kỳ đối soát thứ hai trong cùng ngày (STL-16x)');
{
  const SLUG = 'mobilehub';
  const shop = await L.shopBySlug(SLUG);
  const owner = `owner:${SLUG}`;
  await L.setSetting('payout.auto_max_amount', 100000000);
  await L.setSetting('payout.min_amount', 50000);
  await q(`UPDATE "order".orders SET delivered_at = now(), completed_at = now() WHERE shop_id = $1 AND code LIKE 'DHSEED%'`, [shop.id]);
  await q(`UPDATE payment.shop_payouts SET status = 'paid' WHERE shop_id = $1 AND status IN ('pending','processing')`, [shop.id]);
  const sstat = (code, status) => api('PUT', `/shop/orders/${code}/status`, { as: owner, body: { status } });
  async function completedOrder() {
    const vs = (await L.pickVariant({ shopId: shop.id, qty: 4, maxPrice: 900000 }))[0];
    const placed = await L.placeOrder({ as: 'khach34', items: [{ variantId: vs.id, qty: 1 }], method: 'payos' });
    if (placed.status !== 201) throw new Error(`đặt lỗi ${placed.status} ${placed.code}`);
    const kid = L.childOrders(placed)[0];
    await L.sendWebhook(await L.payosCodeOf(kid.code), num(kid.total), { payer: { bin: '970436', name: 'NGUYEN KHACH', number: '0011223344' } });
    for (const s of ['confirmed', 'packing', 'shipping', 'delivered']) await sstat(kid.code, s);
    await q(`UPDATE "order".orders SET status = 'completed', delivered_at = now() - interval '8 days', completed_at = now() - interval '1 day' WHERE code = $1`, [kid.code]);
    return kid.code;
  }
  const lastEnd = async () => (await q1(`SELECT max(period_end) AS e FROM payment.shop_payouts`))?.e ?? new Date('2020-01-01T00:00:00Z');
  // periodEnd lùi 300ms: đồng hồ Windows lệch giữa hai tiến trình (~15ms) làm `periodEnd = bây giờ` đôi khi vượt Date.now() của API ⇒ 400 thoáng qua (đơn trong bài đã hoàn tất từ 1 ngày trước nên không bị loại).
  const runPeriod = async () => api('POST', '/admin/payouts/run', { as: 'accountant', body: { periodStart: new Date(await lastEnd()).toISOString(), periodEnd: new Date(Date.now() - 300).toISOString(), shopId: shop.id } });

  const o1 = await completedOrder();
  const r1 = await runPeriod();
  await L.sleep(1200); // đảm bảo periodEnd lần 2 > lần 1 (cùng NGÀY, khác mili-giây)
  const o2 = await completedOrder();
  const r2 = await runPeriod();
  await L.sleep(1200);
  const o3 = await completedOrder();
  const r3 = await runPeriod(); // kỳ 3 bắt đầu = kết thúc kỳ 2, cùng NGÀY ⇒ mã gốc PAY-yymmdd-yymmdd-shop TRÙNG kỳ 2 — ca gây lỗi trước đây
  const p1 = r1.data?.[0];
  const p2 = r2.data?.[0];
  const p3 = r3.data?.[0];
  check('AUD-02a', 'chạy lần 1 tạo kỳ chứa đơn 1', !!p1, { st: r1.status, msg: r1.message });
  check('AUD-02b', 'chạy lần 2 tạo kỳ chứa đơn 2', !!p2, { st: r2.status, msg: r2.message });
  check('AUD-02b2', 'chạy lần 3 CÙNG NGÀY với lần 2 (mã gốc trùng) vẫn tạo kỳ mới (trước đây: "Đã tạo 0 kỳ", đơn bị bỏ sót)', !!p3, { st: r3.status, msg: r3.message });
  if (p1 && p2 && p3) {
    const baseOf = (c) => c.replace(/-[B-Z]$/, ''); // chạy lại bài trên DB đã có kỳ hôm nay thì kỳ 2 cũng có hậu tố — so theo mã gốc
    check('AUD-02c', 'ba kỳ có mã KHÁC nhau; kỳ 3 cùng mã gốc với kỳ 2 + hậu tố CHỮ (-B/-C…); ≤ 30 ký tự; hậu tố KHÔNG phải số', new Set([p1.code, p2.code, p3.code]).size === 3 && baseOf(p3.code) === baseOf(p2.code) && /-[B-Z]$/.test(p3.code) && p3.code.length <= 30 && !/-\d+$/.test(p3.code), { c1: p1.code, c2: p2.code, c3: p3.code });
    const linesOf = (id) => q(`SELECT order_code FROM payment.shop_payout_lines WHERE payout_id = $1 AND kind = 'sale'`, [id]);
    const [l1, l2, l3] = [await linesOf(p1.id), await linesOf(p2.id), await linesOf(p3.id)];
    const has = (l, c) => l.some((r) => r.order_code === c);
    check('AUD-02d', 'mỗi đơn nằm đúng MỘT kỳ (đơn 1 ở kỳ 1, đơn 2 ở kỳ 2, đơn 3 ở kỳ 3) — không dòng nào bị bỏ sót hay tính đôi', has(l1, o1) && has(l2, o2) && has(l3, o3) && !has(l2, o1) && !has(l2, o3) && !has(l3, o1) && !has(l3, o2) && !has(l1, o2) && !has(l1, o3), { l1, l2, l3, o1, o2, o3 });
  }
  const lost = await q(`SELECT o.code FROM "order".orders o WHERE o.code = ANY($1) AND NOT EXISTS (SELECT 1 FROM payment.shop_payout_lines l WHERE l.order_code = o.code AND l.kind = 'sale')`, [[o1, o2, o3]]);
  check('AUD-02e', 'không đơn hoàn tất nào bị bỏ khỏi mọi kỳ', lost.length === 0, { lost });
}

/* ------------------------------------------------------------------ AUD-03 */
group('AUD-03 — đổi tài khoản ngân hàng phải nhập lại mật khẩu (STL-11a)');
{
  const SLUG = 'nhaxinh';
  const shop = await L.shopBySlug(SLUG);
  const owner = `owner:${SLUG}`;
  const PASS = process.env.E2E_PW_VENDOR;
  const bankOf = async () => q1(`SELECT bank_code, bank_account_number, bank_account_name FROM shop.shops WHERE id = $1`, [shop.id]);
  const before = await bankOf();
  const NEW = { bankCode: '970422', bankAccountNumber: '5566778899', bankAccountName: 'CHU SHOP MOI' };
  L.resetRateLimit();

  const noPw = await api('PATCH', '/shop/me', { as: owner, body: NEW });
  const afterNoPw = await bankOf();
  check('AUD-03a', 'đổi TK KHÔNG kèm mật khẩu ⇒ 400 SHOP_BANK_PASSWORD_REQUIRED và TK không đổi', noPw.status === 400 && noPw.code === 'SHOP_BANK_PASSWORD_REQUIRED' && JSON.stringify(afterNoPw) === JSON.stringify(before), { st: noPw.status, code: noPw.code, afterNoPw });

  const bad = await api('PATCH', '/shop/me', { as: owner, body: { ...NEW, currentPassword: 'Sai-Mat-Khau-9!' } });
  const afterBad = await bankOf();
  check('AUD-03b', 'đổi TK với mật khẩu SAI ⇒ 400 SHOP_BANK_PASSWORD_INVALID và TK không đổi', bad.status === 400 && bad.code === 'SHOP_BANK_PASSWORD_INVALID' && JSON.stringify(afterBad) === JSON.stringify(before), { st: bad.status, code: bad.code, afterBad });
  check('AUD-03c', 'lỗi mật khẩu KHÔNG dùng 401/403 (FE hiểu là hết phiên / thiếu quyền)', ![401, 403].includes(noPw.status) && ![401, 403].includes(bad.status), { a: noPw.status, b: bad.status });

  const profileOnly = await api('PATCH', '/shop/me', { as: owner, body: { description: 'Mô tả cập nhật lúc kiểm thử — không đụng ngân hàng' } });
  check('AUD-03d', 'chỉ sửa hồ sơ (không đổi bank) ⇒ KHÔNG cần mật khẩu', profileOnly.status === 200, { st: profileOnly.status, code: profileOnly.code });

  const same = await api('PATCH', '/shop/me', { as: owner, body: { bankCode: before.bank_code, bankAccountNumber: before.bank_account_number, bankAccountName: before.bank_account_name } });
  check('AUD-03e', 'gửi lại đúng TK hiện tại (không đổi) ⇒ KHÔNG cần mật khẩu', same.status === 200, { st: same.status, code: same.code });

  const ok = await api('PATCH', '/shop/me', { as: owner, body: { ...NEW, currentPassword: PASS } });
  const afterOk = await bankOf();
  check('AUD-03f', 'đổi TK với mật khẩu ĐÚNG ⇒ 200 và TK mới được lưu', ok.status === 200 && afterOk.bank_account_number === NEW.bankAccountNumber && afterOk.bank_code === NEW.bankCode, { st: ok.status, code: ok.code, afterOk });

  const audit = await q(`SELECT after_summary::text AS after FROM shop.audit_logs WHERE entity_id = $1 AND action ILIKE '%BANK%' ORDER BY created_at DESC LIMIT 1`, [shop.id]);
  check('AUD-03g', 'audit ghi reauthenticated=true; mật khẩu KHÔNG xuất hiện trong audit/outbox', audit[0]?.after?.includes('reauthenticated') && !JSON.stringify(await q(`SELECT after_summary::text a, before_summary::text b FROM shop.audit_logs WHERE entity_id = $1`, [shop.id])).includes(PASS) && !JSON.stringify(await q(`SELECT payload::text p FROM shop.outbox_events WHERE aggregate_id = $1`, [shop.id])).includes(PASS), { audit });

  // khôi phục TK cũ để không để lại hold cho các bài khác
  await q(`UPDATE shop.shops SET bank_code = $2, bank_account_number = $3, bank_account_name = $4, bank_status = 'verified', bank_verified_at = NULL WHERE id = $1`, [shop.id, before.bank_code, before.bank_account_number, before.bank_account_name]);

  // chống dò mật khẩu: quá 10 lần/10 phút ⇒ 429
  L.resetRateLimit();
  const codes = [];
  const token = await L.login(owner);
  // fetch thô: api() của harness tự reset rate-limit rồi thử lại khi gặp 429 nên che mất kết quả cần kiểm
  for (let i = 0; i < 13; i++) {
    const r = await fetch(`${L.BASE}/shop/me`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, connection: 'close' }, body: JSON.stringify({ ...NEW, currentPassword: `sai-${i}` }) });
    codes.push(r.status);
  }
  check('AUD-03h', 'dò mật khẩu liên tục ⇒ bị chặn 429 sau 10 lần/10 phút', codes.includes(429) && codes.slice(0, 10).every((c) => c === 400), { codes });
  L.resetRateLimit();
}

L.saveResults(process.env.OUT ?? 'out-t08.json');
const R = L.results;
console.log(`\nTỔNG nhóm 08: ${R.filter((r) => r.ok).length}/${R.filter((r) => r.ok !== null).length} PASS`);
console.log('FAIL:', R.filter((r) => r.ok === false).map((b) => b.id).join(', ') || '(không)');
process.exit(0);
