import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from '@common/common.module';
import { LoggerModule } from '@common/logger/logger.module';
import { RequestTraceMiddleware } from '@common/request/request-trace.middleware';
import { ConfigModule } from '@config/config.module';
import { PrismaModule } from '@common/prisma/prisma.module';
import { AiModule } from '@modules/ai/ai.module';
import { CartModule } from '@modules/cart/cart.module';
import { CatalogModule } from '@modules/catalog/catalog.module';
import { IdentityModule } from '@modules/identity/identity.module';
import { OrderModule } from '@modules/order/order.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { ProductModule } from '@modules/product/product.module';
import { PromotionModule } from '@modules/promotion/promotion.module';
import { ReportingModule } from '@modules/reporting/reporting.module';
import { ReviewModule } from '@modules/review/review.module';
import { SystemModule } from '@modules/system/system.module';

/*
 * Lắp ráp runtime API. Thứ tự import: config → logger → prisma → common (guard/filter) → module nghiệp vụ.
 * Module nghiệp vụ được thêm dần theo roadmap (identity, catalog, product, cart, order, payment, promotion,
 * review, reporting, ai). Job định kỳ/queue processor nằm ở WorkerModule, KHÔNG ở đây — API không chạy job nền.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    PrismaModule,
    CommonModule,
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    ScheduleModule.forRoot(),
    SystemModule,
    IdentityModule,
    CatalogModule,
    ProductModule,
    CartModule,
    PromotionModule,
    PaymentModule,
    OrderModule,
    ReviewModule,
    ReportingModule,
    AiModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestTraceMiddleware).forRoutes('{*splat}');
  }
}
