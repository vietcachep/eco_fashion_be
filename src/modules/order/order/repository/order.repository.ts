import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';

export const ORDER_INCLUDE = { items: { orderBy: { name: 'asc' as const } }, histories: { orderBy: { createdAt: 'asc' as const } } } as const;
export type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export interface OrderListFilter {
  userId?: string;
  status?: string;
  paymentStatus?: string;
  paymentMethodCode?: string;
  q?: string;
}

/* Bảng order.orders + items + histories. Mã đơn: DH + yymmdd + 4 số từ order_sequences (khoá dòng theo ngày). */
@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  async nextCode(tx: Tx): Promise<string> {
    const d = new Date();
    const day = `${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    await tx.$executeRaw`INSERT INTO "order"."order_sequences" (day, counter) VALUES (${day}, 0) ON CONFLICT (day) DO NOTHING`;
    const [row] = await tx.$queryRaw<Array<{ counter: number }>>`UPDATE "order"."order_sequences" SET counter = counter + 1 WHERE day = ${day} RETURNING counter`;
    return `DH${day}${String(row.counter).padStart(4, '0')}`;
  }

  async findByCode(code: string, tx?: Tx | null): Promise<OrderRow | null> {
    return this.db(tx).order.findFirst({ where: { code, isDeleted: false }, include: ORDER_INCLUDE });
  }

  async findByCodeForUpdate(code: string, tx: Tx): Promise<OrderRow | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "order"."orders" WHERE code = ${code} AND is_deleted = false FOR UPDATE`;
    return rows[0] ? tx.order.findUnique({ where: { id: rows[0].id }, include: ORDER_INCLUDE }) : null;
  }

  async list(f: OrderListFilter, skip: number, take: number): Promise<{ items: OrderRow[]; total: number }> {
    const where: Prisma.OrderWhereInput = {
      isDeleted: false,
      ...(f.userId ? { userId: f.userId } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.paymentStatus ? { paymentStatus: f.paymentStatus } : {}),
      ...(f.paymentMethodCode ? { paymentMethodCode: f.paymentMethodCode } : {}),
      ...(f.q ? { OR: [{ code: { contains: f.q.toUpperCase() } }, { recipientName: { contains: f.q, mode: 'insensitive' } }, { recipientPhone: { contains: f.q } }] } : {}),
    };
    const [items, total] = await Promise.all([this.prisma.order.findMany({ where, include: ORDER_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.order.count({ where })]);
    return { items, total };
  }

  async create(data: Prisma.OrderUncheckedCreateInput, tx: Tx): Promise<OrderRow> {
    return tx.order.create({ data, include: ORDER_INCLUDE });
  }

  async update(id: string, data: Prisma.OrderUncheckedUpdateInput, tx: Tx): Promise<OrderRow> {
    return tx.order.update({ where: { id }, data: { ...data, version: { increment: 1 } }, include: ORDER_INCLUDE });
  }

  async addHistory(orderId: string, fromStatus: string | null, toStatus: string, note: string | null, actorUserId: string | null, tx: Tx): Promise<void> {
    await tx.orderStatusHistory.create({ data: { orderId, fromStatus, toStatus, note, actorUserId } });
  }

  async markItemsReviewed(orderItemIds: string[], tx?: Tx | null): Promise<void> {
    if (orderItemIds.length === 0) return;
    await this.db(tx).orderItem.updateMany({ where: { id: { in: orderItemIds } }, data: { reviewed: true } });
  }

  /* Đơn online quá hạn thanh toán (job huỷ). */
  async findPaymentExpired(limit: number): Promise<Array<{ code: string }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, status: 'pending', paymentStatus: 'unpaid', paymentExpiresAt: { lt: new Date() } }, select: { code: true }, take: limit });
  }

  /* Đã giao quá N ngày không khiếu nại → hoàn tất (job). */
  async findDeliveredBefore(before: Date, limit: number): Promise<Array<{ code: string }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, status: 'delivered', deliveredAt: { lt: before } }, select: { code: true }, take: limit });
  }

  /* Khách đã mua sản phẩm này (đơn delivered/completed) — review dùng. */
  async purchasedItem(userId: string, productId: string): Promise<{ orderItemId: string; orderCode: string; color: string; size: string; reviewed: boolean } | null> {
    const item = await this.prisma.orderItem.findFirst({
      where: { productId, order: { userId, isDeleted: false, status: { in: ['delivered', 'completed'] } } },
      orderBy: [{ reviewed: 'asc' }, { order: { createdAt: 'desc' } }],
      select: { id: true, color: true, size: true, reviewed: true, order: { select: { code: true } } },
    });
    return item ? { orderItemId: item.id, orderCode: item.order.code, color: item.color, size: item.size, reviewed: item.reviewed } : null;
  }
}
