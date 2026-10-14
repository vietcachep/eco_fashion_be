import { Module } from '@nestjs/common';
import { OrderModule } from '@modules/order/order.module';
import { ShopModule } from '@modules/shop/shop.module';
import { SystemModule } from '@modules/system/system.module';
import { PaymentModule } from './payment.module';
import { ShopPayoutController } from './shop-payout/controller/shop-payout.controller';
import { ShopPayoutService } from './shop-payout/shop-payout.service';

/*
 * Đối soát chi trả shop (payout) — tách khỏi PaymentModule vì cần OrderQueryApi mà OrderModule đã import PaymentModule (tránh vòng).
 * Dùng PayosService + audit/outbox của PaymentModule; đọc đơn qua OrderQueryApi, bank shop qua ShopQueryApi.
 */
@Module({
  imports: [PaymentModule, OrderModule, ShopModule, SystemModule],
  controllers: [ShopPayoutController],
  providers: [ShopPayoutService],
})
export class PaymentSettlementModule {}
