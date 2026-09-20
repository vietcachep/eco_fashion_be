import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { StockMovementResponse, StockReceiptResponse, StockRowResponse } from '../dto/inventory.responses';
import { AdjustStockRequest, CreateReceiptRequest, ReceiptListQuery, StockListQuery } from '../request/inventory.requests';
import { InventoryService } from '../service/inventory.service';

/* /admin/inventory — bảng tồn, sổ kho, phiếu nhập (lập → duyệt có Idempotency-Key), điều chỉnh kiểm kê. */
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

  @Post('receipts')
  @RequirePermission('product.inventory.receive')
  @ApiOperation({ summary: 'Lập phiếu nhập (nháp, chưa cộng tồn)' })
  @ApiOkResponse({ type: StockReceiptResponse })
  async createReceipt(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreateReceiptRequest): Promise<ApiResponse<StockReceiptResponse>> {
    return ApiResponse.ok(await this.inventory.createReceipt(actor, body), 'Đã lập phiếu nhập');
  }

  @Post('receipts/:id/post')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product.inventory.receive')
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Gửi lại cùng key → không cộng tồn 2 lần' })
  @ApiOperation({ summary: 'Duyệt phiếu → cộng tồn kho + ghi sổ' })
  @ApiOkResponse({ type: StockReceiptResponse })
  async postReceipt(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key?: string): Promise<ApiResponse<StockReceiptResponse>> {
    return ApiResponse.ok(await this.inventory.postReceipt(actor, id, key ?? null), 'Đã duyệt phiếu nhập');
  }

  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product.inventory.adjust')
  @ApiOperation({ summary: 'Điều chỉnh tồn (kiểm kê / hư hỏng) — có lý do, ghi sổ' })
  @ApiOkResponse({ type: StockRowResponse })
  async adjust(@CurrentActor() actor: AuthenticatedActor, @Body() body: AdjustStockRequest): Promise<ApiResponse<StockRowResponse>> {
    return ApiResponse.ok(await this.inventory.adjust(actor, body), 'Đã điều chỉnh tồn kho');
  }
}
