import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { Prisma } from '../../../../generated/prisma/client';

export const DYNAMIC_ATTRIBUTE_SELECT = {
  id: true,
  code: true,
  name: true,
  inputType: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DynamicAttributeSelect;

export type DynamicAttributeRow = Prisma.DynamicAttributeGetPayload<{ select: typeof DYNAMIC_ATTRIBUTE_SELECT }>;

export const DYNAMIC_ATTRIBUTE_WITH_VALUES_SELECT = {
  ...DYNAMIC_ATTRIBUTE_SELECT,
  values: {
    select: {
      id: true,
      value: true,
      extra: true,
      sortOrder: true,
    },
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.DynamicAttributeSelect;

export type DynamicAttributeWithValuesRow = Prisma.DynamicAttributeGetPayload<{ select: typeof DYNAMIC_ATTRIBUTE_WITH_VALUES_SELECT }>;

/*
 * Bảng catalog.dynamic_attributes — thuộc tính động cho ngành hàng không phải thời trang (PLAN-0016).
 * KHÁC hẳn Attribute/AttributeValue cũ (bị khóa 3 mã color/size/material).
 */
@Injectable()
export class DynamicAttributeRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async list(tx?: Tx | null): Promise<DynamicAttributeWithValuesRow[]> {
    return this.db(tx).dynamicAttribute.findMany({
      orderBy: { createdAt: 'desc' },
      select: DYNAMIC_ATTRIBUTE_WITH_VALUES_SELECT,
    });
  }

  async findById(id: string, tx?: Tx | null): Promise<DynamicAttributeWithValuesRow | null> {
    return this.db(tx).dynamicAttribute.findUnique({
      where: { id },
      select: DYNAMIC_ATTRIBUTE_WITH_VALUES_SELECT,
    });
  }

  async findByCode(code: string, tx?: Tx | null): Promise<DynamicAttributeRow | null> {
    return this.db(tx).dynamicAttribute.findUnique({
      where: { code },
      select: DYNAMIC_ATTRIBUTE_SELECT,
    });
  }

  /* PLAN-0016 — module khác (ai) cần TÊN thuộc tính (vd "Màu sắc") để dựng ngữ cảnh cho AI, tránh N+1. */
  async findAttributesByIds(ids: string[], tx?: Tx | null): Promise<Array<{ id: string; code: string; name: string }>> {
    if (ids.length === 0) return [];
    return this.db(tx).dynamicAttribute.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, code: true, name: true },
    });
  }

  /* Validate mẫu thuộc tính của ngành: cần inputType để biết thuộc tính nào làm được trục biến thể (chỉ select). */
  async findByIdsWithType(ids: string[], tx?: Tx | null): Promise<Array<{ id: string; code: string; name: string; inputType: string }>> {
    if (ids.length === 0) return [];
    return this.db(tx).dynamicAttribute.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, code: true, name: true, inputType: true },
    });
  }

  /* PLAN-0016 — module khác (product) cần snapshot displayValue lúc tạo biến thể — tránh N+1 khi 1 sản
     phẩm có nhiều biến thể × nhiều trục. */
  async findValuesByIds(ids: string[], tx?: Tx | null): Promise<Array<{ id: string; value: string; attributeId: string }>> {
    if (ids.length === 0) return [];
    return this.db(tx).dynamicAttributeValue.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, value: true, attributeId: true },
    });
  }

  async create(data: Prisma.DynamicAttributeUncheckedCreateInput, tx?: Tx | null): Promise<DynamicAttributeWithValuesRow> {
    return this.db(tx).dynamicAttribute.create({
      data,
      select: DYNAMIC_ATTRIBUTE_WITH_VALUES_SELECT,
    });
  }

  async update(id: string, data: Prisma.DynamicAttributeUncheckedUpdateInput, tx?: Tx | null): Promise<DynamicAttributeWithValuesRow> {
    return this.db(tx).dynamicAttribute.update({
      where: { id },
      data,
      select: DYNAMIC_ATTRIBUTE_WITH_VALUES_SELECT,
    });
  }

  async createValue(data: Prisma.DynamicAttributeValueUncheckedCreateInput, tx?: Tx | null): Promise<Prisma.DynamicAttributeValueGetPayload<true>> {
    return this.db(tx).dynamicAttributeValue.create({
      data,
    });
  }

  async updateValue(id: string, data: Prisma.DynamicAttributeValueUncheckedUpdateInput, tx?: Tx | null): Promise<Prisma.DynamicAttributeValueGetPayload<true>> {
    return this.db(tx).dynamicAttributeValue.update({
      where: { id },
      data,
    });
  }

  async deleteValue(id: string, tx?: Tx | null): Promise<Prisma.DynamicAttributeValueGetPayload<true>> {
    return this.db(tx).dynamicAttributeValue.delete({
      where: { id },
    });
  }
}
