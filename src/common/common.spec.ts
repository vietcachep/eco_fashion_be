/*
 * Test bất biến của common: envelope, phân trang, tiền VND (bigint), slug tiếng Việt, che dữ liệu nhạy cảm
 * trong audit, requestId theo AsyncLocalStorage. Không cần DB/Redis.
 */
import { RequestTraceContext } from './request/request-trace.context';
import { ApiError, ApiResponse, PageResponse } from './response/api-response';
import { sanitizeSummary } from './audit/audit';
import { formatVnd, percentOf, vnd } from './utils/money';
import { slugify, unaccent } from './utils/slug';
import { extractInitialChar, generateInitialAvatarDataUri, generateInitialAvatarSvg, resolveAvatarUrl } from './utils/avatar';
import { IdempotencyService } from './idempotency/idempotency.service';

describe('ApiResponse', () => {
  it('ok/failed mang requestId của ngữ cảnh hiện tại', () => {
    RequestTraceContext.runWith(
      () => {
        const ok = ApiResponse.ok({ a: 1 }, 'Xong');
        expect(ok.success).toBe(true);
        expect(ok.requestId).toBe('req-1');
        const failed = ApiResponse.failed('Lỗi', ApiError.of('X_Y', '/p'));
        expect(failed.success).toBe(false);
        expect(failed.error?.code).toBe('X_Y');
        expect(failed.requestId).toBe('req-1');
      },
      { requestId: 'req-1' },
    );
  });

  it('PageResponse tính totalPages/first/last', () => {
    const p = PageResponse.of([1, 2], 3, 20, 137);
    expect(p.totalPages).toBe(7);
    expect(p.first).toBe(false);
    expect(p.last).toBe(false);
    expect(PageResponse.of([], 1, 20, 0).totalPages).toBe(1);
  });
});

describe('money', () => {
  it('parse numeric string từ pg và format VND', () => {
    expect(vnd('159000.00')).toBe(159000n);
    expect(formatVnd(1290000n)).toBe('1.290.000 ₫');
    expect(formatVnd('0')).toBe('0 ₫');
    expect(percentOf(199000n, 12.5)).toBe(24875n);
  });
});

describe('slug', () => {
  it('bỏ dấu, đ→d, nối gạch', () => {
    expect(slugify('Áo Thun Cotton Nam Basic — Đen')).toBe('ao-thun-cotton-nam-basic-den');
    expect(unaccent('Đầm dạ hội')).toBe('Dam da hoi');
  });
});

describe('audit sanitize', () => {
  it('che password/token/secret kể cả lồng nhau', () => {
    const out = sanitizeSummary({ email: 'a@b.vn', password: 'x', nested: { refreshToken: 'y', ok: 1 } });
    expect(out).toEqual({ email: 'a@b.vn', password: '***', nested: { refreshToken: '***', ok: 1 } });
  });
});

describe('idempotency hash', () => {
  it('ổn định theo nội dung', () => {
    expect(IdempotencyService.hashRequest({ a: 1 })).toBe(IdempotencyService.hashRequest({ a: 1 }));
    expect(IdempotencyService.hashRequest({ a: 1 })).not.toBe(IdempotencyService.hashRequest({ a: 2 }));
  });
});

describe('avatar util', () => {
  it('lấy chữ cái đầu chuẩn tiếng Việt và in hoa', () => {
    expect(extractInitialChar('nguyễn')).toBe('N');
    expect(extractInitialChar('đoàn')).toBe('Đ');
    expect(extractInitialChar('  ánh  ')).toBe('Á');
    expect(extractInitialChar('')).toBe('U');
    expect(extractInitialChar(null)).toBe('U');
  });

  it('sinh SVG và Data URI chứa chữ cái đầu', () => {
    const svg = generateInitialAvatarSvg('Trần Văn Nam');
    expect(svg).toContain('<text');
    expect(svg).toContain('>T<');
    const dataUri = generateInitialAvatarDataUri('Lê Thị Mai');
    expect(dataUri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(decodeURIComponent(dataUri)).toContain('>L<');
  });

  it('resolveAvatarUrl ưu tiên URL thật nếu có, ngược lại sinh Data URI chữ cái đầu', () => {
    expect(resolveAvatarUrl('https://res.cloudinary.com/demo/image.jpg', 'Nam')).toBe('https://res.cloudinary.com/demo/image.jpg');
    const fallback = resolveAvatarUrl(null, 'Nam');
    expect(fallback.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(decodeURIComponent(fallback)).toContain('>N<');
  });
});

