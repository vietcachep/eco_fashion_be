import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';

/* QueryAPI của payment — order đọc thông tin hiển thị (URL/mã giao dịch); reporting đọc doanh thu đã thu. */
@Injectable()
export class PaymentQueryApi {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
  ) {}

  extrasForOrder(orderCode: string) {
    return this.payments.extrasForOrder(orderCode);
  }

  /* Phương thức đang bật + dùng được (PayOS chỉ khi có cấu hình khoá) — chatbot kể cho khách. */
  async activeMethods(): Promise<Array<{ code: string; name: string; description: string | null }>> {
    return (await this.payments.listMethods(true)).map((m) => ({ code: m.code, name: m.name, description: m.description }));
  }

  async paidSummaryBetween(from: Date, to: Date): Promise<{ paidCount: number; paidAmount: bigint; refunded: bigint }> {
    const [paid, refunded] = await Promise.all([
      this.prisma.payment.aggregate({ where: { paidAt: { gte: from, lt: to }, status: { in: ['paid', 'partially_refunded', 'refunded'] } }, _count: true, _sum: { amount: true } }),
      this.prisma.refund.aggregate({ where: { status: 'done', processedAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    ]);
    return { paidCount: paid._count, paidAmount: BigInt(paid._sum.amount?.toString() ?? '0'), refunded: BigInt(refunded._sum.amount?.toString() ?? '0') };
  }
}
