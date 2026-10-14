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
  /* true chỉ khi khoá với includeDeleted — biến thể xoá mềm vẫn được nhả/hoàn/trừ cho đơn cũ nhưng không báo STOCK_LOW. */
  isDeleted: boolean;
  /* Gian hàng chủ biến thể — phiếu nhập của shop kiểm trùng ngay trong transaction khoá dòng. */
  shopId: string;
}

/* Cột của dòng bảng tồn; options = trục biến thể ngành dynamic (dựng nhãn color/size thay colorName/sizeCode đang null). */
const STOCK_ROW_SELECT = {
  id: true,
  sku: true,
  colorName: true,
  sizeCode: true,
  stock: true,
  reserved: true,
  isActive: true,
  product: { select: { id: true, name: true, slug: true, status: true } },
  options: { select: { attributeId: true, displayValue: true } },
} satisfies Prisma.ProductVariantSelect;

/* Khoá cố định cho pg_advisory_xact_lock khi cấp mã phiếu nhập (xem nextReceiptCode). */
const RECEIPT_CODE_LOCK = 'product.stock_receipt.code';
/* Mã phiếu runtime: PN + yyMM + số thứ tự toàn cục (≥ 5 chữ số). Mã seed (PN-SEED-…, PN-ACT-…) không khớp mẫu này nên bị bỏ qua khi tính số kế tiếp. */
const RECEIPT_CODE_PATTERN = '^PN[0-9]{9,}$';

/*
 * Tồn kho: mọi đọc-sửa-ghi qua `lockVariants` (SELECT ... FOR UPDATE, sắp theo id để hai transaction khoá cùng thứ tự
 * → không deadlock) rồi UPDATE tuyệt đối + ghi sổ kho. Không bao giờ `stock = stock - x` ngoài khoá.
 */
@Injectable()
export class InventoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /*
   * Khoá dòng biến thể. Mặc định bỏ biến thể đã xoá mềm (nhập kho/điều chỉnh/giữ hàng chỉ đụng hàng còn bán).
   * `includeDeleted`: nhả/trừ/hoàn kho cho đơn ĐÃ có từ trước PHẢI khoá được cả biến thể bị xoá mềm sau đó — nếu không, đơn mở
   * không huỷ/xác nhận được và số `reserved` kẹt vĩnh viễn.
   */
  async lockVariants(variantIds: string[], tx: Tx, opts: { includeDeleted?: boolean } = {}): Promise<LockedVariant[]> {
    if (variantIds.length === 0) return [];
    const ids = [...new Set(variantIds)].sort();
    return tx.$queryRaw<LockedVariant[]>`
      SELECT id, product_id AS "productId", sku, stock, reserved, is_active AS "isActive", is_deleted AS "isDeleted", shop_id AS "shopId"
      FROM "product"."product_variants"
      WHERE id = ANY(${ids}::uuid[]) ${opts.includeDeleted ? Prisma.empty : Prisma.sql`AND is_deleted = false`}
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

  /*
   * Cấp mã phiếu kế tiếp — PHẢI gọi trong cùng transaction với createReceipt. `count(*) + 1` không khoá khiến hai vendor lập
   * phiếu cùng lúc đọc cùng số → trùng mã (unique đỏ, 409). Ở đây advisory lock theo transaction tuần tự hoá việc cấp số:
   * transaction sau đợi transaction trước COMMIT rồi mới đọc số lớn nhất (READ COMMITTED thấy dòng vừa commit) → không trùng.
   * Số kế tiếp = MAX(số của mã đúng mẫu runtime) + 1, nên mã seed hay dòng bị xoá cứng không làm lệch dãy.
   */
  async nextReceiptCode(tx: Tx): Promise<string> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RECEIPT_CODE_LOCK}))`;
    const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`
      SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 7) AS bigint)), 0)::bigint AS n
      FROM "product"."stock_receipts"
      WHERE code ~ ${RECEIPT_CODE_PATTERN}`;
    const d = new Date();
    return `PN${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(n + 1n).padStart(5, '0')}`;
  }

  /* `shopId` = gian hàng lập phiếu (null = phiếu của sàn) — ghi CÙNG câu lệnh tạo phiếu, không còn bước update riêng làm phiếu mồ côi. */
  async createReceipt(data: { code: string; supplierName: string | null; note: string | null; totalCost: bigint; createdBy: string | null; shopId: string | null; items: Array<{ variantId: string; sku: string; quantity: number; unitCost: bigint }> }, tx: Tx): Promise<{ id: string }> {
    return tx.stockReceipt.create({
      data: {
        code: data.code,
        supplierName: data.supplierName,
        note: data.note,
        totalCost: new Prisma.Decimal(data.totalCost.toString()),
        shopId: data.shopId,
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
    return this.prisma.productVariant.findFirst({ where: { id: variantId, isDeleted: false }, select: STOCK_ROW_SELECT });
  }

  /*
   * Bảng tồn cho màn kho: mọi biến thể sống kèm tên sản phẩm; lọc sắp hết hàng. `shopId` (vendor) lọc NGAY ở DB cùng truy vấn
   * với tìm kiếm / lowStockOnly / phân trang / count — không lọc trong bộ nhớ sau khi cắt trang (làm trang 2+ rỗng, total sai).
   */
  async listStock(params: { skip: number; take: number; q?: string; lowStockOnly?: boolean; threshold: number; shopId?: string }) {
    const where: Prisma.ProductVariantWhereInput = {
      isDeleted: false,
      ...(params.shopId ? { shopId: params.shopId } : {}),
      product: { isDeleted: false },
      ...(params.q ? { OR: [{ sku: { contains: params.q, mode: 'insensitive' } }, { product: { name: { contains: params.q, mode: 'insensitive' } } }] } : {}),
      ...(params.lowStockOnly ? { stock: { lte: params.threshold } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.productVariant.findMany({
        where,
        // id là chốt cuối: SKU chỉ duy nhất theo shop nên hai dòng cùng tồn + cùng SKU vẫn phải có thứ tự ổn định khi phân trang.
        orderBy: [{ stock: 'asc' }, { sku: 'asc' }, { id: 'asc' }],
        skip: params.skip,
        take: params.take,
        select: STOCK_ROW_SELECT,
      }),
      this.prisma.productVariant.count({ where }),
    ]);
    return { items, total };
  }
}
