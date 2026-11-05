/*
 * PayOS GIẢ cho kiểm thử cô lập (chạy: node mock-payos.mjs; cổng 4020). Backend trỏ EF_PAYOS_API_URL tới đây.
 * Điều khiển hành vi bằng POST /_ctl { createLink, payout, getLink, lookup, balance, delayMs } và POST /_pay, /_payout_state.
 * PLAN-0041 (nạp cọc): POST /_receive { orderCode, amount, reference?, webhook: 'send'|'skip' }, GET /_transfers?orderCode=, POST /_link_status { orderCode, status?, amountPaid? }.
 */
import http from 'node:http';
import { randomUUID, createHmac } from 'node:crypto';

const PORT = Number(process.env.MOCK_PAYOS_PORT ?? 4020);
const fresh = () => ({
  links: new Map(), // orderCode -> link
  payouts: new Map(), // id -> payout
  byRef: new Map(),
  byIdem: new Map(),
  balance: 1_000_000_000,
  ctl: { createLink: 'ok', payout: 'ok', getLink: 'ok', getPayout: 'ok', lookup: 'ok', cancelLink: 'ok', delayMs: 0 },
  log: [],
  transfers: [], // PLAN-0041: mọi khoản tiền PayOS (giả) đã nhận — nguồn sự thật độc lập cho bất biến tiền (WTP-32)
  prepaid: new Map(), // tiền tới TRƯỚC khi link được tạo xong (xem /_receive)
});
let S = fresh();

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const payoutView = (p) => ({ id: p.id, referenceId: p.referenceId, approvalState: p.approvalState, transactions: [{ state: p.txState }] });

