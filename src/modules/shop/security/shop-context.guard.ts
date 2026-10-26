import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, UnauthorizedException } from '@common/exception/business.exception';
import { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import { effectiveShopPermissions, SHOP_ERR, SHOP_STATUS } from '../foundation/shop.constants';
import { ShopMemberRepository } from '../member/repository/shop-member.repository';
import { ShopRepository } from '../shop/repository/shop.repository';
import { RequestWithShop, SHOP_ANY_STATUS_KEY, SHOP_PERMISSIONS_KEY } from './shop-permission.decorator';

/*
 * Guard dùng chung cho MỌI route `/shop/**` (PLAN-0014 bước 4). Ba việc, THEO ĐÚNG THỨ TỰ:
 *  1. Đọc actor từ JWT (JwtAuthGuard toàn cục đã gắn `req.actor` trước đó) → tra ShopMember ACTIVE của
 *     actor.userId → suy `shopId` DUY NHẤT từ đó. shopId KHÔNG BAO GIỜ đọc từ param/query/body — nên về
 *     mặt cấu trúc, một request không thể "xin" dữ liệu của shop khác dù có sửa URL/body thế nào: giá trị
 *     duy nhất guard tin là chính actor.userId trong token đã ký, không phải bất kỳ input nào của request.
 *  2. Đọc THẲNG `Shop.status` từ DB (không tin cache/JWT cũ) — sàn khoá gian hàng là mọi route /shop/**
 *     của họ 403 NGAY cả khi ShopMember vẫn active (bài học "nguồn sự thật" từ PLAN-0014 mục 2).
 *  3. Nếu route có `@RequireShopPermission(...)`, kiểm mã quyền đó nằm trong quyền của CHÍNH
 *     ShopMember.roleId (đọc qua identity.queryapi — vai scope=shop không có trong effective permissions
 *     toàn cục của user vì không gán vào User.roleId, nên không dùng PermissionGuard/RequirePermission ở đây).
 * Gắn kết quả vào `req.shop` (ShopContext) cho @CurrentShop() / service dùng tiếp.
 */
@Injectable()
export class ShopContextGuard implements CanActivate {
  private readonly logger = new Logger(ShopContextGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly members: ShopMemberRepository,
    private readonly shops: ShopRepository,
    private readonly identity: IdentityQueryApi,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithShop>();
    const actor = req.actor;
    if (!actor) throw new UnauthorizedException('COMMON_UNAUTHORIZED', 'Bạn cần đăng nhập');

    const member = await this.members.findActiveByUserId(actor.userId);
    if (!member) throw new ForbiddenException(SHOP_ERR.NOT_MEMBER, 'Bạn không thuộc gian hàng nào');

    const shop = await this.shops.findById(member.shopId);
    if (!shop) throw new ForbiddenException(SHOP_ERR.NOT_MEMBER, 'Bạn không thuộc gian hàng nào');
    const anyStatus = this.reflector.getAllAndOverride<boolean | undefined>(SHOP_ANY_STATUS_KEY, [ctx.getHandler(), ctx.getClass()]) === true;
    if (shop.status !== SHOP_STATUS.APPROVED && !anyStatus) {
      throw new ForbiddenException(SHOP_ERR.NOT_APPROVED, 'Gian hàng của bạn chưa được duyệt hoặc đã bị khoá');
    }

    const role = await this.identity.shopRoleContext(member.roleId);
    if (!role) {
      this.logger.error({ userId: actor.userId, roleId: member.roleId }, 'ShopMember trỏ tới vai không tồn tại');
      throw new ForbiddenException(SHOP_ERR.ROLE_INVALID, 'Vai của bạn trong gian hàng không hợp lệ');
    }

    const permissionCodes = effectiveShopPermissions(role.code, role.permissionCodes, member.customPermissions);
    const required = this.reflector.getAllAndOverride<string[]>(SHOP_PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (required && required.length > 0) {
      const owned = new Set(permissionCodes);
      const missing = required.filter((c) => !owned.has(c));
      if (missing.length > 0) {
        this.logger.warn({ userId: actor.userId, shopId: shop.id, missing }, 'Thiếu quyền shop');
        throw new ForbiddenException(SHOP_ERR.FORBIDDEN, `Bạn thiếu quyền: ${missing.join(', ')}`, { required: missing.join(',') });
      }
    }

    req.shop = { shopId: shop.id, shopCode: shop.code, shopName: shop.name, shopStatus: shop.status, memberId: member.id, roleId: member.roleId, roleCode: role.code, roleName: role.name, permissionCodes };
    return true;
  }
}
