import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { RequestTraceContext } from '../request/request-trace.context';

/*
 * Log JSON bằng pino (AGENTS.md — Logging Rule). Mỗi dòng có `requestId` từ RequestTraceContext nên tra được
 * xuyên API → audit → outbox → worker. Dev in đẹp bằng pino-pretty; production JSON thuần.
 * Che tự động header authorization/cookie và các field nhạy cảm nếu lỡ lọt vào object log.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.EF_LOG_LEVEL,
          autoLogging: env.NODE_ENV !== 'test',
          transport:
            env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } }
              : undefined,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              '*.password',
              '*.refreshToken',
              '*.accessToken',
              '*.otp',
              '*.secret',
            ],
            censor: '***',
          },
          customProps: () => ({ requestId: RequestTraceContext.currentRequestId() || undefined }),
          serializers: {
            req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
