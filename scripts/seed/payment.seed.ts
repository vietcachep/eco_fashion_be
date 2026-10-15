/* SEED module payment (PLAN-0018): CHỈ 2 phương thức (cod · payos). Upsert theo code; giữ trạng thái bật/tắt admin đã sửa.
   Dòng vnpay/bank_transfer (dữ liệu cũ) luôn bị TẮT — migration payment_platform_collects_all cũng làm vậy, seed lặp lại cho DB dựng từ bản trước. */
import type { PrismaClient } from '../../src/generated/prisma/client';

const METHODS = [
  { code: 'cod', name: 'Thanh toán khi nhận hàng', description: 'Thanh toán khi nhận hàng — shipper thu hộ cho sàn (đơn dưới 5.000.000₫)', kind: 'cod', sortOrder: 1 },
  { code: 'payos', name: 'PayOS (QR chuyển khoản tự động)', description: 'Quét mã QR hoặc chuyển khoản — tiền tự xác nhận khi nhận', kind: 'gateway', sortOrder: 2 },
];
const RETIRED = ['vnpay', 'bank_transfer'];

export async function seed(prisma: PrismaClient): Promise<void> {
  for (const m of METHODS) {
    await prisma.paymentMethod.upsert({ where: { code: m.code }, create: { ...m, isActive: true }, update: { name: m.name, description: m.description, kind: m.kind, sortOrder: m.sortOrder } });
  }
  await prisma.paymentMethod.updateMany({ where: { code: { in: RETIRED }, isActive: true }, data: { isActive: false } });
  console.log(`   phương thức thanh toán: ${METHODS.length} (upsert; vnpay/bank_transfer đã tắt)`);
}
