/* Chạy MỘT job nền của worker ngay lập tức (không chờ chu kỳ): node jobs.cjs <tên> [json-args] — dùng cho kiểm thử. */
// HÀNG RÀO AN TOÀN (bài học audit 2026-10-27): job khởi động cả ứng dụng Nest nên dùng đúng cấu hình của tiến trình gọi — thiếu `source auditenv.sh` thì nó rơi về .env của bản sao
// (DB/Redis/SMTP dev). Chỉ chạy khi EF_DATABASE_URL trỏ DB audit (cổng 55442) và Redis audit (56389); muốn cổng khác phải đặt E2E_ALLOW_ANY_DB=1 một cách có chủ đích.
const dbUrl = process.env.EF_DATABASE_URL ?? '';
const redisUrl = process.env.EF_REDIS_URL ?? '';
if (process.env.E2E_ALLOW_ANY_DB !== '1' && !(dbUrl.includes(':55442/') && redisUrl.includes(':56389'))) {
  console.error('jobs.cjs TỪ CHỐI chạy: EF_DATABASE_URL / EF_REDIS_URL không phải DB/Redis audit (:55442 / :56389). Hãy "source auditenv.sh" trước (hoặc E2E_ALLOW_ANY_DB=1 nếu thật sự cố ý).');
  process.exit(2);
}
const { createRequire } = require('node:module');
const req = createRequire(process.env.BE_DIR + '/package.json');
req('reflect-metadata');
const { NestFactory } = req('@nestjs/core');
const DIST = process.env.BE_DIR + '/dist/src/';

async function main() {
  const name = process.argv[2];
  const { WorkerModule } = require(DIST + 'worker.module.js');
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  try {
    const orderJobs = () => app.get(require(DIST + 'modules/order/order-worker.module.js').OrderJobs, { strict: false });
    const payJobs = () => app.get(require(DIST + 'modules/payment/payment-worker.module.js').PaymentJobs, { strict: false });
    const autoPayout = () => app.get(require(DIST + 'modules/payment/shop-payout/auto-payout.job.js').AutoPayoutJob, { strict: false });
    const topupJobs = () => app.get(require(DIST + 'modules/payment/shop-wallet/shop-wallet-topup.job.js').WalletTopupJobs, { strict: false });
    let out;
    switch (name) {
      case 'cancel-expired': out = await orderJobs().cancelExpired(); break;
      case 'return-sla': out = await orderJobs().returnSlaTick(); break;
      case 'auto-complete': out = await orderJobs().autoComplete(); break;
      case 'refund-recover': out = await payJobs().recoverStuckRefunds(); break;
      case 'payos-poll': out = await payJobs().reconcilePendingPayos(); break;
      case 'refund-auto': out = await payJobs().autoProcessRefunds(); break;
      case 'refund-reconcile': out = await payJobs().reconcileGatewayRefunds(); break;
      case 'payout-reconcile': out = await autoPayout().reconcile(); break;
      case 'order-sla': out = await orderJobs().orderSlaTick(); break; // PLAN-0040 3.2 — chỉ hành động khi setting order.sla_enabled = true
      case 'payout-auto': out = await autoPayout().runOnce(process.argv[3] ? new Date(process.argv[3]) : new Date()); break;
      case 'topup-reconcile': out = await topupJobs().reconcileWalletTopups(); break; // PLAN-0041: dò PayOS khoản nạp cọc đang mở + đuôi 72 giờ + hết hạn (null = bỏ qua/lỗi)
      default: throw new Error('job không biết: ' + name);
    }
    console.log(JSON.stringify({ job: name, ok: true, out: out ?? null }));
  } finally {
    await app.close();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exit(1); });
