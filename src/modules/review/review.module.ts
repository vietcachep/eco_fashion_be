import { Module } from '@nestjs/common';
import { ProductModule } from '../product/product.module';
import { ShopModule } from '../shop/shop.module';
import { AdminReviewController, ReviewController } from './review.controllers';
import { ShopReviewController } from './shop-review.controller';
import { ReviewService } from './review.service';
import { ReviewQueryApi } from './queryapi/review.queryapi';

/* Module review (PLAN-0009). OrderQueryApi từ OrderModule (@Global). Export ReviewQueryApi cho ai (tóm tắt/kiểm duyệt). */
@Module({
  imports: [ProductModule, ShopModule],
  controllers: [ReviewController, AdminReviewController, ShopReviewController],
  providers: [ReviewService, ReviewQueryApi],
  exports: [ReviewQueryApi],
})
export class ReviewModule {}
