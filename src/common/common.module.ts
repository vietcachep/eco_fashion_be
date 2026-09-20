import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { CacheService } from './cache/cache.service';
import { GlobalExceptionFilter } from './exception/global-exception.filter';
import { MailModule } from './mail/mail.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { PermissionGuard } from './security/permission.guard';
import { RateLimitGuard } from './security/rate-limit.guard';
import { StorageModule } from './storage/storage.module';

/*
 * Nền tảng dùng chung (AGENTS.md — common mỏng, không business logic):
 * Redis · BullMQ · Mail · Storage · Cache · JwtModule · filter lỗi toàn cục · guard xác thực/phân quyền/hạn mức.
 * Thứ tự guard: JwtAuthGuard (gắn actor) → PermissionGuard (mã quyền) → RateLimitGuard (khoá theo user/ip).
 * PermissionGuard/JwtAuthGuard hỏi cổng do identity cài — tiêm ở IdentityModule (provider global).
 */
@Global()
@Module({
  imports: [
    RedisModule,
    QueueModule,
    MailModule,
    StorageModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.EF_JWT_SECRET,
        signOptions: { expiresIn: env.EF_ACCESS_TOKEN_TTL_SECONDS, issuer: env.EF_APP_NAME },
      }),
    }),
  ],
  providers: [
    CacheService,
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [CacheService, JwtModule],
})
export class CommonModule {}
