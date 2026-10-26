import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotFoundException } from '@common/exception/business.exception';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import { RequireAnyPermission } from '@common/security/decorators';
import { SHOP_ERR } from '../../foundation/shop.constants';
import { ShopDirectoryItemResponse } from '../dto/shop.responses';
import { ShopListQuery } from '../request/shop.requests';
import { ShopRepository } from '../repository/shop.repository';

/* Mọi màn giám sát theo gian hàng của sàn: ai có quyền XEM một trong các nghiệp vụ đó đều được tra danh bạ shop (không cần quyền quản lý shop). */
const MONITOR_PERMISSIONS = ['supplier.shop.read', 'order.order.read', 'order.return.read', 'payment.payment.read', 'review.review.read', 'product.product.read', 'promotion.promotion.read', 'system.contact.read'] as const;

@ApiTags('admin-shops')
@ApiBearerAuth()
@Controller('admin/shop-directory')
export class ShopDirectoryController {
  constructor(private readonly shops: ShopRepository) {}

  @Get()
  @RequireAnyPermission(...MONITOR_PERMISSIONS)
  @ApiOperation({ summary: 'Danh bạ gian hàng gọn (id, mã, tên, logo, trạng thái, số sản phẩm) để chọn shop ở các màn giám sát' })
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: ShopListQuery): Promise<ApiResponse<PageResponse<ShopDirectoryItemResponse>>> {
    const { items, total } = await this.shops.list({ status: q.status, q: q.q }, (q.page - 1) * q.size, q.size);
    return ApiResponse.ok(PageResponse.of(items.map(toItem), q.page, q.size, total));
  }

  @Get(':id')
  @RequireAnyPermission(...MONITOR_PERMISSIONS)
  @ApiOperation({ summary: 'Một gian hàng trong danh bạ' })
  @ApiOkResponse({ type: ShopDirectoryItemResponse })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ShopDirectoryItemResponse>> {
    const s = await this.shops.findById(id);
    if (!s) throw new NotFoundException(SHOP_ERR.NOT_FOUND, 'Không tìm thấy gian hàng');
    return ApiResponse.ok(toItem(s));
  }
}

function toItem(s: { id: string; code: string; name: string; logoUrl: string | null; status: string; totalProducts: number }): ShopDirectoryItemResponse {
  return { id: s.id, code: s.code, name: s.name, logoUrl: s.logoUrl, status: s.status, totalProducts: s.totalProducts };
}
