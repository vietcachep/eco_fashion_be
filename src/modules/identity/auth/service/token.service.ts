import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { CacheService, CacheSpec } from '@common/cache/cache.service';
import { UnauthorizedException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { REDIS } from '@common/redis/redis.module';
import { RequestTraceContext } from '@common/request/request-trace.context';
import type { JwtPayload } from '@common/security/authenticated-actor';
import { IDENTITY_ERR, REDIS_KEY, USER_AUTH_CACHE_TTL } from '../../foundation/identity.constants';
import { UserAuthRow, UserRepository } from '../../user/repository/user.repository';
import { RefreshTokenRepository } from '../repository/refresh-token.repository';

/* Cache trạng thái xác thực `ef:identity:user-auth:<userId>` — guard đọc mỗi request; đổi user/quyền phải xoá. */
export const USER_AUTH_CACHE: CacheSpec = { module: 'identity', purpose: 'user-auth', ttlSeconds: USER_AUTH_CACHE_TTL };

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  /* id dòng refresh_tokens vừa tạo — dùng nối `replaced_by_id` khi xoay vòng. */
  refreshTokenId: string;
}

/*
 * Phát hành / xoay vòng / thu hồi token (AGENTS.md — Authentication Rule).
 * - Access JWT 15': claims sub, email, role, pv (permission_version), jti. Không lưu DB; thu hồi sớm bằng
 *   blacklist jti trong Redis (TTL = thời gian còn lại của token).
 * - Refresh 256-bit ngẫu nhiên, DB chỉ giữ SHA-256; rotation trong transaction với FOR UPDATE; token đã rotate
 *   mà bị dùng lại → thu hồi CẢ HỌ (family) → 401 REFRESH_REUSED.
 * - Cache Redis `user-auth:<id>` {status, pv, roleCode} TTL 60s để guard không hỏi DB mỗi request; mọi chỗ bump
 *   permission_version / đổi status phải gọi `invalidateUserAuth` (hoặc `invalidateAllUserAuth` khi đổi cả vai),
 *   nếu không token MỚI bị coi là STALE còn token CŨ vẫn qua cho tới khi TTL hết. Redis mất → đọc DB.
 * Không log token thô. Không ghi outbox.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly users: UserRepository,
    private readonly cache: CacheService,
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  static hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  async issuePair(user: UserAuthRow, familyId: string, tx?: Tx | null): Promise<TokenPair> {
    const accessToken = await this.signAccess(user);
    const raw = randomBytes(32).toString('base64url');
    const trace = RequestTraceContext.current();
    const inserted = await this.refreshTokens.insert(
      {
        userId: user.id,
        tokenHash: TokenService.hash(raw),
        familyId,
        deviceName: null,
        ipAddress: trace?.ip || null,
        userAgent: trace?.userAgent || null,
        expiresAt: new Date(Date.now() + this.env.EF_REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
      tx,
    );
    return { accessToken, refreshToken: raw, accessExpiresIn: this.env.EF_ACCESS_TOKEN_TTL_SECONDS, refreshTokenId: inserted.id };
  }

  newFamilyId(): string {
    return randomUUID();
  }

  private signAccess(user: UserAuthRow): Promise<string> {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.roleCode, pv: user.permissionVersion, jti: randomUUID() };
    return this.jwt.signAsync(payload);
  }

  /*
   * Xoay vòng refresh token trong MỘT transaction (khoá dòng): trả cặp mới cùng family. Dùng lại token đã
   * rotate → thu hồi cả họ → 401 REFRESH_REUSED; hết hạn → 401 REFRESH_EXPIRED; không có → 401 REFRESH_INVALID.
   */
  async rotate(rawRefresh: string): Promise<{ pair: TokenPair; user: UserAuthRow }> {
    const hash = TokenService.hash(rawRefresh);
    return this.prisma.$transaction(async (tx) => {
      const row = await this.refreshTokens.findByHashForUpdate(hash, tx);
      if (!row) throw new UnauthorizedException(IDENTITY_ERR.REFRESH_INVALID, 'Phiên đăng nhập không hợp lệ');
      if (row.revokedAt) {
        const n = await this.refreshTokens.revokeFamily(row.familyId, 'REUSE_DETECTED', tx);
        this.logger.warn({ userId: row.userId, familyId: row.familyId, revoked: n }, 'Phát hiện dùng lại refresh token đã xoay — thu hồi cả họ');
        throw new UnauthorizedException(IDENTITY_ERR.REFRESH_REUSED, 'Phiên đăng nhập bị thu hồi vì phát hiện dùng lại token');
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException(IDENTITY_ERR.REFRESH_EXPIRED, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
      }
      const user = await this.users.findAuthById(row.userId, tx);
      if (!user || user.isDeleted || user.status !== 'active') {
        await this.refreshTokens.revokeFamily(row.familyId, 'USER_INACTIVE', tx);
        throw new UnauthorizedException(IDENTITY_ERR.USER_LOCKED, 'Tài khoản không còn hoạt động');
      }
      const pair = await this.issuePair(user, row.familyId, tx);
      await this.refreshTokens.markRotated(row.id, pair.refreshTokenId, tx);
      return { pair, user };
    });
  }

  async revokeByRaw(rawRefresh: string, reason: string, tx?: Tx | null): Promise<void> {
    const row = await this.refreshTokens.findByHash(TokenService.hash(rawRefresh));
    if (row) await this.refreshTokens.revokeFamily(row.familyId, reason, tx);
  }

  async revokeAllOfUser(userId: string, reason: string, tx?: Tx | null): Promise<number> {
    return this.refreshTokens.revokeAllOfUser(userId, reason, tx);
  }

  async blacklistAccess(jti: string, expUnix?: number): Promise<void> {
    const ttl = Math.max(1, (expUnix ?? Math.floor(Date.now() / 1000) + this.env.EF_ACCESS_TOKEN_TTL_SECONDS) - Math.floor(Date.now() / 1000));
    try {
      await this.redis.set(REDIS_KEY.blacklist(jti), '1', 'EX', ttl);
    } catch (err) {
      this.logger.warn({ err }, 'Redis lỗi khi blacklist jti — token sẽ tự hết hạn theo exp');
    }
  }

  async isBlacklisted(jti: string): Promise<boolean> {
    try {
      return (await this.redis.exists(REDIS_KEY.blacklist(jti))) === 1;
    } catch {
      return false;
    }
  }

  /* Trạng thái xác thực của user (status, pv, roleId) — cache 60s; guard + PermissionService gọi mỗi request. */
  async userAuthState(userId: string): Promise<UserAuthRow | null> {
    return this.cache.getOrSet(USER_AUTH_CACHE, userId, () => this.users.findAuthById(userId));
  }

  async invalidateUserAuth(userId: string): Promise<void> {
    await this.cache.del(USER_AUTH_CACHE, userId);
  }

  /* Đổi preset vai → pv của MỌI user vai đó tăng → xoá cả cụm (SCAN theo prefix). */
  async invalidateAllUserAuth(): Promise<void> {
    await this.cache.delByPrefix(USER_AUTH_CACHE);
  }
}
