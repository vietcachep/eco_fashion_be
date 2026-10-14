import { Module } from '@nestjs/common';
import { PAYMENT_GATEWAY } from '@common/gateway/payment.gateway';
import { ShopModule } from '@modules/shop/shop.module';
import { SystemModule } from '@modules/system/system.module';
import { AdminPaymentController, PaymentController, PaymentPublicController } from './payment/payment.controllers';
import { PaymentService } from './payment/payment.service';
import { PaymentQueryApi } from './queryapi/payment.queryapi';
import { PayosService } from './payos/payos.service';
import { VnpayService } from './vnpay/vnpay.service';
import { PaymentAuditLogService } from './audit/payment-audit-log.service';
import { PaymentOutboxService } from './outbox/payment-outbox.service';
import { ShopWalletRepository } from './shop-wallet/repository/shop-wallet.repository';
import { ShopWalletService } from './shop-wallet/service/shop-wallet.service';
import { ShopWalletController } from './shop-wallet/controller/shop-wallet.controller';
import { AdminWalletController } from './shop-wallet/controller/admin-wallet.controller';

/*
 * Module payment (PLAN-0007/PLAN-0015/PLAN-0017): COD · chuyển khoản VietQR · VNPay · PayOS · ví quỹ COD.
 * Export PAYMENT_GATEWAY + PaymentQueryApi cho order; PaymentService (job phục hồi refund treo ở worker) + PayosService + ShopWalletService + audit/outbox cho PaymentSettlementModule/worker.
 * Cần ORDER_PAYMENT_GATEWAY do OrderModule (@Global) cung cấp — KHÔNG import OrderModule (OrderModule import PaymentModule → vòng).
 * Đối soát shop (cần OrderQueryApi) nằm ở PaymentSettlementModule vì lý do đó.
 * Cần ShopContextGuard + SHOP_COD_GATEWAY (ShopModule) và SystemQueryApi (SystemModule).
 */
@Module({
  imports: [ShopModule, SystemModule],
  controllers: [PaymentPublicController, PaymentController, AdminPaymentController, ShopWalletController, AdminWalletController],
  providers: [
    VnpayService,
    PayosService,
    PaymentService,
    PaymentQueryApi,
    PaymentAuditLogService,
    PaymentOutboxService,
    ShopWalletRepository,
    ShopWalletService,
    { provide: PAYMENT_GATEWAY, useExisting: PaymentService },
  ],
  exports: [PAYMENT_GATEWAY, PaymentQueryApi, PaymentService, PayosService, PaymentAuditLogService, PaymentOutboxService, ShopWalletService],
})
export class PaymentModule {}
