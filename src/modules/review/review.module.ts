import { Module } from '@nestjs/common';
import { ProductModule } from '../product/product.module';
import { AdminReviewController, ReviewController } from './review.controllers';
import { ReviewService } from './review.service';
import { ReviewQueryApi } from './queryapi/review.queryapi';

/* Module review (PLAN-0009). OrderQueryApi từ OrderModule (@Global). Export ReviewQueryApi cho ai (tóm tắt/kiểm duyệt). */
@Module({
  imports: [ProductModule],
  controllers: [ReviewController, AdminReviewController],
  providers: [ReviewService, ReviewQueryApi],
  exports: [ReviewQueryApi],
})
export class ReviewModule {}
