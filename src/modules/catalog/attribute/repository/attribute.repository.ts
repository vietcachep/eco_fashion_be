import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';

export interface AttributeValueRow {
  id: string;
  attributeId: string;
  code: string;
  name: string;
  hex: string | null;
  groupCode: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface AttributeRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  isFilterable: boolean;
  sortOrder: number;
  values: AttributeValueRow[];
}

const VALUE_SELECT = { id: true, attributeId: true, code: true, name: true, hex: true, groupCode: true, sortOrder: true, isActive: true } as const;

/* Bảng catalog.attributes / attribute_values — biến thể sản phẩm tham chiếu theo `code`. */
@Injectable()
export class AttributeRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async listAll(tx?: Tx | null): Promise<AttributeRow[]> {
    return this.db(tx).attribute.findMany({
      where: { isDeleted: false },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, code: true, name: true, kind: true, isFilterable: true, sortOrder: true, values: { where: { isDeleted: false }, orderBy: { sortOrder: 'asc' }, select: VALUE_SELECT } },
    });
  }

  async findByCode(code: string, tx?: Tx | null): Promise<AttributeRow | null> {
    return this.db(tx).attribute.findFirst({
      where: { code, isDeleted: false },
      select: { id: true, code: true, name: true, kind: true, isFilterable: true, sortOrder: true, values: { where: { isDeleted: false }, orderBy: { sortOrder: 'asc' }, select: VALUE_SELECT } },
    });
  }

  async upsertAttribute(data: { code: string; name: string; kind: string; isFilterable: boolean; sortOrder: number }, actorId: string | null, tx?: Tx | null): Promise<{ id: string }> {
    return this.db(tx).attribute.upsert({
      where: { code: data.code },
      create: { ...data, createdBy: actorId, updatedBy: actorId },
      update: { name: data.name, kind: data.kind, isFilterable: data.isFilterable, sortOrder: data.sortOrder, isDeleted: false, updatedBy: actorId },
      select: { id: true },
    });
  }

  async upsertValue(attributeId: string, v: { code: string; name: string; hex?: string | null; groupCode?: string | null; sortOrder?: number; isActive?: boolean }, actorId: string | null, tx?: Tx | null): Promise<AttributeValueRow> {
    return this.db(tx).attributeValue.upsert({
      where: { attributeId_code: { attributeId, code: v.code } },
      create: { attributeId, code: v.code, name: v.name, hex: v.hex ?? null, groupCode: v.groupCode ?? null, sortOrder: v.sortOrder ?? 0, isActive: v.isActive ?? true, createdBy: actorId, updatedBy: actorId },
      update: { name: v.name, ...(v.hex !== undefined ? { hex: v.hex } : {}), ...(v.groupCode !== undefined ? { groupCode: v.groupCode } : {}), ...(v.sortOrder !== undefined ? { sortOrder: v.sortOrder } : {}), ...(v.isActive !== undefined ? { isActive: v.isActive } : {}), isDeleted: false, updatedBy: actorId },
      select: VALUE_SELECT,
    });
  }

  async softDeleteValue(attributeId: string, code: string, actorId: string, tx?: Tx | null): Promise<number> {
    const r = await this.db(tx).attributeValue.updateMany({ where: { attributeId, code, isDeleted: false }, data: { isDeleted: true, isActive: false, updatedBy: actorId } });
    return r.count;
  }
}
