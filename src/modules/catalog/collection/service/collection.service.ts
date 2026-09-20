import { Injectable } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { ConflictException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { StorageService } from '@common/storage/storage.service';
import { slugify } from '@common/utils/slug';
import { CatalogAuditLogService } from '../../audit/catalog-audit-log.service';
import { CATALOG_AUDIT, CATALOG_CACHE, CATALOG_ERR } from '../../foundation/catalog.constants';
import { CollectionAdminResponse, CollectionResponse } from '../dto/collection.responses';
import { toCollection, toCollectionAdmin } from '../mapper/collection.mapper';
import { CollectionRepository } from '../repository/collection.repository';

export interface CollectionInput {
  name?: string;
  slug?: string;
  tagline?: string | null;
  queryCategorySlug?: string | null;
  queryGender?: string | null;
  queryTag?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

/* Bộ sưu tập — đọc công khai cache 10'; quản trị: transaction + audit; ảnh Cloudinary. */
@Injectable()
export class CollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: CollectionRepository,
    private readonly cache: CacheService,
    private readonly audit: CatalogAuditLogService,
    private readonly storage: StorageService,
  ) {}

  async listPublic(): Promise<CollectionResponse[]> {
    return this.cache.getOrSet(CATALOG_CACHE.collections, 'active', async () => (await this.repo.list(true)).map(toCollection));
  }

  async getPublic(slug: string): Promise<CollectionResponse> {
    const c = await this.repo.findBySlug(slug);
    if (!c || !c.isActive) throw new NotFoundException(CATALOG_ERR.COLLECTION_NOT_FOUND, 'Không tìm thấy bộ sưu tập');
    return toCollection(c);
  }

  async listAdmin(): Promise<CollectionAdminResponse[]> {
    return (await this.repo.list(false)).map(toCollectionAdmin);
  }

  async create(actor: AuthenticatedActor, input: CollectionInput & { name: string }): Promise<CollectionAdminResponse> {
    const slug = input.slug ?? slugify(input.name);
    if (await this.repo.slugExists(slug)) throw new ConflictException(CATALOG_ERR.COLLECTION_SLUG_EXISTS, `Slug '${slug}' đã tồn tại`);
    const created = await this.prisma.$transaction(async (tx) => {
      const c = await this.repo.create(
        {
          name: input.name.trim(),
          slug,
          tagline: input.tagline ?? null,
          queryCategorySlug: input.queryCategorySlug ?? null,
          queryGender: input.queryGender ?? null,
          queryTag: input.queryTag ?? null,
          sortOrder: input.sortOrder ?? 0,
          isActive: input.isActive ?? true,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
        tx,
      );
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.COLLECTION_CREATED, entityType: 'collection', entityId: c.id, entityCode: c.slug, after: { name: c.name, query: toCollection(c).query } });
      return c;
    });
    await this.cache.delByPrefix(CATALOG_CACHE.collections);
    return toCollectionAdmin(created);
  }

  async update(actor: AuthenticatedActor, id: string, patch: CollectionInput): Promise<CollectionAdminResponse> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException(CATALOG_ERR.COLLECTION_NOT_FOUND, 'Không tìm thấy bộ sưu tập');
    if (patch.slug && patch.slug !== before.slug && (await this.repo.slugExists(patch.slug, id))) throw new ConflictException(CATALOG_ERR.COLLECTION_SLUG_EXISTS, `Slug '${patch.slug}' đã tồn tại`);
    const data = Object.fromEntries(Object.entries({ ...patch, name: patch.name?.trim() }).filter(([, v]) => v !== undefined));
    if (Object.keys(data).length === 0) return toCollectionAdmin(before);
    const after = await this.prisma.$transaction(async (tx) => {
      const c = await this.repo.update(id, { ...data, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.COLLECTION_UPDATED, entityType: 'collection', entityId: id, entityCode: c.slug, before: { name: before.name, isActive: before.isActive }, after: { name: c.name, isActive: c.isActive, query: toCollection(c).query } });
      return c;
    });
    await this.cache.delByPrefix(CATALOG_CACHE.collections);
    return toCollectionAdmin(after);
  }

  async updateImage(actor: AuthenticatedActor, id: string, file: { buffer: Buffer; mimetype: string; size: number }): Promise<CollectionAdminResponse> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException(CATALOG_ERR.COLLECTION_NOT_FOUND, 'Không tìm thấy bộ sưu tập');
    const uploaded = await this.storage.uploadImage(file, 'collections');
    const after = await this.prisma.$transaction(async (tx) => {
      const c = await this.repo.update(id, { imageUrl: uploaded.url, imagePublicId: uploaded.publicId, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.COLLECTION_UPDATED, entityType: 'collection', entityId: id, entityCode: c.slug, after: { imageUrl: uploaded.url } });
      return c;
    });
    if (before.imagePublicId && before.imagePublicId !== uploaded.publicId) await this.storage.deleteImage(before.imagePublicId);
    await this.cache.delByPrefix(CATALOG_CACHE.collections);
    return toCollectionAdmin(after);
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException(CATALOG_ERR.COLLECTION_NOT_FOUND, 'Không tìm thấy bộ sưu tập');
    await this.prisma.$transaction(async (tx) => {
      await this.repo.update(id, { isDeleted: true, isActive: false, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.COLLECTION_DELETED, entityType: 'collection', entityId: id, entityCode: before.slug, before: { name: before.name } });
    });
    await this.cache.delByPrefix(CATALOG_CACHE.collections);
  }
}
