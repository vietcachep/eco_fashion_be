import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { AllowAnyShopStatus, CurrentShop, RequireShopPermission, ShopContext } from '../../security/shop-permission.decorator';
import { ShopContextGuard } from '../../security/shop-context.guard';
import { AddShopMemberResponse, ShopMemberResponse } from '../dto/shop-member.responses';
import { AddShopMemberRequest, ShopMemberListQuery, UpdateShopMemberPermissionsRequest, UpdateShopMemberRequest } from '../request/shop-member.requests';
import { ShopMemberService } from '../service/shop-member.service';

/*
 * /shop/members — chủ gian hàng quản lý nhân viên CỦA CHÍNH mình. `shopId` do ShopContextGuard suy từ JWT;
 * `:id` param là id của ShopMember, chỉ có nghĩa TRONG shopId đó (service lọc lại theo shopId — id thuộc
 * shop khác trả 404, không lộ có/không tồn tại). Response không bao giờ có userId của thành viên.
 * Ghi có @RateLimit theo user. Thêm nhân viên = chủ shop tạo tài khoản mới cho họ (không mời, không chờ chấp nhận); đổi vai/gỡ/rời.
 */
@ApiTags('shops')
@ApiBearerAuth()
@Controller('shop/members')
@UseGuards(ShopContextGuard)
export class ShopMemberController {
  constructor(private readonly members: ShopMemberService) {}

  @Get()
  @RequireShopPermission('shop.staff.read')
  @ApiOperation({ summary: 'Danh sách nhân viên gian hàng của tôi' })
  @ApiOkResponse({ type: PageResponse })
  async list(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Query() q: ShopMemberListQuery): Promise<ApiResponse<PageResponse<ShopMemberResponse>>> {
    return ApiResponse.ok(await this.members.list(actor, shop.shopId, q.page, q.size));
  }

  /* Mã quyền `shop.staff.invite` là tên CŨ (thời còn mời nhân viên) — giữ nguyên để không phải đổi catalog/preset/vai đã gán; mô tả hiển thị đã là "Thêm nhân viên". */
  @Post()
  @RateLimit({ name: 'shop-member-add', limit: 30, windowSeconds: 3600, by: 'user' })
  @RequireShopPermission('shop.staff.invite')
  @ApiOperation({
    summary:
      'Thêm nhân viên: chủ shop TẠO TÀI KHOẢN {email, fullName, password, roleCode} cho nhân viên (có hiệu lực ngay, không mời/không chờ chấp nhận). Email của nhân viên TỪNG làm ở shop này (đã gỡ) ⇒ khôi phục tài khoản cũ, mật khẩu KHÔNG đổi (`restored: true`). 409 IDENTITY_EMAIL_EXISTS khi email đã có tài khoản khác; 409 SHOP_MEMBER_UNAVAILABLE khi không khôi phục được; 409 SHOP_MEMBER_LIMIT_REACHED khi shop đã đủ 50 thành viên; 400 IDENTITY_PASSWORD_WEAK khi mật khẩu không đạt luật.',
  })
  @ApiOkResponse({ type: AddShopMemberResponse })
  async add(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Body() body: AddShopMemberRequest): Promise<ApiResponse<AddShopMemberResponse>> {
    return ApiResponse.ok(await this.members.add(actor, shop.shopId, body), 'Đã thêm nhân viên');
  }

  /* Khai báo TRƯỚC các route có `:id` để 'leave' không bao giờ bị hiểu là id. Chỉ cần là thành viên active — không đòi quyền shop.staff.*. */
  @Post('leave')
  @HttpCode(HttpStatus.OK)
  @AllowAnyShopStatus()
  @ApiOperation({ summary: 'Tôi tự rời gian hàng hiện tại (chủ cuối cùng không rời được — 409 SHOP_LAST_OWNER); dùng được cả khi gian hàng chưa duyệt/đã khoá' })
  @ApiOkResponse({ description: 'data = null' })
  async leave(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext): Promise<ApiResponse<null>> {
    await this.members.leave(actor, shop.shopId, shop.memberId);
    return ApiResponse.ok(null, 'Bạn đã rời gian hàng');
  }

  @Patch(':id')
  @RateLimit({ name: 'shop-member-update', limit: 60, windowSeconds: 3600, by: 'user' })
  @RequireShopPermission('shop.staff.update')
  @ApiOperation({ summary: 'Đổi vai một nhân viên (không hạ được người chủ cuối cùng)' })
  @ApiOkResponse({ type: ShopMemberResponse })
  async update(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateShopMemberRequest): Promise<ApiResponse<ShopMemberResponse>> {
    return ApiResponse.ok(await this.members.updateRole(actor, shop.shopId, id, body.roleCode), 'Đã đổi vai nhân viên');
  }

  @Put(':id/permissions')
  @RateLimit({ name: 'shop-member-permissions', limit: 60, windowSeconds: 3600, by: 'user' })
  @RequireShopPermission('shop.staff.update')
  @ApiOperation({ summary: 'Chủ shop tự đặt quyền cho một nhân viên (permissionCodes null = theo preset của vai); không đặt được cho chủ; sàn không can thiệp' })
  @ApiOkResponse({ type: ShopMemberResponse })
  async setPermissions(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateShopMemberPermissionsRequest): Promise<ApiResponse<ShopMemberResponse>> {
    return ApiResponse.ok(await this.members.updatePermissions(actor, shop.shopId, id, body.permissionCodes ?? null), 'Đã cập nhật quyền nhân viên');
  }

  @Delete(':id')
  @RateLimit({ name: 'shop-member-remove', limit: 60, windowSeconds: 3600, by: 'user' })
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.staff.remove')
  @ApiOperation({ summary: 'Gỡ một nhân viên khỏi gian hàng (không gỡ được người chủ cuối cùng)' })
  @ApiOkResponse({ description: 'data = null' })
  async remove(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.members.remove(actor, shop.shopId, id);
    return ApiResponse.ok(null, 'Đã gỡ nhân viên khỏi gian hàng');
  }
}
