import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import { CurrentActor, Public, RequirePermission } from '@common/security/decorators';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { RateLimit } from '@common/security/rate-limit.guard';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { CurrentShop, RequireShopPermission, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ShippingService } from './shipping.service';
import { ConfirmCarrierCodRequest, ShipmentResponse, ShipmentPageResponse, ShippingLabelResponse, ShippingListQuery, ShippingLocationQuery, ShippingLocationResponse, SimulateShipmentRequest } from './shipping.dto';

/* Ba scope dùng chung service; shopId luôn từ guard, callback chỉ ghi inbox trước khi phản hồi. */
@ApiTags('shipping')
@ApiBearerAuth()
@Controller()
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}
  @Get('shipping/locations/provinces') @Public()
  @ApiOperation({ summary: 'Danh mục tỉnh/thành của hãng vận chuyển' })
  @ApiOkResponse({ type: [ShippingLocationResponse] })
  async provinces() { return ApiResponse.ok(await this.shipping.locations('provinces')); }
  @Get('shipping/locations/districts') @Public()
  @ApiOkResponse({ type: [ShippingLocationResponse] })
  async districts(@Query() q: ShippingLocationQuery) { return ApiResponse.ok(q.provinceId ? await this.shipping.locations('districts', q.provinceId) : []); }
  @Get('shipping/locations/wards') @Public()
  @ApiOkResponse({ type: [ShippingLocationResponse] })
  async wards(@Query() q: ShippingLocationQuery) { return ApiResponse.ok(q.districtId ? await this.shipping.locations('wards', q.districtId) : []); }

  @Post('shop/orders/:code/ship') @UseGuards(ShopContextGuard) @RequireShopPermission('shop.order.update')
  @RateLimit({ name: 'shipment-create', limit: 30, windowSeconds: 600, by: 'user' })
  @ApiOkResponse({ type: ShipmentResponse })
  async ship(@Param('code') code: string, @CurrentShop() shop: ShopContext, @CurrentActor() actor: AuthenticatedActor, @Res({ passthrough: true }) res: Response) {
    const s = await this.shipping.ship(actor, shop.shopId, code); res.status(s?.createStatus === 'created' ? 200 : 202); return ApiResponse.ok(s);
  }
  @Post('shop/orders/:code/shipping/reconcile') @UseGuards(ShopContextGuard) @RequireShopPermission('shop.order.update') @HttpCode(200)
  @RateLimit({ name: 'shipment-reconcile', limit: 60, windowSeconds: 600, by: 'user' })
  @ApiOkResponse({ type: ShipmentResponse })
  async reconcile(@Param('code') code: string, @CurrentShop() shop: ShopContext, @CurrentActor() actor: AuthenticatedActor) { return ApiResponse.ok(await this.shipping.reconcile(actor, shop.shopId, code)); }
  @Get('shop/orders/:code/shipments') @UseGuards(ShopContextGuard) @RequireShopPermission('shop.order.read')
  @ApiOkResponse({ type: [ShipmentResponse] })
  async history(@Param('code') code: string, @CurrentShop() shop: ShopContext) { return ApiResponse.ok(await this.shipping.historyOwned(shop.shopId, code)); }
  @Get('shop/orders/:code/label') @UseGuards(ShopContextGuard) @RequireShopPermission('shop.order.read')
  @ApiOkResponse({ type: ShippingLabelResponse })
  async label(@Param('code') code: string, @CurrentShop() shop: ShopContext) { return ApiResponse.ok(await this.shipping.label(shop.shopId, code)); }

  @Get('admin/shipping/shipments') @RequirePermission('order.order.read')
  @ApiOkResponse({ type: ShipmentPageResponse })
  async list(@Query() q: ShippingListQuery) { const r = await this.shipping.list(q, q.page, q.size); return ApiResponse.ok(PageResponse.of(r.items, q.page, q.size, r.total)); }
  @Get('admin/shipping/shipments/:id') @RequirePermission('order.order.read')
  @ApiOkResponse({ type: ShipmentResponse })
  async detail(@Param('id', ParseUUIDPipe) id: string) { return ApiResponse.ok(await this.shipping.detail(id)); }
  @Post('admin/shipping/simulate') @RequirePermission('shipping.simulator.use') @HttpCode(200)
  @ApiOkResponse({ type: ShipmentResponse })
  async simulate(@Body() req: SimulateShipmentRequest) { return ApiResponse.ok(await this.shipping.simulate(req.shipmentId, req.event, req.eventId)); }
  @Post('admin/shipments/:id/confirm-cod-received') @RequirePermission('payment.cod.confirm') @HttpCode(200)
  @ApiOkResponse({ type: ShipmentResponse })
  async confirmCod(@Param('id', ParseUUIDPipe) id: string, @Body() req: ConfirmCarrierCodRequest, @CurrentActor() actor: AuthenticatedActor) { return ApiResponse.ok(await this.shipping.confirmCod(actor, id, req)); }

  @Post('webhooks/ghn') @Public() @HttpCode(200)
  async webhook(@Headers('x-ghn-secret') secret: string, @Body() payload: Record<string, unknown>) { await this.shipping.webhook(secret, payload); return ApiResponse.ok(null); }
}
