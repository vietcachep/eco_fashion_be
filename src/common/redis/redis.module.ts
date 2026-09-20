import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';

export const REDIS = Symbol('REDIS');

/*
 * Một client ioredis dùng chung cho cache, rate limit, blacklist token, khoá single-flight.
 * BullMQ tự tạo kết nối riêng (không dùng chung client này vì BullMQ cần blocking commands).
 * Redis KHÔNG phải nguồn sự thật: mọi nơi dùng phải có đường lùi khi Redis lỗi (bắt lỗi, log warn, đi tiếp).
 */
@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env): Redis => {
        const logger = new Logger('Redis');
        const client = new Redis(env.EF_REDIS_URL, {
          lazyConnect: false,
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
          retryStrategy: (times) => Math.min(times * 200, 5000),
        });
        client.on('error', (err: Error) =>
          logger.warn({ err }, 'Redis lỗi kết nối — các tính năng cache/hạn mức tạm lùi'),
        );
        return client;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
