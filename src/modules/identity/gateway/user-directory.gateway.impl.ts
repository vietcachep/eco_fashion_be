import { Injectable } from '@nestjs/common';
import type { UserDirectoryGateway, UserSnapshot } from '@common/gateway/user-directory.gateway';
import { UserRepository } from '../user/repository/user.repository';

/* Cài UserDirectoryGateway: module khác (order, review, ai…) tra snapshot người dùng — chỉ đọc, không lộ hash. */
@Injectable()
export class UserDirectoryGatewayImpl implements UserDirectoryGateway {
  constructor(private readonly users: UserRepository) {}

  async findSnapshot(userId: string): Promise<UserSnapshot | null> {
    const map = await this.findSnapshots([userId]);
    return map.get(userId) ?? null;
  }

  async findSnapshots(userIds: string[]): Promise<Map<string, UserSnapshot>> {
    const rows = await this.users.findSnapshots([...new Set(userIds)]);
    return new Map(rows.map((u) => [u.id, { userId: u.id, email: u.email, fullName: u.fullName, phone: u.phone, roleCode: u.role.code, status: u.status }]));
  }

  staffUserIdsWithPermission(permissionCode: string): Promise<string[]> {
    return this.users.activeStaffIdsWithPermission(permissionCode);
  }
}
