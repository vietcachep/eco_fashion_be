import { Injectable } from '@nestjs/common';
import type { PermissionAuthorizationGateway } from '@common/security/permission-authorization.gateway';
import { PermissionService } from '../permission/service/permission.service';

/* Cài PermissionAuthorizationGateway cho PermissionGuard — chỉ uỷ quyền sang PermissionService (đã cache Redis). */
@Injectable()
export class PermissionAuthorizationGatewayImpl implements PermissionAuthorizationGateway {
  constructor(private readonly permissions: PermissionService) {}

  effectivePermissions(userId: string): Promise<ReadonlySet<string>> {
    return this.permissions.effectivePermissions(userId);
  }
}
