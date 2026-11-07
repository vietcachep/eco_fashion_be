import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import { CurrentActor, OptionalAuth, Public, RequirePermission } from '@common/security/decorators';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { RateLimit } from '@common/security/rate-limit.guard';
import { UnauthorizedException } from '@common/exception/business.exception';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import {
  CurrentShop,
  RequireShopPermission,
  type ShopContext,
} from '@modules/shop/security/shop-permission.decorator';
import { ProductQueryApi } from '@modules/product/queryapi/product.queryapi';
import { LiveService } from './live.service';
import { LiveMediaService } from './media/live-media.service';
import {
  LiveAdmissionRequest,
  LiveCreateRequest,
  LiveEditRequest,
  LiveEndRequest,
  LiveFollowRequest,
  LiveGrantRequest,
  LiveLikeRequest,
  LiveListQuery,
  LiveMediaResponse,
  LiveMessageQuery,
  LiveMessageRequest,
  LiveMessageResponse,
  LiveModerationRequest,
  LiveModeratorsRequest,
  LivePinRequest,
  LiveProductsRequest,
  LiveReportListQuery,
  LiveReportProcessRequest,
  LiveReportRequest,
  LiveRestrictRequest,
  LiveSessionResponse,
  LiveStartRequest,
  LiveVersionRequest,
  LiveViewerResponse,
} from './live.dto';

/* REST public/optional auth: token media cấp sau admission, chat và source luôn lấy user từ JWT. */
@ApiTags('livestream')
@Controller('livestreams')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly media: LiveMediaService,
  ) {}
  @Get()
  @OptionalAuth()
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: LiveListQuery, @CurrentActor() a?: AuthenticatedActor) {
    return ApiResponse.ok(await this.live.list(q, undefined, a));
  }
  @Get(':id')
  @OptionalAuth()
  @ApiOkResponse({ type: LiveSessionResponse })
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a?: AuthenticatedActor) {
    return ApiResponse.ok(await this.live.detail(id, a));
  }
  @Get(':id/products')
  @OptionalAuth()
  @ApiOkResponse({ type: PageResponse })
  async products(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: LiveListQuery,
    @CurrentActor() a?: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.productPage(id, q, a));
  }
  @Post(':id/viewer-session')
  @OptionalAuth()
  @RateLimit({ name: 'live-viewer', limit: 30, windowSeconds: 60 })
  @ApiOkResponse({ type: LiveViewerResponse })
  async viewer(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() a: AuthenticatedActor | undefined,
    @Headers('x-guest-key') key?: string,
  ) {
    return ApiResponse.ok(await this.live.viewer(id, a, key));
  }
  @Post(':id/heartbeat')
  @OptionalAuth()
  @RateLimit({ name: 'live-heartbeat', limit: 120, windowSeconds: 60 })
  async heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveAdmissionRequest,
    @CurrentActor() a: AuthenticatedActor | undefined,
    @Headers('x-guest-key') key?: string,
  ) {
    return ApiResponse.ok(await this.live.heartbeat(id, b.admissionId, a, key));
  }
  @Post(':id/leave')
  @OptionalAuth()
  async leave(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveAdmissionRequest,
    @CurrentActor() a: AuthenticatedActor | undefined,
    @Headers('x-guest-key') key?: string,
  ) {
    return ApiResponse.ok(await this.live.heartbeat(id, b.admissionId, a, key, true));
  }
  @Post(':id/likes')
  @OptionalAuth()
  @RateLimit({ name: 'live-like', limit: 30, windowSeconds: 60 })
  async like(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveLikeRequest,
    @CurrentActor() a: AuthenticatedActor | undefined,
    @Headers('x-guest-key') key?: string,
  ) {
    return ApiResponse.ok(await this.live.like(id, b.admissionId, b.count ?? 1, a, key));
  }
  @Post(':id/source-grants')
  @ApiBearerAuth()
  @RateLimit({ name: 'live-grant', limit: 30, windowSeconds: 60 })
  async grant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveGrantRequest,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.grant(a, id, b));
  }
  @Get(':id/messages')
  @OptionalAuth()
  @ApiOkResponse({ type: [LiveMessageResponse] })
  async messages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: LiveMessageQuery,
    @CurrentActor() a?: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.messagePage(id, q, a));
  }
  @Post(':id/messages')
  @ApiBearerAuth()
  @RateLimit({ name: 'live-chat', limit: 30, windowSeconds: 60 })
  @ApiOkResponse({ type: LiveMessageResponse })
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveMessageRequest,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.sendMessage(a, id, b));
  }
  @Get(':id/follow')
  @OptionalAuth()
  async followStatus(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a?: AuthenticatedActor) {
    const s = await this.live.required(id);
    await this.live.canRead(s, a);
    return ApiResponse.ok({ following: await this.live.follows.following(s.shopId, a?.userId) });
  }
  @Post(':id/follow')
  @ApiBearerAuth()
  async follow(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveFollowRequest,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    const s = await this.live.required(id);
    await this.live.canRead(s, a);
    return ApiResponse.ok(await this.live.follows.set(a, s.shopId, b.following));
  }
  @Post(':id/reports')
  @ApiBearerAuth()
  @RateLimit({ name: 'live-report', limit: 10, windowSeconds: 3600 })
  async report(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveReportRequest,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.report(a, id, b));
  }
  @Post('media/webhook')
  @Public()
  async webhook(@Body() body: unknown, @Headers('authorization') authorization?: string) {
    if (typeof body !== 'string')
      throw new UnauthorizedException('LIVE_WEBHOOK_INVALID', 'Webhook phải dùng application/webhook+json.');
    await this.media.receive(body, authorization);
    return ApiResponse.ok({ received: true });
  }
}

