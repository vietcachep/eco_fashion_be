import { Injectable } from '@nestjs/common';
import type { OrderPaymentGateway } from '@common/gateway/payment.gateway';
import type { Tx } from '@common/prisma/types';
import { OrderService } from '../order/service/order.service';
import { ReturnService } from '../return/return.service';

/* Cài OrderPaymentGateway (cổng ngược): payment báo tiền về / thất bại / hoàn xong trong CÙNG tx xử lý IPN. */
@Injectable()
export class OrderPaymentGatewayImpl implements OrderPaymentGateway {
  constructor(
    private readonly orders: OrderService,
    private readonly returns: ReturnService,
  ) {}

  onPaid(orderCode: string, info: { paymentId: string; methodCode: string; transactionCode: string | null; bankCode: string | null; paidAt: Date }, tx: Tx): Promise<void> {
    return this.orders.onPaid(orderCode, info, tx);
  }

  onPaymentFailed(orderCode: string, reason: string, tx: Tx): Promise<void> {
    return this.orders.onPaymentFailed(orderCode, reason, tx);
  }

  async onRefunded(orderCode: string, amount: bigint, refundId: string, tx: Tx): Promise<void> {
    await this.orders.onRefunded(orderCode, amount, refundId, tx);
  }

  /* payment gọi thêm khi hoàn tiền của yêu cầu đổi trả xong. */
  markReturnRefunded(returnRequestId: string, tx: Tx): Promise<void> {
    return this.returns.markRefunded(returnRequestId, tx);
  }
}
