import { Global, Module } from '@nestjs/common';
import { ORDER_ACTIONS_GATEWAY } from '@common/gateway/order-actions.gateway';
import { ORDER_PAYMENT_GATEWAY } from '@common/gateway/payment.gateway';
import { CartModule } from '../cart/cart.module';
import { PaymentModule } from '../payment/payment.module';
import { ProductModule } from '../product/product.module';
import { PromotionModule } from '../promotion/promotion.module';
import { ShopModule } from '../shop/shop.module';
import { SystemModule } from '../system/system.module';
import { OrderAuditLogService } from './audit/order-audit-log.service';
import { OrderActionsGatewayImpl } from './gateway/order-actions.gateway.impl';
import { OrderPaymentGatewayImpl } from './gateway/order-payment.gateway.impl';
import { AdminOrderController, OrderController } from './order/controller/order.controllers';
import { ShopOrderController } from './order/controller/shop-order.controller';
import { OrderRepository } from './order/repository/order.repository';
import { OrderService } from './order/service/order.service';
import { ShopOrderService } from './order/service/shop-order.service';
import { OrderOutboxService } from './outbox/order-outbox.service';
import { OrderQueryApi } from './queryapi/order.queryapi';
import { ReturnService } from './return/return.service';

/*
 * Module order (PLAN-0006). @Global vì cung cấp ORDER_PAYMENT_GATEWAY cho payment (cổng ngược) mà không tạo vòng import.
 * Export OrderQueryApi cho review/ai/reporting. IdentityModule là @Global nên IdentityQueryApi có sẵn.
 */
@Global()
@Module({
  imports: [CartModule, ProductModule, PromotionModule, SystemModule, PaymentModule, ShopModule],
  controllers: [OrderController, AdminOrderController, ShopOrderController],
  providers: [OrderRepository, OrderAuditLogService, OrderOutboxService, OrderService, ShopOrderService, ReturnService, OrderQueryApi, { provide: ORDER_PAYMENT_GATEWAY, useClass: OrderPaymentGatewayImpl }, { provide: ORDER_ACTIONS_GATEWAY, useClass: OrderActionsGatewayImpl }],
  // OrderService/OrderOutboxService export CHỈ cho OrderWorkerModule (job huỷ quá hạn, listener mail).
  exports: [OrderQueryApi, ORDER_PAYMENT_GATEWAY, ORDER_ACTIONS_GATEWAY, OrderService, OrderOutboxService],
})
export class OrderModule {}
