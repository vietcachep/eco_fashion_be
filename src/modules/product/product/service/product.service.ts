import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { CATEGORY_STATS_GATEWAY, CategoryStatsGateway } from '@common/gateway/category-stats.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { makeSku, slugify } from '@common/utils/slug';
import { CatalogQueryApi } from '../../../catalog/queryapi/catalog.queryapi';
import { ProductAuditLogService } from '../../audit/product-audit-log.service';
import { PRODUCT_AUDIT, PRODUCT_ERR, PRODUCT_EVENT, PRODUCT_STATUS, ProductSort } from '../../foundation/product.constants';
import { ProductOutboxService } from '../../outbox/product-outbox.service';
import { ProductAdminResponse, ProductCardResponse } from '../dto/product.responses';
import { toProductAdmin, toProductCard } from '../mapper/product.mapper';
import { ProductDetailRow, ProductRepository } from '../repository/product.repository';
import { ProductQueryService } from './product-query.service';

export interface VariantSpec {
  colorCode: string;
  sizeCode: string;
  sku?: string;
  price?: string | null;
  isActive?: boolean;
}

export interface ProductWriteInput {
  name?: string;
  slug?: string;
  categoryId?: string;
  gender?: string;
  basePrice?: string;
  listPrice?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  material?: string | null;
  care?: string[];
  tags?: string[];
  isNew?: boolean;
  isFeatured?: boolean;
}

/*
 * Ghi sản phẩm (khu quản trị): tạo/sửa/đăng bán/ẩn/xoá mềm + thay bộ biến thể. Mọi hàm: transaction + audit; đăng/ẩn/đổi
 * ngành → CategoryStatsGateway (product_count) cùng transaction + outbox PRODUCT_* (ai nhúng lại, module khác).
 * Biến thể: mã màu/size phải có trong catalog (CatalogQueryApi) — chép tên/hex vào biến thể (snapshot); SKU sinh tự động
 * `<SLUG-8>-<MÀU-2>-<SIZE>` nếu bỏ trống, unique partial trên SKU sống là chốt cuối.
 */
