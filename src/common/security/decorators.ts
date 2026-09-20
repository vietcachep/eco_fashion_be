import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedActor } from './authenticated-actor';

export const IS_PUBLIC_KEY = 'ef:public';
export const OPTIONAL_AUTH_KEY = 'ef:optional-auth';
export const PERMISSIONS_KEY = 'ef:permissions';

/* Route công khai — JwtAuthGuard bỏ qua (danh sách sản phẩm, đăng nhập, IPN VNPay…). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/* Route cho cả khách vãng lai lẫn người đăng nhập: có token hợp lệ thì gắn actor, không có cũng cho qua. */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH_KEY, true);

/*
 * Yêu cầu MÃ QUYỀN (`module.resource.action`) — PermissionGuard kiểm quyền hiệu lực của user
 * (vai ∪ cấp riêng − chặn riêng). Nhiều mã = cần TẤT CẢ. Không kiểm theo tên vai.
 */
export const RequirePermission = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);

export interface RequestWithActor extends Request {
  actor?: AuthenticatedActor;
}

/* Lấy AuthenticatedActor đã được guard gắn vào request. Route @OptionalAuth có thể nhận undefined. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedActor | undefined => {
    const req = ctx.switchToHttp().getRequest<RequestWithActor>();
    return req.actor;
  },
);
