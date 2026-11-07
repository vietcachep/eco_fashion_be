import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import type { BasketForPromotion } from '@common/gateway/promotion.gateway';
import { LIVE_SOURCE_GATEWAY, type LiveSourceGateway } from '@common/gateway/live-source.gateway';
import {
  LIVE_COMMERCE_ORDER_GATEWAY,
  LIVE_RECOVERY_CHECKOUT_GATEWAY,
  type CoveredLiveLine,
  type LiveCommerceOrderGateway,
  type LiveRecoveryCheckoutGateway,
} from '@common/gateway/live-commerce.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';
import { money, moneyOrNull } from '@common/response/money-response';
import { PageResponse } from '@common/response/api-response';
import {
  CreateLiveCampaignRequest,
  LiveCampaignResponse,
  LiveVoucherClaimResponse,
} from './live-voucher.dto';

type Promo = {
  id: string;
  code: string;
  name: string;
  type: string;
  scope: string;
  shopId: string | null;
  liveCampaignId: string | null;
  value: Prisma.Decimal;
  minOrderAmount: Prisma.Decimal;
  maxDiscount: Prisma.Decimal | null;
  usageLimit: number | null;
  usedCount: number;
};
type Claim = {
  id: string;
  campaignId: string;
  state: string;
  recoveryEntitlementId: string | null;
  restoreReason: string | null;
};
type Prepared = {
  basket: BasketForPromotion;
  error?: string;
  weights: Record<string, string>;
  covered: CoveredLiveLine[];
  claimId?: string;
  campaignId: string;
};

