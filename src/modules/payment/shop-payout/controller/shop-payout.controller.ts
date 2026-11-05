import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@common/prisma/types';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { CurrentShop, RequireShopPermission, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { CreatePayoutHoldRequest, MarkPaidRequest, PayosBalanceResponse, PayoutHoldResponse, PayoutListQuery, ReleasePayoutHoldResponse, RunPayoutRequest, ShopPayoutDetailResponse, ShopPayoutResponse } from '../dto/shop-payout.dto';
import { ShopPayoutService } from '../shop-payout.service';

type PayoutRow = Prisma.ShopPayoutGetPayload<object>;
type LineRow = Prisma.ShopPayoutLineGetPayload<object>;

/* Số tài khoản chỉ lộ 4 số cuối ra API — số đầy đủ nằm trong snapshot của kỳ, chỉ dùng khi gọi PayOS. */
function maskedAccount(snapshot: unknown): string | null {
  const n = (snapshot as { accountNumber?: string } | null)?.accountNumber;
  return n ? `****${n.slice(-4)}` : null;
}

/* `vendor`: thông điệp lỗi của cổng chi (có thể lộ tình trạng quỹ chi của sàn) được thay bằng lời nhắn chung. */
function toPayout(p: PayoutRow, vendor = false, label?: string | { name: string; code: string }): ShopPayoutResponse {
  return {
    id: p.id,
    code: p.code,
    shopId: p.shopId,
    shopName: typeof label === 'string' ? label : label?.name,
    shopCode: typeof label === 'string' ? undefined : label?.code,
    periodStart: p.periodStart.toISOString(),
    periodEnd: p.periodEnd.toISOString(),
    grossRevenue: p.grossRevenue.toFixed(0),
    commission: p.commission.toFixed(0),
    refundAmount: p.refundAmount.toFixed(0),
    carriedDebt: p.carriedDebt.toFixed(0),
    netPayout: p.netPayout.toFixed(0),
    status: p.status,
    gatewayStatus: p.gatewayStatus,
    holdReason: p.holdReason,
    providerRef: p.providerRef,
    failReason: vendor && (p.status === 'failed' || p.status === 'unknown') && p.failReason ? 'Chi trả chưa thành công — sàn đang xử lý lại, liên hệ hỗ trợ nếu quá 2 ngày làm việc' : p.failReason,
    paidAt: p.paidAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    bankAccountMasked: maskedAccount(p.bankSnapshot),
  };
}

function toHold(h: { id: string; shopId: string; reason: string; createdAt: Date; releasedAt: Date | null }, label?: { name: string; code: string }): PayoutHoldResponse {
  return { id: h.id, shopId: h.shopId, shopName: label?.name, shopCode: label?.code, reason: h.reason, createdAt: h.createdAt.toISOString(), releasedAt: h.releasedAt?.toISOString() ?? null };
}

