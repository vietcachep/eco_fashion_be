import { Injectable } from '@nestjs/common';
import type { OrderActionsGateway } from '@common/gateway/order-actions.gateway';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { OrderService } from '../order/service/order.service';

/* ai (thẻ "Xác nhận" của chatbot) huỷ đơn thay khách — đi qua OrderService.cancelByCustomer, không có lối tắt. */
@Injectable()
export class OrderActionsGatewayImpl implements OrderActionsGateway {
  constructor(private readonly orders: OrderService) {}

  async cancelByCustomer(actor: Pick<AuthenticatedActor, 'userId' | 'email'>, orderCode: string, reason: string): Promise<{ code: string; status: string }> {
    const o = await this.orders.cancelByCustomer(actor as AuthenticatedActor, orderCode, reason);
    return { code: o.code, status: o.status };
  }
}
