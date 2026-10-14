import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { RequestWithActor } from '@common/security/decorators';

export const SHOP_PERMISSIONS_KEY = 'ef:shop-permissions';
export const SHOP_ANY_STATUS_KEY = 'ef:shop-any-status';

/*
 * Cho phép route chạy khi gian hàng CHƯA duyệt / đã bị khoá (mặc định mọi route /shop/** bị 403). Chỉ dùng cho route "khởi động phiên"
 * (GET /shop/session) để FE hiện đúng màn "đang chờ duyệt" / "đã bị khoá" thay vì lỗi trắng — vẫn bắt buộc là thành viên active của shop.
 */
export const AllowAnyShopStatus = () => SetMetadata(SHOP_ANY_STATUS_KEY, true);

/*
 * Yêu cầu mã quyền namespace `shop.*` cho MỘT route /shop/**. KHÔNG dùng chung PERMISSIONS_KEY của
 * PermissionGuard toàn cục: vai scope=shop (shop_owner/shop_staff) không bao giờ gán vào User.roleId nên
 * PermissionGuard toàn cục luôn thấy actor "thiếu quyền" nếu dùng chung khoá. ShopContextGuard đọc khoá
 * RIÊNG này và tự tính quyền từ ShopMember.roleId của actor trong CHÍNH gian hàng đang thao tác (PLAN-0014
 * § RBAC 2 tầng — xem foundation/shop.constants.ts).
 */
export const RequireShopPermission = (...codes: string[]) => SetMetadata(SHOP_PERMISSIONS_KEY, codes);

/* Bối cảnh gian hàng do ShopContextGuard suy ra từ JWT — KHÔNG BAO GIỜ từ param/body của request. */
export interface ShopContext {
  shopId: string;
  shopCode: string;
  shopName: string;
  shopStatus: string;
  memberId: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  /* Mã quyền shop.* của vai trong CHÍNH gian hàng này (guard đã tính) — FE dùng để ẩn/hiện nút. */
  permissionCodes: string[];
}

export interface RequestWithShop extends RequestWithActor {
  shop?: ShopContext;
}

/* Lấy ShopContext đã được ShopContextGuard gắn vào request — chỉ dùng ở route có @UseGuards(ShopContextGuard). */
export const CurrentShop = createParamDecorator((_data: unknown, ctx: ExecutionContext): ShopContext => {
  const req = ctx.switchToHttp().getRequest<RequestWithShop>();
  if (!req.shop) throw new Error('CurrentShop dùng ở route thiếu ShopContextGuard — kiểm tra @UseGuards');
  return req.shop;
});
