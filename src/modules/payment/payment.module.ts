import { Module } from '@nestjs/common';
import { PAYMENT_GATEWAY } from '@common/gateway/payment.gateway';
import { AdminPaymentController, PaymentController, PaymentPublicController } from './payment/payment.controllers';
import { PaymentService } from './payment/payment.service';
import { PaymentQueryApi } from './queryapi/payment.queryapi';
import { VnpayService } from './vnpay/vnpay.service';

/*
 * Module payment (PLAN-0007): COD · chuyển khoản VietQR · VNPay. Export PAYMENT_GATEWAY + PaymentQueryApi cho order.
 * Cần ORDER_PAYMENT_GATEWAY do OrderModule (@Global) cung cấp — không import OrderModule để tránh vòng.
 */
@Module({
  controllers: [PaymentPublicController, PaymentController, AdminPaymentController],
  providers: [VnpayService, PaymentService, PaymentQueryApi, { provide: PAYMENT_GATEWAY, useExisting: PaymentService }],
  exports: [PAYMENT_GATEWAY, PaymentQueryApi],
})
export class PaymentModule {}
