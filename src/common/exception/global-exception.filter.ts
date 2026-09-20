import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { isPrismaError, prismaErrorTarget } from '../prisma/errors';
import { ApiError, ApiResponse } from '../response/api-response';
import { RequestTraceContext } from '../request/request-trace.context';
import { BusinessException } from './business.exception';

/*
 * Chuyển MỌI exception thành ApiResponse.failed với mã lỗi ổn định + requestId.
 * - BusinessException: mã của module, status do module chọn.
 * - ValidationPipe (BadRequestException có message[]): COMMON_VALIDATION_ERROR + details theo field.
 * - RateLimitedException (BusinessException) đã mang 429 + mã COMMON_RATE_LIMITED.
 * - HttpException khác của Nest (401 guard, 404 route…): map theo status.
 * - Prisma P2002 (unique violation): COMMON_DUPLICATE 409 — unique index là chốt cuối chống trùng, không lộ SQL.
 * - Prisma P2025 (record not found khi update/delete): COMMON_NOT_FOUND 404.
 * - Còn lại: 500 COMMON_INTERNAL_ERROR, log error kèm stack + requestId; body KHÔNG chứa stack.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const path = req.originalUrl ?? req.url ?? '';
    const requestId = RequestTraceContext.currentRequestId();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'COMMON_INTERNAL_ERROR';
    let message = 'Lỗi hệ thống, vui lòng thử lại sau';
    let details: Record<string, string> = {};

    if (exception instanceof BusinessException) {
      status = exception.httpStatus;
      code = exception.errorCode;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof BadRequestException) {
      status = HttpStatus.BAD_REQUEST;
      code = 'COMMON_VALIDATION_ERROR';
      const body = exception.getResponse();
      const msgs = typeof body === 'object' && body && 'message' in body ? body.message : null;
      if (Array.isArray(msgs)) {
        message = 'Dữ liệu không hợp lệ';
        details = Object.fromEntries(
          (msgs as string[]).map((m, i) => {
            const field = m.split(' ')[0] ?? `field${i}`;
            return [field, m];
          }),
        );
      } else {
        message = typeof msgs === 'string' ? msgs : exception.message;
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = this.codeOfStatus(status);
      message = this.messageOfStatus(status, exception.message);
    } else if (isPrismaError(exception, 'P2002')) {
      status = HttpStatus.CONFLICT;
      code = 'COMMON_DUPLICATE';
      message = 'Dữ liệu đã tồn tại';
      this.logger.warn({ requestId, path, target: prismaErrorTarget(exception) }, 'Vi phạm unique constraint');
    } else if (isPrismaError(exception, 'P2025')) {
      status = HttpStatus.NOT_FOUND;
      code = 'COMMON_NOT_FOUND';
      message = 'Không tìm thấy tài nguyên';
    } else {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error({ requestId, path, err }, `Lỗi không xử lý được: ${err.message}`);
    }

    if (status >= 500 && code !== 'COMMON_INTERNAL_ERROR') {
      this.logger.error({ requestId, path, code }, message);
    } else if (status >= 400 && status < 500 && status !== 404) {
      this.logger.warn({ requestId, path, code, status }, message);
    }

    res.status(status).json(ApiResponse.failed(message, ApiError.of(code, path, details), requestId));
  }

  private codeOfStatus(status: number): string {
    switch (status) {
      case 401:
        return 'COMMON_UNAUTHORIZED';
      case 403:
        return 'COMMON_FORBIDDEN';
      case 404:
        return 'COMMON_NOT_FOUND';
      case 405:
        return 'COMMON_METHOD_NOT_ALLOWED';
      case 413:
        return 'COMMON_PAYLOAD_TOO_LARGE';
      case 415:
        return 'COMMON_UNSUPPORTED_MEDIA_TYPE';
      default:
        return status >= 500 ? 'COMMON_INTERNAL_ERROR' : 'COMMON_BAD_REQUEST';
    }
  }

  private messageOfStatus(status: number, fallback: string): string {
    switch (status) {
      case 401:
        return 'Bạn cần đăng nhập';
      case 403:
        return 'Bạn không có quyền thực hiện thao tác này';
      case 404:
        return 'Không tìm thấy tài nguyên';
      default:
        return fallback;
    }
  }
}
