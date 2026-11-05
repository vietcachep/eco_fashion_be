import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { commissionBase } from '../foundation/commission';
import { RETURN_OPEN_STATUSES, RETURN_REJECTED_BY, RETURN_STATUS } from '../foundation/order.constants';
import { OrderRepository } from '../order/repository/order.repository';

/* QueryAPI của order — review (đã mua chưa?), ai (đơn của tôi cho chatbot), reporting. Thứ DUY NHẤT module khác import. */
@Injectable()
export class OrderQueryApi {
  async simulatedOrderCodes(codes: string[]): Promise<ReadonlySet<string>> {
    if (codes.length === 0) return new Set();
    const rows = await this.prisma.order.findMany({ where: { code: { in: codes }, OR: [{ shippingProvider: 'fake' }, { shippingEnvironment: 'demo' }] }, select: { code: true } });
    return new Set(rows.map((r) => r.code));
  }
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OrderRepository,
  ) {}

  /* Khách đã nhận sản phẩm này chưa (đơn delivered/completed) — ưu tiên dòng chưa đánh giá. */
  purchasedItem(userId: string, productId: string) {
    return this.repo.purchasedItem(userId, productId);
  }

  /* review đánh dấu dòng đơn đã đánh giá (cùng tx của review). */
  markItemsReviewed(orderItemIds: string[], tx?: Tx): Promise<void> {
    return this.repo.markItemsReviewed(orderItemIds, tx);
  }

  /* Cho chatbot: vài đơn gần nhất của khách (tóm tắt, không lộ dữ liệu người khác). */
  async recentOrders(userId: string, limit = 5): Promise<Array<{ code: string; status: string; paymentStatus: string; total: string; itemCount: number; createdAt: Date; items: Array<{ name: string; color: string; size: string; quantity: number }> }>> {
    const rows = await this.prisma.order.findMany({ where: { userId, isDeleted: false }, orderBy: { createdAt: 'desc' }, take: limit, include: { items: { select: { name: true, color: true, size: true, quantity: true } } } });
    return rows.map((o) => ({ code: o.code, status: o.status, paymentStatus: o.paymentStatus, total: o.total.toString(), itemCount: o.itemCount, createdAt: o.createdAt, items: o.items }));
  }

  async findByCodeForUser(userId: string, code: string) {
    const o = await this.repo.findByCode(code);
    return o && o.userId === userId ? { code: o.code, status: o.status, paymentStatus: o.paymentStatus, total: o.total.toString(), shippingAddress: o.shippingAddress, createdAt: o.createdAt, items: o.items.map((i) => ({ name: i.name, color: i.color, size: i.size, quantity: i.quantity })) } : null;
  }

  /* Sản phẩm mua cùng (cho gợi ý "mua kèm"): id sản phẩm xuất hiện chung đơn với productId. */
  async boughtTogether(productId: string, limit = 8): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ product_id: string; n: bigint }>>`
      SELECT oi2.product_id, count(*)::bigint AS n
      FROM "order"."order_items" oi1
      JOIN "order"."order_items" oi2 ON oi1.order_id = oi2.order_id AND oi2.product_id <> oi1.product_id
      WHERE oi1.product_id = ${productId}::uuid
      GROUP BY oi2.product_id ORDER BY n DESC LIMIT ${limit}`;
    return rows.map((r) => r.product_id);
  }

  /* Đơn đã mua (không huỷ) gần đây của MỌI khách — ai ghi công gợi ý (click → mua trong 7 ngày). */
  async recentPurchases(since: Date): Promise<Array<{ userId: string; productId: string; createdAt: Date }>> {
    const rows = await this.prisma.orderItem.findMany({ where: { order: { isDeleted: false, status: { notIn: ['cancelled'] }, createdAt: { gte: since } } }, select: { productId: true, order: { select: { userId: true, createdAt: true } } } });
    return rows.map((r) => ({ userId: r.order.userId, productId: r.productId, createdAt: r.order.createdAt }));
  }

  /* Số lượng bán theo biến thể trong N ngày (đơn không huỷ) — ai nhận xét tồn kho. */
  async soldByVariant(days: number): Promise<Map<string, number>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.orderItem.groupBy({ by: ['variantId'], where: { order: { isDeleted: false, status: { notIn: ['cancelled'] }, createdAt: { gte: since } } }, _sum: { quantity: true } });
    return new Map(rows.map((r) => [r.variantId, r._sum.quantity ?? 0]));
  }

  /* Cặp sản phẩm hay nằm chung đơn trong N ngày — ai gợi ý combo (số liệu thật). */
  async coPurchasePairs(days: number, limit = 20): Promise<Array<{ productA: string; productB: string; orders: number }>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ a: string; b: string; n: bigint }>>`
      SELECT oi1.product_id AS a, oi2.product_id AS b, count(DISTINCT o.id) AS n
      FROM "order"."order_items" oi1
      JOIN "order"."order_items" oi2 ON oi1.order_id = oi2.order_id AND oi1.product_id < oi2.product_id
      JOIN "order"."orders" o ON o.id = oi1.order_id
      WHERE o.is_deleted = false AND o.status <> 'cancelled' AND o.created_at >= ${since}
      GROUP BY oi1.product_id, oi2.product_id ORDER BY n DESC LIMIT ${limit}`;
    return rows.map((r) => ({ productA: r.a, productB: r.b, orders: Number(r.n) }));
  }

  /* Lịch sử mua của khách (id sản phẩm, mới nhất trước) — AI gợi ý cá nhân hoá. */
  async purchasedProductIds(userId: string, limit = 30): Promise<string[]> {
    const rows = await this.prisma.orderItem.findMany({ where: { order: { userId, isDeleted: false, status: { notIn: ['cancelled'] } } }, orderBy: { order: { createdAt: 'desc' } }, take: limit, select: { productId: true } });
    return [...new Set(rows.map((r) => r.productId))];
  }

  /* Lấy shopId của đơn (để snapshot khi tạo refund) — payment gọi. */
  async shopIdOfOrder(orderCode: string): Promise<string | null> {
    const o = await this.prisma.order.findFirst({ where: { code: orderCode }, select: { shopId: true } });
    return o?.shopId ?? null;
  }

  /* Tổng khách trả + phần voucher sàn chịu của một nhóm đơn — đối soát dùng để chia hoàn tiền theo tỉ lệ doanh thu của đơn. */
  async orderTotalsOf(orderCodes: string[]): Promise<Map<string, { total: Prisma.Decimal; platformDiscount: Prisma.Decimal }>> {
    if (orderCodes.length === 0) return new Map();
    const rows = await this.prisma.order.findMany({ where: { code: { in: orderCodes } }, select: { code: true, total: true, platformDiscount: true } });
    return new Map(rows.map((r) => [r.code, { total: r.total, platformDiscount: r.platformDiscount }]));
  }

  /* Đơn ONLINE (PayOS) đã thu tiền về sàn để tính đối soát (payout) — PLAN-0020: đơn COD không đi đường này (ví đặt cọc). status=completed, `paymentStatus` paid/partially_refunded,
     đã qua hạn đổi trả (tính từ ngày giao) tính đến periodEnd — escrow: không đưa đơn còn trong hạn đổi trả vào kỳ. Payment tự loại đơn đã nằm trong kỳ trước. */
  async settlementOrders(returnWindowDays: number, periodEnd: Date): Promise<Array<{ orderCode: string; shopId: string; total: Prisma.Decimal; platformDiscount: Prisma.Decimal; /* PLAN-0030: gốc hoa hồng = tiền hàng sau voucher shop (không phí ship) */ commissionBase: Prisma.Decimal; shopRevenue?: Prisma.Decimal; commissionRateSnapshot: Prisma.Decimal; settleFrom: Date }>> {
    const cutoff = new Date(periodEnd.getTime() - returnWindowDays * 86_400_000);
    const rows = await this.prisma.order.findMany({
      where: {
        isDeleted: false,
        status: 'completed',
        // PLAN-0020: đơn COD shop tự cầm tiền mặt — sàn trừ hoa hồng từ ví đặt cọc nên KHÔNG đưa vào đối soát chi trả.
        AND:[{OR:[{paymentMethodCode:{not:'cod'}},{collectionMode:'carrier_cod',paymentStatus:{in:['paid','partially_refunded']}}]}],
        paymentStatus: { in: ['paid', 'partially_refunded'] },
        OR: [{ deliveredAt: { lte: cutoff } }, { deliveredAt: null, completedAt: { lte: cutoff } }],
        // Đơn đang có yêu cầu đổi trả CHƯA xong thì giữ lại (escrow) — chi trước rồi mới hoàn thì shop đã nhận tiền thừa, thành nợ mang sang. "Chưa xong" = requested · approved ·
        // escalated · received (đã nhận hàng, khoản hoàn đang chờ payment báo xong — PLAN-0022), VÀ yêu cầu bị SHOP từ chối mà khách còn trong hạn khiếu nại (nếu khiếu nại thắng thì
        // sàn hoàn tiền SAU khi đã chi cho shop). Chỉ refunded/cancelled/expired, rejected do sàn, hoặc rejected do shop đã hết hạn khiếu nại mới được thả.
        returns: { none: { OR: [{ status: { in: [...RETURN_OPEN_STATUSES] } }, { status: RETURN_STATUS.REJECTED, rejectedBy: RETURN_REJECTED_BY.SHOP, escalateDueAt: { gt: new Date() } }] } },
      },
      select: { code: true, fulfilmentMode:true, shopId: true, total: true, platformDiscount: true, subtotal: true, shopDiscount: true, shopShippingDiscount: true, commissionRateSnapshot: true, deliveredAt: true, completedAt: true },
    });
    return rows.map((o) => ({ orderCode: o.code, shopId: o.shopId, total: o.total, platformDiscount: o.platformDiscount, commissionBase: new Prisma.Decimal(commissionBase(o).toString()), ...(o.fulfilmentMode==='carrier' ? {shopRevenue:o.subtotal.sub(o.shopDiscount)}:{}), commissionRateSnapshot: o.commissionRateSnapshot, settleFrom: (o.deliveredAt ?? o.completedAt) as Date }));
  }
}
