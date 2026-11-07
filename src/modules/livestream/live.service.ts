import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  LIVE_COMMERCE_ORDER_GATEWAY,
  type LiveCommerceOrderGateway,
} from '@common/gateway/live-commerce.gateway';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import {
  BusinessException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@common/exception/business.exception';
import { Prisma } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ProductQueryApi } from '@modules/product/queryapi/product.queryapi';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { ShopFollowApplicationApi } from '@modules/shop/applicationapi/shop-follow.applicationapi';
import { IdentityQueryApi } from '@modules/identity/queryapi/identity.queryapi';
import type { LiveSourceGateway } from '@common/gateway/live-source.gateway';
import { USER_DIRECTORY_GATEWAY, type UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { LiveRepository, type Tx, type LiveSession } from './live.repository';
import { LiveKitProvider } from './media/livekit.provider';
import {
  LiveCreateRequest,
  LiveEditRequest,
  LiveListQuery,
  LiveMessageQuery,
  LiveMessageRequest,
  LiveModerationRequest,
  LiveReportListQuery,
  LiveSessionResponse,
} from './live.dto';

const ACTIVE = ['starting', 'live', 'reconnecting'];
const TERMINAL = ['ended', 'terminated', 'cancelled'];
const now = () => new Date();

/*
 * Use cases của FITLY Live. Mọi command bền vững: transaction + audit/outbox; claim/quota khoá toàn demo,
 * thay ghim/chat dùng row lock và version. LiveKit IO ngoài tx; terminal không hồi sinh từ webhook cũ.
 */
@Injectable()
export class LiveService implements LiveSourceGateway {
  constructor(
    readonly repo: LiveRepository,
    readonly media: LiveKitProvider,
    private readonly products: ProductQueryApi,
    private readonly shops: ShopQueryApi,
    readonly follows: ShopFollowApplicationApi,
    private readonly identity: IdentityQueryApi,
    @Inject(ENV) private readonly env: Env,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
    @Optional() private readonly modules?: ModuleRef,
  ) {}
  async required(id: string, tx?: Tx): Promise<LiveSession> {
    const s = await this.repo.session(id, tx);
    if (!s) throw new NotFoundException('LIVE_NOT_FOUND', 'Phiên livestream không tồn tại.');
    return s;
  }
  async session(id: string) {
    const s = await this.repo.session(id);
    return s && s.mode === 'public'
      ? { id: s.id, shopId: s.shopId, state: s.state, startedAt: s.startedAt }
      : null;
  }
  async canClaim(userId: string, sessionId: string, tx?: Tx): Promise<boolean> {
    // Caller locks session before its campaign row; stop() uses the same session lock.
    if (tx) await this.repo.rowLock(tx, sessionId);
    const db = tx ?? this.repo.db;
    const s = await this.repo.session(sessionId, tx);
    if (!s || s.mode !== 'public' || s.state !== 'live' || !s.startedAt) return false;
    if (
      !(await this.shops.existsApproved(s.shopId)) ||
      (await db.liveRestriction.findUnique({ where: { shopId: s.shopId } }))?.restricted
    )
      return false;
    return !!(await db.liveAdmission.findFirst({
      where: { sessionId, userId, leftAt: null, expiresAt: { gt: now() } },
    }));
  }
  private async approved(shopId: string) {
    if (!(await this.shops.existsApproved(shopId)))
      throw new ForbiddenException(
        'LIVE_SHOP_UNAVAILABLE',
        'Gian hàng không còn được phép phát hoặc bán hàng.',
      );
  }
  owns(s: LiveSession, shopId: string): Promise<void> {
    if (s.shopId !== shopId) throw new NotFoundException('LIVE_NOT_FOUND', 'Phiên livestream không tồn tại.');
    return Promise.resolve();
  }
  private async member(s: LiveSession, userId: string, permission = 'shop.livestream.read') {
    return (await this.shops.memberUserIdsWithPermission(s.shopId, permission)).includes(userId);
  }
  async canRead(s: LiveSession, actor?: AuthenticatedActor): Promise<void> {
    await this.approved(s.shopId);
    if (s.mode === 'public' && !['draft', 'cancelled'].includes(s.state)) return;
    if (s.mode === 'rehearsal') {
      if (
        actor &&
        (await this.member(s, actor.userId)) &&
        (s.hostUserId === actor.userId ||
          s.createdBy === actor.userId ||
          (await this.repo.db.liveModerator.findFirst({
            where: { sessionId: s.id, userId: actor.userId, active: true },
          })))
      )
        return;
      throw new NotFoundException('LIVE_NOT_FOUND', 'Phiên thử chỉ dành cho người được mời.');
    }
    if (actor && (await this.member(s, actor.userId))) return;
    throw new NotFoundException('LIVE_NOT_FOUND', 'Phiên livestream không công khai.');
  }
  async list(query: LiveListQuery, scope?: { shopId?: string; admin?: boolean }, actor?: AuthenticatedActor) {
    if (!scope && query.shopSlug) {
      const shop = await this.shops.findPublicBySlug(query.shopSlug);
      if (!shop) return PageResponse.of([], query.page, query.size, 0);
      query.shopId = shop.id;
    }
    const approved = scope?.admin ? undefined : await this.shops.approvedShopIds();
    const [matchingShops, categoryProducts] = await Promise.all([
      query.q ? this.shops.searchLiveShopIds(query.q, !scope?.admin) : Promise.resolve([]),
      query.categorySlug ? this.products.liveProductIdsByCategory(query.categorySlug) : Promise.resolve(undefined),
    ]);
    const categorySessions = categoryProducts ? await this.repo.db.liveSessionProduct.findMany({ where: { productId: { in: categoryProducts }, removed: false, isDeleted: false }, select: { sessionId: true }, distinct: ['sessionId'] }) : undefined;
    const where: Prisma.LiveSessionWhereInput = {
      isDeleted: false,
      ...(categorySessions ? { id: { in: categorySessions.map(p => p.sessionId) } } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { shopId: { in: matchingShops } }] } : {}),
      ...(!scope
        ? {
            mode: 'public',
            state: query.state ? query.state : { in: ['scheduled', 'starting', 'live', 'reconnecting'] },
          }
        : {}),
      ...(scope?.shopId
        ? { shopId: scope.shopId }
        : query.shopId
          ? { shopId: query.shopId }
          : approved
            ? { shopId: { in: approved } }
            : {}),
    };
    if (!scope && query.shopId && !approved?.includes(query.shopId))
      return PageResponse.of([], query.page, query.size, 0);
    if (!scope && query.state && ['draft', 'cancelled'].includes(query.state))
      return PageResponse.of([], query.page, query.size, 0);
    const result = await this.repo.page(where, query.page, query.size);
    return PageResponse.of(
      await this.presentMany(result.content, actor),
      query.page,
      query.size,
      result.total,
    );
  }
  async presentMany(sessions: LiveSession[], actor?: AuthenticatedActor): Promise<LiveSessionResponse[]> {
    if (!sessions.length) return [];
    const ids = sessions.map((s) => s.id);
    const [shops, counts, productCounts, followed] = await Promise.all([
      this.shops.findManyBrief(sessions.map((s) => s.shopId)),
      this.repo.db.liveAdmission.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: ids }, leftAt: null, expiresAt: { gt: now() } },
        _count: { _all: true },
      }),
      this.repo.db.liveSessionProduct.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: ids }, removed: false },
        _count: { _all: true },
      }),
      actor
        ? Promise.all(
            [...new Set(sessions.map((s) => s.shopId))].map(
              async (id) => [id, await this.follows.following(id, actor.userId)] as const,
            ),
          )
        : Promise.resolve([]),
    ]);
    const viewers = new Map(counts.map((c) => [c.sessionId, c._count._all]));
    const ps = new Map(productCounts.map((c) => [c.sessionId, c._count._all]));
    const fs = new Map(followed);
    return sessions.map((s) => {
      const shop = shops.get(s.shopId);
      return {
        id: s.id,
        shopId: s.shopId,
        title: s.title,
        description: s.description,
        coverUrl: s.coverUrl,
        scheduledAt: s.scheduledAt?.toISOString() ?? null,
        state: s.state,
        mode: s.mode,
        version: s.version,
        startedAt: s.startedAt?.toISOString() ?? null,
        endedAt: s.endedAt?.toISOString() ?? null,
        endReason: s.endReason,
        mediaStopStatus: s.mediaStopStatus,
        pinnedProductId: s.pinnedProductId,
        pinnedMessageId: s.pinnedMessageId,
        viewerCount: viewers.get(s.id) ?? 0,
        productsCount: ps.get(s.id) ?? 0,
        likes: s.likes,
        isFollowing: fs.get(s.shopId) ?? false,
        shop: shop ? { id: shop.id, slug: shop.slug, name: shop.name, logoUrl: shop.logoUrl } : null,
      };
    });
  }
  async detail(id: string, actor?: AuthenticatedActor, shopId?: string, admin = false) {
    const s = await this.required(id);
    if (shopId) await this.owns(s, shopId);
    else if (!admin) await this.canRead(s, actor);
    const [dto] = await this.presentMany([s], actor);
    const pinned = s.pinnedProductId
      ? await this.repo.db.liveSessionProduct.findUnique({
          where: { sessionId_productId: { sessionId: id, productId: s.pinnedProductId } },
        })
      : null;
    const card =
      pinned && !pinned.removed ? (await this.products.liveCardsByIds([pinned.productId]))[0] : null;
    const canModerate =
      !!actor &&
      (await this.member(s, actor.userId, 'shop.livestream.moderate')) &&
      (s.hostUserId === actor.userId ||
        (await this.member(s, actor.userId, 'shop.livestream.manage')) ||
        !!(await this.repo.db.liveModerator.findFirst({
          where: { sessionId: id, userId: actor.userId, active: true },
        })));
    return {
      ...dto,
      canModerate,
      pinnedProduct:
        card && pinned
          ? {
              productId: pinned.productId,
              displayNumber: pinned.displayNumber,
              position: pinned.position,
              pinned: true,
              card,
            }
          : null,
      mediaAvailable: this.media.configured,
    };
  }
  private validateVersion(s: LiveSession, version: number) {
    if (s.version !== version)
      throw new ConflictException('LIVE_VERSION_CHANGED', 'Phiên vừa được cập nhật. Hãy tải lại.');
  }
  private async validateProducts(shopId: string, ids: string[]) {
    const cards = await this.products.liveCardsByIds(ids);
    if (
      ids.length > 50 ||
      new Set(ids).size !== ids.length ||
      cards.length !== ids.length ||
      cards.some((c) => c.shop?.id !== shopId)
    )
      throw new BusinessException(
        'LIVE_PRODUCT_INVALID',
        'Chỉ chọn tối đa50 sản phẩm đang bán của chính shop.',
      );
  }
  private async setProducts(tx: Tx, s: LiveSession, ids: string[], actor: AuthenticatedActor) {
    const old = await tx.liveSessionProduct.findMany({ where: { sessionId: s.id } });
    let next = s.nextDisplayNumber;
    await tx.liveSessionProduct.updateMany({
      where: { sessionId: s.id, productId: { notIn: ids } },
      data: { removed: true },
    });
    for (const [position, productId] of ids.entries()) {
      const found = old.find((p) => p.productId === productId);
      await tx.liveSessionProduct.upsert({
        where: { sessionId_productId: { sessionId: s.id, productId } },
        create: { sessionId: s.id, productId, position, displayNumber: ++next, createdBy: actor.userId },
        update: { removed: false, position, updatedBy: actor.userId, version: { increment: 1 } },
      });
      if (found) next--;
    }
    await tx.liveSession.update({
      where: { id: s.id },
      data: {
        nextDisplayNumber: next,
        ...(s.pinnedProductId && !ids.includes(s.pinnedProductId) ? { pinnedProductId: null } : {}),
      },
    });
  }
  async create(actor: AuthenticatedActor, shopId: string, body: LiveCreateRequest) {
    await this.approved(shopId);
    await this.validateProducts(shopId, body.productIds ?? []);
    if (body.scheduledAt && new Date(body.scheduledAt) <= now())
      throw new BusinessException('LIVE_SCHEDULE_INVALID', 'Lịch phát phải ở tương lai.');
    const s = await this.repo.transaction(async (tx) => {
      const row = await tx.liveSession.create({
        data: {
          shopId,
          title: body.title.trim(),
          description: body.description,
          coverUrl: this.safeCover(body.coverUrl),
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          state: body.scheduledAt ? 'scheduled' : 'draft',
          createdBy: actor.userId,
        },
      });
      await this.setProducts(tx, row, body.productIds ?? [], actor);
      await this.repo.audit(tx, actor, 'LIVE_CREATED', row.id);
      await this.repo.event(tx, row.id, 'session.state_changed', { state: row.state, version: 0 });
      return row;
    });
    return this.detail(s.id, actor, shopId);
  }
  private safeCover(url?: string | null) {
    if (!url) return null;
    if (!url.startsWith('/static/') && !/^https:\/\//i.test(url))
      throw new BusinessException('LIVE_COVER_INVALID', 'Ảnh bìa phải dùng URL HTTPS hoặc ảnh upload.');
    return url;
  }
  async edit(actor: AuthenticatedActor, shopId: string, id: string, body: LiveEditRequest) {
    if (body.productIds) await this.validateProducts(shopId, body.productIds);
    await this.repo.transaction(async (tx) => {
      await this.repo.rowLock(tx, id);
      const s = await this.required(id, tx);
      await this.owns(s, shopId);
      this.validateVersion(s, body.version);
      if (!['draft', 'scheduled'].includes(s.state))
        throw new ConflictException('LIVE_CANNOT_EDIT', 'Chỉ sửa phiên nháp hoặc đã lên lịch.');
      if (body.productIds) await this.setProducts(tx, s, body.productIds, actor);
      if (body.scheduledAt && new Date(body.scheduledAt) <= now())
        throw new BusinessException('LIVE_SCHEDULE_INVALID', 'Lịch phát phải ở tương lai.');
      const row = await tx.liveSession.update({
        where: { id },
        data: {
          ...(body.title !== undefined ? { title: body.title.trim() } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.coverUrl !== undefined ? { coverUrl: this.safeCover(body.coverUrl) } : {}),
          ...(body.scheduledAt !== undefined
            ? {
                scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
                state: body.scheduledAt ? 'scheduled' : 'draft',
                scheduleVersion: { increment: 1 },
              }
            : {}),
          version: { increment: 1 },
          updatedBy: actor.userId,
        },
      });
      await this.repo.audit(tx, actor, 'LIVE_EDITED', id);
      await this.repo.event(tx, id, 'session.state_changed', { state: row.state, version: row.version });
    });
    return this.detail(id, actor, shopId);
  }
  async updateProducts(
    actor: AuthenticatedActor,
    shopId: string,
    id: string,
    ids: string[],
    version: number,
  ) {
    await this.validateProducts(shopId, ids);
    await this.repo.transaction(async (tx) => {
      await this.repo.rowLock(tx, id);
      const s = await this.required(id, tx);
      await this.owns(s, shopId);
      this.validateVersion(s, version);
      if (TERMINAL.includes(s.state)) throw new ConflictException('LIVE_TERMINAL', 'Phiên đã kết thúc.');
      await this.setProducts(tx, s, ids, actor);
      const row = await tx.liveSession.update({
        where: { id },
        data: { version: { increment: 1 }, updatedBy: actor.userId },
      });
      await this.repo.audit(tx, actor, 'LIVE_PRODUCTS_CHANGED', id, { count: ids.length });
      await this.repo.event(tx, id, 'product.pinned', {
        productId: row.pinnedProductId,
        version: row.version,
      });
    });
    return this.detail(id, actor, shopId);
  }
  async pin(
    actor: AuthenticatedActor,
    shopId: string,
    id: string,
    productId: string | null,
    version: number,
  ) {
    await this.repo.transaction(async (tx) => {
      await this.repo.rowLock(tx, id);
      const s = await this.required(id, tx);
      await this.owns(s, shopId);
      this.validateVersion(s, version);
      if (TERMINAL.includes(s.state)) throw new ConflictException('LIVE_TERMINAL', 'Phiên đã kết thúc.');
      if (
        productId &&
        !(await tx.liveSessionProduct.findFirst({ where: { sessionId: id, productId, removed: false } }))
      )
        throw new BusinessException('LIVE_PRODUCT_INVALID', 'Sản phẩm chưa được gắn trong phiên.');
      const row = await tx.liveSession.update({
        where: { id },
        data: { pinnedProductId: productId, version: { increment: 1 }, updatedBy: actor.userId },
      });
      await this.repo.audit(tx, actor, 'LIVE_PRODUCT_PINNED', id, { productId });
      await this.repo.event(tx, id, 'product.pinned', { productId, version: row.version });
    });
    return this.detail(id, actor, shopId);
  }
  async start(actor: AuthenticatedActor, shopId: string, id: string, rehearsal = false) {
    this.media.serverUrl.toString();
    await this.approved(shopId);
    let target = await this.required(id);
    await this.owns(target, shopId);
    if (rehearsal && target.mode !== 'rehearsal') {
      const source = target;
      target = await this.repo.transaction(async (tx) => {
        await this.repo.globalLock(tx);
        const exists = await tx.liveSession.findFirst({
          where: {
            shopId,
            mode: 'rehearsal',
            state: { in: ['draft', ...ACTIVE] },
            createdBy: actor.userId,
            isDeleted: false,
          },
        });
        if (exists) {
          if (exists.hostUserId !== actor.userId)
            throw new ConflictException('LIVE_HOST_CONFLICT', 'Phiên thử đang được người khác sử dụng.');
          return exists;
        }
        const clone = await tx.liveSession.create({
          data: {
            shopId,
            title: source.title,
            description: source.description,
            coverUrl: source.coverUrl,
            mode: 'rehearsal',
            createdBy: actor.userId,
          },
        });
        const ps = await tx.liveSessionProduct.findMany({
          where: { sessionId: id, removed: false },
          orderBy: { position: 'asc' },
        });
        await this.setProducts(
          tx,
          clone,
          ps.map((p) => p.productId),
          actor,
        );
        const moderators = await tx.liveModerator.findMany({ where: { sessionId: source.id, active: true, isDeleted: false }, select: { userId: true } });
        if (moderators.length) await tx.liveModerator.createMany({ data: moderators.map(m => ({ sessionId: clone.id, userId: m.userId, createdBy: actor.userId })) });
        return clone;
      });
    }
    const sid = target.id;
    const claimed = await this.repo.transaction(async (tx) => {
      await this.repo.globalLock(tx);
      await this.repo.rowLock(tx, sid);
      const s = await this.required(sid, tx);
      if ((await tx.liveRestriction.findUnique({ where: { shopId } }))?.restricted)
        throw new ForbiddenException('LIVE_SHOP_RESTRICTED', 'Shop đang bị hạn chế livestream.');
      if (ACTIVE.includes(s.state)) {
        if (s.hostUserId !== actor.userId)
          throw new ConflictException('LIVE_HOST_CONFLICT', 'Phiên đang do người khác phát.');
        return s;
      }
      if (!['draft', 'scheduled'].includes(s.state))
        throw new ConflictException('LIVE_TERMINAL', 'Không thể phát lại phiên đã kết thúc.');
      const other = await tx.liveSession.findFirst({
        where: { id: { not: sid }, state: { in: ACTIVE }, OR: [{ shopId }, { mode: s.mode }] },
      });
      if (other)
        throw new ConflictException('LIVE_CAPACITY', 'Đã có phiên đang hoạt động trong phạm vi demo.');
      const room = `fitly-${s.mode}-${sid}`;
      const row = await tx.liveSession.update({
        where: { id: sid },
        data: {
          state: 'starting',
          hostUserId: actor.userId,
          providerRoomId: room,
          startDeadline: new Date(Date.now() + 60_000),
          mediaStopStatus: 'none',
          version: { increment: 1 },
        },
      });
      await this.repo.audit(tx, actor, 'LIVE_START_REQUESTED', sid, { mode: s.mode });
      await this.repo.event(tx, sid, 'session.state_changed', { state: 'starting', version: row.version });
      return row;
    });
    try {
      await this.media.create(
        claimed.providerRoomId!,
        claimed.mode === 'rehearsal' ? 3 : this.env.EF_LIVE_MAX_VIEWERS + 1,
      );
      const current = await this.required(sid);
      if (!ACTIVE.includes(current.state) || current.hostUserId !== actor.userId) {
        await this.media.stop(claimed.providerRoomId!);
        throw new ConflictException('LIVE_TERMINAL', 'Phiên đã kết thúc trong khi tạo phòng video.');
      }
      return {
        ...(await this.media.token(claimed.providerRoomId!, `host-${sid}`, true, 'Chủ phiên')),
        session: await this.detail(sid, actor, shopId),
      };
    } catch (error) {
      await this.repo.db.liveSession.updateMany({
        where: { id: sid, state: 'starting' },
        data: { state: 'draft', mediaStopStatus: 'pending', version: { increment: 1 } },
      });
      throw error;
    }
  }
  async hostToken(actor: AuthenticatedActor, shopId: string, id: string) {
    const s = await this.required(id);
    await this.owns(s, shopId);
    await this.approved(shopId);
    if (s.hostUserId !== actor.userId || !ACTIVE.includes(s.state) || !s.providerRoomId)
      throw new ForbiddenException('LIVE_HOST_INVALID', 'Bạn không có quyền phát phiên này.');
    if ((await this.repo.db.liveRestriction.findUnique({ where: { shopId } }))?.restricted)
      throw new ForbiddenException('LIVE_SHOP_RESTRICTED', 'Quyền phát đã bị thu hồi.');
    return {
      ...(await this.media.token(s.providerRoomId, `host-${id}`, true, 'Chủ phiên')),
      session: await this.detail(id, actor, shopId),
    };
  }
  async stop(
    actor: AuthenticatedActor | null,
    id: string,
    reason: string,
    shopId?: string,
    terminate = false,
    cancelVersion?: number,
  ) {
    const s = await this.repo.transaction(async (tx) => {
      await this.repo.rowLock(tx, id);
      const old = await this.required(id, tx);
      if (shopId) await this.owns(old, shopId);
      if (cancelVersion !== undefined) {
        this.validateVersion(old, cancelVersion);
        if (!['draft', 'scheduled'].includes(old.state))
          throw new ConflictException('LIVE_CANCEL_INVALID', 'Phiên không còn có thể huỷ lịch.');
      }
      if (TERMINAL.includes(old.state)) return old;
      const state = terminate
        ? 'terminated'
        : ['draft', 'scheduled'].includes(old.state)
          ? 'cancelled'
          : 'ended';
      const row = await tx.liveSession.update({
        where: { id },
        data: {
          state,
          endedAt: now(),
          endReason: reason,
          mediaStopStatus: old.providerRoomId ? 'pending' : 'confirmed',
          version: { increment: 1 },
          updatedBy: actor?.userId,
        },
      });
      await this.repo.audit(tx, actor, terminate ? 'LIVE_TERMINATED' : 'LIVE_ENDED', id, { reason });
      await this.repo.event(tx, id, 'session.state_changed', { state, version: row.version });
      return row;
    });
    if (s.providerRoomId && s.mediaStopStatus !== 'confirmed') await this.stopMedia(s);
    return this.detail(id, actor ?? undefined, shopId, true);
  }
  async stopMedia(s: LiveSession) {
    try {
      await this.media.stop(s.providerRoomId!);
      await this.repo.db.liveSession.updateMany({
        where: { id: s.id, mediaStopStatus: { not: 'confirmed' } },
        data: { mediaStopStatus: 'confirmed' },
      });
    } catch {
      await this.repo.db.liveSession.updateMany({
        where: { id: s.id, mediaStopStatus: { not: 'confirmed' } },
        data: { mediaStopStatus: 'failed' },
      });
    }
  }
  private guestHash(key?: string) {
    if (!key || !/^[-a-zA-Z0-9_]{16,100}$/.test(key))
      throw new BusinessException('LIVE_GUEST_KEY_REQUIRED', 'Thiếu mã phiên xem hợp lệ.');
    return createHash('sha256').update(key).digest('hex');
  }
  private owner(
    admission: { userId: string | null; guestHash: string | null },
    actor?: AuthenticatedActor,
    key?: string,
  ) {
    return actor
      ? admission.userId === actor.userId
      : !admission.userId && admission.guestHash === this.guestHash(key);
  }
  async viewer(id: string, actor?: AuthenticatedActor, key?: string) {
    const s = await this.required(id);
    await this.canRead(s, actor);
    if (!['live', 'reconnecting'].includes(s.state) || !s.providerRoomId)
      throw new ConflictException('LIVE_NOT_PLAYING', 'Phiên chưa phát hoặc đã kết thúc.');
    const admission = await this.repo.transaction(async (tx) => {
      await this.repo.globalLock(tx);
      const fresh = await this.required(id, tx);
      if (!['live', 'reconnecting'].includes(fresh.state))
        throw new ConflictException('LIVE_NOT_PLAYING', 'Phiên đã kết thúc.');
      if ((await tx.liveRestriction.findUnique({ where: { shopId: fresh.shopId } }))?.restricted)
        throw new ForbiddenException('LIVE_SHOP_RESTRICTED', 'Phiên đang bị hạn chế.');
      const count = await tx.liveAdmission.count({
        where: { sessionId: id, leftAt: null, expiresAt: { gt: now() } },
      });
      if (count >= (s.mode === 'rehearsal' ? 2 : this.env.EF_LIVE_MAX_VIEWERS))
        throw new ConflictException('LIVE_VIEWER_CAPACITY', 'Phiên demo đã đủ người xem. Vui lòng thử lại.');
      const previous = await tx.liveAdmission.findFirst({
        where: { sessionId: id, ...(actor ? { userId: actor.userId } : { guestHash: this.guestHash(key) }) },
      });
      const row = await tx.liveAdmission.create({
        data: {
          sessionId: id,
          userId: actor?.userId,
          guestHash: actor ? null : this.guestHash(key),
          participantIdentity: `viewer-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await tx.liveSession.update({
        where: { id },
        data: {
          views: { increment: 1 },
          uniqueViewers: { increment: previous ? 0 : 1 },
          peakViewers: Math.max(fresh.peakViewers, count + 1),
        },
      });
      await this.repo.event(tx, id, 'viewer.count_changed', { viewerCount: count + 1 });
      return row;
    });
    try {
      return {
        admissionId: admission.id,
        ...(await this.media.token(s.providerRoomId, admission.participantIdentity, false)),
      };
    } catch (error) {
      await this.repo.db.liveAdmission.update({ where: { id: admission.id }, data: { leftAt: now() } });
      throw error;
    }
  }
  async admission(id: string, admissionId: string, actor?: AuthenticatedActor, key?: string) {
    const a = await this.repo.db.liveAdmission.findFirst({
      where: { id: admissionId, sessionId: id, leftAt: null, expiresAt: { gt: now() } },
    });
    if (!a || !this.owner(a, actor, key))
      throw new ForbiddenException('LIVE_ADMISSION_INVALID', 'Phiên xem đã hết hạn. Hãy kết nối lại.');
    return a;
  }
  async heartbeat(id: string, admissionId: string, actor?: AuthenticatedActor, key?: string, leave = false) {
    await this.admission(id, admissionId, actor, key);
    const s = await this.required(id);
    await this.canRead(s, actor);
    if (!leave && !['live', 'reconnecting'].includes(s.state))
      throw new ConflictException('LIVE_NOT_PLAYING', 'Phiên đã kết thúc.');
    await this.repo.db.liveAdmission.update({
      where: { id: admissionId },
      data: leave ? { leftAt: now() } : { expiresAt: new Date(Date.now() + 60_000) },
    });
    const viewerCount = await this.repo.db.liveAdmission.count({
      where: { sessionId: id, leftAt: null, expiresAt: { gt: now() } },
    });
    if (leave)
      await this.repo.transaction((tx) => this.repo.event(tx, id, 'viewer.count_changed', { viewerCount }));
    return { viewerCount };
  }
  async grant(
    actor: AuthenticatedActor,
    id: string,
    body: { admissionId?: string; productId: string; quantity: number },
  ) {
    const s = await this.required(id);
    await this.approved(s.shopId);
    if (s.state !== 'live' || s.mode !== 'public' || !s.startedAt)
      throw new ConflictException(
        'LIVE_SOURCE_UNAVAILABLE',
        'Chỉ nhận nguồn mua khi phiên đang phát công khai.',
      );
    const a = await this.repo.db.liveAdmission.findFirst({
      where: {
        ...(body.admissionId ? { id: body.admissionId } : {}),
        sessionId: id,
        userId: actor.userId,
        leftAt: null,
        expiresAt: { gt: now() },
      },
    });
    if (!a)
      throw new ForbiddenException('LIVE_VIEW_REQUIRED', 'Bạn cần vào xem phiên trước khi mua ưu đãi live.');
    if (
      !(await this.repo.db.liveSessionProduct.findFirst({
        where: { sessionId: id, productId: body.productId, removed: false },
      }))
    )
      throw new BusinessException('LIVE_PRODUCT_INVALID', 'Sản phẩm không còn trong live.');
    const card = (await this.products.liveCardsByIds([body.productId]))[0];
    if (card?.shop?.id !== s.shopId)
      throw new BusinessException('LIVE_PRODUCT_INVALID', 'Sản phẩm không còn được bán.');
    const g = await this.repo.transaction(async (tx) => {
      await this.repo.rowLock(tx, id);
      const fresh = await this.required(id, tx);
      if (
        fresh.state !== 'live' ||
        fresh.mode !== 'public' ||
        !fresh.startedAt ||
        (await tx.liveRestriction.findUnique({ where: { shopId: fresh.shopId } }))?.restricted
      )
        throw new ConflictException('LIVE_SOURCE_UNAVAILABLE', 'Phiên không còn nhận nguồn mua.');
      if (
        !(await tx.liveSessionProduct.findFirst({
          where: { sessionId: id, productId: body.productId, removed: false },
        }))
      )
        throw new BusinessException('LIVE_PRODUCT_INVALID', 'Sản phẩm không còn trong live.');
      const row = await tx.liveSourceGrant.create({
        data: {
          userId: actor.userId,
          sessionId: id,
          shopId: s.shopId,
          productId: body.productId,
          quantity: body.quantity,
          eligibleUntil: new Date(s.startedAt!.getTime() + 86_400_000),
        },
      });
      await this.repo.audit(tx, actor, 'LIVE_SOURCE_ISSUED', id, {
        productId: body.productId,
        quantity: body.quantity,
      });
      return row;
    });
    return { ...g, sourceGrantId: g.id };
  }
  async verifySource(userId: string, grantId: string, productId: string, quantity: number) {
    const g = await this.repo.db.liveSourceGrant.findFirst({
      where: { id: grantId, userId, productId, quantity: { gte: quantity }, eligibleUntil: { gt: now() } },
    });
    if (!g || quantity < 1)
      throw new BusinessException('LIVE_SOURCE_INVALID', 'Nguồn hàng live không hợp lệ hoặc đã hết hạn.');
    await this.approved(g.shopId);
    return {
      sourceGrantId: g.id,
      sessionId: g.sessionId,
      shopId: g.shopId,
      productId: g.productId,
      eligibleUntil: g.eligibleUntil,
    };
  }
  async productPage(id: string, query: LiveListQuery, actor?: AuthenticatedActor, shopId?: string) {
    const s = await this.required(id);
    if (shopId) await this.owns(s, shopId);
    else await this.canRead(s, actor);
    const rows = await this.repo.db.liveSessionProduct.findMany({
      where: { sessionId: id, removed: false },
      orderBy: { position: 'asc' },
    });
    const cards = await this.products.liveCardsByIds(rows.map((p) => p.productId));
    const found = new Map(cards.map((c) => [c.id, c]));
    const all = rows.flatMap((p) => {
      const card = found.get(p.productId);
      return card && (!query.q || card.name.toLocaleLowerCase('vi').includes(query.q.toLocaleLowerCase('vi')))
        ? [
            {
              productId: p.productId,
              displayNumber: p.displayNumber,
              position: p.position,
              pinned: p.productId === s.pinnedProductId,
              card,
            },
          ]
        : [];
    });
    return PageResponse.of(
      all.slice((query.page - 1) * query.size, query.page * query.size),
      query.page,
      query.size,
      all.length,
    );
  }
  async messagePage(id: string, query: LiveMessageQuery, actor?: AuthenticatedActor, shopId?: string) {
    const s = await this.required(id);
    if (shopId) await this.owns(s, shopId);
    else await this.canRead(s, actor);
    const rows = await this.repo.db.liveMessage.findMany({
      where: {
        sessionId: id,
        deleted: false,
        isDeleted: false,
        ...(query.after ? { sequence: { gt: query.after } } : {}),
      },
      orderBy: { sequence: query.after ? 'asc' : 'desc' },
      take: query.size,
    });
    return (query.after ? rows : rows.reverse()).map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }));
  }
  async sendMessage(actor: AuthenticatedActor, id: string, body: LiveMessageRequest) {
    const s = await this.required(id);
    await this.canRead(s, actor);
    if (
      !(await this.member(s, actor.userId)) &&
      !(await this.repo.db.liveAdmission.findFirst({
        where: { sessionId: id, userId: actor.userId, leftAt: null, expiresAt: { gt: now() } },
      }))
    )
      throw new ForbiddenException('LIVE_VIEW_REQUIRED', 'Bạn cần vào xem phiên để bình luận.');
    if (!['live', 'reconnecting'].includes(s.state))
      throw new ConflictException('LIVE_NOT_PLAYING', 'Phiên không nhận bình luận lúc này.');
    const user = await this.identity.findUserBrief(actor.userId);
    if (!user || user.status !== 'active')
      throw new ForbiddenException('LIVE_USER_INVALID', 'Tài khoản không hoạt động.');
    return this.repo.transaction(async (tx) => {
      await this.repo.rowLock(tx, id);
      const duplicate = await tx.liveMessage.findUnique({
        where: {
          sessionId_userId_clientMessageId: {
            sessionId: id,
            userId: actor.userId,
            clientMessageId: body.clientMessageId,
          },
        },
      });
      if (duplicate) {
        if (duplicate.body !== body.body.trim() || duplicate.replyToId !== (body.replyToId ?? null))
          throw new ConflictException('LIVE_MESSAGE_KEY_REUSED', 'Mã tin nhắn đã dùng cho nội dung khác.');
        return { ...duplicate, createdAt: duplicate.createdAt.toISOString() };
      }
      const fresh = await this.required(id, tx);
      if (!['live', 'reconnecting'].includes(fresh.state))
        throw new ConflictException('LIVE_NOT_PLAYING', 'Phiên đã kết thúc.');
      if (
        (
          await tx.liveMute.findUnique({
            where: { sessionId_userId: { sessionId: id, userId: actor.userId } },
          })
        )?.muted
      )
        throw new ForbiddenException('LIVE_CHAT_MUTED', 'Bạn đã bị tạm cấm bình luận trong phiên này.');
      if (
        (await tx.liveMessage.count({
          where: { sessionId: id, userId: actor.userId, createdAt: { gt: new Date(Date.now() - 10_000) } },
        })) >= 3
      )
        throw new BusinessException('LIVE_CHAT_RATE_LIMIT', 'Bạn gửi quá nhanh. Hãy đợi vài giây.');
      if (!body.body.trim()) throw new BusinessException('LIVE_MESSAGE_EMPTY', 'Bình luận không được trống.');
      if (
        body.replyToId &&
        !(await tx.liveMessage.findFirst({ where: { id: body.replyToId, sessionId: id, deleted: false } }))
      )
        throw new BusinessException('LIVE_REPLY_INVALID', 'Bình luận được trả lời không còn tồn tại.');
      const row = await tx.liveSession.update({ where: { id }, data: { nextSequence: { increment: 1 } } });
      const msg = await tx.liveMessage.create({
        data: {
          sessionId: id,
          userId: actor.userId,
          clientMessageId: body.clientMessageId,
          body: body.body.trim(),
          replyToId: body.replyToId,
          displayName: user.fullName.slice(0, 100),
          sequence: row.nextSequence,
          createdBy: actor.userId,
        },
      });
      const result = { ...msg, createdAt: msg.createdAt.toISOString() };
      await this.repo.audit(tx, actor, 'LIVE_MESSAGE_SENT', id, {
        messageId: msg.id,
        length: msg.body.length,
      });
      await this.repo.event(tx, id, 'message.accepted', { message: result });
      return result;
    });
  }
  async moderate(actor: AuthenticatedActor, shopId: string, id: string, body: LiveModerationRequest) {
    const s = await this.required(id);
    await this.owns(s, shopId);
    if (
      s.hostUserId !== actor.userId &&
      !(await this.member(s, actor.userId, 'shop.livestream.manage')) &&
      !(await this.repo.db.liveModerator.findFirst({
        where: { sessionId: id, userId: actor.userId, active: true },
      }))
    )
      throw new ForbiddenException('LIVE_MODERATOR_REQUIRED', 'Bạn chưa được phân công điều hành phiên.');
    await this.repo.transaction(async (tx) => {
      await this.repo.rowLock(tx, id);
      if (['delete_message', 'pin_message'].includes(body.action)) {
        const m = await tx.liveMessage.findFirst({
          where: {
            id: body.messageId ?? '00000000-0000-0000-0000-000000000000',
            sessionId: id,
            deleted: false,
          },
        });
        if (!m) throw new NotFoundException('LIVE_MESSAGE_NOT_FOUND', 'Không tìm thấy bình luận.');
        if (body.action === 'delete_message') {
          await tx.liveMessage.update({
            where: { id: m.id },
            data: { deleted: true, body: '', version: { increment: 1 }, updatedBy: actor.userId },
          });
          await tx.liveSession.updateMany({
            where: { id, pinnedMessageId: m.id },
            data: { pinnedMessageId: null, version: { increment: 1 } },
          });
          await this.repo.event(tx, id, 'message.deleted', { messageId: m.id, sequence: m.sequence });
        } else
          await tx.liveSession.update({
            where: { id },
            data: { pinnedMessageId: m.id, version: { increment: 1 } },
          });
      } else if (body.action === 'unpin_message')
        await tx.liveSession.update({
          where: { id },
          data: { pinnedMessageId: null, version: { increment: 1 } },
        });
      else {
        if (!body.userId) throw new BusinessException('LIVE_USER_REQUIRED', 'Thiếu người dùng cần xử lý.');
        await tx.liveMute.upsert({
          where: { sessionId_userId: { sessionId: id, userId: body.userId } },
          create: {
            sessionId: id,
            userId: body.userId,
            muted: body.action === 'mute',
            reason: body.reason,
            createdBy: actor.userId,
          },
          update: {
            muted: body.action === 'mute',
            reason: body.reason,
            updatedBy: actor.userId,
            version: { increment: 1 },
          },
        });
      }
      await this.repo.audit(tx, actor, 'LIVE_MODERATED', id, {
        action: body.action,
        messageId: body.messageId,
        userId: body.userId,
        reason: body.reason,
      });
      await this.repo.event(tx, id, 'moderation.changed', {
        action: body.action,
        messageId: body.messageId,
        userId: body.userId,
      });
    });
    return { ok: true };
  }
  async moderators(actor: AuthenticatedActor, shopId: string, id: string, userIds?: string[]) {
    const s = await this.required(id);
    await this.owns(s, shopId);
    if (userIds) {
      const allowed = await this.shops.memberUserIdsWithPermission(shopId, 'shop.livestream.moderate');
      if (userIds.some((uid) => !allowed.includes(uid)))
        throw new BusinessException(
          'LIVE_MODERATOR_INVALID',
          'Chỉ phân công thành viên shop có quyền điều hành.',
        );
      await this.repo.transaction(async (tx) => {
        await this.repo.rowLock(tx, id);
        await tx.liveModerator.updateMany({ where: { sessionId: id }, data: { active: false } });
        for (const uid of userIds)
          await tx.liveModerator.upsert({
            where: { sessionId_userId: { sessionId: id, userId: uid } },
            create: { sessionId: id, userId: uid, createdBy: actor.userId },
            update: { active: true, updatedBy: actor.userId, version: { increment: 1 } },
          });
        await this.repo.audit(tx, actor, 'LIVE_MODERATORS_CHANGED', id, { userIds });
      });
    }
    const selected = (
      await this.repo.db.liveModerator.findMany({ where: { sessionId: id, active: true } })
    ).map((m) => m.userId);
    const eligible = await this.shops.memberUserIdsWithPermission(shopId, 'shop.livestream.moderate');
    const people = await this.users.findSnapshots(eligible);
    return {
      userIds: selected,
      candidates: eligible.flatMap((userId) => {
        const u = people.get(userId);
        return u ? [{ userId, fullName: u.fullName }] : [];
      }),
    };
  }
  async report(actor: AuthenticatedActor, id: string, body: { reason: string; description?: string }) {
    const s = await this.required(id);
    await this.canRead(s, actor);
    return this.repo.transaction(async (tx) => {
      const r = await tx.liveReport.create({
        data: { sessionId: id, userId: actor.userId, ...body, createdBy: actor.userId },
      });
      await this.repo.audit(tx, actor, 'LIVE_REPORTED', id, { reportId: r.id, reason: body.reason });
      return { id: r.id, status: r.status };
    });
  }
  async reports(q: LiveReportListQuery) {
    const where = { isDeleted: false, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([
      this.repo.db.liveReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.size,
        take: q.size,
      }),
      this.repo.db.liveReport.count({ where }),
    ]);
    return PageResponse.of(
      rows.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        reason: r.reason,
        description: r.description,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
      q.page,
      q.size,
      total,
    );
  }
  async processReport(actor: AuthenticatedActor, id: string, decision: string, note?: string) {
    return this.repo.transaction(async (tx) => {
      const r = await tx.liveReport.findUnique({ where: { id } });
      if (!r) throw new NotFoundException('LIVE_REPORT_NOT_FOUND', 'Báo cáo không tồn tại.');
      if (r.status !== 'pending') return r;
      const row = await tx.liveReport.update({
        where: { id },
        data: { status: decision, resolutionNote: note, updatedBy: actor.userId, version: { increment: 1 } },
      });
      await this.repo.audit(tx, actor, 'LIVE_REPORT_PROCESSED', r.sessionId, {
        reportId: id,
        decision,
        note,
      });
      return row;
    });
  }
  async restrict(actor: AuthenticatedActor, shopId: string, restricted: boolean, reason: string) {
    await this.repo.transaction(async (tx) => {
      await this.repo.globalLock(tx);
      await tx.liveRestriction.upsert({
        where: { shopId },
        create: { shopId, restricted, reason, createdBy: actor.userId },
        update: { restricted, reason, updatedBy: actor.userId, version: { increment: 1 } },
      });
      await this.repo.audit(tx, actor, 'LIVE_SHOP_RESTRICTED', shopId, { restricted, reason });
    });
    if (restricted) {
      const sessions = await this.repo.db.liveSession.findMany({ where: { shopId, state: { in: ACTIVE } } });
      for (const s of sessions) await this.stop(actor, s.id, reason, undefined, true);
    }
    return { restricted };
  }
  async statistics(id: string, shopId: string, actor: AuthenticatedActor) {
    const s = await this.required(id);
    await this.owns(s, shopId);
    const messageCount = await this.repo.db.liveMessage.count({ where: { sessionId: id } });
    const commerce = this.modules
      ? await this.modules
          .get<LiveCommerceOrderGateway>(LIVE_COMMERCE_ORDER_GATEWAY, { strict: false })
          .report(id)
      : undefined;
    return {
      session: await this.detail(id, actor, shopId),
      views: s.views,
      uniqueViewers: s.uniqueViewers,
      peakViewers: s.peakViewers,
      messageCount,
      likes: s.likes,
      commerce,
    };
  }
  async socketAccess(id: string, actor?: AuthenticatedActor, admissionId?: string, key?: string) {
    const s = await this.required(id);
    await this.canRead(s, actor);
    if (actor && (await this.member(s, actor.userId))) return;
    await this.admission(id, admissionId ?? '', actor, key);
  }
  async like(id: string, admissionId: string, count: number, actor?: AuthenticatedActor, key?: string) {
    await this.admission(id, admissionId, actor, key);
    const result = await this.repo.db.liveSession.updateMany({
      where: { id, state: 'live' },
      data: { likes: { increment: count } },
    });
    if (!result.count) throw new ConflictException('LIVE_NOT_PLAYING', 'Phiên không đang phát.');
    return { likes: (await this.required(id)).likes };
  }
}
