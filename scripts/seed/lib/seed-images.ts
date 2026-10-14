/*
 * Ảnh seed → URL dùng được (AGENTS.md — Seed Rule: kèm ảnh, chạy lại không tạo trùng).
 * - Có Cloudinary: upload `scripts/seed/assets/<path>` với public_id CỐ ĐỊNH `ecofashion/seed/<path không đuôi>`.
 *   Hàng trăm ảnh mà gọi Admin API (`api.resource`) từng ảnh sẽ chạm hạn mức 500 lệnh/giờ ⇒ dùng MANIFEST cache
 *   `assets/.cloudinary-manifest.json` (đường dẫn → url + sha1 nội dung): file không đổi thì không gọi mạng; chưa có trong
 *   manifest thì HEAD URL CDN (không tính hạn mức) — đã có trên Cloudinary thì dùng luôn, chưa có mới upload.
 * - Không có Cloudinary: trả URL tĩnh `${EF_API_PUBLIC_URL}/static/seed/<path>` (API phục vụ thư mục assets).
 */
import { v2 as cloudinary } from 'cloudinary';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Env } from '../../../src/config/env';

export const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const MANIFEST_FILE = path.join(ASSETS_DIR, '.cloudinary-manifest.json');

interface ManifestEntry { url: string; publicId: string; sha1: string }
interface Manifest { cloud: string; items: Record<string, ManifestEntry> }

export class SeedImages {
  readonly isConfigured: boolean;
  private readonly cache = new Map<string, { url: string; publicId: string | null }>();
  private manifest: Manifest;
  private dirty = 0;
  uploadedCount = 0;
  reusedCount = 0;

  constructor(private readonly env: Env) {
    this.isConfigured = Boolean(env.EF_CLOUDINARY_CLOUD_NAME && env.EF_CLOUDINARY_API_KEY && env.EF_CLOUDINARY_API_SECRET);
    this.manifest = { cloud: env.EF_CLOUDINARY_CLOUD_NAME, items: {} };
    if (this.isConfigured) {
      cloudinary.config({ cloud_name: env.EF_CLOUDINARY_CLOUD_NAME, api_key: env.EF_CLOUDINARY_API_KEY, api_secret: env.EF_CLOUDINARY_API_SECRET, secure: true });
      this.loadManifest();
      process.once('exit', () => this.saveManifest());
    }
  }

  get mode(): string {
    return this.isConfigured ? `Cloudinary (${this.env.EF_CLOUDINARY_CLOUD_NAME})` : 'tĩnh (/static/seed)';
  }

  /* Có file ảnh trong assets chưa — dùng cho ảnh tuỳ chọn (vd ảnh phụ). */
  has(rel: string): boolean {
    return fs.existsSync(path.join(ASSETS_DIR, rel));
  }

  /* `rel` = đường dẫn tương đối trong assets, vd `product/ao-thun-cotton-nam-basic/main.jpg`. */
  async resolve(rel: string): Promise<{ url: string; publicId: string | null }> {
    const hit = this.cache.get(rel);
    if (hit) return hit;
    const file = path.join(ASSETS_DIR, rel);
    if (!fs.existsSync(file)) throw new Error(`Thiếu ảnh seed: ${rel} (chạy "npm run seed:gen-images" để sinh ảnh minh hoạ)`);
    let out: { url: string; publicId: string | null };
    if (!this.isConfigured) {
      out = { url: `${this.env.EF_API_PUBLIC_URL.replace(/\/$/, '')}/static/seed/${rel.replace(/\\/g, '/')}`, publicId: null };
    } else {
      out = await this.resolveCloudinary(rel, file);
    }
    this.cache.set(rel, out);
    return out;
  }

  private async resolveCloudinary(rel: string, file: string): Promise<{ url: string; publicId: string }> {
    const sha1 = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    const known = this.manifest.items[rel];
    if (known && known.sha1 === sha1) {
      this.reusedCount += 1;
      return { url: known.url, publicId: known.publicId };
    }
    const publicId = `ecofashion/seed/${rel.replace(/\\/g, '/').replace(/\.[a-z0-9]+$/i, '')}`;
    const ext = path.extname(rel).replace('.', '') || 'jpg';
    const cdnUrl = `https://res.cloudinary.com/${this.env.EF_CLOUDINARY_CLOUD_NAME}/image/upload/${publicId}.${ext}`;
    let entry: ManifestEntry;
    // Lần đầu (chưa có trong manifest): ảnh đã được seed trước đây trên Cloudinary thì dùng lại, không upload lại.
    if (!known && (await this.existsOnCdn(cdnUrl))) {
      this.reusedCount += 1;
      entry = { url: cdnUrl, publicId, sha1 };
    } else {
      const r = await cloudinary.uploader.upload(file, { public_id: publicId, overwrite: true, resource_type: 'image' });
      this.uploadedCount += 1;
      entry = { url: r.secure_url, publicId, sha1 };
    }
    this.manifest.items[rel] = entry;
    this.dirty += 1;
    if (this.dirty % 25 === 0) this.saveManifest();
    return { url: entry.url, publicId };
  }

  private async existsOnCdn(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private loadManifest(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;
      if (raw.cloud === this.env.EF_CLOUDINARY_CLOUD_NAME && raw.items) this.manifest = raw;
    } catch {
      /* chưa có manifest — bình thường */
    }
  }

  saveManifest(): void {
    if (!this.isConfigured || this.dirty === 0) return;
    try {
      fs.writeFileSync(MANIFEST_FILE, JSON.stringify(this.manifest, null, 1));
      this.dirty = 0;
    } catch {
      /* không ghi được manifest thì lần sau kiểm lại bằng HEAD — không làm hỏng seed */
    }
  }
}
