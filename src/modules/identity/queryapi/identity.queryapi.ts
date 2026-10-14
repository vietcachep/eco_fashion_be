import { Injectable } from '@nestjs/common';
import { AddressRepository } from '../address/repository/address.repository';
import { PermissionRepository } from '../permission/repository/permission.repository';
import { UserRepository } from '../user/repository/user.repository';

/*
 * QueryAPI của identity — cổng ĐỌC cho module khác trong cùng process (AGENTS.md — Module Boundary):
 * module khác chỉ import file này (và gateway ở common), KHÔNG import repository/service nội bộ của identity.
 * Trả kiểu phẳng, không trả model Prisma.
 */
export interface AddressBrief {
  id: string;
  recipientName: string;
  phone: string;
  provinceCode: string | null;
  provinceName: string;
  districtName: string | null;
  wardName: string | null;
  street: string;
  isDefault: boolean;
}

export interface UserBrief {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  roleCode: string;
  status: string;
  /* true khi email đã xác minh (`users.email_verified_at` có giá trị): đăng ký OTP/Google = đã xác minh; tài khoản do chủ shop tạo cho nhân viên = chưa. */
  emailVerified: boolean;
}

@Injectable()
export class IdentityQueryApi {
  constructor(
    private readonly users: UserRepository,
    private readonly addresses: AddressRepository,
    private readonly permissions: PermissionRepository,
  ) {}

  async findUserBrief(userId: string): Promise<UserBrief | null> {
    const rows = await this.users.findSnapshots([userId]);
    const u = rows[0];
    return u ? { id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, roleCode: u.role.code, status: u.status, emailVerified: u.emailVerifiedAt != null } : null;
  }

  /* Tìm user theo email (module shop dùng khi chủ shop thêm lại nhân viên cũ — khôi phục tài khoản). */
  async findUserBriefByEmail(email: string): Promise<UserBrief | null> {
    const u = await this.users.findByEmail(email);
    return u ? { id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, roleCode: u.role.code, status: u.status, emailVerified: u.emailVerifiedAt != null } : null;
  }

  /*
   * Vai scope=shop theo mã (shop_owner|shop_staff) — PLAN-0014 § RBAC 2 tầng. Module shop gọi khi tạo/đổi
   * ShopMember: resolve roleCode (từ request) → roleId thật, KHÔNG BAO GIỜ nhận roleId trần từ client.
   * Trả null nếu mã không tồn tại HOẶC không phải vai scope=shop (chặn gán nhầm vai platform vào ShopMember).
   */
  async findShopRoleByCode(code: string): Promise<{ id: string; code: string; name: string } | null> {
    const role = await this.permissions.findRoleByCode(code);
    if (!role || role.scope !== 'shop') return null;
    return { id: role.id, code: role.code, name: role.name };
  }

  /*
   * Vai (code/name) + mã quyền hiệu lực của roleId — PLAN-0014 ShopContextGuard gọi MỘT lần để vừa hiển thị
   * vai của thành viên vừa kiểm `@RequireShopPermission`. Không có override cấp/chặn riêng (vai scope=shop
   * không có user_permissions cá nhân); không cache qua Redis vì roleId ít thay đổi và không nằm trên đường
   * JWT auth nóng như effectivePermissions() của user.
   */
  async shopRoleContext(roleId: string): Promise<{ code: string; name: string; permissionCodes: string[] } | null> {
    const role = await this.permissions.findRoleById(roleId);
    if (!role) return null;
    const permissionCodes = await this.permissions.roleCodes(roleId);
    return { code: role.code, name: role.name, permissionCodes };
  }

  /* Vai (code/name) theo lô id — PLAN-0014 module shop dùng khi liệt kê ShopMember (tránh N+1: 1 query cho
     cả trang thay vì 1 query/thành viên). */
  async findRoleBriefs(roleIds: string[]): Promise<Map<string, { code: string; name: string }>> {
    const rows = await this.permissions.findRolesByIds([...new Set(roleIds)]);
    return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name }]));
  }

  async findUserBriefs(userIds: string[]): Promise<Map<string, UserBrief>> {
    const rows = await this.users.findSnapshots([...new Set(userIds)]);
    return new Map(rows.map((u) => [u.id, { id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, roleCode: u.role.code, status: u.status, emailVerified: u.emailVerifiedAt != null }]));
  }

  /* Địa chỉ giao hàng của khách (order dùng khi đặt bằng sổ địa chỉ) — chỉ trả địa chỉ của đúng user. */
  async findAddress(userId: string, addressId: string): Promise<AddressBrief | null> {
    const a = await this.addresses.findOfUser(userId, addressId);
    return a ? { id: a.id, recipientName: a.recipientName, phone: a.phone, provinceCode: a.provinceCode, provinceName: a.provinceName, districtName: a.districtName, wardName: a.wardName, street: a.street, isDefault: a.isDefault } : null;
  }

  async defaultAddress(userId: string): Promise<AddressBrief | null> {
    const list = await this.addresses.listOfUser(userId);
    const a = list.find((x) => x.isDefault) ?? list[0] ?? null;
    return a ? { id: a.id, recipientName: a.recipientName, phone: a.phone, provinceCode: a.provinceCode, provinceName: a.provinceName, districtName: a.districtName, wardName: a.wardName, street: a.street, isDefault: a.isDefault } : null;
  }
}
