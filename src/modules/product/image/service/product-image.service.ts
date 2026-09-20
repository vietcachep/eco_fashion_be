import { Injectable } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { StorageService } from '@common/storage/storage.service';
import { ProductAuditLogService } from '../../audit/product-audit-log.service';
import { MAX_IMAGES_PER_PRODUCT, PRODUCT_AUDIT, PRODUCT_ERR } from '../../foundation/product.constants';
import { ProductAdminResponse } from '../../product/dto/product.responses';
import { toProductAdmin } from '../../product/mapper/product.mapper';
import { ProductRepository } from '../../product/repository/product.repository';
import { ProductQueryService } from '../../product/service/product-query.service';

/*
 * Ảnh sản phẩm: upload Cloudinary (mạng NGOÀI transaction) rồi ghi dòng ảnh + audit trong transaction; ảnh đầu tiên tự
 * làm ảnh chính. Xoá: xoá dòng trước, xoá file Cloudinary sau (file mồ côi chấp nhận được, dòng mồ côi thì không).
 * Gắn ảnh vào màu (`colorCode`) để thẻ đổi ảnh khi rê chấm màu và slider chi tiết nhảy đúng màu.
 * `addFromUrl` dành cho seed (ảnh đã có URL — Cloudinary hoặc tĩnh).
 */
@Injectable()
export class ProductImageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ProductRepository,
    private readonly query: ProductQueryService,
    private readonly storage: StorageService,
    private readonly audit: ProductAuditLogService,
  ) {}

  async upload(actor: AuthenticatedActor, productId: string, file: { buffer: Buffer; mimetype: string; size: number }, opts: { colorCode?: string | null; alt?: string | null; isPrimary?: boolean }): Promise<ProductAdminResponse> {
    const p = await this.repo.findDetailById(productId);
    if (!p) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    if (p.images.length >= MAX_IMAGES_PER_PRODUCT) throw new BusinessException(PRODUCT_ERR.IMAGE_LIMIT, `Tối đa ${MAX_IMAGES_PER_PRODUCT} ảnh mỗi sản phẩm`);
    const uploaded = await this.storage.uploadImage(file, `products/${p.slug}`);
    return this.addFromUrl(actor, productId, { url: uploaded.url, publicId: uploaded.publicId, colorCode: opts.colorCode ?? null, alt: opts.alt ?? p.name, isPrimary: opts.isPrimary ?? false });
  }

  async addFromUrl(actor: AuthenticatedActor | null, productId: string, img: { url: string; publicId: string | null; colorCode: string | null; alt: string | null; isPrimary: boolean }): Promise<ProductAdminResponse> {
    const after = await this.prisma.$transaction(async (tx) => {
      const count = await this.repo.countImages(productId, tx);
      const isPrimary = img.isPrimary || count === 0;
      if (isPrimary) await this.repo.clearPrimary(productId, tx);
      const row = await this.repo.addImage({ productId, url: img.url, publicId: img.publicId, colorCode: img.colorCode, alt: img.alt, sortOrder: count, isPrimary, createdBy: actor?.userId ?? null }, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.IMAGE_ADDED, entityType: 'product', entityId: productId, after: { imageId: row.id, url: row.url, colorCode: img.colorCode, isPrimary } });
      return (await this.repo.findDetailById(productId, tx))!;
    });
    await this.query.invalidateAll();
    return toProductAdmin(after);
  }

  async update(actor: AuthenticatedActor, productId: string, imageId: string, patch: { colorCode?: string | null; alt?: string | null; isPrimary?: boolean }): Promise<ProductAdminResponse> {
    const img = await this.repo.findImage(productId, imageId);
    if (!img) throw new NotFoundException(PRODUCT_ERR.IMAGE_NOT_FOUND, 'Không tìm thấy ảnh');
    const after = await this.prisma.$transaction(async (tx) => {
      if (patch.isPrimary) await this.repo.clearPrimary(productId, tx);
      await this.repo.updateImage(imageId, { ...(patch.colorCode !== undefined ? { colorCode: patch.colorCode } : {}), ...(patch.alt !== undefined ? { alt: patch.alt } : {}), ...(patch.isPrimary !== undefined ? { isPrimary: patch.isPrimary } : {}) }, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.IMAGES_REORDERED, entityType: 'product', entityId: productId, after: { imageId, ...patch } });
      return (await this.repo.findDetailById(productId, tx))!;
    });
    await this.query.invalidateAll();
    return toProductAdmin(after);
  }

  async reorder(actor: AuthenticatedActor, productId: string, imageIds: string[]): Promise<ProductAdminResponse> {
    const p = await this.repo.findDetailById(productId);
    if (!p) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm');
    const known = new Set(p.images.map((i) => i.id));
    if (imageIds.length !== known.size || imageIds.some((id) => !known.has(id))) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Danh sách id ảnh phải đúng và đủ mọi ảnh của sản phẩm');
    const after = await this.prisma.$transaction(async (tx) => {
      await this.repo.clearPrimary(productId, tx);
      for (const [i, id] of imageIds.entries()) await this.repo.updateImage(id, { sortOrder: i, isPrimary: i === 0 }, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.IMAGES_REORDERED, entityType: 'product', entityId: productId, after: { order: imageIds } });
      return (await this.repo.findDetailById(productId, tx))!;
    });
    await this.query.invalidateAll();
    return toProductAdmin(after);
  }

  async remove(actor: AuthenticatedActor, productId: string, imageId: string): Promise<ProductAdminResponse> {
    const img = await this.repo.findImage(productId, imageId);
    if (!img) throw new NotFoundException(PRODUCT_ERR.IMAGE_NOT_FOUND, 'Không tìm thấy ảnh');
    const after = await this.prisma.$transaction(async (tx) => {
      await this.repo.deleteImage(imageId, tx);
      const p = (await this.repo.findDetailById(productId, tx))!;
      if (img.isPrimary && p.images[0]) await this.repo.updateImage(p.images[0].id, { isPrimary: true }, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.IMAGE_REMOVED, entityType: 'product', entityId: productId, before: { imageId, url: img.url } });
      return (await this.repo.findDetailById(productId, tx))!;
    });
    if (img.publicId) await this.storage.deleteImage(img.publicId);
    await this.query.invalidateAll();
    return toProductAdmin(after);
  }
}
