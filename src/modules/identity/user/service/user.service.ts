import { Injectable, Logger } from '@nestjs/common';
import { ConflictException, ForbiddenException, NotFoundException } from '@common/exception/business.exception';
import { PageResponse } from '@common/response/api-response';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { StorageService } from '@common/storage/storage.service';
import { IdentityAuditLogService } from '../../audit/identity-audit-log.service';
import { AuthService } from '../../auth/service/auth.service';
import { TokenService } from '../../auth/service/token.service';
import { IDENTITY_AUDIT, IDENTITY_ERR, IDENTITY_EVENT } from '../../foundation/identity.constants';
import { IdentityOutboxService } from '../../outbox/identity-outbox.service';
import { STAFF_ROLE_CODES } from '../../permission/catalog';
import { PermissionRepository } from '../../permission/repository/permission.repository';
import { PermissionService } from '../../permission/service/permission.service';
import { UserProfileResponse } from '../dto/user.responses';
import { USER_STATUS } from '../enums/user-status';
import { toUserProfile } from '../mapper/user.mapper';
import { UserRepository } from '../repository/user.repository';

/*
 * Use case hồ sơ của CHÍNH user (me) và quản trị nhân viên (admin) — mọi hàm ghi đều: transaction + audit;
 * đổi vai/khoá/đặt lại mật khẩu còn bump permission_version + thu hồi refresh token + xoá cache auth/quyền
 * để có hiệu lực NGAY trên mọi thiết bị.
 * - Không cho admin tự khoá / tự hạ vai chính mình (tự khoá cửa).
 * - Chỉ tạo nhân viên với vai nhân viên; khách tự đăng ký qua /auth/register.
 * - Outbox: USER_LOCKED (module khác nếu cần, mail thông báo).
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserRepository,
    private readonly roles: PermissionRepository,
    private readonly permissions: PermissionService,
    private readonly tokens: TokenService,
    private readonly audit: IdentityAuditLogService,
    private readonly outbox: IdentityOutboxService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------- me

  async myProfile(actor: AuthenticatedActor): Promise<UserProfileResponse> {
    const u = await this.users.findProfile(actor.userId);
    if (!u) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    return toUserProfile(u);
  }

  async updateMyProfile(actor: AuthenticatedActor, patch: { fullName?: string; phone?: string | null }): Promise<UserProfileResponse> {
    const before = await this.users.findProfile(actor.userId);
    if (!before) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    if (patch.phone && patch.phone !== before.phone && (await this.users.phoneExists(patch.phone, actor.userId))) {
      throw new ConflictException(IDENTITY_ERR.PHONE_EXISTS, 'Số điện thoại đã được dùng');
    }
    const data = { ...(patch.fullName !== undefined ? { fullName: patch.fullName.trim() } : {}), ...(patch.phone !== undefined ? { phone: patch.phone } : {}), updatedBy: actor.userId };
    if (Object.keys(data).length === 1) return toUserProfile(before);
    const after = await this.prisma.$transaction(async (tx) => {
      const u = await this.users.update(actor.userId, data, tx);
      await this.audit.write(tx, actor, {
        action: IDENTITY_AUDIT.PROFILE_UPDATED,
        entityType: 'user',
        entityId: actor.userId,
        entityCode: actor.email,
        before: { fullName: before.fullName, phone: before.phone },
        after: { fullName: u.fullName, phone: u.phone },
      });
      return u;
    });
    return toUserProfile(after);
  }

  async updateMyAvatar(actor: AuthenticatedActor, file: { buffer: Buffer; mimetype: string; size: number }): Promise<UserProfileResponse> {
    const uploaded = await this.storage.uploadImage(file, 'avatars'); // gọi mạng NGOÀI transaction
    const after = await this.prisma.$transaction(async (tx) => {
      const u = await this.users.update(actor.userId, { avatarUrl: uploaded.url, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: IDENTITY_AUDIT.AVATAR_UPDATED, entityType: 'user', entityId: actor.userId, entityCode: actor.email, after: { avatarUrl: uploaded.url } });
      return u;
    });
    return toUserProfile(after);
  }

  async deleteMyAvatar(actor: AuthenticatedActor): Promise<UserProfileResponse> {
    const before = await this.users.findProfile(actor.userId);
    if (!before) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    const after = await this.prisma.$transaction(async (tx) => {
      const u = await this.users.update(actor.userId, { avatarUrl: null, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, {
        action: IDENTITY_AUDIT.AVATAR_UPDATED,
        entityType: 'user',
        entityId: actor.userId,
        entityCode: actor.email,
        before: { avatarUrl: before.avatarUrl },
        after: { avatarUrl: null },
      });
      return u;
    });
    return toUserProfile(after);
  }

  // ---------------------------------------------------------------- admin

  async list(params: { page: number; size: number; q?: string; roleCode?: string; status?: string; staffOnly?: boolean }): Promise<PageResponse<UserProfileResponse>> {
    const { items, total } = await this.users.list({ skip: (params.page - 1) * params.size, take: params.size, ...params });
    return PageResponse.of(items.map(toUserProfile), params.page, params.size, total);
  }

  async get(userId: string): Promise<UserProfileResponse> {
    const u = await this.users.findProfile(userId);
    if (!u) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    return toUserProfile(u);
  }

  async createStaff(actor: AuthenticatedActor, input: { email: string; fullName: string; roleCode: string; password: string; phone: string | null }): Promise<UserProfileResponse> {
    if (!STAFF_ROLE_CODES.includes(input.roleCode as never)) throw new ForbiddenException(IDENTITY_ERR.ROLE_NOT_STAFF, 'Chỉ tạo tài khoản với vai nhân viên');
    const role = await this.roles.findRoleByCode(input.roleCode);
    if (!role) throw new NotFoundException(IDENTITY_ERR.ROLE_NOT_FOUND, `Không có vai '${input.roleCode}'`);
    if (await this.users.emailExists(input.email)) throw new ConflictException(IDENTITY_ERR.EMAIL_EXISTS, 'Email đã được dùng');
    if (input.phone && (await this.users.phoneExists(input.phone))) throw new ConflictException(IDENTITY_ERR.PHONE_EXISTS, 'Số điện thoại đã được dùng');
    const passwordHash = await AuthService.hashPassword(input.password);
    const u = await this.prisma.$transaction(async (tx) => {
      const created = await this.users.create(
        { email: input.email, fullName: input.fullName.trim(), phone: input.phone, passwordHash, roleId: role.id, status: USER_STATUS.ACTIVE, createdBy: actor.userId, updatedBy: actor.userId },
        tx,
      );
      await this.audit.write(tx, actor, { action: IDENTITY_AUDIT.USER_CREATED, entityType: 'user', entityId: created.id, entityCode: created.email, after: { email: created.email, role: role.code, fullName: created.fullName } });
      return created;
    });
    this.logger.log({ userId: u.id, role: role.code, by: actor.userId }, 'Tạo tài khoản nhân viên');
    return toUserProfile(u);
  }

  async updateByAdmin(actor: AuthenticatedActor, userId: string, patch: { fullName?: string; phone?: string | null; roleCode?: string }): Promise<UserProfileResponse> {
    const before = await this.users.findProfile(userId);
    if (!before) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    if (patch.roleCode && userId === actor.userId) throw new ForbiddenException(IDENTITY_ERR.CANNOT_MODIFY_SELF, 'Không thể tự đổi vai của chính mình');
    if (patch.phone && patch.phone !== before.phone && (await this.users.phoneExists(patch.phone, userId))) throw new ConflictException(IDENTITY_ERR.PHONE_EXISTS, 'Số điện thoại đã được dùng');
    let roleId: string | undefined;
    if (patch.roleCode && patch.roleCode !== before.role.code) {
      if (before.role.code === 'customer') throw new ForbiddenException(IDENTITY_ERR.ROLE_NOT_STAFF, 'Không đổi khách hàng thành nhân viên — tạo tài khoản nhân viên riêng');
      const role = await this.roles.findRoleByCode(patch.roleCode);
      if (!role) throw new NotFoundException(IDENTITY_ERR.ROLE_NOT_FOUND, `Không có vai '${patch.roleCode}'`);
      roleId = role.id;
    }
    const after = await this.prisma.$transaction(async (tx) => {
      const u = await this.users.update(
        userId,
        {
          ...(patch.fullName !== undefined ? { fullName: patch.fullName.trim() } : {}),
          ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
          ...(roleId ? { roleId, permissionVersion: { increment: 1 } } : {}),
          updatedBy: actor.userId,
        },
        tx,
      );
      await this.audit.write(tx, actor, {
        action: roleId ? IDENTITY_AUDIT.USER_ROLE_CHANGED : IDENTITY_AUDIT.USER_UPDATED,
        entityType: 'user',
        entityId: userId,
        entityCode: before.email,
        before: { fullName: before.fullName, phone: before.phone, role: before.role.code },
        after: { fullName: u.fullName, phone: u.phone, role: u.role.code },
      });
      return u;
    });
    if (roleId) {
      await this.tokens.invalidateUserAuth(userId);
      await this.permissions.invalidateUser(userId);
    }
    return toUserProfile(after);
  }

  async setStatus(actor: AuthenticatedActor, userId: string, status: 'active' | 'locked', reason: string | null): Promise<UserProfileResponse> {
    if (userId === actor.userId) throw new ForbiddenException(IDENTITY_ERR.CANNOT_MODIFY_SELF, 'Không thể tự khoá tài khoản của chính mình');
    const before = await this.users.findProfile(userId);
    if (!before) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    if (before.status === status) return toUserProfile(before); // no-op
    const locking = status === USER_STATUS.LOCKED;
    const after = await this.prisma.$transaction(async (tx) => {
      const u = await this.users.update(userId, { status, lockedReason: locking ? reason : null, permissionVersion: { increment: 1 }, updatedBy: actor.userId }, tx);
      if (locking) await this.tokens.revokeAllOfUser(userId, 'USER_LOCKED', tx);
      await this.audit.write(tx, actor, {
        action: locking ? IDENTITY_AUDIT.USER_LOCKED : IDENTITY_AUDIT.USER_UNLOCKED,
        entityType: 'user',
        entityId: userId,
        entityCode: before.email,
        before: { status: before.status },
        after: { status, reason },
      });
      if (locking) await this.outbox.publish(tx, { eventType: IDENTITY_EVENT.USER_LOCKED, aggregateType: 'user', aggregateId: userId, payload: { userId, email: before.email, reason } });
      return u;
    });
    await this.tokens.invalidateUserAuth(userId);
    await this.permissions.invalidateUser(userId);
    return toUserProfile(after);
  }

  async resetPasswordByAdmin(actor: AuthenticatedActor, userId: string, newPassword: string): Promise<void> {
    const target = await this.users.findProfile(userId);
    if (!target) throw new NotFoundException(IDENTITY_ERR.USER_NOT_FOUND, 'Không tìm thấy người dùng');
    const passwordHash = await AuthService.hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await this.users.update(userId, { passwordHash, permissionVersion: { increment: 1 }, updatedBy: actor.userId }, tx);
      const revoked = await this.tokens.revokeAllOfUser(userId, 'PASSWORD_RESET_BY_ADMIN', tx);
      await this.audit.write(tx, actor, { action: IDENTITY_AUDIT.PASSWORD_RESET_BY_ADMIN, entityType: 'user', entityId: userId, entityCode: target.email, after: { revokedSessions: revoked } });
    });
    await this.tokens.invalidateUserAuth(userId);
  }
}
