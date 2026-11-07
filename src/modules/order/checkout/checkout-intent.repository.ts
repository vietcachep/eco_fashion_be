import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import {
  LIVE_CART_GATEWAY,
  type LiveCartGateway,
  type LiveCartSource,
} from '@common/gateway/live-commerce.gateway';
import { IdempotencyService } from '@common/idempotency/idempotency.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { money } from '@common/response/money-response';
import { CartQueryApi, type Basket } from '@modules/cart/queryapi/cart.queryapi';
import { ProductQueryApi } from '@modules/product/queryapi/product.queryapi';
import { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { CreateCheckoutIntentRequest, CheckoutIntentResponse } from './checkout-intent.dto';

export interface StoredIntentLine {
  variantId: string;
  quantity: number;
  sourceLots: LiveCartSource[];
}
export function intentLines(value: unknown): StoredIntentLine[] {
  if (!Array.isArray(value))
    throw new BusinessException('CHECKOUT_SNAPSHOT_INVALID', 'Dữ liệu lần mua không hợp lệ', 409);
  return value.map((v: unknown) => {
    const line = v as StoredIntentLine;
    if (
      !line ||
      typeof line.variantId !== 'string' ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      !Array.isArray(line.sourceLots)
    )
      throw new BusinessException('CHECKOUT_SNAPSHOT_INVALID', 'Dữ liệu lần mua không hợp lệ', 409);
    return line;
  });
}

/* Intent là snapshot riêng, không đổi tick giỏ. Lệnh tạo đơn khoá intent và commit kết quả cùng order. */
@Injectable()
export class CheckoutIntentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductQueryApi,
    private readonly cart: CartQueryApi,
    private readonly system: SystemQueryApi,
    @Inject(LIVE_CART_GATEWAY) private readonly cartWrite: LiveCartGateway,
  ) {}

  async create(userId: string, input: CreateCheckoutIntentRequest, requestKey: string) {
    const hash = IdempotencyService.hashRequest(input);
    const old = await this.prisma.checkoutIntent.findUnique({
      where: { userId_requestKey: { userId, requestKey } },
    });
    if (old) {
      if (old.requestHash !== hash)
        throw new BusinessException(
          'COMMON_IDEMPOTENCY_KEY_REUSED',
          'Mã yêu cầu đã dùng cho nội dung khác',
          409,
        );
      return this.response(userId, old.id);
    }
    const mode = input.mode;
    const selected = mode === 'cart_selection' ? await this.cart.basketOf(userId, true) : null;
    if (mode === 'cart_selection' && input.lines?.length)
      throw new BusinessException('CHECKOUT_SELECTION_INVALID', 'Chọn món ở giỏ trước khi tạo lần mua');
    const requested = selected
      ? selected.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }))
      : (input.lines ?? []);
    if (
      !requested.length ||
      requested.length > 50 ||
      new Set(requested.map((l) => l.variantId)).size !== requested.length
    )
      throw new BusinessException('CHECKOUT_LINES_INVALID', 'Vui lòng chọn các sản phẩm khác nhau cần mua');
    const limit = await this.system.settingNumber(SETTING_KEY.CART_MAX_QTY_PER_LINE);
    if (requested.some((l) => l.quantity > limit))
      throw new BusinessException('CART_QTY_LIMIT', `Mỗi sản phẩm tối đa ${limit} cái`);
    const snapshots = await this.products.variantSnapshots(requested.map((l) => l.variantId));
    for (const line of requested) {
      const p = snapshots.get(line.variantId);
      if (!p?.isSellable || p.available < line.quantity)
        throw new BusinessException(
          'ORDER_OUT_OF_STOCK',
          'Sản phẩm không còn bán hoặc không đủ số lượng',
          409,
        );
    }
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const lines: StoredIntentLine[] = [];
      for (const line of requested) {
        const source = input.lines?.find((l) => l.variantId === line.variantId)?.sourceGrantId;
        const lots =
          selected?.lines.find((l) => l.variantId === line.variantId)?.sourceLots ??
          (source
            ? await this.cartWrite.claimIntentSources(
                userId,
                id,
                [
                  {
                    grantId: source,
                    productId: snapshots.get(line.variantId)!.productId,
                    quantity: line.quantity,
                  },
                ],
                tx,
              )
            : []);
        lines.push({ ...line, sourceLots: lots });
      }
      await tx.checkoutIntent.create({
        data: {
          id,
          userId,
          mode,
          requestKey,
          requestHash: hash,
          lines: JSON.parse(JSON.stringify(lines)) as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + 30 * 60_000),
          createdBy: userId,
          updatedBy: userId,
        },
      });
    });
    return this.response(userId, id);
  }

  async createRecovery(
    userId: string,
    entitlementId: string,
    lines: Array<{
      variantId: string;
      productId: string;
      shopId: string;
      sessionId: string;
      quantity: number;
      eligibleUntil: string;
    }>,
  ) {
    const requestKey = 'recovery:' + entitlementId;
    const old = await this.prisma.checkoutIntent.findUnique({
      where: { userId_requestKey: { userId, requestKey } },
    });
    if (old && (old.state === 'submitting' || (old.state !== 'consumed' && old.expiresAt > new Date())))
      return this.response(userId, old.id);
    const id = randomUUID();
    const key = old ? requestKey + ':' + id : requestKey;
    const stored = lines.map((l) => ({
      variantId: l.variantId,
      quantity: l.quantity,
      sourceLots: [
        {
          id: entitlementId,
          recoveryEntitlementId: entitlementId,
          sessionId: l.sessionId,
          productId: l.productId,
          shopId: l.shopId,
          quantity: l.quantity,
          eligibleUntil: l.eligibleUntil,
        },
      ],
    }));
    await this.prisma.checkoutIntent.create({
      data: {
        id,
        userId,
        mode: 'buy_now',
        requestKey: key,
        requestHash: IdempotencyService.hashRequest(stored),
        lines: stored,
        expiresAt: new Date(Date.now() + 30 * 60_000),
        createdBy: userId,
        updatedBy: userId,
      },
    });
    return this.response(userId, id);
  }

  async row(userId: string, id: string, tx?: Tx, lock = false) {
    if (lock && tx)
      await tx.$queryRaw`SELECT id FROM "order".checkout_intents WHERE id=${id}::uuid AND user_id=${userId}::uuid FOR UPDATE`;
    const r = await (tx ?? this.prisma).checkoutIntent.findFirst({ where: { id, userId, isDeleted: false } });
    if (!r) throw new NotFoundException('CHECKOUT_INTENT_NOT_FOUND', 'Không tìm thấy lần mua');
    return r;
  }

  async basket(userId: string, id: string, tx?: Tx): Promise<Basket> {
    const r = await this.row(userId, id, tx);
    if (r.state === 'consumed')
      throw new BusinessException('CHECKOUT_ALREADY_PLACED', 'Lần mua này đã có đơn hàng', 409);
    if (r.expiresAt < new Date() && r.state !== 'submitting')
      throw new BusinessException(
        'CHECKOUT_INTENT_EXPIRED',
        'Lần mua đã hết hạn, hãy chọn lại sản phẩm',
        409,
      );
    const lines = intentLines(r.lines);
    const snapshots = await this.products.variantSnapshots(lines.map((l) => l.variantId));
    const mapped = lines.map((l) => {
      const p = snapshots.get(l.variantId);
      if (!p) throw new BusinessException('ORDER_CART_CHANGED', 'Một sản phẩm không còn tồn tại', 409);
      const unitPrice = BigInt(p.unitPrice);
      return {
        ...p,
        quantity: l.quantity,
        unitPrice,
        lineTotal: unitPrice * BigInt(l.quantity),
        sourceLots: l.sourceLots,
      };
    });
    return {
      userId,
      lines: mapped,
      subtotal: mapped.filter((l) => l.isSellable).reduce((s, l) => s + l.lineTotal, 0n),
      itemCount: mapped.reduce((s, l) => s + l.quantity, 0),
    };
  }

  async response(userId: string, id: string): Promise<CheckoutIntentResponse> {
    const row = await this.row(userId, id);
    const stored = intentLines(row.lines);
    const snapshots = await this.products.variantSnapshots(stored.map((l) => l.variantId));
    const latest = await this.prisma.checkoutAttempt.findFirst({
      where: { intentId: id, userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const lines = stored.map((l) => {
      const p = snapshots.get(l.variantId);
      const eligible = l.sourceLots.filter((s) => Date.parse(s.eligibleUntil) > Date.now());
      return {
        variantId: l.variantId,
        productId: p?.productId ?? '',
        shopId: p?.shopId ?? '',
        slug: p?.slug ?? '',
        name: p?.name ?? 'Sản phẩm không còn bán',
        imageUrl: p?.imageUrl ?? null,
        color: p?.color ?? '',
        size: p?.size ?? '',
        quantity: l.quantity,
        unitPrice: money(p?.unitPrice ?? '0'),
        lineTotal: money(BigInt(p?.unitPrice ?? '0') * BigInt(l.quantity)),
        sourceSessionId: eligible[0]?.sessionId ?? null,
        eligibleQuantity: eligible.reduce((s, l) => s + l.quantity, 0),
      };
    });
    return {
      id: row.id,
      version: row.version,
      mode: row.mode,
      state: row.state === 'active' && row.expiresAt < new Date() ? 'expired' : row.state,
      expiresAt: row.expiresAt.toISOString(),
      lines,
      itemCount: stored.reduce((s, l) => s + l.quantity, 0),
      resultGroupCode: row.resultGroupCode,
      latestAttemptId: latest?.id ?? null,
    };
  }

  async committed(userId: string, id: string, groupCode: string, tx: Tx) {
    const row = await this.row(userId, id, tx);
    if (row.mode === 'cart_selection')
      await this.cartWrite.consumeSnapshot(userId, intentLines(row.lines), tx);
    await tx.checkoutIntent.update({
      where: { id },
      data: { state: 'consumed', resultGroupCode: groupCode, updatedBy: userId },
    });
    await tx.checkoutAttempt.updateMany({
      where: { intentId: id, userId, state: 'processing' },
      data: { state: 'succeeded', groupCode, leaseUntil: null },
    });
  }
}
