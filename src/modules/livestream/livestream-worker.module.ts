import { TrackType } from 'livekit-server-sdk';
import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import Redis from 'ioredis';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { REDIS } from '@common/redis/redis.module';
import { NOTIFICATION_GATEWAY, type NotificationGateway } from '@common/gateway/notification.gateway';
import { OutboxRelay } from '@common/outbox/outbox-relay';
import { ShopFollowApplicationApi } from '@modules/shop/applicationapi/shop-follow.applicationapi';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { ShopModule } from '@modules/shop/shop.module';
import { SystemModule } from '@modules/system/system.module';
import { LiveService } from './live.service';
import { LiveRepository } from './live.repository';
import { LiveMediaService } from './media/live-media.service';
import { LivestreamModule } from './livestream.module';

/* Chỉ worker chạy timer: relay outbox, thông báo idempotent, media reconcile/stop retry và TTL cleanup. */
@Injectable()
export class LiveJobs implements OnModuleInit {
  private readonly logger = new Logger(LiveJobs.name);
  private relay!: OutboxRelay;
  private running = false;
  constructor(
    private readonly repo: LiveRepository,
    private readonly live: LiveService,
    private readonly media: LiveMediaService,
    private readonly follows: ShopFollowApplicationApi,
    private readonly shops: ShopQueryApi,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    @Inject(NOTIFICATION_GATEWAY) private readonly notifications: NotificationGateway,
  ) {}
  onModuleInit() {
    this.relay = new OutboxRelay(this.repo.db, 'livestream', async (msg) => {
      if (msg.payload.notifyFollowers) {
        await this.repo.transaction(async (tx) => {
          const claimed = await tx.liveProcessedEvent.findUnique({
            where: { eventId_handler: { eventId: msg.id, handler: 'notify-followers' } },
          });
          if (claimed) return;
          const s = await this.repo.session(msg.aggregateId, tx);
          if (s && ['live', 'reconnecting'].includes(s.state) && s.mode === 'public') {
            const users = await this.follows.followerIds(s.shopId, tx);
            await this.notifications.notifyMany(
              users.map((userId) => ({
                userId,
                type: 'system',
                title: `${s.title} đang phát trực tiếp`,
                content: 'Gian hàng bạn theo dõi đang livestream.',
                link: `/live/${s.id}`,
              })),
              tx,
            );
          }
          await tx.liveProcessedEvent.create({
            data: { eventId: msg.id, eventType: msg.eventType, handler: 'notify-followers' },
          });
        });
      }
      await this.redis.publish(
        'fitly:livestream:events',
        JSON.stringify({ sessionId: msg.aggregateId, event: msg.eventType, payload: msg.payload }),
      );
    });
  }
  @Interval(3000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.relay.poll();
      await this.remindScheduled();
      const inbox = await this.repo.db.liveMediaInbox.findMany({
        where: { processedAt: null },
        take: 20,
        orderBy: { createdAt: 'asc' },
      });
      for (const event of inbox) await this.media.process(event.id);
      const sessions = await this.repo.db.liveSession.findMany({
        where: {
          OR: [
            { state: { in: ['starting', 'live', 'reconnecting'] } },
            { mediaStopStatus: { in: ['pending', 'failed'] } },
          ],
        },
        take: 20,
      });
      for (const s of sessions) {
        if (['ended', 'terminated', 'cancelled', 'draft'].includes(s.state)) {
          if (s.providerRoomId && s.mediaStopStatus !== 'confirmed') await this.live.stopMedia(s);
          continue;
        }
        if (
          !(await this.shops.existsApproved(s.shopId)) ||
          (await this.repo.db.liveRestriction.findUnique({ where: { shopId: s.shopId } }))?.restricted
        ) {
          await this.live.stop(null, s.id, 'Quyền phát của gian hàng đã bị thu hồi', undefined, true);
          continue;
        }
        const deadline = s.startedAt
          ? new Date(
              s.startedAt.getTime() +
                (s.mode === 'rehearsal' ? 10 : this.env.EF_LIVE_DURATION_MINUTES) * 60_000,
            )
          : s.startDeadline;
        if ((deadline && deadline <= new Date()) || (s.reconnectUntil && s.reconnectUntil <= new Date())) {
          if (s.state === 'starting') {
            await this.repo.db.liveSession.updateMany({
              where: { id: s.id, state: 'starting' },
              data: { state: 'draft', mediaStopStatus: 'pending', version: { increment: 1 } },
            });
            await this.live.stopMedia(s);
          } else await this.live.stop(null, s.id, 'Phiên đã hết thời gian phát hoặc thời gian kết nối lại');
          continue;
        }
        if (this.live.media.configured && s.providerRoomId) {
          try {
            const participants = await this.live.media.participants(s.providerRoomId);
            const host = participants.find((p) => p.identity === `host-${s.id}`);
            if (
              host?.tracks.some((t) => t.type === TrackType.VIDEO) &&
              ['starting', 'reconnecting'].includes(s.state)
            )
              await this.repo.transaction(async (tx) => {
                await this.repo.rowLock(tx, s.id);
                const fresh = await this.live.required(s.id, tx);
                if (!['starting', 'reconnecting'].includes(fresh.state)) return;
                const first = !fresh.startedAt;
                const row = await tx.liveSession.update({
                  where: { id: s.id },
                  data: {
                    state: 'live',
                    startedAt: fresh.startedAt ?? new Date(),
                    startDeadline: null,
                    reconnectUntil: null,
                    version: { increment: 1 },
                  },
                });
                await this.repo.event(tx, s.id, 'session.state_changed', {
                  state: 'live',
                  version: row.version,
                  ...(first && s.mode === 'public' ? { notifyFollowers: true } : {}),
                });
              });
            if (!host && s.state === 'live')
              await this.repo.transaction(async (tx) => {
                const row = await tx.liveSession.updateMany({
                  where: { id: s.id, state: 'live' },
                  data: {
                    state: 'reconnecting',
                    reconnectUntil: new Date(Date.now() + 90_000),
                    version: { increment: 1 },
                  },
                });
                if (row.count)
                  await this.repo.event(tx, s.id, 'session.state_changed', { state: 'reconnecting' });
              });
            const liveIdentities = new Set(participants.map((p) => p.identity));
            const admissions = await this.repo.db.liveAdmission.findMany({ where: { sessionId: s.id } });
            for (const a of admissions)
              if ((a.leftAt || a.expiresAt <= new Date()) && liveIdentities.has(a.participantIdentity))
                await this.live.media.remove(s.providerRoomId, a.participantIdentity);
          } catch {
            this.logger.warn({ sessionId: s.id }, 'Chưa đối soát được phòng video; sẽ thử lại.');
          }
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Job livestream chưa hoàn tất; sẽ thử lại.');
    } finally {
      this.running = false;
    }
  }
  private async remindScheduled(): Promise<void> {
    const scheduled = await this.repo.db.liveSession.findMany({
      where: {
        state: 'scheduled',
        mode: 'public',
        isDeleted: false,
        scheduledAt: { gt: new Date(), lte: new Date(Date.now() + 5 * 60_000) },
      },
      take: 20,
      orderBy: { scheduledAt: 'asc' },
    });
    for (const candidate of scheduled) {
      if (!(await this.shops.existsApproved(candidate.shopId))) continue;
      await this.repo.transaction(async (tx) => {
        await this.repo.rowLock(tx, candidate.id);
        const s = await this.repo.session(candidate.id, tx);
        if (
          !s ||
          s.state !== 'scheduled' ||
          s.scheduleVersion !== candidate.scheduleVersion ||
          !s.scheduledAt ||
          s.scheduledAt <= new Date()
        )
          return;
        const handler = `schedule-reminder-v${s.scheduleVersion}`;
        if (
          await tx.liveProcessedEvent.findUnique({ where: { eventId_handler: { eventId: s.id, handler } } })
        )
          return;
        if ((await tx.liveRestriction.findUnique({ where: { shopId: s.shopId } }))?.restricted) return;
        const followers = await this.follows.followerIds(s.shopId, tx);
        await this.notifications.notifyMany(
          followers.map((userId) => ({
            userId,
            type: 'system' as const,
            title: `${s.title} sắp phát trực tiếp`,
            content: 'Phiên livestream của gian hàng bạn theo dõi sẽ bắt đầu trong khoảng 5 phút.',
            link: `/live/${s.id}`,
          })),
          tx,
        );
        await tx.liveProcessedEvent.create({
          data: { eventId: s.id, eventType: 'session.schedule_reminder', handler },
        });
      });
    }
  }
  @Interval(3_600_000)
  async cleanup() {
    const cutoff = new Date(Date.now() - 30 * 86_400_000);
    await this.repo.db.liveMessage.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        sessionId: {
          notIn: (
            await this.repo.db.liveReport.findMany({
              where: { status: 'pending' },
              select: { sessionId: true },
            })
          ).map((r) => r.sessionId),
        },
      },
    });
    await this.repo.db.liveAdmission.deleteMany({
      where: { joinedAt: { lt: new Date(Date.now() - 86_400_000) } },
    });
  }
}
@Module({ imports: [LivestreamModule, SystemModule, ShopModule], providers: [LiveJobs] })
export class LivestreamWorkerModule {}
