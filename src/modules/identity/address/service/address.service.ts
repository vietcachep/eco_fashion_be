import { Injectable } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { IdentityAuditLogService } from '../../audit/identity-audit-log.service';
import { IDENTITY_AUDIT, IDENTITY_ERR } from '../../foundation/identity.constants';
import { AddressResponse } from '../dto/address.response';
import { toAddressResponse } from '../mapper/address.mapper';
import { AddressRepository } from '../repository/address.repository';

export interface AddressInput {
  recipientName: string;
  phone: string;
  provinceCode: string | null;
  provinceName: string;
  districtName: string | null;
  wardName: string | null;
  street: string;
  note: string | null;
}

const MAX_ADDRESSES = 10;

/*
 * Sổ địa chỉ của khách — chỉ chủ sở hữu thao tác (userId từ token). Đặt mặc định = bỏ cờ cũ + đặt cờ mới
 * TRONG MỘT transaction; xoá địa chỉ mặc định → địa chỉ mới nhất còn lại lên mặc định. Tối đa 10 địa chỉ.
 * Audit đầy đủ (địa chỉ giao là dữ liệu cá nhân; đơn hàng chụp lại snapshot nên sửa ở đây không đổi đơn cũ).
 */
@Injectable()
export class AddressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AddressRepository,
    private readonly audit: IdentityAuditLogService,
  ) {}

  async list(actor: AuthenticatedActor): Promise<AddressResponse[]> {
    return (await this.repo.listOfUser(actor.userId)).map(toAddressResponse);
  }

  async get(actor: AuthenticatedActor, id: string): Promise<AddressResponse> {
    const a = await this.repo.findOfUser(actor.userId, id);
    if (!a) throw new NotFoundException(IDENTITY_ERR.ADDRESS_NOT_FOUND, 'Không tìm thấy địa chỉ');
    return toAddressResponse(a);
  }

  async create(actor: AuthenticatedActor, input: AddressInput, makeDefault: boolean): Promise<AddressResponse> {
    const created = await this.prisma.$transaction(async (tx) => {
      const count = await this.repo.countOfUser(actor.userId, tx);
      if (count >= MAX_ADDRESSES) throw new BusinessException(IDENTITY_ERR.ADDRESS_LIMIT, `Tối đa ${MAX_ADDRESSES} địa chỉ`);
      const isDefault = makeDefault || count === 0;
      if (isDefault) await this.repo.clearDefault(actor.userId, tx);
      const a = await this.repo.create({ ...input, userId: actor.userId, isDefault, createdBy: actor.userId, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: IDENTITY_AUDIT.ADDRESS_CREATED, entityType: 'address', entityId: a.id, after: { ...input, isDefault } });
      return a;
    });
    return toAddressResponse(created);
  }

  async update(actor: AuthenticatedActor, id: string, patch: Partial<AddressInput>): Promise<AddressResponse> {
    const before = await this.repo.findOfUser(actor.userId, id);
    if (!before) throw new NotFoundException(IDENTITY_ERR.ADDRESS_NOT_FOUND, 'Không tìm thấy địa chỉ');
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(data).length === 0) return toAddressResponse(before);
    const after = await this.prisma.$transaction(async (tx) => {
      const a = await this.repo.update(id, { ...data, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: IDENTITY_AUDIT.ADDRESS_UPDATED, entityType: 'address', entityId: id, before: this.summary(before), after: this.summary(a) });
      return a;
    });
    return toAddressResponse(after);
  }

  async setDefault(actor: AuthenticatedActor, id: string): Promise<AddressResponse> {
    const target = await this.repo.findOfUser(actor.userId, id);
    if (!target) throw new NotFoundException(IDENTITY_ERR.ADDRESS_NOT_FOUND, 'Không tìm thấy địa chỉ');
    if (target.isDefault) return toAddressResponse(target);
    const after = await this.prisma.$transaction(async (tx) => {
      await this.repo.clearDefault(actor.userId, tx);
      const a = await this.repo.update(id, { isDefault: true, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: IDENTITY_AUDIT.ADDRESS_DEFAULT_SET, entityType: 'address', entityId: id, after: { street: a.street, provinceName: a.provinceName } });
      return a;
    });
    return toAddressResponse(after);
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    const target = await this.repo.findOfUser(actor.userId, id);
    if (!target) throw new NotFoundException(IDENTITY_ERR.ADDRESS_NOT_FOUND, 'Không tìm thấy địa chỉ');
    await this.prisma.$transaction(async (tx) => {
      await this.repo.softDelete(id, actor.userId, tx);
      if (target.isDefault) {
        const rest = await this.repo.listOfUser(actor.userId, tx);
        if (rest[0]) await this.repo.update(rest[0].id, { isDefault: true, updatedBy: actor.userId }, tx);
      }
      await this.audit.write(tx, actor, { action: IDENTITY_AUDIT.ADDRESS_DELETED, entityType: 'address', entityId: id, before: this.summary(target) });
    });
  }

  private summary(a: { recipientName: string; phone: string; provinceName: string; districtName: string | null; wardName: string | null; street: string; isDefault: boolean }) {
    return { recipientName: a.recipientName, phone: a.phone, provinceName: a.provinceName, districtName: a.districtName, wardName: a.wardName, street: a.street, isDefault: a.isDefault };
  }
}
