import { Injectable } from '@nestjs/common';
import { AddressRepository } from '../address/repository/address.repository';
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
}

@Injectable()
export class IdentityQueryApi {
  constructor(
    private readonly users: UserRepository,
    private readonly addresses: AddressRepository,
  ) {}

  async findUserBrief(userId: string): Promise<UserBrief | null> {
    const rows = await this.users.findSnapshots([userId]);
    const u = rows[0];
    return u ? { id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, roleCode: u.role.code, status: u.status } : null;
  }

  async findUserBriefs(userIds: string[]): Promise<Map<string, UserBrief>> {
    const rows = await this.users.findSnapshots([...new Set(userIds)]);
    return new Map(rows.map((u) => [u.id, { id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, roleCode: u.role.code, status: u.status }]));
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
