import { Inject, Injectable, Optional } from '@nestjs/common';
import { LIVE_SOURCE_GATEWAY, type LiveSourceGateway } from '@common/gateway/live-source.gateway';
import type { CartPurchaseSnapshot, LiveCartSource } from '@common/gateway/live-commerce.gateway';
import { IdempotencyService } from '@common/idempotency/idempotency.service';
import { reduceSources, completeCartSources, ordinarySource } from './live-cart.sources';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { INVENTORY_GATEWAY, InventoryGateway } from '@common/gateway/inventory.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { money, MoneyResponse } from '@common/response/money-response';
import { vnd } from '@common/utils/money';
import { ProductQueryApi, VariantSnapshot } from '../product/queryapi/product.queryapi';
import { ShopQueryApi } from '../shop/queryapi/shop.queryapi';
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
  sourceLots?: LiveCartSource[];
  eligibleQuantity?: number;
  variantId: string;
  productId: string;
  slug: string;
  name: string;
  /* PLAN-0014 bước 6+ — gian hàng của dòng này, FE nhóm giỏ theo shop (shopId khớp `shopGroups[].shopId` của /checkout/summary). */
  shopId: string;
  shopSlug: string;
  shopName: string;
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
  lines: Array<{ variantId: string; productId: string; slug: string; name: string; categorySlug: string; imageUrl: string | null; color: string; size: string; sku: string; quantity: number; unitPrice: bigint; lineTotal: bigint; available: number; isSellable: boolean; shopId: string; sourceLots?: LiveCartSource[] }>;
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
    private readonly shops: ShopQueryApi,
    @Inject(INVENTORY_GATEWAY) private readonly inventory: InventoryGateway,
    @Optional() @Inject(LIVE_SOURCE_GATEWAY) private readonly live?: LiveSourceGateway,
  ) {}

  private async cartId(userId: string, tx?: Tx | null): Promise<string> {
    const db = tx ?? this.prisma;
    const c = await db.cart.upsert({ where: { userId }, create: { userId }, update: { version: { increment: 1 } }, select: { id: true } });
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
      return [{ variantId: i.variantId, productId: s.productId, slug: s.slug, name: s.name, categorySlug: s.categorySlug, imageUrl: s.imageUrl, color: s.color, size: s.size, sku: s.sku, quantity: i.quantity, unitPrice, lineTotal: unitPrice * BigInt(i.quantity), available: s.available, isSellable: s.isSellable, shopId: i.shopId, sourceLots: completeCartSources(i.sourceLots,i.quantity,s.productId,i.shopId,i.id) }];
    });
    const sellable = lines.filter((l) => l.isSellable);
    return { userId, lines, subtotal: sellable.reduce((s, l) => s + l.lineTotal, 0n), itemCount: sellable.reduce((n, l) => n + l.quantity, 0) };
  }

  async getCart(userId: string): Promise<CartResponse> {
    const [b, max, threshold, cart] = await Promise.all([this.basket(userId, false), this.maxPerLine(), this.system.settingNumber(SETTING_KEY.SHIPPING_FREE_THRESHOLD), this.prisma.cart.findUnique({ where: { userId }, select: { items: { select: { variantId: true, selected: true } } } })]);
    const selected = new Map((cart?.items ?? []).map((i) => [i.variantId, i.selected]));
    const shopBriefs = await this.shops.findManyBrief(b.lines.map((l) => l.shopId));
    const lines: CartLineResponse[] = b.lines.map((l) => ({
      variantId: l.variantId,
      productId: l.productId,
      slug: l.slug,
      name: l.name,
      shopId: l.shopId,
      shopSlug: shopBriefs.get(l.shopId)?.slug ?? '',
      shopName: shopBriefs.get(l.shopId)?.name ?? '',
      imageUrl: l.imageUrl,
      color: l.color,
      size: l.size,
      sku: l.sku,
      quantity: l.quantity,
      sourceLots: (l.sourceLots ?? []).filter(s=>!!s.sessionId),
      eligibleQuantity: (l.sourceLots ?? []).filter((s) => Date.parse(s.eligibleUntil) > Date.now()).reduce((n, s) => n + s.quantity, 0),
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

  async addItem(userId: string, variantId: string, quantity: number, source?: { sourceGrantId?: string; requestId?: string }): Promise<CartResponse> {
    if (source?.requestId) {
      const previous = await this.prisma.cartMutation.findUnique({ where: { userId_requestId: { userId, requestId: source.requestId } } });
      if (previous) {
        const requestHash = IdempotencyService.hashRequest({ variantId, quantity, sourceGrantId: source.sourceGrantId ?? null });
        if (previous.requestHash !== requestHash) throw new BusinessException('COMMON_IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng cho nội dung khác', 409);
        return this.getCart(userId);
      }
    }
    const [snap, max] = await Promise.all([this.products.variantSnapshots([variantId]).then((m) => m.get(variantId)), this.maxPerLine()]);
    this.assertSellable(snap);
    const shopId = await this.products.getShopId(snap.productId);
    const shopIdVal = shopId ?? '';
    if (source?.sourceGrantId && !source.requestId) throw new BusinessException('CART_REQUEST_ID_REQUIRED', 'Thêm hàng từ live cần mã yêu cầu để thử lại an toàn');
    const grant = source?.sourceGrantId && this.live ? await this.live.verifySource(userId, source.sourceGrantId, snap.productId, quantity) : null;
    if (source?.sourceGrantId && !grant) throw new BusinessException('LIVE_SOURCE_UNAVAILABLE', 'Không xác minh được nguồn hàng từ live', 503);
    await this.prisma.$transaction(async (tx) => {
      const cartId = await this.cartId(userId, tx);
      if (source?.requestId) {
        const requestHash = IdempotencyService.hashRequest({ variantId, quantity, sourceGrantId: source.sourceGrantId ?? null });
        const previous = await tx.cartMutation.findUnique({ where: { userId_requestId: { userId, requestId: source.requestId } } });
        if (previous) { if (previous.requestHash !== requestHash) throw new BusinessException('COMMON_IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng cho nội dung khác', 409); return; }
        await tx.cartMutation.create({ data: { userId, requestId: source.requestId, requestHash } });
      }
      const existing = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
      const total = (existing?.quantity ?? 0) + quantity;
      if (total > max) throw new BusinessException(CART_ERR.QTY_LIMIT, `Mỗi sản phẩm tối đa ${max} cái`);
      if (total > snap.available) throw new BusinessException(CART_ERR.OUT_OF_STOCK, snap.available > 0 ? `Chỉ còn ${snap.available} sản phẩm` : 'Sản phẩm đã hết hàng', 409);
      const sourceLots = completeCartSources(existing?.sourceLots, existing?.quantity ?? 0, snap.productId, shopIdVal,existing?.id);
      if (grant) {
        await tx.cartSourceReceipt.create({ data: { id: grant.sourceGrantId, userId, referenceId: cartId, kind: 'cart' } });
        sourceLots.push({ id: grant.sourceGrantId, sessionId: grant.sessionId, productId: grant.productId, shopId: grant.shopId, quantity, eligibleUntil: grant.eligibleUntil.toISOString() });
      } else sourceLots.push(ordinarySource(quantity, snap.productId, shopIdVal));
      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId, variantId } },
        create: { cartId, variantId, productId: snap.productId, shopId: shopIdVal, quantity, selected: true, sourceLots: JSON.parse(JSON.stringify(sourceLots)) as Prisma.InputJsonValue },
        update: { quantity: total, selected: true, shopId: shopIdVal, sourceLots: JSON.parse(JSON.stringify(sourceLots)) as Prisma.InputJsonValue },
      });
    });
    return this.getCart(userId);
  }

  async updateQuantity(userId: string, variantId: string, quantity: number): Promise<CartResponse> {
    if (quantity <= 0) return this.removeItem(userId, variantId);
    const [snap, max] = await Promise.all([this.products.variantSnapshots([variantId]).then((m) => m.get(variantId)), this.maxPerLine()]);
    this.assertSellable(snap);
    if (quantity > max) throw new BusinessException(CART_ERR.QTY_LIMIT, `Mỗi sản phẩm tối đa ${max} cái`);
    if (quantity > snap.available) throw new BusinessException(CART_ERR.OUT_OF_STOCK, snap.available > 0 ? `Chỉ còn ${snap.available} sản phẩm` : 'Sản phẩm đã hết hàng', 409);
    await this.prisma.$transaction(async (tx) => {
      const cartId = await this.cartId(userId, tx);
      const row = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
      if (!row) throw new NotFoundException(CART_ERR.LINE_NOT_FOUND, 'Sản phẩm không có trong giỏ');
      const sources = reduceSources(completeCartSources(row.sourceLots, row.quantity, row.productId, row.shopId,row.id), Math.max(0, row.quantity - quantity));
      if (quantity > row.quantity) sources.push(ordinarySource(quantity - row.quantity, row.productId, row.shopId));
      await tx.cartItem.update({ where: { id: row.id }, data: { quantity, sourceLots: JSON.parse(JSON.stringify(sources)) as Prisma.InputJsonValue } });
    });
    return this.getCart(userId);
  }

  async setSelected(userId: string, variantId: string, selected: boolean): Promise<CartResponse> {
    await this.prisma.$transaction(async (tx) => { const cartId = await this.cartId(userId, tx); const r = await tx.cartItem.updateMany({ where: { cartId, variantId }, data: { selected } }); if (!r.count) throw new NotFoundException(CART_ERR.LINE_NOT_FOUND, 'Sản phẩm không có trong giỏ'); });
    return this.getCart(userId);
  }

  async removeItem(userId: string, variantId: string): Promise<CartResponse> {
    await this.prisma.$transaction(async (tx) => { const cartId = await this.cartId(userId, tx); await tx.cartItem.deleteMany({ where: { cartId, variantId } }); });
    return this.getCart(userId);
  }

  async clear(userId: string): Promise<CartResponse> {
    await this.prisma.$transaction(async (tx) => { const cartId = await this.cartId(userId, tx); await tx.cartItem.deleteMany({ where: { cartId } }); });
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
        const sources = completeCartSources(existing?.sourceLots, existing?.quantity ?? 0, s.productId, s.shopId,existing?.id);
        const delta = qty - (existing?.quantity ?? 0);
        if (delta > 0) sources.push(ordinarySource(delta, s.productId, s.shopId));
        const kept = delta < 0 ? reduceSources(sources, -delta) : sources;
        await tx.cartItem.upsert({ where: { cartId_variantId: { cartId, variantId: g.variantId } }, create: { cartId, variantId: g.variantId, productId: s.productId, shopId: s.shopId, quantity: qty, selected: true, sourceLots: JSON.parse(JSON.stringify(kept)) as Prisma.InputJsonValue }, update: { quantity: qty, sourceLots: JSON.parse(JSON.stringify(kept)) as Prisma.InputJsonValue } });
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

  async claimIntentSources(userId: string, intentId: string, grants: Array<{ grantId: string; productId: string; quantity: number }>, tx: Tx): Promise<LiveCartSource[]> {
    const out: LiveCartSource[] = [];
    for (const input of grants) {
      if (!this.live) throw new BusinessException('LIVE_SOURCE_UNAVAILABLE', 'Nguồn live chưa sẵn sàng', 503);
      const s = await this.live.verifySource(userId, input.grantId, input.productId, input.quantity);
      await tx.cartSourceReceipt.create({ data: { id: input.grantId, userId, referenceId: intentId, kind: 'intent' } });
      out.push({ id: s.sourceGrantId, sessionId: s.sessionId, shopId: s.shopId, productId: s.productId, quantity: input.quantity, eligibleUntil: s.eligibleUntil.toISOString() });
    }
    return out;
  }

  async consumeSnapshot(userId: string, lines: CartPurchaseSnapshot[], tx: Tx): Promise<void> {
    const cartId = await this.cartId(userId, tx);
    for (const line of [...lines].sort((a,b) => a.variantId.localeCompare(b.variantId))) {
      const row = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId: line.variantId } } });
      if (!row || row.quantity < line.quantity) throw new BusinessException('ORDER_CART_CHANGED', 'Giỏ hàng vừa thay đổi, hãy chọn lại món cần mua', 409);
      const current = completeCartSources(row.sourceLots, row.quantity, row.productId, row.shopId,row.id).map((s) => ({ ...s }));
      let ordinary = line.quantity;
      for (const wanted of line.sourceLots) {
        const s = current.find((s) => s.id === wanted.id);
        if (!s || s.quantity < wanted.quantity) throw new BusinessException('ORDER_CART_CHANGED', 'Nguồn ưu đãi trong giỏ đã thay đổi', 409);
        s.quantity -= wanted.quantity;
        ordinary -= wanted.quantity;
      }
      for (const s of current) {
        if (s.sessionId || ordinary <= 0) continue;
        const take = Math.min(s.quantity, ordinary); s.quantity -= take; ordinary -= take;
      }
      if (ordinary !== 0) throw new BusinessException('ORDER_CART_CHANGED', 'Số lượng trong giỏ vừa thay đổi', 409);
      if (row.quantity === line.quantity) await tx.cartItem.delete({ where: { id: row.id } });
      else await tx.cartItem.update({ where: { id: row.id }, data: { quantity: row.quantity - line.quantity, sourceLots: JSON.parse(JSON.stringify(current.filter((s) => s.quantity > 0))) as Prisma.InputJsonValue } });
    }
  }

  private assertSellable(snap: VariantSnapshot | undefined): asserts snap is VariantSnapshot {
    if (!snap) throw new NotFoundException(CART_ERR.VARIANT_NOT_FOUND, 'Không tìm thấy biến thể sản phẩm');
    if (!snap.isSellable) throw new BusinessException(CART_ERR.NOT_SELLABLE, 'Sản phẩm hiện không bán', 409);
  }
}
