import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { PaymentService } from '../payment/payment.service';

/* QueryAPI của payment — order đọc thông tin hiển thị (URL/mã giao dịch); reporting đọc doanh thu đã thu. */
@Injectable()
export class PaymentQueryApi {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
  ) {}

  /* Báo nhận COD theo lô cho shipping; không truyền model payment qua module. */
  async carrierCodReceipts(codes:string[]):Promise<Map<string,{collectedAt:string|null;remittedAt:string|null;reference:string|null}>> {
    if(!codes.length) return new Map();
    const rows=await this.prisma.payment.findMany({where:{orderCode:{in:codes},collectionMode:'carrier_cod'},select:{orderCode:true,codCollectedAt:true,codRemittedAt:true,codRemittanceRef:true}});
    return new Map(rows.map((r)=>[r.orderCode,{collectedAt:r.codCollectedAt?.toISOString() ?? null,remittedAt:r.codRemittedAt?.toISOString() ?? null,reference:r.codRemittanceRef}]));
  }
  extrasForOrder(orderCode: string) {
    return this.payments.extrasForOrder(orderCode);
  }

  /*
   * PLAN-0027 §2.2 (G14, CAN-13): tổng số tiền đã/đang được hoàn THEO ĐƠN (kind = order; mọi trạng thái — chờ, đang chi, đã chi, lỗi chờ chi lại đều là nghĩa vụ đã phát sinh với khách).
   * Order huỷ đơn `partially_refunded` hoàn đúng `total − số này` — không vượt số đã thu, không hoàn hai lần. Gọi TRONG tx đã khoá dòng đơn (ĐƠN → PAYMENT): chỉ ĐỌC.
   */
  async orderRefundCommitted(orderCode: string, tx?: Tx): Promise<bigint> {
    const agg = await (tx ?? this.prisma).refund.aggregate({ where: { orderCode, kind: 'order' }, _sum: { amount: true } });
    return BigInt(agg._sum.amount?.toString() ?? '0');
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
