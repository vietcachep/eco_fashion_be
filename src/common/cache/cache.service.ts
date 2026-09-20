import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

export interface CacheSpec {
  /* Module chủ quản (thành phần key) — ví dụ 'catalog'. */
  module: string;
  /* Mục đích — ví dụ 'category-tree'. */
  purpose: string;
  /* TTL giây; jitter ±10% tự thêm để tránh avalanche. */
  ttlSeconds: number;
}

/*
 * Cache-Aside trên Redis (AGENTS.md — Cache Strategy Rule). Key `ef:<module>:<purpose>:<khoá>` có TTL + jitter.
 * - `getOrSet`: miss → loader → SET; có single-flight nhẹ (SET NX 10s) để một hot key hết hạn không kéo N rebuild.
 * - `del/delByPrefix`: gọi SAU khi commit DB (xoá key, không cập nhật giá trị).
 * - Redis lỗi → hoạt động như không có cache (log warn) — cache không được làm hỏng nghiệp vụ.
 * KHÔNG dùng cho tồn kho quyết định bán, tiền, trạng thái đơn, giỏ.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  key(spec: CacheSpec, id: string): string {
    return `ef:${spec.module}:${spec.purpose}:${id}`;
  }

  async get<T>(spec: CacheSpec, id: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(this.key(spec, id));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn({ err, key: this.key(spec, id) }, 'Redis GET lỗi — coi như cache miss');
      return null;
    }
  }

  async set(spec: CacheSpec, id: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? spec.ttlSeconds;
    const jitter = Math.round(ttl * (0.9 + Math.random() * 0.2));
    try {
      await this.redis.set(this.key(spec, id), JSON.stringify(value), 'EX', Math.max(1, jitter));
    } catch (err) {
      this.logger.warn({ err, key: this.key(spec, id) }, 'Redis SET lỗi — bỏ qua');
    }
  }

  async getOrSet<T>(spec: CacheSpec, id: string, loader: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(spec, id);
    if (hit !== null) return hit;
    const lockKey = `${this.key(spec, id)}:lock`;
    let locked: boolean;
    try {
      locked = (await this.redis.set(lockKey, '1', 'EX', 10, 'NX')) === 'OK';
    } catch {
      locked = true; // Redis lỗi thì cứ tự nạp
    }
    if (!locked) {
      // Instance khác đang nạp — đợi ngắn rồi thử đọc lại, không có thì tự nạp (không chờ vô hạn).
      await new Promise((r) => setTimeout(r, 150));
      const again = await this.get<T>(spec, id);
      if (again !== null) return again;
    }
    const value = await loader();
    await this.set(spec, id, value);
    if (locked) await this.redis.del(lockKey).catch(() => undefined);
    return value;
  }

  async del(spec: CacheSpec, ...ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.redis.del(...ids.map((i) => this.key(spec, i)));
    } catch (err) {
      this.logger.warn({ err }, 'Redis DEL lỗi — key cũ sẽ tự hết hạn theo TTL');
    }
  }

  async delByPrefix(spec: CacheSpec): Promise<void> {
    const pattern = `ef:${spec.module}:${spec.purpose}:*`;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn({ err, pattern }, 'Redis SCAN/DEL lỗi — key cũ sẽ tự hết hạn theo TTL');
    }
  }
}
