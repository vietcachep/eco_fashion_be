import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@common/prisma/types';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { CurrentShop, RequireShopPermission, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { MarkPaidRequest, PayosBalanceResponse, PayoutListQuery, RunPayoutRequest, ShopPayoutDetailResponse, ShopPayoutResponse } from '../dto/shop-payout.dto';
import { ShopPayoutService } from '../shop-payout.service';

type PayoutRow = Prisma.ShopPayoutGetPayload<object>;
type LineRow = Prisma.ShopPayoutLineGetPayload<object>;

/* Số tài khoản chỉ lộ 4 số cuối ra API — số đầy đủ nằm trong snapshot của kỳ, chỉ dùng khi gọi PayOS. */
function maskedAccount(snapshot: unknown): string | null {
  const n = (snapshot as { accountNumber?: string } | null)?.accountNumber;
  return n ? `****${n.slice(-4)}` : null;
}

/* `vendor`: thông điệp lỗi của cổng chi (có thể lộ tình trạng quỹ chi của sàn) được thay bằng lời nhắn chung. */
function toPayout(p: PayoutRow, vendor = false, shopName?: string): ShopPayoutResponse {
  return {
    id: p.id,
    code: p.code,
    shopId: p.shopId,
    shopName,
    periodStart: p.periodStart.toISOString(),
    periodEnd: p.periodEnd.toISOString(),
    grossRevenue: p.grossRevenue.toFixed(0),
    commission: p.commission.toFixed(0),
    refundAmount: p.refundAmount.toFixed(0),
    carriedDebt: p.carriedDebt.toFixed(0),
    netPayout: p.netPayout.toFixed(0),
    status: p.status,
    providerRef: p.providerRef,
    failReason: vendor && p.status === 'failed' && p.failReason ? 'Chi trả chưa thành công — sàn đang xử lý lại, liên hệ hỗ trợ nếu quá 2 ngày làm việc' : p.failReason,
    paidAt: p.paidAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    bankAccountMasked: maskedAccount(p.bankSnapshot),
  };
}

const toLine = (l: LineRow) => ({ id: l.id, orderCode: l.orderCode, kind: l.kind, gross: l.gross.toFixed(0), commission: l.commission.toFixed(0) });

/*
 * Đối soát chi trả shop: sàn (`supplier.payout.*`) chạy kỳ / chạy lại / đánh dấu đã trả; vendor (`shop.payout.read`) chỉ xem kỳ của shop mình.
 * Route tĩnh (`payos-balance`, `run`) khai báo TRƯỚC `:id` để không bị `:id` nuốt.
 */
@ApiTags('payouts')
@ApiBearerAuth()
@Controller()
export class ShopPayoutController {
  constructor(private readonly service: ShopPayoutService) {}

  // ---------- Sàn ----------

  @Get('admin/payouts/payos-balance')
  @RequirePermission('supplier.payout.read')
  @ApiOperation({ summary: 'Số dư tài khoản chi PayOS (chỉ đọc)' })
  @ApiOkResponse({ type: PayosBalanceResponse })
  async payosBalance(): Promise<ApiResponse<PayosBalanceResponse>> {
    return ApiResponse.ok(await this.service.payosBalance());
  }

  @Post('admin/payouts/run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.process')
  @ApiOperation({ summary: 'Chạy kỳ đối soát toàn sàn (idempotent — chạy lại cùng kỳ không tạo trùng)' })
  @ApiOkResponse({ type: [ShopPayoutResponse] })
  async run(@Body() req: RunPayoutRequest, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ShopPayoutResponse[]>> {
    const created = await this.service.run({ periodStart: new Date(req.periodStart), periodEnd: new Date(req.periodEnd) }, actor);
    const names = await this.service.shopNames(created.map((p) => p.shopId));
    return ApiResponse.ok(created.map((p) => toPayout(p, false, names.get(p.shopId))), `Đã tạo ${created.length} kỳ đối soát`);
  }

  @Get('admin/payouts')
  @RequirePermission('supplier.payout.read')
  @ApiOperation({ summary: 'Danh sách kỳ đối soát (lọc status/shop)' })
  async list(@Query() q: PayoutListQuery): Promise<ApiResponse<PageResponse<ShopPayoutResponse>>> {
    const r = await this.service.list({ status: q.status, shopId: q.shopId }, q.skip, q.size);
    const names = await this.service.shopNames(r.items.map((p) => p.shopId));
    return ApiResponse.ok(PageResponse.of(r.items.map((p) => toPayout(p, false, names.get(p.shopId))), q.page, q.size, r.total));
  }

  @Get('admin/payouts/:id')
  @RequirePermission('supplier.payout.read')
  @ApiOperation({ summary: 'Chi tiết kỳ đối soát + dòng' })
  @ApiOkResponse({ type: ShopPayoutDetailResponse })
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ShopPayoutDetailResponse>> {
    const { payout, lines } = await this.service.getDetail(id);
    const names = await this.service.shopNames([payout.shopId]);
    return ApiResponse.ok({ payout: toPayout(payout, false, names.get(payout.shopId)), lines: lines.map(toLine) });
  }

  @Post('admin/payouts/:id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.process')
  @ApiOperation({ summary: 'Gửi lại lệnh chi PayOS (kỳ failed, hoặc pending khi đã có khoá payout)' })
  @ApiOkResponse({ type: ShopPayoutResponse })
  async retry(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ShopPayoutResponse>> {
    const p = await this.service.retry(id, actor);
    return ApiResponse.ok(toPayout(p, false, (await this.service.shopNames([p.shopId])).get(p.shopId)), 'Đã gửi lại lệnh chi');
  }

  @Post('admin/payouts/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.process')
  @ApiOperation({ summary: 'Kế toán đánh dấu đã chi (chuyển tay / đối chiếu processing)' })
  @ApiOkResponse({ type: ShopPayoutResponse })
  async markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() req: MarkPaidRequest, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ShopPayoutResponse>> {
    const p = await this.service.markPaid(id, req, actor);
    return ApiResponse.ok(toPayout(p, false, (await this.service.shopNames([p.shopId])).get(p.shopId)), 'Đã đánh dấu đã chi');
  }

  // ---------- Vendor (shopId CHỈ lấy từ ngữ cảnh) ----------

  @Get('shop/payouts')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.payout.read')
  @ApiOperation({ summary: 'Kỳ đối soát của shop' })
  async listMine(@Query() q: PayoutListQuery, @CurrentShop() shop: ShopContext): Promise<ApiResponse<PageResponse<ShopPayoutResponse>>> {
    const r = await this.service.list({ status: q.status, shopId: shop.shopId }, q.skip, q.size);
    return ApiResponse.ok(PageResponse.of(r.items.map((p) => toPayout(p, true, shop.shopName)), q.page, q.size, r.total));
  }

  @Get('shop/payouts/:id')
  @UseGuards(ShopContextGuard)
  @RequireShopPermission('shop.payout.read')
  @ApiOperation({ summary: 'Chi tiết kỳ đối soát của shop (kỳ shop khác → 404)' })
  @ApiOkResponse({ type: ShopPayoutDetailResponse })
  async detailMine(@Param('id', ParseUUIDPipe) id: string, @CurrentShop() shop: ShopContext): Promise<ApiResponse<ShopPayoutDetailResponse>> {
    const { payout, lines } = await this.service.getDetail(id, shop.shopId);
    return ApiResponse.ok({ payout: toPayout(payout, true, shop.shopName), lines: lines.map(toLine) });
  }
}
