import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { SHOP_STATUS } from '../../foundation/shop.constants';
import { AdminShopResponse, AdminShopSummaryResponse } from '../dto/shop.responses';
import { RejectShopRequest, ShopListQuery, SuspendShopRequest, UpdateCommissionRequest } from '../request/shop.requests';
import { ShopService } from '../service/shop.service';

/*
 * /admin/shops — nhân viên SÀN (admin/manager hiện có) duyệt/khoá/từ chối/sửa hoa hồng CỦA MỌI gian hàng.
 * Gác bằng mã quyền `supplier.shop.*` qua PermissionGuard toàn cục (KHÔNG phải ShopContextGuard — nhân viên
 * sàn không phải thành viên của bất kỳ gian hàng nào, họ thao tác XUYÊN mọi shop bằng vai nền tảng của họ).
 */
@ApiTags('admin-shops')
@ApiBearerAuth()
@Controller('admin/shops')
export class AdminShopController {
  constructor(private readonly shops: ShopService) {}

  @Get()
  @RequirePermission('supplier.shop.read')
  @ApiOperation({ summary: 'Danh sách gian hàng (lọc trạng thái, tìm mã/tên/slug) — kèm tên/email chủ shop' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: ShopListQuery): Promise<ApiResponse<PageResponse<AdminShopSummaryResponse>>> {
    return ApiResponse.ok(await this.shops.listAdmin({ status: q.status, q: q.q }, q.page, q.size));
  }

  @Get(':id')
  @RequirePermission('supplier.shop.read')
  @ApiOperation({ summary: 'Chi tiết một gian hàng (admin xem full số tài khoản + tên/email chủ shop)' })
  @ApiOkResponse({ type: AdminShopResponse })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<AdminShopResponse>> {
    return ApiResponse.ok(await this.shops.getAdminDetail(id));
  }

  @Patch(':id/approve')
  @RequirePermission('supplier.shop.approve')
  @ApiOperation({ summary: 'Duyệt gian hàng đang chờ (pending → approved) hoặc mở khoá lại (suspended → approved)' })
  @ApiOkResponse({ type: AdminShopSummaryResponse })
  async approve(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<AdminShopSummaryResponse>> {
    return ApiResponse.ok(await this.shops.changeStatus(actor, id, SHOP_STATUS.APPROVED, null), 'Đã duyệt gian hàng');
  }

  @Patch(':id/suspend')
  @RequirePermission('supplier.shop.suspend')
  @ApiOperation({ summary: 'Khoá gian hàng vi phạm (approved → suspended)' })
  @ApiOkResponse({ type: AdminShopSummaryResponse })
  async suspend(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: SuspendShopRequest): Promise<ApiResponse<AdminShopSummaryResponse>> {
    return ApiResponse.ok(await this.shops.changeStatus(actor, id, SHOP_STATUS.SUSPENDED, body.reason), 'Đã khoá gian hàng');
  }

  @Patch(':id/reject')
  @RequirePermission('supplier.shop.reject')
  @ApiOperation({ summary: 'Từ chối gian hàng đăng ký (pending → rejected)' })
  @ApiOkResponse({ type: AdminShopSummaryResponse })
  async reject(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: RejectShopRequest): Promise<ApiResponse<AdminShopSummaryResponse>> {
    return ApiResponse.ok(await this.shops.changeStatus(actor, id, SHOP_STATUS.REJECTED, body.reason), 'Đã từ chối gian hàng');
  }

  @Patch(':id/commission')
  @RequirePermission('supplier.shop.commission')
  @ApiOperation({ summary: 'Sửa % hoa hồng của một gian hàng (không hồi tố đơn cũ)' })
  @ApiOkResponse({ type: AdminShopSummaryResponse })
  async updateCommission(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCommissionRequest): Promise<ApiResponse<AdminShopSummaryResponse>> {
    return ApiResponse.ok(await this.shops.updateCommission(actor, id, body.commissionRate), 'Đã cập nhật % hoa hồng');
  }
}
