import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BusinessException } from '@common/exception/business.exception';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, Public, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { BannerResponse, BannerService } from './banner/service/banner.service';
import { ContactResponse, ContentService, FaqResponse, PageResponseDto } from './content/service/content.service';
import { NotificationResponse, NotificationService } from './notification/service/notification.service';
import { ProvinceResponse, ProvinceService } from './province/service/province.service';
import { SettingRow, SettingService } from './setting/service/setting.service';
import {
  BannerFormRequest,
  BroadcastNotificationRequest,
  ContactListQuery,
  ContactRequest,
  NotificationListQuery,
  ReplyContactRequest,
  SaveFaqRequest,
  SavePageRequest,
  UpdateProvinceRequest,
  UpdateSettingRequest,
} from './system.requests';

/* ===== Công khai: cấu hình shop, tỉnh/thành, banner, FAQ, trang, liên hệ (docs/06 mục system) ===== */
@ApiTags('system')
@Controller()
export class SystemPublicController {
  constructor(
    private readonly settings: SettingService,
    private readonly provinces: ProvinceService,
    private readonly banners: BannerService,
    private readonly content: ContentService,
  ) {}

  @Public() @Get('settings/public') @ApiOperation({ summary: 'Tham số công khai (tên shop, hotline, ngưỡng freeship…)' })
  async publicSettings(): Promise<ApiResponse<Record<string, unknown>>> {
    return ApiResponse.ok(await this.settings.listPublic());
  }

  @Public() @Get('provinces') @ApiOperation({ summary: '63 tỉnh/thành + phí ship' })
  async provincesList(): Promise<ApiResponse<ProvinceResponse[]>> {
    return ApiResponse.ok(await this.provinces.listPublic());
  }

  @Public() @Get('banners') @ApiOperation({ summary: 'Banner đang hiệu lực (?position=hero|promo)' })
  async bannersList(@Query('position') position?: string): Promise<ApiResponse<BannerResponse[]>> {
    return ApiResponse.ok(await this.banners.listPublic(position));
  }

  @Public() @Get('faqs')
  async faqs(): Promise<ApiResponse<FaqResponse[]>> {
    return ApiResponse.ok(await this.content.faqsPublic());
  }

  @Public() @Get('pages/:slug') @ApiOperation({ summary: 'Trang tĩnh: about · shipping · returns-policy · privacy · terms' })
  async page(@Param('slug') slug: string): Promise<ApiResponse<PageResponseDto>> {
    return ApiResponse.ok(await this.content.page(slug));
  }

  @Public() @RateLimit({ name: 'contact', limit: 5, windowSeconds: 3600, by: 'ip' }) @Post('contact') @ApiOperation({ summary: 'Gửi liên hệ (FE /contact)' })
  async contact(@Body() body: ContactRequest): Promise<ApiResponse<{ id: string }>> {
    return ApiResponse.ok(await this.content.submitContact({ name: body.name.trim(), email: body.email, phone: body.phone ?? null, message: body.message.trim() }), 'Đã nhận liên hệ, chúng tôi sẽ phản hồi sớm');
  }
}

/* ===== Thông báo của tôi ===== */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  async list(@CurrentActor() actor: AuthenticatedActor, @Query() q: NotificationListQuery): Promise<ApiResponse<PageResponse<NotificationResponse> & { unreadCount: number }>> {
    return ApiResponse.ok(await this.notifications.listMine(actor, q.page, q.size, q.unreadOnly ?? false));
  }

  @Post(':id/read') @HttpCode(HttpStatus.OK)
  async read(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.notifications.markRead(actor, id);
    return ApiResponse.ok(null);
  }

  @Post('read-all') @HttpCode(HttpStatus.OK)
  async readAll(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<{ marked: number }>> {
    return ApiResponse.ok({ marked: await this.notifications.markAllRead(actor) });
  }
}

/* ===== Quản trị ===== */
@ApiTags('admin-system')
@ApiBearerAuth()
@Controller('admin')
export class AdminSystemController {
  constructor(
    private readonly settings: SettingService,
    private readonly provinces: ProvinceService,
    private readonly banners: BannerService,
    private readonly notifications: NotificationService,
    private readonly content: ContentService,
  ) {}

  @Get('settings') @RequirePermission('system.setting.read')
  async settingsList(): Promise<ApiResponse<SettingRow[]>> {
    return ApiResponse.ok(await this.settings.listAdmin());
  }

  @Put('settings/:key') @RequirePermission('system.setting.update')
  async settingUpdate(@CurrentActor() actor: AuthenticatedActor, @Param('key') key: string, @Body() body: UpdateSettingRequest): Promise<ApiResponse<SettingRow>> {
    return ApiResponse.ok(await this.settings.update(actor, key, body.value), 'Đã cập nhật tham số');
  }

