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
import { CatalogQueryApi } from '../../../catalog/queryapi/catalog.queryapi';
import { ProductAuditLogService } from '../../audit/product-audit-log.service';
import { LOW_STOCK_THRESHOLD, PRODUCT_AUDIT, PRODUCT_ERR, PRODUCT_EVENT, RECEIPT_STATUS, STOCK_MOVE } from '../../foundation/product.constants';
import { ProductOutboxService } from '../../outbox/product-outbox.service';
import { ProductRepository } from '../../product/repository/product.repository';
import { ProductQueryService } from '../../product/service/product-query.service';
import { dynamicColorSize } from '../../queryapi/variant-label';
import { StockMovementResponse, StockReceiptResponse, StockRowResponse } from '../dto/inventory.responses';
import { InventoryRepository } from '../repository/inventory.repository';

type Ref = { type: string; id: string };

/* Trần an toàn: stock là int4 (≈2,1 tỷ) và total_cost là numeric(14,0) — vượt là lỗi số học DB (500) thay vì lỗi nghiệp vụ. */
const MAX_STOCK = 1_000_000_000;
const MAX_RECEIPT_TOTAL = 99_999_999_999_999n;

/* Dòng bảng tồn đọc từ DB (kèm trục biến thể ngành dynamic để dựng nhãn color/size). */
type StockRowSource = Parameters<typeof InventoryService.toStockRow>[0];

