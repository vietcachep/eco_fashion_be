import { CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { UnauthorizedException } from '../exception/business.exception';
import { actorFromPayload, JwtPayload } from './authenticated-actor';
import { IS_PUBLIC_KEY, OPTIONAL_AUTH_KEY, RequestWithActor } from './decorators';
import { TOKEN_VALIDATION_GATEWAY, TokenValidationGateway } from './permission-authorization.gateway';

/*
 * Guard xác thực TOÀN CỤC (APP_GUARD): mọi route mặc định cần Bearer access token hợp lệ, trừ @Public.
 * Sau khi verify chữ ký + hạn, hỏi TokenValidationGateway (identity cài): jti bị thu hồi? user bị khoá?
 * permission_version cũ? — nên logout/khoá tài khoản/đổi quyền có hiệu lực NGAY, không đợi token hết hạn.
 * @OptionalAuth: token sai/thiếu thì bỏ qua (actor undefined), không chặn — cho route vừa khách vừa user.
 * Không log token. Lỗi trả 401 với mã COMMON_UNAUTHORIZED hoặc IDENTITY_TOKEN_* để FE biết cần refresh.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(TOKEN_VALIDATION_GATEWAY) private readonly tokenValidation?: TokenValidationGateway,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const optional = this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest<RequestWithActor>();
    const token = this.bearer(req.headers.authorization);

    if (isPublic && !token) return true;
    if (!token) {
      if (optional) return true;
      throw new UnauthorizedException('COMMON_UNAUTHORIZED', 'Bạn cần đăng nhập');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, { secret: this.env.EF_JWT_SECRET });
    } catch (err) {
      if (optional || isPublic) return true;
      const expired = err instanceof Error && err.name === 'TokenExpiredError';
      throw new UnauthorizedException(
        expired ? 'IDENTITY_TOKEN_EXPIRED' : 'IDENTITY_TOKEN_INVALID',
        expired ? 'Phiên đăng nhập đã hết hạn' : 'Token không hợp lệ',
      );
    }

    const actor = actorFromPayload(payload);
    if (this.tokenValidation) {
      const kq = await this.tokenValidation.validate(actor);
      if (!kq.ok) {
        if (optional || isPublic) return true;
        this.logger.warn({ userId: actor.userId, reason: kq.reason }, 'Token bị từ chối sau khi verify');
        throw new UnauthorizedException(`IDENTITY_TOKEN_${kq.reason}`, 'Phiên đăng nhập không còn hiệu lực');
      }
    }
    req.actor = actor;
    return true;
  }

  private bearer(header?: string): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
  }
}
