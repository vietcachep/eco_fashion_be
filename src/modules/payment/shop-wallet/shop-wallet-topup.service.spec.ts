import { HttpStatus } from '@nestjs/common';
import { BusinessException } from '@common/exception/business.exception';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { WALLET_ERR } from '../foundation/payment.constants';
import { PayosService } from '../payos/payos.service';
import { ACCOUNTANT, bizError, buildTopupFixture, NOW, nextTopupCode, OWNER_A, SHOP_A, SHOP_B, stopFixture } from './shop-wallet-topup.fixture';
import type { TopupFixture } from './shop-wallet-topup.fixture';
import type { TopupShopContext } from './shop-wallet-topup.types';

/*
 * ShopWalletTopupService (PLAN-0041 §6.4 A/F/H, WP-2) trên DB giả + PayosService thật (3 hàm mạng spy).
 * Kiểm: cờ/cấu hình/mức tiền, tái dùng khoản mở, đua tạo link, khoản quá hạn/mồ côi, lỗi PayOS, đọc/huỷ cách ly theo shop, sàn xem-only.
 */

const CTX_A: TopupShopContext = { shopId: SHOP_A, shopCode: 'TECHZONE', shopName: 'Techzone' };
const CTX_B: TopupShopContext = { shopId: SHOP_B, shopCode: 'SPORTPLANET', shopName: 'Sport Planet' };
const AMOUNT = 600_000n;

