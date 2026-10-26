import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Env } from '@config/env';
import { PayosService } from './payos.service';

/*
 * Test cổng PayOS. Khoá PayOS ở môi trường dev/CI để TRỐNG nên mọi lời gọi mạng đều bị thay bằng `fetch` giả
 * (mặc định ném lỗi nếu test quên stub ⇒ không bao giờ chạm mạng thật). Chữ ký trong test được tính ĐỘC LẬP với code
 * bằng node:crypto trên chuỗi viết tay — không gọi lại hàm của service để tự xác nhận mình.
 */

const CLIENT_ID = 'test-client-id';
const API_KEY = 'test-api-key';
const CHECKSUM = 'test-checksum-key';
const PAYOUT_CLIENT_ID = 'test-payout-client-id';
const PAYOUT_API_KEY = 'test-payout-api-key';
const API_URL = 'https://api-merchant.payos.test';

type KeyName =
  | 'EF_PAYOS_CLIENT_ID'
  | 'EF_PAYOS_API_KEY'
  | 'EF_PAYOS_CHECKSUM_KEY'
  | 'EF_PAYOS_PAYOUT_CLIENT_ID'
  | 'EF_PAYOS_PAYOUT_API_KEY'
  | 'EF_PAYOS_PAYOUT_CHECKSUM_KEY';

const BASE_ENV: Record<KeyName | 'EF_PAYOS_API_URL', string> = {
  EF_PAYOS_CLIENT_ID: CLIENT_ID,
  EF_PAYOS_API_KEY: API_KEY,
  EF_PAYOS_CHECKSUM_KEY: CHECKSUM,
  EF_PAYOS_PAYOUT_CLIENT_ID: PAYOUT_CLIENT_ID,
  EF_PAYOS_PAYOUT_API_KEY: PAYOUT_API_KEY,
  EF_PAYOS_PAYOUT_CHECKSUM_KEY: 'test-payout-checksum-key',
  EF_PAYOS_API_URL: API_URL,
};

function makeService(overrides: Partial<Record<KeyName, string>> = {}): PayosService {
  return new PayosService({ ...BASE_ENV, ...overrides } as unknown as Env);
}

const hmac = (data: string, key = CHECKSUM): string => createHmac('sha256', key).update(data, 'utf8').digest('hex');
const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

type WebhookBody = Parameters<PayosService['verifyWebhookSignature']>[0];

