import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from '@common/common.module';
import { LoggerModule } from '@common/logger/logger.module';
import { MailProcessor } from '@common/mail/mail.processor';
import { ConfigModule } from '@config/config.module';
import { PrismaModule } from '@common/prisma/prisma.module';
import { AiWorkerModule } from '@modules/ai/ai-worker.module';
import { IdentityModule } from '@modules/identity/identity.module';
import { IdentityWorkerModule } from '@modules/identity/identity-worker.module';
import { OrderWorkerModule } from '@modules/order/order-worker.module';
import { ProductWorkerModule } from '@modules/product/product-worker.module';
import { ReportingWorkerModule } from '@modules/reporting/reporting-worker.module';

/*
 * Lắp ráp WORKER: cùng code với API nhưng chỉ nạp processor BullMQ, relay outbox và job định kỳ.
 * Module nghiệp vụ cung cấp `XxxWorkerModule` (processor/relay/cron của module đó) — thêm dần theo roadmap.
 * Không mở HTTP (trừ health nội bộ nếu cần sau).
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    PrismaModule,
    CommonModule,
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    ScheduleModule.forRoot(),
    IdentityModule, // @Global: gateway UserDirectory/TokenValidation + IdentityQueryApi cho module worker khác
    IdentityWorkerModule,
    ProductWorkerModule,
    OrderWorkerModule,
    ReportingWorkerModule,
    AiWorkerModule,
  ],
  providers: [MailProcessor],
})
export class WorkerModule {}
