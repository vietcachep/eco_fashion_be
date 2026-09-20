import { Module } from '@nestjs/common';
import { PROMOTION_GATEWAY } from '@common/gateway/promotion.gateway';
import { CartModule } from '../cart/cart.module';
import { AdminPromotionController, PromotionController } from './promotion.controllers';
import { PromotionService } from './promotion.service';
import { PromotionQueryApi } from './queryapi/promotion.queryapi';

/* Module promotion (PLAN-0008): mã giảm giá. Export PROMOTION_GATEWAY (order quote/consume/release) + PromotionQueryApi (ai). */
@Module({
  imports: [CartModule],
  controllers: [PromotionController, AdminPromotionController],
  providers: [PromotionService, PromotionQueryApi, { provide: PROMOTION_GATEWAY, useExisting: PromotionService }],
  exports: [PROMOTION_GATEWAY, PromotionQueryApi],
})
export class PromotionModule {}
