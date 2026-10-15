import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import { RequirePermission } from '@common/security/decorators';
import { ShopRegistrationDetailResponse } from '../dto/shop-registration.responses';
import { ShopRegistrationService } from '../service/shop-registration.service';

/*
 * /admin/shops/:id/registration — nhân viên SÀN xem hồ sơ đăng ký của một gian hàng (kèm người nộp: tên + email, và SĐT) để duyệt/từ chối.
 * Quyền `supplier.shop.read` (PermissionGuard toàn cục), cùng nhóm với màn Gian hàng. Controller riêng để không đụng AdminShopController.
 */
@ApiTags('admin-shop-registrations')
@ApiBearerAuth()
@Controller('admin/shops')
export class AdminShopRegistrationController {
  constructor(private readonly registrations: ShopRegistrationService) {}

  @Get(':id/registration')
  @RequirePermission('supplier.shop.read')
  @ApiOperation({ summary: 'Hồ sơ đăng ký bán hàng của gian hàng (người đại diện, SĐT, ngành hàng, ghi chú, người nộp, lý do từ chối); shop seed/admin tạo không có hồ sơ ⇒ data = null; 404 SHOP_NOT_FOUND khi shop không tồn tại' })
  @ApiOkResponse({ type: ShopRegistrationDetailResponse, description: 'data = null khi shop không có hồ sơ đăng ký' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ShopRegistrationDetailResponse | null>> {
    return ApiResponse.ok(await this.registrations.getForShop(id));
  }
}