@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ProductRepository,
    private readonly query: ProductQueryService,
    private readonly catalog: CatalogQueryApi,
    private readonly audit: ProductAuditLogService,
    private readonly outbox: ProductOutboxService,
    @Inject(CATEGORY_STATS_GATEWAY) private readonly categoryStats: CategoryStatsGateway,
  ) {}

  async listAdmin(p: { page: number; size: number; q?: string; category?: string; gender?: string; status?: string; sort?: string }): Promise<PageResponse<ProductCardResponse & { status: string }>> {
    const { items, total } = await this.repo.list({ publicOnly: false, q: p.q, categorySlug: p.category, gender: p.gender, status: p.status, sort: p.sort as ProductSort | undefined }, (p.page - 1) * p.size, p.size);
    return PageResponse.of(
      items.map((r) => ({ ...toProductCard(r), status: r.status })),
      p.page,
      p.size,
      total,
    );
  }

  async getAdmin(id: string): Promise<ProductAdminResponse> {
    const p = await this.repo.findDetailById(id);
    if (!p) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    return toProductAdmin(p);
  }

  async create(actor: AuthenticatedActor | null, input: ProductWriteInput & { name: string; categoryId: string; gender: string; basePrice: string }, variants: VariantSpec[] = []): Promise<ProductAdminResponse> {
    const slug = input.slug ?? slugify(input.name);
    if (await this.repo.slugExists(slug)) throw new ConflictException(PRODUCT_ERR.SLUG_EXISTS, `Slug '${slug}' đã tồn tại`);
    const category = await this.catalog.findCategoryById(input.categoryId);
    if (!category) throw new BusinessException(PRODUCT_ERR.CATEGORY_INVALID, 'Ngành hàng không tồn tại');
    this.assertPrices(input.basePrice, input.listPrice);
    const specs = variants.length > 0 ? await this.resolveVariants(slug, variants) : [];
    const created = await this.prisma.$transaction(async (tx) => {
      const p = await this.repo.create(
        {
          name: input.name.trim(),
          slug,
          categoryId: category.id,
          categorySlug: category.slug,
          gender: input.gender,
          basePrice: input.basePrice,
          listPrice: input.listPrice ?? null,
          shortDescription: input.shortDescription ?? null,
          description: input.description ?? null,
          material: input.material ?? null,
          care: input.care ?? [],
          tags: input.tags ?? [],
          isNew: input.isNew ?? false,
          isFeatured: input.isFeatured ?? false,
          status: PRODUCT_STATUS.DRAFT,
          createdBy: actor?.userId ?? null,
          updatedBy: actor?.userId ?? null,
        },
        tx,
      );
      for (const v of specs) await this.repo.upsertVariant(p.id, v, actor?.userId ?? null, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.CREATED, entityType: 'product', entityId: p.id, entityCode: p.slug, after: { name: p.name, category: category.slug, basePrice: input.basePrice, variants: specs.length } });
      return (await this.repo.findDetailById(p.id, tx))!;
    });
    await this.query.invalidateAll();
    return toProductAdmin(created);
  }

  async update(actor: AuthenticatedActor, id: string, patch: ProductWriteInput): Promise<ProductAdminResponse> {
    const before = await this.repo.findDetailById(id);
    if (!before) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    if (patch.slug && patch.slug !== before.slug && (await this.repo.slugExists(patch.slug, id))) throw new ConflictException(PRODUCT_ERR.SLUG_EXISTS, `Slug '${patch.slug}' đã tồn tại`);
    this.assertPrices(patch.basePrice ?? before.basePrice.toString(), patch.listPrice === undefined ? (before.listPrice?.toString() ?? null) : patch.listPrice);
    let category: { id: string; slug: string } | null = null;
    if (patch.categoryId && patch.categoryId !== before.categoryId) {
      category = await this.catalog.findCategoryById(patch.categoryId);
      if (!category) throw new BusinessException(PRODUCT_ERR.CATEGORY_INVALID, 'Ngành hàng không tồn tại');
    }
    const data = {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(category ? { categoryId: category.id, categorySlug: category.slug } : {}),
      ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
      ...(patch.basePrice !== undefined ? { basePrice: patch.basePrice } : {}),
      ...(patch.listPrice !== undefined ? { listPrice: patch.listPrice } : {}),
      ...(patch.shortDescription !== undefined ? { shortDescription: patch.shortDescription } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.material !== undefined ? { material: patch.material } : {}),
      ...(patch.care !== undefined ? { care: patch.care } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.isNew !== undefined ? { isNew: patch.isNew } : {}),
      ...(patch.isFeatured !== undefined ? { isFeatured: patch.isFeatured } : {}),
    };
    if (Object.keys(data).length === 0) return toProductAdmin(before);
    const after = await this.prisma.$transaction(async (tx) => {
      const p = await this.repo.update(id, { ...data, updatedBy: actor.userId }, tx);
      if (category && before.status === PRODUCT_STATUS.ACTIVE) {
        await this.categoryStats.adjustProductCount(before.categoryId, -1, tx);
        await this.categoryStats.adjustProductCount(category.id, +1, tx);
      }
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.UPDATED, entityType: 'product', entityId: id, entityCode: p.slug, before: this.summary(before), after: this.summary(p) });
      if (p.status === PRODUCT_STATUS.ACTIVE) await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.UPDATED, aggregateType: 'product', aggregateId: id, payload: { productId: id, slug: p.slug } });
      return p;
    });
    await this.query.invalidateAll();
    return toProductAdmin(after);
  }

  async saveVariants(actor: AuthenticatedActor | null, id: string, variants: VariantSpec[]): Promise<ProductAdminResponse> {
    const before = await this.repo.findDetailById(id);
    if (!before) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    if (variants.length === 0) throw new BusinessException(PRODUCT_ERR.VARIANT_REQUIRED, 'Cần ít nhất một biến thể');
    const specs = await this.resolveVariants(before.slug, variants);
    const after = await this.prisma.$transaction(async (tx) => {
      const kept: string[] = [];
      for (const v of specs) {
        const existing = before.variants.find((x) => x.colorCode === v.colorCode && x.sizeCode === v.sizeCode);
        if (await this.repo.skuExists(v.sku, existing?.id, tx)) throw new ConflictException(PRODUCT_ERR.SKU_EXISTS, `SKU '${v.sku}' đã tồn tại`);
        const saved = await this.repo.upsertVariant(id, v, actor?.userId ?? null, tx);
        kept.push(saved.id);
      }
      const removed = await this.repo.softDeleteVariantsNotIn(id, kept, actor?.userId ?? 'system', tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.VARIANTS_SAVED, entityType: 'product', entityId: id, entityCode: before.slug, after: { variants: specs.map((s) => s.sku), removed } });
      return (await this.repo.findDetailById(id, tx))!;
    });
    await this.query.invalidateAll();
    return toProductAdmin(after);
  }

  async publish(actor: AuthenticatedActor | null, id: string): Promise<ProductAdminResponse> {
    const before = await this.repo.findDetailById(id);
    if (!before) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    if (before.status === PRODUCT_STATUS.ACTIVE) return toProductAdmin(before);
    const problems: string[] = [];
    if (before.variants.filter((v) => v.isActive).length === 0) problems.push('chưa có biến thể');
    if (before.images.length === 0) problems.push('chưa có ảnh');
    if (problems.length > 0) throw new BusinessException(PRODUCT_ERR.NOT_PUBLISHABLE, `Chưa đăng bán được: ${problems.join(', ')}`);
    const after = await this.prisma.$transaction(async (tx) => {
      const p = await this.repo.update(id, { status: PRODUCT_STATUS.ACTIVE, publishedAt: before.publishedAt ?? new Date(), updatedBy: actor?.userId ?? null }, tx);
      await this.categoryStats.adjustProductCount(p.categoryId, +1, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.PUBLISHED, entityType: 'product', entityId: id, entityCode: p.slug, before: { status: before.status }, after: { status: p.status } });
      await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.PUBLISHED, aggregateType: 'product', aggregateId: id, payload: { productId: id, slug: p.slug } });
      return p;
    });
    await this.query.invalidateAll();
    return toProductAdmin(after);
  }

  async hide(actor: AuthenticatedActor, id: string): Promise<ProductAdminResponse> {
    const before = await this.repo.findDetailById(id);
    if (!before) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    if (before.status !== PRODUCT_STATUS.ACTIVE) return toProductAdmin(before);
    const after = await this.prisma.$transaction(async (tx) => {
      const p = await this.repo.update(id, { status: PRODUCT_STATUS.HIDDEN, updatedBy: actor.userId }, tx);
      await this.categoryStats.adjustProductCount(p.categoryId, -1, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.HIDDEN, entityType: 'product', entityId: id, entityCode: p.slug, before: { status: before.status }, after: { status: p.status } });
      await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.HIDDEN, aggregateType: 'product', aggregateId: id, payload: { productId: id, slug: p.slug } });
      return p;
    });
    await this.query.invalidateAll();
    return toProductAdmin(after);
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    const before = await this.repo.findDetailById(id);
    if (!before) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    await this.prisma.$transaction(async (tx) => {
      await this.repo.update(id, { isDeleted: true, status: PRODUCT_STATUS.HIDDEN, updatedBy: actor.userId }, tx);
      // Xoá mềm cả biến thể để SKU được dùng lại (unique partial trên biến thể sống)
      await this.repo.softDeleteVariantsNotIn(id, [], actor.userId, tx);
      if (before.status === PRODUCT_STATUS.ACTIVE) await this.categoryStats.adjustProductCount(before.categoryId, -1, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.DELETED, entityType: 'product', entityId: id, entityCode: before.slug, before: this.summary(before) });
      await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.HIDDEN, aggregateType: 'product', aggregateId: id, payload: { productId: id, slug: before.slug, deleted: true } });
    });
    await this.query.invalidateAll();
    this.logger.log({ id, slug: before.slug, by: actor.userId }, 'Đã xoá mềm sản phẩm');
  }

  /* Worker gọi khi catalog đổi slug ngành hàng: cập nhật snapshot trên mọi sản phẩm của ngành. */
  async syncCategorySlug(categoryId: string, slug: string): Promise<number> {
    const n = await this.repo.updateCategorySlug(categoryId, slug);
    if (n > 0) await this.query.invalidateAll();
    return n;
  }

  // ---------------------------------------------------------------- helpers

  private assertPrices(basePrice: string, listPrice: string | null | undefined): void {
    const base = vnd(basePrice);
    if (base <= 0n) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Giá bán phải lớn hơn 0');
    if (listPrice && vnd(listPrice) <= base) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Giá gốc phải lớn hơn giá bán (hoặc bỏ trống)');
  }

  private async resolveVariants(slug: string, variants: VariantSpec[]): Promise<Array<{ sku: string; colorCode: string; colorName: string; colorHex: string | null; sizeCode: string; price: bigint | null; isActive: boolean }>> {
    const [colors, sizes] = await Promise.all([this.catalog.colorMap(), this.catalog.sizeMap()]);
    const seen = new Set<string>();
    const out = [];
    for (const v of variants) {
      const color = colors.get(v.colorCode);
      if (!color) throw new BusinessException(PRODUCT_ERR.COLOR_INVALID, `Mã màu '${v.colorCode}' không có trong catalog`);
      if (!sizes.has(v.sizeCode)) throw new BusinessException(PRODUCT_ERR.SIZE_INVALID, `Size '${v.sizeCode}' không có trong catalog`);
      const key = `${v.colorCode}|${v.sizeCode}`;
      if (seen.has(key)) throw new BusinessException('COMMON_VALIDATION_ERROR', `Biến thể ${color.name} / ${v.sizeCode} bị lặp`);
      seen.add(key);
      const sku = (v.sku ?? makeSku(slug, v.colorCode, v.sizeCode)).toUpperCase();
      out.push({ sku, colorCode: v.colorCode, colorName: color.name, colorHex: color.hex, sizeCode: v.sizeCode, price: v.price ? vnd(v.price) : null, isActive: v.isActive ?? true });
    }
    return out;
  }

  private summary(p: ProductDetailRow) {
    return { name: p.name, slug: p.slug, category: p.categorySlug, gender: p.gender, basePrice: p.basePrice.toString(), listPrice: p.listPrice?.toString() ?? null, status: p.status, isNew: p.isNew, isFeatured: p.isFeatured };
  }
}
