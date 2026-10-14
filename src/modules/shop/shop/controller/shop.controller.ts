import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { AllowAnyShopStatus, CurrentShop, RequireShopPermission, ShopContext } from '../../security/shop-permission.decorator';
import { ShopContextGuard } from '../../security/shop-context.guard';
import { ShopResponse, ShopSessionResponse } from '../dto/shop.responses';
import { UpdateShopProfileRequest } from '../request/shop.requests';
import { ShopService } from '../service/shop.service';

/*
 * /shop/me — vendor tự quản hồ sơ CHÍNH gian hàng mình. `shopId` KHÔNG nằm trên URL: ShopContextGuard suy
 * từ ShopMember active của actor (JWT) rồi gắn vào @CurrentShop() — không có cách nào truyền shopId khác
 * qua request để đọc/sửa gian hàng khác (PLAN-0014, xem shop-context.guard.ts).
 */
@ApiTags('shops')
@ApiBearerAuth()
@Controller('shop')
@UseGuards(ShopContextGuard)
export class ShopController {
  constructor(private readonly shops: ShopService) {}

  /* Khởi động phiên vendor: KHÔNG đòi quyền nào ngoài "là thành viên active"; chạy cả khi shop chưa duyệt/bị khoá để FE hiện đúng trạng thái. */
  @Get('session')
  @AllowAnyShopStatus()
  @ApiOperation({ summary: 'Phiên vendor: gian hàng + vai + mã quyền shop.* của tôi' })
  @ApiOkResponse({ type: ShopSessionResponse })
  async session(@CurrentShop() shop: ShopContext): Promise<ApiResponse<ShopSessionResponse>> {
    return ApiResponse.ok({ shop: await this.shops.getMe(shop.shopId), roleCode: shop.roleCode, roleName: shop.roleName, permissions: shop.permissionCodes });
  }

  @Get('me')
  @RequireShopPermission('shop.profile.read')
  @ApiOperation({ summary: 'Hồ sơ gian hàng của tôi' })
  @ApiOkResponse({ type: ShopResponse })
  async me(@CurrentShop() shop: ShopContext): Promise<ApiResponse<ShopResponse>> {
    return ApiResponse.ok(await this.shops.getMe(shop.shopId));
  }

  @Patch('me')
  @RequireShopPermission('shop.profile.update')
  @ApiOperation({ summary: 'Sửa hồ sơ gian hàng của tôi (không đổi được mã/slug/trạng thái/hoa hồng — sàn quản)' })
  @ApiOkResponse({ type: ShopResponse })
  async updateMe(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Body() body: UpdateShopProfileRequest): Promise<ApiResponse<ShopResponse>> {
    return ApiResponse.ok(await this.shops.updateMe(actor, shop.shopId, body), 'Đã cập nhật hồ sơ gian hàng');
  }
}
