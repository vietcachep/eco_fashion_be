import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { CurrentShop, RequireShopPermission, type ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ContactListQuery, ReplyContactRequest } from '../../system.requests';
import { ContactResponse, ContentService } from '../service/content.service';

/*
 * /shop/contacts — khách hỏi về sản phẩm / đơn của shop (nút "Hỏi shop"): shop tự xem và trả lời tin gửi CHÍNH shop mình.
 * `shopId` CHỈ từ ngữ cảnh (ShopContextGuard); tin của shop khác trả 404. Trả lời gửi email cho khách dưới tên gian hàng.
 */
@ApiTags('shops')
@ApiBearerAuth()
@Controller('shop/contacts')
@UseGuards(ShopContextGuard)
export class ShopContactsController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @RequireShopPermission('shop.contact.read')
  @ApiOperation({ summary: 'Tin nhắn khách gửi gian hàng của tôi (lọc status)' })
  async list(@Query() q: ContactListQuery, @CurrentShop() shop: ShopContext): Promise<ApiResponse<PageResponse<ContactResponse>>> {
    return ApiResponse.ok(await this.content.listContacts(q.page, q.size, { status: q.status }, shop.shopId));
  }

  @Post(':id/reply')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'shop-contact-reply', limit: 120, windowSeconds: 3600, by: 'user' })
  @RequireShopPermission('shop.contact.reply')
  @ApiOperation({ summary: 'Trả lời khách qua email (tin của shop khác → 404)' })
  async reply(@CurrentActor() actor: AuthenticatedActor, @CurrentShop() shop: ShopContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReplyContactRequest): Promise<ApiResponse<ContactResponse>> {
    return ApiResponse.ok(await this.content.replyContact(actor, id, body.reply.trim(), shop.shopId), 'Đã gửi phản hồi');
  }
}
