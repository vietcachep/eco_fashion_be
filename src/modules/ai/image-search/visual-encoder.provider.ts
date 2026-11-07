import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { normaliseVisualVector } from './visual.types';

/* Encoder ảnh nội bộ: không gọi OpenAI embedding văn bản, giới hạn thời gian/lô và chốt model-version. */
@Injectable()
export class VisualEncoderProvider {
  constructor(@Inject(ENV) private readonly env: Env) {}
  get configured(): boolean {
    return !!this.env.EF_VISUAL_ENCODER_URL && !!this.env.EF_VISUAL_ENCODER_TOKEN;
  }
  get modelVersion(): string {
    return this.env.EF_VISUAL_MODEL_VERSION;
  }
  async embed(images: Array<{ buffer: Buffer; mimetype: string }>): Promise<number[][]> {
    if (
      !this.configured ||
      images.length < 1 ||
      images.length > 4 ||
      images.some((i) => i.buffer.length > 5 * 1024 * 1024)
    )
      throw new Error('Encoder ảnh chưa sẵn sàng');
    const response = await fetch(`${this.env.EF_VISUAL_ENCODER_URL.replace(/\/$/, '')}/v1/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.env.EF_VISUAL_ENCODER_TOKEN}`,
      },
      body: JSON.stringify({ images: images.map((i) => i.buffer.toString('base64')) }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Encoder ảnh không phản hồi (${response.status})`);
    const result = (await response.json()) as { modelVersion?: string; vectors?: unknown[] };
    if (
      result.modelVersion !== this.modelVersion ||
      !Array.isArray(result.vectors) ||
      result.vectors.length !== images.length
    )
      throw new Error('Encoder ảnh khác phiên bản chỉ mục');
    return result.vectors.map(normaliseVisualVector);
  }
}
