import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Env } from '../../../src/config/env';

/*
 * SeedImages — link Cloudinary ĐÓNG GÓI SẴN (manifest trong repo) dùng được trên máy khác: không cần khoá, không cần upload lại, và khi máy
 * khác dùng TÀI KHOẢN Cloudinary KHÁC thì manifest đóng gói không bị ghi đè.
 */

const upload = jest.fn<Promise<{ secure_url: string }>, [string, { public_id: string }]>();
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: (f: string, o: { public_id: string }) => upload(f, o) } } }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SeedImages } = require('./seed-images') as typeof import('./seed-images');

const REL = 'product/ao-thun/main.jpg';
const BYTES = Buffer.from('anh-gia-lap');
const SHA1 = crypto.createHash('sha1').update(BYTES).digest('hex');
const PACKAGED_URL = `https://res.cloudinary.com/goc/image/upload/v1/ecofashion/seed/${REL}`;

function env(over: Partial<Env> = {}): Env {
  return { EF_CLOUDINARY_CLOUD_NAME: '', EF_CLOUDINARY_API_KEY: '', EF_CLOUDINARY_API_SECRET: '', EF_API_PUBLIC_URL: 'http://localhost:4000/', ...over } as unknown as Env;
}

function makeAssets(manifest: object | null, bytes: Buffer = BYTES): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-images-'));
  fs.mkdirSync(path.join(dir, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(dir, REL), bytes);
  if (manifest) fs.writeFileSync(path.join(dir, '.cloudinary-manifest.json'), JSON.stringify(manifest));
  return dir;
}

const packaged = { cloud: 'goc', items: { [REL]: { url: PACKAGED_URL, publicId: `ecofashion/seed/product/ao-thun/main`, sha1: SHA1 } } };
const OTHER = { EF_CLOUDINARY_CLOUD_NAME: 'khac', EF_CLOUDINARY_API_KEY: 'k', EF_CLOUDINARY_API_SECRET: 's' };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.EF_SEED_IMAGE_SOURCE;
  global.fetch = jest.fn(() => Promise.resolve({ ok: false })) as unknown as typeof fetch;
});

