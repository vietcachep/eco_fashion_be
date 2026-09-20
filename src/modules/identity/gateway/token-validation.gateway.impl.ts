import { Injectable } from '@nestjs/common';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { TokenValidationGateway, TokenValidationResult } from '@common/security/permission-authorization.gateway';
import { TokenService } from '../auth/service/token.service';
import { USER_STATUS } from '../user/enums/user-status';

/*
 * Cài TokenValidationGateway cho JwtAuthGuard: sau khi verify chữ ký, kiểm
 * (1) jti bị blacklist (logout/đổi mật khẩu) — Redis, (2) user còn tồn tại/active — cache 60s,
 * (3) permission_version trong token còn khớp DB — admin đổi quyền/vai thì token cũ bị chặn ngay.
 */
@Injectable()
export class TokenValidationGatewayImpl implements TokenValidationGateway {
  constructor(private readonly tokens: TokenService) {}

  async validate(actor: AuthenticatedActor): Promise<TokenValidationResult> {
    if (await this.tokens.isBlacklisted(actor.tokenId)) return { ok: false, reason: 'REVOKED' };
    const state = await this.tokens.userAuthState(actor.userId);
    if (!state || state.isDeleted) return { ok: false, reason: 'USER_NOT_FOUND' };
    if (state.status !== USER_STATUS.ACTIVE) return { ok: false, reason: 'USER_INACTIVE' };
    if (state.permissionVersion !== actor.permissionVersion) return { ok: false, reason: 'PERMISSION_VERSION_STALE' };
    return { ok: true };
  }
}
