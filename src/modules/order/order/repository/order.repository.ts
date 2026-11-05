import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { RETURN_COUNTED_STATUSES, RETURN_OPEN_STATUSES, RETURN_REJECTED_BY, RETURN_STATUS } from '../../foundation/order.constants';

export const ORDER_INCLUDE = { items: { orderBy: { name: 'asc' as const } }, histories: { orderBy: { createdAt: 'asc' as const } } } as const;
export type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/* PLAN-0014 bước 7 — đơn cha kèm các đơn con theo shop (mỗi đơn con đủ items/histories như OrderRow). */
export const ORDER_GROUP_INCLUDE = { orders: { include: ORDER_INCLUDE, orderBy: { createdAt: 'asc' as const } } } as const;
export type OrderGroupRow = Prisma.OrderGroupGetPayload<{ include: typeof ORDER_GROUP_INCLUDE }>;

/*
 * Yêu cầu đang "giữ chỗ" số lượng hàng (PLAN-0022): đang mở + đã hoàn xong, VÀ yêu cầu bị SHOP từ chối nhưng khách còn quyền khiếu nại (hạn chưa hết) — nếu không,
 * khách tạo yêu cầu thứ hai cho cùng món rồi khiếu nại yêu cầu cũ ⇒ hoàn hai lần. rejected(platform)/cancelled/expired nhả lại số lượng.
 */
function reservingWhere(now: Date): Prisma.ReturnRequestWhereInput {
  return { OR: [{ status: { in: [...RETURN_COUNTED_STATUSES] } }, { status: RETURN_STATUS.REJECTED, rejectedBy: RETURN_REJECTED_BY.SHOP, escalateDueAt: { gt: now } }] };
}

export interface OrderListFilter {
  userId?: string;
  shopId?: string;
  status?: string;
  paymentStatus?: string;
  paymentMethodCode?: string;
  q?: string;
  /* PLAN-0040 tầng 4 (AUD-12b) — CHỈ danh sách ADMIN đặt, để `q` khớp thêm: mã nhóm DHN… (qGroupCode) và các khách có email = q (qUserIds, đã tra qua IdentityQueryApi — order không join sang schema identity). Shop KHÔNG dùng. */
  qGroupCode?: boolean;
  qUserIds?: string[];
}

