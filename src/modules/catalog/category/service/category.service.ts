import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { StorageService } from '@common/storage/storage.service';
import { slugify } from '@common/utils/slug';
import { CatalogAuditLogService } from '../../audit/catalog-audit-log.service';
import { CATALOG_AUDIT, CATALOG_CACHE, CATALOG_ERR, CATALOG_EVENT } from '../../foundation/catalog.constants';
import { CatalogOutboxService } from '../../outbox/catalog-outbox.service';
import { CategoryAdminResponse, CategoryResponse } from '../dto/category.responses';
import { toCategory, toCategoryAdmin } from '../mapper/category.mapper';
import { CategoryRepository } from '../repository/category.repository';

export interface CategoryInput {
  name?: string;
  slug?: string;
  description?: string | null;
  parentId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

/*
 * Ngành hàng: đọc công khai (cache Redis 10', chỉ ngành đang bán, có product_count) + quản trị (transaction + audit).
 * Đổi slug/tên → outbox CATEGORY_CHANGED để product cập nhật snapshot category_slug (worker). Xoá mềm chỉ khi không còn
 * sản phẩm đang bán (product_count = 0) — ngành hàng là trục lọc của web, không được "mồ côi" sản phẩm.
 */
@Injectable()
export class CategoryService {
  private readonly logger = new Logger(CategoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: CategoryRepository,
    private readonly cache: CacheService,
    private readonly audit: CatalogAuditLogService,
    private readonly outbox: CatalogOutboxService,
    private readonly storage: StorageService,
  ) {}

  async listPublic(): Promise<CategoryResponse[]> {
    return this.cache.getOrSet(CATALOG_CACHE.categories, 'active', async () => (await this.repo.listActive()).map(toCategory));
  }

  async listAdmin(): Promise<CategoryAdminResponse[]> {
    return (await this.repo.listAll()).map(toCategoryAdmin);
  }

  async getAdmin(id: string): Promise<CategoryAdminResponse> {
    const c = await this.repo.findById(id);
    if (!c) throw new NotFoundException(CATALOG_ERR.CATEGORY_NOT_FOUND, 'Không tìm thấy ngành hàng');
    return toCategoryAdmin(c);
  }

  async create(actor: AuthenticatedActor, input: CategoryInput & { name: string }): Promise<CategoryAdminResponse> {
    const slug = input.slug ?? slugify(input.name);
    if (await this.repo.slugExists(slug)) throw new ConflictException(CATALOG_ERR.CATEGORY_SLUG_EXISTS, `Slug '${slug}' đã tồn tại`);
    if (input.parentId && !(await this.repo.findById(input.parentId))) throw new BusinessException(CATALOG_ERR.CATEGORY_PARENT_INVALID, 'Ngành hàng cha không tồn tại');
    const created = await this.prisma.$transaction(async (tx) => {
      const c = await this.repo.create(
        { name: input.name.trim(), slug, description: input.description ?? null, parentId: input.parentId ?? null, sortOrder: input.sortOrder ?? 0, isActive: input.isActive ?? true, createdBy: actor.userId, updatedBy: actor.userId },
        tx,
      );
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.CATEGORY_CREATED, entityType: 'category', entityId: c.id, entityCode: c.slug, after: { name: c.name, slug: c.slug, isActive: c.isActive } });
      return c;
    });
    await this.invalidate();
    return toCategoryAdmin(created);
  }

  async update(actor: AuthenticatedActor, id: string, patch: CategoryInput): Promise<CategoryAdminResponse> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException(CATALOG_ERR.CATEGORY_NOT_FOUND, 'Không tìm thấy ngành hàng');
    if (patch.slug && patch.slug !== before.slug && (await this.repo.slugExists(patch.slug, id))) throw new ConflictException(CATALOG_ERR.CATEGORY_SLUG_EXISTS, `Slug '${patch.slug}' đã tồn tại`);
    if (patch.parentId) {
      if (patch.parentId === id) throw new BusinessException(CATALOG_ERR.CATEGORY_PARENT_INVALID, 'Ngành hàng không thể là cha của chính nó');
      if (!(await this.repo.findById(patch.parentId))) throw new BusinessException(CATALOG_ERR.CATEGORY_PARENT_INVALID, 'Ngành hàng cha không tồn tại');
    }
    const data = {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    };
    if (Object.keys(data).length === 0) return toCategoryAdmin(before);
    const after = await this.prisma.$transaction(async (tx) => {
      const c = await this.repo.update(id, { ...data, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.CATEGORY_UPDATED, entityType: 'category', entityId: id, entityCode: c.slug, before: { name: before.name, slug: before.slug, isActive: before.isActive }, after: { name: c.name, slug: c.slug, isActive: c.isActive } });
      if (c.slug !== before.slug || c.name !== before.name || c.isActive !== before.isActive) {
        await this.outbox.publish(tx, { eventType: CATALOG_EVENT.CATEGORY_CHANGED, aggregateType: 'category', aggregateId: id, payload: { categoryId: id, slug: c.slug, name: c.name, isActive: c.isActive, previousSlug: before.slug } });
      }
      return c;
    });
    await this.invalidate();
    return toCategoryAdmin(after);
  }

  async updateImage(actor: AuthenticatedActor, id: string, file: { buffer: Buffer; mimetype: string; size: number }): Promise<CategoryAdminResponse> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException(CATALOG_ERR.CATEGORY_NOT_FOUND, 'Không tìm thấy ngành hàng');
    const uploaded = await this.storage.uploadImage(file, 'categories'); // mạng NGOÀI transaction
    const after = await this.prisma.$transaction(async (tx) => {
      const c = await this.repo.update(id, { imageUrl: uploaded.url, imagePublicId: uploaded.publicId, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.CATEGORY_UPDATED, entityType: 'category', entityId: id, entityCode: c.slug, after: { imageUrl: uploaded.url } });
      return c;
    });
    if (before.imagePublicId && before.imagePublicId !== uploaded.publicId) await this.storage.deleteImage(before.imagePublicId);
    await this.invalidate();
    return toCategoryAdmin(after);
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException(CATALOG_ERR.CATEGORY_NOT_FOUND, 'Không tìm thấy ngành hàng');
    if (before.productCount > 0) throw new BusinessException(CATALOG_ERR.CATEGORY_HAS_PRODUCTS, `Ngành hàng còn ${before.productCount} sản phẩm đang bán — ẩn sản phẩm hoặc chuyển ngành trước`);
    await this.prisma.$transaction(async (tx) => {
      await this.repo.update(id, { isDeleted: true, isActive: false, updatedBy: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.CATEGORY_DELETED, entityType: 'category', entityId: id, entityCode: before.slug, before: { name: before.name, slug: before.slug } });
    });
    await this.invalidate();
    this.logger.log({ id, slug: before.slug, by: actor.userId }, 'Đã xoá mềm ngành hàng');
  }

  async invalidate(): Promise<void> {
    await this.cache.delByPrefix(CATALOG_CACHE.categories);
  }
}
