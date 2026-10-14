import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { PrismaService } from '@common/prisma/prisma.service';
import { REVIEW_MODULE } from './enums/review-events';

/*
 * Relay outbox review: mỗi 3s claim event PENDING/FAILED tới hạn và phát qua EventEmitter
 * `outbox.review.<EVENT_TYPE>` (listener cùng process worker). Chỉ WorkerModule nạp — API không chạy job nền.
 * PLAN-0014 bước 5b: shop listener đăng ký REVIEW_CREATED để tính lại Shop.ratingAvg.
 */
@Injectable()
export class ReviewOutboxRelayJob implements OnModuleInit {
  private readonly logger = new Logger(ReviewOutboxRelayJob.name);
  private relay!: OutboxRelay;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.relay = new OutboxRelay(this.prisma, REVIEW_MODULE, async (msg) => {
      await this.emitter.emitAsync(`outbox.${REVIEW_MODULE}.${msg.eventType}`, msg);
    });
  }

  @Interval(3000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.relay.poll();
      if (n > 0) this.logger.debug({ n }, 'Đã relay outbox review');
    } catch (err) {
      this.logger.error({ err }, 'Relay outbox review lỗi');
    } finally {
      this.running = false;
    }
  }
}

/* Phần worker của review: relay outbox. Chỉ WorkerModule import. */
@Module({
  providers: [ReviewOutboxRelayJob],
})
export class ReviewWorkerModule {}