describe('SeedImages — link đóng gói sẵn', () => {
  it('máy KHÔNG có khoá Cloudinary vẫn nhận link Cloudinary đóng gói (không dùng /static/seed)', async () => {
    const img = new SeedImages(env(), { assetsDir: makeAssets(packaged) });

    const r = await img.resolve(REL);

    expect(r).toEqual({ url: PACKAGED_URL, publicId: 'ecofashion/seed/product/ao-thun/main' });
    expect(img.packagedCount).toBe(1);
    expect(upload).not.toHaveBeenCalled();
    expect(img.mode).toContain('link đóng gói sẵn (goc)');
  });

  it('máy dùng TÀI KHOẢN KHÁC: vẫn dùng link đóng gói, không upload, không gọi mạng, không ghi đè manifest', async () => {
    const dir = makeAssets(packaged);
    const before = fs.readFileSync(path.join(dir, '.cloudinary-manifest.json'), 'utf8');
    const img = new SeedImages(env(OTHER), { assetsDir: dir });

    const r = await img.resolve(REL);
    img.saveManifest();

    expect(r.url).toBe(PACKAGED_URL);
    expect(upload).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, '.cloudinary-manifest.json'), 'utf8')).toBe(before);
    expect(img.mode).toContain('ảnh mới → upload Cloudinary (khac)');
  });

  it('ảnh ĐÃ ĐỔI nội dung (sha1 lệch) + không khoá ⇒ không dùng link cũ, rơi về URL tĩnh', async () => {
    const img = new SeedImages(env(), { assetsDir: makeAssets(packaged, Buffer.from('noi-dung-khac')) });

    const r = await img.resolve(REL);

    expect(r).toEqual({ url: `http://localhost:4000/static/seed/${REL}`, publicId: null });
    expect(img.packagedCount).toBe(0);
  });

  it('ảnh MỚI chưa có trong manifest + tài khoản khác ⇒ upload lên tài khoản của máy này, lưu manifest .local (manifest đóng gói giữ nguyên)', async () => {
    const dir = makeAssets({ cloud: 'goc', items: {} });
    upload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/khac/image/upload/v9/x.jpg' });
    const img = new SeedImages(env(OTHER), { assetsDir: dir });

    const r = await img.resolve(REL);
    img.saveManifest();

    expect(r.url).toBe('https://res.cloudinary.com/khac/image/upload/v9/x.jpg');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(img.uploadedCount).toBe(1);
    const local = JSON.parse(fs.readFileSync(path.join(dir, '.cloudinary-manifest.local.json'), 'utf8')) as { cloud: string; items: Record<string, unknown> };
    expect(local.cloud).toBe('khac');
    expect(Object.keys(local.items)).toEqual([REL]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.cloudinary-manifest.json'), 'utf8'))).toEqual({ cloud: 'goc', items: {} });
  });

  it('EF_SEED_IMAGE_SOURCE=upload: bỏ link của tài khoản khác, upload lên tài khoản của máy này', async () => {
    process.env.EF_SEED_IMAGE_SOURCE = 'upload';
    upload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/khac/image/upload/v9/y.jpg' });
    const img = new SeedImages(env(OTHER), { assetsDir: makeAssets(packaged) });

    const r = await img.resolve(REL);

    expect(r.url).toContain('/khac/');
    expect(img.packagedCount).toBe(0);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('EF_SEED_IMAGE_SOURCE=upload nhưng thiếu khoá ⇒ rơi về URL tĩnh (không ném lỗi)', async () => {
    const img = new SeedImages(env(), { assetsDir: makeAssets(packaged), source: 'upload' });

    expect((await img.resolve(REL)).url).toBe(`http://localhost:4000/static/seed/${REL}`);
    expect(img.mode).toContain('thiếu EF_CLOUDINARY_*');
  });

  it('EF_SEED_IMAGE_SOURCE=static: luôn URL tĩnh dù có manifest và có khoá', async () => {
    const img = new SeedImages(env(OTHER), { assetsDir: makeAssets(packaged), source: 'static' });

    expect((await img.resolve(REL)).url).toBe(`http://localhost:4000/static/seed/${REL}`);
    expect(upload).not.toHaveBeenCalled();
  });

  it('cùng tài khoản với manifest: ảnh mới upload xong được GHI vào manifest đóng gói (đường cập nhật seed:manifest)', async () => {
    const dir = makeAssets({ cloud: 'goc', items: {} });
    upload.mockResolvedValue({ secure_url: PACKAGED_URL });
    const img = new SeedImages(env({ EF_CLOUDINARY_CLOUD_NAME: 'goc', EF_CLOUDINARY_API_KEY: 'k', EF_CLOUDINARY_API_SECRET: 's' }), { assetsDir: dir });

    await img.resolve(REL);
    img.saveManifest();

    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.cloudinary-manifest.json'), 'utf8')) as { items: Record<string, { sha1: string }> };
    expect(saved.items[REL].sha1).toBe(SHA1);
  });

  it('repackage: thay manifest của tài khoản khác bằng link của tài khoản này và bỏ mục không còn trong assets', async () => {
    const dir = makeAssets({ cloud: 'goc', items: { ...packaged.items, 'product/da-xoa/main.jpg': { url: 'u', publicId: 'p', sha1: 'x' } } });
    upload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/khac/image/upload/v9/z.jpg' });
    const img = new SeedImages(env(OTHER), { assetsDir: dir, repackage: true });

    await img.resolve(REL);
    const removed = img.prune(new Set([REL]));
    img.saveManifest();

    expect(removed).toBe(0); // manifest mới của tài khoản này chưa từng có mục thừa
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.cloudinary-manifest.json'), 'utf8')) as { cloud: string; items: Record<string, unknown> };
    expect(saved.cloud).toBe('khac');
    expect(Object.keys(saved.items)).toEqual([REL]);
  });
});