describe('ShopWalletTopupService — tạo/đọc/huỷ link nạp cọc', () => {
  let fx: TopupFixture;
  let svc: TopupFixture['topups'];
  beforeEach(() => {
    fx = buildTopupFixture();
    svc = fx.topups;
  });
  afterEach(() => stopFixture());

  const openRowsOf = (shopId: string) => fx.topupRows().filter((r) => r.shopId === shopId && ['creating', 'pending', 'partial'].includes(String(r.status)));

  it('[WTU-01] cờ tắt ⇒ 409 WALLET_TOPUP_DISABLED, không gọi PayOS, không ghi DB (WTP-18)', async () => {
    fx.setting(SETTING_KEY.WALLET_PAYOS_DEPOSIT_ENABLED, false);
    const err = await bizError(svc.create(OWNER_A, CTX_A, AMOUNT));
    expect(err.errorCode).toBe(WALLET_ERR.TOPUP_DISABLED);
    expect(err.httpStatus).toBe(HttpStatus.CONFLICT);
    expect(fx.createLink).not.toHaveBeenCalled();
    expect(fx.topupRows()).toHaveLength(0);
  });

  it('[WTU-02] PayOS chưa cấu hình ⇒ 503 WALLET_TOPUP_UNAVAILABLE (WTP-18)', async () => {
    const off = buildTopupFixture({ payosConfigured: false });
    const err = await bizError(off.topups.create(OWNER_A, CTX_A, AMOUNT));
    expect(err.errorCode).toBe(WALLET_ERR.TOPUP_UNAVAILABLE);
    expect(err.httpStatus).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(off.createLink).not.toHaveBeenCalled();
  });

  it('[WTU-03] production + EF_ADMIN_URL là http ⇒ 503 WALLET_TOPUP_UNAVAILABLE; production + https ⇒ qua (WTP-18)', async () => {
    const insecure = buildTopupFixture({ production: true, adminUrl: 'http://localhost:3001' });
    expect((await bizError(insecure.topups.create(OWNER_A, CTX_A, AMOUNT))).errorCode).toBe(WALLET_ERR.TOPUP_UNAVAILABLE);
    expect(insecure.createLink).not.toHaveBeenCalled();

    const secure = buildTopupFixture({ production: true, adminUrl: 'https://fitly-admin.test' });
    await expect(secure.topups.create(OWNER_A, CTX_A, AMOUNT)).resolves.toMatchObject({ reused: false });
  });

  it('[WTU-04] dưới min ⇒ 400 WALLET_DEPOSIT_TOO_SMALL; trên max ⇒ 400 WALLET_TOPUP_TOO_LARGE; đúng min và đúng max ⇒ được (WTP-23)', async () => {
    const small = await bizError(svc.create(OWNER_A, CTX_A, 499_999n));
    expect(small.errorCode).toBe(WALLET_ERR.DEPOSIT_TOO_SMALL);
    expect(small.httpStatus).toBe(HttpStatus.BAD_REQUEST);

    const large = await bizError(svc.create(OWNER_A, CTX_B, 50_000_001n));
    expect(large.errorCode).toBe(WALLET_ERR.TOPUP_TOO_LARGE);
    expect(large.httpStatus).toBe(HttpStatus.BAD_REQUEST);

    await expect(svc.create(OWNER_A, CTX_A, 500_000n)).resolves.toMatchObject({ reused: false });
    await expect(svc.create(OWNER_A, CTX_B, 50_000_000n)).resolves.toMatchObject({ reused: false });
    expect(fx.createLink).toHaveBeenCalledTimes(2);
  });

  it('[WTU-05] tạo thành công: create(creating) → PayOS (ngoài transaction) → markLinkCreated(pending); mã dải nạp; description, returnUrl/cancelUrl, expiresAt đúng; audit WALLET_TOPUP_CREATED đúng một lần (WTP-01)', async () => {
    const r = await svc.create(OWNER_A, CTX_A, AMOUNT);
    expect(r.reused).toBe(false);
    expect(r.topup.status).toBe('pending');
    expect(r.topup.checkoutUrl).toMatch(/^https:\/\/pay\.payos\.test\/web\//);

    expect(fx.createLink).toHaveBeenCalledTimes(1);
    const link = fx.createdLinks[0];
    expect(String(link.orderCode)).toMatch(/^5\d{15}$/);
    expect(link.description).toBe('NAPCOC TECHZONE');
    expect(link.description.length).toBeLessThanOrEqual(25);
    expect(link.returnUrl).toBe('https://fitly-admin.test/vendor/wallet/payos-return');
    expect(link.cancelUrl).toBe(link.returnUrl);
    expect(link.expiresAt.getTime()).toBe(NOW + 60 * 60_000);
    expect(link.amount).toBe(AMOUNT);
    expect(fx.createLinkDepth).toEqual([0]);

    const labels = fx.engine.calls.map((c) => c.label);
    const created = labels.indexOf('shop_cod_topups.create');
    const payos = labels.indexOf('PAYOS createPaymentLink ' + String(link.orderCode));
    const linked = labels.indexOf('shop_cod_topups.update');
    expect(created).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(payos);
    expect(payos).toBeLessThan(linked);

    expect(fx.auditOf('WALLET_TOPUP_CREATED')).toHaveLength(1);
  });

  it('[WTU-06] gọi lần hai khi còn link pending còn hạn ⇒ trả link cũ (reused:true), KHÔNG gọi PayOS, KHÔNG tạo dòng; số tiền khác vẫn trả link cũ (WTP-20)', async () => {
    const first = await svc.create(OWNER_A, CTX_A, AMOUNT);
    const second = await svc.create(OWNER_A, CTX_A, 700_000n);
    expect(second.reused).toBe(true);
    expect(second.topup.id).toBe(first.topup.id);
    expect(second.topup.checkoutUrl).toBe(first.topup.checkoutUrl);
    expect(fx.createLink).toHaveBeenCalledTimes(1);
    expect(fx.topupRows()).toHaveLength(1);
  });

  it('[WTU-07] hai lần tạo ĐỒNG THỜI ⇒ đúng 1 dòng mở; bên thua nhận reused hoặc 409 WALLET_TOPUP_IN_PROGRESS, không 500 (WTP-21)', async () => {
    const results = await Promise.allSettled([svc.create(OWNER_A, CTX_A, AMOUNT), svc.create(OWNER_A, CTX_A, AMOUNT)]);
    expect(openRowsOf(SHOP_A)).toHaveLength(1);
    expect(fx.createLink).toHaveBeenCalledTimes(1);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      if (r.status === 'fulfilled') {
        expect(typeof r.value.reused).toBe('boolean');
      } else {
        expect(r.reason).toBeInstanceOf(BusinessException);
        expect((r.reason as BusinessException).errorCode).toBe(WALLET_ERR.TOPUP_IN_PROGRESS);
      }
    }
  });

  it('[WTU-08] link pending quá expires_at chưa quét ⇒ settle.reconcileOne(id, forceClose) rồi tạo mới (WTP-22)', async () => {
    const stale = fx.seedTopup({ shopId: SHOP_A, status: 'pending', expiresAt: new Date(NOW - 60_000), payosOrderCode: nextTopupCode() });
    const spy = jest.spyOn(fx.settle, 'reconcileOne');
    const r = await svc.create(OWNER_A, CTX_A, AMOUNT);
    expect(spy).toHaveBeenCalledWith(stale.id, { forceClose: true });
    expect(String(fx.topupOf(stale.id)?.status)).toBe('expired');
    expect(r.reused).toBe(false);
    expect(r.topup.id).not.toBe(stale.id);
    expect(fx.createLink).toHaveBeenCalledTimes(1);
  });

  it('[WTU-09] dòng creating < 60 s ⇒ 409 WALLET_TOPUP_IN_PROGRESS; > 60 s ⇒ đóng rồi tạo mới', async () => {
    fx.seedTopup({ shopId: SHOP_A, status: 'creating', checkoutUrl: null, createdAt: new Date(NOW - 10_000) });
    const busy = await bizError(svc.create(OWNER_A, CTX_A, AMOUNT));
    expect(busy.errorCode).toBe(WALLET_ERR.TOPUP_IN_PROGRESS);
    expect(busy.httpStatus).toBe(HttpStatus.CONFLICT);
    expect(fx.createLink).not.toHaveBeenCalled();

    const dead = fx.seedTopup({ shopId: SHOP_B, status: 'creating', checkoutUrl: null, createdAt: new Date(NOW - 120_000) });
    const r = await svc.create(OWNER_A, CTX_B, AMOUNT);
    // PayOS (giả) đang biết link ⇒ dòng creating quá 60 giây được đóng là expired rồi mới tạo khoản mới.
    expect(String(fx.topupOf(dead.id)?.status)).toBe('expired');
    expect(r.reused).toBe(false);
    expect(r.topup.id).not.toBe(dead.id);
  });

  it('[WTU-10] PayOS trả checkoutUrl null hoặc ném ⇒ 503 WALLET_TOPUP_LINK_FAILED; dòng thành failed; không còn khoản mở; lần sau tạo được (WTP-17)', async () => {
    fx.createLink.mockResolvedValueOnce({ checkoutUrl: null, qrCode: null, paymentLinkId: null });
    const a = await bizError(svc.create(OWNER_A, CTX_A, AMOUNT));
    expect(a.errorCode).toBe(WALLET_ERR.TOPUP_LINK_FAILED);
    expect(a.httpStatus).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(openRowsOf(SHOP_A)).toHaveLength(0);

    fx.createLink.mockRejectedValueOnce(new Error('timeout'));
    const b = await bizError(svc.create(OWNER_A, CTX_A, AMOUNT));
    expect(b.errorCode).toBe(WALLET_ERR.TOPUP_LINK_FAILED);
    expect(fx.topupRows().filter((r) => r.status === 'failed')).toHaveLength(2);

    await expect(svc.create(OWNER_A, CTX_A, AMOUNT)).resolves.toMatchObject({ reused: false });
    expect(openRowsOf(SHOP_A)).toHaveLength(1);
  });

  it('[WTU-11] trùng mã PayOS (P2002, không có khoản mở) ⇒ sinh mã mới tối đa 5 lần rồi 503 (không 500)', async () => {
    const taken = '5000000000000042';
    fx.seedTopup({ shopId: SHOP_B, status: 'paid', payosOrderCode: taken, receivedAmount: 600_000 });
    const gen = jest.spyOn(PayosService, 'generateTopupOrderCode').mockReturnValue(Number(taken));
    const err = await bizError(svc.create(OWNER_A, CTX_A, AMOUNT));
    expect(err.errorCode).toBe(WALLET_ERR.TOPUP_LINK_FAILED);
    expect(err.httpStatus).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(gen).toHaveBeenCalledTimes(5);
    expect(fx.createLink).not.toHaveBeenCalled();
  });

  it('[WTU-12] getMine: shop khác ⇒ 404; khoản còn mở ⇒ reconcileOne(minIntervalMs 8000); khoản đã đóng ⇒ không hỏi PayOS; reconcileOne ném ⇒ vẫn trả dòng (WTP-24)', async () => {
    const open = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    const paid = fx.seedTopup({ shopId: SHOP_A, status: 'paid', receivedAmount: 600_000, payosOrderCode: nextTopupCode(), createdAt: new Date(NOW - 7_200_000) });
    const spy = jest.spyOn(fx.settle, 'reconcileOne');

    const notMine = await bizError(svc.getMine(SHOP_B, open.id));
    expect(notMine.errorCode).toBe(WALLET_ERR.TOPUP_NOT_FOUND);
    expect(notMine.httpStatus).toBe(HttpStatus.NOT_FOUND);

    await expect(svc.getMine(SHOP_A, open.id)).resolves.toMatchObject({ id: open.id });
    expect(spy).toHaveBeenCalledWith(open.id, { minIntervalMs: 8_000 });

    spy.mockClear();
    await expect(svc.getMine(SHOP_A, paid.id)).resolves.toMatchObject({ id: paid.id, status: 'paid' });
    expect(spy).not.toHaveBeenCalled();

    spy.mockRejectedValueOnce(new Error('PayOS chết'));
    await expect(svc.getMine(SHOP_A, open.id)).resolves.toMatchObject({ id: open.id });
  });

  it('[WTU-13] getMineByOrderCode: mã sai định dạng ⇒ 404 KHÔNG chạm DB; của shop khác ⇒ 404; của mình ⇒ trả khoản', async () => {
    const mine = fx.seedTopup({ shopId: SHOP_A, status: 'paid', receivedAmount: 600_000, payosOrderCode: nextTopupCode() });

    const before = fx.engine.calls.length;
    for (const bad of ['abc', '12345678901234567', '']) {
      const e = await bizError(svc.getMineByOrderCode(SHOP_A, bad));
      expect(e.errorCode).toBe(WALLET_ERR.TOPUP_NOT_FOUND);
    }
    expect(fx.engine.calls.length).toBe(before);

    const other = await bizError(svc.getMineByOrderCode(SHOP_B, String(mine.payosOrderCode)));
    expect(other.httpStatus).toBe(HttpStatus.NOT_FOUND);

    await expect(svc.getMineByOrderCode(SHOP_A, String(mine.payosOrderCode))).resolves.toMatchObject({ id: mine.id });
  });

  it('[WTU-14] cancelMine: pending ⇒ cancelled rồi mới gọi PayOS huỷ (NGOÀI transaction; PayOS lỗi vẫn thành công); paid ⇒ 409; shop khác ⇒ 404 (WTP-25)', async () => {
    const pending = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    // Ghi nhận lời gọi PayOS (để kiểm thứ tự) trước khi giả lập lỗi mạng.
    fx.cancelLink.mockImplementationOnce((code) => {
      fx.cancelLinkDepth.push(fx.engine.openTxCount());
      fx.engine.mark(`PAYOS cancelPaymentLink ${String(code)}`);
      return Promise.reject(new Error('timeout'));
    });
    const row = await svc.cancelMine(ACCOUNTANT, SHOP_A, pending.id);
    expect(row.status).toBe('cancelled');
    expect(String(row.cancelledBy)).toBe(ACCOUNTANT.userId);

    const labels = fx.engine.calls.map((c) => c.label);
    expect(labels.indexOf('shop_cod_topups.update')).toBeLessThan(labels.indexOf(`PAYOS cancelPaymentLink ${String(pending.payosOrderCode)}`));
    expect(fx.cancelLinkDepth).toEqual([0]);

    const paid = fx.seedTopup({ shopId: SHOP_A, status: 'paid', receivedAmount: 600_000, payosOrderCode: nextTopupCode() });
    const invalid = await bizError(svc.cancelMine(OWNER_A, SHOP_A, paid.id));
    expect(invalid.errorCode).toBe(WALLET_ERR.TOPUP_INVALID_STATE);
    expect(invalid.httpStatus).toBe(HttpStatus.CONFLICT);

    const other = fx.seedTopup({ shopId: SHOP_B, status: 'pending', payosOrderCode: nextTopupCode() });
    expect((await bizError(svc.cancelMine(OWNER_A, SHOP_A, other.id))).httpStatus).toBe(HttpStatus.NOT_FOUND);
  });

  it('[WTU-15] summaryFor: enabled=false khi cờ tắt / PayOS thiếu / EF_ADMIN_URL không dùng được; active=null khi hết hạn hoặc đã đóng; min/max đúng setting', async () => {
    await expect(svc.summaryFor(SHOP_A)).resolves.toEqual({ enabled: true, minAmount: 500_000, maxAmount: 50_000_000, active: null });

    const active = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    expect((await svc.summaryFor(SHOP_A)).active?.id).toBe(active.id);

    fx.seedTopup({ shopId: SHOP_B, status: 'pending', expiresAt: new Date(NOW - 1000), payosOrderCode: nextTopupCode() });
    expect((await svc.summaryFor(SHOP_B)).active).toBeNull();

    fx.setting(SETTING_KEY.WALLET_PAYOS_DEPOSIT_ENABLED, false);
    expect((await svc.summaryFor(SHOP_A)).enabled).toBe(false);

    const offPayos = buildTopupFixture({ payosConfigured: false });
    expect((await offPayos.topups.summaryFor(SHOP_A)).enabled).toBe(false);

    const insecure = buildTopupFixture({ production: true, adminUrl: 'http://localhost:3001' });
    expect((await insecure.topups.summaryFor(SHOP_A)).enabled).toBe(false);
  });

  it('[WTU-16] listMine lọc theo shop ngữ cảnh + status, phân trang mới nhất trước; listAll lọc shopId/status; getForAdmin trả biên nhận theo thời gian; shopNames một truy vấn', async () => {
    const paid = fx.seedTopup({ shopId: SHOP_A, status: 'paid', receivedAmount: 600_000, payosOrderCode: nextTopupCode(), createdAt: new Date(NOW - 3_000) });
    const pending = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode(), createdAt: new Date(NOW - 2_000) });
    const expired = fx.seedTopup({ shopId: SHOP_A, status: 'expired', closedAt: new Date(NOW - 500), payosOrderCode: nextTopupCode(), createdAt: new Date(NOW - 1_000) });
    fx.seedTopup({ shopId: SHOP_B, status: 'pending', payosOrderCode: nextTopupCode() });

    const page = await svc.listMine(SHOP_A, {}, 0, 2);
    expect(page.total).toBe(3);
    expect(page.items.map((t) => t.id)).toEqual([expired.id, pending.id]);
    const onlyPaid = await svc.listMine(SHOP_A, { status: 'paid' }, 0, 10);
    expect(onlyPaid.items.map((t) => t.id)).toEqual([paid.id]);

    const all = await svc.listAll({ shopId: SHOP_B }, 0, 10);
    expect(all.total).toBe(1);
    expect(all.items.every((t) => t.shopId === SHOP_B)).toBe(true);
    expect((await svc.listAll({ status: 'pending' }, 0, 10)).total).toBe(2);

    fx.seedReceipt(paid.id, 'LATE-REF', 200_000, new Date(NOW - 100));
    fx.seedReceipt(paid.id, 'EARLY-REF', 400_000, new Date(NOW - 500));
    const detail = await svc.getForAdmin(paid.id);
    expect(detail.receipts.map((r) => r.reference)).toEqual(['EARLY-REF', 'LATE-REF']);
    const missing = await bizError(svc.getForAdmin('00000000-0000-4000-8000-000000000000'));
    expect(missing.errorCode).toBe(WALLET_ERR.TOPUP_NOT_FOUND);
    expect(missing.httpStatus).toBe(HttpStatus.NOT_FOUND);

    const names = await svc.shopNames([SHOP_A, SHOP_B]);
    expect(names.get(SHOP_A)).toBe('Techzone');
    expect(names.get(SHOP_B)).toBe('Sport Planet');
  });
});
