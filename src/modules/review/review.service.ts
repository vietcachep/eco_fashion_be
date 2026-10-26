import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditEntry, writeAuditLog } from '@common/audit/audit';
import { BusinessException, ForbiddenException, NotFoundException } from '@common/exception/business.exception';
import { PRODUCT_STATS_GATEWAY, ProductStatsGateway } from '@common/gateway/product-stats.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { OutboxEventInput, writeOutboxEvent } from '@common/outbox/outbox';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { resolveAvatarUrl } from '@common/utils';
import { OrderQueryApi } from '../order/queryapi/order.queryapi';
import { ProductQueryApi } from '../product/queryapi/product.queryapi';

import { ShopReviewResponse } from './dto/shop-review.responses';
import { REVIEW_EVENT, REVIEW_MODULE } from './enums/review-events';
import { REVIEW_PLATFORM_NAME, REVIEW_REPLY_AUTHOR, REVIEW_SHOP_FALLBACK_NAME } from './review.constants';
import { ShopQueryApi } from '../shop/queryapi/shop.queryapi';

export const REVIEW_ERR = { NOT_FOUND: 'REVIEW_NOT_FOUND', NOT_PURCHASED: 'REVIEW_NOT_PURCHASED', ALREADY_REVIEWED: 'REVIEW_ALREADY_REVIEWED', PRODUCT_NOT_FOUND: 'REVIEW_PRODUCT_NOT_FOUND', INVALID_STATE: 'REVIEW_INVALID_STATE' } as const;
export const REVIEW_STATUS = { PENDING: 'pending', APPROVED: 'approved', HIDDEN: 'hidden' } as const;

export interface MediaItem {
  type: string;
  url: string;
  name: string;
}

/* Đánh giá hiện ở trang sản phẩm (FE `ReviewResponse`). */
export interface ReviewResponse {
  id: string;
  productId: string;
  author: string;
  avatarUrl: string | null;
  rating: number;
  content: string;
  variantLabel: string | null;
  media: MediaItem[];
  /* Ảnh (url) tách riêng cho FE cũ */
  images: string[];
  reply: { staffName: string; content: string; createdAt: string } | null;
  createdAt: string;
}

/* Đánh giá của tôi (FE `MyReviewResponse`). */
export interface MyReviewResponse {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  imageUrl: string | null;
  rating: number;
  content: string;
  media: MediaItem[];
  variantLabel: string | null;
  status: string;
  /* Phản hồi công khai (staffName = tên gian hàng, hoặc tên sàn nếu nhân viên sàn trả lời — KHÔNG bao giờ là họ tên người); null = chưa trả lời. */
  reply: { staffName: string; content: string; createdAt: string } | null;
  createdAt: string;
}

export interface ReviewAdminResponse extends ReviewResponse {
  userId: string;
  productSlug: string;
  productName: string;
  orderCode: string | null;
  status: string;
  moderationNote: string | null;
  helpfulCount: number;
}