/* Policy thuộc promotion. ModuleRef chỉ dùng cho các cổng ngược tới order lúc chạy, tránh vòng DI ở constructor. */
@Injectable()
export class LiveVoucherService {
  private readonly logger = new Logger(LiveVoucherService.name);
  private sweeping = false;
  private sweepCursor: string | undefined;
  constructor(
    private readonly prisma: PrismaService,
    private readonly modules: ModuleRef,
    @Optional() @Inject(LIVE_SOURCE_GATEWAY) private readonly source?: LiveSourceGateway,
  ) {}
  private async audit(
    tx: Tx,
    actor: string | null,
    action: string,
    id: string,
    summary: Prisma.InputJsonValue,
  ) {
    await tx.livePromotionAudit.create({ data: { actorUserId: actor, action, entityId: id, summary } });
  }
  private async session(id: string) {
    const s = await this.source?.session(id);
    if (!s) throw new NotFoundException('LIVE_SESSION_NOT_FOUND', 'Không tìm thấy phiên live công khai');
    return s;
  }
  async activate(sessionId: string) {
    const session = await this.session(sessionId);
    if (!session.startedAt) return session;
    const until = new Date(session.startedAt.getTime() + 24 * 3600_000);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM promotion.live_campaigns WHERE session_id=${sessionId}::uuid ORDER BY id FOR UPDATE`;
      const drafts = await tx.liveVoucherCampaign.findMany({
        where: { sessionId, state: 'draft', isDeleted: false },
        select: { id: true, promotionId: true },
      });
      if (!drafts.length) return;
      await tx.liveVoucherCampaign.updateMany({
        where: { id: { in: drafts.map((d) => d.id) }, state: 'draft' },
        data: { state: 'active', redeemUntil: until, version: { increment: 1 } },
      });
      await tx.promotion.updateMany({
        where: { id: { in: drafts.map((d) => d.promotionId) } },
        data: { isActive: true, startsAt: session.startedAt!, endsAt: until },
      });
    });
    return session;
  }
  async create(
    userId: string,
    shopId: string,
    sessionId: string,
    input: CreateLiveCampaignRequest,
    scope: 'shop' | 'platform' = 'shop',
  ): Promise<LiveCampaignResponse> {
    const session = await this.session(sessionId);
    if (session.shopId !== shopId || !['draft', 'scheduled', 'live'].includes(session.state))
      throw new BusinessException(
        'LIVE_CAMPAIGN_LOCKED',
        'Không tạo ưu đãi cho phiên đã kết thúc hoặc bị dừng',
        409,
      );
    if (input.type === 'percentage' && (input.value <= 0 || input.value > 100))
      throw new BusinessException('PROMOTION_INVALID', 'Phần trăm giảm phải lớn hơn0 và không quá100');
    if (input.type === 'fixed_amount' && input.value <= 0)
      throw new BusinessException('PROMOTION_INVALID', 'Số tiền giảm phải lớn hơn0');
    const campaignId = randomUUID();
    const promotionId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'live-campaign:' + sessionId}, 0))`;
      if (await tx.liveVoucherCampaign.count({ where: { sessionId, isDeleted: false } }) >= 50)
        throw new BusinessException('LIVE_CAMPAIGN_LIMIT', 'Mỗi phiên tối đa 50 ưu đãi', 409);
      await tx.promotion.create({
        data: {
          id: promotionId,
          liveCampaignId: campaignId,
          code: input.code.toUpperCase(),
          name: input.name.trim(),
          type: input.type,
          value: input.type === 'free_shipping' ? 0 : input.value,
          minOrderAmount: input.minOrderAmount ?? '0',
          maxDiscount: input.maxDiscount ?? null,
          usageLimit: input.usageLimit ?? 100,
          usageLimitPerUser: 1,
          scope,
          shopId: scope === 'shop' ? shopId : null,
          isPublic: false,
          isActive: false,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 24 * 3600_000),
          createdBy: userId,
          updatedBy: userId,
        },
      });
      await tx.liveVoucherCampaign.create({
        data: {
          id: campaignId,
          promotionId,
          sessionId,
          shopId,
          claimLimit: input.claimLimit ?? 100,
          createdBy: userId,
          updatedBy: userId,
        },
      });
      await this.audit(tx, userId, 'LIVE_CAMPAIGN_CREATED', campaignId, {
        sessionId,
        policyVersion: 'FITLY_LIVE_V1',
        scope,
      });
    });
    return (await this.list(sessionId, userId)).find((c) => c.id === campaignId)!;
  }
  async list(sessionId: string, userId?: string): Promise<LiveCampaignResponse[]> {
    await this.activate(sessionId);
    const campaigns = await this.prisma.liveVoucherCampaign.findMany({
      where: { sessionId, isDeleted: false },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const [promotions, claims] = await Promise.all([
      this.prisma.promotion.findMany({ where: { id: { in: campaigns.map((c) => c.promotionId) } } }),
      userId
        ? this.prisma.liveVoucherClaim.findMany({
            where: { campaignId: { in: campaigns.map((c) => c.id) }, userId },
          })
        : Promise.resolve([]),
    ]);
    const ps = new Map(promotions.map((p) => [p.id, p]));
    const cs = new Map(claims.map((c) => [c.campaignId, c]));
    return campaigns.flatMap((c) => {
      const p = ps.get(c.promotionId);
      if (!p) return [];
      return [
        {
          id: c.id,
          sessionId,
          shopId: c.shopId,
          code: p.code,
          name: p.name,
          type: p.type,
          scope: p.scope,
          value: p.value.toString(),
          minOrderAmount: money(p.minOrderAmount.toString()),
          maxDiscount: moneyOrNull(p.maxDiscount?.toString()),
          claimLimit: c.claimLimit,
          usageLimit: p.usageLimit,
          claimedCount: c.claimedCount,
          usedCount: p.usedCount,
          state: c.state,
          redeemUntil: c.redeemUntil?.toISOString() ?? null,
          policyVersion: c.policyVersion,
          claim: cs.has(c.id) ? this.claimDto(cs.get(c.id)!, c, p) : null,
        },
      ];
    });
  }
  private claimDto(
    c: Claim,
    campaign: { redeemUntil: Date | null; state: string; policyVersion: string },
    p: { code: string; name: string },
  ): LiveVoucherClaimResponse {
    const state =
      campaign.state === 'revoked'
        ? 'revoked'
        : campaign.redeemUntil && campaign.redeemUntil < new Date()
          ? 'expired'
          : c.state;
    return {
      id: c.id,
      campaignId: c.campaignId,
      code: p.code,
      name: p.name,
      state,
      redeemUntil: campaign.redeemUntil?.toISOString() ?? null,
      policyVersion: campaign.policyVersion,
      recoveryEntitlementId: c.recoveryEntitlementId,
      restoreReason: c.restoreReason,
    };
  }
  async claim(userId: string, sessionId: string, campaignId: string): Promise<LiveVoucherClaimResponse> {
    const session = await this.activate(sessionId);
    if (session.state !== 'live' || !(await this.source?.canClaim(userId, sessionId)))
      throw new BusinessException('LIVE_ADMISSION_REQUIRED', 'Bạn cần đang xem phiên live để nhận mã', 409);
    const id = await this.prisma.$transaction(async (tx) => {
      if (!(await this.source?.canClaim(userId, sessionId, tx)))
        throw new BusinessException('LIVE_ADMISSION_REQUIRED', 'Bạn cần đang xem phiên live để nhận mã', 409);
      await tx.$queryRaw`SELECT id FROM promotion.live_campaigns WHERE id=${campaignId}::uuid FOR UPDATE`;
      const c = await tx.liveVoucherCampaign.findFirst({
        where: { id: campaignId, sessionId, isDeleted: false },
      });
      if (!c) throw new NotFoundException('LIVE_CAMPAIGN_NOT_FOUND', 'Không tìm thấy ưu đãi');
      const existing = await tx.liveVoucherClaim.findUnique({
        where: { campaignId_userId: { campaignId, userId } },
      });
      if (existing) return existing.id;
      if (
        c.state !== 'active' ||
        !c.redeemUntil ||
        c.redeemUntil < new Date() ||
        c.claimedCount >= c.claimLimit
      )
        throw new BusinessException(
          'LIVE_CLAIM_UNAVAILABLE',
          'Mã đã hết lượt nhận hoặc không còn mở nhận',
          409,
        );
      const claim = await tx.liveVoucherClaim.create({ data: { campaignId, userId } });
      await tx.liveVoucherCampaign.update({
        where: { id: campaignId },
        data: { claimedCount: { increment: 1 }, version: { increment: 1 } },
      });
      await this.audit(tx, userId, 'LIVE_VOUCHER_CLAIMED', claim.id, { campaignId });
      return claim.id;
    });
    const result = (await this.list(sessionId, userId)).find((c) => c.id === campaignId)?.claim;
    if (!result || result.id !== id)
      throw new BusinessException('LIVE_CLAIM_UNAVAILABLE', 'Không tải được phiếu ưu đãi', 503);
    return result;
  }
  async change(
    userId: string,
    shopId: string,
    sessionId: string,
    id: string,
    state: 'closed' | 'revoked',
    reason: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM promotion.live_campaigns WHERE id=${id}::uuid FOR UPDATE`;
      const c = await tx.liveVoucherCampaign.findFirst({
        where: { id, sessionId, shopId, isDeleted: false },
      });
      if (!c) throw new NotFoundException('LIVE_CAMPAIGN_NOT_FOUND', 'Không tìm thấy ưu đãi của shop');
      if (c.state === 'revoked') return;
      await tx.liveVoucherCampaign.update({
        where: { id },
        data: { state, reason, version: { increment: 1 }, updatedBy: userId },
      });
      if (state === 'revoked')
        await tx.promotion.update({ where: { id: c.promotionId }, data: { isActive: false } });
      await this.audit(tx, userId, 'LIVE_CAMPAIGN_' + state.toUpperCase(), id, { reason });
    });
    return this.list(sessionId, userId);
  }
  async prepare(p: Promo, basket: BasketForPromotion, tx?: Tx): Promise<Prepared> {
    const empty: Prepared = {
      basket: { ...basket, subtotal: 0n, lines: [] },
      weights: {},
      covered: [],
      campaignId: p.liveCampaignId ?? '',
    };
    if (!p.liveCampaignId) return { ...empty, basket };
    const db = tx ?? this.prisma;
    const c = await db.liveVoucherCampaign.findUnique({ where: { id: p.liveCampaignId } });
    if (!c) return { ...empty, error: 'Ưu đãi live không tồn tại' };
    const claim = await db.liveVoucherClaim.findUnique({
      where: { campaignId_userId: { campaignId: c.id, userId: basket.userId } },
    });
    if (c.state === 'revoked' || !c.redeemUntil || c.redeemUntil < new Date())
      return { ...empty, error: 'Ưu đãi live đã hết hạn hoặc bị thu hồi' };
    if (!claim || !['available', 'restored'].includes(claim.state))
      return {
        ...empty,
        error: claim ? 'Mã đang dùng cho đơn khác hoặc chưa được khôi phục' : 'Bạn chưa nhận mã trong live',
      };
    const covered: CoveredLiveLine[] = [];
    const lines: BasketForPromotion['lines'] = [];
    for (const l of basket.lines) {
      if (!l.variantId || !l.quantity || l.unitPrice === undefined || l.shopId !== c.shopId) continue;
      const sources = (l.liveSources ?? []).filter(
        (s) =>
          s.sessionId === c.sessionId &&
          s.productId === l.productId &&
          Date.parse(s.eligibleUntil) > Date.now() &&
          (!s.recoveryEntitlementId || s.recoveryEntitlementId === claim.recoveryEntitlementId),
      );
      const quantity = Math.min(
        l.quantity,
        sources.reduce((n, s) => n + s.quantity, 0),
      );
      if (!quantity) continue;
      lines.push({ ...l, quantity, lineTotal: l.unitPrice * BigInt(quantity), liveSources: sources });
      covered.push({
        variantId: l.variantId,
        productId: l.productId,
        shopId: c.shopId,
        sessionId: c.sessionId,
        quantity,
      });
    }
    if (!lines.length) return { ...empty, error: 'Chỉ áp dụng cho số lượng được thêm hoặc mua từ live này' };
    const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0n);
    const shippingFee =
      basket.shippingByShop?.[c.shopId] ?? (basket.shopId === c.shopId ? basket.shippingFee : 0n);
    return {
      basket: { ...basket, lines, subtotal, shippingFee },
      weights: { [c.shopId]: (p.type === 'free_shipping' ? shippingFee : subtotal).toString() },
      covered,
      claimId: claim.id,
      campaignId: c.id,
    };
  }
  async consumed(
    p: Promo,
    basket: BasketForPromotion,
    usageId: string,
    orderCode: string,
    discount: bigint,
    tx: Tx,
  ) {
    const prepared = await this.prepare(p, basket, tx);
    if (prepared.error || !prepared.claimId)
      throw new BusinessException(
        'LIVE_CLAIM_UNAVAILABLE',
        prepared.error ?? 'Phiếu không còn sẵn sàng',
        409,
      );
    const useId = randomUUID();
    const won = await tx.liveVoucherClaim.updateMany({
      where: { id: prepared.claimId, state: { in: ['available', 'restored'] } },
      data: { state: 'used', activeUseId: useId, recoveryEntitlementId: null, version: { increment: 1 } },
    });
    if (!won.count) throw new BusinessException('LIVE_CLAIM_IN_USE', 'Mã vừa được dùng cho đơn khác', 409);
    await tx.liveVoucherUse.create({
      data: {
        id: useId,
        claimId: prepared.claimId,
        campaignId: prepared.campaignId,
        promotionUsageId: usageId,
        orderCode,
        discount: discount.toString(),
        covered: JSON.parse(JSON.stringify(prepared.covered)) as Prisma.InputJsonValue,
      },
    });
    await this.audit(tx, basket.userId, 'LIVE_VOUCHER_USED', useId, {
      orderCode,
      policyVersion: 'FITLY_LIVE_V1',
    });
  }
  async claims(userId: string, page: number, size: number) {
    await this.reconcile();
    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.liveVoucherClaim.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.liveVoucherClaim.count({ where }),
    ]);
    const campaigns = await this.prisma.liveVoucherCampaign.findMany({
      where: { id: { in: rows.map((r) => r.campaignId) } },
    });
    const cs = new Map(campaigns.map((c) => [c.id, c]));
    const ps = new Map(
      (
        await this.prisma.promotion.findMany({ where: { id: { in: campaigns.map((c) => c.promotionId) } } })
      ).map((p) => [p.id, p]),
    );
    const uses = new Map(
      (
        await this.prisma.liveVoucherUse.findMany({
          where: { id: { in: rows.flatMap((r) => (r.activeUseId ? [r.activeUseId] : [])) } },
        })
      ).map((u) => [u.id, u.state]),
    );
    return PageResponse.of(
      rows.flatMap((r) => {
        const c = cs.get(r.campaignId);
        const p = c ? ps.get(c.promotionId) : null;
        if (!c || !p) return [];
        const state = r.activeUseId ? uses.get(r.activeUseId) : undefined;
        return [
          this.claimDto(
            {
              ...r,
              state:
                state === 'pending_refund' ? 'pending_refund' : state === 'partial' ? 'partial' : r.state,
            },
            c,
            p,
          ),
        ];
      }),
      page,
      size,
      total,
    );
  }
  async recovery(userId: string, id: string) {
    await this.reconcile();
    const claim = await this.prisma.liveVoucherClaim.findFirst({ where: { id, userId, state: 'restored' } });
    if (!claim?.recoveryEntitlementId)
      throw new BusinessException(
        'LIVE_RECOVERY_UNAVAILABLE',
        'Mã chưa được khôi phục hoặc không có quyền mua lại',
        409,
      );
    const c = await this.prisma.liveVoucherCampaign.findUniqueOrThrow({ where: { id: claim.campaignId } });
    if (c.state === 'revoked' || !c.redeemUntil || c.redeemUntil < new Date())
      throw new BusinessException('LIVE_RECOVERY_EXPIRED', 'Mã đã hết hạn hoặc bị thu hồi', 409);
    const lines = claim.recoveryLines as unknown as CoveredLiveLine[];
    return this.modules
      .get<LiveRecoveryCheckoutGateway>(LIVE_RECOVERY_CHECKOUT_GATEWAY, { strict: false })
      .createRecovery(
        userId,
        claim.recoveryEntitlementId,
        lines.map((l) => ({ ...l, eligibleUntil: c.redeemUntil!.toISOString() })),
      );
  }
  @Interval(30_000)
  async reconcile(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const orderGateway = this.modules.get<LiveCommerceOrderGateway>(LIVE_COMMERCE_ORDER_GATEWAY, {
        strict: false,
      });
      const rows = await this.prisma.liveVoucherUse.findMany({
        where: {
          state: { in: ['active', 'partial', 'pending_refund'] },
          ...(this.sweepCursor ? { id: { gt: this.sweepCursor } } : {}),
        },
        take: 50,
        orderBy: { id: 'asc' },
      });
      this.sweepCursor = rows.length === 50 ? rows[rows.length - 1].id : undefined;
      for (const use of rows) {
        const covered = use.covered as unknown as CoveredLiveLine[];
        const state = await orderGateway.coverage(use.orderCode, covered);
        if (!state.complete) {
          const s = state.pendingRefund ? 'pending_refund' : state.partial ? 'partial' : 'active';
          if (s !== use.state)
            await this.prisma.liveVoucherUse.updateMany({ where: { id: use.id, restoredAt: null, state: { in: ['active', 'partial', 'pending_refund'] } }, data: { state: s } });
          continue;
        }
        await this.prisma.$transaction(async (tx) => {
          const won = await tx.liveVoucherUse.updateMany({
            where: { id: use.id, restoredAt: null },
            data: { state: 'closed', restoredAt: new Date() },
          });
          if (!won.count) return;
          const c = await tx.liveVoucherCampaign.findUniqueOrThrow({ where: { id: use.campaignId } });
          const usage = await tx.promotionUsage.findUniqueOrThrow({ where: { id: use.promotionUsageId } });
          const released = await tx.promotionUsage.updateMany({
            where: { id: usage.id, releasedAt: null },
            data: { releasedAt: new Date() },
          });
          if (released.count)
            await tx.promotion.update({
              where: { id: usage.promotionId },
              data: { usedCount: { decrement: 1 } },
            });
          const available = c.state !== 'revoked' && !!c.redeemUntil && c.redeemUntil > new Date();
          await tx.liveVoucherClaim.updateMany({
            where: { id: use.claimId, activeUseId: use.id },
            data: {
              state: available ? 'restored' : c.state === 'revoked' ? 'revoked' : 'expired',
              activeUseId: null,
              recoveryEntitlementId: available ? randomUUID() : null,
              recoveryLines: use.covered as Prisma.InputJsonValue,
              restoreReason: available
                ? 'Đã huỷ/hoàn toàn bộ phần hàng áp mã'
                : c.state === 'revoked'
                  ? 'Campaign đã thu hồi'
                  : 'Mã đã hết hạn; không gia hạn',
              version: { increment: 1 },
            },
          });
          await this.audit(tx, null, 'LIVE_VOUCHER_RESTORATION_SETTLED', use.id, {
            available,
            policyVersion: 'FITLY_LIVE_V1',
          });
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Chưa đối soát được voucher live; sẽ thử lại',
      );
    } finally {
      this.sweeping = false;
    }
  }
}
