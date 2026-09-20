import { Global, Module } from '@nestjs/common';
import { USER_DIRECTORY_GATEWAY } from '@common/gateway/user-directory.gateway';
import { PERMISSION_AUTHORIZATION_GATEWAY, TOKEN_VALIDATION_GATEWAY } from '@common/security/permission-authorization.gateway';
import { AddressController } from './address/controller/address.controller';
import { AddressRepository } from './address/repository/address.repository';
import { AddressService } from './address/service/address.service';
import { AdminAuditController } from './audit/controller/admin-audit.controller';
import { IdentityAuditLogService } from './audit/identity-audit-log.service';
import { IdentityAuditQueryService } from './audit/identity-audit-query.service';
import { AuthController } from './auth/controller/auth.controller';
import { RefreshTokenRepository } from './auth/repository/refresh-token.repository';
import { AuthService } from './auth/service/auth.service';
import { TokenService } from './auth/service/token.service';
import { PermissionAuthorizationGatewayImpl } from './gateway/permission-authorization.gateway.impl';
import { TokenValidationGatewayImpl } from './gateway/token-validation.gateway.impl';
import { UserDirectoryGatewayImpl } from './gateway/user-directory.gateway.impl';
import { LoginHistoryController } from './loginhistory/controller/login-history.controller';
import { LoginHistoryRepository } from './loginhistory/repository/login-history.repository';
import { LoginHistoryService } from './loginhistory/service/login-history.service';
import { IdentityOutboxService } from './outbox/identity-outbox.service';
import { AdminPermissionController } from './permission/controller/admin-permission.controller';
import { AdminRoleController } from './permission/controller/admin-role.controller';
import { PermissionRepository } from './permission/repository/permission.repository';
import { PermissionService } from './permission/service/permission.service';
import { IdentityQueryApi } from './queryapi/identity.queryapi';
import { AdminUserController } from './user/controller/admin-user.controller';
import { MeController } from './user/controller/me.controller';
import { UserRepository } from './user/repository/user.repository';
import { UserService } from './user/service/user.service';

/*
 * Module identity (PLAN-0002): xác thực, người dùng, vai/quyền, địa chỉ, lịch sử đăng nhập, audit.
 * @Global vì cung cấp 3 cổng mà guard ở common cần (TOKEN_VALIDATION, PERMISSION_AUTHORIZATION) và cổng
 * USER_DIRECTORY cho module khác. Module khác chỉ được import IdentityQueryApi + các gateway; KHÔNG import
 * repository/service nội bộ (dependency-cruiser gác).
 */
@Global()
@Module({
  controllers: [
    AuthController,
    MeController,
    AdminUserController,
    AddressController,
    LoginHistoryController,
    AdminAuditController,
    AdminRoleController,
    AdminPermissionController,
  ],
  providers: [
    // repository
    UserRepository,
    RefreshTokenRepository,
    PermissionRepository,
    AddressRepository,
    LoginHistoryRepository,
    // audit/outbox
    IdentityAuditLogService,
    IdentityAuditQueryService,
    IdentityOutboxService,
    // service
    TokenService,
    AuthService,
    PermissionService,
    UserService,
    AddressService,
    LoginHistoryService,
    // gateway impl → token global
    { provide: TOKEN_VALIDATION_GATEWAY, useClass: TokenValidationGatewayImpl },
    { provide: PERMISSION_AUTHORIZATION_GATEWAY, useClass: PermissionAuthorizationGatewayImpl },
    { provide: USER_DIRECTORY_GATEWAY, useClass: UserDirectoryGatewayImpl },
    IdentityQueryApi,
  ],
  exports: [TOKEN_VALIDATION_GATEWAY, PERMISSION_AUTHORIZATION_GATEWAY, USER_DIRECTORY_GATEWAY, IdentityQueryApi],
})
export class IdentityModule {}
