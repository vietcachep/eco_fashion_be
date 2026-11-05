import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '@common/prisma/prisma.service';
import { REDIS } from '@common/redis/redis.module';
import { HealthResponse, WorkerHealthResponse } from '../dto/health.response';
import { withTimeout } from './with-timeout';
import { WORKER_HEARTBEAT_STALE_MS, WorkerHeartbeatService } from './worker-heartbeat.service';

/* Mỗi phép kiểm tối đa 2 giây: healthcheck bị LB gọi liên tục nên không được treo khi hạ tầng sập. */
const CHECK_TIMEOUT_MS = 2_000;

/* API còn phục vụ được đúng không? DB hoặc Redis DOWN ⇒ không (đăng nhập, phiên, giới hạn tốc độ, giữ kho đều cần) ⇒ controller trả HTTP 503. Worker DOWN thì KHÔNG: API vẫn nhận đơn, chỉ job nền dừng. */
export function isApiServing(h: Pick<HealthResponse, 'database' | 'redis'>): boolean {
  return h.database === 'UP' && h.redis === 'UP';
}

/*
 * Kiểm sức khoẻ: ping DB (SELECT 1), Redis (PING) và nhịp tim worker (khoá Redis do worker ghi — AUD-12a).
 * - `status` = UP chỉ khi cả ba ổn, ngược lại DEGRADED.
 * - HTTP 503 do controller quyết định bằng `isApiServing` (DB/Redis DOWN) để load balancer/uptime monitor thấy được sự cố thật,
 *   thay vì 200 + body báo lỗi như trước. Worker DOWN giữ HTTP 200 (kéo API khỏi LB vì worker chết là sai) nhưng body báo rõ.
 * - Mỗi phép kiểm có timeout 2 giây.
 * Không cần đăng nhập (@Public ở controller) để load balancer/compose healthcheck gọi được.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly heartbeat: WorkerHeartbeatService,
  ) {}

  async check(): Promise<HealthResponse> {
    const [database, redis, worker] = await Promise.all([this.checkDb(), this.checkRedis(), this.heartbeat.read()]);
    return {
      status: database === 'UP' && redis === 'UP' && worker.status !== 'DOWN' ? 'UP' : 'DEGRADED',
      database,
      redis,
      worker: worker.status,
      workerLastSeenAt: worker.lastSeenAt,
      version: process.env.npm_package_version ?? '0.1.0',
      timestamp: new Date().toISOString(),
    };
  }

  /* Riêng worker — `GET /health/worker` trả 503 khi không phải UP (DOWN hoặc không xác minh được). */
  async checkWorker(): Promise<WorkerHealthResponse> {
    const worker = await this.heartbeat.read();
    return { status: worker.status, lastSeenAt: worker.lastSeenAt, staleAfterSeconds: WORKER_HEARTBEAT_STALE_MS / 1000, timestamp: new Date().toISOString() };
  }

  private async checkDb(): Promise<'UP' | 'DOWN'> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS, 'postgres');
      return 'UP';
    } catch (err) {
      this.logger.error({ err }, 'PostgreSQL không phản hồi');
      return 'DOWN';
    }
  }

  private async checkRedis(): Promise<'UP' | 'DOWN'> {
    try {
      return (await withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS, 'redis')) === 'PONG' ? 'UP' : 'DOWN';
    } catch {
      return 'DOWN';
    }
  }
}
