import { Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import Redis from 'ioredis';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes, randomInt } from 'node:crypto';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { BusinessException, ConflictException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@common/exception/business.exception';
import { MailService } from '@common/mail/mail.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { REDIS } from '@common/redis/redis.module';
import { RequestTraceContext } from '@common/request/request-trace.context';
import { resolveAvatarUrl } from '@common/utils';
import { IdentityAuditLogService } from '../../audit/identity-audit-log.service';
import {
  IDENTITY_AUDIT,
  IDENTITY_ERR,
  IDENTITY_EVENT,
  LOGIN_LOCK_SECONDS,
  LOGIN_MAX_FAILS,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  REDIS_KEY,
} from '../../foundation/identity.constants';
import { LoginHistoryRepository } from '../../loginhistory/repository/login-history.repository';
import { IdentityOutboxService } from '../../outbox/identity-outbox.service';
import { ROLE_CODES } from '../../permission/catalog';
import { PermissionRepository } from '../../permission/repository/permission.repository';
import { USER_STATUS } from '../../user/enums/user-status';
import { UserRepository } from '../../user/repository/user.repository';
import type {
  ChangePasswordCommand,
  ForgotPasswordCommand,
  GoogleLoginCommand,
  LoginCommand,
  LogoutCommand,
  RefreshCommand,
  RegisterCommand,
  RegisterOtpCommand,
  ResetPasswordCommand,
} from '../command/auth.commands';
import { TokenPair, TokenService } from './token.service';

export interface AuthUserBrief {
  id: string;
  email: string;
  fullName: string;
  roleCode: string;
  status: string;
  avatarUrl: string | null;
  phone: string | null;
  createdAt: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  tokenType: 'bearer';
  user: AuthUserBrief;
}

/* Đọc `exp` của access token đang dùng (đã verify ở guard) để blacklist đúng thời gian còn lại. */
export function accessExpOf(req: { headers: { authorization?: string } }): number | undefined {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return payload.exp;
  } catch {
    return undefined;
  }
}

const ARGON2_OPTS: argon2.HashOptions & { raw?: false } = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

