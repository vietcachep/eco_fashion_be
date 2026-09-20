import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { PrismaClient } from '../../generated/prisma/client';

/*
 * MỘT PrismaClient cho toàn app (API + worker + script), driver adapter pg (Prisma 7).
 * - Kết nối lúc onModuleInit để lỗi DB lộ ngay khi boot, không đợi request đầu.
 * - Module nghiệp vụ tiêm PrismaService vào `repository/` của mình và CHỈ được dùng model thuộc schema
 *   của module đó (test `prisma-boundaries.spec.ts` gác). Transaction: `prisma.$transaction(async (tx) => …)`.
 * - Log query chỉ ở development; không bao giờ log tham số chứa mật khẩu/token (Prisma log 'query' không in
 *   giá trị tham số ở mức mặc định — giữ nguyên).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ENV) env: Env) {
    super({
      adapter: new PrismaPg({ connectionString: env.EF_DATABASE_URL, max: env.NODE_ENV === 'test' ? 5 : 20 }),
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Đã kết nối PostgreSQL (Prisma)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
