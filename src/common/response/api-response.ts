import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RequestTraceContext } from '../request/request-trace.context';

/*
 * Error payload chuẩn nằm trong ApiResponse khi API trả lỗi.
 * Mỗi module tự đặt mã lỗi (`IDENTITY_INVALID_CREDENTIALS`, `ORDER_OUT_OF_STOCK`…) nhưng khuôn chung cố định
 * để frontend/gateway/log tập trung xử lý được.
 */
export class ApiError {
  @ApiProperty({ example: 'IDENTITY_INVALID_CREDENTIALS' })
  code: string;

  @ApiProperty({ example: '/api/v1/auth/login' })
  path: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  details: Record<string, string>;

  static of(code: string, path: string, details?: Record<string, string>): ApiError {
    const e = new ApiError();
    e.code = code;
    e.path = path;
    e.details = details ? { ...details } : {};
    return e;
  }
}

/*
 * Response envelope chuẩn cho TOÀN BỘ REST API (AGENTS.md — common).
 * Chỉ là body JSON; HTTP status do controller/filter quyết định. `requestId` là mã tra log/audit/outbox
 * khi vận hành gặp lỗi — frontend nên hiện mã này trong màn lỗi.
 */
export class ApiResponse<T> {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  message: string;

  @ApiPropertyOptional()
  data: T | null;

  @ApiPropertyOptional({ type: ApiError })
  error: ApiError | null;

  @ApiProperty()
  requestId: string;

  @ApiProperty()
  timestamp: string;

  static ok<T>(data: T, message = 'OK', requestId?: string): ApiResponse<T> {
    const r = new ApiResponse<T>();
    r.success = true;
    r.message = message;
    r.data = data;
    r.error = null;
    r.requestId = requestId ?? RequestTraceContext.currentRequestId();
    r.timestamp = new Date().toISOString();
    return r;
  }

  static failed<T = never>(message: string, error: ApiError, requestId?: string): ApiResponse<T> {
    const r = new ApiResponse<T>();
    r.success = false;
    r.message = message;
    r.data = null;
    r.error = error;
    r.requestId = requestId ?? RequestTraceContext.currentRequestId();
    r.timestamp = new Date().toISOString();
    return r;
  }
}

/*
 * DTO phân trang chuẩn. Không trả cấu trúc nội bộ của TypeORM ra ngoài; contract này là thứ FE bám vào.
 * `page` bắt đầu từ 1.
 */
export class PageResponse<T> {
  @ApiProperty({ isArray: true })
  content: T[];

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  size: number;

  @ApiProperty({ example: 137 })
  totalElements: number;

  @ApiProperty({ example: 7 })
  totalPages: number;

  @ApiProperty()
  first: boolean;

  @ApiProperty()
  last: boolean;

  static of<T>(content: T[], page: number, size: number, totalElements: number): PageResponse<T> {
    const p = new PageResponse<T>();
    const totalPages = size > 0 ? Math.max(1, Math.ceil(totalElements / size)) : 1;
    p.content = content;
    p.page = page;
    p.size = size;
    p.totalElements = totalElements;
    p.totalPages = totalPages;
    p.first = page <= 1;
    p.last = page >= totalPages;
    return p;
  }
}
