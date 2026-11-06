import { GhnGateway, GhnHttpError } from './ghn.gateway';

describe('PLAN-0043 GHN contract', () => {
  const originalFetch = global.fetch;
  const originalEnv = { token: process.env.GHN_TOKEN, shop: process.env.GHN_SHOP_ID, url: process.env.GHN_BASE_URL };
  beforeEach(() => { process.env.GHN_TOKEN = 'test-contract-no-real-network'; process.env.GHN_SHOP_ID = '123'; process.env.GHN_BASE_URL = 'https://dev-online-gateway.ghn.vn'; });
  afterEach(() => { global.fetch = originalFetch; for (const [key, value] of Object.entries({ GHN_TOKEN: originalEnv.token, GHN_SHOP_ID: originalEnv.shop, GHN_BASE_URL: originalEnv.url })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  it('tra mã client bằng endpoint riêng GET, không nhầm detail(order_code)', async () => {
    const mock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ code: 200, data: { order_code: 'GHN-1', client_order_code: 'DH1-SA', status: 'ready_to_pick', total_fee: 30000 } }) });
    global.fetch = mock;
    const state = await new GhnGateway().findByClientCode('DH1-SA');
    expect(state?.carrierOrderCode).toBe('GHN-1');
    const [url, options] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/detail-by-client-code?client_order_code=DH1-SA');
    expect(options.method).toBe('GET');
  });
  it('timeout/503 không được coi là vận đơn chưa tồn tại', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(new GhnGateway().findByClientCode('DH1-SA')).rejects.toBeInstanceOf(GhnHttpError);
  });
  it('404 rõ ràng mới cho caller tạo lại cùng mã client', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(new GhnGateway().findByClientCode('DH1-SA')).resolves.toBeNull();
  });
  it.each([
    'Lỗi gọi API: corev2_tenant_order_detail_by_client_order_code - Đơn hàng không tồn tại',
    'Đơn hàng không tồn tại',
  ])('HTTP400 không-tồn-tại xác định từ staging cho phép tạo cùng mã client: %s', async (message) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ code: 400, message, data: null }) });
    await expect(new GhnGateway().findByClientCode('DH1-SA')).resolves.toBeNull();
  });
  it.each([
    [400, 400, 'Token không hợp lệ', null],
    [400, 400, 'Thiếu client_order_code', null],
    [400, 400, 'Đơn hàng không tồn tại hoặc không có quyền truy cập', null],
    [400, 401, 'Đơn hàng không tồn tại', null],
    [400, 400, 'Đơn hàng không tồn tại', { order_code: 'EXISTING' }],
    [401, 400, 'Đơn hàng không tồn tại', null],
    [403, 400, 'Đơn hàng không tồn tại', null],
    [503, 400, 'Đơn hàng không tồn tại', null],
  ])('lỗi HTTP%s/code%s (%s) không được coi là mã client chưa tồn tại', async (status, code, message, data) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status, json: () => Promise.resolve({ code, message, data }) });
    await expect(new GhnGateway().findByClientCode('DH1-SA')).rejects.toBeInstanceOf(GhnHttpError);
  });
  it('HTTP400 không phải JSON vẫn giữ lỗi, không tạo mù', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.reject(new SyntaxError('invalid JSON')) });
    await expect(new GhnGateway().findByClientCode('DH1-SA')).rejects.toBeInstanceOf(GhnHttpError);
  });
  it('HTTP400 không-tồn-tại ở endpoint track không được đổi thành null', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ code: 400, message: 'Đơn hàng không tồn tại', data: null }) });
    await expect(new GhnGateway().track('GHN-1')).rejects.toBeInstanceOf(GhnHttpError);
  });
  it('timeout tra mã client giữ lỗi, không cho tạo mù', async () => {
    const timeout = new Error('request timeout');
    global.fetch = jest.fn().mockRejectedValue(timeout);
    await expect(new GhnGateway().findByClientCode('DH1-SA')).rejects.toBe(timeout);
  });
  it('huỷ HTTP 200 nhưng một mã result=false vẫn thất bại', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ code: 200, data: [{ order_code: 'G1', result: false }] }) });
    await expect(new GhnGateway().cancel('G1')).rejects.toMatchObject({ errorCode: 'SHIPMENT_CANCEL_REJECTED' });
  });
  it('báo phí dùng điểm lấy của từng shop thay vì kho mặc định tài khoản sàn', async () => {
    const mock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ code: 200, data: { total: 35000 } }) }); global.fetch = mock;
    const address = { name: 'A', phone: '0900000000', street: '1 A', provinceName: 'Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Bến Nghé', provinceId: 202, districtId: 1442, wardCode: '20101', addressSystem: 'legacy_3level' as const };
    await new GhnGateway().quote({ userId: 'u', shopId: 's', pickup: { ...address, districtId: 1443, wardCode: '20301' }, destination: address, parcel: { weightGram: 500, lengthCm: 20, widthCm: 15, heightCm: 10 }, codValue: '530000', fallbackFee: '30000' });
    const [, options] = mock.mock.calls[0] as [string, RequestInit];
    if (typeof options.body !== 'string') throw new Error('Thiếu body JSON');
    const body = JSON.parse(options.body) as Record<string, unknown>;
    expect(body).toMatchObject({ from_district_id: 1443, from_ward_code: '20301', to_district_id: 1442, to_ward_code: '20101', cod_value: 530000 });
  });
});
