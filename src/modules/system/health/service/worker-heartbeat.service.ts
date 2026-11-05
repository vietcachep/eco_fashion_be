import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '@common/redis/redis.module';
import { withTimeout } from './with-timeout';

/* Khoá Redis chứa nhịp tim của worker. Quy ước `ef:<module>:<mục đích>` (xem CacheService). */
export const WORKER_HEARTBEAT_KEY = 'ef:system:worker-heartbeat';
/* Worker ghi nhịp mỗi 5 giây… */
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
/* …và coi là "chết" khi nhịp cuối cũ hơn 60 giây (12 nhịp liên tiếp mất — đủ rộng để Redis khởi động lại / deploy mà không báo oan). */
export const WORKER_HEARTBEAT_STALE_MS = 60_000;
/* TTL của khoá dài hơn ngưỡng "chết" để còn đọc được `lastSeenAt` khi worker vừa chết (chẩn đoán); health vẫn quyết định theo tuổi nhịp, không theo việc khoá còn hay hết. */
const KEY_TTL_SECONDS = 600;
const READ_TIMEOUT_MS = 1_500;

export type WorkerStatus = 'UP' | 'DOWN' | 'UNKNOWN';

/* Giá trị khoá là JSON `{at: ISO, pid}`; rác (không phải JSON / thiếu `at` / `at` không phải ngày) ⇒ NaN ⇒ coi như chưa có nhịp. */
function parseBeatTime(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { at?: unknown };
    return typeof parsed.at === 'string' ? Date.parse(parsed.at) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

export interface WorkerHeartbeatState {
  /* UP = nhịp mới; DOWN = chưa từng có / quá hạn; UNKNOWN = không đọc được Redis (không thể kết luận — Redis DOWN đã tự làm /health đỏ). */
  status: WorkerStatus;
  lastSeenAt: string | null;
}

/*
 * Nhịp tim của worker (PLAN-0029 §2.4, AUD-12a / OPS-01y). Worker là tiến trình riêng KHÔNG mở cổng HTTP — nó chết thì job nền,
 * email, outbox, huỷ đơn quá hạn… dừng IM LẶNG trong khi `/health` của API vẫn xanh. Giải pháp: worker ghi dấu thời gian vào Redis
 * theo chu kỳ (`WorkerHeartbeatJob`), API đọc lại ở `/health` và `/health/worker`.
 * Dùng Redis (không phải DB) vì: không cần migration, ghi nhịp không tốn kết nối/khoá Postgres, và vẫn ghi được khi Postgres đang sự cố
 * (để phân biệt "DB chết" với "worker chết"). Nhiều worker cùng ghi một khoá: chỉ cần MỘT worker còn sống là xanh.
 */
@Injectable()
export class WorkerHeartbeatService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /* Worker gọi mỗi nhịp. Lỗi Redis ném lên để job tự ghi log. */
  async beat(now: Date = new Date()): Promise<void> {
    await this.redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: now.toISOString(), pid: process.pid }), 'EX', KEY_TTL_SECONDS);
  }

  /* API gọi mỗi lần health. Không bao giờ ném. */
  async read(now: Date = new Date()): Promise<WorkerHeartbeatState> {
    let raw: string | null;
    try {
      raw = await withTimeout(this.redis.get(WORKER_HEARTBEAT_KEY), READ_TIMEOUT_MS, 'worker-heartbeat');
    } catch {
      return { status: 'UNKNOWN', lastSeenAt: null };
    }
    if (!raw) return { status: 'DOWN', lastSeenAt: null };
    const seen = parseBeatTime(raw);
    if (Number.isNaN(seen)) return { status: 'DOWN', lastSeenAt: null };
    return { status: now.getTime() - seen <= WORKER_HEARTBEAT_STALE_MS ? 'UP' : 'DOWN', lastSeenAt: new Date(seen).toISOString() };
  }
}
