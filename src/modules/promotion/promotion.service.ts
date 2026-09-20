import { Injectable, Logger } from '@nestjs/common';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import { BasketForPromotion, PromotionGateway, PromotionQuote } from '@common/gateway/promotion.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import { money, MoneyResponse, moneyOrNull } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { minVnd, percentOf, vnd } from '@common/utils/money';

export const PROMOTION_MODULE = 'promotion';
export const PROMO_TYPE = { PERCENTAGE: 'percentage', FIXED: 'fixed_amount', FREE_SHIPPING: 'free_shipping' } as const;
export const PROMO_ERR = { NOT_FOUND: 'PROMOTION_NOT_FOUND', CODE_EXISTS: 'PROMOTION_CODE_EXISTS', INVALID: 'PROMOTION_INVALID' } as const;

/* Phiếu voucher cho web (FE `PromotionOfferResponse`): mức giảm THẬT cho giỏ hiện tại + đủ điều kiện hay còn thiếu. */
export interface PromotionOfferResponse {
  code: string;
  type: string;
  name: string | null;
  description: string | null;
  endAt: string;
  displayDiscount: MoneyResponse;
  displayValue: MoneyResponse | null;
  displayMinOrderAmount: MoneyResponse | null;
  displayMaxDiscount: MoneyResponse | null;
  displayMissingAmount: MoneyResponse | null;
  percentValue: number | null;
  eligible: boolean;
  reason: string | null;
}

export interface PromotionAdminResponse extends PromotionOfferResponse {
  id: string;
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  usedCount: number;
  appliesTo: string;
  targets: Array<{ targetType: string; targetRef: string }>;
  startAt: string;
  isActive: boolean;
  isPublic: boolean;
}

export interface PromotionInput {
  code?: string;
  name?: string;
  description?: string | null;
  type?: string;
  value?: string;
  maxDiscount?: string | null;
  minOrderAmount?: string;
  usageLimit?: number | null;
  usageLimitPerUser?: number | null;
  appliesTo?: string;
  targets?: Array<{ targetType: string; targetRef: string }>;
  startsAt?: string;
  endsAt?: string;
  isActive?: boolean;
  isPublic?: boolean;
}

type PromoRow = Prisma.PromotionGetPayload<{ include: { targets: true } }>;

/*
 * Khuyến mãi (PLAN-0008). Tính giảm: percentage (có trần), fixed_amount (không quá subtotal), free_shipping (= phí ship).
 * Phạm vi: all | category (slug) | product (id) — chỉ tính trên dòng khớp. Điều kiện: hiệu lực thời gian, active, đơn tối thiểu,
 * hạn mức tổng/mỗi khách. `consume` khoá dòng promotions (FOR UPDATE) rồi kiểm lần cuối → không vượt hạn mức khi đặt song song.
 */