/* Vendor: ShopContextGuard kiểm ownership từ thành viên, không nhận shopId từ body. */
@ApiTags('shop-livestream')
@ApiBearerAuth()
@UseGuards(ShopContextGuard)
@Controller('shop/livestreams')
export class ShopLiveController {
  constructor(
    private readonly live: LiveService,
    private readonly products: ProductQueryApi,
  ) {}
  @Get()
  @RequireShopPermission('shop.livestream.read')
  @ApiOkResponse({ type: PageResponse })
  async list(
    @Query() q: LiveListQuery,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.list(q, { shopId: s.shopId }, a));
  }
  @Get('product-options')
  @RequireShopPermission('shop.livestream.manage')
  @ApiOkResponse({ type: PageResponse })
  async options(@Query() q: LiveListQuery, @CurrentShop() s: ShopContext) {
    const p = await this.products.listLiveCards(s.shopId, q);
    return ApiResponse.ok(PageResponse.of(p.items, q.page, q.size, p.total));
  }
  @Post()
  @RequireShopPermission('shop.livestream.manage')
  @ApiOkResponse({ type: LiveSessionResponse })
  async create(
    @Body() b: LiveCreateRequest,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.create(a, s.shopId, b));
  }
  @Get(':id')
  @RequireShopPermission('shop.livestream.read')
  @ApiOkResponse({ type: LiveSessionResponse })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.detail(id, a, s.shopId));
  }
  @Patch(':id')
  @RequireShopPermission('shop.livestream.manage')
  @ApiOkResponse({ type: LiveSessionResponse })
  async edit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveEditRequest,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.edit(a, s.shopId, id, b));
  }
  @Post(':id/cancel')
  @RequireShopPermission('shop.livestream.manage')
  @ApiOkResponse({ type: LiveSessionResponse })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveVersionRequest,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.stop(a, id, 'Shop huỷ lịch', s.shopId, false, b.version));
  }
  @Get(':id/products')
  @RequireShopPermission('shop.livestream.read')
  @ApiOkResponse({ type: PageResponse })
  async listProducts(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: LiveListQuery,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.productPage(id, q, a, s.shopId));
  }
  @Put(':id/products')
  @RequireShopPermission('shop.livestream.manage')
  @ApiOkResponse({ type: LiveSessionResponse })
  async setProducts(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveProductsRequest,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.updateProducts(a, s.shopId, id, b.productIds, b.version));
  }
  @Post(':id/pin')
  @RequireShopPermission('shop.livestream.manage')
  @ApiOkResponse({ type: LiveSessionResponse })
  async pin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LivePinRequest,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.pin(a, s.shopId, id, b.productId ?? null, b.version));
  }
  @Post(':id/start')
  @RequireShopPermission('shop.livestream.broadcast')
  @ApiOkResponse({ type: LiveMediaResponse })
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveStartRequest,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.start(a, s.shopId, id, b.rehearsal));
  }
  @Post(':id/host-token')
  @RequireShopPermission('shop.livestream.broadcast')
  @ApiOkResponse({ type: LiveMediaResponse })
  async token(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.hostToken(a, s.shopId, id));
  }
  @Post(':id/end')
  @RequireShopPermission('shop.livestream.broadcast')
  @ApiOkResponse({ type: LiveSessionResponse })
  async end(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveEndRequest,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.stop(a, id, b.reason ?? 'Shop kết thúc', s.shopId));
  }
  @Get(':id/messages')
  @RequireShopPermission('shop.livestream.read')
  @ApiOkResponse({ type: [LiveMessageResponse] })
  async messages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: LiveMessageQuery,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.messagePage(id, q, a, s.shopId));
  }
  @Post(':id/moderation')
  @RequireShopPermission('shop.livestream.moderate')
  async moderate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveModerationRequest,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.moderate(a, s.shopId, id, b));
  }
  @Get(':id/moderators')
  @RequireShopPermission('shop.livestream.manage')
  async moderators(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.moderators(a, s.shopId, id));
  }
  @Put(':id/moderators')
  @RequireShopPermission('shop.livestream.manage')
  async setModerators(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveModeratorsRequest,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.moderators(a, s.shopId, id, b.userIds));
  }
  @Get(':id/report')
  @RequireShopPermission('shop.livestream.report.read')
  async report(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentShop() s: ShopContext,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.statistics(id, s.shopId, a));
  }
}

