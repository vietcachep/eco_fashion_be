import { Injectable, Logger } from '@nestjs/common';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { IdentityAuditLogService } from '../audit/identity-audit-log.service';
import { PASSWORD_MSG, PASSWORD_RULE } from '../auth/request/auth.requests';
import { AuthService } from '../auth/service/auth.service';
import { IDENTITY_AUDIT, IDENTITY_ERR } from '../foundation/identity.constants';
import { ROLE_CODES } from '../permission/catalog';
import { PermissionRepository } from '../permission/repository/permission.repository';
import { USER_STATUS } from '../user/enums/user-status';
import { UserRepository } from '../user/repository/user.repository';

export interface NewCustomerAccount {
  email: string;
  fullName: string;
  passwordHash: string;
}

/*
 * Cổng GHI công khai của identity cho module khác (queryapi chỉ ĐỌC). Hiện chỉ có một việc: module shop để CHỦ SHOP tạo tài khoản cho
 * nhân viên của mình — tài khoản là KHÁCH THƯỜNG (vai `customer`); quyền trong gian hàng nằm ở ShopMember (module shop), không ở vai
 * identity. Khác `UserService.createStaff` (nhân viên SÀN, vai platform): không bao giờ tạo được vai nhân viên sàn qua đây.
 *
 * Hai bước tách riêng để băm mật khẩu (chậm) diễn ra NGOÀI transaction của người gọi:
 *  - hashPassword: kiểm luật mật khẩu (8–64 ký tự, có chữ và số) rồi băm — luật mật khẩu chỉ có MỘT nguồn là identity;
 *  - createCustomerAccount: ghi user + audit TRONG transaction của người gọi (`tx`) để tài khoản và việc gắn vào shop thành công/thất bại cùng nhau.
 * Email chưa xác minh (`emailVerifiedAt` rỗng): người tạo chỉ gõ địa chỉ, không chứng minh được chủ địa chỉ — nhân viên đổi mật khẩu bằng
 * "quên mật khẩu" (OTP về email) là chiếm lại được tài khoản nếu chủ shop gõ nhầm.
 */
@Injectable()
export class IdentityApplicationApi {
  private readonly logger = new Logger(IdentityApplicationApi.name);

  constructor(
    private readonly users: UserRepository,
    private readonly roles: PermissionRepository,
    private readonly audit: IdentityAuditLogService,
  ) {}

  /* 400 IDENTITY_PASSWORD_WEAK nếu không đạt luật mật khẩu; ngược lại trả hash. Không log mật khẩu. */
  async hashPassword(password: string): Promise<string> {
    if (!PASSWORD_RULE.test(password)) throw new BusinessException(IDENTITY_ERR.PASSWORD_WEAK, PASSWORD_MSG);
    return AuthService.hashPassword(password);
  }

  /*
   * Tạo tài khoản khách bên trong `tx` của người gọi. 409 IDENTITY_EMAIL_EXISTS khi email đã có tài khoản (kể cả khi hai
   * request tạo cùng email đồng thời: chốt unique của DB cũng quy về cùng 409). `actor` là người tạo (chủ shop) — ghi vào createdBy + audit.
   */
  async createCustomerAccount(actor: AuthenticatedActor, input: NewCustomerAccount, tx: Tx): Promise<{ userId: string; email: string; fullName: string }> {
    const role = await this.roles.findRoleByCode(ROLE_CODES.CUSTOMER);
    if (!role) throw new NotFoundException(IDENTITY_ERR.ROLE_NOT_FOUND, 'Chưa seed vai khách hàng — chạy perms:sync');
    const email = input.email.trim().toLowerCase();
    if (await this.users.emailExists(email, tx)) throw new ConflictException(IDENTITY_ERR.EMAIL_EXISTS, 'Email đã được dùng — hãy dùng email khác cho nhân viên');

    let created;
    try {
      created = await this.users.create(
        { email, fullName: input.fullName.trim(), passwordHash: input.passwordHash, roleId: role.id, status: USER_STATUS.ACTIVE, createdBy: actor.userId, updatedBy: actor.userId },
        tx,
      );
    } catch (e) {
      // Prisma P2002 = vi phạm unique (email) khi hai request tạo cùng lúc lọt qua kiểm tra ở trên.
      if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002') {
        throw new ConflictException(IDENTITY_ERR.EMAIL_EXISTS, 'Email đã được dùng — hãy dùng email khác cho nhân viên');
      }
      throw e;
    }
    await this.audit.write(tx, actor, {
      action: IDENTITY_AUDIT.USER_CREATED,
      entityType: 'user',
      entityId: created.id,
      entityCode: created.email,
      after: { email: created.email, role: role.code, fullName: created.fullName, via: 'shop_staff' },
    });
    this.logger.log({ userId: created.id, by: actor.userId }, 'Tạo tài khoản nhân viên gian hàng');
    return { userId: created.id, email: created.email, fullName: created.fullName };
  }
}
