/*
 * Ảnh seed → URL dùng được (AGENTS.md — Seed Rule: kèm ảnh, chạy lại không tạo trùng).
 *
 * ĐÓNG GÓI SẴN LINK CLOUDINARY: `assets/.cloudinary-manifest.json` (commit cùng repo) ghi, cho từng ảnh trong `assets/`, URL ĐÃ UPLOAD sẵn
 * (+ sha1 nội dung để biết ảnh chưa đổi). Ảnh Cloudinary là URL CÔNG KHAI nên máy khác — kể cả máy dùng tài khoản Cloudinary KHÁC hoặc
 * KHÔNG có khoá — chạy seed là có đủ ảnh ngay, không phải upload lại hàng trăm ảnh.
 *
 * Nguồn ảnh (env `EF_SEED_IMAGE_SOURCE`, mặc định `auto`):
 *  - `auto`   : ảnh có trong manifest (sha1 khớp) ⇒ DÙNG LUÔN link đóng gói sẵn, bất kể máy này cấu hình Cloudinary nào. Ảnh MỚI chưa có trong
 *               manifest ⇒ có khoá Cloudinary thì upload lên tài khoản của máy này, không có khoá thì dùng URL tĩnh.
 *  - `upload` : bỏ qua link đóng gói của tài khoản khác, upload/tái dùng ảnh trên Cloudinary CỦA MÁY NÀY (cần EF_CLOUDINARY_*) — dùng khi muốn
 *               toàn bộ ảnh nằm trong tài khoản của mình. Kết quả lưu ở `.cloudinary-manifest.local.json` (gitignored), KHÔNG ghi đè manifest đóng gói.
 *  - `static` : không dùng Cloudinary, trả URL tĩnh `${EF_API_PUBLIC_URL}/static/seed/<path>` (API phục vụ thư mục assets).
 * Không có Cloudinary và không có manifest ⇒ như `static`.
 *
 * Có khoá + public_id CỐ ĐỊNH `ecofashion/seed/<path không đuôi>`: hàng trăm ảnh mà gọi Admin API (`api.resource`) từng ảnh sẽ chạm hạn mức
 * 500 lệnh/giờ ⇒ file không đổi thì không gọi mạng; chưa có trong manifest thì HEAD URL CDN (không tính hạn mức) — đã có thì dùng luôn.
 * Cập nhật manifest đóng gói (sau khi thêm/đổi ảnh, bằng tài khoản Cloudinary GỐC): `npm run seed:manifest`.
 */
import { v2 as cloudinary } from 'cloudinary';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Env } from '../../../src/config/env';

export const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const MANIFEST_NAME = '.cloudinary-manifest.json';
const LOCAL_MANIFEST_NAME = '.cloudinary-manifest.local.json';

export type SeedImageSource = 'auto' | 'upload' | 'static';

interface ManifestEntry { url: string; publicId: string; sha1: string }
interface Manifest { cloud: string; items: Record<string, ManifestEntry> }

export interface SeedImagesOptions {
  /* Thư mục assets (mặc định `scripts/seed/assets`) — test dùng thư mục tạm. */
  assetsDir?: string;
  /* Ghi đè EF_SEED_IMAGE_SOURCE. */
  source?: SeedImageSource;
  /*
   * ĐÓNG GÓI LẠI: upload/tái dùng ảnh trên Cloudinary của máy này rồi GHI vào manifest đóng gói (kể cả khi manifest cũ là của tài khoản khác —
   * khi đó manifest được thay bằng link của tài khoản này). Chỉ `npm run seed:manifest` dùng; ép nguồn `upload`.
   */
  repackage?: boolean;
}

function parseSource(raw: string | undefined): SeedImageSource {
  return raw === 'upload' || raw === 'static' ? raw : 'auto';
}

export class SeedImages {
  /* Máy này có ĐỦ khoá Cloudinary để upload (không liên quan việc dùng link đóng gói sẵn). */
  readonly isConfigured: boolean;
  readonly source: SeedImageSource;
  private readonly assetsDir: string;
  private readonly cache = new Map<string, { url: string; publicId: string | null }>();
  /* Manifest ĐÓNG GÓI trong repo (chỉ đọc khi là của tài khoản khác; ghi lại chỉ khi trùng tài khoản máy này). */
  private readonly packaged: Manifest | null;
  /* Manifest của Cloudinary CỦA MÁY NÀY — chính là `packaged` nếu cùng tài khoản, còn không thì file `.local` gitignored. */
  private own: Manifest;
  private ownFile: string;
  private dirty = 0;
  uploadedCount = 0;
  reusedCount = 0;
  /* Số ảnh lấy từ link đóng gói sẵn (không upload, không gọi mạng). */
  packagedCount = 0;

