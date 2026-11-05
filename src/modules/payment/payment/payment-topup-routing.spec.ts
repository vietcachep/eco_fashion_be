import { createHmac } from 'node:crypto';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { Env } from '@config/env';
import { PayosService } from '../payos/payos.service';
import { PaymentService } from './payment.service';

/*
 * Định tuyến webhook PayOS (PLAN-0041 §6.5): đơn hàng trước; mã không thuộc đơn ⇒ thử khoản NẠP CỌC (settleWebhookIfTopup); mã lạ ⇒ 200 bỏ qua.
 * Dựng PaymentService TỐI THIỂU với stub (không dùng buildFixture khổng lồ của payment-payos.spec). PayosService THẬT: chữ ký HMAC được kiểm thật.
 * Ghi chú: constructor nhận `topups` làm đối số CUỐI (WP-3). Ép kiểu constructor để spec này không phụ thuộc thứ tự tham số khác.
 */

const CHECKSUM = 'routing-checksum-key';
const PAYOS_CODE = '1790000000123456'; // mã đơn hàng (≈1,8e15)
const TOPUP_CODE = '5000000000000002'; // mã nạp cọc (dải 5e15)

const env = { EF_PAYOS_CLIENT_ID: 'cid', EF_PAYOS_API_KEY: 'key', EF_PAYOS_CHECKSUM_KEY: CHECKSUM, EF_PAYOS_API_URL: 'https://api.payos.test' } as unknown as Env;
const unconfiguredEnv = { EF_PAYOS_CLIENT_ID: '', EF_PAYOS_API_KEY: '', EF_PAYOS_CHECKSUM_KEY: '', EF_PAYOS_API_URL: '' } as unknown as Env;

/* Chữ ký như PayOS: HMAC-SHA256(checksum, `k=v` sắp theo khoá, nối bằng &) trên `data`. */
function signedBody(data: Record<string, unknown>, signature?: string): { code: string; desc: string; success: boolean; data: Record<string, unknown>; signature: string } {
  const canonical = Object.keys(data)
    .sort()
    .map((k) => `${k}=${typeof data[k] === 'string' || typeof data[k] === 'number' ? String(data[k]) : ''}`)
    .join('&');
  return { code: '00', desc: 'success', success: true, data, signature: signature ?? createHmac('sha256', CHECKSUM).update(canonical, 'utf8').digest('hex') };
}

const webhookData = (orderCode: string | number, code = '00'): Record<string, unknown> => ({
  orderCode: typeof orderCode === 'string' && /^\d+$/.test(orderCode) ? Number(orderCode) : orderCode,
  amount: 600000,
  reference: 'TF-ROUTE-1',
  transactionDateTime: '2026-11-03 10:05:00',
  code,
  desc: 'success',
});

function build(opts: { env?: Env; found?: { paymentId: string } | null } = {}) {
  const prisma = { paymentTransaction: { findFirst: jest.fn((): Promise<{ paymentId: string } | null> => Promise.resolve(opts.found ?? null)) } };
  const payos = new PayosService(opts.env ?? env);
  const topups = { settleWebhookIfTopup: jest.fn((_code: string, _data: Record<string, unknown>, _paidOk: boolean): Promise<{ outcome: string; message: string } | null> => Promise.resolve(null)) };
  const wallet = {};
  const moduleRef = {};
  const notifier = {};
  const users = {};
  const shops = {};
  const system = {};
  const Ctor = PaymentService as unknown as new (...args: unknown[]) => PaymentService;
  const service = new Ctor(prisma, payos, wallet, opts.env ?? env, moduleRef, notifier, users, shops, system, topups);
  const settlePayos = jest.spyOn(service as unknown as { settlePayos: (...args: unknown[]) => Promise<string> }, 'settlePayos').mockResolvedValue('paid');
  return { service, prisma, topups, settlePayos };
}

describe('PaymentService.handlePayos — định tuyến webhook đơn hàng / nạp cọc', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('[WTR-01] chữ ký sai ⇒ 401, không gọi topups', async () => {
    const { service, topups } = build();
    const r = await service.handlePayos(signedBody(webhookData(TOPUP_CODE), 'deadbeef'));
    expect(r.statusCode).toBe(401);
    expect(topups.settleWebhookIfTopup).not.toHaveBeenCalled();
  });

  it('[WTR-02] mã là payment đơn ⇒ đi đường đơn, KHÔNG gọi topups', async () => {
    const { service, topups, settlePayos } = build({ found: { paymentId: 'pay-1' } });
    const r = await service.handlePayos(signedBody(webhookData(PAYOS_CODE)));
    expect(r).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } });
    expect(settlePayos).toHaveBeenCalledTimes(1);
    expect(topups.settleWebhookIfTopup).not.toHaveBeenCalled();
  });

  it('[WTR-03] mã hợp lệ định dạng, không phải đơn, topups trả null ⇒ 200 Ignored: unknown order', async () => {
    const { service, topups } = build();
    const r = await service.handlePayos(signedBody(webhookData(TOPUP_CODE)));
    expect(topups.settleWebhookIfTopup).toHaveBeenCalledWith(TOPUP_CODE, expect.any(Object), true);
    expect(r).toEqual({ statusCode: 200, body: { code: '00', message: 'Ignored: unknown order' } });
  });

  it('[WTR-04] topups trả kết quả ⇒ 200 {code:"00", message}; topups ném ⇒ 500 {code:"99"} (PayOS gửi lại)', async () => {
    const ok = build();
    ok.topups.settleWebhookIfTopup.mockResolvedValueOnce({ outcome: 'credited', message: 'Success' });
    expect(await ok.service.handlePayos(signedBody(webhookData(TOPUP_CODE)))).toEqual({ statusCode: 200, body: { code: '00', message: 'Success' } });

    const boom = build();
    boom.topups.settleWebhookIfTopup.mockRejectedValueOnce(new Error('DB chết'));
    expect(await boom.service.handlePayos(signedBody(webhookData(TOPUP_CODE)))).toEqual({ statusCode: 500, body: { code: '99', message: 'Internal error' } });
  });

  it('[WTR-05] mã sai định dạng ⇒ không gọi topups (theo §9.1); paidOk=false được truyền xuống topups', async () => {
    // Ghi chú: §6.5 hiện gọi settleWebhookIfTopup cho MỌI mã không thuộc đơn; §6.4(C) chặn mã sai định dạng bên trong settle (không chạm DB).
    // Kỳ vọng dưới đây theo đúng §9.1 WTR-05; nếu đỏ ⇒ điều phối viên quyết định: thêm guard định dạng trong handlePayos hoặc sửa §9.1.
    const malformed = build();
    await malformed.service.handlePayos(signedBody(webhookData('abc')));
    expect(malformed.topups.settleWebhookIfTopup).not.toHaveBeenCalled();

    const unpaid = build();
    const r = await unpaid.service.handlePayos(signedBody(webhookData(TOPUP_CODE, '01')));
    expect(unpaid.topups.settleWebhookIfTopup).toHaveBeenCalledWith(TOPUP_CODE, expect.any(Object), false);
    expect(r.statusCode).toBe(200);
  });

  it('[WTR-06] PayOS chưa cấu hình ⇒ 401 PayOS not configured như cũ, không gọi topups', async () => {
    const { service, topups } = build({ env: unconfiguredEnv });
    const r = await service.handlePayos(signedBody(webhookData(TOPUP_CODE)));
    expect(r).toEqual({ statusCode: 401, body: { code: '01', message: 'PayOS not configured' } });
    expect(topups.settleWebhookIfTopup).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('không có trong hệ thống'));
  });
});
