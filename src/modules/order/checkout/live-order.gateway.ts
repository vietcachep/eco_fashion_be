import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
  CoveredLiveLine,
  LiveCartSource,
  LiveCommerceOrderGateway,
} from '@common/gateway/live-commerce.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { money } from '@common/response/money-response';
import { PaymentQueryApi } from '@modules/payment/queryapi/payment.queryapi';

/* Số lượng trả được gán LIFO trên snapshot nguồn; cùng SKU có lượng thường không được phục hồi mã nhầm. */
export function returnedFromSession(
  value: unknown,
  total: number,
  returned: number,
  sessionId: string,
): number {
  const sources = Array.isArray(value) ? (value as LiveCartSource[]) : [];
  let left = Math.min(returned, total),
    covered = 0;
  for (let i = sources.length - 1; i >= 0 && left > 0; i--) {
    const s = sources[i];
    const amount = Math.min(left, s.quantity);
    if (s.sessionId === sessionId) covered += amount;
    left -= amount;
  }
  return covered;
}

@Injectable()
export class LiveOrderGateway implements LiveCommerceOrderGateway {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modules: ModuleRef,
  ) {}
  async coverage(orderCode: string, lines: CoveredLiveLine[]) {
    const orders = await this.prisma.order.findMany({
      where: { OR: [{ code: orderCode }, { orderGroup: { code: orderCode } }] },
      include: { items: true, returns: { include: { items: true } } },
    });
    if (!orders.length) return { complete: false, partial: false, pendingRefund: false };
    const moneyState = await this.modules
      .get(PaymentQueryApi, { strict: false })
      .liveRefundSettlement(orders.map((o) => o.code));
    let complete = true,
      partial = false,
      pendingRefund = false;
    for (const covered of lines) {
      const order = orders.find(
        (o) => o.shopId === covered.shopId && o.items.some((i) => i.variantId === covered.variantId),
      );
      const item = order?.items.find((i) => i.variantId === covered.variantId);
      if (!order || !item) {
        complete = false;
        continue;
      }
      const financial = moneyState.get(order.code);
      if (order.status === 'cancelled') {
        const settled =
          !!financial &&
          (!financial.moneyCollected ||
            (!financial.refundPending && financial.refundDone >= BigInt(order.total.toString())));
        if (!settled) {
          complete = false;
          pendingRefund = true;
        } else partial = true;
        continue;
      }
      const returned = order.returns
        .filter((r) => r.status === 'refunded')
        .reduce(
          (n, r) => n + r.items.filter((i) => i.orderItemId === item.id).reduce((s, i) => s + i.quantity, 0),
          0,
        );
      const count = returnedFromSession(item.liveSources, item.quantity, returned, covered.sessionId);
      if (count > 0) partial = true;
      if (count < covered.quantity) complete = false;
      if (
        order.returns.some((r) => r.status === 'received' && r.items.some((i) => i.orderItemId === item.id))
      )
        pendingRefund = true;
    }
    return { complete: complete && !pendingRefund, partial, pendingRefund };
  }
  async report(sessionId: string) {
    const orders = await this.prisma.order.findMany({
      where: { isDeleted: false, items: { some: { liveSources: { array_contains: [{ sessionId }] } } } },
      include: { items: true, returns: { where: { status: 'refunded' }, include: { items: true } } },
    });
    const settlements = await this.modules
      .get(PaymentQueryApi, { strict: false })
      .liveRefundSettlement(orders.filter((o) => o.status === 'cancelled').map((o) => o.code));
    let revenue = 0n,
      refunded = 0n;
    let paidOrders = 0;
    for (const order of orders) {
      if (!['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) continue;
      paidOrders++;
      for (const item of order.items) {
        const sources = Array.isArray(item.liveSources)
          ? (item.liveSources as unknown as LiveCartSource[])
          : [];
        const quantity = sources.filter((s) => s.sessionId === sessionId).reduce((n, s) => n + s.quantity, 0);
        if (!quantity) continue;
        const a = item.discountAllocation as { netGoodsAmount?: string } | null;
        const net = a?.netGoodsAmount
          ? BigInt(a.netGoodsAmount)
          : (BigInt(item.lineTotal.toString()) *
              (BigInt(order.subtotal.toString()) -
                (BigInt(order.discount.toString()) -
                  BigInt(order.shopShippingDiscount.toString()) -
                  BigInt(order.platformShippingDiscount.toString())))) /
            BigInt(order.subtotal.toString());
        revenue += (net * BigInt(quantity)) / BigInt(item.quantity);
        const returned = order.returns.reduce(
          (n, r) => n + r.items.filter((i) => i.orderItemId === item.id).reduce((s, i) => s + i.quantity, 0),
          0,
        );
        const settlement = settlements.get(order.code);
        const cancelledRefunded =
          order.status === 'cancelled' &&
          settlement?.moneyCollected &&
          !settlement.refundPending &&
          settlement.refundDone >= BigInt(order.total.toString());
        refunded +=
          (net *
            BigInt(
              cancelledRefunded
                ? quantity
                : Math.min(
                    quantity,
                    returnedFromSession(item.liveSources, item.quantity, returned, sessionId),
                  ),
            )) /
          BigInt(item.quantity);
      }
    }
    return { orders: orders.length, paidOrders, revenue: money(revenue), refunded: money(refunded) };
  }
}
