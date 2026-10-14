import { Injectable } from '@nestjs/common';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { PRODUCT_ERR, PRODUCT_STATUS } from '../../foundation/product.constants';
import { ProductAdminResponse } from '../dto/product.responses';
import { ProductImageService } from '../../image/service/product-image.service';
import { detectImageType } from './image-signature';

/*
 * Vendor ảnh sản phẩm — bọc ProductImageService với kiểm ownership (product.shopId = ctx.shopId) và các luật riêng của vendor.
 * Mọi thao tác (upload, update, reorder, remove) → 404 nếu product không shop's.
 * Luật thêm ở lớp này (ProductImageService dùng chung với /admin nên không sửa ở đó):
 * - upload: kiểm magic bytes (JPEG/PNG/WebP/GIF) TRƯỚC khi gọi Storage; mimetype được chuẩn hoá theo nội dung thật;
 * - update: không cho bỏ cờ ảnh chính của ảnh chính hiện tại (sản phẩm sẽ không còn ảnh chính) — chọn ảnh khác làm chính;
 * - reorder: id không được trùng (ProductImageService chỉ so độ dài + tập nên [a, a] lọt qua);
 * - remove: không xoá ảnh cuối của sản phẩm ĐANG BÁN (đăng bán đòi ≥ 1 ảnh).
 */
@Injectable()
export class ShopProductImageService {
  constructor(
    private readonly images: ProductImageService,
    private readonly prisma: PrismaService,
  ) {}

  /* POST /shop/products/:id/images — upload ảnh (kiểm ownership + magic bytes). */
  async uploadShop(actor: AuthenticatedActor, shopId: string, productId: string, file: { buffer: Buffer; mimetype: string; size: number }, opts: { colorCode?: string | null; alt?: string | null; isPrimary?: boolean }): Promise<ProductAdminResponse> {
    await this.assertProductOwnership(shopId, productId);
    const detected = detectImageType(file.buffer);
    if (!detected) throw new BusinessException(PRODUCT_ERR.IMAGE_INVALID, 'File không phải ảnh JPG/PNG/WEBP/GIF hợp lệ');
    return this.images.upload(actor, productId, { ...file, mimetype: detected }, opts);
  }

  /* PATCH /shop/products/:id/images/:imageId — sửa ảnh (kiểm ownership). */
  async updateShop(actor: AuthenticatedActor, shopId: string, productId: string, imageId: string, patch: { colorCode?: string | null; alt?: string | null; isPrimary?: boolean }): Promise<ProductAdminResponse> {
    await this.assertProductOwnership(shopId, productId);
    if (patch.isPrimary === false) {
      const img = await this.prisma.productImage.findFirst({ where: { id: imageId, productId }, select: { isPrimary: true } });
      if (!img) throw new NotFoundException(PRODUCT_ERR.IMAGE_NOT_FOUND, 'Không tìm thấy ảnh');
      if (img.isPrimary) throw new ConflictException(PRODUCT_ERR.IMAGE_PRIMARY_REQUIRED, 'Không thể bỏ ảnh chính — hãy chọn ảnh khác làm ảnh chính');
    }
    return this.images.update(actor, productId, imageId, patch);
  }

  /* PUT /shop/products/:id/images/order — sắp xếp ảnh (kiểm ownership, id không trùng). */
  async reorderShop(actor: AuthenticatedActor, shopId: string, productId: string, imageIds: string[]): Promise<ProductAdminResponse> {
    await this.assertProductOwnership(shopId, productId);
    if (new Set(imageIds).size !== imageIds.length) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Danh sách id ảnh không được trùng');
    return this.images.reorder(actor, productId, imageIds);
  }

  /* DELETE /shop/products/:id/images/:imageId — xoá ảnh (kiểm ownership; không xoá ảnh cuối của sản phẩm đang bán). */
  async removeShop(actor: AuthenticatedActor, shopId: string, productId: string, imageId: string): Promise<ProductAdminResponse> {
    const p = await this.prisma.product.findFirst({ where: { id: productId, shopId, isDeleted: false }, select: { id: true, status: true, _count: { select: { images: true } } } });
    if (!p) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm hoặc không thuộc gian hàng của bạn');
    if (p.status === PRODUCT_STATUS.ACTIVE && p._count.images <= 1) {
      throw new ConflictException(PRODUCT_ERR.IMAGE_REQUIRED, 'Sản phẩm đang bán phải còn ít nhất một ảnh — hãy thêm ảnh khác trước khi xoá ảnh này, hoặc ẩn sản phẩm');
    }
    return this.images.remove(actor, productId, imageId);
  }

  // ---------------------------------------------------------------- helpers

  /* Kiểm product thuộc shop này, nếu không → 404 (không rò rỉ tồn tại). */
  private async assertProductOwnership(shopId: string, productId: string): Promise<void> {
    const p = await this.prisma.product.findFirst({ where: { id: productId, shopId, isDeleted: false }, select: { id: true } });
    if (!p) throw new NotFoundException(PRODUCT_ERR.NOT_FOUND, 'Không tìm thấy sản phẩm hoặc không thuộc gian hàng của bạn');
  }
}
