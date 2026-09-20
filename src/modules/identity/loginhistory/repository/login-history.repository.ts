import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { RequestTraceContext } from '@common/request/request-trace.context';

export interface LoginHistoryInput {
  userId: string | null;
  email: string;
  success: boolean;
  reason: string | null;
}

/* Bảng identity.login_histories — ghi mọi lần đăng nhập (thành/bại) kèm ip/ua từ ngữ cảnh request. */
@Injectable()
export class LoginHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(tx: Tx | null, input: LoginHistoryInput): Promise<void> {
    const trace = RequestTraceContext.current();
    await (tx ?? this.prisma).loginHistory.create({
      data: { ...input, ipAddress: trace?.ip || null, userAgent: trace?.userAgent || null },
    });
  }

  async list(params: { skip: number; take: number; email?: string; userId?: string; success?: boolean }) {
    const where = {
      ...(params.email ? { email: { contains: params.email, mode: 'insensitive' as const } } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.success !== undefined ? { success: params.success } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.loginHistory.findMany({ where, skip: params.skip, take: params.take, orderBy: { createdAt: 'desc' } }),
      this.prisma.loginHistory.count({ where }),
    ]);
    return { items, total };
  }

  async purgeOlderThan(date: Date): Promise<number> {
    const r = await this.prisma.loginHistory.deleteMany({ where: { createdAt: { lt: date } } });
    return r.count;
  }
}
