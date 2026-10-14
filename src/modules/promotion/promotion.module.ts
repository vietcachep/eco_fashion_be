import { Module } from '@nestjs/common';
import { PROMOTION_GATEWAY } from '@common/gateway/promotion.gateway';
import { ShopModule } from '@modules/shop/shop.module';
import { CartModule } from '../cart/cart.module';
import { AdminPromotionController, PromotionController } from './promotion.controllers';
import { PromotionService } from './promotion.service';
import { ShopPromotionController } from './shop-promotion.controller';
import { PromotionQueryApi } from './queryapi/promotion.queryapi';

/* Module promotion (PLAN-0008/0017): mã giảm giá sàn + gian hàng. Export PROMOTION_GATEWAY (order quote/consume/release) + PromotionQueryApi (ai). */
@Module({
  imports: [CartModule, ShopModule],
  controllers: [PromotionController, AdminPromotionController, ShopPromotionController],
  providers: [PromotionService, PromotionQueryApi, { provide: PROMOTION_GATEWAY, useExisting: PromotionService }],
  exports: [PROMOTION_GATEWAY, PromotionQueryApi],
})
export class PromotionModule {}
