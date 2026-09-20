import { Injectable } from '@nestjs/common';
import { BusinessException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { ProductCardResponse, ProductQueryApi } from '../product/queryapi/product.queryapi';

const MAX_WISHLIST = 100;

/* Yêu thích theo user — trả thẻ sản phẩm (đang bán) theo thứ tự thêm mới nhất trước; sản phẩm ẩn tự biến mất. */
@Injectable()
export class WishlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductQueryApi,
  ) {}

  async list(userId: string): Promise<{ productIds: string[]; products: ProductCardResponse[] }> {
    const rows = await this.prisma.wishlist.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { productId: true } });
    const ids = rows.map((r) => r.productId);
    return { productIds: ids, products: await this.products.cardsByIds(ids) };
  }

  async ids(userId: string): Promise<string[]> {
    return (await this.prisma.wishlist.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { productId: true } })).map((r) => r.productId);
  }

  async add(userId: string, productId: string): Promise<string[]> {
    const p = await this.products.findProductBrief(productId);
    if (!p || p.status !== 'active') throw new BusinessException('CART_WISHLIST_PRODUCT_INVALID', 'Sản phẩm không tồn tại hoặc đã ngừng bán');
    if ((await this.prisma.wishlist.count({ where: { userId } })) >= MAX_WISHLIST) throw new BusinessException('CART_WISHLIST_LIMIT', `Danh sách yêu thích tối đa ${MAX_WISHLIST} sản phẩm`);
    await this.prisma.wishlist.upsert({ where: { userId_productId: { userId, productId } }, create: { userId, productId }, update: {} });
    return this.ids(userId);
  }

  async remove(userId: string, productId: string): Promise<string[]> {
    await this.prisma.wishlist.deleteMany({ where: { userId, productId } });
    return this.ids(userId);
  }

  async toggle(userId: string, productId: string): Promise<{ added: boolean; productIds: string[] }> {
    const exists = await this.prisma.wishlist.findUnique({ where: { userId_productId: { userId, productId } } });
    if (exists) return { added: false, productIds: await this.remove(userId, productId) };
    return { added: true, productIds: await this.add(userId, productId) };
  }
}
