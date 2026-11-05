import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RATE_LIMIT_KEY } from '@common/security/rate-limit.guard';
import { PERMISSIONS_KEY } from '@common/security/decorators';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { SHOP_PERMISSIONS_KEY, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { bizError, buildTopupFixture, NOW, nextTopupCode, OWNER_A, SHOP_A, SHOP_B, SHOP_OFFICIAL, stopFixture } from './shop-wallet-topup.fixture';
import type { TopupFixture } from './shop-wallet-topup.fixture';
import { CreateTopupRequest, TopupListQuery } from './dto/shop-wallet-topup.dto';
import { ShopWalletTopupController } from './controller/shop-wallet-topup.controller';
import { ShopWalletController } from './controller/shop-wallet.controller';
import { WALLET_ERR } from '../foundation/payment.constants';

/*
 * Controller nạp cọc PayOS (PLAN-0041 §5.1–5.2, WP-2) + cách ly theo shop + payosTopup trên GET /shop/wallet.
 * Kiểm metadata route/guard/quyền/rate-limit (không gọi HTTP), DTO bằng class-validator, mapper qua controller gọi thẳng service thật (DB giả).
 */

const shopCtx = (shopId: string, shopCode: string, shopName: string): ShopContext => ({
  shopId,
  shopCode,
  shopName,
  shopStatus: 'approved',
  memberId: `member-${shopCode}`,
  roleId: 'role-owner',
  roleCode: 'shop_owner',
  roleName: 'Chủ shop',
  permissionCodes: ['shop.wallet.read', 'shop.wallet.deposit_request'],
});
const CTX_A = shopCtx(SHOP_A, 'TECHZONE', 'Techzone');
const CTX_B = shopCtx(SHOP_B, 'SPORTPLANET', 'Sport Planet');

/* Route = phương thức HTTP + đường dẫn (không có "/" đầu) đọc từ metadata của handler, theo thứ tự khai báo trong class. */
const proto = ShopWalletTopupController.prototype;
const routes = Object.getOwnPropertyNames(proto)
  .filter((name) => name !== 'constructor')
  .map((name) => {
    const handler = Object.getOwnPropertyDescriptor(proto, name)!.value as (...args: unknown[]) => unknown;
    return { name, handler, method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod, path: (Reflect.getMetadata(PATH_METADATA, handler) as string).replace(/^\//, '') };
  });
const handlerOf = (method: RequestMethod, path: string) => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`Thiếu route ${RequestMethod[method]} ${path}`);
  return r.handler;
};
const GET = RequestMethod.GET;
const POST = RequestMethod.POST;

/* ApiResponse.data có kiểu T | null; ở đây handler luôn trả dữ liệu — thiếu thì test thất bại ngay tại chỗ. */
const dataOf = <T>(r: { data: T | null }): T => {
  if (r.data === null) throw new Error('ApiResponse không có data');
  return r.data;
};

describe('ShopWalletTopupController — route, quyền, DTO, mapper, cách ly', () => {
  let fx: TopupFixture;
  let controller: ShopWalletTopupController;
  beforeEach(() => {
    fx = buildTopupFixture();
    controller = new ShopWalletTopupController(fx.topups);
  });
  afterEach(() => stopFixture());

  it('[WTC-01] mỗi route có đúng phương thức + đường dẫn; by-order-code khai báo TRƯỚC :id', () => {
    const declared = routes.map((r) => `${RequestMethod[r.method]} ${r.path}`);
    expect(declared).toEqual(
      expect.arrayContaining([
        'POST shop/wallet/topups',
        'GET shop/wallet/topups',
        'GET shop/wallet/topups/by-order-code/:orderCode',
        'GET shop/wallet/topups/:id',
        'POST shop/wallet/topups/:id/cancel',
        'GET admin/wallet-topups',
        'GET admin/wallet-topups/:id',
      ]),
    );
    expect(routes).toHaveLength(7);
    const paths = routes.map((r) => r.path);
    expect(paths.indexOf('shop/wallet/topups/by-order-code/:orderCode')).toBeLessThan(paths.indexOf('shop/wallet/topups/:id'));
  });

  it('[WTC-02] vendor: ShopContextGuard + RequireShopPermission đúng mã + @RateLimit đúng tên; sàn: RequirePermission supplier.wallet.read, không ShopContextGuard', () => {
    const guards = (h: unknown) => (Reflect.getMetadata(GUARDS_METADATA, h as object) as unknown[] | undefined) ?? [];
    const rate = (h: unknown) => (Reflect.getMetadata(RATE_LIMIT_KEY, h as object) as { name: string } | undefined)?.name;
    const shopPerm = (h: unknown) => Reflect.getMetadata(SHOP_PERMISSIONS_KEY, h as object) as string[] | undefined;

    const create = handlerOf(POST, 'shop/wallet/topups');
    expect(guards(create)).toContain(ShopContextGuard);
    expect(shopPerm(create)).toEqual(['shop.wallet.deposit_request']);
    expect(rate(create)).toBe('wallet-topup-create');

    const list = handlerOf(GET, 'shop/wallet/topups');
    expect(shopPerm(list)).toEqual(['shop.wallet.read']);

    for (const h of [handlerOf(GET, 'shop/wallet/topups/by-order-code/:orderCode'), handlerOf(GET, 'shop/wallet/topups/:id')]) {
      expect(guards(h)).toContain(ShopContextGuard);
      expect(shopPerm(h)).toEqual(['shop.wallet.read']);
      expect(rate(h)).toBe('wallet-topup-read');
    }

    const cancel = handlerOf(POST, 'shop/wallet/topups/:id/cancel');
    expect(shopPerm(cancel)).toEqual(['shop.wallet.deposit_request']);
    expect(rate(cancel)).toBe('wallet-topup-cancel');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, cancel)).toBe(200);

    for (const path of ['admin/wallet-topups', 'admin/wallet-topups/:id']) {
      const h = handlerOf(GET, path);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, h as object)).toEqual(['supplier.wallet.read']);
      expect(guards(h)).not.toContain(ShopContextGuard);
    }
  });

  it('[WTC-03] DTO: amount sai định dạng (0, âm, thập phân, chữ, 16 chữ số, rỗng) bị từ chối; trường lạ bị từ chối; status ngoài tập bị từ chối; size > 100 bị từ chối', async () => {
    const opts = { whitelist: true, forbidNonWhitelisted: true };
    for (const amount of ['0', '-5', '1.5', 'abc', '1000000000000000', '', undefined]) {
      const body = plainToInstance(CreateTopupRequest, { amount });
      expect((await validate(body, opts)).length).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(CreateTopupRequest, { amount: '600000' }), opts)).toHaveLength(0);
    expect(await validate(plainToInstance(CreateTopupRequest, { amount: '99999999999999' }), opts)).toHaveLength(0);
    expect((await validate(plainToInstance(CreateTopupRequest, { amount: '600000', shopId: SHOP_B }), opts)).length).toBeGreaterThan(0);

    expect((await validate(plainToInstance(TopupListQuery, { status: 'bogus' }), opts)).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(TopupListQuery, { size: '101' }), opts)).length).toBeGreaterThan(0);
    expect(await validate(plainToInstance(TopupListQuery, { size: '100', status: 'pending' }), opts)).toHaveLength(0);
  });

  it('[WTC-04] response: checkoutUrl chỉ cho vendor khi pending|partial còn hạn; admin luôn null; canCancel đúng; biên nhận chỉ ở chi tiết sàn', async () => {
    const created = dataOf(await controller.create(plainToInstance(CreateTopupRequest, { amount: '600000' }), OWNER_A, CTX_A));
    expect(created.reused).toBe(false);
    expect(created.checkoutUrl).toMatch(/^https:\/\/pay\.payos\.test\/web\//);
    expect(created.canCancel).toBe(true);

    const partial = fx.seedTopup({ shopId: SHOP_B, status: 'partial', receivedAmount: 100_000, payosOrderCode: nextTopupCode() });
    const vendorView = dataOf(await controller.getMine(partial.id, CTX_B));
    expect(vendorView.checkoutUrl).not.toBeNull();
    expect(vendorView.canCancel).toBe(true);

    const paid = fx.seedTopup({ shopId: SHOP_B, status: 'paid', receivedAmount: 600_000, payosOrderCode: nextTopupCode() });
    const paidView = dataOf(await controller.getMine(paid.id, CTX_B));
    expect(paidView.checkoutUrl).toBeNull();
    expect(paidView.canCancel).toBe(false);

    // Khoản pending đã quá hạn (không có khoản mở khác của SHOP_OFFICIAL): link không được lộ dù còn ở trạng thái pending.
    const expiredLink = fx.seedTopup({ shopId: SHOP_OFFICIAL, status: 'pending', payosOrderCode: nextTopupCode(), expiresAt: new Date(NOW - 1000) });
    const expiredView = dataOf(await controller.listMine(plainToInstance(TopupListQuery, {}), shopCtx(SHOP_OFFICIAL, 'OFFICIAL', 'Gian hàng sàn')));
    const hidden = expiredView.content.find((t) => t.id === expiredLink.id);
    expect(hidden?.checkoutUrl).toBeNull();

    const adminList = dataOf(await controller.listAll(plainToInstance(TopupListQuery, {})));
    expect(adminList.content.every((t) => t.checkoutUrl === null && t.canCancel === false)).toBe(true);

    const adminDetail = dataOf(await controller.detail(created.id));
    expect(adminDetail.checkoutUrl).toBeNull();
    expect(adminDetail.canCancel).toBe(false);
    expect(Array.isArray(adminDetail.receipts)).toBe(true);
  });

  it('[WTI-01] cách ly: khoản shop B không xem/huỷ được từ phiên shop A (404) qua GET :id, by-order-code, list, cancel; shopId trong query bị bỏ qua', async () => {
    const bTopup = fx.seedTopup({ shopId: SHOP_B, status: 'pending', payosOrderCode: nextTopupCode() });

    const byId = await bizError(controller.getMine(bTopup.id, CTX_A));
    expect(byId.httpStatus).toBe(404);
    expect(byId.errorCode).toBe(WALLET_ERR.TOPUP_NOT_FOUND);

    const byCode = await bizError(controller.byOrderCode(String(bTopup.payosOrderCode), CTX_A));
    expect(byCode.httpStatus).toBe(404);

    const cancel = await bizError(controller.cancel(bTopup.id, OWNER_A, CTX_A));
    expect(cancel.httpStatus).toBe(404);
    expect(String(fx.topupOf(bTopup.id)?.status)).toBe('pending');

    const aTopup = fx.seedTopup({ shopId: SHOP_A, status: 'paid', receivedAmount: 600_000, payosOrderCode: nextTopupCode() });
    // shopId = B trong query bị bỏ qua: vendor luôn chỉ thấy khoản của phiên (shop A).
    const list = dataOf(await controller.listMine(plainToInstance(TopupListQuery, { shopId: SHOP_B }), CTX_A));
    expect(list.content.map((t) => t.id)).toEqual([aTopup.id]);
    expect(list.content.every((t) => t.shopId === SHOP_A)).toBe(true);
  });

  it('[WTI-02] GET /shop/wallet (vendor) trả payosTopup {enabled,minAmount,maxAmount,active}; GET /admin/shops/:id/wallet KHÔNG có trường payosTopup', async () => {
    const wallet = new ShopWalletController(fx.wallet, fx.topups);
    const mine = dataOf(await wallet.mine(CTX_A));
    expect(mine.payosTopup).toEqual({ enabled: true, minAmount: 500_000, maxAmount: 50_000_000, active: null });

    const open = fx.seedTopup({ shopId: SHOP_A, status: 'pending', payosOrderCode: nextTopupCode() });
    const withActive = dataOf(await wallet.mine(CTX_A));
    expect(withActive.payosTopup?.active?.id).toBe(open.id);
    expect(withActive.payosTopup?.active?.checkoutUrl).not.toBeNull();

    const admin = dataOf(await wallet.walletOf(SHOP_A));
    expect(admin).not.toHaveProperty('payosTopup');
  });
});
