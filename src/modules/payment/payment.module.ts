import { Module } from '@nestjs/common';
import { PAYMENT_GATEWAY } from '@common/gateway/payment.gateway';
import { ShopModule } from '@modules/shop/shop.module';
import { SystemModule } from '@modules/system/system.module';
import { AdminPaymentController, PaymentController, PaymentPublicController } from './payment/payment.controllers';
import { PaymentService } from './payment/payment.service';
import { PaymentQueryApi } from './queryapi/payment.queryapi';
import { PayosService } from './payos/payos.service';
import { PaymentAuditLogService } from './audit/payment-audit-log.service';
import { PaymentOutboxService } from './outbox/payment-outbox.service';

/*
 * Module payment (PLAN-0007/0015/0017/0018): chỉ còn COD (sàn thu hộ qua đơn vị vận chuyển) + PayOS; mọi khoản tiền về sàn rồi đối soát chi trả shop.
 * Export PAYMENT_GATEWAY + PaymentQueryApi cho order; PaymentService (job phục hồi refund treo ở worker) + PayosService + audit/outbox cho PaymentSettlementModule/worker.
 * Cần ORDER_PAYMENT_GATEWAY do OrderModule (@Global) cung cấp — KHÔNG import OrderModule (OrderModule import PaymentModule → vòng).
 * Đối soát shop (cần OrderQueryApi) nằm ở PaymentSettlementModule vì lý do đó.
 * Cần ShopModule (ShopQueryApi) và SystemQueryApi (SystemModule).
 */
@Module({
  imports: [ShopModule, SystemModule],
  controllers: [PaymentPublicController, PaymentController, AdminPaymentController],
  providers: [
    PayosService,
    PaymentService,
    PaymentQueryApi,
    PaymentAuditLogService,
    PaymentOutboxService,
    { provide: PAYMENT_GATEWAY, useExisting: PaymentService },
  ],
  exports: [PAYMENT_GATEWAY, PaymentQueryApi, PaymentService, PayosService, PaymentAuditLogService, PaymentOutboxService],
})
export class PaymentModule {}
