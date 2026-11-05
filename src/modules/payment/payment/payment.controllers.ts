import { Body, Controller, Get, Header, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, Public, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { PageQuery } from '@common/utils/pagination';
import { ToBoolean } from '@common/utils/transform';
import { RefundPayeeRevealResponse, RefundResponse } from './dto/refund.dto';
import { PaymentMethodResponse, PaymentResponse, PaymentService } from './payment.service';

class ProcessRefundRequest {
  @ApiPropertyOptional({ description: 'Mã giao dịch chuyển khoản (bắt buộc khi hoàn tay — đơn COD khi chưa cấu hình payout, thiếu tài khoản nhận, refund lịch sử qua cổng cũ): ghi sổ, KHÔNG gọi cổng. 4–120 ký tự chữ-số và `. _ : / # -`, DUY NHẤT toàn hệ thống (trùng ⇒ 409 REFUND_PROVIDER_REF_DUPLICATE), không mở đầu bằng `payos-refund:`.' })
  @IsOptional() @IsString() @MinLength(4) @MaxLength(120) @Matches(/^\s*[A-Za-z0-9][A-Za-z0-9._:/#-]*\s*$/, { message: 'providerRef chỉ gồm chữ, số và các ký tự . _ : / # -' }) providerRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ type: Boolean, description: 'Chỉ dùng khi hoàn tay một khoản có lệnh chi PayOS ở trạng thái KHÔNG RÕ mà hệ thống KHÔNG tra được PayOS: kế toán xác nhận đã đối chiếu trên bảng điều khiển PayOS và lệnh CHƯA chạy. PayOS tra được và ĐÃ nhận lệnh ⇒ luôn bị chặn 409.' })
  @IsOptional() @IsBoolean() confirmGatewayNotExecuted?: boolean;
}
class SetMethodActiveRequest {
  @ApiProperty() @IsBoolean() isActive: boolean;
}
class PaymentListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsIn(['pending', 'processing', 'paid', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['cod', 'payos', 'vnpay', 'bank_transfer']) methodCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) q?: string;
  @ApiPropertyOptional({ description: 'Chỉ giao dịch của đơn thuộc gian hàng này' }) @IsOptional() @IsUUID('loose') shopId?: string;
}
class RefundListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['requested', 'processing', 'done', 'failed'] }) @IsOptional() @IsIn(['requested', 'processing', 'done', 'failed']) status?: string;
  @ApiPropertyOptional({ description: 'Chỉ hoàn tiền của đơn thuộc gian hàng này' }) @IsOptional() @IsUUID('loose') shopId?: string;
  @ApiPropertyOptional({ type: Boolean, description: 'true = chỉ khoản đang CHỜ chuyển tay (thiếu tài khoản nhận / không qua cổng / chưa cấu hình payout / PayOS treo bất thường); false/bỏ trống = không lọc' })
  @IsOptional() @ToBoolean() @IsBoolean() needsManual?: boolean;
}

/* Công khai: phương thức (cod · payos); webhook PayOS (server-to-server) và return (FE trang kết quả). */
@ApiTags('payments')
@Controller()
export class PaymentPublicController {
  constructor(private readonly payments: PaymentService) {}

  @Public() @Get('payment-methods') @ApiOperation({ summary: 'Phương thức thanh toán đang bật (cod · payos — payos chỉ hiện khi có khoá)' })
  async methods(): Promise<ApiResponse<PaymentMethodResponse[]>> {
    return ApiResponse.ok(await this.payments.listMethods(true));
  }

  @Public() @Post('payments/payos/webhook') @HttpCode(HttpStatus.OK) @RateLimit({ name: 'payos-webhook', limit: 1200, windowSeconds: 600, by: 'ip' })
  @ApiOperation({ summary: 'Webhook PayOS (server-to-server) — xác minh chữ ký, ghi nhận thanh toán (idempotent)' })
  async payosWebhook(@Body() body: Record<string, unknown>): Promise<{ code: string; message: string }> {
    const r = await this.payments.handlePayos(body);
    if (r.statusCode !== 200) {
      throw new HttpException(r.body, r.statusCode);
    }
    return r.body as { code: string; message: string };
  }

  @Public() @RateLimit({ name: 'payos-return', limit: 30, windowSeconds: 600, by: 'ip' }) @Get('payments/payos/return')
  @ApiOperation({ summary: 'FE trang kết quả PayOS gọi với `orderCode` (PayOS) — hỏi lại PayOS rồi ghi nhận thanh toán (idempotent, giống webhook)' })
  async payosReturn(@Query('orderCode') orderCode?: string): Promise<ApiResponse<{ success: boolean; orderCode: string | null; status: string; message: string }>> {
    const r = await this.payments.handlePayosReturn(orderCode ?? '');
    return ApiResponse.ok(r, r.message);
  }
}

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Post('payos/retry/:orderCode') @HttpCode(HttpStatus.OK) @RateLimit({ name: 'payos-retry', limit: 10, windowSeconds: 600, by: 'user' })
  @ApiOperation({ summary: 'Khách thanh toán lại đơn PayOS (link hết hạn / đã huỷ) — trả link mới' })
  async retryPayos(@CurrentActor() actor: AuthenticatedActor, @Param('orderCode') orderCode: string): Promise<ApiResponse<{ paymentUrl: string }>> {
    return ApiResponse.ok(await this.payments.retryPayos(actor, orderCode.toUpperCase()));
  }
}