describe('PayosService', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.fn((_url: string, _init: RequestInit): Promise<Response> => Promise.reject(new Error('fetch chưa được stub trong test này — không được gọi mạng thật')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  /* Đọc lời gọi fetch thứ n: URL, method, header (chữ thường) và body JSON. */
  function callAt(n = 0) {
    const [url, init] = fetchMock.mock.calls[n];
    return {
      url,
      init,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : (JSON.parse(init.body as string) as Record<string, unknown>),
    };
  }

  // ------------------------------------------------------------------ cấu hình

  describe('isConfigured / isPayoutConfigured', () => {
    it('đủ 3 khoá thu tiền ⇒ isConfigured = true', () => {
      expect(makeService().isConfigured).toBe(true);
    });

    it.each(['EF_PAYOS_CLIENT_ID', 'EF_PAYOS_API_KEY', 'EF_PAYOS_CHECKSUM_KEY'] as const)('thiếu %s ⇒ isConfigured = false', (key) => {
      expect(makeService({ [key]: '' }).isConfigured).toBe(false);
    });

    it('mọi khoá để trống (mặc định dev/CI) ⇒ cả hai cờ đều false', () => {
      const s = makeService({ EF_PAYOS_CLIENT_ID: '', EF_PAYOS_API_KEY: '', EF_PAYOS_CHECKSUM_KEY: '', EF_PAYOS_PAYOUT_CLIENT_ID: '', EF_PAYOS_PAYOUT_API_KEY: '', EF_PAYOS_PAYOUT_CHECKSUM_KEY: '' });
      expect(s.isConfigured).toBe(false);
      expect(s.isPayoutConfigured).toBe(false);
    });

    it('đủ 3 khoá chi tiền ⇒ isPayoutConfigured = true', () => {
      expect(makeService().isPayoutConfigured).toBe(true);
    });

    it.each(['EF_PAYOS_PAYOUT_CLIENT_ID', 'EF_PAYOS_PAYOUT_API_KEY', 'EF_PAYOS_PAYOUT_CHECKSUM_KEY'] as const)('thiếu %s ⇒ isPayoutConfigured = false', (key) => {
      expect(makeService({ [key]: '' }).isPayoutConfigured).toBe(false);
    });

    it('thu tiền và chi tiền là hai cặp khoá độc lập', () => {
      const onlyCollect = makeService({ EF_PAYOS_PAYOUT_CLIENT_ID: '', EF_PAYOS_PAYOUT_API_KEY: '', EF_PAYOS_PAYOUT_CHECKSUM_KEY: '' });
      expect(onlyCollect.isConfigured).toBe(true);
      expect(onlyCollect.isPayoutConfigured).toBe(false);

      const onlyPayout = makeService({ EF_PAYOS_CLIENT_ID: '', EF_PAYOS_API_KEY: '', EF_PAYOS_CHECKSUM_KEY: '' });
      expect(onlyPayout.isConfigured).toBe(false);
      expect(onlyPayout.isPayoutConfigured).toBe(true);
    });
  });

  // ------------------------------------------------------------------ orderCode

  describe('generateOrderCode', () => {
    const FIXED_MS = Date.UTC(2026, 9, 3, 10, 0, 0); // 2026-10-03T10:00:00Z

    it('số nguyên dương an toàn, nằm trong [1e15, 9.007e15) với đồng hồ thật', () => {
      const code = PayosService.generateOrderCode();
      expect(Number.isSafeInteger(code)).toBe(true);
      expect(code).toBeGreaterThanOrEqual(1e15);
      expect(code).toBeLessThan(9.007e15);
      expect(code).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    });

    it('2000 lần gọi trong CÙNG một mili-giây: luôn đúng kiểu/khoảng, tiền tố = mili-giây, 3 số cuối biến thiên', () => {
      jest.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
      const codes = Array.from({ length: 2000 }, () => PayosService.generateOrderCode());

      for (const c of codes) {
        expect(Number.isSafeInteger(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(1e15);
        expect(c).toBeLessThan(9.007e15);
        expect(Math.floor(c / 1000)).toBe(FIXED_MS);
        expect(c % 1000).toBeGreaterThanOrEqual(0);
        expect(c % 1000).toBeLessThanOrEqual(999);
      }
      // Ngẫu nhiên thật: 2000 lần bốc trong 1000 giá trị phải ra rất nhiều giá trị khác nhau (kỳ vọng ≈ 860).
      expect(new Set(codes.map((c) => c % 1000)).size).toBeGreaterThan(100);
    });

    it('mili-giây sau luôn cho mã LỚN hơn mili-giây trước (3 số ngẫu nhiên không bao giờ lấn sang mili-giây khác)', () => {
      const now = jest.spyOn(Date, 'now');
      let prev = 0;
      for (let i = 0; i < 300; i += 1) {
        now.mockReturnValue(FIXED_MS + i);
        const c = PayosService.generateOrderCode();
        expect(c).toBeGreaterThan(prev);
        prev = c;
      }
    });

    it('mã là số nguyên thập phân thuần (không có dấu chấm / e-mũ) để PayOS nhận được', () => {
      jest.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
      expect(String(PayosService.generateOrderCode())).toMatch(/^\d{16}$/);
    });
  });

  // ------------------------------------------------------------------ tạo payment link

  describe('createPaymentLink', () => {
    const RETURN_URL = 'https://shop.fitly.test/checkout/payos-return?ref=a&b=c';
    const CANCEL_URL = 'https://shop.fitly.test/checkout/payos-return?cancel=1';
    const input = {
      orderCode: 1790000000123456,
      amount: 350_000n,
      description: 'FT2610030001',
      returnUrl: RETURN_URL,
      cancelUrl: CANCEL_URL,
      expiresAt: new Date(1_800_000_000_999),
    };
    const OK_REPLY = { code: '00', desc: 'success', data: { checkoutUrl: 'https://pay.payos.vn/web/abc123', qrCode: '00020101021238570010A000000727', paymentLinkId: 'plink-1' } };
    const FAILED = { checkoutUrl: null, qrCode: null, paymentLinkId: null };

    it.each(['EF_PAYOS_CLIENT_ID', 'EF_PAYOS_API_KEY', 'EF_PAYOS_CHECKSUM_KEY'] as const)('thiếu khoá %s ⇒ checkoutUrl = null và KHÔNG gọi fetch', async (key) => {
      const r = await makeService({ [key]: '' }).createPaymentLink(input);
      expect(r).toEqual(FAILED);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('thành công: gọi POST /v2/payment-requests với header khoá thu tiền, trả checkoutUrl + qrCode + paymentLinkId', async () => {
      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      const r = await makeService().createPaymentLink(input);

      expect(r).toEqual({ checkoutUrl: 'https://pay.payos.vn/web/abc123', qrCode: '00020101021238570010A000000727', paymentLinkId: 'plink-1' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = callAt();
      expect(call.url).toBe(`${API_URL}/v2/payment-requests`);
      expect(call.method).toBe('POST');
      expect(call.headers).toMatchObject({ 'Content-Type': 'application/json', 'x-client-id': CLIENT_ID, 'x-api-key': API_KEY });
      // header thu tiền, KHÔNG dùng nhầm khoá chi tiền
      expect(Object.values(call.headers)).not.toContain(PAYOUT_API_KEY);
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    });

    it('body: orderCode/amount là SỐ (không phải bigint/chuỗi), URL nguyên bản, expiredAt = giây Unix của expiresAt (cắt phần mili-giây)', async () => {
      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      await makeService().createPaymentLink(input);

      const { body } = callAt();
      expect(body).toMatchObject({
        orderCode: 1790000000123456,
        amount: 350000,
        description: 'FT2610030001',
        returnUrl: RETURN_URL,
        cancelUrl: CANCEL_URL,
        expiredAt: 1_800_000_000,
      });
      expect(typeof body?.amount).toBe('number');
      expect(typeof body?.orderCode).toBe('number');
    });

    it('chữ ký = HMAC-SHA256 hex (checksum key) của `amount=…&cancelUrl=…&description=…&orderCode=…&returnUrl=…` (URL KHÔNG bị encode)', async () => {
      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      await makeService().createPaymentLink(input);

      const expectedString = `amount=350000&cancelUrl=${CANCEL_URL}&description=FT2610030001&orderCode=1790000000123456&returnUrl=${RETURN_URL}`;
      expect(callAt().body?.signature).toBe(hmac(expectedString));
      expect(callAt().body?.signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it('chữ ký phụ thuộc đúng khoá checksum THU TIỀN (không phải khoá chi tiền)', async () => {
      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      await makeService().createPaymentLink(input);

      const signed = `amount=350000&cancelUrl=${CANCEL_URL}&description=FT2610030001&orderCode=1790000000123456&returnUrl=${RETURN_URL}`;
      expect(callAt().body?.signature).not.toBe(hmac(signed, 'test-payout-checksum-key'));
      expect(callAt().body?.signature).not.toBe(hmac(signed, 'sai-khoa'));
    });

    it('description dài hơn 25 ký tự bị cắt còn 25 — cả trong body lẫn trong chuỗi ký', async () => {
      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      await makeService().createPaymentLink({ ...input, description: 'Thanh toan don hang FITLY 2026 rat dai' });

      const { body } = callAt();
      expect(body?.description).toBe('Thanh toan don hang FITLY');
      expect((body?.description as string).length).toBe(25);
      const signed = `amount=350000&cancelUrl=${CANCEL_URL}&description=Thanh toan don hang FITLY&orderCode=1790000000123456&returnUrl=${RETURN_URL}`;
      expect(body?.signature).toBe(hmac(signed));
    });

    it('description ≤ 25 ký tự giữ nguyên', async () => {
      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      await makeService().createPaymentLink({ ...input, description: 'A'.repeat(25) });
      expect(callAt().body?.description).toBe('A'.repeat(25));

      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      await makeService().createPaymentLink({ ...input, description: 'FT1' });
      expect(callAt(1).body?.description).toBe('FT1');
    });

    it('số tiền lớn vẫn ký/gửi đúng số nguyên (không dạng khoa học)', async () => {
      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      await makeService().createPaymentLink({ ...input, amount: 120_000_000n });
      expect(callAt().body?.amount).toBe(120000000);
      expect(callAt().body?.signature).toBe(hmac(`amount=120000000&cancelUrl=${CANCEL_URL}&description=FT2610030001&orderCode=1790000000123456&returnUrl=${RETURN_URL}`));
    });

    it('có `items` thì gửi kèm (price thành số) và KHÔNG ảnh hưởng chữ ký; không có thì không gửi trường items', async () => {
      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      await makeService().createPaymentLink({ ...input, items: [{ name: 'Áo thun', quantity: 2, price: 175_000n }] });
      expect(callAt().body?.items).toEqual([{ name: 'Áo thun', quantity: 2, price: 175000 }]);
      const withItems = callAt().body?.signature;

      fetchMock.mockResolvedValueOnce(reply(OK_REPLY));
      await makeService().createPaymentLink(input);
      expect(callAt(1).body).not.toHaveProperty('items');
      expect(callAt(1).body?.signature).toBe(withItems);
    });

    it('thiếu qrCode / paymentLinkId trong phản hồi ⇒ trả null cho các trường đó nhưng vẫn thành công', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '00', data: { checkoutUrl: 'https://pay.payos.vn/web/only-url' } }));
      const r = await makeService().createPaymentLink(input);
      expect(r).toEqual({ checkoutUrl: 'https://pay.payos.vn/web/only-url', qrCode: null, paymentLinkId: null });
    });

    it.each([
      ['INVALID_REQUEST_BODY', { code: 'INVALID_REQUEST_BODY', desc: 'Dữ liệu không hợp lệ' }],
      ['231 (orderCode đã tồn tại)', { code: '231', desc: 'Đơn thanh toán đã tồn tại', data: null }],
      ['20 (thiếu tham số)', { code: '20', desc: 'Missing' }],
      ['mã 00 nhưng KHÔNG có checkoutUrl', { code: '00', desc: 'success', data: {} }],
      ['mã 00 nhưng không có data', { code: '00', desc: 'success' }],
      ['mã 00 nhưng checkoutUrl rỗng', { code: '00', data: { checkoutUrl: '' } }],
      ['phản hồi rỗng {}', {}],
      ['có checkoutUrl nhưng mã lỗi (không tin data)', { code: '99', data: { checkoutUrl: 'https://pay.payos.vn/web/x' } }],
    ])('PayOS trả %s ⇒ checkoutUrl = null (caller phải coi là thất bại)', async (_label, body) => {
      fetchMock.mockResolvedValueOnce(reply(body));
      expect(await makeService().createPaymentLink(input)).toEqual(FAILED);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('chỉ code "00" (chuỗi) mới là thành công — số 0 hay "0" thì không', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: 0, data: { checkoutUrl: 'https://pay.payos.vn/web/x' } }));
      expect(await makeService().createPaymentLink(input)).toEqual(FAILED);
      fetchMock.mockResolvedValueOnce(reply({ code: '0', data: { checkoutUrl: 'https://pay.payos.vn/web/x' } }));
      expect(await makeService().createPaymentLink(input)).toEqual(FAILED);
    });

    it('fetch ném lỗi mạng ⇒ checkoutUrl = null, không ném ra ngoài', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(makeService().createPaymentLink(input)).resolves.toEqual(FAILED);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('timeout (TimeoutError của AbortSignal) ⇒ checkoutUrl = null', async () => {
      fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
      await expect(makeService().createPaymentLink(input)).resolves.toEqual(FAILED);
    });

    it('fetch ném giá trị không phải Error (chuỗi) ⇒ vẫn trả null', async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- cố ý: lỗi ném ra không phải Error
      fetchMock.mockImplementationOnce(() => Promise.reject('boom'));
      await expect(makeService().createPaymentLink(input)).resolves.toEqual(FAILED);
    });

    it('PayOS trả HTML/không phải JSON (vd 502 gateway) ⇒ checkoutUrl = null', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
      await expect(makeService().createPaymentLink(input)).resolves.toEqual(FAILED);
    });
  });

  // ------------------------------------------------------------------ tra cứu / huỷ link

  describe('getPaymentLink', () => {
    it('chưa cấu hình ⇒ {} và không gọi fetch', async () => {
      expect(await makeService({ EF_PAYOS_API_KEY: '' }).getPaymentLink(123)).toEqual({});
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('GET /v2/payment-requests/{orderCode} kèm header khoá thu tiền, trả data của PayOS', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '00', data: { status: 'PAID', amountPaid: 350000, amountRemaining: 0 } }));
      const r = await makeService().getPaymentLink(1790000000123456);
      expect(r).toEqual({ status: 'PAID', amountPaid: 350000, amountRemaining: 0 });
      const call = callAt();
      expect(call.url).toBe(`${API_URL}/v2/payment-requests/1790000000123456`);
      expect(call.method).toBe('GET');
      expect(call.headers).toEqual({ 'x-client-id': CLIENT_ID, 'x-api-key': API_KEY });
    });

    it('phản hồi không có data ⇒ {}', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '101', desc: 'not found' }));
      expect(await makeService().getPaymentLink('abc')).toEqual({});
    });

    it('lỗi mạng ⇒ {} (không ném)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      await expect(makeService().getPaymentLink(1)).resolves.toEqual({});
    });
  });

  describe('cancelPaymentLink', () => {
    it('chưa cấu hình ⇒ false và không gọi fetch', async () => {
      expect(await makeService({ EF_PAYOS_CLIENT_ID: '' }).cancelPaymentLink(1)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('DELETE /v2/payment-requests/{id}; code "00" ⇒ true', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '00' }));
      expect(await makeService().cancelPaymentLink(1790000000123456)).toBe(true);
      expect(callAt().method).toBe('DELETE');
      expect(callAt().url).toBe(`${API_URL}/v2/payment-requests/1790000000123456`);
    });

    it('code khác "00" hoặc lỗi mạng ⇒ false', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '231' }));
      expect(await makeService().cancelPaymentLink(1)).toBe(false);
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      expect(await makeService().cancelPaymentLink(1)).toBe(false);
    });
  });

  // ------------------------------------------------------------------ xác minh webhook

  describe('verifyWebhookSignature', () => {
    /* Ví dụ webhook trong tài liệu PayOS. Chuỗi chuẩn hoá viết TAY (sắp khoá, `k=v` nối &, null → rỗng) rồi mới ký. */
    const DOC_DATA = {
      orderCode: 123,
      amount: 3000,
      description: 'VQRIO123',
      accountNumber: '12345678',
      reference: 'TF230204212323',
      transactionDateTime: '2023-02-04 18:25:00',
      currency: 'VND',
      paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
      code: '00',
      desc: 'Thành công',
      counterAccountBankId: '',
      counterAccountBankName: '',
      counterAccountName: '',
      counterAccountNumber: '',
      virtualAccountName: '',
      virtualAccountNumber: '',
    };
    const DOC_CANONICAL =
      'accountNumber=12345678&amount=3000&code=00&counterAccountBankId=&counterAccountBankName=&counterAccountName=&counterAccountNumber=&currency=VND&desc=Thành công&description=VQRIO123&orderCode=123&paymentLinkId=124c33293c43417ab7879e14c8d9eb18&reference=TF230204212323&transactionDateTime=2023-02-04 18:25:00&virtualAccountName=&virtualAccountNumber=';

    const verify = (body: unknown, service = makeService()): boolean => service.verifyWebhookSignature(body as WebhookBody);

    it('chữ ký đúng theo chuẩn hoá của SDK PayOS (khoá sắp theo tên) ⇒ true, bất kể thứ tự khoá trong body', () => {
      expect(verify({ code: '00', data: DOC_DATA, signature: hmac(DOC_CANONICAL) })).toBe(true);

      const shuffled = Object.fromEntries(Object.entries(DOC_DATA).reverse());
      expect(verify({ code: '00', data: shuffled, signature: hmac(DOC_CANONICAL) })).toBe(true);
    });

    it('chữ ký hex viết HOA vẫn đúng (không phân biệt hoa/thường)', () => {
      expect(verify({ data: DOC_DATA, signature: hmac(DOC_CANONICAL).toUpperCase() })).toBe(true);
      const mixed = hmac(DOC_CANONICAL).replace(/^(.{20})(.*)$/, (_m, a: string, b: string) => a.toUpperCase() + b);
      expect(verify({ data: DOC_DATA, signature: mixed })).toBe(true);
    });

    it('giá trị null/undefined được chuẩn hoá thành chuỗi rỗng (không làm lệch chữ ký)', () => {
      const data = { orderCode: 7, amount: 1000, counterAccountName: null, virtualAccountName: undefined, desc: 'ok' };
      expect(verify({ data, signature: hmac('amount=1000&counterAccountName=&desc=ok&orderCode=7&virtualAccountName=') })).toBe(true);
      // null và chuỗi rỗng cho cùng một chữ ký
      expect(verify({ data: { ...data, counterAccountName: '' }, signature: hmac('amount=1000&counterAccountName=&desc=ok&orderCode=7&virtualAccountName=') })).toBe(true);
    });

    it('chuỗi "null"/"undefined" cũng bị coi là rỗng (đúng SDK PayOS)', () => {
      const data = { orderCode: 7, counterAccountName: 'null', reference: 'undefined' };
      expect(verify({ data, signature: hmac('counterAccountName=&orderCode=7&reference=') })).toBe(true);
    });

    it('mảng/đối tượng ⇒ JSON với khoá sắp xếp; số/boolean ⇒ String(v)', () => {
      const data = {
        orderCode: 9,
        flag: true,
        items: [{ price: 5, name: 'a' }, { qty: 1, id: 'x' }],
        meta: { z: 1, a: 2 },
        tags: ['b', 'a'],
      };
      const canonical = 'flag=true&items=[{"name":"a","price":5},{"id":"x","qty":1}]&meta={"a":2,"z":1}&orderCode=9&tags=["b","a"]';
      expect(verify({ data, signature: hmac(canonical) })).toBe(true);
    });

    it('dữ liệu bị sửa (đổi số tiền) sau khi ký ⇒ false', () => {
      const signature = hmac(DOC_CANONICAL);
      expect(verify({ data: { ...DOC_DATA, amount: 3001 }, signature })).toBe(false);
      expect(verify({ data: { ...DOC_DATA, orderCode: 124 }, signature })).toBe(false);
      expect(verify({ data: { ...DOC_DATA, extra: 'x' }, signature })).toBe(false); // thêm khoá lạ
      const { desc: _removed, ...withoutDesc } = DOC_DATA;
      expect(verify({ data: withoutDesc, signature })).toBe(false); // bớt khoá
    });

    it('ký bằng khoá khác (khoá chi tiền / khoá sai) ⇒ false', () => {
      expect(verify({ data: DOC_DATA, signature: hmac(DOC_CANONICAL, 'test-payout-checksum-key') })).toBe(false);
      expect(verify({ data: DOC_DATA, signature: hmac(DOC_CANONICAL, 'khoa-sai') })).toBe(false);
    });

    it('chữ ký sai (cùng độ dài) / ngắn hơn / dài hơn / rỗng ⇒ false', () => {
      const good = hmac(DOC_CANONICAL);
      const flipped = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
      expect(verify({ data: DOC_DATA, signature: flipped })).toBe(false);
      expect(verify({ data: DOC_DATA, signature: good.slice(0, 63) })).toBe(false);
      expect(verify({ data: DOC_DATA, signature: good + '0' })).toBe(false);
      expect(verify({ data: DOC_DATA, signature: '' })).toBe(false);
      expect(verify({ data: DOC_DATA, signature: 'invalid-signature' })).toBe(false);
    });

    it('chữ ký có ký tự đa byte nhưng đúng 64 ký tự (độ dài chuỗi khớp, độ dài byte lệch) ⇒ false, KHÔNG ném lỗi', () => {
      const sig = 'é'.repeat(64);
      expect(sig.length).toBe(64);
      expect(() => verify({ data: DOC_DATA, signature: sig })).not.toThrow();
      expect(verify({ data: DOC_DATA, signature: sig })).toBe(false);
    });

    it('thiếu signature / signature không phải chuỗi / thiếu data ⇒ false', () => {
      expect(verify({ code: '00', data: DOC_DATA })).toBe(false);
      expect(verify({ data: DOC_DATA, signature: 123 })).toBe(false);
      expect(verify({ data: DOC_DATA, signature: null })).toBe(false);
      expect(verify({ code: '00', signature: hmac('') })).toBe(false);
      expect(verify({ code: '00', data: null, signature: hmac('') })).toBe(false);
      expect(verify({})).toBe(false);
    });

    it('chưa cấu hình ⇒ false dù chữ ký "đúng" với khoá trống', () => {
      const emptyKey = makeService({ EF_PAYOS_CHECKSUM_KEY: '' });
      expect(verify({ data: DOC_DATA, signature: hmac(DOC_CANONICAL, '') }, emptyKey)).toBe(false);
      const noClient = makeService({ EF_PAYOS_CLIENT_ID: '' });
      expect(verify({ data: DOC_DATA, signature: hmac(DOC_CANONICAL) }, noClient)).toBe(false);
    });

    it('data rỗng {} ký trên chuỗi rỗng vẫn được xác minh nhất quán (HMAC của "")', () => {
      expect(verify({ data: {}, signature: hmac('') })).toBe(true);
      expect(verify({ data: {}, signature: hmac('x') })).toBe(false);
    });

    it('mẫu kiểm tra URL của PayOS (orderCode=123) ký đúng ⇒ true (xử lý bỏ qua nằm ở PaymentService)', () => {
      const data = { orderCode: 123, amount: 3000, code: '00', desc: 'success' };
      expect(verify({ code: '00', data, signature: hmac('amount=3000&code=00&desc=success&orderCode=123') })).toBe(true);
    });
  });

  // ------------------------------------------------------------------ chi tiền

  describe('payout', () => {
    const payoutInput = { referenceId: 'refund-1', amount: 100_000n, toBin: '970436', toAccountNumber: '0011223344', description: 'Hoan tien don FT1', idempotencyKey: 'refund-1' };

    it.each(['EF_PAYOS_PAYOUT_CLIENT_ID', 'EF_PAYOS_PAYOUT_API_KEY', 'EF_PAYOS_PAYOUT_CHECKSUM_KEY'] as const)('thiếu %s ⇒ ok=false, code NOT_CONFIGURED, KHÔNG gọi fetch', async (key) => {
      const r = await makeService({ [key]: '' }).payout(payoutInput);
      expect(r).toMatchObject({ ok: false, code: 'NOT_CONFIGURED', raw: null });
      expect(r.message).toEqual(expect.any(String));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('khoá thu tiền đủ nhưng khoá chi tiền trống vẫn NOT_CONFIGURED', async () => {
      const s = makeService({ EF_PAYOS_PAYOUT_CLIENT_ID: '', EF_PAYOS_PAYOUT_API_KEY: '', EF_PAYOS_PAYOUT_CHECKSUM_KEY: '' });
      expect(s.isConfigured).toBe(true);
      expect((await s.payout(payoutInput)).code).toBe('NOT_CONFIGURED');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('thành công: POST /v1/payouts với khoá CHI tiền + x-idempotency-key + x-signature, body amount là số', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '00', desc: 'success', data: { id: 'PO-123' } }));
      const r = await makeService().payout(payoutInput);

      expect(r).toMatchObject({ ok: true, code: '00', message: 'success', transactionId: 'PO-123' });
      const call = callAt();
      expect(call.url).toBe(`${API_URL}/v1/payouts`);
      expect(call.method).toBe('POST');
      expect(call.headers).toMatchObject({ 'x-client-id': PAYOUT_CLIENT_ID, 'x-api-key': PAYOUT_API_KEY, 'x-idempotency-key': 'refund-1' });
      expect(Object.values(call.headers)).not.toContain(API_KEY);
      expect(call.body).toEqual({ referenceId: 'refund-1', amount: 100000, toBin: '970436', toAccountNumber: '0011223344', description: 'Hoan tien don FT1' });
    });

    it('x-signature = HMAC-SHA256(checksum key CHI tiền, body sắp theo khoá, khoá+giá trị mã hoá encodeURIComponent) — KHÔNG dùng checksum key thu tiền', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '00', data: { id: 'PO-1' } }));
      await makeService().payout(payoutInput);
      const canonical = 'amount=100000&description=Hoan%20tien%20don%20FT1&referenceId=refund-1&toAccountNumber=0011223344&toBin=970436';
      expect(callAt().headers['x-signature']).toBe(hmac(canonical, 'test-payout-checksum-key'));
      expect(callAt().headers['x-signature']).not.toBe(hmac(canonical));
    });

    it('PayOS từ chối (code lỗi) ⇒ ok=false, giữ code + desc + raw', async () => {
      const body = { code: '231', desc: 'Số dư không đủ' };
      fetchMock.mockResolvedValueOnce(reply(body));
      const r = await makeService().payout(payoutInput);
      expect(r).toMatchObject({ ok: false, code: '231', message: 'Số dư không đủ', raw: body });
    });

    it('HTTP 401 (chữ ký / khoá sai) ⇒ ok=false dù không có code trong body', async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ desc: 'Unauthorized' }), { status: 401 }));
      expect(await makeService().payout(payoutInput)).toMatchObject({ ok: false, code: '401', message: 'Unauthorized' });
    });

    it('phản hồi 200 nhưng không có code ⇒ không bao giờ ok', async () => {
      fetchMock.mockResolvedValueOnce(reply({ desc: 'lạ' }));
      expect((await makeService().payout(payoutInput)).ok).toBe(false);
    });

    it('lỗi mạng/timeout ⇒ ok=false, code "99", raw null, không ném', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      await expect(makeService().payout(payoutInput)).resolves.toMatchObject({ ok: false, code: '99', raw: null });
      expect(warnSpy).toHaveBeenCalled();
    });

    it('JSON hỏng (HTTP 500) ⇒ ok=false, mang mã HTTP', async () => {
      fetchMock.mockResolvedValueOnce(new Response('not json', { status: 500 }));
      await expect(makeService().payout(payoutInput)).resolves.toMatchObject({ ok: false, code: '500' });
    });
  });

  describe('getPayout / payoutState', () => {
    it('mọi giao dịch SUCCEEDED ⇒ succeeded; đang PROCESSING ⇒ processing; có FAILED / approvalState bị từ chối ⇒ failed', () => {
      expect(PayosService.payoutState('APPROVED', ['SUCCEEDED'])).toMatchObject({ state: 'succeeded' });
      expect(PayosService.payoutState('APPROVED', ['PROCESSING'])).toMatchObject({ state: 'processing' });
      expect(PayosService.payoutState(undefined, ['SUCCEEDED', 'PROCESSING'])).toMatchObject({ state: 'processing' });
      expect(PayosService.payoutState('APPROVED', ['FAILED'])).toMatchObject({ state: 'failed' });
      expect(PayosService.payoutState('REJECTED', [])).toMatchObject({ state: 'failed' });
      expect(PayosService.payoutState('APPROVED', [])).toMatchObject({ state: 'processing' }); // chưa có giao dịch ⇒ không tự đánh đã trả
    });

    it('GET /v1/payouts/{id} với khoá CHI; lỗi / thiếu cấu hình ⇒ unknown (giữ nguyên, không tự đánh đã trả)', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '00', desc: 'success', data: { approvalState: 'APPROVED', transactions: [{ state: 'SUCCEEDED' }] } }));
      expect(await makeService().getPayout('PO-1')).toMatchObject({ state: 'succeeded' });
      expect(callAt().url).toBe(`${API_URL}/v1/payouts/PO-1`);
      expect(callAt().headers).toEqual({ 'x-client-id': PAYOUT_CLIENT_ID, 'x-api-key': PAYOUT_API_KEY });

      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ desc: 'Forbidden' }), { status: 403 }));
      expect((await makeService().getPayout('PO-1')).state).toBe('unknown');
      fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      expect((await makeService().getPayout('PO-1')).state).toBe('unknown');
      expect((await makeService({ EF_PAYOS_PAYOUT_API_KEY: '' }).getPayout('PO-1')).state).toBe('unknown');
    });
  });

  describe('payoutBalance', () => {
    it('chưa cấu hình payout ⇒ NOT_CONFIGURED, balance null, KHÔNG gọi fetch', async () => {
      const r = await makeService({ EF_PAYOS_PAYOUT_API_KEY: '' }).payoutBalance();
      expect(r).toMatchObject({ balance: null, code: 'NOT_CONFIGURED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('thành công: GET /v1/payouts-account/balance, số dư là bigint', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '00', message: 'ok', data: { balance: 5_000_000 } }));
      const r = await makeService().payoutBalance();
      expect(r).toEqual({ balance: 5_000_000n, code: '00', message: 'ok' });
      expect(callAt().url).toBe(`${API_URL}/v1/payouts-account/balance`);
      expect(callAt().method).toBe('GET');
      expect(callAt().headers).toEqual({ 'x-client-id': PAYOUT_CLIENT_ID, 'x-api-key': PAYOUT_API_KEY });
    });

    it('số dư 0 là 0n chứ không bị nhầm thành null', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '00', data: { balance: 0 } }));
      expect((await makeService().payoutBalance()).balance).toBe(0n);
    });

    it('không có data.balance ⇒ balance null', async () => {
      fetchMock.mockResolvedValueOnce(reply({ code: '00' }));
      expect((await makeService().payoutBalance()).balance).toBeNull();
    });

    it('lỗi mạng ⇒ balance null, code "99"', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(makeService().payoutBalance()).resolves.toMatchObject({ balance: null, code: '99' });
    });
  });
});

describe('PayosService.payoutCanonical — chuỗi ký lệnh chi', () => {
  it('sắp khoá, mã hoá URI cả khoá lẫn giá trị, null → rỗng, mảng/đối tượng → JSON đã sắp khoá', () => {
    expect(PayosService.payoutCanonical({ b: 'x y', a: 1, c: null, d: undefined })).toBe('a=1&b=x%20y&c=&d=');
    expect(PayosService.payoutCanonical({ payouts: [{ toBin: '1', amount: 2 }], category: ['a', 'b'] })).toBe(
      `category=${encodeURIComponent('["a","b"]')}&payouts=${encodeURIComponent('[{"amount":2,"toBin":"1"}]')}`,
    );
    expect(PayosService.payoutCanonical({ d: 'Tiếng Việt & ký tự=lạ' })).toBe('d=Ti%E1%BA%BFng%20Vi%E1%BB%87t%20%26%20k%C3%BD%20t%E1%BB%B1%3Dl%E1%BA%A1');
  });
});
