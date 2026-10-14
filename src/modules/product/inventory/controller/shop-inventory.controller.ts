import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { CurrentShop, RequireShopPermission, ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { StockMovementResponse, StockReceiptResponse, StockRowResponse } from '../dto/inventory.responses';
import { AdjustStockRequest, CreateReceiptRequest, ReceiptListQuery, StockListQuery } from '../request/inventory.requests';
import { ShopInventoryService } from '../service/shop-inventory.service';

/*
 * /shop/inventory — vendor quản lý kho của riêng gian hàng mình (PLAN-0017 bước 2):
 * - GET /stock: biến thể của shop (có lọc sắp hết)
 * - GET /stock/:variantId/movements: sổ kho (404 nếu variant không shop's)
 * - GET /receipts: phiếu nhập (chỉ shop's)
 * - GET /receipts/:id: chi tiết phiếu (kiểm shop ownership)
 * - POST /receipts: lập phiếu (mọi item phải shop's)
 * - POST /receipts/:id/post: duyệt (Idempotency-Key, kiểm shop ownership)
 * - POST /adjust: điều chỉnh tồn (variant phải shop's)
 */
@ApiTags('shops')
@ApiBearerAuth()
@Controller('shop/inventory')
@UseGuards(ShopContextGuard)
export class ShopInventoryController {
  constructor(private readonly inventory: ShopInventoryService) {}

  @Get('stock')
  @RequireShopPermission('shop.inventory.read')
  @ApiOperation({ summary: 'Bảng tồn biến thể của gian hàng (lọc sắp hết)' })
  @ApiOkResponse({ type: PageResponse })
  async stock(
    @CurrentShop() shop: ShopContext,
    @Query() q: StockListQuery,
  ): Promise<ApiResponse<PageResponse<StockRowResponse>>> {
    return ApiResponse.ok(await this.inventory.listStockShop(shop.shopId, { page: q.page, size: q.size, q: q.q, lowStockOnly: q.lowStockOnly }));
  }

  @Get('stock/:variantId/movements')
  @RequireShopPermission('shop.inventory.read')
  @ApiOperation({ summary: 'Sổ kho của một biến thể (50 dòng gần nhất)' })
  @ApiOkResponse({ type: [StockMovementResponse] })
  async movements(
    @CurrentShop() shop: ShopContext,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<ApiResponse<StockMovementResponse[]>> {
    return ApiResponse.ok(await this.inventory.movementsShop(shop.shopId, variantId));
  }

  @Get('receipts')
  @RequireShopPermission('shop.inventory.read')
  @ApiOkResponse({ type: PageResponse })
  async receipts(
    @CurrentShop() shop: ShopContext,
    @Query() q: ReceiptListQuery,
  ): Promise<ApiResponse<PageResponse<StockReceiptResponse>>> {
    return ApiResponse.ok(await this.inventory.listReceiptsShop(shop.shopId, { page: q.page, size: q.size, status: q.status }));
  }

  @Get('receipts/:id')
  @RequireShopPermission('shop.inventory.read')
  @ApiOkResponse({ type: StockReceiptResponse })
  async receipt(
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiResponse<StockReceiptResponse>> {
    return ApiResponse.ok(await this.inventory.getReceiptShop(shop.shopId, id));
  }

  @Post('receipts')
  @RequireShopPermission('shop.inventory.manage')
  @ApiOperation({ summary: 'Lập phiếu nhập (nháp, chưa cộng tồn)' })
  @ApiOkResponse({ type: StockReceiptResponse })
  async createReceipt(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Body() body: CreateReceiptRequest,
  ): Promise<ApiResponse<StockReceiptResponse>> {
    return ApiResponse.ok(await this.inventory.createReceiptShop(actor, shop.shopId, body), 'Đã lập phiếu nhập');
  }

  @Post('receipts/:id/post')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.inventory.manage')
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Gửi lại cùng key → không cộng tồn 2 lần' })
  @ApiOperation({ summary: 'Duyệt phiếu → cộng tồn kho + ghi sổ' })
  @ApiOkResponse({ type: StockReceiptResponse })
  async postReceipt(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ): Promise<ApiResponse<StockReceiptResponse>> {
    return ApiResponse.ok(await this.inventory.postReceiptShop(actor, shop.shopId, id, key ?? null), 'Đã duyệt phiếu nhập');
  }

  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.inventory.manage')
  @ApiOperation({ summary: 'Điều chỉnh tồn (kiểm kê / hư hỏng) — có lý do, ghi sổ' })
  @ApiOkResponse({ type: StockRowResponse })
  async adjust(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Body() body: AdjustStockRequest,
  ): Promise<ApiResponse<StockRowResponse>> {
    return ApiResponse.ok(await this.inventory.adjustStockShop(actor, shop.shopId, body), 'Đã điều chỉnh tồn kho');
  }
}