  constructor(private readonly env: Env, opts: SeedImagesOptions = {}) {
    this.assetsDir = opts.assetsDir ?? ASSETS_DIR;
    this.source = opts.repackage ? 'upload' : (opts.source ?? parseSource(process.env.EF_SEED_IMAGE_SOURCE));
    const cloud = env.EF_CLOUDINARY_CLOUD_NAME;
    this.isConfigured = Boolean(cloud && env.EF_CLOUDINARY_API_KEY && env.EF_CLOUDINARY_API_SECRET);
    this.packaged = this.readManifest(path.join(this.assetsDir, MANIFEST_NAME));
    this.own = { cloud, items: {} };
    this.ownFile = path.join(this.assetsDir, MANIFEST_NAME);
    if (this.isConfigured) {
      cloudinary.config({ cloud_name: cloud, api_key: env.EF_CLOUDINARY_API_KEY, api_secret: env.EF_CLOUDINARY_API_SECRET, secure: true });
      if (this.packaged && this.packaged.cloud === cloud) {
        this.own = this.packaged;
      } else if (opts.repackage) {
        this.dirty = 1; // manifest mới của tài khoản này sẽ thay manifest đóng gói cũ
      } else {
        // Tài khoản khác với manifest đóng gói: KHÔNG ghi đè manifest đóng gói — lưu riêng ở file local.
        this.ownFile = path.join(this.assetsDir, LOCAL_MANIFEST_NAME);
        const local = this.readManifest(this.ownFile);
        if (local && local.cloud === cloud) this.own = local;
      }
      process.once('exit', () => this.saveManifest());
    }
  }

  get mode(): string {
    if (this.source === 'static') return 'tĩnh (/static/seed)';
    const own = this.isConfigured ? `Cloudinary (${this.env.EF_CLOUDINARY_CLOUD_NAME})` : null;
    if (this.source === 'upload') return own ?? 'tĩnh (/static/seed) — thiếu EF_CLOUDINARY_*, không upload được';
    if (!this.packaged) return own ?? 'tĩnh (/static/seed)';
    const pk = `link đóng gói sẵn (${this.packaged.cloud})`;
    return own && this.packaged.cloud !== this.env.EF_CLOUDINARY_CLOUD_NAME ? `${pk}; ảnh mới → upload ${own}` : pk;
  }

  /* Có file ảnh trong assets chưa — dùng cho ảnh tuỳ chọn (vd ảnh phụ). */
  has(rel: string): boolean {
    return fs.existsSync(path.join(this.assetsDir, rel));
  }

  /* `rel` = đường dẫn tương đối trong assets, vd `product/ao-thun-cotton-nam-basic/main.jpg`. */
  async resolve(rel: string): Promise<{ url: string; publicId: string | null }> {
    const hit = this.cache.get(rel);
    if (hit) return hit;
    const file = path.join(this.assetsDir, rel);
    if (!fs.existsSync(file)) throw new Error(`Thiếu ảnh seed: ${rel} (chạy "npm run seed:gen-images" để sinh ảnh minh hoạ)`);
    let out: { url: string; publicId: string | null };
    if (this.source === 'static') {
      out = this.staticUrl(rel);
    } else {
      const sha1 = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
      const packaged = this.source === 'auto' ? this.packagedEntry(rel, sha1) : null;
      if (packaged) {
        this.packagedCount += 1;
        out = { url: packaged.url, publicId: packaged.publicId };
      } else if (this.isConfigured) {
        out = await this.resolveCloudinary(rel, file, sha1);
      } else {
        out = this.staticUrl(rel);
      }
    }
    this.cache.set(rel, out);
    return out;
  }

  /* Link đóng gói sẵn còn đúng cho nội dung ảnh hiện tại (sha1 khớp). */
  private packagedEntry(rel: string, sha1: string): ManifestEntry | null {
    const e = this.packaged?.items[rel];
    return e && e.sha1 === sha1 ? e : null;
  }

  private staticUrl(rel: string): { url: string; publicId: null } {
    return { url: `${this.env.EF_API_PUBLIC_URL.replace(/\/$/, '')}/static/seed/${rel.replace(/\\/g, '/')}`, publicId: null };
  }

  private async resolveCloudinary(rel: string, file: string, sha1: string): Promise<{ url: string; publicId: string }> {
    const known = this.own.items[rel];
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
    this.own.items[rel] = entry;
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

  private readManifest(file: string): Manifest | null {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
      return raw && typeof raw.cloud === 'string' && raw.items ? raw : null;
    } catch {
      return null; // chưa có manifest — bình thường
    }
  }

  /* Bỏ khỏi manifest những ảnh không còn trong assets (đóng gói lại cho gọn). */
  prune(keep: ReadonlySet<string>): number {
    let removed = 0;
    for (const rel of Object.keys(this.own.items)) {
      if (!keep.has(rel)) {
        delete this.own.items[rel];
        removed += 1;
      }
    }
    if (removed > 0) this.dirty += removed;
    return removed;
  }

  saveManifest(): void {
    if (!this.isConfigured || this.dirty === 0) return;
    try {
      fs.writeFileSync(this.ownFile, JSON.stringify(this.own, null, 1));
      this.dirty = 0;
    } catch {
      /* không ghi được manifest thì lần sau kiểm lại bằng HEAD — không làm hỏng seed */
    }
  }
}
