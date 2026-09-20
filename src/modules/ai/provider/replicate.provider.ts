import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { BusinessException } from '@common/exception/business.exception';
import { AI_ERR } from '../foundation/ai.constants';

export interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: unknown;
  error?: string | null;
}

/*
 * Bọc REST API Replicate (thử đồ 2D IDM-VTON) — CHỖ DUY NHẤT dùng EF_REPLICATE_API_TOKEN. Token chỉ vào header
 * Authorization, không bao giờ log. Không token → `isConfigured=false` → API trả 503 rõ ràng.
 */
@Injectable()
export class ReplicateProvider {
  private readonly logger = new Logger(ReplicateProvider.name);
  private static readonly BASE = 'https://api.replicate.com/v1';

  constructor(@Inject(ENV) private readonly env: Env) {
    if (!env.EF_REPLICATE_API_TOKEN) this.logger.warn('EF_REPLICATE_API_TOKEN trống — thử đồ 2D tắt (503 AI_TRYON_NOT_CONFIGURED)');
  }

  get isConfigured(): boolean {
    return Boolean(this.env.EF_REPLICATE_API_TOKEN);
  }

  get model(): string {
    return this.env.EF_REPLICATE_TRYON_MODEL;
  }

  private headers(): Record<string, string> {
    if (!this.env.EF_REPLICATE_API_TOKEN) throw new BusinessException(AI_ERR.TRYON_NOT_CONFIGURED, 'Thử đồ 2D chưa được cấu hình', 503);
    return { Authorization: `Bearer ${this.env.EF_REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' };
  }

  /* Tạo prediction theo `owner/name:version` (env) — input theo IDM-VTON: human_img, garm_img, garment_des, category. */
  async createPrediction(input: Record<string, unknown>): Promise<ReplicatePrediction> {
    const [, version] = this.model.split(':');
    const body = version ? { version, input } : { input };
    const url = version ? `${ReplicateProvider.BASE}/predictions` : `${ReplicateProvider.BASE}/models/${this.model}/predictions`;
    const res = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn({ status: res.status, body: text.slice(0, 300) }, 'Replicate tạo prediction lỗi');
      throw new BusinessException(AI_ERR.PROVIDER_FAILED, `Replicate từ chối yêu cầu (${res.status})`, 503);
    }
    return (await res.json()) as ReplicatePrediction;
  }

  async getPrediction(id: string): Promise<ReplicatePrediction> {
    const res = await fetch(`${ReplicateProvider.BASE}/predictions/${encodeURIComponent(id)}`, { headers: this.headers() });
    if (!res.ok) throw new BusinessException(AI_ERR.PROVIDER_FAILED, `Replicate không trả trạng thái (${res.status})`, 503);
    return (await res.json()) as ReplicatePrediction;
  }

  async cancel(id: string): Promise<void> {
    try {
      await fetch(`${ReplicateProvider.BASE}/predictions/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: this.headers() });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, id }, 'Huỷ prediction lỗi — bỏ qua');
    }
  }
}
