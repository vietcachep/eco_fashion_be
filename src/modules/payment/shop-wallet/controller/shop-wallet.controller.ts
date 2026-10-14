import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { PageQuery } from '@common/utils/pagination';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { CurrentShop, RequireShopPermission, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { DepositRequestResponse, ShopWalletResponse, ShopWalletTransactionResponse } from '../dto/shop-wallet.responses';
import { CreateDepositRequestDto, DepositListQuery } from '../request/shop-wallet.requests';
import { ShopWalletService } from '../service/shop-wallet.service';
import { toDepositResponse, toTransactionResponse } from './wallet.mappers';

/* /shop/wallet — vendor xem ví quỹ COD của MÌNH (shopId chỉ từ ngữ cảnh), xin nộp quỹ. */
@ApiTags('shop-wallet')
@ApiBearerAuth()
@Controller('shop/wallet')
@UseGuards(ShopContextGuard)
export class ShopWalletController {
  constructor(
    private readonly wallet: ShopWalletService,
    private readonly shops: ShopQueryApi,
  ) {}

  @Get()
  @RequireShopPermission('shop.wallet.read')
  @ApiOperation({ summary: 'Ví quỹ COD: số dư, COD bật/tắt, yêu cầu nộp quỹ đang chờ' })
  @ApiOkResponse({ type: ShopWalletResponse })
  async summary(@CurrentShop() shop: ShopContext): Promise<ApiResponse<ShopWalletResponse>> {
    const [info, brief] = await Promise.all([this.wallet.getWalletSummary(shop.shopId), this.shops.findBrief(shop.shopId)]);
    return ApiResponse.ok({
      shopId: shop.shopId,
      balance: info.balance.toFixed(0),
      codEnabled: brief?.codEnabled ?? false,
      pendingDeposit: info.pendingDeposit ? { id: info.pendingDeposit.id, amount: info.pendingDeposit.amount.toFixed(0) } : null,
    });
  }

  @Get('transactions')
  @RequireShopPermission('shop.wallet.read')
  @ApiOperation({ summary: 'Sổ cái ví (mới nhất trước)' })
  async transactions(@CurrentShop() shop: ShopContext, @Query() q: PageQuery): Promise<ApiResponse<PageResponse<ShopWalletTransactionResponse>>> {
    const r = await this.wallet.listTransactions(shop.shopId, q.skip, q.size);
    return ApiResponse.ok(PageResponse.of(r.data.map(toTransactionResponse), q.page, q.size, r.total));
  }

  @Get('deposit-requests')
  @RequireShopPermission('shop.wallet.read')
  @ApiOperation({ summary: 'Lịch sử yêu cầu nộp quỹ của shop' })
  async deposits(@CurrentShop() shop: ShopContext, @Query() q: DepositListQuery): Promise<ApiResponse<PageResponse<DepositRequestResponse>>> {
    const r = await this.wallet.listDepositRequests({ status: q.status, shopId: shop.shopId }, q.skip, q.size);
    return ApiResponse.ok(PageResponse.of(r.data.map((d) => toDepositResponse(d, shop.shopName)), q.page, q.size, r.total));
  }

  @Post('deposit-requests')
  @HttpCode(HttpStatus.CREATED)
  @RequireShopPermission('shop.wallet.deposit_request')
  @ApiOperation({ summary: 'Xin nộp thêm quỹ (một yêu cầu chờ duyệt mỗi lúc)' })
  @ApiCreatedResponse({ type: DepositRequestResponse })
  async createDeposit(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Body() body: CreateDepositRequestDto): Promise<ApiResponse<DepositRequestResponse>> {
    const { id } = await this.wallet.createDepositRequest(shop.shopId, body.amount, actor, body.proofUrl, body.note);
    return ApiResponse.ok(
      { id, shopId: shop.shopId, shopName: shop.shopName, amount: String(body.amount), status: 'pending', proofUrl: body.proofUrl ?? null, note: body.note ?? null, createdAt: new Date().toISOString() },
      'Đã gửi yêu cầu nộp quỹ',
    );
  }
}
