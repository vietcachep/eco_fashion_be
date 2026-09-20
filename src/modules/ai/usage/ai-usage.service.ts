import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { BusinessException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { AI_ERR, TOKEN_PRICE_USD_PER_M } from '../foundation/ai.constants';

export interface UsageEntry {
  feature: string;
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs: number;
  success: boolean;
  userId?: string | null;
}

/*
 * Cổng chi phí AI: mọi lần gọi provider ghi một dòng `ai.usage_logs`; `assertBudget` chặn khi tổng token hôm nay
 * (giờ VN) vượt EF_AI_DAILY_TOKEN_BUDGET (0 = không giới hạn). Tính năng có đường lùi thì bắt lỗi BUDGET và dùng rule.
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async record(e: UsageEntry): Promise<void> {
    const price = TOKEN_PRICE_USD_PER_M[e.model] ?? TOKEN_PRICE_USD_PER_M.default;
    const cost = e.costUsd ?? ((e.tokensIn ?? 0) * price.in + (e.tokensOut ?? 0) * price.out) / 1_000_000;
    try {
      await this.prisma.aiUsageLog.create({ data: { feature: e.feature, provider: e.provider, model: e.model, tokensIn: e.tokensIn ?? 0, tokensOut: e.tokensOut ?? 0, costEstimate: new Prisma.Decimal(cost.toFixed(6)), durationMs: e.durationMs, success: e.success, userId: e.userId ?? null } });
    } catch (err) {
      this.logger.warn({ err, feature: e.feature }, 'Ghi usage_logs lỗi — bỏ qua');
    }
  }

  /* Tổng token đã dùng hôm nay (giờ VN). */
  async usedToday(): Promise<number> {
    const start = new Date(new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10) + 'T00:00:00+07:00');
    const agg = await this.prisma.aiUsageLog.aggregate({ where: { createdAt: { gte: start } }, _sum: { tokensIn: true, tokensOut: true } });
    return (agg._sum.tokensIn ?? 0) + (agg._sum.tokensOut ?? 0);
  }

  async assertBudget(): Promise<void> {
    const budget = this.env.EF_AI_DAILY_TOKEN_BUDGET;
    if (!budget) return;
    const used = await this.usedToday();
    if (used >= budget) throw new BusinessException(AI_ERR.BUDGET_EXCEEDED, 'Hạn mức AI hôm nay đã hết, vui lòng thử lại vào ngày mai', 429, { used: String(used), budget: String(budget) });
  }

  async summary(days = 14): Promise<{ budget: number; usedToday: number; byDay: Array<{ day: string; tokens: number; calls: number; cost: string }>; byFeature: Array<{ feature: string; tokens: number; calls: number; cost: string; failed: number }> }> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.aiUsageLog.findMany({ where: { createdAt: { gte: since } }, select: { feature: true, tokensIn: true, tokensOut: true, costEstimate: true, success: true, createdAt: true } });
    const byDay = new Map<string, { tokens: number; calls: number; cost: number }>();
    const byFeature = new Map<string, { tokens: number; calls: number; cost: number; failed: number }>();
    for (const r of rows) {
      const day = new Date(r.createdAt.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
      const d = byDay.get(day) ?? { tokens: 0, calls: 0, cost: 0 };
      d.tokens += r.tokensIn + r.tokensOut;
      d.calls += 1;
      d.cost += Number(r.costEstimate);
      byDay.set(day, d);
      const f = byFeature.get(r.feature) ?? { tokens: 0, calls: 0, cost: 0, failed: 0 };
      f.tokens += r.tokensIn + r.tokensOut;
      f.calls += 1;
      f.cost += Number(r.costEstimate);
      if (!r.success) f.failed += 1;
      byFeature.set(r.feature, f);
    }
    return {
      budget: this.env.EF_AI_DAILY_TOKEN_BUDGET,
      usedToday: await this.usedToday(),
      byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, tokens: v.tokens, calls: v.calls, cost: v.cost.toFixed(4) })),
      byFeature: [...byFeature.entries()].map(([feature, v]) => ({ feature, tokens: v.tokens, calls: v.calls, cost: v.cost.toFixed(4), failed: v.failed })),
    };
  }
}
