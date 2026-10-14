import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { Prisma } from '../../../../generated/prisma/client';

export const CATEGORY_ATTRIBUTE_SELECT = {
  id: true,
  categoryId: true,
  attributeId: true,
  required: true,
  isVariantAxis: true,
  sortOrder: true,
} satisfies Prisma.CategoryAttributeSelect;

export type CategoryAttributeRow = Prisma.CategoryAttributeGetPayload<{ select: typeof CATEGORY_ATTRIBUTE_SELECT }>;

export const CATEGORY_ATTRIBUTE_WITH_DETAILS_SELECT = {
  ...CATEGORY_ATTRIBUTE_SELECT,
  attribute: {
    select: {
      id: true,
      code: true,
      name: true,
      inputType: true,
      values: {
        select: {
          id: true,
          value: true,
          extra: true,
          sortOrder: true,
        },
        orderBy: { sortOrder: 'asc' as const },
      },
    },
  },
} satisfies Prisma.CategoryAttributeSelect;

export type CategoryAttributeWithDetailsRow = Prisma.CategoryAttributeGetPayload<{ select: typeof CATEGORY_ATTRIBUTE_WITH_DETAILS_SELECT }>;

/*
 * Bảng catalog.category_attributes — mẫu thuộc tính theo category (ngành hàng).
 * Mỗi category có danh sách thuộc tính cần theo, có bắt buộc không, có dùng làm trục biến thể không.
 */
@Injectable()
export class CategoryAttributeRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async getByCategoryId(categoryId: string, tx?: Tx | null): Promise<CategoryAttributeWithDetailsRow[]> {
    return this.db(tx).categoryAttribute.findMany({
      where: { categoryId },
      orderBy: { sortOrder: 'asc' },
      select: CATEGORY_ATTRIBUTE_WITH_DETAILS_SELECT,
    });
  }

  async countVariantAxis(categoryId: string, tx?: Tx | null): Promise<number> {
    return this.db(tx).categoryAttribute.count({
      where: { categoryId, isVariantAxis: true },
    });
  }

  async deleteAllByCategory(categoryId: string, tx?: Tx | null): Promise<void> {
    await this.db(tx).categoryAttribute.deleteMany({
      where: { categoryId },
    });
  }

  async create(data: Prisma.CategoryAttributeUncheckedCreateInput, tx?: Tx | null): Promise<CategoryAttributeRow> {
    return this.db(tx).categoryAttribute.create({
      data,
      select: CATEGORY_ATTRIBUTE_SELECT,
    });
  }
}
