import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import type { Prisma } from '../../../../generated/prisma/client';

export const COLLECTION_SELECT = {
  id: true,
  slug: true,
  name: true,
  tagline: true,
  imageUrl: true,
  imagePublicId: true,
  queryCategorySlug: true,
  queryGender: true,
  queryTag: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CollectionSelect;

export type CollectionRow = Prisma.CollectionGetPayload<{ select: typeof COLLECTION_SELECT }>;

@Injectable()
export class CollectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async list(onlyActive: boolean, tx?: Tx | null): Promise<CollectionRow[]> {
    return this.db(tx).collection.findMany({ where: { isDeleted: false, ...(onlyActive ? { isActive: true } : {}) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: COLLECTION_SELECT });
  }

  async findById(id: string, tx?: Tx | null): Promise<CollectionRow | null> {
    return this.db(tx).collection.findFirst({ where: { id, isDeleted: false }, select: COLLECTION_SELECT });
  }

  async findBySlug(slug: string, tx?: Tx | null): Promise<CollectionRow | null> {
    return this.db(tx).collection.findFirst({ where: { slug, isDeleted: false }, select: COLLECTION_SELECT });
  }

  async slugExists(slug: string, exceptId?: string, tx?: Tx | null): Promise<boolean> {
    return (await this.db(tx).collection.count({ where: { slug, isDeleted: false, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
  }

  async create(data: Prisma.CollectionUncheckedCreateInput, tx?: Tx | null): Promise<CollectionRow> {
    return this.db(tx).collection.create({ data, select: COLLECTION_SELECT });
  }

  async update(id: string, data: Prisma.CollectionUncheckedUpdateInput, tx?: Tx | null): Promise<CollectionRow> {
    return this.db(tx).collection.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: COLLECTION_SELECT });
  }
}
