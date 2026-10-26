import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@common/prisma/types';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { PageQuery } from '@common/utils/pagination';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { CurrentShop, RequireShopPermission, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { AdjustWalletRequest, DepositListQuery, DepositRequest, RejectDepositRequest, WalletDepositResponse, WalletListQuery, WalletResponse, WalletSummaryResponse, WalletTransactionResponse } from '../dto/shop-wallet.dto';
import { ShopWalletService } from '../shop-wallet.service';

type DepositRow = Prisma.ShopCodDepositGetPayload<object>;
type TxRow = Prisma.ShopCodWalletTransactionGetPayload<object>;
type WalletView = Awaited<ReturnType<ShopWalletService['getWallet']>>;

const toDeposit = (d: DepositRow, shopName?: string): WalletDepositResponse => ({
  id: d.id,
  shopId: d.shopId,
  shopName,
  amount: d.amount.toFixed(0),
  transferRef: d.transferRef,
  note: d.note,
  status: d.status,
  rejectReason: d.rejectReason,
  reviewedAt: d.reviewedAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
});

const toTx = (t: TxRow): WalletTransactionResponse => ({
  id: t.id,
  type: t.type,
  amount: t.amount.toFixed(0),
  balanceAfter: t.balanceAfter.toFixed(0),
  orderCode: t.orderCode,
  note: t.note,
  createdAt: t.createdAt.toISOString(),
});

const toWallet = (w: WalletView, shopName?: string): WalletResponse => ({
  shopId: w.shopId,
  shopName,
  balance: w.balance.toFixed(0),
  codEnabled: w.codEnabled,
  exempt: w.exempt,
  pendingDeposit: w.pendingDeposit ? toDeposit(w.pendingDeposit, shopName) : null,
  minDeposit: w.minDeposit,
  instructions: w.instructions,
});

