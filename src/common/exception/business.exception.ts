import { HttpStatus } from '@nestjs/common';

/*
 * Exception nghiệp vụ chung cho mọi module khi cần trả MÃ LỖI ỔN ĐỊNH ra REST API.
 * Module chủ quản tự đặt errorCode (`<MODULE>_<LY_DO>`), common chỉ chuẩn hoá cách chuyển thành ApiResponse.
 * Mặc định 400; các lớp con bên dưới cố định status cho ba tình huống hay gặp nhất.
 * `data` (hiếm dùng): payload có cấu trúc đi kèm lỗi, filter đặt vào `ApiResponse.data` — vd 409 ORDER_PRICE_CHANGED mang báo giá mới
 * (`details` chỉ chứa chuỗi nên không chở nổi một đối tượng). Không đặt dữ liệu nhạy cảm vào đây: nó ra thẳng response.
 */
export class BusinessException extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly httpStatus: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details: Record<string, string> = {},
    public readonly data: unknown = null,
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
