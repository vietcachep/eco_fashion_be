import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import Redis from 'ioredis';
import { BusinessException } from '../exception/business.exception';
import { REDIS } from '../redis/redis.module';
import { RequestTraceContext } from '../request/request-trace.context';
import { RequestWithActor } from './decorators';

export const RATE_LIMIT_KEY = 'ef:rate-limit';

export interface RateLimitSpec {
  /* Tên nhóm — thành phần của key Redis; mỗi endpoint nhạy cảm một tên. */
  name: string;
  /* Số request tối đa trong cửa sổ. */
  limit: number;
  /* Cửa sổ (giây). */
  windowSeconds: number;
  /* Khoá theo user (đã đăng nhập) hay theo IP. Mặc định: user nếu có, không thì IP. */
  by?: 'ip' | 'user' | 'auto';
}

/*
 * Giới hạn số request cho endpoint nhạy cảm (đăng nhập, OTP, refresh, chat AI, upload, webhook…).
 * @nestjs/throttler chưa hỗ trợ Nest 12 nên tự làm bằng Redis INCR + EXPIRE (cửa sổ cố định) —
 * đủ cho "narrow temporary protection" (AGENTS.md — Rate Limit Rule); gateway sau này sẽ thay.
 */
export const RateLimit = (spec: RateLimitSpec) => SetMetadata(RATE_LIMIT_KEY, spec);

export class RateLimitedException extends BusinessException {
  constructor(retryAfterSeconds: number) {
    super(
      'COMMON_RATE_LIMITED',
      'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút',
      HttpStatus.TOO_MANY_REQUESTS,
      {
        retryAfterSeconds: String(retryAfterSeconds),
      },
    );
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.getAllAndOverride<RateLimitSpec | undefined>(RATE_LIMIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!spec) return true;
    const req = ctx.switchToHttp().getRequest<RequestWithActor>();
    const trace = RequestTraceContext.current();
    const by = spec.by ?? 'auto';
    const ipKey = `ip:${trace?.ip ?? ''}`;
    const subject = by !== 'ip' && req.actor ? `user:${req.actor.userId}` : ipKey;
    const key = `ef:rl:${spec.name}:${subject}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, spec.windowSeconds);
      if (count > spec.limit) {
        const ttl = await this.redis.ttl(key);
        this.logger.warn({ key: spec.name, subject }, 'Vượt hạn mức request');
        throw new RateLimitedException(Math.max(1, ttl));
      }
      return true;
    } catch (err) {
      if (err instanceof RateLimitedException) throw err;
      // Redis lỗi → không chặn (đường lùi), log warn — hạn mức là lớp bảo vệ phụ, không phải kiểm quyền.
      this.logger.warn({ err }, 'Redis lỗi khi kiểm hạn mức — bỏ qua kiểm tra');
      return true;
    }
  }
}
