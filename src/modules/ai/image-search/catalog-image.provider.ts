import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';

/* Chỉ tải ảnh từ origin catalog đã cấu hình; không theo redirect hay nhận URL từ AI/query người dùng. */
@Injectable()
export class CatalogImageProvider {
  constructor(@Inject(ENV) private readonly env: Env) {}
  resolve(source: string): URL {
    const allowed = [this.env.EF_API_PUBLIC_URL, ...this.env.EF_VISUAL_IMAGE_ORIGINS.split(',')]
      .filter(Boolean)
      .map((s) => new URL(s.trim()).origin);
    if (!source.startsWith('/static/') && !/^https?:\/\//i.test(source))
      throw new Error('Đường dẫn ảnh không được phép');
    const url = new URL(source, this.env.EF_API_PUBLIC_URL);
    if (url.username || url.password || !allowed.includes(url.origin))
      throw new Error('Origin ảnh không được phép');
    return url;
  }
  async download(source: string): Promise<{ buffer: Buffer; mimetype: string }> {
    const url = this.resolve(source);
    const internal = this.env.EF_VISUAL_CATALOG_BASE_URL;
    const downloadUrl = internal && url.origin === new URL(this.env.EF_API_PUBLIC_URL).origin ? new URL(url.pathname + url.search, internal) : url;
    const response = await fetch(downloadUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const mimetype = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(mimetype) || !response.body) {
      await response.body?.cancel();
      throw new Error('Không tải được ảnh catalog hợp lệ');
    }
    const limit = 5 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body.cancel();
      throw new Error('Ảnh catalog quá lớn');
    }
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > limit) throw new Error('Ảnh catalog quá lớn');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return { buffer: Buffer.concat(chunks), mimetype };
  }
}