/*
 * Use case xác thực (PLAN-0002): đăng ký khách, đăng nhập, refresh, đăng xuất, đổi mật khẩu, quên/đặt lại
 * mật khẩu bằng OTP email.
 * - Transaction: register (user + audit + outbox), login (last_login + login_history + refresh token),
 *   change/reset password (hash mới + thu hồi mọi refresh + bump pv + audit).
 * - Chống dò mật khẩu: Redis `login-fail:<email>:<ip>` ≥ 5 → khoá 15' (không đụng DB); unique email là chốt cuối
 *   khi hai đăng ký song song (P2002 → 409 qua filter).
 * - OTP 6 số Redis TTL 10', tối đa 5 lần thử; quên mật khẩu luôn trả 200 để không lộ email có tồn tại.
 * - Không log mật khẩu/token/OTP. Email đi qua MailService.enqueue (BullMQ) — không chờ SMTP trong request.
 * - Outbox: USER_REGISTERED (worker gửi mail chào mừng, module khác nếu cần).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private googleClient: OAuth2Client | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserRepository,
    private readonly permissions: PermissionRepository,
    private readonly loginHistory: LoginHistoryRepository,
    private readonly tokens: TokenService,
    private readonly audit: IdentityAuditLogService,
    private readonly outbox: IdentityOutboxService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  static hashPassword(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTS);
  }

  static verifyPassword(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password).catch(() => false);
  }

  async sendRegisterOtp(cmd: RegisterOtpCommand): Promise<void> {
    const email = cmd.email.trim().toLowerCase();
    if (await this.users.emailExists(email)) {
      throw new ConflictException(IDENTITY_ERR.EMAIL_EXISTS, 'Email đã được đăng ký tài khoản');
    }
    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis.set(REDIS_KEY.otp('register', email), otp, 'EX', OTP_TTL_SECONDS);
    await this.redis.del(REDIS_KEY.otpAttempts('register', email)).catch(() => undefined);
    await this.mail.enqueue({
      to: email,
      subject: `${this.env.EF_APP_NAME} — Mã xác nhận đăng ký tài khoản`,
      html: `<p>Chào mừng bạn đến với <b>${this.env.EF_APP_NAME}</b>!</p><p>Mã xác nhận OTP đăng ký của bạn là: <b style="font-size:24px;letter-spacing:4px;color:#000;">${otp}</b></p><p>Mã có hiệu lực trong vòng 10 phút. Vui lòng không chia sẻ mã này cho bất kỳ ai.</p>`,
    });
    this.logger.log({ email }, 'Đã gửi OTP đăng ký tài khoản');
  }

  async register(cmd: RegisterCommand): Promise<AuthResult> {
    const email = cmd.email.trim().toLowerCase();
    if (await this.users.emailExists(email)) throw new ConflictException(IDENTITY_ERR.EMAIL_EXISTS, 'Email đã được đăng ký');
    if (cmd.phone && (await this.users.phoneExists(cmd.phone))) throw new ConflictException(IDENTITY_ERR.PHONE_EXISTS, 'Số điện thoại đã được đăng ký');

    const attemptsKey = REDIS_KEY.otpAttempts('register', email);
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) await this.redis.expire(attemptsKey, OTP_TTL_SECONDS);
    if (attempts > OTP_MAX_ATTEMPTS) {
      throw new BusinessException(IDENTITY_ERR.TOO_MANY_ATTEMPTS, 'Nhập sai mã OTP quá nhiều lần, hãy yêu cầu mã mới', 429);
    }
    const savedOtp = await this.redis.get(REDIS_KEY.otp('register', email));
    if (!savedOtp || savedOtp !== cmd.otp) {
      throw new BusinessException(IDENTITY_ERR.OTP_INVALID, 'Mã xác nhận OTP không đúng hoặc đã hết hạn');
    }

    const role = await this.permissions.findRoleByCode(ROLE_CODES.CUSTOMER);
    if (!role) throw new BusinessException(IDENTITY_ERR.ROLE_NOT_FOUND, 'Chưa seed vai khách hàng — chạy perms:sync');
    const passwordHash = await AuthService.hashPassword(cmd.password);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await this.users.create(
        { email, phone: cmd.phone, passwordHash, fullName: cmd.fullName.trim(), roleId: role.id, status: USER_STATUS.ACTIVE },
        tx,
      );
      await this.audit.write(tx, { userId: user.id, email: user.email }, {
        action: IDENTITY_AUDIT.USER_REGISTERED,
        entityType: 'user',
        entityId: user.id,
        entityCode: user.email,
        after: { email: user.email, fullName: user.fullName, role: role.code },
      });
      await this.outbox.publish(tx, {
        eventType: IDENTITY_EVENT.USER_REGISTERED,
        aggregateType: 'user',
        aggregateId: user.id,
        payload: { userId: user.id, email: user.email, fullName: user.fullName },
      });
      const auth = { id: user.id, email: user.email, roleId: role.id, roleCode: role.code, status: user.status, permissionVersion: user.permissionVersion, isDeleted: false };
      const pair = await this.tokens.issuePair(auth, this.tokens.newFamilyId(), tx);
      await this.loginHistory.record(tx, { userId: user.id, email: user.email, success: true, reason: 'REGISTER' });
      return { pair, user };
    });
    await this.redis.del(REDIS_KEY.otp('register', email), attemptsKey).catch(() => undefined);
    this.logger.log({ userId: result.user.id }, 'Khách đăng ký tài khoản mới');
    return this.toResult(result.pair, { ...result.user, roleCode: role.code });
  }

  async login(cmd: LoginCommand): Promise<AuthResult> {
    const email = cmd.email.trim().toLowerCase();
    const ip = RequestTraceContext.current()?.ip ?? '';
    const failKey = REDIS_KEY.loginFail(email, ip);
    const fails = await this.redis.get(failKey).catch(() => null);
    if (fails && Number(fails) >= LOGIN_MAX_FAILS) {
      await this.loginHistory.record(null, { userId: null, email, success: false, reason: 'THROTTLED' });
      throw new BusinessException(IDENTITY_ERR.TOO_MANY_ATTEMPTS, 'Đăng nhập sai nhiều lần, vui lòng thử lại sau 15 phút', 429);
    }
    const user = await this.users.findForLogin(email);
    const ok = user ? await AuthService.verifyPassword(user.passwordHash, cmd.password) : false;
    if (!user || !ok) {
      await this.countFail(failKey);
      await this.loginHistory.record(null, { userId: user?.id ?? null, email, success: false, reason: 'INVALID_CREDENTIALS' });
      this.logger.warn({ email, ip }, 'Đăng nhập sai thông tin');
      throw new UnauthorizedException(IDENTITY_ERR.INVALID_CREDENTIALS, 'Email hoặc mật khẩu không đúng');
    }
    if (user.status !== USER_STATUS.ACTIVE) {
      await this.loginHistory.record(null, { userId: user.id, email, success: false, reason: 'USER_' + user.status.toUpperCase() });
      throw new ForbiddenException(IDENTITY_ERR.USER_LOCKED, user.lockedReason ? `Tài khoản bị khoá: ${user.lockedReason}` : 'Tài khoản không hoạt động');
    }
    await this.redis.del(failKey).catch(() => undefined);
    const auth = { id: user.id, email: user.email, roleId: user.roleId, roleCode: user.role.code, status: user.status, permissionVersion: user.permissionVersion, isDeleted: false };
    const { pair, profile } = await this.prisma.$transaction(async (tx) => {
      const profile = await this.users.update(user.id, { lastLoginAt: new Date() }, tx);
      const pair = await this.tokens.issuePair(auth, this.tokens.newFamilyId(), tx);
      await this.loginHistory.record(tx, { userId: user.id, email: user.email, success: true, reason: cmd.deviceName ?? null });
      return { pair, profile };
    });
    return this.toResult(pair, { ...profile, roleCode: user.role.code });
  }

  /*
   * Đăng nhập Google (web bán hàng): FE lấy id_token từ Google Identity Services rồi gửi lên; BE xác minh chữ ký +
   * audience = EF_GOOGLE_CLIENT_ID. Tìm theo google_sub → theo email (liên kết tài khoản có sẵn) → tạo khách mới
   * (mật khẩu ngẫu nhiên không dùng được; muốn đăng nhập mật khẩu thì "quên mật khẩu"). Không nhận access token Google.
   */
  async loginWithGoogle(cmd: GoogleLoginCommand): Promise<AuthResult> {
    if (!this.env.EF_GOOGLE_CLIENT_ID) throw new ServiceUnavailableException(IDENTITY_ERR.GOOGLE_NOT_CONFIGURED, 'Đăng nhập Google chưa được cấu hình');
    this.googleClient ??= new OAuth2Client(this.env.EF_GOOGLE_CLIENT_ID);
    let payload: { sub: string; email: string; name: string; picture: string | null };
    try {
      const ticket = await this.googleClient.verifyIdToken({ idToken: cmd.idToken, audience: this.env.EF_GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      if (!p?.sub || !p.email || !p.email_verified) throw new Error('payload thiếu sub/email hoặc email chưa xác minh');
      payload = { sub: p.sub, email: p.email.toLowerCase(), name: p.name?.trim() || p.email.split('@')[0], picture: p.picture ?? null };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'Google id_token không hợp lệ');
      throw new UnauthorizedException(IDENTITY_ERR.GOOGLE_TOKEN_INVALID, 'Không xác minh được tài khoản Google');
    }

    let user = await this.users.findByGoogleSub(payload.sub);
    let created = false;
    let linked = false;
    if (!user) {
      const byEmail = await this.users.findForLogin(payload.email);
      if (byEmail) {
        linked = true;
        user = await this.users.findProfile(byEmail.id);
      }
    }
    if (user && user.status !== USER_STATUS.ACTIVE) {
      await this.loginHistory.record(null, { userId: user.id, email: user.email, success: false, reason: 'USER_' + user.status.toUpperCase() });
      throw new ForbiddenException(IDENTITY_ERR.USER_LOCKED, user.lockedReason ? `Tài khoản bị khoá: ${user.lockedReason}` : 'Tài khoản không hoạt động');
    }
    const role = await this.permissions.findRoleByCode(ROLE_CODES.CUSTOMER);
    if (!role) throw new BusinessException(IDENTITY_ERR.ROLE_NOT_FOUND, 'Chưa seed vai khách hàng — chạy perms:sync');

    const result = await this.prisma.$transaction(async (tx) => {
      let profile = user;
      if (!profile) {
        created = true;
        const passwordHash = await AuthService.hashPassword(randomBytes(32).toString('base64url'));
        profile = await this.users.create(
          { email: payload.email, fullName: payload.name, passwordHash, roleId: role.id, status: USER_STATUS.ACTIVE, googleSub: payload.sub, avatarUrl: payload.picture, emailVerifiedAt: new Date() },
          tx,
        );
        await this.audit.write(tx, { userId: profile.id, email: profile.email }, { action: IDENTITY_AUDIT.USER_REGISTERED, entityType: 'user', entityId: profile.id, entityCode: profile.email, after: { email: profile.email, fullName: profile.fullName, role: role.code, provider: 'google' } });
        await this.outbox.publish(tx, { eventType: IDENTITY_EVENT.USER_REGISTERED, aggregateType: 'user', aggregateId: profile.id, payload: { userId: profile.id, email: profile.email, fullName: profile.fullName } });
      } else {
        profile = await this.users.update(profile.id, { lastLoginAt: new Date(), ...(linked ? { googleSub: payload.sub, emailVerifiedAt: profile.emailVerifiedAt ?? new Date() } : {}) }, tx);
        if (linked) await this.audit.write(tx, { userId: profile.id, email: profile.email }, { action: IDENTITY_AUDIT.USER_GOOGLE_LINKED, entityType: 'user', entityId: profile.id, entityCode: profile.email });
      }
      const auth = { id: profile.id, email: profile.email, roleId: role.id, roleCode: profile.role.code, status: profile.status, permissionVersion: profile.permissionVersion, isDeleted: false };
      const pair = await this.tokens.issuePair(auth, this.tokens.newFamilyId(), tx);
      await this.loginHistory.record(tx, { userId: profile.id, email: profile.email, success: true, reason: created ? 'GOOGLE_REGISTER' : 'GOOGLE' });
      return { pair, profile };
    });
    if (created) this.logger.log({ userId: result.profile.id }, 'Khách đăng ký qua Google');
    return this.toResult(result.pair, { ...result.profile, roleCode: result.profile.role.code });
  }

  async refresh(cmd: RefreshCommand): Promise<AuthResult> {
    const { pair, user } = await this.tokens.rotate(cmd.refreshToken);
    const profile = await this.users.findProfile(user.id);
    if (!profile) throw new UnauthorizedException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    return this.toResult(pair, { ...profile, roleCode: user.roleCode });
  }

  async logout(cmd: LogoutCommand): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (cmd.refreshToken) await this.tokens.revokeByRaw(cmd.refreshToken, 'LOGOUT', tx);
      await this.audit.write(tx, cmd.actor, { action: IDENTITY_AUDIT.LOGOUT, entityType: 'user', entityId: cmd.actor.userId, entityCode: cmd.actor.email });
    });
    await this.tokens.blacklistAccess(cmd.actor.tokenId, cmd.accessExp);
  }

  async changePassword(cmd: ChangePasswordCommand): Promise<void> {
    const hash = await this.users.passwordHashOf(cmd.actor.userId);
    if (!hash || !(await AuthService.verifyPassword(hash, cmd.currentPassword))) {
      throw new BusinessException(IDENTITY_ERR.PASSWORD_MISMATCH, 'Mật khẩu hiện tại không đúng');
    }
    const newHash = await AuthService.hashPassword(cmd.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await this.users.update(cmd.actor.userId, { passwordHash: newHash, permissionVersion: { increment: 1 }, updatedBy: cmd.actor.userId }, tx);
      const revoked = await this.tokens.revokeAllOfUser(cmd.actor.userId, 'PASSWORD_CHANGED', tx);
      await this.audit.write(tx, cmd.actor, {
        action: IDENTITY_AUDIT.PASSWORD_CHANGED,
        entityType: 'user',
        entityId: cmd.actor.userId,
        entityCode: cmd.actor.email,
        after: { revokedSessions: revoked },
      });
    });
    await this.tokens.blacklistAccess(cmd.actor.tokenId, cmd.accessExp);
    await this.tokens.invalidateUserAuth(cmd.actor.userId);
  }

  /* Luôn 200 (không lộ email tồn tại). OTP 6 số, Redis TTL 10'. */
  async forgotPassword(cmd: ForgotPasswordCommand): Promise<void> {
    const email = cmd.email.trim().toLowerCase();
    const user = await this.users.findForLogin(email);
    if (!user || user.status !== USER_STATUS.ACTIVE) return;
    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis.set(REDIS_KEY.otp('reset', email), otp, 'EX', OTP_TTL_SECONDS);
    await this.redis.del(REDIS_KEY.otpAttempts('reset', email)).catch(() => undefined);
    await this.mail.enqueue({
      to: email,
      subject: `${this.env.EF_APP_NAME} — Mã đặt lại mật khẩu`,
      html: `<p>Mã xác nhận đặt lại mật khẩu của bạn là <b style="font-size:20px">${otp}</b>. Mã có hiệu lực 10 phút.</p><p>Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>`,
    });
    this.logger.log({ userId: user.id }, 'Đã gửi OTP đặt lại mật khẩu');
  }

  async resetPassword(cmd: ResetPasswordCommand): Promise<void> {
    const email = cmd.email.trim().toLowerCase();
    const attemptsKey = REDIS_KEY.otpAttempts('reset', email);
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) await this.redis.expire(attemptsKey, OTP_TTL_SECONDS);
    if (attempts > OTP_MAX_ATTEMPTS) throw new BusinessException(IDENTITY_ERR.TOO_MANY_ATTEMPTS, 'Nhập sai mã quá nhiều lần, hãy yêu cầu mã mới', 429);
    const otp = await this.redis.get(REDIS_KEY.otp('reset', email));
    if (!otp || otp !== cmd.otp) throw new BusinessException(IDENTITY_ERR.OTP_INVALID, 'Mã xác nhận không đúng hoặc đã hết hạn');
    const user = await this.users.findForLogin(email);
    if (!user) throw new BusinessException(IDENTITY_ERR.OTP_INVALID, 'Mã xác nhận không đúng hoặc đã hết hạn');
    const newHash = await AuthService.hashPassword(cmd.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await this.users.update(user.id, { passwordHash: newHash, permissionVersion: { increment: 1 } }, tx);
      const revoked = await this.tokens.revokeAllOfUser(user.id, 'PASSWORD_RESET', tx);
      await this.audit.write(tx, { userId: user.id, email: user.email }, {
        action: IDENTITY_AUDIT.PASSWORD_RESET,
        entityType: 'user',
        entityId: user.id,
        entityCode: user.email,
        after: { revokedSessions: revoked },
      });
    });
    await this.redis.del(REDIS_KEY.otp('reset', email), attemptsKey).catch(() => undefined);
    await this.tokens.invalidateUserAuth(user.id);
  }

  private async countFail(key: string): Promise<void> {
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, LOGIN_LOCK_SECONDS);
    } catch (err) {
      this.logger.warn({ err }, 'Redis lỗi khi đếm đăng nhập sai — bỏ qua (chỉ mất chống dò tạm thời)');
    }
  }

  private toResult(pair: TokenPair, user: { id: string; email: string; fullName: string; roleCode: string; status: string; avatarUrl: string | null; phone: string | null; createdAt: Date }): AuthResult {
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessExpiresIn: pair.accessExpiresIn,
      tokenType: 'bearer',
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        roleCode: user.roleCode,
        status: user.status,
        avatarUrl: resolveAvatarUrl(user.avatarUrl, user.fullName || user.email),
        phone: user.phone,
        createdAt: user.createdAt.toISOString(),
      },
    };
  }
}