/*
 * Ví đặt cọc COD (PLAN-0020): vendor (`shop.wallet.*`) xem ví của CHÍNH shop mình và gửi yêu cầu nộp cọc — shopId CHỈ từ ngữ cảnh;
 * sàn (`supplier.wallet.*`): kế toán xem + duyệt / từ chối khoản nộp (`approve`), CHỈ Admin chỉnh ví tay (`adjust`). Route tĩnh khai báo TRƯỚC `:id`.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@Controller()
export class ShopWalletController {
  constructor(private readonly service: ShopWalletService) {}

  // ---------- Sàn ----------

  @Get('admin/wallets')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Danh sách ví đặt cọc COD của các gian hàng (lowOnly = chỉ ví ≤ 0, COD đang đóng)' })
  async listWallets(@Query() q: WalletListQuery): Promise<ApiResponse<PageResponse<WalletSummaryResponse>>> {
    const r = await this.service.listWallets({ lowOnly: q.lowOnly }, q.skip, q.size);
    const names = await this.service.shopNames(r.items.map((w) => w.shopId));
    const codOk = await this.service.codAvailability(r.items.map((w) => w.shopId));
    return ApiResponse.ok(
      PageResponse.of(
        r.items.map((w) => ({ shopId: w.shopId, shopName: names.get(w.shopId), balance: w.balance.toFixed(0), codEnabled: codOk.get(w.shopId) ?? false, updatedAt: w.updatedAt.toISOString() })),
        q.page,
        q.size,
        r.total,
      ),
    );
  }

  @Get('admin/wallet-deposits')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Các yêu cầu nộp cọc (lọc status / shop)' })
  async listDeposits(@Query() q: DepositListQuery): Promise<ApiResponse<PageResponse<WalletDepositResponse>>> {
    const r = await this.service.listDeposits({ status: q.status, shopId: q.shopId }, q.skip, q.size);
    const names = await this.service.shopNames(r.items.map((d) => d.shopId));
    return ApiResponse.ok(PageResponse.of(r.items.map((d) => toDeposit(d, names.get(d.shopId))), q.page, q.size, r.total));
  }

  @Post('admin/wallet-deposits/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.wallet.approve')
  @ApiOperation({ summary: 'Duyệt khoản nộp cọc — cộng vào ví (bù số âm trước); ví > 0 thì shop bán được COD' })
  @ApiOkResponse({ type: WalletDepositResponse })
  async approve(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<WalletDepositResponse>> {
    const d = await this.service.approveDeposit(actor, id);
    return ApiResponse.ok(toDeposit(d, (await this.service.shopNames([d.shopId])).get(d.shopId)), 'Đã duyệt khoản nộp cọc');
  }

  @Post('admin/wallet-deposits/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.wallet.approve')
  @ApiOperation({ summary: 'Từ chối khoản nộp cọc (kèm lý do)' })
  @ApiOkResponse({ type: WalletDepositResponse })
  async reject(@Param('id', ParseUUIDPipe) id: string, @Body() req: RejectDepositRequest, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<WalletDepositResponse>> {
    const d = await this.service.rejectDeposit(actor, id, req.reason);
    return ApiResponse.ok(toDeposit(d, (await this.service.shopNames([d.shopId])).get(d.shopId)), 'Đã từ chối khoản nộp cọc');
  }

  @Get('admin/shops/:shopId/wallet')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Ví đặt cọc COD của một gian hàng' })
  @ApiOkResponse({ type: WalletResponse })
  async walletOf(@Param('shopId', ParseUUIDPipe) shopId: string): Promise<ApiResponse<WalletResponse>> {
    return ApiResponse.ok(toWallet(await this.service.getWallet(shopId), (await this.service.shopNames([shopId])).get(shopId)));
  }

  @Get('admin/shops/:shopId/wallet/transactions')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Sổ cái ví của một gian hàng' })
  async transactionsOf(@Param('shopId', ParseUUIDPipe) shopId: string, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<WalletTransactionResponse>>> {
    const r = await this.service.listTransactions(shopId, q.skip, q.size);
    return ApiResponse.ok(PageResponse.of(r.items.map(toTx), q.page, q.size, r.total));
  }

  @Post('admin/shops/:shopId/wallet/adjust')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.wallet.adjust')
  @ApiOperation({ summary: 'Chỉnh ví tay (cộng / trừ, bắt buộc lý do)' })
  @ApiOkResponse({ type: WalletResponse })
  async adjust(@Param('shopId', ParseUUIDPipe) shopId: string, @Body() req: AdjustWalletRequest, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<WalletResponse>> {
    await this.service.adjust(actor, shopId, BigInt(req.amount), req.note);
    return ApiResponse.ok(toWallet(await this.service.getWallet(shopId), (await this.service.shopNames([shopId])).get(shopId)), 'Đã chỉnh ví');
  }

  // ---------- Vendor (shopId CHỈ lấy từ ngữ cảnh) ----------

  @Get('shop/wallet')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.wallet.read')
  @ApiOperation({ summary: 'Ví đặt cọc COD của shop: số dư, COD đang mở/đóng, yêu cầu nộp đang chờ' })
  @ApiOkResponse({ type: WalletResponse })
  async mine(@CurrentShop() shop: ShopContext): Promise<ApiResponse<WalletResponse>> {
    return ApiResponse.ok(toWallet(await this.service.getWallet(shop.shopId), shop.shopName));
  }

  @Get('shop/wallet/transactions')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.wallet.read')
  @ApiOperation({ summary: 'Sổ cái ví của shop (nộp cọc, hoa hồng đơn COD, hoàn tiền, chỉnh tay)' })
  async myTransactions(@Query() q: PageQuery, @CurrentShop() shop: ShopContext): Promise<ApiResponse<PageResponse<WalletTransactionResponse>>> {
    const r = await this.service.listTransactions(shop.shopId, q.skip, q.size);
    return ApiResponse.ok(PageResponse.of(r.items.map(toTx), q.page, q.size, r.total));
  }

  @Get('shop/wallet/deposit-requests')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.wallet.read')
  @ApiOperation({ summary: 'Các yêu cầu nộp cọc của shop' })
  async myDeposits(@Query() q: PageQuery, @CurrentShop() shop: ShopContext): Promise<ApiResponse<PageResponse<WalletDepositResponse>>> {
    const r = await this.service.listDeposits({ shopId: shop.shopId }, q.skip, q.size);
    return ApiResponse.ok(PageResponse.of(r.items.map((d) => toDeposit(d, shop.shopName)), q.page, q.size, r.total));
  }

  @Post('shop/wallet/deposit-requests')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.wallet.deposit_request')
  @ApiOperation({ summary: 'Gửi yêu cầu nộp cọc: shop đã chuyển khoản cho sàn, khai số tiền + mã giao dịch để kế toán đối chiếu' })
  @ApiOkResponse({ type: WalletDepositResponse })
  async requestDeposit(@Body() req: DepositRequest, @CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext): Promise<ApiResponse<WalletDepositResponse>> {
    const d = await this.service.requestDeposit(actor, shop.shopId, { amount: BigInt(req.amount), transferRef: req.transferRef, note: req.note });
    return ApiResponse.ok(toDeposit(d, shop.shopName), 'Đã gửi yêu cầu nộp cọc — chờ sàn đối chiếu và duyệt');
  }
}