  @Get('provinces') @RequirePermission('system.province.manage')
  async provincesAdmin(): Promise<ApiResponse<ProvinceResponse[]>> {
    return ApiResponse.ok(await this.provinces.listAdmin());
  }

  @Patch('provinces/:code') @RequirePermission('system.province.manage')
  async provinceUpdate(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: UpdateProvinceRequest): Promise<ApiResponse<ProvinceResponse>> {
    return ApiResponse.ok(await this.provinces.updateFee(actor, code, body), 'Đã cập nhật phí ship');
  }

  @Get('banners') @RequirePermission('system.banner.manage')
  async bannersAdmin(): Promise<ApiResponse<BannerResponse[]>> {
    return ApiResponse.ok(await this.banners.listAdmin());
  }

  @Post('banners') @RequirePermission('system.banner.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } })) @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string' }, subtitle: { type: 'string' }, linkUrl: { type: 'string' }, position: { type: 'string' }, sortOrder: { type: 'number' } } } })
  async bannerCreate(@CurrentActor() actor: AuthenticatedActor, @Body() body: BannerFormRequest, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<BannerResponse>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu file ảnh (field `file`)');
    if (!body.title) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu tiêu đề');
    return ApiResponse.ok(await this.banners.create(actor, { ...body, title: body.title }, { buffer: file.buffer, mimetype: file.mimetype, size: file.size }), 'Đã tạo banner');
  }

  @Patch('banners/:id') @RequirePermission('system.banner.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } })) @ApiConsumes('multipart/form-data')
  async bannerUpdate(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: BannerFormRequest, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<BannerResponse>> {
    return ApiResponse.ok(await this.banners.update(actor, id, body, file ? { buffer: file.buffer, mimetype: file.mimetype, size: file.size } : undefined), 'Đã cập nhật banner');
  }

  @Delete('banners/:id') @HttpCode(HttpStatus.OK) @RequirePermission('system.banner.manage')
  async bannerDelete(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.banners.remove(actor, id);
    return ApiResponse.ok(null, 'Đã xoá banner');
  }

  @Post('notifications/broadcast') @HttpCode(HttpStatus.OK) @RequirePermission('system.notification.send')
  async broadcast(@CurrentActor() actor: AuthenticatedActor, @Body() body: BroadcastNotificationRequest): Promise<ApiResponse<{ sent: number }>> {
    return ApiResponse.ok({ sent: await this.notifications.broadcast(actor, { userIds: body.userIds, title: body.title, content: body.content ?? null, link: body.link ?? null }) }, 'Đã gửi thông báo');
  }

  @Get('contacts') @RequirePermission('system.notification.send')
  async contacts(@Query() q: ContactListQuery): Promise<ApiResponse<PageResponse<ContactResponse>>> {
    return ApiResponse.ok(await this.content.listContacts(q.page, q.size, q.status));
  }

  @Post('contacts/:id/reply') @HttpCode(HttpStatus.OK) @RequirePermission('system.notification.send')
  async replyContact(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReplyContactRequest): Promise<ApiResponse<ContactResponse>> {
    return ApiResponse.ok(await this.content.replyContact(actor, id, body.reply.trim()), 'Đã gửi phản hồi');
  }

  @Get('faqs') @RequirePermission('system.setting.read')
  async faqsAdmin(): Promise<ApiResponse<FaqResponse[]>> {
    return ApiResponse.ok(await this.content.faqsAdmin());
  }

  @Post('faqs') @RequirePermission('system.setting.update')
  async faqCreate(@CurrentActor() actor: AuthenticatedActor, @Body() body: SaveFaqRequest): Promise<ApiResponse<FaqResponse>> {
    return ApiResponse.ok(await this.content.saveFaq(actor, null, body), 'Đã thêm câu hỏi');
  }

  @Put('faqs/:id') @RequirePermission('system.setting.update')
  async faqUpdate(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaveFaqRequest): Promise<ApiResponse<FaqResponse>> {
    return ApiResponse.ok(await this.content.saveFaq(actor, id, body), 'Đã cập nhật');
  }

  @Delete('faqs/:id') @HttpCode(HttpStatus.OK) @RequirePermission('system.setting.update')
  async faqDelete(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.content.deleteFaq(actor, id);
    return ApiResponse.ok(null, 'Đã xoá');
  }

  @Get('pages') @RequirePermission('system.setting.read')
  async pagesAdmin(): Promise<ApiResponse<PageResponseDto[]>> {
    return ApiResponse.ok(await this.content.pagesAdmin());
  }

  @Put('pages/:slug') @RequirePermission('system.setting.update')
  async pageSave(@CurrentActor() actor: AuthenticatedActor, @Param('slug') slug: string, @Body() body: SavePageRequest): Promise<ApiResponse<PageResponseDto>> {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Slug trang không hợp lệ');
    return ApiResponse.ok(await this.content.savePage(actor, slug, body), 'Đã lưu trang');
  }
}
