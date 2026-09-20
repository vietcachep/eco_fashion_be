import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { INVENTORY_GATEWAY, InventoryGateway } from '@common/gateway/inventory.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { money, MoneyResponse } from '@common/response/money-response';
import { vnd } from '@common/utils/money';
import { ProductQueryApi, VariantSnapshot } from '../product/queryapi/product.queryapi';
import { SETTING_KEY } from '../system/enums/setting-keys';
import { SystemQueryApi } from '../system/queryapi/system.queryapi';

export const CART_ERR = {
  VARIANT_NOT_FOUND: 'CART_VARIANT_NOT_FOUND',
  NOT_SELLABLE: 'CART_NOT_SELLABLE',
  OUT_OF_STOCK: 'CART_OUT_OF_STOCK',
  LINE_NOT_FOUND: 'CART_LINE_NOT_FOUND',
  QTY_LIMIT: 'CART_QTY_LIMIT',
} as const;

/* Dòng giỏ như FE `CartLine` + cảnh báo tồn (giá/tồn đọc SỐNG từ product, không snapshot). */
export interface CartLineResponse {
  variantId: string;
  productId: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  color: string;
  size: string;
  sku: string;
  quantity: number;
  unitPrice: MoneyResponse;
  lineTotal: MoneyResponse;
  /* Tối đa có thể mua = min(tồn có thể bán, hạn mức mỗi dòng) */
  maxQuantity: number;
  selected: boolean;
  /* ok | low_stock (quantity > tồn) | unavailable (ngừng bán) */
  status: 'ok' | 'low_stock' | 'unavailable';
}

export interface CartResponse {
  lines: CartLineResponse[];
  itemCount: number;
  selectedCount: number;
  subtotal: MoneyResponse;
  /* Ngưỡng freeship để FE hiện "mua thêm X để freeship" */
  freeShippingThreshold: MoneyResponse;
}

/* Giỏ tối giản cho promotion/order (tiền bigint) — CartQueryApi trả. */
export interface Basket {
  userId: string;
  lines: Array<{ variantId: string; productId: string; slug: string; name: string; categorySlug: string; imageUrl: string | null; color: string; size: string; sku: string; quantity: number; unitPrice: bigint; lineTotal: bigint; available: number; isSellable: boolean }>;
  subtotal: bigint;
  itemCount: number;
}

/*
 * Giỏ theo user (PLAN-0005). Khoá dòng = biến thể (màu×size). Mọi đọc đều "hồi sinh" dòng bằng giá/tồn hiện tại;
 * khách chưa đăng nhập giữ giỏ ở FE, đăng nhập → `merge`. Không tính khuyến mãi/ship ở đây (order làm).
 */
