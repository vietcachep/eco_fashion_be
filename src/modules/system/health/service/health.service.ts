import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '@common/prisma/prisma.service';
import { REDIS } from '@common/redis/redis.module';
import { HealthResponse } from '../dto/health.response';

/*
 * Kiểm sức khoẻ: ping DB (SELECT 1) và Redis (PING). Redis DOWN → DEGRADED (app vẫn chạy được nhờ đường lùi),
 * DB DOWN → DEGRADED nhưng thực tế app không phục vụ được — orchestrator nên dựa vào `database`.
 * Không cần đăng nhập (@Public ở controller) để load balancer/compose healthcheck gọi được.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    return {
      status: database === 'UP' && redis === 'UP' ? 'UP' : 'DEGRADED',
      database,
      redis,
      version: process.env.npm_package_version ?? '0.1.0',
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDb(): Promise<'UP' | 'DOWN'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'UP';
    } catch (err) {
      this.logger.error({ err }, 'PostgreSQL không phản hồi');
      return 'DOWN';
    }
  }

  private async checkRedis(): Promise<'UP' | 'DOWN'> {
    try {
      return (await this.redis.ping()) === 'PONG' ? 'UP' : 'DOWN';
    } catch {
      return 'DOWN';
    }
  }
}
