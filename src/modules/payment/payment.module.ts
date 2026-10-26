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
import { ShopWalletController } from './shop-wallet/controller/shop-wallet.controller';
import { ShopWalletService } from './shop-wallet/shop-wallet.service';

/*
 * Module payment (PLAN-0007/0015/0017/0018/0020): COD + PayOS. PayOS: tiền về sàn rồi đối soát chi trả shop. COD (PLAN-0020): shop cầm tiền mặt, chỉ bán được khi đã đặt cọc
 * (ShopWalletService: ví đặt cọc, sàn tự trừ hoa hồng mỗi đơn COD thu thành công).
 * Export PAYMENT_GATEWAY + PaymentQueryApi cho order; PaymentService (job phục hồi refund treo ở worker) + PayosService + audit/outbox cho PaymentSettlementModule/worker.
 * Cần ORDER_PAYMENT_GATEWAY do OrderModule (@Global) cung cấp — KHÔNG import OrderModule (OrderModule import PaymentModule → vòng).
 * Đối soát shop (cần OrderQueryApi) nằm ở PaymentSettlementModule vì lý do đó.
 * Cần ShopModule (ShopQueryApi) và SystemQueryApi (SystemModule).
 */
@Module({
  imports: [ShopModule, SystemModule],
  controllers: [PaymentPublicController, PaymentController, AdminPaymentController, ShopWalletController],
  providers: [
    PayosService,
    PaymentService,
    ShopWalletService,
    PaymentQueryApi,
    PaymentAuditLogService,
    PaymentOutboxService,
    { provide: PAYMENT_GATEWAY, useExisting: PaymentService },
  ],
  exports: [PAYMENT_GATEWAY, PaymentQueryApi, PaymentService, ShopWalletService, PayosService, PaymentAuditLogService, PaymentOutboxService],
})
export class PaymentModule {}
