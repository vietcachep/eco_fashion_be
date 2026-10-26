import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import { RequirePermission } from '@common/security/decorators';
import { StockMovementResponse, StockReceiptResponse, StockRowResponse } from '../dto/inventory.responses';
import { ReceiptListQuery, StockListQuery } from '../request/inventory.requests';
import { InventoryService } from '../service/inventory.service';

/* /admin/inventory — SÀN chỉ XEM bảng tồn, sổ kho, phiếu nhập; nhập kho / điều chỉnh là việc của chủ shop (/shop/inventory) — PLAN-0021. */
@ApiTags('admin-inventory')
@ApiBearerAuth()
@Controller('admin/inventory')
export class AdminInventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('stock')
  @RequirePermission('product.inventory.read')
  @ApiOperation({ summary: 'Bảng tồn theo biến thể (lọc sắp hết hàng)' })
  @ApiOkResponse({ type: PageResponse })
  async stock(@Query() q: StockListQuery): Promise<ApiResponse<PageResponse<StockRowResponse>>> {
    return ApiResponse.ok(await this.inventory.listStock({ page: q.page, size: q.size, q: q.q, lowStockOnly: q.lowStockOnly }));
  }

  @Get('stock/:variantId/movements')
  @RequirePermission('product.inventory.read')
  @ApiOperation({ summary: 'Sổ kho của một biến thể (50 dòng gần nhất)' })
  @ApiOkResponse({ type: [StockMovementResponse] })
  async movements(@Param('variantId', ParseUUIDPipe) variantId: string): Promise<ApiResponse<StockMovementResponse[]>> {
    return ApiResponse.ok(await this.inventory.movements(variantId));
  }

  @Get('receipts')
  @RequirePermission('product.inventory.read')
  @ApiOkResponse({ type: PageResponse })
  async receipts(@Query() q: ReceiptListQuery): Promise<ApiResponse<PageResponse<StockReceiptResponse>>> {
    return ApiResponse.ok(await this.inventory.listReceipts({ page: q.page, size: q.size, status: q.status }));
  }

  @Get('receipts/:id')
  @RequirePermission('product.inventory.read')
  @ApiOkResponse({ type: StockReceiptResponse })
  async receipt(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<StockReceiptResponse>> {
    return ApiResponse.ok(await this.inventory.getReceipt(id));
  }
}
