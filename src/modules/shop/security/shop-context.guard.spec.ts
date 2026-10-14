import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, UnauthorizedException } from '@common/exception/business.exception';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import { SHOP_STATUS } from '../foundation/shop.constants';
import type { ShopMemberRepository, ShopMemberRow } from '../member/repository/shop-member.repository';
import type { ShopRepository, ShopRow } from '../shop/repository/shop.repository';
import { ShopContextGuard } from './shop-context.guard';
import type { RequestWithShop } from './shop-permission.decorator';

/*
 * ShopContextGuard là chốt chặn DUY NHẤT cách ly dữ liệu giữa các gian hàng ở tầng route: nó suy `shopId`
 * CHỈ từ actor.userId (JWT đã ký, guard toàn cục JwtAuthGuard gắn vào request) qua ShopMember — không bao
 * giờ đọc `body`/`query`/`params` của request. Bộ test dưới đây chứng minh: (1) vendor A luôn resolve ra
 * đúng shop của A dù request có bị chèn shopId của shop B ở bất kỳ vị trí nào khác; (2) không phải thành
 * viên → 403; (3) gian hàng bị khoá → 403 dù ShopMember vẫn active; (4) thiếu quyền `shop.*` theo vai → 403.
 */

type ShopFixture = Pick<ShopRow, 'id' | 'code' | 'name' | 'status'>;
type MemberFixture = Pick<ShopMemberRow, 'id' | 'shopId' | 'userId' | 'roleId' | 'status'>;

function fakeReflector(required: string[] | undefined): Reflector {
  const partial: Pick<Reflector, 'getAllAndOverride'> = { getAllAndOverride: () => required };
  return partial as unknown as Reflector;
}

function fakeMembers(byUserId: Record<string, MemberFixture | undefined>): ShopMemberRepository {
  const partial: Pick<ShopMemberRepository, 'findActiveByUserId'> = {
    findActiveByUserId: (userId: string) => Promise.resolve((byUserId[userId] as ShopMemberRow | undefined) ?? null),
  };
  return partial as unknown as ShopMemberRepository;
}

function fakeShops(byId: Record<string, ShopFixture | undefined>): ShopRepository {
  const partial: Pick<ShopRepository, 'findById'> = {
    findById: (id: string) => Promise.resolve((byId[id] as ShopRow | undefined) ?? null),
  };
  return partial as unknown as ShopRepository;
}

function fakeIdentity(permissionCodes: string[]): IdentityQueryApi {
  const partial: Pick<IdentityQueryApi, 'shopRoleContext'> = {
    shopRoleContext: () => Promise.resolve({ code: 'shop_owner', name: 'Chủ gian hàng', permissionCodes }),
  };
  return partial as unknown as IdentityQueryApi;
}

/*
 * ExecutionContext thật có nhiều phương thức (switchToRpc/WS, getArgs…) mà guard KHÔNG dùng — nên dựng đúng 3
 * phương thức guard gọi (switchToHttp().getRequest, getHandler, getClass) rồi ép kiểu MỘT lần ở đây, không rải 'as' khắp test.
 */
function fakeContext(req: RequestWithShop): ExecutionContext {
  const partial = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  };
  return partial as unknown as ExecutionContext;
}

/* Request giả: chỉ gắn các trường guard/test đụng tới (actor, body, query, params) — ép sang RequestWithShop một lần ở đây. */
function makeRequest(fields: Partial<Record<'actor' | 'body' | 'query' | 'params', unknown>> = {}): RequestWithShop {
  return { ...fields } as unknown as RequestWithShop;
}

function makeActor(overrides: Partial<AuthenticatedActor> = {}): AuthenticatedActor {
  return { userId: 'user-a', email: 'a@vn', roleCode: 'customer', permissionVersion: 1, tokenId: 't1', ...overrides };
}

const shopA: ShopFixture = { id: 'shop-a', code: 'SHOP-A', name: 'Gian hàng A', status: SHOP_STATUS.APPROVED };
const shopB: ShopFixture = { id: 'shop-b', code: 'SHOP-B', name: 'Gian hàng B', status: SHOP_STATUS.APPROVED };
const memberOfA: MemberFixture = { id: 'member-a', shopId: 'shop-a', userId: 'user-a', roleId: 'role-owner', status: 'active' };
const memberOfB: MemberFixture = { id: 'member-b', shopId: 'shop-b', userId: 'user-b', roleId: 'role-owner', status: 'active' };