@Injectable()
export class PromotionService implements PromotionGateway {
  private readonly logger = new Logger(PromotionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ tính toán thuần

  static discountOf(p: { type: string; value: Prisma.Decimal | string; maxDiscount: Prisma.Decimal | string | null; appliesTo: string; targets: Array<{ targetType: string; targetRef: string }> }, basket: BasketForPromotion): bigint {
    const eligibleLines = basket.lines.filter((l) => {
      if (p.appliesTo === 'all') return true;
      return p.targets.some((t) => (t.targetType === 'category' && t.targetRef === l.categorySlug) || (t.targetType === 'product' && t.targetRef === l.productId));
    });
    const base = eligibleLines.reduce((s, l) => s + l.lineTotal, 0n);
    if (p.type === PROMO_TYPE.FREE_SHIPPING) return base > 0n ? basket.shippingFee : 0n;
    if (base <= 0n) return 0n;
    if (p.type === PROMO_TYPE.PERCENTAGE) {
      const d = percentOf(base, Number(p.value.toString()));
      return p.maxDiscount ? minVnd(d, vnd(p.maxDiscount.toString())) : d;
    }
    return minVnd(vnd(p.value.toString()), base);
  }

  private async evaluate(p: PromoRow, basket: BasketForPromotion, tx?: Tx | null): Promise<PromotionQuote> {
    const now = new Date();
    const q = (error: string | null, discount = 0n, missing: bigint | null = null): PromotionQuote => ({ ok: error === null, code: p.code, name: p.name, type: p.type, discount, error, missingAmount: missing });
    if (!p.isActive || p.isDeleted) return q('Mã không tồn tại hoặc đã hết hạn');
    if (p.startsAt > now) return q('Mã chưa đến thời gian áp dụng');
    if (p.endsAt < now) return q('Mã đã hết hạn');
    if (p.usageLimit !== null && p.usedCount >= p.usageLimit) return q('Mã đã hết lượt sử dụng');
    const min = vnd(p.minOrderAmount.toString());
    if (basket.subtotal < min) return q(`Đơn tối thiểu ${money(min).display} mới dùng được mã này`, 0n, min - basket.subtotal);
    if (p.usageLimitPerUser !== null) {
      const used = await (tx ?? this.prisma).promotionUsage.count({ where: { promotionId: p.id, userId: basket.userId, releasedAt: null } });
      if (used >= p.usageLimitPerUser) return q('Bạn đã dùng hết lượt của mã này');
    }
    const discount = PromotionService.discountOf(p, basket);
    // Freeship: đủ điều kiện dù phí ship hiện = 0 (chưa biết tỉnh ở bước giỏ / đã freeship theo ngưỡng) — giảm thật tính lúc checkout.
    if (p.type === PROMO_TYPE.FREE_SHIPPING) return basket.lines.length > 0 ? q(null, discount) : q('Giỏ hàng trống');
    if (discount <= 0n) return q('Mã không áp dụng cho sản phẩm trong giỏ');
    return q(null, discount);
  }

  private async findByCode(code: string, tx?: Tx | null): Promise<PromoRow | null> {
    return (tx ?? this.prisma).promotion.findFirst({ where: { code: { equals: code.trim(), mode: 'insensitive' }, isDeleted: false }, include: { targets: true } });
  }

  // ------------------------------------------------------------------ gateway

  async quote(code: string, basket: BasketForPromotion): Promise<PromotionQuote> {
    const p = await this.findByCode(code);
    if (!p) return { ok: false, code: code.trim().toUpperCase(), name: null, type: 'unknown', discount: 0n, error: 'Mã không tồn tại hoặc đã hết hạn', missingAmount: null };
    return this.evaluate(p, basket);
  }

  async consume(code: string, basket: BasketForPromotion, orderCode: string, tx: Tx): Promise<PromotionQuote> {
    const head = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "promotion"."promotions" WHERE upper(code) = upper(${code.trim()}) AND is_deleted = false FOR UPDATE`;
    const p = head[0] ? await tx.promotion.findUnique({ where: { id: head[0].id }, include: { targets: true } }) : null;
    if (!p) return { ok: false, code, name: null, type: 'unknown', discount: 0n, error: 'Mã không tồn tại hoặc đã hết hạn', missingAmount: null };
    const q = await this.evaluate(p, basket, tx);
    if (!q.ok) return q;
    await tx.promotion.update({ where: { id: p.id }, data: { usedCount: { increment: 1 } } });
    await tx.promotionUsage.create({ data: { promotionId: p.id, userId: basket.userId, orderCode, discountAmount: new Prisma.Decimal(q.discount.toString()) } });
    return q;
  }

  async release(orderCode: string, tx: Tx): Promise<void> {
    const usages = await tx.promotionUsage.findMany({ where: { orderCode, releasedAt: null } });
    for (const u of usages) {
      await tx.promotionUsage.update({ where: { id: u.id }, data: { releasedAt: new Date() } });
      await tx.promotion.update({ where: { id: u.promotionId }, data: { usedCount: { decrement: 1 } } });
    }
  }

  // ------------------------------------------------------------------ web bán hàng

  async offers(basket: BasketForPromotion): Promise<PromotionOfferResponse[]> {
    const now = new Date();
    const rows = await this.prisma.promotion.findMany({ where: { isDeleted: false, isActive: true, isPublic: true, startsAt: { lte: now }, endsAt: { gte: now } }, include: { targets: true }, orderBy: [{ endsAt: 'asc' }] });
    const out: PromotionOfferResponse[] = [];
    for (const p of rows) {
      const q = await this.evaluate(p, basket);
      out.push(PromotionService.toOffer(p, q));
    }
    return out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || Number(b.displayDiscount.amount) - Number(a.displayDiscount.amount));
  }

  static toOffer(p: PromoRow, q: PromotionQuote): PromotionOfferResponse {
    const isPercent = p.type === PROMO_TYPE.PERCENTAGE;
    return {
      code: p.code,
      type: p.type,
      name: p.name,
      description: p.description,
      endAt: p.endsAt.toISOString(),
      displayDiscount: money(q.discount),
      displayValue: p.type === PROMO_TYPE.FIXED ? money(p.value.toString()) : null,
      displayMinOrderAmount: vnd(p.minOrderAmount.toString()) > 0n ? money(p.minOrderAmount.toString()) : null,
      displayMaxDiscount: moneyOrNull(p.maxDiscount?.toString() ?? null),
      displayMissingAmount: q.missingAmount !== null && q.missingAmount > 0n ? money(q.missingAmount) : null,
      percentValue: isPercent ? Number(p.value.toString()) : null,
      eligible: q.ok,
      reason: q.error,
    };
  }

  // ------------------------------------------------------------------ quản trị

  private static toAdmin(p: PromoRow): PromotionAdminResponse {
    const empty: BasketForPromotion = { userId: '', subtotal: 0n, shippingFee: 0n, lines: [] };
    return {
      ...PromotionService.toOffer(p, { ok: p.isActive, code: p.code, name: p.name, type: p.type, discount: 0n, error: null, missingAmount: null }),
      id: p.id,
      usageLimit: p.usageLimit,
      usageLimitPerUser: p.usageLimitPerUser,
      usedCount: p.usedCount,
      appliesTo: p.appliesTo,
      targets: p.targets.map((t) => ({ targetType: t.targetType, targetRef: t.targetRef })),
      startAt: p.startsAt.toISOString(),
      isActive: p.isActive,
      isPublic: p.isPublic,
      displayDiscount: money(PromotionService.discountOf(p, empty)),
    };
  }

  async listAdmin(page: number, size: number, q?: string, active?: boolean): Promise<PageResponse<PromotionAdminResponse>> {
    const where: Prisma.PromotionWhereInput = { isDeleted: false, ...(q ? { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}), ...(active !== undefined ? { isActive: active } : {}) };
    const [items, total] = await Promise.all([this.prisma.promotion.findMany({ where, include: { targets: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.promotion.count({ where })]);
    return PageResponse.of(items.map((p) => PromotionService.toAdmin(p)), page, size, total);
  }

  async getAdmin(id: string): Promise<PromotionAdminResponse> {
    const p = await this.prisma.promotion.findFirst({ where: { id, isDeleted: false }, include: { targets: true } });
    if (!p) throw new NotFoundException(PROMO_ERR.NOT_FOUND, 'Không tìm thấy mã khuyến mãi');
    return PromotionService.toAdmin(p);
  }

  private validate(input: PromotionInput, current?: PromoRow): void {
    const type = input.type ?? current?.type;
    const value = input.value !== undefined ? Number(input.value) : Number(current?.value.toString() ?? 0);
    if (type === PROMO_TYPE.PERCENTAGE && (value <= 0 || value > 100)) throw new BusinessException(PROMO_ERR.INVALID, 'Phần trăm giảm phải trong 1–100');
    if (type === PROMO_TYPE.FIXED && value <= 0) throw new BusinessException(PROMO_ERR.INVALID, 'Số tiền giảm phải lớn hơn 0');
    const startsAt = input.startsAt ? new Date(input.startsAt) : current?.startsAt;
    const endsAt = input.endsAt ? new Date(input.endsAt) : current?.endsAt;
    if (startsAt && endsAt && endsAt <= startsAt) throw new BusinessException(PROMO_ERR.INVALID, 'Ngày kết thúc phải sau ngày bắt đầu');
    const appliesTo = input.appliesTo ?? current?.appliesTo ?? 'all';
    const targets = input.targets ?? current?.targets ?? [];
    if (appliesTo !== 'all' && targets.length === 0) throw new BusinessException(PROMO_ERR.INVALID, 'Phạm vi category/product cần ít nhất một mục tiêu');
  }

  async create(actor: AuthenticatedActor, input: PromotionInput & { code: string; name: string; type: string; startsAt: string; endsAt: string }): Promise<PromotionAdminResponse> {
    this.validate(input);
    const code = input.code.trim().toUpperCase();
    if (await this.findByCode(code)) throw new ConflictException(PROMO_ERR.CODE_EXISTS, `Mã '${code}' đã tồn tại`);
    const created = await this.prisma.$transaction(async (tx) => {
      const p = await tx.promotion.create({
        data: {
          code,
          name: input.name.trim(),
          description: input.description ?? null,
          type: input.type,
          value: input.type === PROMO_TYPE.FREE_SHIPPING ? '0' : (input.value ?? '0'),
          maxDiscount: input.maxDiscount ?? null,
          minOrderAmount: input.minOrderAmount ?? '0',
          usageLimit: input.usageLimit ?? null,
          usageLimitPerUser: input.usageLimitPerUser ?? null,
          appliesTo: input.appliesTo ?? 'all',
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          isActive: input.isActive ?? true,
          isPublic: input.isPublic ?? true,
          createdBy: actor.userId,
          updatedBy: actor.userId,
          targets: { create: (input.targets ?? []).map((t) => ({ targetType: t.targetType, targetRef: t.targetRef })) },
        },
        include: { targets: true },
      });
      await this.audit(tx, actor, { action: 'PROMOTION_CREATED', entityType: 'promotion', entityId: p.id, entityCode: p.code, after: { type: p.type, value: p.value.toString(), endsAt: p.endsAt } });
      return p;
    });
    return PromotionService.toAdmin(created);
  }

  async update(actor: AuthenticatedActor, id: string, patch: PromotionInput): Promise<PromotionAdminResponse> {
    const before = await this.prisma.promotion.findFirst({ where: { id, isDeleted: false }, include: { targets: true } });
    if (!before) throw new NotFoundException(PROMO_ERR.NOT_FOUND, 'Không tìm thấy mã khuyến mãi');
    this.validate(patch, before);
    if (patch.code && patch.code.toUpperCase() !== before.code && (await this.findByCode(patch.code))) throw new ConflictException(PROMO_ERR.CODE_EXISTS, `Mã '${patch.code}' đã tồn tại`);
    const after = await this.prisma.$transaction(async (tx) => {
      if (patch.targets) {
        await tx.promotionTarget.deleteMany({ where: { promotionId: id } });
        await tx.promotionTarget.createMany({ data: patch.targets.map((t) => ({ promotionId: id, targetType: t.targetType, targetRef: t.targetRef })) });
      }
      const p = await tx.promotion.update({
        where: { id },
        data: {
          ...(patch.code !== undefined ? { code: patch.code.trim().toUpperCase() } : {}),
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.value !== undefined ? { value: patch.value } : {}),
          ...(patch.maxDiscount !== undefined ? { maxDiscount: patch.maxDiscount } : {}),
          ...(patch.minOrderAmount !== undefined ? { minOrderAmount: patch.minOrderAmount } : {}),
          ...(patch.usageLimit !== undefined ? { usageLimit: patch.usageLimit } : {}),
          ...(patch.usageLimitPerUser !== undefined ? { usageLimitPerUser: patch.usageLimitPerUser } : {}),
          ...(patch.appliesTo !== undefined ? { appliesTo: patch.appliesTo } : {}),
          ...(patch.startsAt !== undefined ? { startsAt: new Date(patch.startsAt) } : {}),
          ...(patch.endsAt !== undefined ? { endsAt: new Date(patch.endsAt) } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.isPublic !== undefined ? { isPublic: patch.isPublic } : {}),
          updatedBy: actor.userId,
          version: { increment: 1 },
        },
        include: { targets: true },
      });
      await this.audit(tx, actor, { action: 'PROMOTION_UPDATED', entityType: 'promotion', entityId: id, entityCode: p.code, before: { isActive: before.isActive, value: before.value.toString() }, after: { isActive: p.isActive, value: p.value.toString() } });
      return p;
    });
    return PromotionService.toAdmin(after);
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    const before = await this.prisma.promotion.findFirst({ where: { id, isDeleted: false } });
    if (!before) throw new NotFoundException(PROMO_ERR.NOT_FOUND, 'Không tìm thấy mã khuyến mãi');
    await this.prisma.$transaction(async (tx) => {
      await tx.promotion.update({ where: { id }, data: { isDeleted: true, isActive: false, updatedBy: actor.userId } });
      await this.audit(tx, actor, { action: 'PROMOTION_DELETED', entityType: 'promotion', entityId: id, entityCode: before.code });
    });
    this.logger.log({ id, code: before.code, by: actor.userId }, 'Đã xoá mềm mã khuyến mãi');
  }

  async usages(id: string, page: number, size: number) {
    const where = { promotionId: id };
    const [items, total] = await Promise.all([this.prisma.promotionUsage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.promotionUsage.count({ where })]);
    return PageResponse.of(
      items.map((u) => ({ id: u.id, userId: u.userId, orderCode: u.orderCode, discountAmount: money(u.discountAmount.toString()), createdAt: u.createdAt.toISOString(), releasedAt: u.releasedAt?.toISOString() ?? null })),
      page,
      size,
      total,
    );
  }

  private audit(tx: Tx, actor: AuthenticatedActor, entry: AuditEntry): Promise<void> {
    return writeAuditLog(tx.promotionAuditLog, PROMOTION_MODULE, actor, entry);
  }
}
