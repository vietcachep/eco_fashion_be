import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, Public, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { PageQuery } from '@common/utils/pagination';
import { PAYMENT_ERR } from '../foundation/payment.constants';
import { PaymentMethodResponse, PaymentResponse, PaymentService, RefundResponse, VnpayResult } from './payment.service';

class ConfirmTransferRequest {
  @ApiPropertyOptional({ example: 'FT26091512345' }) @IsOptional() @IsString() @MaxLength(120) bankRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class ProcessRefundRequest {
  @ApiPropertyOptional({ description: 'Mã tham chiếu chuyển khoản (bắt buộc khi hoàn tay). Với refund VNPay `failed` chưa rõ kết quả (needsReconcile): mã giao dịch hoàn trên cổng — ghi sổ, KHÔNG gọi cổng.' }) @IsOptional() @IsString() @MaxLength(120) providerRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ description: 'Chỉ dùng cho refund VNPay `failed` chưa rõ kết quả (needsReconcile): đã đối chiếu trên cổng và xác nhận CHƯA hoàn ⇒ cho phép gọi lại cổng.' }) @IsOptional() @IsBoolean() confirmGatewayNotRefunded?: boolean;
}
class SetMethodActiveRequest {
  @ApiProperty() @IsBoolean() isActive: boolean;
}
class PaymentListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsIn(['pending', 'processing', 'paid', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['cod', 'bank_transfer', 'vnpay', 'payos']) methodCode?: string;
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

  @Public() @Get('payment-methods') @ApiOperation({ summary: 'Phương thức thanh toán đang bật (cod · bank_transfer · vnpay · payos — payos chỉ hiện khi có khoá)' })
  async methods(): Promise<ApiResponse<PaymentMethodResponse[]>> {
    return ApiResponse.ok(await this.payments.listMethods(true));
  }

  @Public() @RateLimit({ name: 'vnpay-return', limit: 30, windowSeconds: 600, by: 'ip' }) @Get('payments/vnpay/return')
  @ApiOperation({ summary: 'FE trang kết quả gọi với toàn bộ query VNPay trả về — xác minh chữ ký, ghi nhận thanh toán (idempotent)' })
  async vnpayReturn(@Query() query: Record<string, string>): Promise<ApiResponse<VnpayResult>> {
    const r = await this.payments.handleVnpay(query, 'return');
    if (r.result) return ApiResponse.ok(r.result, r.result.message);
    // Không có kết quả = chữ ký sai (97) hoặc không có giao dịch (01): trả LỖI HTTP thật — trước đây trả 200 success:true data:null nên FE dễ hiểu nhầm là đã thanh toán.
    if (r.rspCode === '97') throw new BusinessException(PAYMENT_ERR.INVALID_SIGNATURE, 'Chữ ký VNPay không hợp lệ');
    throw new NotFoundException(PAYMENT_ERR.NOT_FOUND, 'Không tìm thấy giao dịch thanh toán');
  }

  @Public() @Get('payments/vnpay/ipn') @ApiOperation({ summary: 'IPN VNPay (server-to-server) — trả {RspCode, Message}' })
  async vnpayIpn(@Query() query: Record<string, string>): Promise<{ RspCode: string; Message: string }> {
    const r = await this.payments.handleVnpay(query, 'ipn');
    return { RspCode: r.rspCode, Message: r.message };
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

  @Post('refunds/:id/process') @HttpCode(HttpStatus.OK) @RequirePermission('payment.refund.process') @ApiOperation({ summary: 'Thực hiện hoàn tiền: VNPay API (gateway) hoặc ghi nhận đã chuyển tay (providerRef). Refund `processing` quá 10 phút chưa có providerRef được chiếm lại; đã có providerRef chỉ ghi sổ (không gọi cổng).' })
  async process(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ProcessRefundRequest): Promise<ApiResponse<RefundResponse>> {
    return ApiResponse.ok(await this.payments.processRefund(actor, id, body), 'Đã hoàn tiền');
  }

  @Post('refunds/:id/retry-finalize') @HttpCode(HttpStatus.OK) @RequirePermission('payment.refund.process') @ApiOperation({ summary: 'Hoàn tất GHI SỔ cho refund mà cổng ĐÃ chi (processing + providerRef) nhưng ghi sổ lỗi. KHÔNG gọi cổng; idempotent (chỉ ghi sổ một lần).' })
  async retryFinalize(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<RefundResponse>> {
    return ApiResponse.ok(await this.payments.retryFinalizeRefund(actor, id), 'Đã hoàn tất ghi sổ hoàn tiền');
  }
}
