import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { RETURN_STATUS } from '../../foundation/order.constants';

export const ORDER_INCLUDE = { items: { orderBy: { name: 'asc' as const } }, histories: { orderBy: { createdAt: 'asc' as const } } } as const;
export type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/* PLAN-0014 bước 7 — đơn cha kèm các đơn con theo shop (mỗi đơn con đủ items/histories như OrderRow). */
export const ORDER_GROUP_INCLUDE = { orders: { include: ORDER_INCLUDE, orderBy: { createdAt: 'asc' as const } } } as const;
export type OrderGroupRow = Prisma.OrderGroupGetPayload<{ include: typeof ORDER_GROUP_INCLUDE }>;

/* Số lượng ĐÃ yêu cầu trả (đang mở/đã duyệt/đã hoàn) theo dòng hàng — cùng định nghĩa với ReturnService khi chặn trả quá số lượng. */
export const RETURN_COUNTED_STATUSES = [RETURN_STATUS.REQUESTED, RETURN_STATUS.APPROVED, RETURN_STATUS.REFUNDED] as const;

export interface OrderListFilter {
  userId?: string;
  shopId?: string;
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

  /* Mã đơn CHA — dãy đếm riêng (order_group_sequences), không dùng chung counter với đơn con để tránh
     đụng logic sinh mã Order hiện có. Tiền tố DHN phân biệt rõ với DH của đơn con. */
  async nextGroupCode(tx: Tx): Promise<string> {
    const d = new Date();
    const day = `${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    await tx.$executeRaw`INSERT INTO "order"."order_group_sequences" (day, counter) VALUES (${day}, 0) ON CONFLICT (day) DO NOTHING`;
    const [row] = await tx.$queryRaw<Array<{ counter: number }>>`UPDATE "order"."order_group_sequences" SET counter = counter + 1 WHERE day = ${day} RETURNING counter`;
    return `DHN${day}${String(row.counter).padStart(4, '0')}`;
  }

  async createGroup(data: Prisma.OrderGroupUncheckedCreateInput, tx: Tx): Promise<{ id: string; code: string }> {
    return tx.orderGroup.create({ data, select: { id: true, code: true } });
  }

  async findGroupByCode(code: string, tx?: Tx | null): Promise<OrderGroupRow | null> {
    return this.db(tx).orderGroup.findFirst({ where: { code }, include: ORDER_GROUP_INCLUDE });
  }

  async listGroups(userId: string, skip: number, take: number): Promise<{ items: OrderGroupRow[]; total: number }> {
    const where: Prisma.OrderGroupWhereInput = { userId };
    const [items, total] = await Promise.all([
      this.prisma.orderGroup.findMany({ where, include: ORDER_GROUP_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.orderGroup.count({ where }),
    ]);
    return { items, total };
  }

  async findByCode(code: string, tx?: Tx | null): Promise<OrderRow | null> {
    return this.db(tx).order.findFirst({ where: { code, isDeleted: false }, include: ORDER_INCLUDE });
  }

  async findByCodeForUpdate(code: string, tx: Tx): Promise<OrderRow | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "order"."orders" WHERE code = ${code} AND is_deleted = false FOR UPDATE`;
    return rows[0] ? tx.order.findUnique({ where: { id: rows[0].id }, include: ORDER_INCLUDE }) : null;
  }

  /* Mã đơn cha + số đơn con KHÁC còn hiệu lực (chưa huỷ) — huỷ đơn con cuối của nhóm thì mới nhả voucher sàn. */
  async returnedQtyByItem(orderId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.returnRequestItem.groupBy({ by: ['orderItemId'], where: { request: { orderId, status: { in: [...RETURN_COUNTED_STATUSES] } } }, _sum: { quantity: true } });
    return new Map(rows.map((g) => [g.orderItemId, g._sum.quantity ?? 0]));
  }

  async groupSiblingInfo(orderGroupId: string, excludeOrderId: string, tx: Tx): Promise<{ groupCode: string; activeOthers: number } | null> {
    const group = await tx.orderGroup.findUnique({ where: { id: orderGroupId }, select: { code: true } });
    if (!group) return null;
    const activeOthers = await tx.order.count({ where: { orderGroupId, id: { not: excludeOrderId }, isDeleted: false, status: { not: 'cancelled' } } });
    return { groupCode: group.code, activeOthers };
  }

  async list(f: OrderListFilter, skip: number, take: number): Promise<{ items: OrderRow[]; total: number }> {
    const where: Prisma.OrderWhereInput = {
      isDeleted: false,
      ...(f.userId ? { userId: f.userId } : {}),
      ...(f.shopId ? { shopId: f.shopId } : {}),
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
  async findDeliveredBefore(before: Date, limit: number, excludeCodes: string[] = []): Promise<Array<{ code: string }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, status: 'delivered', deliveredAt: { lt: before }, ...(excludeCodes.length > 0 ? { code: { notIn: excludeCodes } } : {}) }, orderBy: { deliveredAt: 'asc' }, select: { code: true }, take: limit });
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
