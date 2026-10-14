import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { PageResponse } from '@common/response/api-response';
import { money } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { PRODUCT_ERR } from '../../foundation/product.constants';
import type { StockMovementResponse, StockReceiptResponse, StockRowResponse } from '../dto/inventory.responses';
import { InventoryService } from './inventory.service';

/*
 * Vendor kho — bọc InventoryService với lọc shopId. Mọi biến thể / phiếu nhập PHẢI thuộc shop của vendor,
 * nếu không trả 404 (không rò rỉ tồn tại của shop khác).
 */
@Injectable()
export class ShopInventoryService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly prisma: PrismaService,
  ) {}

  /*
   * GET /shop/inventory/stock — chỉ biến thể của shop này (có tìm kiếm / lọc sắp hết). shopId xuống tận truy vấn DB nên
   * phân trang + total + tìm kiếm + lowStockOnly đều tính trên đúng tập biến thể của shop (không lọc bộ nhớ sau khi cắt trang).
   */
  async listStockShop(shopId: string, p: { page: number; size: number; q?: string; lowStockOnly?: boolean }): Promise<PageResponse<StockRowResponse>> {
    return this.inventory.listStock({ ...p, shopId });
  }

  /* GET /shop/inventory/stock/:variantId/movements — chỉ movements của variant shop này. */
  async movementsShop(shopId: string, variantId: string, take = 50): Promise<StockMovementResponse[]> {
    await this.assertVariantOwnership(shopId, variantId);
    return this.inventory.movements(variantId, take);
  }

  /* GET /shop/inventory/receipts — chỉ receipts của shop này. */
  async listReceiptsShop(shopId: string, p: { page: number; size: number; status?: string }): Promise<PageResponse<StockReceiptResponse>> {
    // Lấy receipts của shop từ DB trực tiếp (tối ưu)
    const skip = (p.page - 1) * p.size;
    const where = { isDeleted: false, shopId, ...(p.status ? { status: p.status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.stockReceipt.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: p.size, include: { items: true } }),
      this.prisma.stockReceipt.count({ where }),
    ]);
    const responses = items.map((r) => this.toReceipt(r));
    return PageResponse.of(responses, p.page, p.size, total);
  }

  /* GET /shop/inventory/receipts/:id — receipt phải thuộc shop này. */
  async getReceiptShop(shopId: string, id: string): Promise<StockReceiptResponse> {
    const r = await this.prisma.stockReceipt.findFirst({ where: { id, isDeleted: false, shopId }, include: { items: true } });
    if (!r) throw new NotFoundException(PRODUCT_ERR.RECEIPT_NOT_FOUND, 'Không tìm thấy phiếu nhập');
    return this.toReceipt(r);
  }

  /*
   * POST /shop/inventory/receipts — tạo phiếu nhập. shopId đi vào CHÍNH transaction tạo phiếu (cùng mã phiếu + dòng phiếu) và
   * InventoryService kiểm mọi biến thể thuộc shop ngay sau khi khoá dòng → không có phiếu mồ côi shopId=NULL (thành phiếu của sàn),
   * không có khe hở giữa kiểm quyền và ghi.
   */
  async createReceiptShop(actor: AuthenticatedActor | null, shopId: string, input: { supplierName?: string | null; note?: string | null; items: Array<{ variantId: string; quantity: number; unitCost?: string | null }> }): Promise<StockReceiptResponse> {
    return this.inventory.createReceipt(actor, input, { shopId });
  }

  /* POST /shop/inventory/receipts/:id/post — duyệt phiếu (Idempotency-Key). */
  async postReceiptShop(actor: AuthenticatedActor | null, shopId: string, id: string, idempotencyKey?: string | null): Promise<StockReceiptResponse> {
    // Kiểm receipt thuộc shop (sẽ throw 404 nếu không)
    await this.getReceiptShop(shopId, id);
    // Gọi inventory.postReceipt (không phải shop-scoped, nhưng đã verify quyền trên receipt)
    return this.inventory.postReceipt(actor, id, idempotencyKey);
  }

  /* POST /shop/inventory/adjust — điều chỉnh tồn (variant phải thuộc shop). */
  async adjustStockShop(actor: AuthenticatedActor, shopId: string, input: { variantId: string; delta: number; reason: string }): Promise<StockRowResponse> {
    await this.assertVariantOwnership(shopId, input.variantId);
    return this.inventory.adjust(actor, input);
  }

  // ---------------------------------------------------------------- helpers

  private async assertVariantOwnership(shopId: string, variantId: string): Promise<void> {
    const v = await this.prisma.productVariant.findFirst({ where: { id: variantId, shopId, isDeleted: false }, select: { id: true } });
    if (!v) throw new NotFoundException(PRODUCT_ERR.VARIANT_NOT_FOUND, 'Không tìm thấy biến thể hoặc không thuộc gian hàng của bạn');
  }

  private toReceipt(r: { id: string; code: string; supplierName: string | null; note: string | null; status: string; totalCost: { toString(): string }; postedAt: Date | null; createdAt: Date; items: Array<{ variantId: string; sku: string; quantity: number; unitCost: { toString(): string } }> }): StockReceiptResponse {
    return {
      id: r.id,
      code: r.code,
      supplierName: r.supplierName,
      note: r.note,
      status: r.status,
      totalCost: money(r.totalCost.toString()),
      items: r.items.map((i) => ({ variantId: i.variantId, sku: i.sku, quantity: i.quantity, unitCost: money(i.unitCost.toString()) })),
      postedAt: r.postedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