@ApiTags('admin-payments')
@ApiBearerAuth()
@Controller('admin')
export class AdminPaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Get('payment-methods') @RequirePermission('payment.method.manage')
  async methods(): Promise<ApiResponse<PaymentMethodResponse[]>> {
    return ApiResponse.ok(await this.payments.listMethods(false));
  }

  @Put('payment-methods/:code') @RequirePermission('payment.method.manage')
  async setMethod(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: SetMethodActiveRequest): Promise<ApiResponse<PaymentMethodResponse>> {
    return ApiResponse.ok(await this.payments.setMethodActive(actor, code, body.isActive), 'Đã cập nhật');
  }

  @Get('payments') @RequirePermission('payment.payment.read')
  async list(@Query() q: PaymentListQuery): Promise<ApiResponse<PageResponse<PaymentResponse>>> {
    return ApiResponse.ok(await this.payments.listPayments(q.page, q.size, { status: q.status, methodCode: q.methodCode, q: q.q, shopId: q.shopId }));
  }

  @Get('payments/:id') @RequirePermission('payment.payment.read')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<PaymentResponse>> {
    return ApiResponse.ok(await this.payments.getPayment(id));
  }

  @Get('refunds') @RequirePermission('payment.payment.read')
  @ApiOperation({ summary: 'Danh sách hoàn tiền (lọc status / shopId / needsManual): có tài khoản nhận (che số), nguồn tài khoản, trạng thái lệnh chi PayOS, cờ chờ chuyển tay, yêu cầu đổi trả gốc. Phần tử là RefundResponse.' })
  async refunds(@Query() q: RefundListQuery): Promise<ApiResponse<PageResponse<RefundResponse>>> {
    return ApiResponse.ok(await this.payments.listRefunds(q.page, q.size, { status: q.status, shopId: q.shopId, needsManual: q.needsManual }));
  }

  @Get('refunds/:id/payee') @RequirePermission('payment.refund.process') @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'refund-payee-reveal', limit: 60, windowSeconds: 600, by: 'user' })
  @ApiOperation({ summary: 'Xem SỐ TÀI KHOẢN ĐẦY ĐỦ nhận hoàn để chuyển khoản tay (ưu tiên tài khoản đã trả tiền, sau đó khách khai). Dữ liệu nhạy cảm: mỗi lần xem ghi audit REFUND_PAYEE_VIEWED (không ghi số), Cache-Control: no-store. Chỉ khi refund còn mở (requested/processing/failed): đã hoàn xong ⇒ 409 PAYMENT_INVALID_STATE; chưa có tài khoản ⇒ 404 PAYMENT_REFUND_PAYEE_NOT_FOUND.' })
  @ApiOkResponse({ type: RefundPayeeRevealResponse })
  async payee(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<RefundPayeeRevealResponse>> {
    return ApiResponse.ok(await this.payments.revealPayee(actor, id));
  }

  @Post('refunds/:id/process') @HttpCode(HttpStatus.OK) @RequirePermission('payment.refund.process')
  @ApiOperation({ summary: 'Thực hiện hoàn tiền: PayOS payout khi đủ điều kiện (tài khoản đã trả tiền → tài khoản khách khai) hoặc ghi nhận đã chuyển tay (providerRef, duy nhất). PayOS "đã nhận lệnh" KHÔNG phải xong: refund giữ `processing` (gatewayStatus submitted) tới khi PayOS báo thành công thật (job đối soát/bấm lại) — thất bại ⇒ `failed` chạy lại được. Đã gửi lệnh thì không gửi lại. Refund `processing` quá 10 phút chưa gửi lệnh được chiếm lại; đã có providerRef chỉ ghi sổ (không gọi cổng).' })
  @ApiOkResponse({ type: RefundResponse })
  async process(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ProcessRefundRequest): Promise<ApiResponse<RefundResponse>> {
    const refund = await this.payments.processRefund(actor, id, body);
    const message = refund.status === 'done' ? 'Đã hoàn tiền' : refund.status === 'failed' ? 'PayOS báo lệnh hoàn tiền thất bại — kiểm tra ghi chú, có thể chạy lại hoặc chuyển khoản tay' : 'Đã gửi lệnh hoàn tiền sang PayOS — đang chờ ngân hàng xác nhận';
    return ApiResponse.ok(refund, message);
  }

  @Post('refunds/:id/retry-finalize') @HttpCode(HttpStatus.OK) @RequirePermission('payment.refund.process') @ApiOperation({ summary: 'Hoàn tất GHI SỔ cho refund mà tiền ĐÃ đi (processing + providerRef — PayOS đã xác nhận hoặc nhập tay) nhưng ghi sổ lỗi. KHÔNG gọi cổng; idempotent (chỉ ghi sổ một lần).' })
  @ApiOkResponse({ type: RefundResponse })
  async retryFinalize(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<RefundResponse>> {
    return ApiResponse.ok(await this.payments.retryFinalizeRefund(actor, id), 'Đã hoàn tất ghi sổ hoàn tiền');
  }
}
