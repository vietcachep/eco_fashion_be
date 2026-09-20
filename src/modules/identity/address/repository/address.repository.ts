import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { Prisma } from '../../../../generated/prisma/client';

export const ADDRESS_SELECT = {
  id: true,
  userId: true,
  recipientName: true,
  phone: true,
  provinceCode: true,
  provinceName: true,
  districtName: true,
  wardName: true,
  street: true,
  isDefault: true,
  note: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AddressSelect;

export type AddressRow = Prisma.AddressGetPayload<{ select: typeof ADDRESS_SELECT }>;

/*
 * Bảng identity.addresses — sổ địa chỉ giao hàng của khách. Mọi truy vấn đều lọc theo userId (Ownership Rule);
 * partial unique `uq_addresses_one_default_per_user` là chốt cuối "mỗi khách một địa chỉ mặc định".
 */
@Injectable()
export class AddressRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async listOfUser(userId: string, tx?: Tx | null): Promise<AddressRow[]> {
    return this.db(tx).address.findMany({ where: { userId, isDeleted: false }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }], select: ADDRESS_SELECT });
  }

  async findOfUser(userId: string, id: string, tx?: Tx | null): Promise<AddressRow | null> {
    return this.db(tx).address.findFirst({ where: { id, userId, isDeleted: false }, select: ADDRESS_SELECT });
  }

  async countOfUser(userId: string, tx?: Tx | null): Promise<number> {
    return this.db(tx).address.count({ where: { userId, isDeleted: false } });
  }

  async create(data: Prisma.AddressUncheckedCreateInput, tx?: Tx | null): Promise<AddressRow> {
    return this.db(tx).address.create({ data, select: ADDRESS_SELECT });
  }

  async update(id: string, data: Prisma.AddressUncheckedUpdateInput, tx?: Tx | null): Promise<AddressRow> {
    return this.db(tx).address.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: ADDRESS_SELECT });
  }

  /* Bỏ cờ mặc định của mọi địa chỉ khác — gọi TRƯỚC khi đặt mặc định mới trong cùng transaction. */
  async clearDefault(userId: string, tx: Tx): Promise<void> {
    await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
  }

  async softDelete(id: string, actorId: string, tx: Tx): Promise<void> {
    await tx.address.update({ where: { id }, data: { isDeleted: true, isDefault: false, updatedBy: actorId } });
  }
}