export interface ProductReviewSummary {
  avgRating: number;
  reviewCount: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

type ReviewRow = Prisma.ReviewGetPayload<{ include: { replies: true } }>;

/*
 * Đánh giá (PLAN-0009): chỉ khách ĐÃ NHẬN hàng (order delivered/completed) mới đánh giá, mỗi dòng đơn một lần; ảnh/video
 * upload trước qua /uploads/media (Cloudinary). Mặc định hiện ngay (approved); nhân viên ẩn/hiện, trả lời thay shop.
 * Tên đứng dưới phản hồi (công khai) được TÍNH khi đọc từ `authorKind` (shop ⇒ tên gian hàng, platform ⇒ tên sàn), không đọc `staffName` lưu trong DB — xem review.constants.
 * Điểm trung bình + số đánh giá ghi sang product (ProductStatsGateway) trong cùng tx; outbox REVIEW_CREATED cho AI tóm tắt/kiểm duyệt.
 */
@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductQueryApi,
    private readonly orders: OrderQueryApi,
    private readonly shops: ShopQueryApi,
    @Inject(PRODUCT_STATS_GATEWAY) private readonly stats: ProductStatsGateway,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
  ) {}

  // ------------------------------------------------------------ đọc công khai

  async listForProduct(slug: string, page: number, size: number, rating?: number): Promise<PageResponse<ReviewResponse> & { summary: ProductReviewSummary }> {
    const productId = await this.productIdBySlug(slug);
    const where: Prisma.ReviewWhereInput = { productId, status: REVIEW_STATUS.APPROVED, isDeleted: false, ...(rating ? { rating } : {}) };
    const [items, total, summary] = await Promise.all([
      this.prisma.review.findMany({ where, include: { replies: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
      this.prisma.review.count({ where }),
      this.summary(productId),
    ]);
    const shopNames = await this.shopNamesForReplies(items);
    return Object.assign(PageResponse.of(items.map((r) => ReviewService.toPublic(r, shopNames.get(r.shopId))), page, size, total), { summary });
  }

  private async productIdBySlug(slug: string): Promise<string> {
    const p = await this.products.findProductBriefBySlug(slug);
    if (!p) throw new NotFoundException(REVIEW_ERR.PRODUCT_NOT_FOUND, 'Không tìm thấy sản phẩm');
    return p.id;
  }

  async summary(productId: string): Promise<ProductReviewSummary> {
    const rows = await this.prisma.review.groupBy({ by: ['rating'], where: { productId, status: REVIEW_STATUS.APPROVED, isDeleted: false }, _count: true });
    const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as Record<'1' | '2' | '3' | '4' | '5', number>;
    let sum = 0;
    let count = 0;
    for (const r of rows) {
      distribution[String(r.rating) as '1'] = r._count;
      sum += r.rating * r._count;
      count += r._count;
    }
    return { avgRating: count ? Math.round((sum / count) * 10) / 10 : 0, reviewCount: count, distribution };
  }

  /* Khách có thể đánh giá sản phẩm này không (FE ẩn/hiện form). */
  async eligibility(actor: AuthenticatedActor, slug: string): Promise<{ canReview: boolean; orderCode: string | null; variantLabel: string | null; reason: string | null }> {
    const productId = await this.productIdBySlug(slug);
    const item = await this.orders.purchasedItem(actor.userId, productId);
    if (!item) return { canReview: false, orderCode: null, variantLabel: null, reason: 'Bạn cần mua và nhận sản phẩm trước khi đánh giá' };
    if (item.reviewed) return { canReview: false, orderCode: item.orderCode, variantLabel: [item.color, item.size].filter(Boolean).join(' / ') || null, reason: 'Bạn đã đánh giá sản phẩm này' };
    return { canReview: true, orderCode: item.orderCode, variantLabel: [item.color, item.size].filter(Boolean).join(' / ') || null, reason: null };
  }

  // ------------------------------------------------------------ khách viết

  async create(actor: AuthenticatedActor, slug: string, input: { rating: number; content: string; media: MediaItem[] }): Promise<MyReviewResponse> {
    const productId = await this.productIdBySlug(slug);
    const [brief, item, user] = await Promise.all([this.products.findProductBrief(productId), this.orders.purchasedItem(actor.userId, productId), this.users.findSnapshot(actor.userId)]);
    if (!brief) throw new NotFoundException(REVIEW_ERR.PRODUCT_NOT_FOUND, 'Không tìm thấy sản phẩm');
    if (!item) throw new ForbiddenException(REVIEW_ERR.NOT_PURCHASED, 'Bạn cần mua và nhận sản phẩm trước khi đánh giá');
    if (item.reviewed) throw new BusinessException(REVIEW_ERR.ALREADY_REVIEWED, 'Bạn đã đánh giá sản phẩm này', 409);
    const created = await this.prisma.$transaction(async (tx) => {
      const r = await tx.review.create({
        data: {
          productId,
          productSlug: brief.slug,
          productName: brief.name,
          shopId: brief.shopId,
          userId: actor.userId,
          authorName: user?.fullName ?? actor.email,
          avatarUrl: null,
          orderCode: item.orderCode,
          orderItemId: item.orderItemId,
          variantLabel: [item.color, item.size].filter(Boolean).join(' / ') || null,
          rating: input.rating,
          content: input.content.trim(),
          media: input.media as unknown as Prisma.InputJsonValue,
          status: REVIEW_STATUS.APPROVED,
        },
        include: { replies: true },
      });
      await this.orders.markItemsReviewed([item.orderItemId], tx);
      await this.syncStats(productId, tx);
      await this.audit(tx, actor, { action: 'REVIEW_CREATED', entityType: 'review', entityId: r.id, entityCode: brief.slug, after: { rating: r.rating, media: input.media.length } });
      await this.publish(tx, { eventType: REVIEW_EVENT.CREATED, aggregateType: 'review', aggregateId: r.id, payload: { reviewId: r.id, productId, rating: r.rating } });
      return r;
    });
    this.logger.log({ reviewId: created.id, productId, userId: actor.userId }, 'Khách đánh giá sản phẩm');
    return ReviewService.toMine(created, await this.imageOf(productId));
  }

  async mine(actor: AuthenticatedActor, page: number, size: number): Promise<PageResponse<MyReviewResponse>> {
    const where = { userId: actor.userId, isDeleted: false };
    const [items, total] = await Promise.all([this.prisma.review.findMany({ where, include: { replies: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.review.count({ where })]);
    const cards = await this.products.cardsByIds([...new Set(items.map((r) => r.productId))]);
    const img = new Map(cards.map((c) => [c.id, c.imageUrl]));
    const shopNames = await this.shopNamesForReplies(items);
    return PageResponse.of(items.map((r) => ReviewService.toMine(r, img.get(r.productId) ?? null, shopNames.get(r.shopId))), page, size, total);
  }

  async updateMine(actor: AuthenticatedActor, id: string, input: { rating?: number; content?: string; media?: MediaItem[] }): Promise<MyReviewResponse> {
    const r = await this.prisma.review.findFirst({ where: { id, userId: actor.userId, isDeleted: false } });
    if (!r) throw new NotFoundException(REVIEW_ERR.NOT_FOUND, 'Không tìm thấy đánh giá');
    const after = await this.prisma.$transaction(async (tx) => {
      const u = await tx.review.update({ where: { id }, data: { ...(input.rating !== undefined ? { rating: input.rating } : {}), ...(input.content !== undefined ? { content: input.content.trim() } : {}), ...(input.media !== undefined ? { media: input.media as unknown as Prisma.InputJsonValue } : {}), version: { increment: 1 } }, include: { replies: true } });
      if (input.rating !== undefined && input.rating !== r.rating) await this.syncStats(r.productId, tx);
      await this.audit(tx, actor, { action: 'REVIEW_UPDATED', entityType: 'review', entityId: id, before: { rating: r.rating }, after: { rating: u.rating } });
      return u;
    });
    return ReviewService.toMine(after, await this.imageOf(r.productId), (await this.shopNamesForReplies([after])).get(after.shopId));
  }

  async deleteMine(actor: AuthenticatedActor, id: string): Promise<void> {
    const r = await this.prisma.review.findFirst({ where: { id, userId: actor.userId, isDeleted: false } });
    if (!r) throw new NotFoundException(REVIEW_ERR.NOT_FOUND, 'Không tìm thấy đánh giá');
    await this.prisma.$transaction(async (tx) => {
      await tx.review.update({ where: { id }, data: { isDeleted: true, version: { increment: 1 } } });
      await this.syncStats(r.productId, tx);
      await this.audit(tx, actor, { action: 'REVIEW_DELETED', entityType: 'review', entityId: id });
    });
  }

  // ------------------------------------------------------------ nhân viên

  async listAdmin(page: number, size: number, f: { status?: string; rating?: number; q?: string; shopId?: string }): Promise<PageResponse<ReviewAdminResponse>> {
    const where: Prisma.ReviewWhereInput = { isDeleted: false, ...(f.shopId ? { shopId: f.shopId } : {}), ...(f.status ? { status: f.status } : {}), ...(f.rating ? { rating: f.rating } : {}), ...(f.q ? { OR: [{ productName: { contains: f.q, mode: 'insensitive' } }, { content: { contains: f.q, mode: 'insensitive' } }, { authorName: { contains: f.q, mode: 'insensitive' } }] } : {}) };
    const [items, total] = await Promise.all([this.prisma.review.findMany({ where, include: { replies: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }), this.prisma.review.count({ where })]);
    const shopNames = await this.shopNamesForReplies(items);
    return PageResponse.of(items.map((r) => ReviewService.toAdmin(r, shopNames.get(r.shopId))), page, size, total);
  }

  async moderate(actor: AuthenticatedActor, id: string, status: 'approved' | 'hidden', note?: string): Promise<ReviewAdminResponse> {
    const r = await this.prisma.review.findFirst({ where: { id, isDeleted: false } });
    if (!r) throw new NotFoundException(REVIEW_ERR.NOT_FOUND, 'Không tìm thấy đánh giá');
    const after = await this.prisma.$transaction(async (tx) => {
      const u = await tx.review.update({ where: { id }, data: { status, moderationNote: note ?? null, moderatedBy: actor.userId, moderatedAt: new Date(), version: { increment: 1 } }, include: { replies: true } });
      await this.syncStats(r.productId, tx);
      await this.audit(tx, actor, { action: 'REVIEW_MODERATED', entityType: 'review', entityId: id, before: { status: r.status }, after: { status, note: note ?? null } });
      return u;
    });
    return ReviewService.toAdmin(after, (await this.shopNamesForReplies([after])).get(after.shopId));
  }

  /*
   * Nhân viên SÀN trả lời thay cửa hàng (một trả lời / đánh giá, gọi lại = sửa — kể cả ghi đè phản hồi của vendor).
   * Phản hồi hiện CÔNG KHAI dưới tên trung tính của sàn (REVIEW_PLATFORM_NAME), KHÔNG phải họ tên nhân viên: DB lưu authorKind='platform' +
   * staffName = tên sàn; người trả lời thật nằm ở `staffUserId` + audit actor để truy vết nội bộ. Không cần tra hồ sơ nhân viên.
   */
  async reply(actor: AuthenticatedActor, id: string, content: string): Promise<ReviewAdminResponse> {
    const r = await this.prisma.review.findFirst({ where: { id, isDeleted: false } });
    if (!r) throw new NotFoundException(REVIEW_ERR.NOT_FOUND, 'Không tìm thấy đánh giá');
    const author = { staffUserId: actor.userId, staffName: REVIEW_PLATFORM_NAME, authorKind: REVIEW_REPLY_AUTHOR.PLATFORM };
    const after = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.reviewReply.findFirst({ where: { reviewId: id } });
      if (existing) await tx.reviewReply.update({ where: { id: existing.id }, data: { content: content.trim(), ...author } });
      else await tx.reviewReply.create({ data: { reviewId: id, content: content.trim(), ...author } });
      await this.audit(tx, actor, { action: 'REVIEW_REPLIED', entityType: 'review', entityId: id, after: { length: content.length, as: REVIEW_REPLY_AUTHOR.PLATFORM } });
      return tx.review.findUniqueOrThrow({ where: { id }, include: { replies: true } });
    });
    return ReviewService.toAdmin(after);
  }

  // ------------------------------------------------------------ shop-scoped (PLAN-0014 bước 9)

  /*
   * Danh sách đánh giá cho VENDOR. Luôn khoá status = approved (đánh giá ẩn/chờ duyệt là việc của nhân viên sàn —
   * vendor không được thấy) và trả ShopReviewResponse (đã bỏ userId/orderCode/moderationNote/tên đầy đủ).
   * `shopId` do ShopContextGuard suy từ JWT; KHÔNG có tham số status từ client.
   */
  async listShop(shopId: string, page: number, size: number): Promise<PageResponse<ShopReviewResponse>> {
    const where: Prisma.ReviewWhereInput = { isDeleted: false, shopId, status: REVIEW_STATUS.APPROVED };
    const [items, total] = await Promise.all([
      this.prisma.review.findMany({ where, include: { replies: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
      this.prisma.review.count({ where }),
    ]);
    return PageResponse.of(items.map((r) => ReviewService.toShop(r)), page, size, total);
  }

  /*
   * Vendor trả lời đánh giá (một trả lời / đánh giá, gọi lại = sửa). Transaction: ghi reply + audit.
   * - Chỉ đánh giá `approved` của CHÍNH shop: khác shop / đang ẩn / chờ duyệt / đã xoá đều trả cùng 404 (không lộ tồn tại).
   * - Tên công khai dưới đánh giá = TÊN GIAN HÀNG (không phải họ tên thật của nhân viên): ghi authorKind='shop' + staffName = tên shop; người trả
   *   lời thật lưu ở `staffUserId` + audit actor để truy vết nội bộ. Sửa lại reply cũ (kể cả reply của sàn) cũng ghi đè sang 'shop' + tên shop.
   */
  async replyShop(actor: AuthenticatedActor, shop: { shopId: string; shopName: string }, id: string, content: string): Promise<ShopReviewResponse> {
    const r = await this.prisma.review.findFirst({ where: { id, shopId: shop.shopId, status: REVIEW_STATUS.APPROVED, isDeleted: false }, select: { id: true } });
    if (!r) throw new NotFoundException(REVIEW_ERR.NOT_FOUND, 'Không tìm thấy đánh giá');
    const author = { staffUserId: actor.userId, staffName: shop.shopName, authorKind: REVIEW_REPLY_AUTHOR.SHOP };
    const after = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.reviewReply.findFirst({ where: { reviewId: id } });
      if (existing) await tx.reviewReply.update({ where: { id: existing.id }, data: { content: content.trim(), ...author } });
      else await tx.reviewReply.create({ data: { reviewId: id, content: content.trim(), ...author } });
      await this.audit(tx, actor, { action: 'REVIEW_REPLIED', entityType: 'review', entityId: id, after: { shopId: shop.shopId, length: content.length } });
      return tx.review.findUniqueOrThrow({ where: { id }, include: { replies: true } });
    });
    return ReviewService.toShop(after);
  }

  // ------------------------------------------------------------ helpers

  /* Đếm sẵn lên product (chỉ approved) trong cùng tx. */
  private async syncStats(productId: string, tx: Tx): Promise<void> {
    const agg = await tx.review.aggregate({ where: { productId, status: REVIEW_STATUS.APPROVED, isDeleted: false }, _avg: { rating: true }, _count: true });
    await this.stats.setRating(productId, Math.round((agg._avg.rating ?? 0) * 100) / 100, agg._count, tx);
    // Điểm sản phẩm đổi (tạo/ẩn/hiện/xoá đánh giá) ⇒ báo shop tính lại Shop.ratingAvg — listener tính lại từ đầu nên chạy lặp vô hại.
    await this.publish(tx, { eventType: REVIEW_EVENT.RATING_CHANGED, aggregateType: 'product', aggregateId: productId, payload: { productId } });
  }

  /*
   * Tên shop (theo id) cho các đánh giá có phản hồi do SHOP đứng tên — một lần tra theo lô (ShopQueryApi.findManyBrief), không N+1; không có phản hồi
   * của shop nào thì không tra gì. Dùng tên HIỆN TẠI của shop (shop đổi tên thì phản hồi cũ hiện tên mới — đúng danh tính).
   */
  private async shopNamesForReplies(rows: ReviewRow[]): Promise<Map<string, string>> {
    const shopIds = rows.filter((r) => r.replies[0]?.authorKind === REVIEW_REPLY_AUTHOR.SHOP).map((r) => r.shopId);
    if (shopIds.length === 0) return new Map();
    const briefs = await this.shops.findManyBrief(shopIds);
    return new Map([...briefs.values()].map((b) => [b.id, b.name]));
  }

  private async imageOf(productId: string): Promise<string | null> {
    const [c] = await this.products.cardsByIds([productId]);
    return c?.imageUrl ?? null;
  }

  /*
   * Tên hiển thị dưới phản hồi — TÍNH từ authorKind, TUYỆT ĐỐI không đọc `staffName` lưu trong DB (dữ liệu cũ có thể còn họ tên nhân viên):
   * shop ⇒ tên gian hàng (`shopName`; thiếu thì 'Cửa hàng'); mọi giá trị khác (platform, lạ) ⇒ tên sàn.
   */
  static replyAuthorName(reply: { authorKind: string }, shopName?: string | null): string {
    if (reply.authorKind === REVIEW_REPLY_AUTHOR.SHOP) return shopName?.trim() || REVIEW_SHOP_FALLBACK_NAME;
    return REVIEW_PLATFORM_NAME;
  }

  private static toReplyView(reply: ReviewRow['replies'][number] | undefined, shopName?: string | null): { staffName: string; content: string; createdAt: string } | null {
    return reply ? { staffName: ReviewService.replyAuthorName(reply, shopName), content: reply.content, createdAt: reply.createdAt.toISOString() } : null;
  }

  static toPublic(r: ReviewRow, shopName?: string | null): ReviewResponse {
    const media = Array.isArray(r.media) ? (r.media as unknown as MediaItem[]) : [];
    return { id: r.id, productId: r.productId, author: ReviewService.maskName(r.authorName), avatarUrl: resolveAvatarUrl(r.avatarUrl, r.authorName), rating: r.rating, content: r.content, variantLabel: r.variantLabel, media, images: media.filter((m) => m.type === 'image').map((m) => m.url), reply: ReviewService.toReplyView(r.replies[0], shopName), createdAt: r.createdAt.toISOString() };
  }

  static toAdmin(r: ReviewRow, shopName?: string | null): ReviewAdminResponse {
    return { ...ReviewService.toPublic(r, shopName), author: r.authorName, userId: r.userId, productSlug: r.productSlug, productName: r.productName, orderCode: r.orderCode, status: r.status, moderationNote: r.moderationNote, helpfulCount: r.helpfulCount };
  }

  /* Đánh giá cho cổng vendor — whitelist trường, KHÔNG lan ra userId/orderCode/moderationNote/staffName (xem ShopReviewResponse). */
  static toShop(r: ReviewRow): ShopReviewResponse {
    const media = Array.isArray(r.media) ? (r.media as unknown as MediaItem[]) : [];
    const reply = r.replies[0] ?? null;
    return {
      id: r.id,
      productId: r.productId,
      productName: r.productName,
      productSlug: r.productSlug,
      rating: r.rating,
      content: r.content,
      authorDisplay: ReviewService.maskName(r.authorName),
      variantLabel: r.variantLabel,
      images: media.filter((m) => m.type === 'image').map((m) => m.url),
      helpfulCount: r.helpfulCount,
      reply: reply ? { content: reply.content, createdAt: reply.createdAt.toISOString() } : null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  static toMine(r: ReviewRow, imageUrl: string | null, shopName?: string | null): MyReviewResponse {
    return { id: r.id, productId: r.productId, productName: r.productName, productSlug: r.productSlug, imageUrl, rating: r.rating, content: r.content, media: Array.isArray(r.media) ? (r.media as unknown as MediaItem[]) : [], variantLabel: r.variantLabel, status: r.status, reply: ReviewService.toReplyView(r.replies[0], shopName), createdAt: r.createdAt.toISOString() };
  }

  /*
   * Ẩn bớt tên khách trên web công khai/cổng vendor: "Nguyễn Văn An" → "Nguyễn V. A.".
   * authorName có thể rơi về EMAIL (user chưa có họ tên) — không bao giờ trả email: chỉ giữ ký tự đầu + '***'.
   */
  static maskName(name: string): string {
    const clean = name.trim();
    if (clean.includes('@')) return `${Array.from(clean)[0] ?? ''}***`;
    const parts = clean.split(/\s+/);
    if (parts.length <= 1) return name;
    return `${parts[0]} ${parts.slice(1).map((p) => `${Array.from(p)[0]}.`).join(' ')}`;
  }

  private audit(tx: Tx, actor: AuthenticatedActor | null, entry: AuditEntry): Promise<void> {
    return writeAuditLog(tx.reviewAuditLog, REVIEW_MODULE, actor, entry);
  }

  private publish(tx: Tx, input: OutboxEventInput): Promise<void> {
    return writeOutboxEvent(tx.reviewOutboxEvent, input);
  }
}