/* Bảng order.orders + items + histories. Mã đơn: DH + yymmdd + 4 số từ order_sequences (khoá dòng theo ngày). */
@Injectable()
export class OrderRepository {
  async simulatedOrderCodes(codes: string[]): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.order.findMany({ where: { code: { in: codes }, OR: [{ shippingProvider: 'fake' }, { shippingEnvironment: 'demo' }] }, select: { code: true } });
    return new Set(rows.map((r) => r.code));
  }
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx | null) {
    return tx ?? this.prisma;
  }

  /* Replay checkout trước HTTP báo phí; không ghi dữ liệu và kiểm hash như IdempotencyService. */
  async completedPlacement(userId:string,key:string,hash:string):Promise<string|null> {
    const row=await this.prisma.orderIdempotencyKey.findUnique({where:{scope_actorKey_idempotencyKey:{scope:'place-order',actorKey:userId,idempotencyKey:key}}});
    if(!row) return null;
    if(row.requestHash !== hash) throw new (await import('@common/exception/business.exception')).BusinessException('COMMON_IDEMPOTENCY_KEY_REUSED','Idempotency-Key đã dùng cho yêu cầu khác',409);
    return row.status === 'DONE' ? row.resultRef : null;
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

  /* Chỉ KHOÁ dòng đơn (không đọc) — payment gọi trước khi khoá payment để giữ thứ tự khoá đơn → payment (xem OrderPaymentGateway.lockOrder). */
  async lockByCode(code: string, tx: Tx): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "order"."orders" WHERE code = ${code} AND is_deleted = false FOR UPDATE`;
  }

  async findByCodeForUpdate(code: string, tx: Tx): Promise<OrderRow | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "order"."orders" WHERE code = ${code} AND is_deleted = false FOR UPDATE`;
    return rows[0] ? tx.order.findUnique({ where: { id: rows[0].id }, include: ORDER_INCLUDE }) : null;
  }

  /* Số lượng đã "giữ chỗ" cho đổi trả theo dòng hàng (id dòng là duy nhất toàn bảng nên gộp được nhiều đơn một lần — không N+1 theo đơn). Trong tx khi tạo yêu cầu. */
  async returnedQtyByItem(orderIds: string[], tx?: Tx | null): Promise<Map<string, number>> {
    if (orderIds.length === 0) return new Map();
    const rows = await this.db(tx).returnRequestItem.groupBy({ by: ['orderItemId'], where: { request: { orderId: { in: orderIds }, ...reservingWhere(new Date()) } }, _sum: { quantity: true } });
    return new Map(rows.map((g) => [g.orderItemId, g._sum.quantity ?? 0]));
  }

  /* Đơn còn yêu cầu đổi trả MỞ (requested/approved/escalated/received) — chặn huỷ đơn / báo giao thất bại khi đang tranh chấp. */
  async hasOpenReturn(orderId: string, tx?: Tx | null): Promise<boolean> {
    return (await this.db(tx).returnRequest.count({ where: { orderId, status: { in: [...RETURN_OPEN_STATUSES] } } })) > 0;
  }

  /* PLAN-0031 §2.2 (SHP-06): đơn còn yêu cầu "chưa nhận hàng" (reasonCode = not_received) đang MỞ — chặn shop báo `delivered` (409 ORDER_NOT_RECEIVED_OPEN). Gọi trong tx của updateStatus (đơn đã khoá). */
  async hasOpenNotReceived(orderId: string, tx?: Tx | null): Promise<boolean> {
    return (await this.db(tx).returnRequest.count({ where: { orderId, reasonCode: 'not_received', status: { in: [...RETURN_OPEN_STATUSES] } } })) > 0;
  }

  /*
   * PLAN-0031 §2.1 (SHP-13): mã vận đơn này shop đã dùng cho đơn KHÁC (chưa huỷ) chưa — so không phân biệt hoa thường. Khoá advisory theo (shop, mã) trong tx để hai đơn cùng nhận một mã ở hai transaction
   * song song vẫn thấy nhau (mỗi tx khoá dòng ĐƠN khác nhau nên chỉ khoá dòng thì không đủ); khoá advisory lấy SAU khoá đơn, ai cũng theo thứ tự đó ⇒ không deadlock.
   */
  async trackingCodeUsedByOther(shopId: string, trackingCode: string, excludeOrderId: string, tx: Tx): Promise<boolean> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`trk:${shopId}:${trackingCode.toUpperCase()}`}))`;
    return (await tx.order.count({ where: { shopId, trackingCode: { equals: trackingCode, mode: 'insensitive' }, id: { not: excludeOrderId }, status: { not: 'cancelled' }, isDeleted: false } })) > 0;
  }

  /* PLAN-0027: tập id đơn (trong danh sách) đang có yêu cầu đổi trả MỞ — MỘT query cho cả trang (cờ canMarkReceived không N+1). */
  async openReturnOrderIds(orderIds: string[], tx?: Tx | null): Promise<Set<string>> {
    if (orderIds.length === 0) return new Set();
    const rows = await this.db(tx).returnRequest.findMany({ where: { orderId: { in: orderIds }, status: { in: [...RETURN_OPEN_STATUSES] } }, select: { orderId: true }, distinct: ['orderId'] });
    return new Set(rows.map((r) => r.orderId));
  }

  // ---------------------------------------------------------------- PLAN-0027: SLA / yêu cầu huỷ (job quét theo chỉ mục (status, *_due_at); chỉ đơn có hạn KHÁC NULL — đơn cũ không bao giờ lọt vào)

  /*
   * Mở một lượt chạy job SLA: khoá advisory (nhiều worker chỉ một chạy), đọc nhịp lần chạy trước. Nghỉ quá `maxGapMs` (SLA vừa được bật lần đầu / bật lại, worker sập lâu) ⇒ "rebase":
   * mọi hạn đã TRỄ được đẩy sang `now + số giờ` (kể cả hạn của yêu cầu huỷ) và xoá cờ nhắc — để bật SLA không huỷ hàng loạt đơn đã trễ từ trước. Rồi ghi nhịp `now`.
   * Trả acquired=false khi worker khác đang giữ khoá (bỏ qua lượt này).
   */
  async beginSlaTick(tx: Tx, now: Date, maxGapMs: number, hours: { confirm: number; ship: number; cancelRequest: number }): Promise<{ acquired: boolean; rebased: boolean }> {
    const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('order-sla')) AS ok`;
    if (!lock?.ok) return { acquired: false, rebased: false };
    const state = await tx.orderJobState.findUnique({ where: { key: 'order-sla' } });
    const rebased = !state || now.getTime() - state.lastRunAt.getTime() > maxGapMs;
    if (rebased) {
      const at = (h: number) => new Date(now.getTime() + h * 3_600_000);
      await tx.order.updateMany({ where: { isDeleted: false, status: 'pending', confirmDueAt: { lt: now } }, data: { confirmDueAt: at(hours.confirm), confirmRemindedAt: null } });
      await tx.order.updateMany({ where: { isDeleted: false, status: { in: ['confirmed', 'packing'] }, shipDueAt: { lt: now } }, data: { shipDueAt: at(hours.ship), shipRemindedAt: null } });
      await tx.order.updateMany({ where: { isDeleted: false, status: 'packing', cancelRequestStatus: 'pending', cancelRequestDueAt: { lt: now } }, data: { cancelRequestDueAt: at(hours.cancelRequest) } });
    }
    await tx.orderJobState.upsert({ where: { key: 'order-sla' }, create: { key: 'order-sla', lastRunAt: now }, update: { lastRunAt: now } });
    return { acquired: true, rebased };
  }

  private notIn(exclude: string[]) {
    return exclude.length > 0 ? { code: { notIn: exclude } } : {};
  }

  /* Đơn `pending` (COD hoặc PayOS đã trả — chỉ lúc đó mới có hạn) quá hạn xác nhận. */
  async findConfirmOverdue(now: Date, limit: number, exclude: string[] = []): Promise<Array<{ code: string }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, status: 'pending', confirmDueAt: { lt: now }, ...this.notIn(exclude) }, orderBy: { confirmDueAt: 'asc' }, select: { code: true }, take: limit });
  }

  /* Đơn `confirmed`/`packing` quá hạn giao. */
  async findShipOverdue(now: Date, limit: number, exclude: string[] = []): Promise<Array<{ code: string }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, status: { in: ['confirmed', 'packing'] }, shipDueAt: { lt: now }, ...this.notIn(exclude) }, orderBy: { shipDueAt: 'asc' }, select: { code: true }, take: limit });
  }

  /* Yêu cầu huỷ của khách (đơn `packing`) shop im lặng quá hạn ⇒ tự chấp nhận. */
  async findCancelRequestsDue(now: Date, limit: number, exclude: string[] = []): Promise<Array<{ code: string }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, status: 'packing', cancelRequestStatus: 'pending', cancelRequestDueAt: { lt: now }, ...this.notIn(exclude) }, orderBy: { cancelRequestDueAt: 'asc' }, select: { code: true }, take: limit });
  }

  /* Đơn còn ≤ `withinMs` là quá hạn mà chưa nhắc. */
  async findConfirmToRemind(now: Date, withinMs: number, limit: number, exclude: string[] = []): Promise<Array<{ code: string }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, status: 'pending', confirmRemindedAt: null, confirmDueAt: { gt: now, lte: new Date(now.getTime() + withinMs) }, ...this.notIn(exclude) }, orderBy: { confirmDueAt: 'asc' }, select: { code: true }, take: limit });
  }

  async findShipToRemind(now: Date, withinMs: number, limit: number, exclude: string[] = []): Promise<Array<{ code: string }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, status: { in: ['confirmed', 'packing'] }, shipRemindedAt: null, shipDueAt: { gt: now, lte: new Date(now.getTime() + withinMs) }, ...this.notIn(exclude) }, orderBy: { shipDueAt: 'asc' }, select: { code: true }, take: limit });
  }

  /* Đơn của shop theo trạng thái (cũ nhất trước) — listener khoá shop duyệt từng lô. */
  async findByShopAndStatus(shopId: string, statuses: string[], limit: number, exclude: string[] = []): Promise<Array<{ code: string; status: string }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, shopId, status: { in: statuses }, ...this.notIn(exclude) }, orderBy: { createdAt: 'asc' }, select: { code: true, status: true }, take: limit });
  }

  /* Số đơn đang mở của shop theo trạng thái — hộp thoại khoá shop. */
  async openCountsByShop(shopId: string, statuses: string[]): Promise<Record<string, number>> {
    const rows = await this.prisma.order.groupBy({ by: ['status'], where: { isDeleted: false, shopId, status: { in: statuses } }, _count: { _all: true } });
    return Object.fromEntries(statuses.map((s) => [s, rows.find((r) => r.status === s)?._count._all ?? 0]));
  }

  /* Mã đơn cha + số đơn con KHÁC còn hiệu lực (chưa huỷ) — huỷ đơn con cuối của nhóm thì mới nhả voucher sàn. */
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
      ...(f.q ? { OR: [{ code: { contains: f.q.toUpperCase() } }, { recipientName: { contains: f.q, mode: 'insensitive' } }, { recipientPhone: { contains: f.q } }, ...(f.qGroupCode ? [{ orderGroup: { code: { contains: f.q.toUpperCase() } } }] : []), ...(f.qUserIds && f.qUserIds.length > 0 ? [{ userId: { in: f.qUserIds } }] : [])] } : {}),
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
  async findPaymentExpired(limit: number, graceMinutes = 0): Promise<Array<{ code: string; paymentExpiresAt: Date | null }>> {
    return this.prisma.order.findMany({ where: { isDeleted: false, status: 'pending', paymentStatus: 'unpaid', paymentExpiresAt: { lt: new Date(Date.now() - graceMinutes * 60_000) } }, select: { code: true, paymentExpiresAt: true }, orderBy: { paymentExpiresAt: 'asc' }, take: limit });
  }

  /* Đã giao quá N ngày không khiếu nại → hoàn tất (job). */
  async findDeliveredBefore(before: Date, limit: number, excludeCodes: string[] = []): Promise<Array<{ code: string }>> {
    // PLAN-0027 (SHP-04, G13): đơn còn yêu cầu đổi trả MỞ không được tự hoàn tất (hoàn tất sẽ mở escrow trong khi khách đang tranh chấp).
    return this.prisma.order.findMany({ where: { isDeleted: false, status: 'delivered', deliveredAt: { lt: before }, returns: { none: { status: { in: [...RETURN_OPEN_STATUSES] } } }, ...(excludeCodes.length > 0 ? { code: { notIn: excludeCodes } } : {}) }, orderBy: { deliveredAt: 'asc' }, select: { code: true }, take: limit });
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
