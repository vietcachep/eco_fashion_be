import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, Public, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { PageQuery } from '@common/utils/pagination';
import { PaymentMethodResponse, PaymentResponse, PaymentService, RefundResponse } from './payment.service';

class ProcessRefundRequest {
  @ApiPropertyOptional({ description: 'Mã tham chiếu chuyển khoản (bắt buộc khi hoàn tay — gồm hoàn đơn COD và refund lịch sử qua cổng cũ): ghi sổ, KHÔNG gọi cổng.' }) @IsOptional() @IsString() @MaxLength(120) providerRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class SetMethodActiveRequest {
  @ApiProperty() @IsBoolean() isActive: boolean;
}
class PaymentListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsIn(['pending', 'processing', 'paid', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['cod', 'payos', 'vnpay', 'bank_transfer']) methodCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) q?: string;
}
class RefundListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsIn(['requested', 'processing', 'done', 'failed']) status?: string;
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
    return ApiResponse.ok(await this.payments.listPayments(q.page, q.size, { status: q.status, methodCode: q.methodCode, q: q.q }));
  }

  @Get('payments/:id') @RequirePermission('payment.payment.read')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<PaymentResponse>> {
    return ApiResponse.ok(await this.payments.getPayment(id));
  }

  @Get('refunds') @RequirePermission('payment.payment.read')
  async refunds(@Query() q: RefundListQuery): Promise<ApiResponse<PageResponse<RefundResponse>>> {
    return ApiResponse.ok(await this.payments.listRefunds(q.page, q.size, q.status));
  }

  @Post('refunds/:id/process') @HttpCode(HttpStatus.OK) @RequirePermission('payment.refund.process') @ApiOperation({ summary: 'Thực hiện hoàn tiền: PayOS payout (gateway, khi đủ số TK) hoặc ghi nhận đã chuyển tay (providerRef — hoàn đơn COD luôn là tay). Refund `processing` quá 10 phút chưa có providerRef được chiếm lại; đã có providerRef chỉ ghi sổ (không gọi cổng).' })
  async process(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ProcessRefundRequest): Promise<ApiResponse<RefundResponse>> {
    return ApiResponse.ok(await this.payments.processRefund(actor, id, body), 'Đã hoàn tiền');
  }

  @Post('refunds/:id/retry-finalize') @HttpCode(HttpStatus.OK) @RequirePermission('payment.refund.process') @ApiOperation({ summary: 'Hoàn tất GHI SỔ cho refund mà cổng ĐÃ chi (processing + providerRef) nhưng ghi sổ lỗi. KHÔNG gọi cổng; idempotent (chỉ ghi sổ một lần).' })
  async retryFinalize(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<RefundResponse>> {
    return ApiResponse.ok(await this.payments.retryFinalizeRefund(actor, id), 'Đã hoàn tất ghi sổ hoàn tiền');
  }
}