describe('ShopContextGuard — cách ly dữ liệu theo gian hàng', () => {
  it('mỗi vendor CHỈ resolve ra shopId của chính mình — chèn shopId shop khác vào body/query/params không đổi được kết quả', async () => {
    const guard = new ShopContextGuard(fakeReflector(undefined), fakeMembers({ 'user-a': memberOfA, 'user-b': memberOfB }), fakeShops({ 'shop-a': shopA, 'shop-b': shopB }), fakeIdentity(['shop.profile.read']));

    const reqA = makeRequest({ actor: makeActor({ userId: 'user-a', tokenId: 't1' }) });
    await expect(guard.canActivate(fakeContext(reqA))).resolves.toBe(true);
    expect(reqA.shop?.shopId).toBe('shop-a');

    // Vendor A cố tình chèn shopId của shop B vào MỌI vị trí request có thể đọc — guard không đọc các trường này.
    const spoofed = makeRequest({
      actor: makeActor(),
      body: { shopId: 'shop-b' },
      query: { shopId: 'shop-b' },
      params: { shopId: 'shop-b', id: 'shop-b' },
    });
    await expect(guard.canActivate(fakeContext(spoofed))).resolves.toBe(true);
    expect(spoofed.shop?.shopId).toBe('shop-a'); // vẫn shop A, không phải shop B bị chèn vào request

    const reqB = makeRequest({ actor: makeActor({ userId: 'user-b', tokenId: 't2' }) });
    await expect(guard.canActivate(fakeContext(reqB))).resolves.toBe(true);
    expect(reqB.shop?.shopId).toBe('shop-b');
  });

  it('chưa đăng nhập (không có actor) → 401', async () => {
    const guard = new ShopContextGuard(fakeReflector(undefined), fakeMembers({}), fakeShops({}), fakeIdentity([]));
    await expect(guard.canActivate(fakeContext(makeRequest()))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('user không thuộc ShopMember nào → 403, không lộ có gian hàng nào tồn tại', async () => {
    const guard = new ShopContextGuard(fakeReflector(undefined), fakeMembers({}), fakeShops({}), fakeIdentity([]));
    const req = makeRequest({ actor: makeActor({ userId: 'user-x', tokenId: 't3' }) });
    await expect(guard.canActivate(fakeContext(req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('gian hàng bị khoá (suspended) → 403 dù ShopMember vẫn active', async () => {
    const suspended: ShopFixture = { ...shopA, status: SHOP_STATUS.SUSPENDED };
    const guard = new ShopContextGuard(fakeReflector(undefined), fakeMembers({ 'user-a': memberOfA }), fakeShops({ 'shop-a': suspended }), fakeIdentity(['shop.profile.read']));
    const req = makeRequest({ actor: makeActor({ userId: 'user-a', tokenId: 't1' }) });
    await expect(guard.canActivate(fakeContext(req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('thiếu mã quyền shop.* theo vai của ShopMember → 403 kèm mã còn thiếu', async () => {
    // vai chỉ có shop.profile.read (giống preset shop_staff) nhưng route yêu cầu shop.staff.invite (chỉ shop_owner có).
    const guard = new ShopContextGuard(fakeReflector(['shop.staff.invite']), fakeMembers({ 'user-a': memberOfA }), fakeShops({ 'shop-a': shopA }), fakeIdentity(['shop.profile.read']));
    const req = makeRequest({ actor: makeActor({ userId: 'user-a', tokenId: 't1' }) });
    await expect(guard.canActivate(fakeContext(req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('đủ quyền theo yêu cầu route → qua và gắn đúng ShopContext', async () => {
    const guard = new ShopContextGuard(fakeReflector(['shop.profile.read']), fakeMembers({ 'user-a': memberOfA }), fakeShops({ 'shop-a': shopA }), fakeIdentity(['shop.profile.read', 'shop.profile.update']));
    const req = makeRequest({ actor: makeActor({ userId: 'user-a', tokenId: 't1' }) });
    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(true);
    expect(req.shop).toEqual({ shopId: 'shop-a', shopCode: 'SHOP-A', shopName: 'Gian hàng A', shopStatus: 'approved', memberId: 'member-a', roleId: 'role-owner', roleCode: 'shop_owner', roleName: 'Chủ gian hàng', permissionCodes: ['shop.profile.read', 'shop.profile.update'] });
  });
});
