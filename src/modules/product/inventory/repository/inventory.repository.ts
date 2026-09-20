import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { Prisma } from '@common/prisma/types';

export interface LockedVariant {
  id: string;
  productId: string;
  sku: string;
  stock: number;
  reserved: number;
  isActive: boolean;
}

/*
 * Tồn kho: mọi đọc-sửa-ghi qua `lockVariants` (SELECT ... FOR UPDATE, sắp theo id để hai transaction khoá cùng thứ tự
 * → không deadlock) rồi UPDATE tuyệt đối + ghi sổ kho. Không bao giờ `stock = stock - x` ngoài khoá.
 */
@Injectable()
export class InventoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async lockVariants(variantIds: string[], tx: Tx): Promise<LockedVariant[]> {
    if (variantIds.length === 0) return [];
    const ids = [...new Set(variantIds)].sort();
    return tx.$queryRaw<LockedVariant[]>`
      SELECT id, product_id AS "productId", sku, stock, reserved, is_active AS "isActive"
      FROM "product"."product_variants"
      WHERE id = ANY(${ids}::uuid[]) AND is_deleted = false
      ORDER BY id
      FOR UPDATE`;
  }

  async setStock(variantId: string, stock: number, reserved: number, tx: Tx): Promise<void> {
    await tx.productVariant.update({ where: { id: variantId }, data: { stock, reserved, version: { increment: 1 } } });
  }

  async addMovement(m: { productId: string; variantId: string; type: string; quantity: number; stockAfter: number; refType: string | null; refId: string | null; note: string | null; actorUserId: string | null }, tx: Tx): Promise<void> {
    await tx.stockMovement.create({ data: m });
  }

  async availableOf(variantIds: string[]): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.prisma.productVariant.findMany({ where: { id: { in: variantIds }, isDeleted: false, isActive: true, product: { isDeleted: false, status: 'active' } }, select: { id: true, stock: true, reserved: true } });
    return new Map(rows.map((r) => [r.id, Math.max(0, r.stock - r.reserved)]));
  }

  // ------------------------------------------------------------ receipts

  async nextReceiptCode(tx: Tx): Promise<string> {
    const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "product"."stock_receipts"`;
    const d = new Date();
    return `PN${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(n + 1n).padStart(5, '0')}`;
  }

  async createReceipt(data: { code: string; supplierName: string | null; note: string | null; totalCost: bigint; createdBy: string | null; items: Array<{ variantId: string; sku: string; quantity: number; unitCost: bigint }> }, tx: Tx): Promise<{ id: string }> {
    return tx.stockReceipt.create({
      data: {
        code: data.code,
        supplierName: data.supplierName,
        note: data.note,
        totalCost: new Prisma.Decimal(data.totalCost.toString()),
        createdBy: data.createdBy,
        updatedBy: data.createdBy,
        items: { create: data.items.map((i) => ({ variantId: i.variantId, sku: i.sku, quantity: i.quantity, unitCost: new Prisma.Decimal(i.unitCost.toString()) })) },
      },
      select: { id: true },
    });
  }

  async findReceipt(id: string, tx?: Tx | null) {
    return (tx ?? this.prisma).stockReceipt.findFirst({ where: { id, isDeleted: false }, include: { items: true } });
  }

  async findReceiptForUpdate(id: string, tx: Tx): Promise<{ id: string; status: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM "product"."stock_receipts" WHERE id = ${id}::uuid AND is_deleted = false FOR UPDATE`;
    return rows[0] ?? null;
  }

  async markReceipt(id: string, status: string, actorId: string, tx: Tx): Promise<void> {
    await tx.stockReceipt.update({ where: { id }, data: { status, ...(status === 'posted' ? { postedAt: new Date(), postedBy: actorId } : {}), updatedBy: actorId, version: { increment: 1 } } });
  }

  async listReceipts(skip: number, take: number, status?: string) {
    const where = { isDeleted: false, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.stockReceipt.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { items: true } }),
      this.prisma.stockReceipt.count({ where }),
    ]);
    return { items, total };
  }

  async listMovements(variantId: string, take: number) {
    return this.prisma.stockMovement.findMany({ where: { variantId }, orderBy: { createdAt: 'desc' }, take });
  }

  async findStockRow(variantId: string) {
    return this.prisma.productVariant.findFirst({
      where: { id: variantId, isDeleted: false },
      select: { id: true, sku: true, colorName: true, sizeCode: true, stock: true, reserved: true, isActive: true, product: { select: { id: true, name: true, slug: true, status: true } } },
    });
  }

  /* Bảng tồn cho màn kho: mọi biến thể sống kèm tên sản phẩm; lọc sắp hết hàng. */
  async listStock(params: { skip: number; take: number; q?: string; lowStockOnly?: boolean; threshold: number }) {
    const where: Prisma.ProductVariantWhereInput = {
      isDeleted: false,
      product: { isDeleted: false, ...(params.q ? { OR: [{ name: { contains: params.q, mode: 'insensitive' } }, { variants: { some: { sku: { contains: params.q, mode: 'insensitive' } } } }] } : {}) },
      ...(params.lowStockOnly ? { stock: { lte: params.threshold } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.productVariant.findMany({
        where,
        orderBy: [{ stock: 'asc' }, { sku: 'asc' }],
        skip: params.skip,
        take: params.take,
        select: { id: true, sku: true, colorName: true, sizeCode: true, stock: true, reserved: true, isActive: true, product: { select: { id: true, name: true, slug: true, status: true } } },
      }),
      this.prisma.productVariant.count({ where }),
    ]);
    return { items, total };
  }
}
