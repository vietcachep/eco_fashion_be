/*
 * Ảnh seed → URL dùng được (AGENTS.md — Seed Rule: kèm ảnh, chạy lại không tạo trùng).
 * - Có Cloudinary: upload `scripts/seed/assets/<path>` với public_id CỐ ĐỊNH `ecofashion/seed/<path không đuôi>`;
 *   đã có trên Cloudinary → lấy URL sẵn, không upload lại (cloudinary.api.resource).
 * - Không có Cloudinary: trả URL tĩnh `${EF_API_PUBLIC_URL}/static/seed/<path>` (API phục vụ thư mục assets).
 */
import { v2 as cloudinary } from 'cloudinary';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Env } from '../../../src/config/env';

export const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

export class SeedImages {
  private readonly configured: boolean;
  private readonly cache = new Map<string, { url: string; publicId: string | null }>();

  constructor(private readonly env: Env) {
    this.configured = Boolean(env.EF_CLOUDINARY_CLOUD_NAME && env.EF_CLOUDINARY_API_KEY && env.EF_CLOUDINARY_API_SECRET);
    if (this.configured) {
      cloudinary.config({ cloud_name: env.EF_CLOUDINARY_CLOUD_NAME, api_key: env.EF_CLOUDINARY_API_KEY, api_secret: env.EF_CLOUDINARY_API_SECRET, secure: true });
    }
  }

  get mode(): string {
    return this.configured ? 'Cloudinary' : 'tĩnh (/static/seed)';
  }

  /* `rel` = đường dẫn tương đối trong assets, vd `product/ao-thun-cotton-nam-basic/main.jpg`. */
  async resolve(rel: string): Promise<{ url: string; publicId: string | null }> {
    const hit = this.cache.get(rel);
    if (hit) return hit;
    const file = path.join(ASSETS_DIR, rel);
    if (!fs.existsSync(file)) throw new Error(`Thiếu ảnh seed: ${rel}`);
    let out: { url: string; publicId: string | null };
    if (!this.configured) {
      out = { url: `${this.env.EF_API_PUBLIC_URL.replace(/\/$/, '')}/static/seed/${rel.replace(/\\/g, '/')}`, publicId: null };
    } else {
      const publicId = `ecofashion/seed/${rel.replace(/\\/g, '/').replace(/\.[a-z0-9]+$/i, '')}`;
      const existing = (await cloudinary.api.resource(publicId).catch(() => null)) as { secure_url?: string } | null;
      if (existing?.secure_url) {
        out = { url: existing.secure_url, publicId };
      } else {
        const r = await cloudinary.uploader.upload(file, { public_id: publicId, overwrite: false, resource_type: 'image' });
        out = { url: r.secure_url, publicId };
      }
    }
    this.cache.set(rel, out);
    return out;
  }
}