@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductQueryApi,
    private readonly system: SystemQueryApi,
    @Inject(INVENTORY_GATEWAY) private readonly inventory: InventoryGateway,
  ) {}

  private async cartId(userId: string, tx?: Tx | null): Promise<string> {
    const db = tx ?? this.prisma;
    const c = await db.cart.upsert({ where: { userId }, create: { userId }, update: {}, select: { id: true } });
    return c.id;
  }

  private async maxPerLine(): Promise<number> {
    return this.system.settingNumber(SETTING_KEY.CART_MAX_QTY_PER_LINE);
  }

  async basket(userId: string, onlySelected: boolean): Promise<Basket> {
    const cart = await this.prisma.cart.findUnique({ where: { userId }, select: { items: { orderBy: { createdAt: 'asc' } } } });
    const items = (cart?.items ?? []).filter((i) => !onlySelected || i.selected);
    const snaps = await this.products.variantSnapshots(items.map((i) => i.variantId));
    const lines = items.flatMap((i) => {
      const s = snaps.get(i.variantId);
      if (!s) return [];
      const unitPrice = vnd(s.unitPrice);
      return [{ variantId: i.variantId, productId: s.productId, slug: s.slug, name: s.name, categorySlug: s.categorySlug, imageUrl: s.imageUrl, color: s.color, size: s.size, sku: s.sku, quantity: i.quantity, unitPrice, lineTotal: unitPrice * BigInt(i.quantity), available: s.available, isSellable: s.isSellable }];
    });
    const sellable = lines.filter((l) => l.isSellable);
    return { userId, lines, subtotal: sellable.reduce((s, l) => s + l.lineTotal, 0n), itemCount: sellable.reduce((n, l) => n + l.quantity, 0) };
  }

  async getCart(userId: string): Promise<CartResponse> {
    const [b, max, threshold, cart] = await Promise.all([this.basket(userId, false), this.maxPerLine(), this.system.settingNumber(SETTING_KEY.SHIPPING_FREE_THRESHOLD), this.prisma.cart.findUnique({ where: { userId }, select: { items: { select: { variantId: true, selected: true } } } })]);
    const selected = new Map((cart?.items ?? []).map((i) => [i.variantId, i.selected]));
    const lines: CartLineResponse[] = b.lines.map((l) => ({
      variantId: l.variantId,
      productId: l.productId,
      slug: l.slug,
      name: l.name,
      imageUrl: l.imageUrl,
      color: l.color,
      size: l.size,
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: money(l.unitPrice),
      lineTotal: money(l.lineTotal),
      maxQuantity: Math.min(l.available, max),
      selected: selected.get(l.variantId) ?? true,
      status: !l.isSellable ? 'unavailable' : l.quantity > l.available ? 'low_stock' : 'ok',
    }));
    const sel = lines.filter((l) => l.selected && l.status !== 'unavailable');
    return {
      lines,
      itemCount: lines.reduce((n, l) => n + l.quantity, 0),
      selectedCount: sel.reduce((n, l) => n + l.quantity, 0),
      subtotal: money(sel.reduce((s, l) => s + vnd(l.lineTotal.amount), 0n)),
      freeShippingThreshold: money(threshold),
    };
  }

  async addItem(userId: string, variantId: string, quantity: number): Promise<CartResponse> {
    const [snap, max] = await Promise.all([this.products.variantSnapshots([variantId]).then((m) => m.get(variantId)), this.maxPerLine()]);
    this.assertSellable(snap);
    await this.prisma.$transaction(async (tx) => {
      const cartId = await this.cartId(userId, tx);
      const existing = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
      const total = (existing?.quantity ?? 0) + quantity;
      if (total > max) throw new BusinessException(CART_ERR.QTY_LIMIT, `Mỗi sản phẩm tối đa ${max} cái`);
      if (total > snap.available) throw new BusinessException(CART_ERR.OUT_OF_STOCK, snap.available > 0 ? `Chỉ còn ${snap.available} sản phẩm` : 'Sản phẩm đã hết hàng', 409);
      await tx.cartItem.upsert({ where: { cartId_variantId: { cartId, variantId } }, create: { cartId, variantId, productId: snap.productId, quantity, selected: true }, update: { quantity: total, selected: true } });
    });
    return this.getCart(userId);
  }

  async updateQuantity(userId: string, variantId: string, quantity: number): Promise<CartResponse> {
    if (quantity <= 0) return this.removeItem(userId, variantId);
    const [snap, max] = await Promise.all([this.products.variantSnapshots([variantId]).then((m) => m.get(variantId)), this.maxPerLine()]);
    this.assertSellable(snap);
    if (quantity > max) throw new BusinessException(CART_ERR.QTY_LIMIT, `Mỗi sản phẩm tối đa ${max} cái`);
    if (quantity > snap.available) throw new BusinessException(CART_ERR.OUT_OF_STOCK, snap.available > 0 ? `Chỉ còn ${snap.available} sản phẩm` : 'Sản phẩm đã hết hàng', 409);
    const cartId = await this.cartId(userId);
    const r = await this.prisma.cartItem.updateMany({ where: { cartId, variantId }, data: { quantity } });
    if (r.count === 0) throw new NotFoundException(CART_ERR.LINE_NOT_FOUND, 'Sản phẩm không có trong giỏ');
    return this.getCart(userId);
  }

  async setSelected(userId: string, variantId: string, selected: boolean): Promise<CartResponse> {
    const cartId = await this.cartId(userId);
    const r = await this.prisma.cartItem.updateMany({ where: { cartId, variantId }, data: { selected } });
    if (r.count === 0) throw new NotFoundException(CART_ERR.LINE_NOT_FOUND, 'Sản phẩm không có trong giỏ');
    return this.getCart(userId);
  }

  async removeItem(userId: string, variantId: string): Promise<CartResponse> {
    const cartId = await this.cartId(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId, variantId } });
    return this.getCart(userId);
  }

  async clear(userId: string): Promise<CartResponse> {
    const cartId = await this.cartId(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId } });
    return this.getCart(userId);
  }

  /* Đăng nhập: gộp giỏ FE (guest) vào giỏ server — cộng dồn, cắt theo tồn/hạn mức, bỏ dòng không bán. */
  async merge(userId: string, guest: Array<{ variantId: string; quantity: number }>): Promise<CartResponse> {
    const ids = [...new Set(guest.map((g) => g.variantId))];
    const [snaps, max] = await Promise.all([this.products.variantSnapshots(ids), this.maxPerLine()]);
    await this.prisma.$transaction(async (tx) => {
      const cartId = await this.cartId(userId, tx);
      for (const g of guest) {
        const s = snaps.get(g.variantId);
        if (!s || !s.isSellable || s.available <= 0) continue;
        const existing = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId: g.variantId } } });
        const qty = Math.min((existing?.quantity ?? 0) + g.quantity, max, s.available);
        await tx.cartItem.upsert({ where: { cartId_variantId: { cartId, variantId: g.variantId } }, create: { cartId, variantId: g.variantId, productId: s.productId, quantity: qty, selected: true }, update: { quantity: qty } });
      }
    });
    return this.getCart(userId);
  }

  /* CartGateway: order xoá dòng đã mua trong tx tạo đơn. */
  async removeLines(userId: string, variantIds: string[], tx?: Tx): Promise<void> {
    const db = tx ?? this.prisma;
    const cart = await db.cart.findUnique({ where: { userId }, select: { id: true } });
    if (!cart) return;
    await db.cartItem.deleteMany({ where: { cartId: cart.id, variantId: { in: variantIds } } });
  }

  private assertSellable(snap: VariantSnapshot | undefined): asserts snap is VariantSnapshot {
    if (!snap) throw new NotFoundException(CART_ERR.VARIANT_NOT_FOUND, 'Không tìm thấy biến thể sản phẩm');
    if (!snap.isSellable) throw new BusinessException(CART_ERR.NOT_SELLABLE, 'Sản phẩm hiện không bán', 409);
  }
}