@ApiTags('admin-livestream')
@ApiBearerAuth()
@Controller('admin')
export class AdminLiveController {
  constructor(private readonly live: LiveService) {}
  @Get('livestreams')
  @RequirePermission('livestream.session.read')
  @ApiOkResponse({ type: PageResponse })
  async list(@Query() q: LiveListQuery, @CurrentActor() a: AuthenticatedActor) {
    return ApiResponse.ok(await this.live.list(q, { admin: true }, a));
  }
  @Get('livestreams/:id')
  @RequirePermission('livestream.session.read')
  @ApiOkResponse({ type: LiveSessionResponse })
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: AuthenticatedActor) {
    return ApiResponse.ok(await this.live.detail(id, a, undefined, true));
  }
  @Post('livestreams/:id/terminate')
  @RequirePermission('livestream.session.terminate')
  @ApiOkResponse({ type: LiveSessionResponse })
  async stop(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveReportRequest,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.stop(a, id, b.reason, undefined, true));
  }
  @Get('livestream-reports')
  @RequirePermission('livestream.report.read')
  @ApiOkResponse({ type: PageResponse })
  async reports(@Query() q: LiveReportListQuery) {
    return ApiResponse.ok(await this.live.reports(q));
  }
  @Post('livestream-reports/:id/process')
  @RequirePermission('livestream.report.process')
  async process(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: LiveReportProcessRequest,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.processReport(a, id, b.decision, b.note));
  }
  @Post('livestreams/shops/:shopId/restrict')
  @RequirePermission('livestream.shop.restrict')
  async restrict(
    @Param('shopId', ParseUUIDPipe) id: string,
    @Body() b: LiveRestrictRequest,
    @CurrentActor() a: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.live.restrict(a, id, b.restricted, b.reason));
  }
}
