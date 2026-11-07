import type { Env } from '@config/env';
import { CatalogImageProvider } from './catalog-image.provider';
import { VisualEncoderProvider } from './visual-encoder.provider';

describe('PLAN-0044 boundaries image providers', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const env = {
    EF_API_PUBLIC_URL: 'https://api.example.test',
    EF_VISUAL_IMAGE_ORIGINS: 'https://res.cloudinary.com',
    EF_VISUAL_ENCODER_URL: 'http://encoder:8080',
    EF_VISUAL_ENCODER_TOKEN: 'unit-test-token',
    EF_VISUAL_MODEL_VERSION: 'model-v1',
  } as Env;
  it.each([
    'https://evil.test/a.jpg',
    'http://127.0.0.1/admin',
    'file:///etc/passwd',
    '//evil.test/img',
    'data:image/png;base64,aaa',
    'https://token:password@res.cloudinary.com/img',
  ])('nguồn ảnh không được phép không gọi mạng: %s', (url) => {
    global.fetch = jest.fn();
    expect(() => new CatalogImageProvider(env).resolve(url)).toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('ảnh local chỉ /static, resolve trên API origin cấu hình', () => {
    expect(new CatalogImageProvider(env).resolve('/static/product/a.jpg').href).toBe(
      'https://api.example.test/static/product/a.jpg',
    );
  });
  it('redirect không được tự theo để tải IP/host khác', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })),
    );
    await expect(new CatalogImageProvider(env).download('https://res.cloudinary.com/img')).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('không tải HTML dù URL trông như ảnh', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response('<html>', { headers: { 'content-type': 'text/html' } })),
    );
    await expect(new CatalogImageProvider(env).download('https://res.cloudinary.com/img')).rejects.toThrow();
  });
  it('stream vượt5MB bị huỷ kể cả thiếu content-length', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } }),
      ),
    );
    await expect(new CatalogImageProvider(env).download('https://res.cloudinary.com/img')).rejects.toThrow(
      'quá lớn',
    );
  });
  it('encoder khác model-version bị từ chối trước truy vấn vector', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ modelVersion: 'wrong', vectors: [Array(768).fill(1)] }))),
    );
    await expect(
      new VisualEncoderProvider(env).embed([{ buffer: Buffer.from('jpeg'), mimetype: 'image/jpeg' }]),
    ).rejects.toThrow('phiên bản');
  });
  it('encoder không cấu hình không gọi mạng hoặc key khác', async () => {
    global.fetch = jest.fn();
    await expect(
      new VisualEncoderProvider({ ...env, EF_VISUAL_ENCODER_TOKEN: '' }).embed([
        { buffer: Buffer.from('jpeg'), mimetype: 'image/jpeg' },
      ]),
    ).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('encoder thật contract: chuẩn hoá768, gửi bearer riêng, không URL ảnh người dùng', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ modelVersion: 'model-v1', vectors: [Array(768).fill(1)] })),
      ),
    );
    const [vector] = await new VisualEncoderProvider(env).embed([
      { buffer: Buffer.from('jpeg'), mimetype: 'image/jpeg' },
    ]);
    expect(Math.hypot(...vector)).toBeCloseTo(1);
    expect(vector).toHaveLength(768);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://encoder:8080/v1/embed',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer unit-test-token' },
      }),
    );
  });
});
