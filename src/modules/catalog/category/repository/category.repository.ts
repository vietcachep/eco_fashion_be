import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { Prisma } from '../../../../generated/prisma/client';

export const CATEGORY_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  imageUrl: true,
  imagePublicId: true,
  parentId: true,
  sortOrder: true,
  isActive: true,
  productCount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CategorySelect;

export type CategoryRow = Prisma.CategoryGetPayload<{ select: typeof CATEGORY_SELECT }>;

/* Bảng catalog.categories — cây ngành hàng (đề tài: 7 nhóm phẳng, parentId để sau nếu cần). */
@Injectable()
export class CategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async listActive(tx?: Tx | null): Promise<CategoryRow[]> {
    return this.db(tx).category.findMany({ where: { isDeleted: false, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: CATEGORY_SELECT });
  }

  async listAll(tx?: Tx | null): Promise<CategoryRow[]> {
    return this.db(tx).category.findMany({ where: { isDeleted: false }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: CATEGORY_SELECT });
  }

  async findById(id: string, tx?: Tx | null): Promise<CategoryRow | null> {
    return this.db(tx).category.findFirst({ where: { id, isDeleted: false }, select: CATEGORY_SELECT });
  }

  async findBySlug(slug: string, tx?: Tx | null): Promise<CategoryRow | null> {
    return this.db(tx).category.findFirst({ where: { slug, isDeleted: false }, select: CATEGORY_SELECT });
  }

  async slugExists(slug: string, exceptId?: string, tx?: Tx | null): Promise<boolean> {
    return (await this.db(tx).category.count({ where: { slug, isDeleted: false, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
  }

  async create(data: Prisma.CategoryUncheckedCreateInput, tx?: Tx | null): Promise<CategoryRow> {
    return this.db(tx).category.create({ data, select: CATEGORY_SELECT });
  }

  async update(id: string, data: Prisma.CategoryUncheckedUpdateInput, tx?: Tx | null): Promise<CategoryRow> {
    return this.db(tx).category.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: CATEGORY_SELECT });
  }

  async adjustProductCount(id: string, delta: number, tx?: Tx | null): Promise<void> {
    await this.db(tx).category.update({ where: { id }, data: { productCount: { increment: delta } } });
  }
}
