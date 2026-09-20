import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';

export const QUEUE = { DEFAULT: 'default', MAIL: 'mail', AI: 'ai' } as const;

/*
 * BullMQ trên Redis — ba hàng đợi tách riêng để job dài (AI, gọi OpenAI hàng chục giây) không chặn
 * job ngắn (mail, dọn dẹp). Worker (src/worker.ts) đăng ký processor; API chỉ enqueue.
 * Job mặc định retry 3 lần backoff mũ; giữ 1000 job xong / 5000 job lỗi để soi.
 */
function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    username: u.username || undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
  };
}

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        connection: redisConnection(env.EF_REDIS_URL),
        prefix: 'ef',
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      }),
    }),
    BullModule.registerQueue({ name: QUEUE.DEFAULT }, { name: QUEUE.MAIL }, { name: QUEUE.AI }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
