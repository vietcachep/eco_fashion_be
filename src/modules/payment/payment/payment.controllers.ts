import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, Public, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { PageQuery } from '@common/utils/pagination';
import { PaymentMethodResponse, PaymentResponse, PaymentService, RefundResponse, VnpayResult } from './payment.service';

class ConfirmTransferRequest {
  @ApiPropertyOptional({ example: 'FT26091512345' }) @IsOptional() @IsString() @MaxLength(120) bankRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class ProcessRefundRequest {
  @ApiPropertyOptional({ description: 'Mã tham chiếu chuyển khoản (bắt buộc khi hoàn tay)' }) @IsOptional() @IsString() @MaxLength(120) providerRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class SetMethodActiveRequest {
  @ApiProperty() @IsBoolean() isActive: boolean;
}
class PaymentListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsIn(['pending', 'processing', 'paid', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['cod', 'bank_transfer', 'vnpay']) methodCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) q?: string;
}
class RefundListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsIn(['requested', 'processing', 'done', 'failed']) status?: string;
}

/* Công khai: phương thức; VNPay return (FE gọi với query VNPay chuyển về) và IPN (server-to-server, JSON chuẩn VNPay). */
@ApiTags('payments')
@Controller()
export class PaymentPublicController {
  constructor(private readonly payments: PaymentService) {}

  @Public() @Get('payment-methods') @ApiOperation({ summary: 'Phương thức thanh toán đang bật (cod · bank_transfer · vnpay)' })
  async methods(): Promise<ApiResponse<PaymentMethodResponse[]>> {
    return ApiResponse.ok(await this.payments.listMethods(true));
  }

  @Public() @RateLimit({ name: 'vnpay-return', limit: 30, windowSeconds: 600, by: 'ip' }) @Get('payments/vnpay/return')
  @ApiOperation({ summary: 'FE trang kết quả gọi với toàn bộ query VNPay trả về — xác minh chữ ký, ghi nhận thanh toán (idempotent)' })
  async vnpayReturn(@Query() query: Record<string, string>): Promise<ApiResponse<VnpayResult | null>> {
    const r = await this.payments.handleVnpay(query, 'return');
    return r.result ? ApiResponse.ok(r.result, r.result.message) : ApiResponse.ok(null, r.message);
  }

  @Public() @Get('payments/vnpay/ipn') @ApiOperation({ summary: 'IPN VNPay (server-to-server) — trả {RspCode, Message}' })
  async vnpayIpn(@Query() query: Record<string, string>): Promise<{ RspCode: string; Message: string }> {
    const r = await this.payments.handleVnpay(query, 'ipn');
    return { RspCode: r.rspCode, Message: r.message };
  }
}

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Post('vnpay/retry/:orderCode') @HttpCode(HttpStatus.OK) @RateLimit({ name: 'vnpay-retry', limit: 10, windowSeconds: 600, by: 'user' })
  @ApiOperation({ summary: 'Khách thanh toán lại đơn VNPay (sau khi huỷ/thất bại trên cổng)' })
  async retry(@CurrentActor() actor: AuthenticatedActor, @Param('orderCode') orderCode: string): Promise<ApiResponse<{ paymentUrl: string }>> {
    return ApiResponse.ok(await this.payments.retryVnpay(actor, orderCode.toUpperCase()));
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

  @Post('payments/:id/confirm-transfer') @HttpCode(HttpStatus.OK) @RequirePermission('payment.transfer.confirm') @ApiOperation({ summary: 'Kế toán đối soát: tiền đã về → paid, đơn được xác nhận' })
  async confirm(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ConfirmTransferRequest): Promise<ApiResponse<PaymentResponse>> {
    return ApiResponse.ok(await this.payments.confirmTransfer(actor, id, body), 'Đã xác nhận chuyển khoản');
  }

  @Get('refunds') @RequirePermission('payment.payment.read')
  async refunds(@Query() q: RefundListQuery): Promise<ApiResponse<PageResponse<RefundResponse>>> {
    return ApiResponse.ok(await this.payments.listRefunds(q.page, q.size, q.status));
  }

  @Post('refunds/:id/process') @HttpCode(HttpStatus.OK) @RequirePermission('payment.refund.process') @ApiOperation({ summary: 'Thực hiện hoàn tiền: VNPay API (gateway) hoặc ghi nhận đã chuyển tay (providerRef)' })
  async process(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ProcessRefundRequest): Promise<ApiResponse<RefundResponse>> {
    return ApiResponse.ok(await this.payments.processRefund(actor, id, body), 'Đã hoàn tiền');
  }
}
