import { CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, UnauthorizedException } from '../exception/business.exception';
import { PERMISSIONS_KEY, RequestWithActor } from './decorators';
import {
  PERMISSION_AUTHORIZATION_GATEWAY,
  PermissionAuthorizationGateway,
} from './permission-authorization.gateway';

/*
 * Guard phân quyền (APP_GUARD, chạy SAU JwtAuthGuard): route có @RequirePermission thì user phải có
 * TẤT CẢ mã quyền yêu cầu trong tập quyền hiệu lực (identity tính: vai ∪ cấp riêng − chặn riêng, cache Redis).
 * Thiếu → 403 COMMON_FORBIDDEN kèm details.required để FE hiện "cần quyền X".
 * Chưa tiêm gateway (test/skeleton) → từ chối mọi route có yêu cầu quyền, không cho qua âm thầm.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(PERMISSION_AUTHORIZATION_GATEWAY)
    private readonly gateway?: PermissionAuthorizationGateway,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const req = ctx.switchToHttp().getRequest<RequestWithActor>();
    const actor = req.actor;
    if (!actor) throw new UnauthorizedException('COMMON_UNAUTHORIZED', 'Bạn cần đăng nhập');
    if (!this.gateway) {
      this.logger.error('PermissionAuthorizationGateway chưa được tiêm — từ chối route có yêu cầu quyền');
      throw new ForbiddenException('COMMON_FORBIDDEN', 'Hệ thống phân quyền chưa sẵn sàng');
    }
    const owned = await this.gateway.effectivePermissions(actor.userId);
    const missing = required.filter((c) => !owned.has(c));
    if (missing.length > 0) {
      this.logger.warn({ userId: actor.userId, missing }, 'Thiếu quyền');
      throw new ForbiddenException('COMMON_FORBIDDEN', `Bạn thiếu quyền: ${missing.join(', ')}`, {
        required: missing.join(','),
      });
    }
    actor.permissions = owned;
    return true;
  }
}
