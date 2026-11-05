import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { ShopOrderController } from '../../order/controller/shop-order.controller';
import { AdminReturnController, ReturnController, ShopReturnController } from './return.controllers';

/*
 * Hợp đồng route + quyền của đổi trả (PLAN-0022 §4–§5): kiểm bằng metadata của controller (không dựng app) — đổi route/quyền mà quên cập nhật FE là test đỏ.
 * shopId của vendor chỉ từ ngữ cảnh: route /shop/** đều qua ShopContextGuard và không route nào nhận :shopId.
 */

interface Route {
  method: string;
  path: string;
  perm?: string[];
  shopPerm?: string[];
}

function routesOf(ctrl: { prototype: object }): Route[] {
  const proto = ctrl.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
    .map((n) => {
      const fn = proto[n] as object;
      return {
        method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod],
        path: Reflect.getMetadata(PATH_METADATA, fn) as string,
        perm: Reflect.getMetadata('ef:permissions', fn) as string[] | undefined,
        shopPerm: Reflect.getMetadata('ef:shop-permissions', fn) as string[] | undefined,
      };
    });
}
const sig = (r: Route) => `${r.method} ${r.path}`;
const prefix = (ctrl: { prototype: object } | (new (...a: never[]) => unknown)) => Reflect.getMetadata(PATH_METADATA, ctrl) as string | undefined;

describe('ReturnController (khách)', () => {
  it('route theo plan §4.2: tạo · danh sách · chi tiết · ship-back · cancel · escalate — không route nào nhận userId', () => {
    expect(routesOf(ReturnController).map(sig).sort()).toEqual(['GET returns', 'GET returns/:id', 'POST orders/:code/returns', 'POST returns/:id/cancel', 'POST returns/:id/escalate', 'POST returns/:id/ship-back'].sort());
    expect(routesOf(ReturnController).every((r) => !r.path.includes(':userId') && !r.path.includes(':shopId'))).toBe(true);
  });
});

describe('AdminReturnController (sàn)', () => {
  it('/admin/returns: xem = order.return.read; phân xử = order.return.process; KHÔNG còn :id/process', () => {
    expect(prefix(AdminReturnController)).toBe('admin/returns');
    const r = routesOf(AdminReturnController);
    expect(r.map(sig).sort()).toEqual(['GET /', 'GET :id', 'POST :id/resolve'].sort());
    const byPath = Object.fromEntries(r.map((x) => [sig(x), x.perm]));
    expect(byPath['GET :id']).toEqual(['order.return.read']);
    expect(byPath['POST :id/resolve']).toEqual(['order.return.process']);
    expect(Object.values(byPath).flat()).not.toContain('order.return.update');
    expect(r.some((x) => x.path.endsWith('/process'))).toBe(false);
  });
});

describe('ShopReturnController (vendor)', () => {
  it('/shop/returns qua ShopContextGuard; đọc = shop.return.read; duyệt/từ chối/nhận hàng = shop.return.process', () => {
    expect(prefix(ShopReturnController)).toBe('shop/returns');
    expect(Reflect.getMetadata(GUARDS_METADATA, ShopReturnController) as unknown[]).toContain(ShopContextGuard);
    const r = Object.fromEntries(routesOf(ShopReturnController).map((x) => [sig(x), x.shopPerm]));
    expect(Object.keys(r).sort()).toEqual(['GET /', 'GET :id', 'POST :id/approve', 'POST :id/receive', 'POST :id/reject'].sort());
    expect(r['GET :id']).toEqual(['shop.return.read']);
    expect(r['POST :id/approve']).toEqual(['shop.return.process']);
    expect(r['POST :id/reject']).toEqual(['shop.return.process']);
    expect(r['POST :id/receive']).toEqual(['shop.return.process']);
  });

  it('[SHP-09] POST /shop/orders/:code/delivery-failed và /goods-returned cần shop.order.update (PLAN-0031 §2.4: người giao hàng báo giao thất bại, không phải người xử lý đổi trả)', () => {
    const failed = routesOf(ShopOrderController).find((x) => x.path === ':code/delivery-failed');
    expect(failed).toMatchObject({ method: 'POST', shopPerm: ['shop.order.update'] });
    const back = routesOf(ShopOrderController).find((x) => x.path === ':code/goods-returned');
    expect(back).toMatchObject({ method: 'POST', shopPerm: ['shop.order.update'] });
  });
});