// PLAN-0041: payload webhook PayOS ký HMAC cho khoản nạp cọc (/_receive). Định dạng khớp /_confirm (cùng các trường, cùng khoá ký).
const webhookUrl = () => process.env.BACKEND_WEBHOOK ?? 'http://localhost:4030/api/v1/payments/payos/webhook';
const buildWebhook = (l, amount, reference, payer = {}) => {
  const data = { orderCode: Number(l.orderCode), amount: Number(amount), description: l.description, accountNumber: '12345678', reference, transactionDateTime: new Date().toISOString().replace('T', ' ').slice(0, 19), currency: 'VND', paymentLinkId: l.paymentLinkId, code: '00', desc: 'Thành công', counterAccountBankId: payer.bin ?? '970436', counterAccountBankName: payer.bankName ?? 'Vietcombank', counterAccountName: payer.name ?? 'NGUYEN KHACH GIA LAP', counterAccountNumber: payer.number ?? '0011223344', virtualAccountName: '', virtualAccountNumber: '' };
  const canonical = Object.keys(data).sort().map((k) => `${k}=${data[k] ?? ''}`).join('&');
  const signature = createHmac('sha256', process.env.MOCK_CHECKSUM ?? 'audit-checksum-key-collect').update(canonical, 'utf8').digest('hex');
  return { code: '00', desc: 'success', success: true, data, signature };
};
// Trạng thái link theo tiền thực nhận. Link đã đóng (EXPIRED/CANCELLED) GIỮ NGUYÊN: tiền về muộn không làm link "sống lại" trên PayOS giả.
const applyLinkStatus = (l) => {
  if (Number(l.amountPaid) >= Number(l.amount)) l.status = 'PAID';
  else if (l.status === 'PENDING' || l.status === 'UNDERPAID') l.status = 'UNDERPAID';
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
    S.log.push({ t: Date.now(), m: req.method, p: path + url.search, body: path.startsWith('/_') ? undefined : body });
    if (S.log.length > 2000) S.log.shift();

    // ---------- trang thanh toán giả (cho kiểm thử trình duyệt) ----------
    const mPay = path.match(/^\/pay\/(\d+)$/);
    if (mPay && req.method === 'GET') {
      const l = S.links.get(mPay[1]);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (!l) return res.end('<h1>Không tìm thấy link</h1>');
      return res.end(`<!doctype html><meta charset="utf-8"><title>PayOS giả</title><body style="font-family:sans-serif;max-width:420px;margin:60px auto"><h2>PayOS (giả lập kiểm thử)</h2><p>Mã: <b>${l.orderCode}</b><br>Nội dung: ${l.description}<br>Số tiền: <b>${Number(l.amount).toLocaleString('vi-VN')} ₫</b><br>Trạng thái: ${l.status}</p><button id="pay" style="padding:10px 18px;font-size:16px">Chuyển khoản thành công (giả lập)</button> <button id="cancel" style="padding:10px 18px;font-size:16px">Huỷ</button><script>document.getElementById('pay').onclick=async()=>{const r=await fetch('/_confirm/${l.orderCode}',{method:'POST'});const j=await r.json();location.href=j.redirect};document.getElementById('cancel').onclick=()=>{location.href='${l.cancelUrl ?? '/'}'};</script>`);
    }
    const mConf = path.match(/^\/_confirm\/(\d+)$/);
    if (mConf && req.method === 'POST') {
      const l = S.links.get(mConf[1]);
      if (!l) return json(res, 404, { error: 'no link' });
      l.status = 'PAID'; l.amountPaid = l.amount;
      const data = { orderCode: Number(l.orderCode), amount: l.amount, description: l.description, accountNumber: '12345678', reference: `UI${Date.now()}`, transactionDateTime: new Date().toISOString().replace('T', ' ').slice(0, 19), currency: 'VND', paymentLinkId: l.paymentLinkId, code: '00', desc: 'Thành công', counterAccountBankId: '970436', counterAccountBankName: 'Vietcombank', counterAccountName: 'NGUYEN KHACH GIA LAP', counterAccountNumber: '0011223344', virtualAccountName: '', virtualAccountNumber: '' };
      const canonical = Object.keys(data).sort().map((k) => `${k}=${data[k] ?? ''}`).join('&');
      const signature = createHmac('sha256', process.env.MOCK_CHECKSUM ?? 'audit-checksum-key-collect').update(canonical, 'utf8').digest('hex');
      S.transfers.push({ orderCode: String(l.orderCode), reference: data.reference, amount: l.amount, at: Date.now() }); // PLAN-0041: trang PayOS giả cũng là một khoản đã nhận
      let wh = 0;
      try { wh = (await fetch(process.env.BACKEND_WEBHOOK ?? 'http://localhost:4030/api/v1/payments/payos/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '00', desc: 'success', success: true, data, signature }) })).status; } catch { wh = -1; }
      const ret = new URL(l.returnUrl ?? 'http://localhost:3402/');
      ret.searchParams.set('code', '00'); ret.searchParams.set('id', l.paymentLinkId); ret.searchParams.set('cancel', 'false'); ret.searchParams.set('status', 'PAID'); ret.searchParams.set('orderCode', String(l.orderCode));
      return json(res, 200, { webhook: wh, redirect: ret.toString() });
    }

    // ---------- điều khiển ----------
    if (path === '/_ctl') {
      Object.assign(S.ctl, body);
      return json(res, 200, S.ctl);
    }
    if (path === '/_reset') {
      S = fresh();
      return json(res, 200, { ok: true });
    }
    if (path === '/_state') {
      return json(res, 200, { ctl: S.ctl, links: [...S.links.values()], payouts: [...S.payouts.values()], balance: S.balance });
    }
    if (path === '/_log') {
      return json(res, 200, S.log.filter((l) => !l.p.startsWith('/_')));
    }
    if (path === '/_pay') {
      const l = S.links.get(String(body.orderCode));
      if (!l) return json(res, 404, { error: 'no link' });
      l.status = 'PAID';
      l.amountPaid = body.amount ?? l.amount;
      return json(res, 200, l);
    }
    if (path === '/_payout_state') {
      const p = [...S.payouts.values()].find((x) => x.id === body.id || x.referenceId === body.referenceId);
      if (!p) return json(res, 404, { error: 'no payout' });
      p.txState = body.state; // PROCESSING | SUCCEEDED | FAILED
      return json(res, 200, p);
    }
    // ---------- PLAN-0041: khoản nạp cọc — tiền PayOS nhận (sổ giả), webhook ký tuỳ chọn, luỹ kế/trạng thái để thử poll ----------
    if (path === '/_receive' && req.method === 'POST') {
      const code = String(body.orderCode);
      const amount = Number(body.amount);
      if (!(amount > 0)) return json(res, 400, { error: 'amount phải > 0' });
      const reference = body.reference ?? `MOCK${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const l = S.links.get(code);
      S.transfers.push({ orderCode: code, reference, amount, at: Date.now() });
      if (l) { l.amountPaid = Number(l.amountPaid ?? 0) + amount; applyLinkStatus(l); }
      else S.prepaid.set(code, (S.prepaid.get(code) ?? 0) + amount); // PayOS đã nhận tiền cho mã này nhưng phản hồi tạo link còn chậm
      let webhookStatus = null;
      if ((body.webhook ?? 'send') === 'send') {
        try {
          const r = await fetch(webhookUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildWebhook(l ?? { orderCode: code, description: '', paymentLinkId: `pl-${code}` }, amount, reference)) });
          webhookStatus = r.status;
        } catch { webhookStatus = -1; }
      }
      return json(res, 200, { orderCode: code, reference, amount, webhookStatus, amountPaid: l ? l.amountPaid : (S.prepaid.get(code) ?? 0), status: l ? l.status : null });
    }
    if (path === '/_transfers') {
      const code = url.searchParams.get('orderCode');
      return json(res, 200, S.transfers.filter((t) => !code || t.orderCode === code));
    }
    if (path === '/_link_status' && req.method === 'POST') {
      const l = S.links.get(String(body.orderCode));
      if (!l) return json(res, 404, { error: 'no link' });
      if (body.status) l.status = body.status; // PENDING | EXPIRED | CANCELLED (để thử poll)
      if (body.amountPaid !== undefined) l.amountPaid = Number(body.amountPaid); // luỹ kế PayOS báo (thấp hơn để thử WTP-12)
      return json(res, 200, l);
    }
    if (path === '/_balance') {
      S.balance = body.balance;
      return json(res, 200, { balance: S.balance });
    }

    if (S.ctl.delayMs) await sleep(S.ctl.delayMs);

    // ---------- payment link ----------
    if (path === '/v2/payment-requests' && req.method === 'POST') {
      if (S.ctl.createLink === 'drop') return req.socket.destroy();
      if (S.ctl.createLink === '500') return json(res, 500, { code: '99', desc: 'Internal error' });
      if (S.ctl.createLink === 'fail') return json(res, 200, { code: '20', desc: 'Tạo link thất bại (giả lập)' });
      const link = {
        orderCode: body.orderCode,
        amount: body.amount,
        description: body.description,
        paymentLinkId: `pl-${body.orderCode}`,
        status: 'PENDING',
        amountPaid: 0,
        expiredAt: body.expiredAt,
        returnUrl: body.returnUrl,
        cancelUrl: body.cancelUrl,
        createdAt: Date.now(),
      };
      const pre = S.prepaid.get(String(body.orderCode)); // tiền đã tới trước khi link xong (PLAN-0041)
      if (pre) { link.amountPaid = pre; S.prepaid.delete(String(body.orderCode)); applyLinkStatus(link); }
      S.links.set(String(body.orderCode), link);
      return json(res, 200, { code: '00', desc: 'success', data: { ...link, checkoutUrl: `http://localhost:${PORT}/pay/${body.orderCode}`, qrCode: `MOCKQR-${body.orderCode}` } });
    }
    const mLink = path.match(/^\/v2\/payment-requests\/([^/]+)$/);
    if (mLink && req.method === 'GET') {
      if (S.ctl.getLink === 'down') return json(res, 503, { code: '99', desc: 'PayOS tạm ngưng (giả lập)' });
      const l = S.links.get(mLink[1]) ?? [...S.links.values()].find((x) => x.paymentLinkId === mLink[1]);
      if (!l) return json(res, 404, { code: '101', desc: 'Không tìm thấy' });
      return json(res, 200, { code: '00', desc: 'success', data: { ...l, amountRemaining: l.amount - l.amountPaid } });
    }
    if (mLink && req.method === 'DELETE') {
      if (S.ctl.cancelLink === 'down') return json(res, 503, { code: '99', desc: 'down' });
      const l = S.links.get(mLink[1]);
      if (l && l.status === 'PENDING') l.status = 'CANCELLED';
      return json(res, 200, { code: '00', desc: 'success', data: l ?? null });
    }

    // ---------- payout ----------
    if (path === '/v1/payouts' && req.method === 'POST') {
      const idem = req.headers['x-idempotency-key'];
      if (S.ctl.payout === 'drop') {
        // mô phỏng timeout/mất kết nối SAU khi PayOS có thể đã nhận: nhận lệnh rồi cắt kết nối
        if (body.referenceId && !S.byRef.has(body.referenceId)) {
          const p = { id: `po-${randomUUID().slice(0, 8)}`, referenceId: body.referenceId, amount: body.amount, toBin: body.toBin, toAccountNumber: body.toAccountNumber, approvalState: 'APPROVED', txState: 'PROCESSING', idem };
          S.payouts.set(p.id, p);
          S.byRef.set(p.referenceId, p);
          if (idem) S.byIdem.set(idem, p);
        }
        return req.socket.destroy();
      }
      if (S.ctl.payout === 'drop_before') return req.socket.destroy(); // mất kết nối TRƯỚC khi PayOS nhận
      if (S.ctl.payout === '500') return json(res, 500, { code: '99', desc: 'Internal error' });
      if (S.ctl.payout === 'reject') return json(res, 400, { code: '101', desc: 'Tài khoản nhận không hợp lệ (giả lập)' });
      if (S.ctl.payout === 'nobalance') return json(res, 400, { code: '21', desc: 'Số dư không đủ (giả lập)' });
      if (idem && S.byIdem.has(idem)) {
        const p = S.byIdem.get(idem);
        return json(res, 200, { code: '00', desc: 'success', data: payoutView(p) });
      }
      if (S.balance < body.amount) return json(res, 400, { code: '21', desc: 'Số dư không đủ' });
      S.balance -= body.amount;
      const p = { id: `po-${randomUUID().slice(0, 8)}`, referenceId: body.referenceId, amount: body.amount, toBin: body.toBin, toAccountNumber: body.toAccountNumber, approvalState: 'APPROVED', txState: 'PROCESSING', idem };
      S.payouts.set(p.id, p);
      S.byRef.set(p.referenceId, p);
      if (idem) S.byIdem.set(idem, p);
      return json(res, 200, { code: '00', desc: 'success', data: payoutView(p) });
    }
    const mPo = path.match(/^\/v1\/payouts\/([^/]+)$/);
    if (mPo && req.method === 'GET') {
      if (S.ctl.getPayout === 'down') return json(res, 503, { code: '99', desc: 'down' });
      const p = S.payouts.get(decodeURIComponent(mPo[1]));
      if (!p) return json(res, 404, { code: '101', desc: 'Không tìm thấy lệnh chi' });
      return json(res, 200, { code: '00', desc: 'success', data: payoutView(p) });
    }
    if (path === '/v1/payouts' && req.method === 'GET') {
      if (S.ctl.lookup === 'down') return json(res, 503, { code: '99', desc: 'down' });
      const ref = url.searchParams.get('referenceId');
      const list = [...S.payouts.values()].filter((p) => !ref || p.referenceId === ref).map(payoutView);
      return json(res, 200, { code: '00', desc: 'success', data: { payouts: list } });
    }
    if (path === '/v1/payouts-account/balance') {
      return json(res, 200, { code: '00', message: 'success', data: { balance: S.balance } });
    }

    json(res, 404, { code: '404', desc: `mock: không có ${req.method} ${path}` });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`PayOS giả nghe cổng ${PORT}`));