/* `orderCode` luôn là mã ĐƠN (dòng refund: đơn bị hoàn — cột source_order_code; dòng cũ không backfill được thì lùi về khoá RF-…); `lineKey` = khoá kỹ thuật duy nhất của dòng. */
const toLine = (l: LineRow) => ({ id: l.id, orderCode: l.sourceOrderCode ?? l.orderCode, lineKey: l.orderCode, kind: l.kind, gross: l.gross.toFixed(0), commission: l.commission.toFixed(0) });

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
    const created = await this.service.run({ periodStart: new Date(req.periodStart), periodEnd: new Date(req.periodEnd), shopId: req.shopId }, actor);
    const names = await this.service.shopLabels(created.map((p) => p.shopId));
    return ApiResponse.ok(created.map((p) => toPayout(p, false, names.get(p.shopId))), `Đã tạo ${created.length} kỳ đối soát`);
  }

  // ---------- Giữ tay tiền chi trả (PLAN-0026 §2.4) — route tĩnh khai báo TRƯỚC :id ----------

  @Post('admin/payouts/holds')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.process')
  @ApiOperation({ summary: 'Giữ tay tiền chi trả của một shop (có lý do): kỳ mới của shop vào held, kỳ pending/awaiting_approval chuyển held ngay. Mỗi shop tối đa một lệnh giữ (trùng ⇒ 409 PAYOUT_HOLD_EXISTS).' })
  @ApiOkResponse({ type: PayoutHoldResponse })
  async createHold(@Body() req: CreatePayoutHoldRequest, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<PayoutHoldResponse>> {
    const hold = await this.service.createHold(req.shopId, req.reason, actor);
    const labels = await this.service.shopLabels([hold.shopId]);
    return ApiResponse.ok(toHold(hold, labels.get(hold.shopId)), 'Đã giữ tiền chi trả của gian hàng');
  }

  @Get('admin/payouts/holds')
  @RequirePermission('supplier.payout.read')
  @ApiOperation({ summary: 'Danh sách lệnh giữ: có shopId = lịch sử của shop đó; bỏ trống = các lệnh ĐANG hiệu lực' })
  @ApiOkResponse({ type: [PayoutHoldResponse] })
  async listHolds(@Query('shopId') shopId?: string): Promise<ApiResponse<PayoutHoldResponse[]>> {
    const holds = await this.service.listHolds(shopId);
    const labels = await this.service.shopLabels(holds.map((h) => h.shopId));
    return ApiResponse.ok(holds.map((h) => toHold(h, labels.get(h.shopId))));
  }

  @Post('admin/payouts/holds/:id/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.process')
  @ApiOperation({ summary: 'Mở lệnh giữ tay: các kỳ held của shop không còn lý do giữ nào khác về pending / đi tiếp' })
  @ApiOkResponse({ type: ReleasePayoutHoldResponse })
  async releaseHold(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ReleasePayoutHoldResponse>> {
    const r = await this.service.releaseHold(id, actor);
    const hold = (await this.service.listHolds(r.hold.shopId)).find((h) => h.id === id);
    const labels = await this.service.shopLabels([r.hold.shopId]);
    return ApiResponse.ok({ hold: toHold(hold ?? { id, shopId: r.hold.shopId, reason: '', createdAt: new Date(), releasedAt: new Date() }, labels.get(r.hold.shopId)), releasedPayouts: r.released }, r.released > 0 ? `Đã mở giữ ${r.released} kỳ` : 'Đã mở lệnh giữ');
  }

  @Get('admin/payouts')
  @RequirePermission('supplier.payout.read')
  @ApiOperation({ summary: 'Danh sách kỳ đối soát (lọc status/shop)' })
  async list(@Query() q: PayoutListQuery): Promise<ApiResponse<PageResponse<ShopPayoutResponse>>> {
    const r = await this.service.list({ status: q.status, shopId: q.shopId }, q.skip, q.size);
    const names = await this.service.shopLabels(r.items.map((p) => p.shopId));
    return ApiResponse.ok(PageResponse.of(r.items.map((p) => toPayout(p, false, names.get(p.shopId))), q.page, q.size, r.total));
  }

  @Get('admin/payouts/:id')
  @RequirePermission('supplier.payout.read')
  @ApiOperation({ summary: 'Chi tiết kỳ đối soát + dòng' })
  @ApiOkResponse({ type: ShopPayoutDetailResponse })
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<ShopPayoutDetailResponse>> {
    const { payout, lines } = await this.service.getDetail(id);
    const names = await this.service.shopLabels([payout.shopId]);
    return ApiResponse.ok({ payout: toPayout(payout, false, names.get(payout.shopId)), lines: lines.map(toLine) });
  }

  @Post('admin/payouts/:id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.process')
  @ApiOperation({ summary: 'Gửi lại lệnh chi PayOS (kỳ failed, hoặc pending khi đã có khoá payout)' })
  @ApiOkResponse({ type: ShopPayoutResponse })
  async retry(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ShopPayoutResponse>> {
    const p = await this.service.retry(id, actor);
    return ApiResponse.ok(toPayout(p, false, (await this.service.shopLabels([p.shopId])).get(p.shopId)), 'Đã gửi lại lệnh chi');
  }

  @Post('admin/payouts/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.approve')
  @ApiOperation({ summary: 'Duyệt kỳ chi trả vượt hạn mức tự chi (awaiting_approval) ⇒ gửi PayOS' })
  @ApiOkResponse({ type: ShopPayoutResponse })
  async approve(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ShopPayoutResponse>> {
    const p = await this.service.approve(id, actor);
    return ApiResponse.ok(toPayout(p, false, (await this.service.shopLabels([p.shopId])).get(p.shopId)), 'Đã duyệt và gửi lệnh chi');
  }

  @Post('admin/payouts/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.process')
  @ApiOperation({ summary: 'Kiểm tra với PayOS kết quả lệnh chi của kỳ processing/unknown (cập nhật paid / failed / giữ nguyên)' })
  @ApiOkResponse({ type: ShopPayoutResponse })
  async reconcile(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ShopPayoutResponse>> {
    const r = await this.service.reconcileOne(id, actor);
    const { payout } = await this.service.getDetail(id);
    return ApiResponse.ok(toPayout(payout, false, (await this.service.shopLabels([payout.shopId])).get(payout.shopId)), `Kết quả đối chiếu: ${r.outcome} (${r.detail})`);
  }

  @Post('admin/payouts/:id/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.process')
  @ApiOperation({ summary: 'Mở giữ kỳ held khi lý do giữ đã hết (shop mở khoá / hết thời gian giữ đổi TK)' })
  @ApiOkResponse({ type: ShopPayoutResponse })
  async release(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ShopPayoutResponse>> {
    await this.service.releaseOne(id, actor); // còn lý do giữ ⇒ 409 PAYOUT_STILL_HELD kèm lý do
    const { payout } = await this.service.getDetail(id);
    return ApiResponse.ok(toPayout(payout, false, (await this.service.shopLabels([payout.shopId])).get(payout.shopId)), 'Đã mở giữ');
  }

  @Post('admin/payouts/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier.payout.process')
  @ApiOperation({ summary: 'Kế toán đánh dấu đã chi (chuyển tay / đối chiếu processing)' })
  @ApiOkResponse({ type: ShopPayoutResponse })
  async markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() req: MarkPaidRequest, @CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ShopPayoutResponse>> {
    const p = await this.service.markPaid(id, req, actor);
    return ApiResponse.ok(toPayout(p, false, (await this.service.shopLabels([p.shopId])).get(p.shopId)), 'Đã đánh dấu đã chi');
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