/*
 * Tồn kho (AGENTS.md — Inventory/Transaction Rule): mọi biến động đi qua đây, trong transaction, dòng biến thể bị khoá
 * FOR UPDATE theo thứ tự id; mỗi biến động ghi sổ kho `stock_movements`. Ba đường:
 *  - Quản trị: phiếu nhập (draft → posted với Idempotency-Key), điều chỉnh kiểm kê (±, có lý do).
 *  - Gateway cho order: reserve (giữ) / release (nhả) / commit (bán: trừ stock lẫn reserved) / restock (trả hàng).
 * Thiếu hàng → InsufficientStockError (danh sách thiếu); gateway giữ nguyên lỗi này cho reserve (placeOrder bắt để trả
 * ORDER_OUT_OF_STOCK 409) và đổi thành BusinessException 409 PRODUCT_INSUFFICIENT_STOCK cho commit/release/restock.
 * Sau commit: xoá cache chi tiết sản phẩm; tồn ≤ ngưỡng → outbox STOCK_LOW (thông báo chủ shop).
 *
 * Biến thể bị tắt / xoá mềm SAU khi đơn đã giữ hàng: chỉ `reserve` (đơn mới) đòi biến thể còn bán. release / restock / commit
 * thao tác trên đơn đã tồn tại nên vẫn khoá được biến thể không-active và đã xoá mềm — nếu không, đơn mở không xác nhận/huỷ
 * được và `reserved` kẹt vĩnh viễn.
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
    private readonly catalog: CatalogQueryApi,
  ) {}

  // ---------------------------------------------------------------- gateway (order/cart gọi trong tx của họ)

  async availableOf(variantIds: string[]): Promise<Map<string, number>> {
    return this.repo.availableOf(variantIds);
  }

  /* Giữ hàng cho đơn MỚI — chỉ biến thể còn bán (chưa xoá mềm, đang bật) và đủ tồn khả dụng. */
  async reserve(lines: StockLine[], ref: Ref, tx: Tx): Promise<void> {
    const locked = await this.lockAndCheck(lines, tx, (v, q) => v.stock - v.reserved >= q, { sellableOnly: true });
    for (const { v, q } of locked) {
      await this.repo.setStock(v.id, v.stock, v.reserved + q, tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.RESERVE, quantity: -q, stockAfter: v.stock, refType: ref.type, refId: ref.id, note: null, actorUserId: null }, tx);
    }
    await this.afterStockChange(locked.map((l) => l.v.productId), locked.map((l) => ({ ...l.v, reserved: l.v.reserved + l.q })), tx);
  }

  /* Nhả hàng đã giữ (huỷ/quá hạn) — không bao giờ từ chối: biến thể tắt/xoá mềm vẫn nhả được; dòng không còn trong DB thì bỏ qua. */
  async release(lines: StockLine[], ref: Ref, tx: Tx): Promise<void> {
    const locked = await this.lockAndCheck(lines, tx, () => true, { sellableOnly: false, skipMissing: true });
    for (const { v, q } of locked) {
      await this.repo.setStock(v.id, v.stock, Math.max(0, v.reserved - q), tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.RELEASE, quantity: q, stockAfter: v.stock, refType: ref.type, refId: ref.id, note: null, actorUserId: null }, tx);
    }
    await this.afterStockChange(locked.map((l) => l.v.productId), [], tx);
  }

  /* Bán thật: trừ cả stock lẫn reserved (hàng đã giữ trước đó). Chưa giữ (COD xác nhận thẳng) thì chỉ cần đủ stock. */
  async commit(lines: StockLine[], ref: Ref, tx: Tx): Promise<void> {
    // Hàng đã bán/giữ cho đơn có sẵn: biến thể sau đó bị tắt hay xoá mềm KHÔNG được chặn việc xác nhận đơn (chỉ thiếu tồn thật mới chặn).
    const locked = await this.lockAndCheck(lines, tx, (v, q) => v.stock >= q, { sellableOnly: false });
    for (const { v, q } of locked) {
      const stock = v.stock - q;
      await this.repo.setStock(v.id, stock, Math.max(0, v.reserved - q), tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.SALE, quantity: -q, stockAfter: stock, refType: ref.type, refId: ref.id, note: null, actorUserId: null }, tx);
    }
    await this.afterStockChange(locked.map((l) => l.v.productId), locked.map((l) => ({ ...l.v, stock: l.v.stock - l.q, reserved: Math.max(0, l.v.reserved - l.q) })), tx);
  }

  /* Hoàn hàng về kho (huỷ đơn đã trừ kho / đổi trả) — như release: không bao giờ từ chối vì biến thể tắt/xoá mềm. */
  async restock(lines: StockLine[], ref: Ref, tx: Tx): Promise<void> {
    const locked = await this.lockAndCheck(lines, tx, () => true, { sellableOnly: false, skipMissing: true });
    for (const { v, q } of locked) {
      await this.repo.setStock(v.id, v.stock + q, v.reserved, tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.RETURN, quantity: q, stockAfter: v.stock + q, refType: ref.type, refId: ref.id, note: null, actorUserId: null }, tx);
    }
    await this.afterStockChange(locked.map((l) => l.v.productId), [], tx);
  }

  // ---------------------------------------------------------------- quản trị

  /* `shopId` (vendor) lọc ở DB cùng truy vấn phân trang + count; bỏ trống = toàn sàn (nhân viên sàn). */
  async listStock(p: { page: number; size: number; q?: string; lowStockOnly?: boolean; shopId?: string }): Promise<PageResponse<StockRowResponse>> {
    const { items, total } = await this.repo.listStock({ skip: (p.page - 1) * p.size, take: p.size, q: p.q, lowStockOnly: p.lowStockOnly, threshold: LOW_STOCK_THRESHOLD, shopId: p.shopId });
    return PageResponse.of(await this.toStockRows(items), p.page, p.size, total);
  }

  /* Một lần tra mã thuộc tính cho cả trang (chỉ khi có biến thể dynamic) để dựng nhãn color/size — không N+1. */
  private async toStockRows(rows: StockRowSource[]): Promise<StockRowResponse[]> {
    const attrIds = [...new Set(rows.flatMap((r) => r.options.map((o) => o.attributeId)))];
    const codes = attrIds.length > 0 ? await this.catalog.findDynamicAttributeNamesByIds(attrIds) : new Map<string, { id: string; code: string; name: string }>();
    return rows.map((r) => InventoryService.toStockRow(r, codes));
  }

  /* Biến thể dynamic không có colorName/sizeCode: color/size lấy theo quy ước chung ở queryapi/variant-label.ts. */
  static toStockRow(v: { id: string; sku: string; colorName: string | null; sizeCode: string | null; stock: number; reserved: number; isActive: boolean; product: { id: string; name: string; slug: string; status: string }; options: Array<{ attributeId: string; displayValue: string }> }, attrCodes: ReadonlyMap<string, { code: string }> = new Map()): StockRowResponse {
    const dyn = v.options.length > 0 ? dynamicColorSize(v.options, attrCodes) : null;
    return {
      variantId: v.id,
      productId: v.product.id,
      productName: v.product.name,
      productSlug: v.product.slug,
      productStatus: v.product.status,
      sku: v.sku,
      color: dyn ? dyn.color : (v.colorName ?? ''),
      size: dyn ? dyn.size : (v.sizeCode ?? ''),
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

  /*
   * Lập phiếu (nháp): kiểm biến thể tồn tại, gộp dòng trùng; chưa đụng tồn kho.
   * `opts.shopId` (vendor): phiếu thuộc gian hàng đó — mã phiếu, shopId và dòng phiếu ghi trong CÙNG transaction (không còn bước
   * update shopId riêng làm phiếu mồ côi thành phiếu của sàn), và mọi biến thể phải là của shop này (kiểm ngay sau khi khoá dòng).
   * Bỏ trống = phiếu của sàn (nhân viên sàn lập, không giới hạn shop).
   */
  async createReceipt(actor: AuthenticatedActor | null, input: { supplierName?: string | null; note?: string | null; items: Array<{ variantId: string; quantity: number; unitCost?: string | null }> }, opts: { shopId?: string | null } = {}): Promise<StockReceiptResponse> {
    const merged = new Map<string, { quantity: number; unitCost: bigint }>();
    for (const i of input.items) {
      const cur = merged.get(i.variantId);
      merged.set(i.variantId, { quantity: (cur?.quantity ?? 0) + i.quantity, unitCost: i.unitCost ? vnd(i.unitCost) : (cur?.unitCost ?? 0n) });
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const locked = await this.repo.lockVariants([...merged.keys()], tx);
      // Shop khác coi như không tồn tại (404, không lộ biến thể của shop khác).
      const variants = opts.shopId ? locked.filter((v) => v.shopId === opts.shopId) : locked;
      const missing = [...merged.keys()].filter((id) => !variants.some((v) => v.id === id));
      if (missing.length > 0) throw new NotFoundException(PRODUCT_ERR.VARIANT_NOT_FOUND, opts.shopId ? `Biến thể không tồn tại hoặc không thuộc gian hàng của bạn: ${missing.join(', ')}` : `Biến thể không tồn tại: ${missing.join(', ')}`);
      const items = variants.map((v) => ({ variantId: v.id, sku: v.sku, quantity: merged.get(v.id)!.quantity, unitCost: merged.get(v.id)!.unitCost }));
      const totalCost = items.reduce((s, i) => s + BigInt(i.quantity) * i.unitCost, 0n);
      // total_cost là numeric(14,0): vượt thì DB báo lỗi số học (500) — chặn sớm bằng lỗi nghiệp vụ.
      if (totalCost > MAX_RECEIPT_TOTAL) throw new BusinessException(PRODUCT_ERR.RECEIPT_TOTAL_TOO_LARGE, 'Tổng giá trị phiếu nhập vượt giới hạn cho phép — tách thành nhiều phiếu');
      const code = await this.repo.nextReceiptCode(tx);
      const r = await this.repo.createReceipt({ code, supplierName: input.supplierName ?? null, note: input.note ?? null, totalCost, createdBy: actor?.userId ?? null, shopId: opts.shopId ?? null, items }, tx);
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
        if (stock > MAX_STOCK) throw new BusinessException(PRODUCT_ERR.STOCK_LIMIT_EXCEEDED, `Tồn kho của ${item.sku} sẽ vượt giới hạn ${MAX_STOCK.toLocaleString('vi-VN')}`);
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
      if (stock > MAX_STOCK) throw new BusinessException(PRODUCT_ERR.STOCK_LIMIT_EXCEEDED, `Tồn kho sau điều chỉnh vượt giới hạn ${MAX_STOCK.toLocaleString('vi-VN')}`);
      await this.repo.setStock(v.id, stock, v.reserved, tx);
      await this.repo.addMovement({ productId: v.productId, variantId: v.id, type: STOCK_MOVE.ADJUST, quantity: input.delta, stockAfter: stock, refType: 'adjust', refId: null, note: input.reason, actorUserId: actor.userId }, tx);
      await this.audit.write(tx, actor, { action: PRODUCT_AUDIT.STOCK_ADJUSTED, entityType: 'product_variant', entityId: v.id, entityCode: v.sku, before: { stock: v.stock }, after: { stock, delta: input.delta, reason: input.reason } });
      await this.afterStockChange([v.productId], [{ ...v, stock }], tx);
    });
    const row = await this.repo.findStockRow(input.variantId);
    if (!row) throw new NotFoundException(PRODUCT_ERR.VARIANT_NOT_FOUND, 'Không tìm thấy biến thể');
    return (await this.toStockRows([row]))[0];
  }

  // ---------------------------------------------------------------- helpers

  /*
   * Gộp dòng trùng, khoá dòng biến thể (FOR UPDATE, theo id) rồi kiểm điều kiện `ok` từng dòng.
   *  - sellableOnly=true (reserve): chỉ khoá biến thể chưa xoá mềm và đòi isActive — biến thể tắt/xoá coi như hết hàng.
   *  - sellableOnly=false (commit/release/restock): khoá CẢ biến thể xoá mềm, KHÔNG xét isActive — đây là đơn đã có từ trước.
   *  - skipMissing=true: dòng không còn trong DB (xoá cứng bất thường) bị bỏ qua + cảnh báo, để huỷ/hoàn đơn không bị kẹt;
   *    mặc định thiếu dòng là thiếu hàng.
   * Thiếu → InsufficientStockError (kèm danh sách thiếu); gateway quyết định đổi thành 409 hay để order tự bắt.
   */
  private async lockAndCheck(lines: StockLine[], tx: Tx, ok: (v: { stock: number; reserved: number }, q: number) => boolean, opts: { sellableOnly: boolean; skipMissing?: boolean }) {
    const merged = new Map<string, number>();
    for (const l of lines) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity);
    const locked = await this.repo.lockVariants([...merged.keys()], tx, { includeDeleted: !opts.sellableOnly });
    const shortages = [];
    const out = [];
    for (const [variantId, q] of merged) {
      const v = locked.find((x) => x.id === variantId);
      if (!v) {
        if (opts.skipMissing) this.logger.warn({ variantId, quantity: q }, 'Biến thể không còn trong DB — bỏ qua khi nhả/hoàn kho');
        else shortages.push({ variantId, requested: q, available: 0 });
        continue;
      }
      if (opts.sellableOnly && !v.isActive) {
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
  private async afterStockChange(productIds: string[], after: Array<{ id: string; sku: string; productId: string; stock: number; reserved: number; isActive?: boolean; isDeleted?: boolean }>, tx: Tx): Promise<void> {
    for (const v of after) {
      // Biến thể đã tắt/xoá mềm (chỉ gặp khi trừ kho cho đơn cũ) không còn bán → không báo "sắp hết hàng" cho chủ shop.
      if (v.isActive !== false && !v.isDeleted && v.stock - v.reserved <= LOW_STOCK_THRESHOLD) {
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
