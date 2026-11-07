import { Global, Module } from '@nestjs/common';
import { CheckoutIntentController } from './checkout/checkout-intent.controller';
import { CheckoutIntentRepository } from './checkout/checkout-intent.repository';
import { CheckoutIntentService } from './checkout/checkout-intent.service';
import { LIVE_RECOVERY_CHECKOUT_GATEWAY, LIVE_COMMERCE_ORDER_GATEWAY } from '@common/gateway/live-commerce.gateway';
import { LiveOrderGateway } from './checkout/live-order.gateway';
import { ORDER_ACTIONS_GATEWAY } from '@common/gateway/order-actions.gateway';
import { ORDER_PAYMENT_GATEWAY } from '@common/gateway/payment.gateway';
import { ORDER_SHIPPING_GATEWAY } from '@common/gateway/order-shipping.gateway';
import { ShippingModule } from '@modules/shipping/shipping.module';
import { OrderShippingGatewayImpl } from './gateway/order-shipping.gateway.impl';
import { OrderShippingPricingService } from './shipping/order-shipping-pricing.service';
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
import { OrderFulfilmentService } from './order/service/order-fulfilment.service';
import { OrderSlaService } from './order/service/order-sla.service';
import { AdminShopViolationController, ShopViolationController } from './violation/shop-violation.controller';
import { ShopViolationService } from './violation/shop-violation.service';
import { ShopOrderService } from './order/service/shop-order.service';
import { OrderOutboxService } from './outbox/order-outbox.service';
import { OrderQueryApi } from './queryapi/order.queryapi';
import { AdminReturnService } from './return/admin-return.service';
import { AdminReturnController, ReturnController, ShopReturnController } from './return/controller/return.controllers';
import { ReturnCoreService } from './return/return-core.service';
import { ReturnSlaService } from './return/return-sla.service';
import { ReturnService } from './return/return.service';
import { ShopReturnService } from './return/shop-return.service';

/*
 * Module order (PLAN-0006; đổi trả theo đúng vai: PLAN-0022). @Global vì cung cấp ORDER_PAYMENT_GATEWAY cho payment (cổng ngược) mà không tạo vòng import.
 * Export OrderQueryApi cho review/ai/reporting. IdentityModule là @Global nên IdentityQueryApi có sẵn.
 */
@Global()
@Module({
  imports: [ShippingModule, CartModule, ProductModule, PromotionModule, SystemModule, PaymentModule, ShopModule],
  controllers: [CheckoutIntentController, OrderController, AdminOrderController, ShopOrderController, ReturnController, AdminReturnController, ShopReturnController, AdminShopViolationController, ShopViolationController],
  providers: [
    CheckoutIntentRepository,
    CheckoutIntentService,
    {provide:LIVE_RECOVERY_CHECKOUT_GATEWAY,useExisting:CheckoutIntentRepository},
    {provide:LIVE_COMMERCE_ORDER_GATEWAY,useClass:LiveOrderGateway},
    OrderShippingPricingService,
    {provide:ORDER_SHIPPING_GATEWAY,useClass:OrderShippingGatewayImpl},
    OrderRepository,
    OrderAuditLogService,
    OrderOutboxService,
    OrderService,
    ShopOrderService,
    // PLAN-0027: lối thoát & hạn chót (yêu cầu huỷ, đổi địa chỉ, đã nhận hàng, gia hạn giao, shop bị khoá) + job SLA + điểm vi phạm của shop.
    OrderFulfilmentService,
    OrderSlaService,
    ShopViolationService,
    // Đổi trả (PLAN-0022): lõi dùng chung + một service theo từng vai (khách · shop · sàn) + job SLA.
    ReturnCoreService,
    ReturnService,
    ShopReturnService,
    AdminReturnService,
    ReturnSlaService,
    OrderQueryApi,
    { provide: ORDER_PAYMENT_GATEWAY, useClass: OrderPaymentGatewayImpl },
    { provide: ORDER_ACTIONS_GATEWAY, useClass: OrderActionsGatewayImpl },
  ],
  // OrderService/OrderOutboxService/ReturnSlaService export CHỈ cho OrderWorkerModule (job huỷ quá hạn, job SLA đổi trả, listener mail).
  exports: [LIVE_COMMERCE_ORDER_GATEWAY,LIVE_RECOVERY_CHECKOUT_GATEWAY, ORDER_SHIPPING_GATEWAY,OrderQueryApi, ORDER_PAYMENT_GATEWAY, ORDER_ACTIONS_GATEWAY, OrderService, OrderOutboxService, ReturnSlaService, OrderFulfilmentService, OrderSlaService, ShopViolationService],
})
export class OrderModule {}
