import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { CurrentShop, RequireShopPermission, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { CreateTopupRequest, CreateTopupResponse, TopupListQuery, WalletTopupDetailResponse, WalletTopupResponse } from '../dto/shop-wallet-topup.dto';
import { ShopWalletTopupService } from '../shop-wallet-topup.service';
import { toTopupDetail, toTopupResponse } from './topup.mapper';

/*
 * Nạp cọc COD qua PayOS (PLAN-0041 §5.1–5.2). Vendor (`shop.wallet.*`): tạo / xem / huỷ link của CHÍNH shop — shopId CHỈ từ ngữ cảnh `@CurrentShop()`,
 * không bao giờ từ URL/body. Sàn (`supplier.wallet.read`): chỉ xem khoản nạp + biên nhận để đối chiếu PayOS, KHÔNG có route duyệt/huỷ.
 * Route tĩnh `by-order-code` khai báo TRƯỚC `:id` để không bị bắt nhầm thành id.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@Controller()
export class ShopWalletTopupController {
  constructor(private readonly topups: ShopWalletTopupService) {}

  // ---------- Vendor (shopId CHỈ lấy từ ngữ cảnh) ----------

  @Post('shop/wallet/topups')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.wallet.deposit_request')
  @RateLimit({ name: 'wallet-topup-create', limit: 10, windowSeconds: 600, by: 'user' })
  @ApiOperation({ summary: 'Tạo link nạp cọc qua PayOS. Đang có khoản mở còn hạn ⇒ trả lại link cũ (reused: true)' })
  @ApiCreatedResponse({ type: CreateTopupResponse })
  async create(@Body() req: CreateTopupRequest, @CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext): Promise<ApiResponse<CreateTopupResponse>> {
    const r = await this.topups.create(actor, { shopId: shop.shopId, shopCode: shop.shopCode, shopName: shop.shopName }, BigInt(req.amount));
    return ApiResponse.ok(
      { ...toTopupResponse(r.topup, { shopName: shop.shopName, exposeLink: true }), reused: r.reused },
      r.reused ? 'Đang có link nạp cọc còn hạn — dùng lại link này' : 'Đã tạo link nạp cọc qua PayOS',
    );
  }

  @Get('shop/wallet/topups')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.wallet.read')
  @ApiOperation({ summary: 'Danh sách khoản nạp qua PayOS của shop, mới nhất trước (shopId trong query bị bỏ qua)' })
  async listMine(@Query() q: TopupListQuery, @CurrentShop() shop: ShopContext): Promise<ApiResponse<PageResponse<WalletTopupResponse>>> {
    const r = await this.topups.listMine(shop.shopId, { status: q.status }, q.skip, q.size);
    return ApiResponse.ok(PageResponse.of(r.items.map((t) => toTopupResponse(t, { shopName: shop.shopName, exposeLink: true })), q.page, q.size, r.total));
  }

  @Get('shop/wallet/topups/by-order-code/:orderCode')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.wallet.read')
  @RateLimit({ name: 'wallet-topup-read', limit: 200, windowSeconds: 600, by: 'user' })
  @ApiOperation({ summary: 'Tra khoản nạp theo mã PayOS (trang quay lại từ PayOS). Còn mở ⇒ làm mới từ PayOS trước khi trả' })
  @ApiOkResponse({ type: WalletTopupResponse })
  async byOrderCode(@Param('orderCode') orderCode: string, @CurrentShop() shop: ShopContext): Promise<ApiResponse<WalletTopupResponse>> {
    const t = await this.topups.getMineByOrderCode(shop.shopId, orderCode);
    return ApiResponse.ok(toTopupResponse(t, { shopName: shop.shopName, exposeLink: true }));
  }

  @Get('shop/wallet/topups/:id')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.wallet.read')
  @RateLimit({ name: 'wallet-topup-read', limit: 200, windowSeconds: 600, by: 'user' })
  @ApiOperation({ summary: 'Chi tiết khoản nạp của shop. Còn mở ⇒ làm mới từ PayOS (FE gọi định kỳ khi đang chờ)' })
  @ApiOkResponse({ type: WalletTopupResponse })
  async getMine(@Param('id', ParseUUIDPipe) id: string, @CurrentShop() shop: ShopContext): Promise<ApiResponse<WalletTopupResponse>> {
    const t = await this.topups.getMine(shop.shopId, id);
    return ApiResponse.ok(toTopupResponse(t, { shopName: shop.shopName, exposeLink: true }));
  }

  @Post('shop/wallet/topups/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.wallet.deposit_request')
  @RateLimit({ name: 'wallet-topup-cancel', limit: 10, windowSeconds: 600, by: 'user' })
  @ApiOperation({ summary: 'Huỷ link nạp cọc đang chờ (pending|partial). Trạng thái khác ⇒ 409 WALLET_TOPUP_INVALID_STATE' })
  @ApiOkResponse({ type: WalletTopupResponse })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext): Promise<ApiResponse<WalletTopupResponse>> {
    const t = await this.topups.cancelMine(actor, shop.shopId, id);
    return ApiResponse.ok(toTopupResponse(t, { shopName: shop.shopName, exposeLink: true }), 'Đã huỷ link nạp cọc');
  }

  // ---------- Sàn (xem-only) ----------

  @Get('admin/wallet-topups')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Khoản nạp qua PayOS của các gian hàng (xem-only; lọc theo trạng thái / gian hàng)' })
  async listAll(@Query() q: TopupListQuery): Promise<ApiResponse<PageResponse<WalletTopupResponse>>> {
    const r = await this.topups.listAll({ shopId: q.shopId, status: q.status }, q.skip, q.size);
    const names = await this.topups.shopNames(r.items.map((t) => t.shopId));
    return ApiResponse.ok(PageResponse.of(r.items.map((t) => toTopupResponse(t, { shopName: names.get(t.shopId), exposeLink: false })), q.page, q.size, r.total));
  }

  @Get('admin/wallet-topups/:id')
  @RequirePermission('supplier.wallet.read')
  @ApiOperation({ summary: 'Chi tiết khoản nạp PayOS kèm biên nhận (receipts) để kế toán đối chiếu. Không duyệt/từ chối tay' })
  @ApiOkResponse({ type: WalletTopupDetailResponse })
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<WalletTopupDetailResponse>> {
    const { topup, receipts } = await this.topups.getForAdmin(id);
    const names = await this.topups.shopNames([topup.shopId]);
    return ApiResponse.ok(toTopupDetail(topup, receipts, names.get(topup.shopId)));
  }
}
