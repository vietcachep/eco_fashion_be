import { Injectable, Logger } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { InsufficientStockError, StockLine } from '@common/gateway/inventory.gateway';
import { IdempotencyService } from '@common/idempotency/idempotency.service';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import { money } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { vnd } from '@common/utils/money';
import { ProductAuditLogService } from '../../audit/product-audit-log.service';
import { LOW_STOCK_THRESHOLD, PRODUCT_AUDIT, PRODUCT_ERR, PRODUCT_EVENT, RECEIPT_STATUS, STOCK_MOVE } from '../../foundation/product.constants';
import { ProductOutboxService } from '../../outbox/product-outbox.service';
import { ProductRepository } from '../../product/repository/product.repository';
import { ProductQueryService } from '../../product/service/product-query.service';
import { StockMovementResponse, StockReceiptResponse, StockRowResponse } from '../dto/inventory.responses';
import { InventoryRepository } from '../repository/inventory.repository';

type Ref = { type: string; id: string };

/*
 * Tồn kho (AGENTS.md — Inventory/Transaction Rule): mọi biến động đi qua đây, trong transaction, dòng biến thể bị khoá
 * FOR UPDATE theo thứ tự id; mỗi biến động ghi sổ kho `stock_movements`. Ba đường:
 *  - Quản trị: phiếu nhập (draft → posted với Idempotency-Key), điều chỉnh kiểm kê (±, có lý do).
 *  - Gateway cho order: reserve (giữ) / release (nhả) / commit (bán: trừ stock lẫn reserved) / restock (trả hàng).
 * Thiếu hàng → InsufficientStockError (danh sách thiếu) để order/cart trả 409 rõ ràng. Sau commit: xoá cache chi tiết
 * sản phẩm; tồn ≤ ngưỡng → outbox STOCK_LOW (thông báo nhân viên kho).
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: InventoryRepository,
    private readonly products: ProductRepository,
    private readonly query: ProductQueryService,
    private readonly audit: ProductAuditLogService,
    private readonly outbox: ProductOutboxService,
  ) {}

  // ---------------------------------------------------------------- gateway (order/cart gọi trong tx của họ)

  async availableOf(variantIds: string[]): Promise<Map<string, number>> {
    return this.repo.availableOf(variantIds);
  }

  async reserve(lines: StockLine[], ref: Ref, tx: Tx): Promise<void> {
    const locked = await this.lockAndCheck(lines, tx, (v, q) => v.stock - v.reserved >= q);
    for (const { v, q } of locked) {
      await this.repo.setStock(v.id, v.stock, v.reserved + q, tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.RESERVE, quantity: -q, stockAfter: v.stock, refType: ref.type, refId: ref.id, note: null, actorUserId: null }, tx);
    }
    await this.afterStockChange(locked.map((l) => l.v.productId), locked.map((l) => ({ ...l.v, reserved: l.v.reserved + l.q })), tx);
  }

  async release(lines: StockLine[], ref: Ref, tx: Tx): Promise<void> {
    const locked = await this.lockAndCheck(lines, tx, () => true);
    for (const { v, q } of locked) {
      await this.repo.setStock(v.id, v.stock, Math.max(0, v.reserved - q), tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.RELEASE, quantity: q, stockAfter: v.stock, refType: ref.type, refId: ref.id, note: null, actorUserId: null }, tx);
    }
    await this.afterStockChange(locked.map((l) => l.v.productId), [], tx);
  }

  /* Bán thật: trừ cả stock lẫn reserved (hàng đã giữ trước đó). Chưa giữ (COD xác nhận thẳng) thì chỉ cần đủ stock. */
  async commit(lines: StockLine[], ref: Ref, tx: Tx): Promise<void> {
    const locked = await this.lockAndCheck(lines, tx, (v, q) => v.stock >= q);
    for (const { v, q } of locked) {
      const stock = v.stock - q;
      await this.repo.setStock(v.id, stock, Math.max(0, v.reserved - q), tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.SALE, quantity: -q, stockAfter: stock, refType: ref.type, refId: ref.id, note: null, actorUserId: null }, tx);
    }
    await this.afterStockChange(locked.map((l) => l.v.productId), locked.map((l) => ({ ...l.v, stock: l.v.stock - l.q, reserved: Math.max(0, l.v.reserved - l.q) })), tx);
  }

  async restock(lines: StockLine[], ref: Ref, tx: Tx): Promise<void> {
    const locked = await this.lockAndCheck(lines, tx, () => true);
    for (const { v, q } of locked) {
      await this.repo.setStock(v.id, v.stock + q, v.reserved, tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.RETURN, quantity: q, stockAfter: v.stock + q, refType: ref.type, refId: ref.id, note: null, actorUserId: null }, tx);
    }
    await this.afterStockChange(locked.map((l) => l.v.productId), [], tx);
  }

  // ---------------------------------------------------------------- quản trị

  async listStock(p: { page: number; size: number; q?: string; lowStockOnly?: boolean }): Promise<PageResponse<StockRowResponse>> {
    const { items, total } = await this.repo.listStock({ skip: (p.page - 1) * p.size, take: p.size, q: p.q, lowStockOnly: p.lowStockOnly, threshold: LOW_STOCK_THRESHOLD });
    return PageResponse.of(items.map((v) => InventoryService.toStockRow(v)), p.page, p.size, total);
  }

  static toStockRow(v: { id: string; sku: string; colorName: string; sizeCode: string; stock: number; reserved: number; isActive: boolean; product: { id: string; name: string; slug: string; status: string } }): StockRowResponse {
    return {
      variantId: v.id,
      productId: v.product.id,
      productName: v.product.name,
      productSlug: v.product.slug,
      productStatus: v.product.status,
      sku: v.sku,
      color: v.colorName,
      size: v.sizeCode,
      stock: v.stock,
      reserved: v.reserved,
      available: Math.max(0, v.stock - v.reserved),
      isActive: v.isActive,
      isLow: v.stock <= LOW_STOCK_THRESHOLD,
    };
  }

  async movements(variantId: string, take = 50): Promise<StockMovementResponse[]> {
    return (await this.repo.listMovements(variantId, take)).map((m) => ({ id: m.id, type: m.type, quantity: m.quantity, stockAfter: m.stockAfter, refType: m.refType, refId: m.refId, note: m.note, createdAt: m.createdAt.toISOString() }));
  }

  async listReceipts(p: { page: number; size: number; status?: string }): Promise<PageResponse<StockReceiptResponse>> {
    const { items, total } = await this.repo.listReceipts((p.page - 1) * p.size, p.size, p.status);
    return PageResponse.of(items.map((r) => this.toReceipt(r)), p.page, p.size, total);
  }

  async getReceipt(id: string): Promise<StockReceiptResponse> {
    const r = await this.repo.findReceipt(id);
    if (!r) throw new NotFoundException(PRODUCT_ERR.RECEIPT_NOT_FOUND, 'Không tìm thấy phiếu nhập');
    return this.toReceipt(r);
  }

  /* Lập phiếu (nháp): kiểm biến thể tồn tại, gộp dòng trùng; chưa đụng tồn kho. */
  async createReceipt(actor: AuthenticatedActor | null, input: { supplierName?: string | null; note?: string | null; items: Array<{ variantId: string; quantity: number; unitCost?: string | null }> }): Promise<StockReceiptResponse> {
    const merged = new Map<string, { quantity: number; unitCost: bigint }>();
    for (const i of input.items) {
      const cur = merged.get(i.variantId);
      merged.set(i.variantId, { quantity: (cur?.quantity ?? 0) + i.quantity, unitCost: i.unitCost ? vnd(i.unitCost) : (cur?.unitCost ?? 0n) });
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const variants = await this.repo.lockVariants([...merged.keys()], tx);
      const missing = [...merged.keys()].filter((id) => !variants.some((v) => v.id === id));
      if (missing.length > 0) throw new NotFoundException(PRODUCT_ERR.VARIANT_NOT_FOUND, `Biến thể không tồn tại: ${missing.join(', ')}`);
      const items = variants.map((v) => ({ variantId: v.id, sku: v.sku, quantity: merged.get(v.id)!.quantity, unitCost: merged.get(v.id)!.unitCost }));
      const totalCost = items.reduce((s, i) => s + BigInt(i.quantity) * i.unitCost, 0n);
      const code = await this.repo.nextReceiptCode(tx);
      const r = await this.repo.createReceipt({ code, supplierName: input.supplierName ?? null, note: input.note ?? null, totalCost, createdBy: actor?.userId ?? null, items }, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.RECEIPT_CREATED, entityType: 'stock_receipt', entityId: r.id, entityCode: code, after: { items: items.length, totalCost: totalCost.toString() } });
      return r.id;
    });
    return this.getReceipt(id);
  }

  /*
   * Duyệt phiếu → cộng tồn. Idempotency-Key (bảng product.idempotency_keys): duyệt 2 lần cùng key → trả lại kết quả cũ,
   * KHÔNG cộng tồn 2 lần; không có key thì vẫn an toàn nhờ khoá dòng + kiểm status=draft.
   */
  async postReceipt(actor: AuthenticatedActor | null, id: string, idempotencyKey?: string | null): Promise<StockReceiptResponse> {
    const result = await this.prisma.$transaction(async (tx) => {
      const idem = idempotencyKey
        ? await IdempotencyService.begin<StockReceiptResponse>(tx.productIdempotencyKey, { scope: 'stock-receipt-post', actorKey: actor?.userId ?? 'system', key: idempotencyKey, requestHash: IdempotencyService.hashRequest({ id }), ttlHours: 24 })
        : null;
      if (idem?.replay) return idem.replay;
      const head = await this.repo.findReceiptForUpdate(id, tx);
      if (!head) throw new NotFoundException(PRODUCT_ERR.RECEIPT_NOT_FOUND, 'Không tìm thấy phiếu nhập');
      if (head.status !== RECEIPT_STATUS.DRAFT) throw new BusinessException(PRODUCT_ERR.RECEIPT_NOT_DRAFT, `Phiếu đang ở trạng thái ${head.status}, không duyệt được`);
      const r = (await this.repo.findReceipt(id, tx))!;
      const locked = await this.repo.lockVariants(r.items.map((i) => i.variantId), tx);
      for (const item of r.items) {
        const v = locked.find((x) => x.id === item.variantId);
        if (!v) throw new NotFoundException(PRODUCT_ERR.VARIANT_NOT_FOUND, `Biến thể ${item.sku} không còn`);
        const stock = v.stock + item.quantity;
        await this.repo.setStock(v.id, stock, v.reserved, tx);
        await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.RECEIPT, quantity: item.quantity, stockAfter: stock, refType: 'stock_receipt', refId: r.code, note: r.supplierName, actorUserId: actor?.userId ?? null }, tx);
      }
      await this.repo.markReceipt(id, RECEIPT_STATUS.POSTED, actor?.userId ?? 'system', tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.RECEIPT_POSTED, entityType: 'stock_receipt', entityId: id, entityCode: r.code, after: { items: r.items.map((i) => ({ sku: i.sku, quantity: i.quantity })) }, idempotencyKey: idempotencyKey ?? null });
      await this.afterStockChange(locked.map((v) => v.productId), [], tx);
      const response = this.toReceipt((await this.repo.findReceipt(id, tx))!);
      if (idem) await idem.complete(200, response, id);
      return response;
    });
    this.logger.log({ receiptId: id, code: result.code, by: actor?.userId }, 'Đã duyệt phiếu nhập kho');
    return result;
  }

  async adjust(actor: AuthenticatedActor, input: { variantId: string; delta: number; reason: string }): Promise<StockRowResponse> {
    if (input.delta === 0) throw new BusinessException(PRODUCT_ERR.ADJUST_INVALID, 'Số lượng điều chỉnh phải khác 0');
    await this.prisma.$transaction(async (tx) => {
      const [v] = await this.repo.lockVariants([input.variantId], tx);
      if (!v) throw new NotFoundException(PRODUCT_ERR.VARIANT_NOT_FOUND, 'Không tìm thấy biến thể');
      const stock = v.stock + input.delta;
      if (stock < v.reserved) throw new BusinessException(PRODUCT_ERR.ADJUST_INVALID, `Không thể giảm dưới số đang giữ cho đơn (${v.reserved})`);
      await this.repo.setStock(v.id, stock, v.reserved, tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.ADJUST, quantity: input.delta, stockAfter: stock, refType: 'adjust', refId: null, note: input.reason, actorUserId: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.STOCK_ADJUSTED, entityType: 'product_variant', entityId: v.id, entityCode: v.sku, before: { stock: v.stock }, after: { stock, delta: input.delta, reason: input.reason } });
      await this.afterStockChange([v.productId], [{ ...v, stock }], tx);
    });
    const row = await this.repo.findStockRow(input.variantId);
    if (!row) throw new NotFoundException(PRODUCT_ERR.VARIANT_NOT_FOUND, 'Không tìm thấy biến thể');
    return InventoryService.toStockRow(row);
  }

  // ---------------------------------------------------------------- helpers

  private async lockAndCheck(lines: StockLine[], tx: Tx, ok: (v: { stock: number; reserved: number }, q: number) => boolean) {
    const merged = new Map<string, number>();
    for (const l of lines) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity);
    const locked = await this.repo.lockVariants([...merged.keys()], tx);
    const shortages = [];
    const out = [];
    for (const [variantId, q] of merged) {
      const v = locked.find((x) => x.id === variantId);
      if (!v || !v.isActive) {
        shortages.push({ variantId, requested: q, available: 0 });
        continue;
      }
      if (!ok(v, q)) shortages.push({ variantId, requested: q, available: Math.max(0, v.stock - v.reserved) });
      else out.push({ v, q });
    }
    if (shortages.length > 0) throw new InsufficientStockError(shortages);
    return out;
  }

  /* Sau khi đổi tồn: xoá cache chi tiết các sản phẩm liên quan (slug) + outbox STOCK_LOW cho biến thể chạm ngưỡng. */
  private async afterStockChange(productIds: string[], after: Array<{ id: string; sku: string; productId: string; stock: number; reserved: number }>, tx: Tx): Promise<void> {
    for (const v of after) {
      if (v.stock - v.reserved <= LOW_STOCK_THRESHOLD) {
        await this.outbox.publish(tx, { eventType: PRODUCT_EVENT.STOCK_LOW, aggregateType: 'product_variant', aggregateId: v.id, payload: { variantId: v.id, sku: v.sku, productId: v.productId, available: v.stock - v.reserved } });
      }
    }
    const unique = [...new Set(productIds)];
    const rows = unique.length > 0 ? await tx.product.findMany({ where: { id: { in: unique } }, select: { slug: true } }) : [];
    // Cache là ngoài transaction — xoá sau commit vẫn đúng vì đọc lại sẽ thấy dữ liệu mới; ở đây xoá ngay cũng an toàn (TTL ngắn).
    for (const r of rows) await this.query.invalidateDetail(r.slug);
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
