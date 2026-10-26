/*
 * Giả lập webhook PayOS "đã thanh toán" để thử luồng thu tiền mà KHÔNG cần quét QR thật (chỉ dùng khi phát triển).
 *
 * Dùng:  node scripts/dev/simulate-payos-webhook.mjs <payosOrderCode> <amount>
 *   - payosOrderCode: số PayOS của giao dịch — lấy từ DB:
 *       SELECT provider_ref FROM payment.payment_transactions WHERE type = 'create_url' ORDER BY created_at DESC LIMIT 1;
 *   - amount: đúng số tiền của đơn con (VND) — lệch số tiền thì hệ thống ghi "mismatch" và KHÔNG đánh dấu đã trả.
 *
 * Đọc EF_PAYOS_CHECKSUM_KEY và địa chỉ API từ biến môi trường (hoặc file .env cùng thư mục chạy):
 *   EF_PAYOS_CHECKSUM_KEY=... EF_API_URL=http://localhost:4000/api/v1 node scripts/dev/simulate-payos-webhook.mjs 1761234567890123 150000
 * Chữ ký tính y như PayOS: HMAC-SHA256(checksumKey, "k=v&..." của `data`, khoá sắp alphabet).
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

function loadDotEnv() {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv();

const [orderCode, amount] = process.argv.slice(2);
const key = process.env.EF_PAYOS_CHECKSUM_KEY;
const base = process.env.EF_API_URL ?? `${(process.env.EF_API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '')}/${process.env.EF_API_PREFIX ?? 'api/v1'}`;
if (!orderCode || !amount || !key) {
  console.error('Thiếu tham số. Dùng: node scripts/dev/simulate-payos-webhook.mjs <payosOrderCode> <amount>  (cần EF_PAYOS_CHECKSUM_KEY)');
  process.exit(1);
}

const data = {
  orderCode: Number(orderCode),
  amount: Number(amount),
  description: 'SIMULATED',
  accountNumber: '12345678',
  reference: `SIM${Date.now()}`,
  transactionDateTime: new Date().toISOString().replace('T', ' ').slice(0, 19),
  currency: 'VND',
  paymentLinkId: `sim-${orderCode}`,
  code: '00',
  desc: 'Thành công',
  counterAccountBankId: '',
  counterAccountBankName: '',
  counterAccountName: '',
  counterAccountNumber: '',
  virtualAccountName: '',
  virtualAccountNumber: '',
};
const canonical = Object.keys(data).sort().map((k) => `${k}=${data[k] ?? ''}`).join('&');
const signature = createHmac('sha256', key).update(canonical, 'utf8').digest('hex');

const res = await fetch(`${base}/payments/payos/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: '00', desc: 'success', success: true, data, signature }),
});
console.log(res.status, await res.text());
