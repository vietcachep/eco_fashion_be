import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { ShopRegistrationResponse } from '../dto/shop-registration.responses';
import { SubmitShopRegistrationRequest } from '../request/shop-registration.requests';
import { ShopRegistrationService } from '../service/shop-registration.service';

/*
 * /shop/registrations — người bán TỰ ĐĂNG KÝ gian hàng (PLAN-0019). Chỉ cần đăng nhập (JwtAuthGuard toàn cục); KHÔNG dùng ShopContextGuard
 * vì người nộp CHƯA là thành viên shop nào. Người nộp luôn là actor từ JWT — không có userId/shopId trong body/URL, nên `GET /me` chỉ trả hồ sơ
 * của chính người gọi. Ghi có @RateLimit theo user (rate limit không thay cho các luật 409 của service).
 */
@ApiTags('shop-registrations')
@ApiBearerAuth()
@Controller('shop/registrations')
export class ShopRegistrationController {
  constructor(private readonly registrations: ShopRegistrationService) {}

  @Post()
  @RateLimit({ name: 'shop-registration-submit', limit: 15, windowSeconds: 86400, by: 'user' })
  @ApiOperation({
    summary:
      'Nộp hồ sơ đăng ký bán hàng: tạo gian hàng ở trạng thái `pending` + hồ sơ, chờ sàn duyệt (khi duyệt, người nộp thành chủ shop). 403 SHOP_REGISTRATION_NOT_ELIGIBLE (nhân viên sàn/tài khoản không active); 400 SHOP_REGISTRATION_CATEGORY_INVALID; 409 SHOP_REGISTRATION_PENDING (đã có hồ sơ chờ) · SHOP_REGISTRATION_ALREADY_MEMBER (đã thuộc một gian hàng) · SHOP_NAME_TAKEN (trùng tên); 429 COMMON_RATE_LIMITED (15 lần/ngày, tính cả lần bị từ chối vì lỗi).',
  })
  @ApiCreatedResponse({ type: ShopRegistrationResponse })
  async submit(@CurrentActor() actor: AuthenticatedActor, @Body() body: SubmitShopRegistrationRequest): Promise<ApiResponse<ShopRegistrationResponse>> {
    return ApiResponse.ok(await this.registrations.submit(actor, body), 'Đã gửi hồ sơ đăng ký — chờ sàn duyệt');
  }

  @Get('me')
  @ApiOperation({ summary: 'Hồ sơ đăng ký MỚI NHẤT của tôi (kèm trạng thái duyệt/lý do từ chối/canReapply); chưa từng đăng ký ⇒ data = null' })
  @ApiOkResponse({ type: ShopRegistrationResponse, description: 'data = null khi chưa từng đăng ký' })
  async mine(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ShopRegistrationResponse | null>> {
    return ApiResponse.ok(await this.registrations.getMine(actor));
  }
}
