import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { PageQuery } from '@common/utils/pagination';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { AdminWalletRowResponse, DepositRequestResponse, ShopWalletResponse, ShopWalletTransactionResponse } from '../dto/shop-wallet.responses';
import { AdjustWalletDto, ApproveDepositDto, DepositListQuery, RejectDepositDto, WalletListQuery } from '../request/shop-wallet.requests';
import { ShopWalletService } from '../service/shop-wallet.service';
import { toDepositResponse, toTransactionResponse } from './wallet.mappers';

/*
 * Sàn quản lý ví quỹ COD của shop: xem, điều chỉnh, duyệt/từ chối nộp quỹ.
 * Route `wallets` / `wallet-deposits` đặt dưới `admin/` (KHÔNG dưới `admin/shops/`) để `admin/shops/:id` của module shop không nuốt.
 */
@ApiTags('admin-wallet')
@ApiBearerAuth()
@Controller('admin')
export class AdminWalletController {
  constructor(
    private readonly wallet: ShopWalletService,
    private readonly shops: ShopQueryApi,
  ) {}

  @Get('wallets')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Danh sách ví quỹ COD các shop (lowOnly = ví ≤ 0, COD đang khoá)' })
  async list(@Query() q: WalletListQuery): Promise<ApiResponse<PageResponse<AdminWalletRowResponse>>> {
    const r = await this.wallet.listWallets(q.lowOnly ?? false, q.skip, q.size);
    const briefs = await this.shops.findManyBrief(r.data.map((w) => w.shopId));
    const rows = r.data.map((w) => ({ shopId: w.shopId, shopName: briefs.get(w.shopId)?.name ?? null, balance: w.balance.toFixed(0), codEnabled: briefs.get(w.shopId)?.codEnabled ?? false, updatedAt: w.updatedAt.toISOString() }));
    return ApiResponse.ok(PageResponse.of(rows, q.page, q.size, r.total));
  }

  @Get('shops/:id/wallet')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Ví quỹ COD của một gian hàng' })
  @ApiOkResponse({ type: ShopWalletResponse })
  async shopWallet(@Param('id', ParseUUIDPipe) shopId: string): Promise<ApiResponse<ShopWalletResponse>> {
    const [info, brief] = await Promise.all([this.wallet.getWalletSummary(shopId), this.shops.findBrief(shopId)]);
    return ApiResponse.ok({
      shopId,
      balance: info.balance.toFixed(0),
      codEnabled: brief?.codEnabled ?? false,
      pendingDeposit: info.pendingDeposit ? { id: info.pendingDeposit.id, amount: info.pendingDeposit.amount.toFixed(0) } : null,
    });
  }

  @Get('shops/:id/wallet/transactions')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Sổ cái ví của một gian hàng' })
  async shopTransactions(@Param('id', ParseUUIDPipe) shopId: string, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<ShopWalletTransactionResponse>>> {
    const r = await this.wallet.listTransactions(shopId, q.skip, q.size);
    return ApiResponse.ok(PageResponse.of(r.data.map(toTransactionResponse), q.page, q.size, r.total));
  }

  @Post('shops/:id/wallet/adjust')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.wallet.adjust')
  @ApiOperation({ summary: 'Điều chỉnh ví (dương = cộng, âm = trừ) — bắt buộc ghi chú' })
  async adjust(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) shopId: string, @Body() body: AdjustWalletDto): Promise<ApiResponse<{ success: boolean }>> {
    await this.wallet.adjust(shopId, body.amount, body.note, actor);
    return ApiResponse.ok({ success: true }, 'Đã điều chỉnh ví');
  }

  @Get('wallet-deposits')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Yêu cầu nộp quỹ (lọc theo trạng thái)' })
  async deposits(@Query() q: DepositListQuery): Promise<ApiResponse<PageResponse<DepositRequestResponse>>> {
    const r = await this.wallet.listDepositRequests({ status: q.status }, q.skip, q.size);
    const briefs = await this.shops.findManyBrief([...new Set(r.data.map((d) => d.shopId))]);
    return ApiResponse.ok(PageResponse.of(r.data.map((d) => toDepositResponse(d, briefs.get(d.shopId)?.name ?? null)), q.page, q.size, r.total));
  }

  @Post('wallet-deposits/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.wallet.adjust')
  @ApiOperation({ summary: 'Duyệt nộp quỹ: cộng ví, mở lại COD khi ví > 0' })
  async approve(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveDepositDto): Promise<ApiResponse<{ success: boolean }>> {
    await this.wallet.approveDeposit(id, actor, body.note);
    return ApiResponse.ok({ success: true }, 'Đã duyệt yêu cầu nộp quỹ');
  }

  @Post('wallet-deposits/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.wallet.adjust')
  @ApiOperation({ summary: 'Từ chối nộp quỹ (bắt buộc lý do)' })
  async reject(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: RejectDepositDto): Promise<ApiResponse<{ success: boolean }>> {
    await this.wallet.rejectDeposit(id, actor, body.note);
    return ApiResponse.ok({ success: true }, 'Đã từ chối yêu cầu nộp quỹ');
  }
}
