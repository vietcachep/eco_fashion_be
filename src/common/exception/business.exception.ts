import { HttpStatus } from '@nestjs/common';

/*
 * Exception nghiệp vụ chung cho mọi module khi cần trả MÃ LỖI ỔN ĐỊNH ra REST API.
 * Module chủ quản tự đặt errorCode (`<MODULE>_<LY_DO>`), common chỉ chuẩn hoá cách chuyển thành ApiResponse.
 * Mặc định 400; các lớp con bên dưới cố định status cho ba tình huống hay gặp nhất.
 */
export class BusinessException extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly httpStatus: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'BusinessException';
  }
}

export class NotFoundException extends BusinessException {
  constructor(errorCode: string, message: string, details?: Record<string, string>) {
    super(errorCode, message, HttpStatus.NOT_FOUND, details);
  }
}

export class ConflictException extends BusinessException {
  constructor(errorCode: string, message: string, details?: Record<string, string>) {
    super(errorCode, message, HttpStatus.CONFLICT, details);
  }
}

export class ForbiddenException extends BusinessException {
  constructor(errorCode: string, message: string, details?: Record<string, string>) {
    super(errorCode, message, HttpStatus.FORBIDDEN, details);
  }
}

export class UnauthorizedException extends BusinessException {
  constructor(errorCode: string, message: string, details?: Record<string, string>) {
    super(errorCode, message, HttpStatus.UNAUTHORIZED, details);
  }
}

export class ServiceUnavailableException extends BusinessException {
  constructor(errorCode: string, message: string, details?: Record<string, string>) {
    super(errorCode, message, HttpStatus.SERVICE_UNAVAILABLE, details);
  }
}
