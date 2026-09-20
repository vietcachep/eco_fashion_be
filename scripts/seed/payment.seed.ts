/* SEED module payment: 3 phương thức (cod · bank_transfer · vnpay). Upsert theo code; giữ trạng thái bật/tắt admin đã sửa. */
import type { PrismaClient } from '../../src/generated/prisma/client';

const METHODS = [
  { code: 'cod', name: 'Thanh toán khi nhận hàng', description: 'Trả tiền mặt cho nhân viên giao hàng (đơn dưới 5.000.000₫)', kind: 'cod', sortOrder: 1 },
  { code: 'bank_transfer', name: 'Chuyển khoản ngân hàng', description: 'Quét mã VietQR, nội dung chuyển khoản là mã đơn — đơn xác nhận khi tiền về', kind: 'bank_transfer', sortOrder: 2 },
  { code: 'vnpay', name: 'Thẻ ATM / Visa / Mastercard / VNPay QR', description: 'Thanh toán an toàn qua cổng VNPay — không lưu số thẻ', kind: 'gateway', sortOrder: 3 },
];

export async function seed(prisma: PrismaClient): Promise<void> {
  for (const m of METHODS) {
    await prisma.paymentMethod.upsert({ where: { code: m.code }, create: { ...m, isActive: true }, update: { name: m.name, description: m.description, kind: m.kind, sortOrder: m.sortOrder } });
  }
  console.log(`   phương thức thanh toán: ${METHODS.length} (upsert)`);
}
