import { Injectable } from '@nestjs/common';
import type { CarrierOrderUpdate, OrderShippingGateway, ShippingOrderSnapshot, ShippingSnapshot } from '@common/gateway/order-shipping.gateway';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { PaymentQueryApi } from '@modules/payment/queryapi/payment.queryapi';
import { OrderRepository } from '../order/repository/order.repository';
import { OrderService } from '../order/service/order.service';

/* Cổng ngược giữ thứ tự khoá ĐƠN → SHIPMENT; shipping không đọc/ghi bảng order trực tiếp. */
@Injectable()
export class OrderShippingGatewayImpl implements OrderShippingGateway {
  constructor(private readonly repo: OrderRepository, private readonly orders: OrderService, private readonly payments:PaymentQueryApi) {}
  codReceipts(codes:string[]) { return this.payments.carrierCodReceipts(codes); }
  recordShippingAction(order:ShippingOrderSnapshot,input:{kind:string;shipmentId:string;message:string},tx:Tx) { return this.orders.recordShippingAction(order,input,tx); }
  async lockOrder(code: string, tx: Tx): Promise<ShippingOrderSnapshot | null> {
    const o = await this.repo.findByCodeForUpdate(code, tx);
    return o ? { id: o.id, code: o.code, userId: o.userId, shopId: o.shopId, status: o.status,
      paymentStatus: o.paymentStatus, paymentMethodCode: o.paymentMethodCode, fulfilmentMode: o.fulfilmentMode,
      collectionMode: o.collectionMode ?? (o.paymentMethodCode === 'cod' ? 'shop_cod' : 'platform_online'),
      total: o.total.toString(), cancelRequestPending: o.cancelRequestStatus === 'pending',
      shippingSnapshot: o.shippingSnapshot as unknown as ShippingSnapshot | null } : null;
  }
  applyCarrierUpdate(order: ShippingOrderSnapshot, input: CarrierOrderUpdate, tx: Tx): Promise<void> {
    return this.orders.applyCarrierUpdate(order, input, tx);
  }
  confirmCodReceived(order: ShippingOrderSnapshot, actor: AuthenticatedActor, input: { amount: string; reference: string; note?: string }, tx: Tx): Promise<void> {
    return this.orders.confirmCarrierCod(order, actor, input, tx);
  }
}
