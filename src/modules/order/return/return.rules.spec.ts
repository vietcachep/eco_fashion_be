import { ORDER_ERR, RETURN_STATUS, RETURN_TRANSITIONS, RETURN_OPEN_STATUSES, RETURN_CLOSED_STATUSES, canReturnTransition, type ReturnStatus } from '../foundation/order.constants';
import {
  canCancel,
  canEscalate,
  canShipBack,
  deadlineOf,
  isTrustedEvidenceUrl,
  maskAccountNumber,
  normalizeAccountName,
  normalizeEvidence,
  normalizeRefundAccount,
  boundedSetting,
  proportionalRefund,
  readRefundAccount,
  refundReason,
  resolveShopRefundAmount,
  type EvidenceHostContext,
  type ReturnStateView,
} from './return.rules';

const HOUR = 3_600_000;
/* errorCode của BusinessException do hàm ném (undefined nếu không ném). */
const errCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { errorCode?: string }).errorCode;
  }
};
const ctx: EvidenceHostContext = { cloudinaryCloudName: 'fitly-demo', apiPublicUrl: 'https://api.fitly.vn' };
const noCloud: EvidenceHostContext = { cloudinaryCloudName: '', apiPublicUrl: 'http://localhost:4000' };

describe('máy trạng thái đổi trả (RETURN_TRANSITIONS)', () => {
  const ALL = Object.values(RETURN_STATUS);

  it('mọi trạng thái đều có hàng trong bảng chuyển; trạng thái kết thúc không đi đâu nữa', () => {
    expect(Object.keys(RETURN_TRANSITIONS).sort()).toEqual([...ALL].sort());
    for (const s of [RETURN_STATUS.REFUNDED, RETURN_STATUS.CANCELLED, RETURN_STATUS.EXPIRED]) expect(RETURN_TRANSITIONS[s]).toEqual([]);
  });

  it('mọi chuyển HỢP LỆ theo plan §3', () => {
    const valid: Array<[ReturnStatus, ReturnStatus]> = [
      ['requested', 'approved'], // shop duyệt (cần trả hàng)
      ['requested', 'received'], // shop duyệt `not_received` ⇒ hoàn tiền ngay
      ['requested', 'refunded'], // …không có tiền nào cần hoàn
      ['requested', 'rejected'], // shop từ chối
      ['requested', 'escalated'], // quá hạn shop duyệt
      ['requested', 'cancelled'], // khách rút
      ['approved', 'received'], // shop nhận đúng hàng
      ['approved', 'refunded'],
      ['approved', 'escalated'], // hàng không khớp / shop quá hạn nhận
      ['approved', 'cancelled'], // khách rút trước khi gửi
      ['approved', 'expired'], // khách không gửi hàng
      ['rejected', 'escalated'], // khách khiếu nại
      ['escalated', 'received'], // sàn phân xử hoàn tiền
      ['escalated', 'refunded'],
      ['escalated', 'rejected'], // sàn từ chối lần cuối
      ['received', 'refunded'], // payment báo xong
    ];
    for (const [from, to] of valid) expect(canReturnTransition(from, to)).toBe(true);
  });

  it('mọi chuyển còn lại bị TỪ CHỐI (kể cả tự chuyển về chính nó và quay ngược)', () => {
    const allowed = new Set(Object.entries(RETURN_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`)));
    let rejected = 0;
    for (const from of ALL)
      for (const to of ALL) {
        if (allowed.has(`${from}>${to}`)) continue;
        expect(canReturnTransition(from, to)).toBe(false);
        rejected += 1;
      }
    expect(rejected).toBe(ALL.length * ALL.length - allowed.size);
    // các ca dễ nhầm
    expect(canReturnTransition('rejected', 'approved')).toBe(false); // shop không "đổi ý" sau khi từ chối — khách phải khiếu nại
    expect(canReturnTransition('received', 'escalated')).toBe(false);
    expect(canReturnTransition('refunded', 'received')).toBe(false);
    expect(canReturnTransition('approved', 'rejected')).toBe(false); // đã duyệt thì không từ chối lại
    expect(canReturnTransition('expired', 'approved')).toBe(false);
    expect(canReturnTransition('nope', 'approved')).toBe(false);
  });

  it('tập "mở" và "kết thúc" chia đôi toàn bộ trạng thái; mở = requested · approved · escalated · received', () => {
    expect([...RETURN_OPEN_STATUSES].sort()).toEqual(['approved', 'escalated', 'received', 'requested']);
    expect([...RETURN_CLOSED_STATUSES].sort()).toEqual(['cancelled', 'expired', 'refunded', 'rejected']);
    expect([...RETURN_OPEN_STATUSES, ...RETURN_CLOSED_STATUSES].sort()).toEqual([...ALL].sort());
  });
});

describe('isTrustedEvidenceUrl — minh chứng chỉ từ kho upload của hệ thống', () => {
  it('nhận: Cloudinary của đúng cloud (image|video/upload) · /static/uploads tương đối · tuyệt đối https cùng origin API', () => {
    expect(isTrustedEvidenceUrl('https://res.cloudinary.com/fitly-demo/image/upload/v1/ecofashion/user-media/a.jpg', ctx)).toBe(true);
    expect(isTrustedEvidenceUrl('https://res.cloudinary.com/fitly-demo/video/upload/v1/ecofashion/user-media/a.mp4', ctx)).toBe(true);
    expect(isTrustedEvidenceUrl('/static/uploads/user-media/abcd1234/17-aaaa.jpg', ctx)).toBe(true);
    expect(isTrustedEvidenceUrl('/static/uploads/user-media/abcd1234/17-aaaa.jpg', noCloud)).toBe(true);
    expect(isTrustedEvidenceUrl('https://api.fitly.vn/static/uploads/user-media/abcd1234/17-aaaa.jpg', ctx)).toBe(true);
  });

  it.each([
    ['http thường', 'http://res.cloudinary.com/fitly-demo/image/upload/a.jpg'],
    ['cloud khác', 'https://res.cloudinary.com/nguoi-la/image/upload/a.jpg'],
    ['host lạ', 'https://evil.example.com/static/uploads/a.jpg'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:image/png;base64,AAAA'],
    ['kèm user:pass', 'https://user:pass@res.cloudinary.com/fitly-demo/a.jpg'],
    ['cổng lạ', 'https://res.cloudinary.com:8443/fitly-demo/a.jpg'],
    ['đường dẫn tương đối ngoài /static/uploads', '/uploads/a.jpg'],
    ['path traversal', '/static/uploads/../../etc/passwd'],
    ['ký tự lạ trong path tương đối', '/static/uploads/a b.jpg'],
    ['rỗng', ''],
    ['quá dài', `/static/uploads/${'a'.repeat(600)}`],
    ['http cùng origin API', 'http://api.fitly.vn/static/uploads/a.jpg'],
    ['cùng origin API nhưng ngoài /static/uploads', 'https://api.fitly.vn/api/v1/orders'],
  ])('từ chối: %s', (_label, url) => {
    expect(isTrustedEvidenceUrl(url, ctx)).toBe(false);
  });

  it.each([
    ['delivery type fetch (Cloudinary tự kéo URL ngoài)', 'https://res.cloudinary.com/fitly-demo/image/fetch/https://evil.example.com/a.jpg'],
    ['delivery type private', 'https://res.cloudinary.com/fitly-demo/image/private/a.jpg'],
    ['delivery type authenticated', 'https://res.cloudinary.com/fitly-demo/image/authenticated/a.jpg'],
    ['resource type raw', 'https://res.cloudinary.com/fitly-demo/raw/upload/a.zip'],
    ['video fetch', 'https://res.cloudinary.com/fitly-demo/video/fetch/https://evil.example.com/a.mp4'],
    ['không có kiểu giao', 'https://res.cloudinary.com/fitly-demo/a.jpg'],
    ['tên cloud là tiền tố của cloud khác', 'https://res.cloudinary.com/fitly-demo-evil/image/upload/a.jpg'],
  ])('Cloudinary của đúng cloud nhưng %s ⇒ từ chối', (_label, url) => {
    expect(isTrustedEvidenceUrl(url, ctx)).toBe(false);
  });

  it('chưa cấu hình Cloudinary (lưu cục bộ) ⇒ URL Cloudinary không được nhận', () => {
    expect(isTrustedEvidenceUrl('https://res.cloudinary.com/fitly-demo/image/upload/a.jpg', noCloud)).toBe(false);
  });
});

describe('normalizeEvidence', () => {
  const ok = { type: 'image', url: '/static/uploads/user-media/ab/1.jpg', name: ' 1.jpg ' };

  it('bắt buộc ≥ 1 khi required; không bắt buộc (not_received) thì rỗng/undefined đều được', () => {
    expect(errCode(() => normalizeEvidence([], ctx, { required: true }))).toBe(ORDER_ERR.EVIDENCE_REQUIRED);
    expect(errCode(() => normalizeEvidence(undefined, ctx, { required: true }))).toBe(ORDER_ERR.EVIDENCE_REQUIRED);
    expect(normalizeEvidence(undefined, ctx, { required: false })).toEqual([]);
    expect(normalizeEvidence([], ctx, { required: false })).toEqual([]);
  });

  it('chuẩn hoá: cắt khoảng trắng, chỉ giữ type/url/name', () => {
    expect(normalizeEvidence([{ ...ok, junk: 1 } as never], ctx, { required: true })).toEqual([{ type: 'image', url: '/static/uploads/user-media/ab/1.jpg', name: '1.jpg' }]);
  });

  it('tối đa 8 tệp: 8 qua, 9 ⇒ RETURN_EVIDENCE_INVALID', () => {
    expect(normalizeEvidence(Array(8).fill(ok), ctx, { required: true })).toHaveLength(8);
    expect(errCode(() => normalizeEvidence(Array(9).fill(ok), ctx, { required: true }))).toBe(ORDER_ERR.RETURN_EVIDENCE_INVALID);
  });

  it('chỉ nhận loại image|video; URL ngoài kho upload ⇒ RETURN_EVIDENCE_INVALID', () => {
    expect(normalizeEvidence([{ ...ok, type: 'video' }], ctx, { required: true })[0].type).toBe('video');
    expect(errCode(() => normalizeEvidence([{ ...ok, type: 'pdf' }], ctx, { required: true }))).toBe(ORDER_ERR.RETURN_EVIDENCE_INVALID);
    expect(errCode(() => normalizeEvidence([{ ...ok, url: 'https://evil.example.com/a.jpg' }], ctx, { required: true }))).toBe(ORDER_ERR.RETURN_EVIDENCE_INVALID);
  });

  it('thiếu tên thì đặt tên mặc định', () => {
    expect(normalizeEvidence([{ type: 'image', url: ok.url, name: '  ' }], ctx, { required: true })[0].name).toBe('minh-chung');
  });
});

describe('tài khoản nhận hoàn', () => {
  it('chuẩn hoá tên: bỏ dấu, in hoa, gộp khoảng trắng, đ → D', () => {
    expect(normalizeAccountName('  Nguyễn   Văn  Đức ')).toBe('NGUYEN VAN DUC');
  });

  it('hợp lệ: BIN 6 số · số TK 6–19 chữ số (bỏ khoảng trắng/gạch) · tên chuẩn hoá', () => {
    expect(normalizeRefundAccount({ bankBin: '970422', accountNumber: '0123 4567-89', accountName: 'Nguyễn Văn A', bankName: ' MB Bank ' })).toEqual({ bankBin: '970422', bankName: 'MB Bank', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' });
    expect(normalizeRefundAccount({ bankBin: '970422', accountNumber: '123456', accountName: 'AB' })).toEqual({ bankBin: '970422', accountNumber: '123456', accountName: 'AB' });
  });

  it.each([
    ['BIN thiếu số', { bankBin: '9704', accountNumber: '0123456789', accountName: 'A B' }],
    ['BIN có chữ', { bankBin: '97042A', accountNumber: '0123456789', accountName: 'A B' }],
    ['số TK quá ngắn', { bankBin: '970422', accountNumber: '12345', accountName: 'A B' }],
    ['số TK quá dài', { bankBin: '970422', accountNumber: '1'.repeat(20), accountName: 'A B' }],
    ['số TK có chữ', { bankBin: '970422', accountNumber: '01234abc89', accountName: 'A B' }],
    ['tên rỗng', { bankBin: '970422', accountNumber: '0123456789', accountName: '   ' }],
    ['tên ký tự lạ', { bankBin: '970422', accountNumber: '0123456789', accountName: 'AB@#' }],
    ['tên quá dài', { bankBin: '970422', accountNumber: '0123456789', accountName: 'A'.repeat(61) }],
  ])('sai định dạng: %s ⇒ RETURN_REFUND_ACCOUNT_INVALID', (_l, input) => {
    expect(errCode(() => normalizeRefundAccount(input))).toBe(ORDER_ERR.RETURN_REFUND_ACCOUNT_INVALID);
  });

  it('che số tài khoản: chỉ 4 số cuối; readRefundAccount đọc lại JSON đã lưu và bỏ qua dữ liệu hỏng', () => {
    expect(maskAccountNumber('0123456789')).toBe('****6789');
    expect(readRefundAccount({ bankBin: '970422', accountNumber: '0123456789', accountName: 'A B' })).toEqual({ bankBin: '970422', accountNumber: '0123456789', accountName: 'A B' });
    expect(readRefundAccount(null)).toBeNull();
    expect(readRefundAccount({ bankBin: 1 })).toBeNull();
  });
});

describe('refundReason — lý do gửi payment ≤ 255 ký tự', () => {
  it('ngắn thì giữ nguyên; dài thì cắt PHẦN LÝ DO, tiền tố/hậu tố còn nguyên, tổng đúng 255', () => {
    expect(refundReason('Đổi trả: ', 'Không vừa size')).toBe('Đổi trả: Không vừa size');
    expect(refundReason('Đổi trả: ', 'Không vừa', ' (sàn phân xử)')).toBe('Đổi trả: Không vừa (sàn phân xử)');
    const long = refundReason('Huỷ đơn: ', 'a'.repeat(300));
    expect(long).toHaveLength(255);
    expect(long.startsWith('Huỷ đơn: aaa')).toBe(true);
    const withSuffix = refundReason('Đổi trả: ', 'b'.repeat(300), ' (sàn phân xử)');
    expect(withSuffix).toHaveLength(255);
    expect(withSuffix.endsWith('bb (sàn phân xử)')).toBe(true);
  });
});

describe('boundedSetting — hạn chót kẹp vào khoảng hợp lý', () => {
  it('giờ ∈ [1, 8760]; ngày ∈ [1, 365]; làm tròn xuống số nguyên; không hữu hạn ⇒ mặc định', () => {
    expect(boundedSetting(72, 'hours', 1)).toBe(72);
    expect(boundedSetting(0, 'hours', 72)).toBe(1);
    expect(boundedSetting(-9, 'days', 7)).toBe(1);
    expect(boundedSetting(0.4, 'days', 7)).toBe(1);
    expect(boundedSetting(2.9, 'days', 7)).toBe(2);
    expect(boundedSetting(1e12, 'hours', 72)).toBe(8760);
    expect(boundedSetting(1e12, 'days', 7)).toBe(365);
    expect(boundedSetting(Number.NaN, 'days', 7)).toBe(7);
    expect(boundedSetting(Number.POSITIVE_INFINITY, 'hours', 72)).toBe(72);
  });
});

describe('proportionalRefund / resolveShopRefundAmount', () => {
  it('hoàn theo tỉ lệ trên total, làm tròn xuống, không vượt total; subtotal = 0 ⇒ Σ dòng bị chặn bởi total', () => {
    expect(proportionalRefund([{ unitPrice: 50_000n, quantity: 2 }], 100_000n, 100_000n)).toBe(100_000n);
    expect(proportionalRefund([{ unitPrice: 100_000n, quantity: 1 }, { unitPrice: 50_000n, quantity: 2 }], 350_000n, 300_000n)).toBe(171_428n);
    expect(proportionalRefund([{ unitPrice: 120_000n, quantity: 1 }], 100_000n, 80_000n)).toBe(80_000n);
    expect(proportionalRefund([{ unitPrice: 50_000n, quantity: 1 }], 0n, 30_000n)).toBe(30_000n);
  });

  it('shop: bỏ trống = số tính sẵn; bằng số tính sẵn không cần lý do; giảm thì BẮT BUỘC lý do; không được tăng; phải > 0', () => {
    expect(resolveShopRefundAmount(100_000n, undefined, undefined)).toEqual({ amount: 100_000n, adjustReason: null });
    expect(resolveShopRefundAmount(100_000n, '100000', undefined)).toEqual({ amount: 100_000n, adjustReason: null });
    expect(resolveShopRefundAmount(100_000n, '80000', ' Hàng đã mở hộp, trừ 20% ')).toEqual({ amount: 80_000n, adjustReason: 'Hàng đã mở hộp, trừ 20%' });
    expect(errCode(() => resolveShopRefundAmount(100_000n, '80000', undefined))).toBe(ORDER_ERR.RETURN_ADJUST_REASON_REQUIRED);
    expect(errCode(() => resolveShopRefundAmount(100_000n, '80000', 'ngắn'))).toBe(ORDER_ERR.RETURN_ADJUST_REASON_REQUIRED);
    expect(errCode(() => resolveShopRefundAmount(100_000n, '100001', 'tăng thêm một đồng'))).toBe(ORDER_ERR.RETURN_REFUND_TOO_HIGH);
    expect(errCode(() => resolveShopRefundAmount(100_000n, '0', 'không hoàn'))).toBe(ORDER_ERR.RETURN_REFUND_TOO_HIGH);
  });
});

describe('hạn chót + cờ hành động của khách', () => {
  const now = new Date('2026-10-26T10:00:00Z');
  const at = (h: number) => new Date(now.getTime() + h * HOUR);
  const base: ReturnStateView = { status: 'requested', requireReturn: true, rejectedBy: null, shippedBackAt: null, shopRespondDueAt: at(10), shipBackDueAt: null, shopReceiveDueAt: null, escalateDueAt: null };

  it('deadlineOf: bước đang chờ quyết định hạn nào', () => {
    expect(deadlineOf(base)).toEqual({ at: at(10), kind: 'shop_respond' });
    expect(deadlineOf({ ...base, status: 'approved', shipBackDueAt: at(100) })).toEqual({ at: at(100), kind: 'ship_back' });
    expect(deadlineOf({ ...base, status: 'approved', shippedBackAt: now, shipBackDueAt: at(100), shopReceiveDueAt: at(50) })).toEqual({ at: at(50), kind: 'shop_receive' });
    expect(deadlineOf({ ...base, status: 'rejected', rejectedBy: 'shop', escalateDueAt: at(20) })).toEqual({ at: at(20), kind: 'escalate' });
  });

  it('deadlineOf: không còn bước chờ ⇒ null (sàn từ chối, đã nhận, đã hoàn, không cần trả hàng, thiếu mốc)', () => {
    const none = { at: null, kind: null };
    expect(deadlineOf({ ...base, status: 'rejected', rejectedBy: 'platform', escalateDueAt: at(20) })).toEqual(none);
    for (const status of ['received', 'refunded', 'escalated', 'cancelled', 'expired']) expect(deadlineOf({ ...base, status })).toEqual(none);
    expect(deadlineOf({ ...base, status: 'approved', requireReturn: false, shipBackDueAt: at(1) })).toEqual(none);
    expect(deadlineOf({ ...base, shopRespondDueAt: null })).toEqual(none);
  });

  it('canCancel: chờ shop duyệt, hoặc đã duyệt nhưng CHƯA gửi hàng; đã gửi / đã nhận / bị từ chối thì không', () => {
    expect(canCancel(base)).toBe(true);
    expect(canCancel({ ...base, status: 'approved' })).toBe(true);
    expect(canCancel({ ...base, status: 'approved', shippedBackAt: now })).toBe(false);
    for (const status of ['rejected', 'escalated', 'received', 'refunded', 'cancelled', 'expired']) expect(canCancel({ ...base, status })).toBe(false);
  });

  it('canShipBack: đã duyệt + cần trả hàng + chưa báo gửi + còn hạn gửi', () => {
    const approved = { ...base, status: 'approved', shipBackDueAt: at(24) };
    expect(canShipBack(approved, now)).toBe(true);
    expect(canShipBack({ ...approved, shipBackDueAt: at(-1) }, now)).toBe(false); // quá hạn
    expect(canShipBack({ ...approved, shippedBackAt: now }, now)).toBe(false);
    expect(canShipBack({ ...approved, requireReturn: false }, now)).toBe(false);
    expect(canShipBack(base, now)).toBe(false);
  });

  it('canEscalate: CHỈ khi SHOP từ chối và còn trong hạn khiếu nại', () => {
    const rejected = { ...base, status: 'rejected', rejectedBy: 'shop', escalateDueAt: at(24) };
    expect(canEscalate(rejected, now)).toBe(true);
    expect(canEscalate({ ...rejected, escalateDueAt: at(-0.01) }, now)).toBe(false); // hết hạn
    expect(canEscalate({ ...rejected, rejectedBy: 'platform' }, now)).toBe(false); // quyết định cuối của sàn
    expect(canEscalate({ ...rejected, escalateDueAt: null }, now)).toBe(false);
    expect(canEscalate(base, now)).toBe(false);
  });
});
