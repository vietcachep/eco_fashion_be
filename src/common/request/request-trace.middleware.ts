import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { isIP } from 'node:net';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { RequestTraceContext } from './request-trace.context';

export const REQUEST_ID_HEADER = 'x-request-id';

/*
 * Gắn requestId + ip + userAgent cho MỌI request rồi chạy phần còn lại trong AsyncLocalStorage.
 * - requestId: lấy từ header X-Request-Id nếu client/gateway gửi (chỉ nhận tối đa 64 ký tự an toàn), không thì tự sinh;
 *   luôn trả lại ở response header để FE hiện mã tra lỗi.
 * - ip: đọc X-Forwarded-For theo SỐ proxy tin cậy (EF_TRUSTED_PROXY_COUNT) — header này client tự gõ được,
 *   nên chỉ tin phần tử thứ N tính từ phải; khai lớn hơn thực tế là rate limit/audit ghi IP giả.
 */
@Injectable()
export class RequestTraceMiddleware implements NestMiddleware {
  constructor(@Inject(ENV) private readonly env: Env) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const raw = req.header(REQUEST_ID_HEADER);
    const requestId = raw && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : RequestTraceContext.newRequestId();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const trace = {
      requestId,
      ip: this.clientIp(req),
      userAgent: (req.header('user-agent') ?? '').slice(0, 255),
    };
    RequestTraceContext.run(trace, () => next());
  }

  private clientIp(req: Request): string {
    const n = this.env.EF_TRUSTED_PROXY_COUNT;
    if (n > 0) {
      const xff = (req.header('x-forwarded-for') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const candidate = xff[xff.length - n];
      if (candidate && isIP(candidate)) return candidate;
    }
    const ip = req.socket?.remoteAddress ?? '';
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }
}
