import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import { CurrentActor, OptionalAuth, RequirePermission } from '@common/security/decorators';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { RateLimit } from '@common/security/rate-limit.guard';
import { PageQuery } from '@common/utils/pagination';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import {
  CurrentShop,
  RequireShopPermission,
  type ShopContext,
} from '@modules/shop/security/shop-permission.decorator';
import { LIVE_SOURCE_GATEWAY, type LiveSourceGateway } from '@common/gateway/live-source.gateway';
import { Inject } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import { CheckoutIntentResponse } from '@modules/order/queryapi/checkout-contract';
import {
  CreateLiveCampaignRequest,
  LiveCampaignReasonRequest,
  LiveCampaignResponse,
  LiveVoucherClaimResponse,
} from './live-voucher.dto';
import { LiveVoucherService } from './live-voucher.service';

@ApiTags('live-vouchers')
@ApiBearerAuth()
@Controller()
export class LiveVoucherController {
  constructor(private readonly service: LiveVoucherService) {}
  @Get('livestreams/:id/campaigns')
  @OptionalAuth()
  @ApiOkResponse({ type: [LiveCampaignResponse] })
  async list(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor?: AuthenticatedActor) {
    return ApiResponse.ok(await this.service.list(id, actor?.userId));
  }
  @Post('livestreams/:id/campaigns/:campaignId/claims')
  @ApiOkResponse({ type: LiveVoucherClaimResponse })
  @RateLimit({ name: 'live-claim', limit: 20, windowSeconds: 60, by: 'user' })
  async claim(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return ApiResponse.ok(await this.service.claim(actor.userId, id, campaignId));
  }
  @Get('promotions/me/claims')
  @ApiOkResponse({ type: PageResponse })
  async claims(@CurrentActor() actor: AuthenticatedActor, @Query() q: PageQuery) {
    return ApiResponse.ok(await this.service.claims(actor.userId, q.page, q.size));
  }
  @Post('promotions/me/claims/:id/recovery-intents')
  @ApiOkResponse({ type: CheckoutIntentResponse })
  @RateLimit({ name: 'live-recovery', limit: 20, windowSeconds: 60, by: 'user' })
  async recovery(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string) {
    return ApiResponse.ok(await this.service.recovery(actor.userId, id));
  }
}

@ApiTags('shop-live-vouchers')
@ApiBearerAuth()
@Controller('shop/livestreams')
@UseGuards(ShopContextGuard)
export class ShopLiveVoucherController {
  constructor(
    private readonly service: LiveVoucherService,
    @Inject(LIVE_SOURCE_GATEWAY) private readonly source: LiveSourceGateway,
  ) {}
  private async own(shopId: string, id: string) {
    const session = await this.source.session(id);
    if (!session || session.shopId !== shopId)
      throw new NotFoundException('LIVE_SESSION_NOT_FOUND', 'Không tìm thấy phiên của shop');
  }
  @Get(':id/campaigns')
  @RequireShopPermission('shop.livestream.read')
  @ApiOkResponse({ type: [LiveCampaignResponse] })
  async list(
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    await this.own(shop.shopId, id);
    return ApiResponse.ok(await this.service.list(id, actor.userId));
  }
  @Post(':id/campaigns')
  @RequireShopPermission('shop.livestream.manage', 'shop.promotion.manage')
  @ApiOkResponse({ type: LiveCampaignResponse })
  async create(
    @CurrentShop() shop: ShopContext,
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateLiveCampaignRequest,
  ) {
    return ApiResponse.ok(await this.service.create(actor.userId, shop.shopId, id, body));
  }
  @Post(':id/campaigns/:campaignId/close')
  @RequireShopPermission('shop.livestream.manage', 'shop.promotion.manage')
  @ApiOkResponse({ type: [LiveCampaignResponse] })
  async close(
    @CurrentShop() shop: ShopContext,
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() body: LiveCampaignReasonRequest,
  ) {
    return ApiResponse.ok(
      await this.service.change(
        actor.userId,
        shop.shopId,
        id,
        campaignId,
        'closed',
        body.reason ?? 'Shop đóng nhận',
      ),
    );
  }
  @Post(':id/campaigns/:campaignId/revoke')
  @RequireShopPermission('shop.livestream.manage', 'shop.promotion.manage')
  @ApiOkResponse({ type: [LiveCampaignResponse] })
  async revoke(
    @CurrentShop() shop: ShopContext,
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() body: LiveCampaignReasonRequest,
  ) {
    return ApiResponse.ok(
      await this.service.change(
        actor.userId,
        shop.shopId,
        id,
        campaignId,
        'revoked',
        body.reason ?? 'Shop thu hồi',
      ),
    );
  }
}

@ApiTags('admin-live-vouchers')
@ApiBearerAuth()
@Controller('admin/livestreams')
export class AdminLiveVoucherController {
  constructor(
    private readonly service: LiveVoucherService,
    @Inject(LIVE_SOURCE_GATEWAY) private readonly source: LiveSourceGateway,
  ) {}
  private async shop(id: string) {
    const s = await this.source.session(id);
    if (!s) throw new NotFoundException('LIVE_SESSION_NOT_FOUND', 'Không tìm thấy phiên');
    return s.shopId;
  }
  @Get(':id/campaigns')
  @RequirePermission('livestream.session.read')
  @ApiOkResponse({ type: [LiveCampaignResponse] })
  async list(@Param('id', ParseUUIDPipe) id: string) {
    return ApiResponse.ok(await this.service.list(id));
  }
  @Post(':id/campaigns')
  @RequirePermission('promotion.promotion.manage', 'livestream.session.read')
  @ApiOkResponse({ type: LiveCampaignResponse })
  async create(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateLiveCampaignRequest,
  ) {
    return ApiResponse.ok(await this.service.create(actor.userId, await this.shop(id), id, body, 'platform'));
  }
  @Post(':id/campaigns/:campaignId/revoke')
  @RequirePermission('promotion.promotion.manage')
  @ApiOkResponse({ type: [LiveCampaignResponse] })
  async revoke(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() body: LiveCampaignReasonRequest,
  ) {
    return ApiResponse.ok(
      await this.service.change(
        actor.userId,
        await this.shop(id),
        id,
        campaignId,
        'revoked',
        body.reason ?? 'Sàn thu hồi',
      ),
    );
  }
}
